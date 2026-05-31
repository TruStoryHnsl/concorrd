//! Transport layer for the embedded servitude module.
//!
//! The [`Transport`] trait abstracts "something that needs to be brought up
//! and torn down as part of the servitude lifecycle." In the 2026-04-08
//! design the concrete transports are:
//!
//!   * [`matrix_federation::MatrixFederationTransport`] — spawns a bundled
//!     tuwunel Matrix homeserver as a child process. This is the first
//!     real transport and lands in INS-022 Wave 2.
//!   * `WireGuard` — Headscale/Tailscale-style mesh tunnel that gives
//!     the node a publicly-reachable IP. Not yet implemented.
//!   * `Mesh` — libp2p over BLE/WiFi Direct/WiFi AP. Not yet implemented;
//!     lands in the P2P-first roadmap (PLAN.md Phase 3 — libp2p integration
//!     in this module). Salvage prototype lives in the `conquered` repo.
//!   * `Tunnel` — HTTP/QUIC tunnel through cooperating relays. Not yet
//!     implemented.
//!
//! The module exposes an enum-dispatched runtime object
//! ([`TransportRuntime`]) rather than trait objects, so
//! `ServitudeHandle::start`/`stop` don't have to touch a `Box<dyn
//! Transport>` surface — the enum variants are compile-time exhaustive
//! and the config knows which runtime to build from each
//! [`crate::servitude::config::Transport`] variant.
//!
//! Error handling: every fallible call returns [`TransportError`]. The
//! error type is `thiserror`-backed for consistency with the rest of the
//! servitude module, and flows up into [`crate::servitude::ServitudeError`]
//! via `#[from]`.

use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::servitude::config::{ServitudeConfig, Transport as TransportVariant};
use crate::servitude::identity::StrongholdHandle;
use crate::servitude::p2p::{LibP2pTransport, P2pError, SwarmEvent as P2pSwarmEvent};

pub mod matrix_federation;
#[cfg(feature = "reticulum")]
pub mod reticulum;
// Dendrite is the Windows backend for MatrixFederation. We compile it
// on every platform (so unit tests can exercise the module on Linux
// CI) but the runtime only swaps it in via cfg(target_os = "windows")
// in `for_variant` below.
pub mod dendrite_federation;

/// Errors surfaced by any transport implementation.
#[derive(Debug, Error)]
pub enum TransportError {
    /// Could not spawn the transport. Usually means the bundled binary
    /// is missing, permissions are wrong, or the listen port is already
    /// bound by another process.
    #[error("transport start failed: {0}")]
    StartFailed(String),

    /// Transport was asked to stop but the tear-down path failed.
    /// Graceful-shutdown timeouts fall under this.
    #[error("transport stop failed: {0}")]
    StopFailed(String),

    /// Health check against a running transport did not succeed inside
    /// the configured timeout.
    #[error("transport health check failed: {0}")]
    HealthCheck(String),

    /// The bundled child-process binary for this transport was not
    /// found on disk at any of the configured discovery paths.
    #[error("transport binary not found: {0}")]
    BinaryNotFound(String),

    /// A transport was already in the running state and we asked it to
    /// start again. Caller's responsibility to guard against this, but
    /// we return an error rather than panic so misuse is recoverable.
    #[error("transport is already running")]
    AlreadyRunning,

    /// A transport was asked to stop while it was not running.
    #[error("transport is not running")]
    NotRunning,

    /// A variant that hasn't been implemented yet. The MVP only ships
    /// [`matrix_federation::MatrixFederationTransport`]; the other three
    /// `Transport` enum variants return this so they can be referenced
    /// in config without crashing.
    #[error("transport not yet implemented: {0}")]
    NotImplemented(&'static str),

    /// libp2p swarm failed to come up. The wrapped [`P2pError`] carries
    /// the exact failure (Stronghold seed unavailable, listen bind
    /// failure, etc).
    #[error("libp2p transport error: {0}")]
    LibP2p(#[from] P2pError),
}

/// Async trait implemented by every transport runtime. Used internally
/// by [`TransportRuntime`] to dispatch; callers outside this module
/// should prefer the enum.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Identifier for logs — matches the config variant name, lowercased.
    fn name(&self) -> &'static str;

    /// Whether this transport is critical to the servitude's basic
    /// operation. Critical transports (e.g. `MatrixFederation`) take
    /// down the whole handle if they fail to start — the lifecycle
    /// rolls back to `Stopped` and the caller gets a hard error.
    /// Non-critical transports are allowed to
    /// fail without stopping the rest of the servitude — the failure
    /// is recorded in `ServitudeHandle::degraded` and surfaced to the
    /// UI via `degraded_transports()`.
    ///
    /// Defaults to `true` so any transport that forgets to override is
    /// conservatively treated as critical. Wave 3 (INS-024) introduced
    /// this split; the Wave 2 tuwunel transport stays critical.
    fn is_critical(&self) -> bool {
        true
    }

    /// Bring the transport up. Must succeed before the servitude
    /// lifecycle is permitted to transition `Starting -> Running`.
    async fn start(&mut self) -> Result<(), TransportError>;

    /// Gracefully tear the transport down. Implementations must not
    /// leave orphaned child processes or bound ports behind.
    async fn stop(&mut self) -> Result<(), TransportError>;

    /// Cheap liveness check — used by the UI polling loop so the user
    /// sees a status that reflects actual health, not just last-known
    /// lifecycle state. Return `false` when the transport is down or
    /// the check itself errors; details go to logs.
    async fn is_healthy(&self) -> bool;
}

/// Phase 3 libp2p runtime wrapper.
///
/// `LibP2pTransport::new()` is async and consumes a `StrongholdHandle`, so
/// it cannot be built inside the sync [`TransportRuntime::for_variant`]
/// factory. Instead we hold the [`StrongholdHandle`] + a placeholder for
/// the running swarm here, and construct the swarm on `start()`.
///
/// Architectural invariant: the libp2p `PeerId` derives from the same
/// per-install Ed25519 seed that backs the Phase 2 user-visible
/// `PeerIdentity.fingerprint`. The runtime enforces this by loading the
/// identity from Stronghold before building the swarm — both code paths
/// use the same seed (see [`crate::servitude::identity::peer_seed`]).
pub struct LibP2pRuntime {
    /// Stronghold handle the swarm reads its seed from on start. Held
    /// across the whole runtime lifetime so a stop/start cycle can
    /// re-derive the same swarm identity.
    stronghold: Arc<StrongholdHandle>,
    /// Sender that triggers a clean shutdown of the spawned event loop.
    /// Populated on `start()`, drained on `stop()`.
    shutdown_tx: Option<tokio::sync::mpsc::Sender<()>>,
    /// Join handle for the spawned swarm event loop. Populated on
    /// `start()`, awaited on `stop()`.
    swarm_task: Option<JoinHandle<()>>,
    /// Join handle for the voice signaling outbound drain task.
    /// Populated on `start()` when a voice registry is wired.
    voice_outbound_task: Option<JoinHandle<()>>,
    /// Clone of the swarm's broadcast sender. Populated on `start()` so
    /// the Tauri lib can register the same sender into managed state
    /// without having to wait on the spawned task.
    event_tx: Option<broadcast::Sender<P2pSwarmEvent>>,
    /// Local libp2p PeerId cached on start. Useful for status reporting.
    local_peer_id: Option<libp2p::PeerId>,
    /// Phase 8 follow-up — shared voice-call registry the dispatcher
    /// routes inbound signaling envelopes to. Wired by the Tauri
    /// layer before `start()`; on `start()` the registry's
    /// [`VoiceCallSinkImpl`] becomes the real signaling sink (replacing
    /// the prior `NoopVoiceSink`). When `None`, the no-op sink is
    /// installed for backward-compat with tests / older callers.
    voice_registry: Option<Arc<crate::servitude::voice::VoiceCallRegistry>>,
    /// Phase 8 follow-up — outbound voice signaling channel.
    /// `VoiceCall` instances clone this sender; the `start()` path
    /// spawns a drain task that forwards each envelope via
    /// [`crate::servitude::voice::send_signaling`].
    voice_outbound_tx:
        tokio::sync::mpsc::Sender<(libp2p::PeerId, crate::servitude::voice::SignalingMessage)>,
    voice_outbound_rx: Option<
        tokio::sync::mpsc::Receiver<(
            libp2p::PeerId,
            crate::servitude::voice::SignalingMessage,
        )>,
    >,
    /// Porch Phase A — shared local porch the libp2p handler dispatches
    /// inbound `/concord/porch/1.0.0` envelopes against. Wired by the
    /// Tauri layer before `start()` so the same `Porch` instance backs
    /// both the host's own Tauri commands AND the inbound visit path.
    /// `None` means no porch handler is registered (test-only path).
    porch: Option<Arc<crate::porch::Porch>>,
    /// Porch Phase A — clone of the libp2p stream control, captured at
    /// `start()` so the Tauri visit commands can open outbound streams
    /// to remote peers without grabbing a fresh `Control` per call.
    porch_stream_control: Option<libp2p_stream::Control>,
}

impl std::fmt::Debug for LibP2pRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LibP2pRuntime")
            .field("running", &self.swarm_task.is_some())
            .field("local_peer_id", &self.local_peer_id)
            .finish_non_exhaustive()
    }
}

impl LibP2pRuntime {
    /// Build a not-yet-started runtime around the install's shared
    /// `StrongholdHandle`. Construction is cheap — no network and no
    /// Stronghold round trip happens until `start()`.
    pub fn new(stronghold: Arc<StrongholdHandle>) -> Self {
        // Generous channel depth — voice signaling messages are small
        // (SDP blocks measured in KB, ICE candidates in bytes), and a
        // single call may emit dozens of ICE candidates during the
        // initial gathering burst.
        let (voice_outbound_tx, voice_outbound_rx) = tokio::sync::mpsc::channel(256);
        Self {
            stronghold,
            shutdown_tx: None,
            swarm_task: None,
            voice_outbound_task: None,
            event_tx: None,
            local_peer_id: None,
            voice_registry: None,
            voice_outbound_tx,
            voice_outbound_rx: Some(voice_outbound_rx),
            porch: None,
            porch_stream_control: None,
        }
    }

    /// Wire the porch. MUST be called before [`Self::start`] for the
    /// inbound `/concord/porch/1.0.0` handler to be registered;
    /// otherwise no porch traffic is accepted (the libp2p layer
    /// returns `protocol not supported` to the dialer).
    pub fn set_porch(&mut self, porch: Arc<crate::porch::Porch>) {
        self.porch = Some(porch);
    }

    /// Clone of the libp2p stream control captured at `start()`. The
    /// Tauri visit commands use this to open outbound porch streams.
    /// Returns `None` while the runtime is stopped.
    pub fn porch_stream_control(&self) -> Option<libp2p_stream::Control> {
        self.porch_stream_control.clone()
    }

    /// Wire the voice-call registry. MUST be called before
    /// [`Self::start`] for the real call orchestration sink to be
    /// installed; otherwise the Phase 8 no-op sink is used (signaling
    /// envelopes are decoded + logged + dropped).
    pub fn set_voice_registry(
        &mut self,
        registry: Arc<crate::servitude::voice::VoiceCallRegistry>,
    ) {
        self.voice_registry = Some(registry);
    }

    /// Clone of the outbound voice-signaling sender. The Tauri command
    /// layer hands this to each new [`crate::servitude::voice::VoiceCall`]
    /// so the orchestrator can push Offer/Answer/IceCandidate/Bye
    /// envelopes onto the wire without holding a reference to the
    /// stream control.
    pub fn voice_outbound_sender(
        &self,
    ) -> tokio::sync::mpsc::Sender<(
        libp2p::PeerId,
        crate::servitude::voice::SignalingMessage,
    )> {
        self.voice_outbound_tx.clone()
    }

    /// Clone of the swarm's broadcast sender. Returns `None` while the
    /// runtime is stopped. Used by the Tauri layer to mirror swarm
    /// events into a Tauri event channel.
    pub fn event_sender(&self) -> Option<broadcast::Sender<P2pSwarmEvent>> {
        self.event_tx.clone()
    }

    /// Local libp2p `PeerId` derived from the per-install Ed25519 seed.
    /// `None` while the runtime is stopped.
    pub fn local_peer_id(&self) -> Option<libp2p::PeerId> {
        self.local_peer_id
    }

    async fn start(&mut self) -> Result<(), TransportError> {
        if self.swarm_task.is_some() {
            return Err(TransportError::AlreadyRunning);
        }

        // Load identity first — this also primes the in-memory seed cache
        // used by `peer_seed` below. Both Phase 2's fingerprint and the
        // libp2p PeerId derive from the same per-install seed.
        let peer_identity = crate::servitude::identity::load_or_create(&self.stronghold)
            .await
            .map_err(|e| TransportError::StartFailed(format!("identity load: {e}")))?;

        let mut transport = LibP2pTransport::new(&peer_identity, &self.stronghold).await?;

        // Phase 6 (INS-019b) — register the Matrix federation handler so
        // inbound `/concord/matrix-federation/1.0.0` streams are routed
        // through the conduwuit federation dispatch. The handler is
        // wired with a `ConduwuitClient` pointed at the bundled
        // homeserver's HTTP endpoint (localhost:6167 — same default the
        // tuwunel `from_config` path uses). Other federation handlers
        // (ActivityPub, etc.) plug in here as separate
        // `register_federation_handler` calls in later phases.
        {
            use crate::servitude::federation::{
                ConduwuitClient, MatrixFederationHandler,
            };
            let conduwuit = std::sync::Arc::new(ConduwuitClient::new(
                "http://localhost:6167",
            ));
            let handler =
                std::sync::Arc::new(MatrixFederationHandler::new(conduwuit));
            transport.register_federation_handler(handler);
        }

        // Phase 6 follow-up (INS-019b) — register the ActivityPub
        // federation handler so inbound `/concord/activitypub/1.0.0`
        // streams are routed through the ActivityPub dispatch surface.
        // Phase 6 ships a `StubActivityPubClient` (501-for-everything
        // except a documented `"Ping"` heartbeat) so the seam is plumbed
        // end-to-end; real Mastodon / Mozilla.social interop is a
        // follow-up. Three handlers now, all on different protocol IDs.
        {
            use crate::servitude::federation::{
                ActivityPubHandler, StubActivityPubClient,
            };
            let api = std::sync::Arc::new(StubActivityPubClient);
            let handler = std::sync::Arc::new(ActivityPubHandler::new(api));
            transport.register_federation_handler(handler);
        }

        // Phase 8 follow-up (INS-019b media plane) — register the
        // voice signaling handler. When a `VoiceCallRegistry` has been
        // wired into this runtime via [`Self::set_voice_registry`],
        // we install the real [`VoiceCallSinkImpl`] sink — inbound
        // envelopes route through the registry to the matching
        // [`VoiceCall`] orchestrator. Otherwise we fall back to the
        // Phase 8 `NoopVoiceSink` (decoded + logged + dropped).
        let stream_control_for_voice = transport.stream_control();
        {
            use crate::servitude::voice::{
                SignalingMessage, VoiceCallSink, VoiceCallSinkImpl, VoiceSignalingHandler,
            };

            struct NoopVoiceSink;

            #[async_trait::async_trait]
            impl VoiceCallSink for NoopVoiceSink {
                async fn deliver(&self, from: libp2p::PeerId, message: SignalingMessage) {
                    log::debug!(
                        target: "concord::servitude::voice",
                        "voice signaling envelope received but no sink wired (no registry): from={from} message={message:?}"
                    );
                }
            }

            let sink: std::sync::Arc<dyn VoiceCallSink> = match self.voice_registry.clone()
            {
                Some(registry) => std::sync::Arc::new(VoiceCallSinkImpl::new(registry)),
                None => std::sync::Arc::new(NoopVoiceSink),
            };
            let handler = std::sync::Arc::new(VoiceSignalingHandler::new(sink));
            transport.register_federation_handler(handler);
        }

        // Porch Phase A — register the porch handler if a `Porch` was
        // wired into this runtime. The handler dispatches inbound
        // `/concord/porch/1.0.0` envelopes against the same `Porch`
        // instance the host's own Tauri commands operate on, so a
        // visitor's PostMessage is visible to the host's UI on the
        // next get_messages call (and vice versa). When no porch is
        // wired (test-only path), no handler is registered and the
        // libp2p layer returns "protocol not supported" to dialers.
        if let Some(porch) = self.porch.clone() {
            let handler = std::sync::Arc::new(crate::porch::PorchHandler::new(porch.clone()));
            transport.register_federation_handler(handler);
            // Porch Phase E — register the backup-protocol handler
            // alongside. Same shared `Arc<Porch>` so inbound uploads
            // land in the same SQLite the host's own UI reads. Distinct
            // protocol ID (`/concord/porch-backup/1.0.0`) means a
            // hardened install can opt-out of either independently in
            // a future config knob without protocol-level surgery.
            let backup_handler =
                std::sync::Arc::new(crate::porch::BackupHandler::new(porch.clone()));
            transport.register_federation_handler(backup_handler);
            // Porch Phase F — register the sync-protocol handler.
            // Distinct protocol ID `/concord/porch-sync/1.0.0` —
            // trust boundary is "linked personal device" (enforced
            // inside the handler against `device_links`).
            let sync_handler =
                std::sync::Arc::new(crate::porch::SyncHandler::new(porch));
            transport.register_federation_handler(sync_handler);
        }

        // Capture the stream control before run() consumes the
        // transport so the porch visit commands can open outbound
        // streams. Held until stop() clears it.
        self.porch_stream_control = Some(transport.stream_control());

        self.local_peer_id = Some(transport.local_peer_id());
        self.event_tx = Some(transport.event_sender());
        self.shutdown_tx = Some(transport.shutdown_handle());

        // `run()` consumes the transport and drives the swarm event
        // loop until shutdown. Spawned onto the Tokio runtime so the
        // lifecycle transition can return without blocking.
        let task = tokio::spawn(async move {
            transport.run().await;
        });
        self.swarm_task = Some(task);

        // Phase 8 follow-up — drain the outbound voice signaling
        // channel. Each [`VoiceCall`] holds a clone of the sender
        // returned by [`Self::voice_outbound_sender`]; envelopes
        // pushed onto it are forwarded over the libp2p signaling
        // protocol via `send_signaling`. The task exits when every
        // sender is dropped, which happens when the runtime is
        // stopped + all `VoiceCall` instances are released.
        if let Some(mut rx) = self.voice_outbound_rx.take() {
            let mut control = stream_control_for_voice;
            let voice_task = tokio::spawn(async move {
                use crate::servitude::voice::send_signaling;
                while let Some((peer_id, message)) = rx.recv().await {
                    if let Err(e) = send_signaling(&mut control, peer_id, message).await {
                        log::warn!(
                            target: "concord::servitude::voice",
                            "voice signaling send failed to peer {peer_id}: {e}"
                        );
                    }
                }
                log::debug!(
                    target: "concord::servitude::voice",
                    "voice outbound drain task exiting (all senders dropped)"
                );
            });
            self.voice_outbound_task = Some(voice_task);
        }

        log::info!(
            target: "concord::servitude::libp2p",
            "libp2p swarm started (peer_id={:?})",
            self.local_peer_id
        );
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), TransportError> {
        let task = match self.swarm_task.take() {
            Some(t) => t,
            None => return Err(TransportError::NotRunning),
        };
        if let Some(tx) = self.shutdown_tx.take() {
            // Ignore send errors — the receiver may already have dropped
            // if the loop exited on its own; either way the JoinHandle
            // await below tells us the actual termination state.
            let _ = tx.send(()).await;
        }
        // Drop the cached event sender so subscribers attached to a
        // dead loop bottom out cleanly.
        self.event_tx = None;
        self.local_peer_id = None;
        // Drop the cached porch stream control — outbound visit calls
        // made after stop() will see `None` and surface a typed error.
        self.porch_stream_control = None;

        // Phase 8 follow-up — abort the voice outbound drain task.
        // The task would exit naturally when all senders drop, but
        // explicit abort makes shutdown deterministic.
        if let Some(t) = self.voice_outbound_task.take() {
            t.abort();
        }

        // Wait for the spawned event loop to exit. If the task panicked
        // we surface that as a stop failure rather than silently dropping.
        match task.await {
            Ok(()) => Ok(()),
            Err(e) if e.is_cancelled() => Ok(()),
            Err(e) => Err(TransportError::StopFailed(format!(
                "libp2p swarm task panicked: {e}"
            ))),
        }
    }

    fn is_healthy(&self) -> bool {
        match &self.swarm_task {
            Some(handle) => !handle.is_finished(),
            None => false,
        }
    }
}

/// Enum-dispatched runtime object owned by a running servitude handle.
///
/// We use an enum instead of `Box<dyn Transport>` so the call sites
/// inside `ServitudeHandle` can stay on the concrete types and the
/// compiler guarantees every transport variant is handled.
///
/// Wave 3 sprint: Windows uses a parallel
/// [`dendrite_federation::DendriteFederationTransport`] backend
/// because tuwunel can't be built on Windows. The
/// `TransportVariant::MatrixFederation` config variant maps to either
/// `MatrixFederation(...)` (Linux/macOS) OR `DendriteFederation(...)`
/// (Windows) at runtime via `for_variant`. The frontend NEVER knows
/// which is in play — both transports report `name() = "matrix_federation"`
/// and both publish a registration secret through
/// `TransportRuntime::registration_token`.
#[derive(Debug)]
pub enum TransportRuntime {
    /// Embedded tuwunel Matrix homeserver as a child process. Used on
    /// Linux + macOS. The Windows arm of `for_variant` returns
    /// `DendriteFederation` instead — this variant is never
    /// constructed on a Windows runtime.
    MatrixFederation(matrix_federation::MatrixFederationTransport),
    /// Embedded dendrite Matrix homeserver as a child process. Used
    /// on Windows. Mirrors the public surface of `MatrixFederation`.
    DendriteFederation(dendrite_federation::DendriteFederationTransport),
    /// Placeholder for WireGuard tunnel — returns `NotImplemented`
    /// until the wire-up lands in a later wave.
    WireGuard,
    /// Placeholder for local-radio mesh — libp2p integration is planned
    /// in PLAN.md Phase 3 (salvage prototype in the `conquered` repo).
    Mesh,
    /// Placeholder for HTTP/QUIC tunnel — returns `NotImplemented`
    /// until the wire-up lands.
    Tunnel,
    /// Reticulum overlay transport (INS-037). Spawns `rnsd` as a
    /// child process. Non-critical — failures land in `degraded`.
    /// Only available when the `reticulum` Cargo feature is enabled.
    #[cfg(feature = "reticulum")]
    Reticulum(reticulum::ReticulumTransport),
    /// Phase 3 libp2p swarm. Always-on baseline P2P transport
    /// composed of Kad / Identify / Ping / Gossipsub /
    /// RequestResponse / Relay(server+client) / DCUtR over TCP+QUIC
    /// with Noise + Yamux. The PeerId derives from the same Ed25519
    /// seed that backs the Phase 2 `PeerIdentity.fingerprint`.
    ///
    /// Non-critical: a libp2p start failure leaves the rest of the
    /// servitude (Matrix federation, etc.) running and records the
    /// failure in `degraded`. The frontend's Profile tab surfaces
    /// the swarm status (peer count + multiaddrs) so degradation is
    /// visible.
    LibP2p(LibP2pRuntime),
    /// No-op runtime used only by unit tests that drive the
    /// `ServitudeHandle` state machine without spawning any real
    /// transport. Intentionally `#[doc(hidden)]` — the public
    /// [`Self::for_variant`] factory never returns this variant, so
    /// production code paths cannot land on it.
    #[doc(hidden)]
    Noop,
    /// No-op runtime that reports `is_critical() = false`. Exists
    /// alongside [`Self::Noop`] so unit tests can exercise the
    /// partial-failure rollback path (non-critical transport fails
    /// → lifecycle stays Running with a `degraded` entry).
    #[doc(hidden)]
    NoopNonCritical,
    /// No-op runtime that always FAILS to start with
    /// [`TransportError::NotImplemented`], and reports
    /// `is_critical() = false`. Used by the
    /// `test_servitude_handle_continues_when_noncritical_transport_fails`
    /// test to pin the partial-failure rollback contract.
    #[doc(hidden)]
    FailingNonCritical,
}

impl TransportRuntime {
    /// Build the runtime object appropriate for the given transport
    /// variant, reading any per-transport settings out of the shared
    /// `ServitudeConfig`. This is the single factory seam between the
    /// config and the transport layer.
    pub fn for_variant(
        variant: TransportVariant,
        config: &ServitudeConfig,
    ) -> Self {
        match variant {
            // Wave 3 sprint: per-OS backend split for the
            // MatrixFederation variant. Windows -> dendrite (Go,
            // single-binary, cross-compiles cleanly). All other
            // platforms -> tuwunel.
            #[cfg(target_os = "windows")]
            TransportVariant::MatrixFederation => TransportRuntime::DendriteFederation(
                dendrite_federation::DendriteFederationTransport::from_config(config),
            ),
            #[cfg(not(target_os = "windows"))]
            TransportVariant::MatrixFederation => TransportRuntime::MatrixFederation(
                matrix_federation::MatrixFederationTransport::from_config(config),
            ),
            TransportVariant::WireGuard => TransportRuntime::WireGuard,
            TransportVariant::Mesh => TransportRuntime::Mesh,
            TransportVariant::Tunnel => TransportRuntime::Tunnel,
            #[cfg(feature = "reticulum")]
            TransportVariant::Reticulum => TransportRuntime::Reticulum(
                reticulum::ReticulumTransport::from_config(config),
            ),
        }
    }

    /// Register an Application Service registration YAML path with
    /// the MatrixFederation transport inside this runtime. Called by
    /// the cross-transport pre-pass so the embedded tuwunel knows
    /// about bridges when it starts.
    ///
    /// No-op for non-MatrixFederation variants — only the homeserver
    /// transport needs to load AS registrations. On Windows
    /// (DendriteFederation), this is currently a no-op — dendrite's
    /// appservice config_files mechanism uses YAML config keys
    /// rather than runtime registration; integrating
    /// mautrix-discord on Windows is a follow-up sprint task.
    pub fn add_appservice_registration(&mut self, path: std::path::PathBuf) {
        match self {
            TransportRuntime::MatrixFederation(t) => {
                t.add_appservice_registration(path);
            }
            TransportRuntime::DendriteFederation(_) => {
                log::warn!(
                    target: "concord::servitude",
                    "appservice registration ignored on dendrite backend (path: {:?}); \
                     dendrite-side bridge wiring is a follow-up sprint",
                    path
                );
            }
            _ => {}
        }
    }

    /// The current registration token of the embedded homeserver, if
    /// this runtime variant carries one and it has been materialized
    /// by a successful `start()`.
    ///
    /// For the MatrixFederation (tuwunel) backend, this is the per-
    /// instance `m.login.registration_token` value used by the legacy
    /// Host onboarding UIA dance. For the DendriteFederation backend
    /// it is the `registration_shared_secret` (used by the
    /// `register_owner` adapter — the frontend never touches this
    /// directly anymore).
    ///
    /// In both cases, the value is exposed to the Tauri layer so the
    /// existing `servitude_get_registration_token` command keeps
    /// returning a string the UI can display ("show me the invite
    /// secret") even on Windows. The post-W3 owner-registration
    /// path no longer relies on the frontend reading this — see
    /// `servitude_register_owner`.
    pub fn registration_token(&self) -> Option<&str> {
        match self {
            TransportRuntime::MatrixFederation(t) => t.registration_token(),
            TransportRuntime::DendriteFederation(t) => t.shared_secret(),
            _ => None,
        }
    }

    /// Drive owner registration through whichever backend is active.
    /// Wave 3 sprint W3-05.
    ///
    /// Linux/macOS (tuwunel): performs the
    /// `/_matrix/client/v3/register` UIA dance using the persisted
    /// registration_token, then `/login` to obtain an access token.
    ///
    /// Windows (dendrite): shells out to `create-account.exe -admin`
    /// to register + elevate, then `/login` to obtain an access
    /// token. See [`dendrite_federation::DendriteFederationTransport::register_owner`].
    pub async fn register_owner(
        &self,
        username: &str,
        password: &str,
    ) -> Result<dendrite_federation::RegisterOwnerResponse, TransportError> {
        match self {
            TransportRuntime::DendriteFederation(t) => {
                t.register_owner(username, password).await
            }
            TransportRuntime::MatrixFederation(t) => {
                register_owner_via_matrix_uia(t, username, password).await
            }
            _ => Err(TransportError::NotImplemented(
                "register_owner only supported on MatrixFederation runtimes",
            )),
        }
    }

    /// Human-readable name for logs — matches
    /// [`Transport::name`] on the active variant.
    pub fn name(&self) -> &'static str {
        match self {
            TransportRuntime::MatrixFederation(_) => "matrix_federation",
            // Both backends report "matrix_federation" externally so
            // the frontend's logic stays platform-agnostic. The enum
            // tag is what diagnostics use to know "is this dendrite or
            // tuwunel".
            TransportRuntime::DendriteFederation(_) => "matrix_federation",
            TransportRuntime::WireGuard => "wireguard",
            TransportRuntime::Mesh => "mesh",
            TransportRuntime::Tunnel => "tunnel",
            #[cfg(feature = "reticulum")]
            TransportRuntime::Reticulum(_) => "reticulum",
            TransportRuntime::LibP2p(_) => "libp2p",
            TransportRuntime::Noop => "noop",
            TransportRuntime::NoopNonCritical => "noop_noncritical",
            TransportRuntime::FailingNonCritical => "failing_noncritical",
        }
    }

    /// Backend identifier — distinguishes tuwunel vs dendrite for
    /// diagnostics. The frontend doesn't see this; logs and the
    /// degraded-transports map do.
    pub fn backend_kind(&self) -> &'static str {
        match self {
            TransportRuntime::MatrixFederation(_) => "tuwunel",
            TransportRuntime::DendriteFederation(_) => "dendrite",
            TransportRuntime::WireGuard => "wireguard",
            TransportRuntime::Mesh => "mesh",
            TransportRuntime::Tunnel => "tunnel",
            #[cfg(feature = "reticulum")]
            TransportRuntime::Reticulum(_) => "reticulum",
            TransportRuntime::LibP2p(_) => "libp2p",
            TransportRuntime::Noop => "noop",
            TransportRuntime::NoopNonCritical => "noop_noncritical",
            TransportRuntime::FailingNonCritical => "failing_noncritical",
        }
    }

    /// Whether the active variant is critical to the servitude's
    /// operation. Mirrors [`Transport::is_critical`] for the enum
    /// variants that aren't themselves trait objects. Critical
    /// transports trigger an all-or-nothing lifecycle rollback on
    /// start failure; non-critical transports get recorded in
    /// `ServitudeHandle::degraded` and the handle stays Running.
    pub fn is_critical(&self) -> bool {
        match self {
            TransportRuntime::MatrixFederation(t) => t.is_critical(),
            TransportRuntime::DendriteFederation(t) => t.is_critical(),
            // Placeholders default to critical so any future
            // stub-driven misconfiguration fails loudly instead of
            // silently degrading.
            TransportRuntime::WireGuard
            | TransportRuntime::Mesh
            | TransportRuntime::Tunnel => true,
            #[cfg(feature = "reticulum")]
            TransportRuntime::Reticulum(t) => t.is_critical(),
            // libp2p is the baseline P2P transport but a swarm-start
            // failure should NOT take down the rest of the servitude
            // (Matrix federation runs independently of it). Mark
            // non-critical so the partial-failure path captures the
            // failure in `degraded` rather than rolling back.
            TransportRuntime::LibP2p(_) => false,
            // Test-only variants. Noop is critical (matches the
            // existing Wave 2 lifecycle tests); the dedicated
            // non-critical noops below override to false.
            TransportRuntime::Noop => true,
            TransportRuntime::NoopNonCritical => false,
            TransportRuntime::FailingNonCritical => false,
        }
    }

    /// Dispatch start to the active variant. Placeholder variants
    /// return [`TransportError::NotImplemented`] so misconfiguration
    /// surfaces as a clean error instead of a silent skip. The
    /// `Noop` variant succeeds unconditionally — it exists only to
    /// make lifecycle unit tests cheap.
    pub async fn start(&mut self) -> Result<(), TransportError> {
        match self {
            TransportRuntime::MatrixFederation(t) => t.start().await,
            TransportRuntime::DendriteFederation(t) => t.start().await,
            TransportRuntime::WireGuard => {
                Err(TransportError::NotImplemented("wireguard"))
            }
            TransportRuntime::Mesh => Err(TransportError::NotImplemented("mesh")),
            TransportRuntime::Tunnel => {
                Err(TransportError::NotImplemented("tunnel"))
            }
            #[cfg(feature = "reticulum")]
            TransportRuntime::Reticulum(t) => t.start().await,
            TransportRuntime::LibP2p(t) => t.start().await,
            TransportRuntime::Noop | TransportRuntime::NoopNonCritical => Ok(()),
            TransportRuntime::FailingNonCritical => {
                Err(TransportError::NotImplemented("failing_noncritical"))
            }
        }
    }

    /// Dispatch stop to the active variant. Placeholder variants are
    /// no-ops on stop (there's nothing to tear down if there was
    /// nothing to bring up), which keeps lifecycle state machine
    /// rollback paths simple.
    pub async fn stop(&mut self) -> Result<(), TransportError> {
        match self {
            TransportRuntime::MatrixFederation(t) => t.stop().await,
            TransportRuntime::DendriteFederation(t) => t.stop().await,
            TransportRuntime::WireGuard
            | TransportRuntime::Mesh
            | TransportRuntime::Tunnel
            | TransportRuntime::Noop
            | TransportRuntime::NoopNonCritical
            | TransportRuntime::FailingNonCritical => Ok(()),
            #[cfg(feature = "reticulum")]
            TransportRuntime::Reticulum(t) => t.stop().await,
            TransportRuntime::LibP2p(t) => t.stop().await,
        }
    }

    /// Dispatch health check to the active variant. Placeholders
    /// report unhealthy so the UI never shows a green light for a
    /// transport that hasn't been implemented. `Noop` reports
    /// healthy (tests that exercise the lifecycle expect a Running
    /// state to be consistent with a healthy report).
    pub async fn is_healthy(&self) -> bool {
        match self {
            TransportRuntime::MatrixFederation(t) => t.is_healthy().await,
            TransportRuntime::DendriteFederation(t) => t.is_healthy().await,
            TransportRuntime::WireGuard
            | TransportRuntime::Mesh
            | TransportRuntime::Tunnel => false,
            #[cfg(feature = "reticulum")]
            TransportRuntime::Reticulum(t) => t.is_healthy().await,
            TransportRuntime::LibP2p(t) => t.is_healthy(),
            TransportRuntime::Noop | TransportRuntime::NoopNonCritical => true,
            TransportRuntime::FailingNonCritical => false,
        }
    }

    /// If this runtime is a [`TransportRuntime::LibP2p`] and the swarm
    /// has been started, returns a clone of its broadcast sender so
    /// callers can subscribe to swarm events. Returns `None` for every
    /// other variant or when the libp2p swarm is stopped.
    pub fn libp2p_event_sender(&self) -> Option<broadcast::Sender<P2pSwarmEvent>> {
        match self {
            TransportRuntime::LibP2p(t) => t.event_sender(),
            _ => None,
        }
    }

    /// If this runtime is a [`TransportRuntime::LibP2p`] and the swarm
    /// has been started, returns the local libp2p `PeerId`. Returns
    /// `None` for every other variant or when the swarm is stopped.
    pub fn libp2p_local_peer_id(&self) -> Option<libp2p::PeerId> {
        match self {
            TransportRuntime::LibP2p(t) => t.local_peer_id(),
            _ => None,
        }
    }

    /// Phase 8 follow-up — wire the voice-call registry into the
    /// LibP2p runtime variant. No-op for every other variant.
    pub fn set_voice_registry(
        &mut self,
        registry: Arc<crate::servitude::voice::VoiceCallRegistry>,
    ) {
        if let TransportRuntime::LibP2p(t) = self {
            t.set_voice_registry(registry);
        }
    }

    /// Phase 8 follow-up — clone of the libp2p runtime's outbound
    /// voice signaling sender. `None` for every other variant.
    pub fn voice_outbound_sender(
        &self,
    ) -> Option<
        tokio::sync::mpsc::Sender<(
            libp2p::PeerId,
            crate::servitude::voice::SignalingMessage,
        )>,
    > {
        match self {
            TransportRuntime::LibP2p(t) => Some(t.voice_outbound_sender()),
            _ => None,
        }
    }

    /// Porch Phase A — wire the porch into the LibP2p runtime variant.
    /// No-op for every other variant.
    pub fn set_porch(&mut self, porch: Arc<crate::porch::Porch>) {
        if let TransportRuntime::LibP2p(t) = self {
            t.set_porch(porch);
        }
    }

    /// Porch Phase A — clone of the libp2p stream control captured at
    /// `start()`, suitable for opening outbound porch streams. `None`
    /// for every other variant or while the swarm is stopped.
    pub fn porch_stream_control(&self) -> Option<libp2p_stream::Control> {
        match self {
            TransportRuntime::LibP2p(t) => t.porch_stream_control(),
            _ => None,
        }
    }
}

/// Drive the m.login.registration_token UIA dance against the
/// embedded tuwunel, then `/login` to mint an access token. Wave 3
/// W3-05: this used to live in the frontend (HostOnboarding.tsx);
/// it's now backend-side so the same `servitude_register_owner`
/// command works on every platform.
async fn register_owner_via_matrix_uia(
    transport: &matrix_federation::MatrixFederationTransport,
    username: &str,
    password: &str,
) -> Result<dendrite_federation::RegisterOwnerResponse, TransportError> {
    use std::time::Duration;
    let token = transport.registration_token().ok_or_else(|| {
        TransportError::StartFailed(
            "register_owner_via_matrix_uia: registration_token not yet \
             materialized; call start() first"
                .to_string(),
        )
    })?;

    // Tuwunel binds the same port as the transport's listen_port; we
    // don't have a public accessor for that, but `name()` ensures the
    // tuwunel transport is what we have. Pull the port from the
    // transport's internal config via the registration_token side
    // effect — this is unfortunately a coupling, but it's the same
    // coupling the frontend used to have. To avoid stamping new
    // public API, parse from the server_name. NOTE: tuwunel's
    // server_name is "localhost:<port>" by construction (see
    // matrix_federation::MatrixFederationTransport::from_config).
    // We can't read the listen port directly, so we hit
    // 127.0.0.1:8765 — the default port. This is a known limitation;
    // the integration test in servitude/mod.rs uses Noop runtimes
    // and exercises the dispatch shape only.
    //
    // Production code path: the listen_port comes from the
    // ServitudeConfig that was passed to from_config. In practice
    // that's always 8765 today (the only enabled value). When the
    // Wave 4 tunneling transport adds dynamic port selection, we'll
    // need to plumb the port through register_owner explicitly.
    let homeserver_url = "http://127.0.0.1:8765";
    let register_url = format!("{}/_matrix/client/v3/register", homeserver_url);
    let login_url = format!("{}/_matrix/client/v3/login", homeserver_url);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to build reqwest client: {}",
                e
            ))
        })?;

    // Step 1 — probe to elicit the UIA challenge. Tuwunel returns 401
    // with a JSON body containing the session id and supported flows.
    let probe_body = serde_json::json!({});
    let probe = client
        .post(&register_url)
        .json(&probe_body)
        .send()
        .await
        .map_err(|e| {
            TransportError::StartFailed(format!(
                "register UIA probe failed: {}",
                e
            ))
        })?;

    if probe.status().as_u16() != 401 {
        let status = probe.status();
        let body = probe.text().await.unwrap_or_default();
        return Err(TransportError::StartFailed(format!(
            "register probe expected 401 (UIA challenge), got {}: {}",
            status, body
        )));
    }

    let probe_json: serde_json::Value = probe.json().await.map_err(|e| {
        TransportError::StartFailed(format!(
            "register probe response was not valid JSON: {}",
            e
        ))
    })?;

    let session = probe_json
        .get("session")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            TransportError::StartFailed(
                "register UIA challenge missing session id".to_string(),
            )
        })?
        .to_string();

    // Step 2 — final POST with username + password + auth.
    let final_body = serde_json::json!({
        "username": username,
        "password": password,
        "auth": {
            "type": "m.login.registration_token",
            "token": token,
            "session": session,
        },
    });

    let final_resp = client
        .post(&register_url)
        .json(&final_body)
        .send()
        .await
        .map_err(|e| {
            TransportError::StartFailed(format!(
                "register final POST failed: {}",
                e
            ))
        })?;

    if !final_resp.status().is_success() {
        let status = final_resp.status();
        let body = final_resp.text().await.unwrap_or_default();
        return Err(TransportError::StartFailed(format!(
            "register final POST failed {}: {}",
            status, body
        )));
    }

    let parsed: serde_json::Value = final_resp.json().await.map_err(|e| {
        TransportError::StartFailed(format!(
            "register final response was not valid JSON: {}",
            e
        ))
    })?;

    // tuwunel returns access_token + device_id directly on the
    // register response (the `inhibit_login: false` default), so we
    // don't need a separate /login round-trip when the registration
    // succeeds. Try to extract from the register response first; fall
    // back to /login if any field is missing.
    let user_id = parsed
        .get("user_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let access_token = parsed
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let device_id = parsed
        .get("device_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let (Some(uid), Some(at), Some(did)) =
        (user_id.clone(), access_token.clone(), device_id.clone())
    {
        return Ok(dendrite_federation::RegisterOwnerResponse {
            user_id: uid,
            access_token: at,
            device_id: did,
        });
    }

    // Fallback /login path — only reached if register response was
    // missing fields (shouldn't happen with tuwunel today, but guards
    // a future tuwunel build that ships inhibit_login: true).
    let login_body = serde_json::json!({
        "type": "m.login.password",
        "identifier": {
            "type": "m.id.user",
            "user": username,
        },
        "password": password,
        "initial_device_display_name": "concord-host-onboarding",
    });
    let login_resp = client
        .post(&login_url)
        .json(&login_body)
        .send()
        .await
        .map_err(|e| {
            TransportError::StartFailed(format!("/login POST failed: {}", e))
        })?;
    if !login_resp.status().is_success() {
        let status = login_resp.status();
        let body = login_resp.text().await.unwrap_or_default();
        return Err(TransportError::StartFailed(format!(
            "/login returned {}: {}",
            status, body
        )));
    }
    let lp: serde_json::Value = login_resp.json().await.map_err(|e| {
        TransportError::StartFailed(format!(
            "/login response was not valid JSON: {}",
            e
        ))
    })?;
    let user_id = lp
        .get("user_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            TransportError::StartFailed("/login missing user_id".to_string())
        })?
        .to_string();
    let access_token = lp
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            TransportError::StartFailed("/login missing access_token".to_string())
        })?
        .to_string();
    let device_id = lp
        .get("device_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            TransportError::StartFailed("/login missing device_id".to_string())
        })?
        .to_string();

    Ok(dendrite_federation::RegisterOwnerResponse {
        user_id,
        access_token,
        device_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servitude::config::{ServitudeConfig, Transport as TransportVariant};

    fn test_config() -> ServitudeConfig {
        ServitudeConfig {
            display_name: "test-node".to_string(),
            max_peers: 16,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![TransportVariant::MatrixFederation],
            profile: crate::servitude::config::Profile::WebFirst,
        }
    }

    #[test]
    fn test_factory_returns_matrix_federation_for_variant() {
        let runtime = TransportRuntime::for_variant(
            TransportVariant::MatrixFederation,
            &test_config(),
        );
        // Both backends report "matrix_federation" externally so the
        // frontend stays platform-agnostic.
        assert_eq!(runtime.name(), "matrix_federation");
    }

    /// Wave 3 sprint W3-04: per-OS backend dispatch. On Windows the
    /// MatrixFederation variant maps to a DendriteFederation runtime;
    /// on every other platform it maps to a MatrixFederation runtime.
    #[cfg(target_os = "windows")]
    #[test]
    fn test_factory_uses_dendrite_backend_on_windows() {
        let runtime = TransportRuntime::for_variant(
            TransportVariant::MatrixFederation,
            &test_config(),
        );
        assert_eq!(
            runtime.backend_kind(),
            "dendrite",
            "Windows must select the dendrite backend"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_factory_uses_tuwunel_backend_on_non_windows() {
        let runtime = TransportRuntime::for_variant(
            TransportVariant::MatrixFederation,
            &test_config(),
        );
        assert_eq!(
            runtime.backend_kind(),
            "tuwunel",
            "non-Windows platforms must select the tuwunel backend"
        );
    }

    #[test]
    fn test_factory_returns_placeholder_variants_correctly() {
        let wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        assert_eq!(wg.name(), "wireguard");
        let mesh = TransportRuntime::for_variant(TransportVariant::Mesh, &test_config());
        assert_eq!(mesh.name(), "mesh");
        let tunnel = TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        assert_eq!(tunnel.name(), "tunnel");
    }

    #[tokio::test]
    async fn test_placeholder_variants_report_not_implemented_on_start() {
        let mut wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        let err = wg.start().await.expect_err("wireguard must not start");
        assert!(matches!(err, TransportError::NotImplemented("wireguard")));

        let mut tunnel =
            TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        let err = tunnel.start().await.expect_err("tunnel must not start");
        assert!(matches!(err, TransportError::NotImplemented("tunnel")));
    }

    #[tokio::test]
    async fn test_placeholder_variants_report_unhealthy() {
        let wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        assert!(!wg.is_healthy().await);
        let mesh = TransportRuntime::for_variant(TransportVariant::Mesh, &test_config());
        assert!(!mesh.is_healthy().await);
        let tunnel = TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        assert!(!tunnel.is_healthy().await);
    }

    #[tokio::test]
    async fn test_placeholder_variants_stop_is_noop() {
        // Stopping an un-started placeholder is a no-op by design —
        // lifecycle rollback paths rely on this, so the test pins it.
        let mut wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        wg.stop().await.expect("wg stop must be a noop");
        let mut mesh = TransportRuntime::for_variant(TransportVariant::Mesh, &test_config());
        mesh.stop().await.expect("mesh stop must be a noop");
        let mut tunnel =
            TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        tunnel.stop().await.expect("tunnel stop must be a noop");
    }
}
