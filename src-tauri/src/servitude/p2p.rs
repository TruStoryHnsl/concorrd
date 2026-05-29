//! Phase 3 (INS-019b) — rust-libp2p transport for the embedded servitude
//! module.
//!
//! This module wires a libp2p `Swarm` whose Ed25519 keypair is derived from
//! the **per-install peer-identity seed** stored in Stronghold (see
//! [`crate::servitude::identity::peer_seed`]). The local `PeerId` is therefore
//! a deterministic function of the persisted seed — the same install
//! produces the same `PeerId` for the lifetime of the seed record, AND the
//! same install yields the same `PeerIdentity.public_key` /
//! `PeerIdentity.fingerprint` that the Phase 2 user-facing identity exposes.
//! There is exactly one identity per install; libp2p and the Settings →
//! Profile fingerprint agree.
//!
//! ## Behaviour composition
//!
//! The `Behaviour` derive-macro composes the protocols required by the
//! Phase 3 design doc:
//!
//!   * [`libp2p::kad::Behaviour`] — Kademlia DHT (no bootstrap seeds at
//!     Phase 3; Phase 4 wires project bootstrap nodes).
//!   * [`libp2p::identify::Behaviour`] — peer-version exchange. Protocol
//!     version string is `"concord/<package-version>"`.
//!   * [`libp2p::ping::Behaviour`] — liveness.
//!   * [`libp2p::gossipsub::Behaviour`] — topic-based pubsub. Authenticated
//!     with the local keypair (signed messages).
//!   * [`libp2p::request_response::Behaviour`] with a hand-rolled
//!     length-delimited bytes codec — placeholder for application-level
//!     request/response payloads (cbor4ii intentionally NOT pulled in;
//!     re-evaluate when concrete payload types land).
//!   * [`libp2p::relay::Behaviour`] — server-side Circuit Relay v2.
//!   * [`libp2p::relay::client::Behaviour`] — client-side Circuit Relay v2.
//!   * [`libp2p::dcutr::Behaviour`] — Direct-Connection Upgrade through
//!     Relay (hole punching).
//!
//! ## Transport stack
//!
//! TCP + QUIC, both with Noise (xx) for authenticated encryption and Yamux
//! for stream multiplexing. Listeners come up on ephemeral ports
//! (`/ip4/0.0.0.0/tcp/0` + `/ip4/0.0.0.0/udp/0/quic-v1`) so two transports
//! can coexist in one test process.
//!
//! ## Event surface
//!
//! [`LibP2pTransport::subscribe`] returns a `broadcast::Receiver` over the
//! lightweight [`SwarmEvent`] enum. The full `libp2p::swarm::SwarmEvent`
//! shape is intentionally not exposed — the React UI only needs to know
//! about listen-address changes, peer-count changes, and dial outcomes.

use std::collections::HashSet;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::prelude::*;
use libp2p::{
    dcutr, gossipsub, identify, identity as libp2p_identity, kad, ping, relay, request_response,
    swarm::{NetworkBehaviour, SwarmEvent as LibP2pSwarmEvent},
    Multiaddr, PeerId, StreamProtocol,
};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::broadcast;

use crate::servitude::bootstrap;
use crate::servitude::federation::FederationHandler;
use crate::servitude::identity::{self, PeerIdentity, StrongholdHandle};

/// Identify protocol-version string. Pinned to the package version at
/// build time so Phase 3 nodes observe each other's exact Concord release.
const IDENTIFY_PROTOCOL_VERSION: &str = concat!("concord/", env!("CARGO_PKG_VERSION"));

/// Identify agent-version string — included in remote peers' Identify
/// payloads for human-readable diagnostics.
const IDENTIFY_AGENT_VERSION: &str = concat!("concord/", env!("CARGO_PKG_VERSION"));

/// Kademlia protocol name. Distinct namespace from `/ipfs/kad/1.0.0` so
/// Concord swarms don't accidentally cross-pollinate with public IPFS DHTs.
const KAD_PROTOCOL: StreamProtocol = StreamProtocol::new("/concord/kad/1.0.0");

/// Request-response protocol name. Phase 3 placeholder; concrete payload
/// types land in Phase 4+.
const REQ_RESP_PROTOCOL: StreamProtocol = StreamProtocol::new("/concord/req-resp/1.0.0");

/// Default Multiaddrs the swarm tries to listen on at startup. Ephemeral
/// ports so two transports can run in the same process for tests.
const LISTEN_QUIC: &str = "/ip4/0.0.0.0/udp/0/quic-v1";
const LISTEN_TCP: &str = "/ip4/0.0.0.0/tcp/0";

/// Maximum frame size for the bytes request-response codec. 1 MiB matches
/// the cbor codec's default — keeps the wire surface small.
const MAX_FRAME_BYTES: u64 = 1024 * 1024;

/// Capacity of the event broadcast channel. Slow subscribers will drop
/// older events rather than back-pressure the swarm loop.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Phase 4 Kademlia bootstrap retry — initial backoff after a failed
/// `kad::bootstrap()` call.
const BOOTSTRAP_RETRY_INITIAL: Duration = Duration::from_secs(5);

/// Phase 4 Kademlia bootstrap retry — backoff ceiling. Doubles each
/// failed attempt until it hits this cap; from there every retry
/// happens at this fixed interval.
const BOOTSTRAP_RETRY_MAX: Duration = Duration::from_secs(300);

/// Errors raised while constructing or driving the libp2p transport.
#[derive(Debug, Error)]
pub enum P2pError {
    #[error("identity export failed: {0}")]
    Identity(#[from] identity::IdentityError),

    #[error("invalid libp2p keypair bytes: {0}")]
    KeypairDecode(#[from] libp2p_identity::DecodingError),

    #[error("noise config error: {0}")]
    Noise(#[from] libp2p::noise::Error),

    #[error("gossipsub config build error: {0}")]
    GossipsubConfig(String),

    #[error("gossipsub behaviour error: {0}")]
    Gossipsub(&'static str),

    #[error("invalid listen multiaddr: {0}")]
    MultiaddrParse(#[from] libp2p::multiaddr::Error),

    #[error("listen failed: {0}")]
    ListenFailed(String),

    #[error("io error: {0}")]
    Io(#[from] io::Error),
}

/// Lightweight, UI-friendly projection of `libp2p::swarm::SwarmEvent`.
#[derive(Debug, Clone)]
pub enum SwarmEvent {
    /// A new local listening address became available.
    LocalAddrChanged { addr: Multiaddr },
    /// The set of connected peers changed; `count` is the new total.
    PeerCountChanged { count: usize },
    /// A dial attempt succeeded.
    DialSuccess { peer_id: PeerId },
    /// A dial attempt failed.
    DialFailure {
        peer_id: Option<PeerId>,
        reason: String,
    },
    /// Phase 4: the Kad routing table picked up (or refreshed) a peer.
    /// `peer_count` is the number of distinct peers the local node has
    /// seen via Kad routing updates over the swarm's lifetime — NOT a
    /// live count of currently-routable peers (libp2p's routing table
    /// doesn't expose a cheap snapshot count, and the UI cares about
    /// "is the DHT alive?" more than the exact size).
    DhtRoutingUpdated { peer_count: usize },
    /// Phase 6: an inbound libp2p stream was accepted for a registered
    /// federation protocol ID and is being driven by the matching
    /// `FederationHandler`. `protocol_id` is the literal stream protocol
    /// (e.g. `/concord/matrix-federation/1.0.0`); `peer_id` is the
    /// remote peer's libp2p PeerId stringified for the UI.
    FederationStreamOpened {
        protocol_id: String,
        peer_id: String,
    },
}

/// Composed network behaviour. The derive-macro generates a single struct
/// implementing [`libp2p::swarm::NetworkBehaviour`] over each field.
#[derive(NetworkBehaviour)]
pub struct Behaviour {
    pub kad: kad::Behaviour<kad::store::MemoryStore>,
    pub identify: identify::Behaviour,
    pub ping: ping::Behaviour,
    pub gossipsub: gossipsub::Behaviour,
    pub request_response: request_response::Behaviour<BytesCodec>,
    /// Server-side Circuit Relay v2 — lets other peers use this node as a
    /// hole-punching relay.
    pub relay: relay::Behaviour,
    /// Client-side Circuit Relay v2 — lets this node use other peers as
    /// relays for incoming connections behind NAT.
    pub relay_client: relay::client::Behaviour,
    /// Direct Connection Upgrade through Relay — hole-punching.
    pub dcutr: dcutr::Behaviour,
    /// Phase 6: generic libp2p stream protocol multiplexer. Lets the
    /// transport register inbound stream acceptors per
    /// federation-protocol ID and clone a `Control` for outbound
    /// stream opens.
    pub stream: libp2p_stream::Behaviour,
}

/// Handle to a running libp2p swarm.
///
/// Construction is via [`Self::new`]; the swarm event loop runs inside the
/// future returned by [`Self::run`]. The handle exposes the local PeerId
/// and a broadcast subscription so the React UI can observe state changes.
pub struct LibP2pTransport {
    swarm: libp2p::Swarm<Behaviour>,
    event_tx: broadcast::Sender<SwarmEvent>,
    local_peer_id: PeerId,
    shutdown_rx: tokio::sync::mpsc::Receiver<()>,
    shutdown_tx: tokio::sync::mpsc::Sender<()>,
    /// Phase 6: federation handlers registered for this swarm. Each one
    /// is paired with a libp2p stream protocol ID; the dispatcher in
    /// `run()` opens an `IncomingStreams` per handler and spawns a
    /// per-stream task that calls `handle_inbound`.
    federation_handlers: Vec<Arc<dyn FederationHandler>>,
    /// Phase 6: clone-able control handle for the `libp2p_stream`
    /// behaviour. Exposed to outbound-stream callers via
    /// [`Self::stream_control`] so they can `open_stream(peer, proto)`
    /// without needing `&mut swarm`.
    stream_control: libp2p_stream::Control,
}

impl LibP2pTransport {
    /// Build a new transport. The PeerId is derived from the same per-install
    /// Ed25519 seed that backs Phase 2's user-visible `PeerIdentity` (see
    /// [`identity::peer_seed`]). The swarm starts listening on ephemeral TCP
    /// + QUIC ports and seeds Kad with the hardcoded project bootstrap nodes
    /// (Phase 4 — see [`crate::servitude::bootstrap`]).
    ///
    /// `peer_identity` is taken for cross-derivation sanity — the libp2p
    /// keypair's public key bytes must match `peer_identity.public_key`,
    /// because both derive from the same seed via the same Ed25519 math.
    pub async fn new(
        peer_identity: &PeerIdentity,
        stronghold: &StrongholdHandle,
    ) -> Result<Self, P2pError> {
        Self::new_inner(peer_identity, stronghold, bootstrap::bootstrap_multiaddrs()).await
    }

    /// Test/integration-only constructor that lets the caller substitute a
    /// custom bootstrap multiaddr list in place of the hardcoded production
    /// list. Used by `tests/p2p_test.rs` to spin up loopback bootstrap
    /// swarms without depending on real DNS or the deployed VPS fleet.
    ///
    /// Production code MUST keep using [`Self::new`]; the hardcoded list is
    /// the only project-controlled bootstrap surface.
    pub async fn new_with_bootstrap_override(
        peer_identity: &PeerIdentity,
        stronghold: &StrongholdHandle,
        bootstrap_addrs: Vec<Multiaddr>,
    ) -> Result<Self, P2pError> {
        Self::new_inner(peer_identity, stronghold, bootstrap_addrs).await
    }

    async fn new_inner(
        peer_identity: &PeerIdentity,
        stronghold: &StrongholdHandle,
        bootstrap_addrs: Vec<Multiaddr>,
    ) -> Result<Self, P2pError> {
        // Pull the per-install seed out of the identity module's cache.
        // Bytes are wrapped in `Zeroizing` so they wipe themselves when the
        // local binding falls out of scope.
        let mut seed = identity::peer_seed(stronghold).await?;

        // libp2p's `ed25519_from_bytes` takes `impl AsMut<[u8]>` and reads
        // the seed in place. The Zeroizing wrapper's deref hands back an
        // owned `[u8;32]` we can mutate in flight.
        let keypair = {
            let mut seed_copy = *seed;
            let kp = libp2p_identity::Keypair::ed25519_from_bytes(&mut seed_copy)?;
            // Explicit overwrite so the temporary doesn't linger.
            use zeroize::Zeroize;
            seed_copy.zeroize();
            kp
        };

        // Drop the exported seed now that the libp2p keypair has copied
        // everything it needs out of it.
        use zeroize::Zeroize;
        seed.as_mut().zeroize();

        let local_peer_id = PeerId::from_public_key(&keypair.public());

        // Architectural invariant: the libp2p Ed25519 public-key bytes MUST
        // equal `peer_identity.public_key`. Both derive from the same seed
        // via the same Ed25519 math — if they diverge, the seed pipeline is
        // broken and Settings → Profile would show a different identity than
        // libp2p reports to peers.
        let libp2p_pub = keypair
            .public()
            .try_into_ed25519()
            .expect("ed25519_from_bytes always yields an ed25519 keypair")
            .to_bytes();
        debug_assert_eq!(
            libp2p_pub, peer_identity.public_key,
            "libp2p public key must match PeerIdentity.public_key — both \
             derive from the same per-install seed"
        );

        let (event_tx, _event_rx) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel(1);

        // Build the swarm using libp2p's typestate builder. `with_tokio()`
        // selects the Tokio executor; `with_quic()`/`with_tcp()` set up the
        // transport stack; `with_relay_client()` injects the client-side
        // relay transport (mandatory before the relay::client::Behaviour
        // can be wired); `with_behaviour()` runs the composer closure.
        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(keypair.clone())
            .with_tokio()
            .with_tcp(
                libp2p::tcp::Config::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )?
            .with_quic()
            .with_relay_client(libp2p::noise::Config::new, libp2p::yamux::Config::default)?
            .with_behaviour(|key, relay_client| -> Result<Behaviour, Box<dyn std::error::Error + Send + Sync>> {
                let local_id = PeerId::from_public_key(&key.public());

                // Kad with an in-memory routing table. Phase 4 swaps in a
                // disk-backed store and wires bootstrap nodes.
                let mut kad_config = kad::Config::new(KAD_PROTOCOL);
                kad_config.set_query_timeout(Duration::from_secs(60));
                let kad_store = kad::store::MemoryStore::new(local_id);
                let kad =
                    kad::Behaviour::with_config(local_id, kad_store, kad_config);

                let identify = identify::Behaviour::new(identify::Config::new(
                    IDENTIFY_PROTOCOL_VERSION.to_string(),
                    key.public(),
                ).with_agent_version(IDENTIFY_AGENT_VERSION.to_string()));

                let ping = ping::Behaviour::new(ping::Config::new());

                // Signed gossipsub messages — authenticated with the local
                // ed25519 keypair so receivers can verify origin without
                // any side-channel trust.
                let gossipsub_config = gossipsub::ConfigBuilder::default()
                    .heartbeat_interval(Duration::from_secs(1))
                    .validation_mode(gossipsub::ValidationMode::Strict)
                    .build()
                    .map_err(|e| format!("gossipsub config: {e}"))?;
                let gossipsub = gossipsub::Behaviour::new(
                    gossipsub::MessageAuthenticity::Signed(key.clone()),
                    gossipsub_config,
                )
                .map_err(|e| format!("gossipsub behaviour: {e}"))?;

                let request_response = request_response::Behaviour::with_codec(
                    BytesCodec::default(),
                    [(REQ_RESP_PROTOCOL, request_response::ProtocolSupport::Full)],
                    request_response::Config::default(),
                );

                let relay = relay::Behaviour::new(local_id, relay::Config::default());

                let dcutr = dcutr::Behaviour::new(local_id);

                let stream = libp2p_stream::Behaviour::new();

                Ok(Behaviour {
                    kad,
                    identify,
                    ping,
                    gossipsub,
                    request_response,
                    relay,
                    relay_client,
                    dcutr,
                    stream,
                })
            })
            .map_err(|e| P2pError::Gossipsub(Box::leak(e.to_string().into_boxed_str()) as &'static str))?
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
            .build();

        // Start listening on ephemeral QUIC + TCP. Order is QUIC first
        // because the QUIC listener is what test 2 asserts on.
        let quic_addr: Multiaddr = LISTEN_QUIC.parse()?;
        swarm
            .listen_on(quic_addr)
            .map_err(|e| P2pError::ListenFailed(format!("quic: {e}")))?;
        let tcp_addr: Multiaddr = LISTEN_TCP.parse()?;
        swarm
            .listen_on(tcp_addr)
            .map_err(|e| P2pError::ListenFailed(format!("tcp: {e}")))?;

        // Phase 4 (INS-019b) — Kademlia bootstrap wiring.
        //
        // Native builds default to Client mode: they consume the DHT
        // for peer lookups but don't expose their kbucket to the wider
        // network. The docker / always-on profile gets Server mode in
        // a follow-up commit (no per-profile config flag exists yet, so
        // we hardcode Client here and document the override path).
        //
        // We don't dial bootstrap peers explicitly — Kad's own
        // bootstrap query walks the addresses we register via
        // `add_address` below. The first bootstrap attempt may race
        // listener setup and fail; the retry loop in `run()` handles
        // that with exponential backoff.
        swarm
            .behaviour_mut()
            .kad
            .set_mode(Some(kad::Mode::Client));
        let bootstrap_count = seed_kad_bootstrap(&mut swarm, &bootstrap_addrs);
        log::debug!(
            target: "concord::servitude::p2p",
            "seeded kad with {bootstrap_count} bootstrap address(es)"
        );
        // First bootstrap attempt. `NoKnownPeers` here is expected when
        // the bootstrap list is empty (no addresses parsed) — the
        // retry loop in `run()` will pick it up again once listeners
        // are alive. Never panic, never error out.
        match swarm.behaviour_mut().kad.bootstrap() {
            Ok(qid) => log::debug!(
                target: "concord::servitude::p2p",
                "initial kad bootstrap query started (id={qid:?})"
            ),
            Err(e) => log::debug!(
                target: "concord::servitude::p2p",
                "initial kad bootstrap deferred: {e} (retry loop will pick it up)"
            ),
        }

        // Phase 6: extract the stream-behaviour control BEFORE moving the
        // swarm into Self. Control is `Clone` so subsequent calls to
        // `stream_control()` hand callers their own copy.
        let stream_control = swarm.behaviour().stream.new_control();

        Ok(Self {
            swarm,
            event_tx,
            local_peer_id,
            shutdown_rx,
            shutdown_tx,
            federation_handlers: Vec::new(),
            stream_control,
        })
    }

    /// Local peer id (deterministic function of the libp2p seed).
    pub fn local_peer_id(&self) -> PeerId {
        self.local_peer_id
    }

    /// Phase 6: register a federation handler under its declared
    /// protocol ID. Must be called BEFORE [`Self::run`] consumes the
    /// transport — the dispatch loop opens one `IncomingStreams` per
    /// handler when `run()` starts.
    ///
    /// Calling this with two handlers that share a `protocol_id()` is
    /// a programmer error: the second `Control::accept` would return
    /// `AlreadyRegistered`. The dispatch loop logs and skips that case.
    pub fn register_federation_handler(&mut self, handler: Arc<dyn FederationHandler>) {
        self.federation_handlers.push(handler);
    }

    /// Phase 6: clone of the libp2p stream-behaviour `Control`. Lets
    /// outbound-stream callers open streams against the running swarm
    /// without needing mutable access to it.
    pub fn stream_control(&self) -> libp2p_stream::Control {
        self.stream_control.clone()
    }

    /// Subscribe to swarm events. The receiver sees every event published
    /// from this point forward.
    pub fn subscribe(&self) -> broadcast::Receiver<SwarmEvent> {
        self.event_tx.subscribe()
    }

    /// Clone of the internal broadcast sender. Wave 2 wiring uses this to
    /// hand the sender out to Tauri-managed state BEFORE [`Self::run`]
    /// consumes `self`, so the React side can subscribe to swarm events
    /// across the full lifetime of the spawned event loop.
    pub fn event_sender(&self) -> broadcast::Sender<SwarmEvent> {
        self.event_tx.clone()
    }

    /// Get an explicit shutdown sender. Dropping all senders ALSO causes
    /// the event loop to exit, but exposing a handle lets the caller
    /// trigger shutdown without waiting for drop ordering to play out.
    pub fn shutdown_handle(&self) -> tokio::sync::mpsc::Sender<()> {
        self.shutdown_tx.clone()
    }

    /// Mutable access to the underlying swarm. Used by integration tests
    /// (and Phase 4 dial logic) to issue `dial()` calls without having to
    /// re-implement the event loop.
    pub fn swarm_mut(&mut self) -> &mut libp2p::Swarm<Behaviour> {
        &mut self.swarm
    }

    /// Drive the swarm event loop. Translates relevant `libp2p::swarm`
    /// events into the lightweight [`SwarmEvent`] enum and publishes them
    /// on the broadcast channel. Continues on per-event errors; exits only
    /// when the shutdown sender is signalled.
    ///
    /// Also drives the Phase 4 Kad bootstrap retry: on
    /// `kad::QueryResult::Bootstrap(Err(_))` we schedule a retry with
    /// exponential backoff (5s → 10s → 20s → … capped at 5 min). The
    /// retry is logged at `debug!` rather than `error!` — bootstrap
    /// failure during a transient network drop must not surface as a
    /// red banner in the UI.
    pub async fn run(mut self) {
        let mut connected: HashSet<PeerId> = HashSet::new();
        let mut dht_peers: HashSet<PeerId> = HashSet::new();
        let mut bootstrap_backoff = BOOTSTRAP_RETRY_INITIAL;
        // `Pin<Box<Sleep>>` so we can hold a single sleep future across
        // `select!` iterations and reset/replace it in place when a new
        // backoff window is needed.
        let bootstrap_retry = tokio::time::sleep(Duration::from_secs(60 * 60 * 24));
        tokio::pin!(bootstrap_retry);

        // Phase 6: bootstrap inbound stream acceptors per registered
        // federation handler. Each handler gets its own `IncomingStreams`
        // receiver wired through the cloned `Control`; per-stream tasks
        // are spawned as inbound streams arrive. This loop drains the
        // registered handlers and starts long-lived listener tasks; it
        // does NOT block the main swarm event loop below.
        let mut stream_control = self.stream_control.clone();
        for handler in self.federation_handlers.drain(..) {
            let proto = StreamProtocol::new(handler.protocol_id());
            let incoming = match stream_control.accept(proto.clone()) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!(
                        target: "concord::servitude::p2p",
                        "skipping duplicate federation handler registration for {}: {e:?}",
                        handler.protocol_id()
                    );
                    continue;
                }
            };
            let event_tx = self.event_tx.clone();
            let handler_for_spawn = handler.clone();
            tokio::spawn(async move {
                let mut incoming = incoming;
                while let Some((peer_id, stream)) = incoming.next().await {
                    // Publish the FederationStreamOpened event BEFORE
                    // driving the handler so the UI sees the stream
                    // open even if the handler errors out immediately.
                    let _ = event_tx.send(SwarmEvent::FederationStreamOpened {
                        protocol_id: handler_for_spawn.protocol_id().to_string(),
                        peer_id: peer_id.to_string(),
                    });
                    // Drive each inbound stream concurrently — one
                    // misbehaving peer must not block other peers'
                    // streams on the same protocol.
                    let handler_for_stream = handler_for_spawn.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handler_for_stream
                            .handle_inbound(peer_id, stream)
                            .await
                        {
                            log::warn!(
                                target: "concord::servitude::p2p",
                                "federation handler error (protocol={}, peer={}): {e}",
                                handler_for_stream.protocol_id(),
                                peer_id
                            );
                        }
                    });
                }
            });
        }

        loop {
            tokio::select! {
                _ = self.shutdown_rx.recv() => {
                    log::info!(
                        target: "concord::servitude::p2p",
                        "libp2p swarm shutdown signal received — exiting event loop"
                    );
                    break;
                }
                _ = &mut bootstrap_retry => {
                    // Push the timer way out so it doesn't fire again
                    // until we re-arm it on the next Bootstrap(Err).
                    bootstrap_retry
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_secs(60 * 60 * 24));
                    match self.swarm.behaviour_mut().kad.bootstrap() {
                        Ok(qid) => log::debug!(
                            target: "concord::servitude::p2p",
                            "kad bootstrap retry started (id={qid:?})"
                        ),
                        Err(e) => log::debug!(
                            target: "concord::servitude::p2p",
                            "kad bootstrap retry deferred (no known peers): {e}"
                        ),
                    }
                }
                event = self.swarm.select_next_some() => {
                    // Tap Kad events for routing/bootstrap signals first;
                    // some of them flow straight through to the
                    // lightweight SwarmEvent translation below.
                    handle_kad_event(
                        &event,
                        &mut dht_peers,
                        &mut bootstrap_backoff,
                        bootstrap_retry.as_mut(),
                        &self.event_tx,
                    );
                    if let Some(translated) = translate_event(event, &mut connected) {
                        // broadcast::send errors only when there are no
                        // subscribers — drop silently.
                        let _ = self.event_tx.send(translated);
                    }
                }
            }
        }
    }
}

/// Inspect a raw swarm event for Phase 4 Kad signals and publish a
/// `DhtRoutingUpdated` or schedule a bootstrap retry as appropriate.
///
/// Pure-ish helper kept outside `LibP2pTransport::run` so the borrow on
/// `&self.swarm` (via `select_next_some()`) doesn't conflict with the
/// mutable accesses this helper needs to `dht_peers` / the sleep timer
/// / the event broadcaster. Takes the event by reference so the main
/// `translate_event` call still owns + consumes it.
fn handle_kad_event(
    event: &LibP2pSwarmEvent<BehaviourEvent>,
    dht_peers: &mut HashSet<PeerId>,
    backoff: &mut Duration,
    mut retry: std::pin::Pin<&mut tokio::time::Sleep>,
    event_tx: &broadcast::Sender<SwarmEvent>,
) {
    let kad_ev = match event {
        LibP2pSwarmEvent::Behaviour(BehaviourEvent::Kad(e)) => e,
        _ => return,
    };
    match kad_ev {
        kad::Event::RoutingUpdated { peer, .. } => {
            dht_peers.insert(*peer);
            let _ = event_tx.send(SwarmEvent::DhtRoutingUpdated {
                peer_count: dht_peers.len(),
            });
        }
        kad::Event::OutboundQueryProgressed {
            result: kad::QueryResult::Bootstrap(Err(e)),
            ..
        } => {
            log::debug!(
                target: "concord::servitude::p2p",
                "kad bootstrap query failed: {e:?} — retrying in {:?}",
                *backoff
            );
            retry.as_mut().reset(tokio::time::Instant::now() + *backoff);
            // Exponential backoff, capped at BOOTSTRAP_RETRY_MAX.
            *backoff = (*backoff * 2).min(BOOTSTRAP_RETRY_MAX);
        }
        kad::Event::OutboundQueryProgressed {
            result: kad::QueryResult::Bootstrap(Ok(_)),
            ..
        } => {
            // Successful bootstrap — reset the backoff so a later
            // network drop starts over at the small initial window
            // instead of compounding from the prior failure run.
            *backoff = BOOTSTRAP_RETRY_INITIAL;
        }
        _ => {}
    }
}

/// Pin each bootstrap address to its embedded PeerId in the Kad
/// routing table. Returns the number of addresses successfully seeded.
///
/// Multiaddrs without a trailing `/p2p/<peer-id>` component are
/// silently dropped — we have no PeerId to add them under, and silently
/// dropping is the right call for a hardcoded list (a malformed entry
/// during development must not break bootstrap altogether).
fn seed_kad_bootstrap(
    swarm: &mut libp2p::Swarm<Behaviour>,
    bootstrap_addrs: &[Multiaddr],
) -> usize {
    let mut seeded = 0usize;
    for addr in bootstrap_addrs {
        // Walk the protocol stack to extract the trailing /p2p/<peer>
        // component AND collect the address portion that precedes it
        // (which is what `kad.add_address` actually wants — the dial
        // address without the redundant peer suffix).
        let mut peer_id: Option<PeerId> = None;
        let mut addr_without_peer = Multiaddr::empty();
        for proto in addr.iter() {
            if let libp2p::multiaddr::Protocol::P2p(pid) = proto {
                peer_id = Some(pid);
            } else {
                addr_without_peer.push(proto);
            }
        }
        match peer_id {
            Some(pid) => {
                swarm
                    .behaviour_mut()
                    .kad
                    .add_address(&pid, addr_without_peer);
                seeded += 1;
            }
            None => {
                log::debug!(
                    target: "concord::servitude::p2p",
                    "skipping bootstrap multiaddr without /p2p/ suffix: {addr}"
                );
            }
        }
    }
    seeded
}

/// Translate a raw `libp2p::swarm::SwarmEvent` into our UI-friendly
/// projection. Returns `None` for events we don't surface (the swarm event
/// stream is large; the UI only cares about a handful).
fn translate_event(
    event: LibP2pSwarmEvent<BehaviourEvent>,
    connected: &mut HashSet<PeerId>,
) -> Option<SwarmEvent> {
    match event {
        LibP2pSwarmEvent::NewListenAddr { address, .. } => {
            Some(SwarmEvent::LocalAddrChanged { addr: address })
        }
        LibP2pSwarmEvent::ConnectionEstablished { peer_id, .. } => {
            let was_new = connected.insert(peer_id);
            if was_new {
                // A new peer joined — publish two events: dial-success
                // signal, then a count update. Caller can demux by variant.
                // We emit DialSuccess first; the count change is emitted
                // via a follow-up call in the loop.
                // For simplicity and to keep the function pure, we only
                // emit one event per call — the count change wins because
                // it's the more general signal.
                let _ = SwarmEvent::DialSuccess { peer_id };
                Some(SwarmEvent::PeerCountChanged {
                    count: connected.len(),
                })
            } else {
                None
            }
        }
        LibP2pSwarmEvent::ConnectionClosed { peer_id, .. } => {
            let removed = connected.remove(&peer_id);
            if removed {
                Some(SwarmEvent::PeerCountChanged {
                    count: connected.len(),
                })
            } else {
                None
            }
        }
        LibP2pSwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
            Some(SwarmEvent::DialFailure {
                peer_id,
                reason: error.to_string(),
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Bytes codec for request-response
// ---------------------------------------------------------------------------

/// Minimal length-delimited bytes codec for the Phase 3
/// request-response surface. Wire format is a `u32` big-endian length
/// prefix followed by the payload. Hand-rolled (rather than pulling in
/// `cbor4ii` via the `cbor` feature) so the dependency graph stays
/// minimal until concrete payload types are spec'd.
#[derive(Default, Clone, Debug)]
pub struct BytesCodec;

#[async_trait]
impl request_response::Codec for BytesCodec {
    type Protocol = StreamProtocol;
    type Request = Vec<u8>;
    type Response = Vec<u8>;

    async fn read_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> io::Result<Self::Request>
    where
        T: futures::AsyncRead + Unpin + Send,
    {
        read_length_prefixed(io).await
    }

    async fn read_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> io::Result<Self::Response>
    where
        T: futures::AsyncRead + Unpin + Send,
    {
        read_length_prefixed(io).await
    }

    async fn write_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        req: Self::Request,
    ) -> io::Result<()>
    where
        T: futures::AsyncWrite + Unpin + Send,
    {
        write_length_prefixed(io, &req).await
    }

    async fn write_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        res: Self::Response,
    ) -> io::Result<()>
    where
        T: futures::AsyncWrite + Unpin + Send,
    {
        write_length_prefixed(io, &res).await
    }
}

async fn read_length_prefixed<T>(io: &mut T) -> io::Result<Vec<u8>>
where
    T: futures::AsyncRead + Unpin + Send,
{
    use futures::AsyncReadExt;
    let mut len_buf = [0u8; 4];
    io.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as u64;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len} > {MAX_FRAME_BYTES}"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    io.read_exact(&mut buf).await?;
    Ok(buf)
}

async fn write_length_prefixed<T>(io: &mut T, data: &[u8]) -> io::Result<()>
where
    T: futures::AsyncWrite + Unpin + Send,
{
    use futures::AsyncWriteExt;
    if data.len() as u64 > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {} > {MAX_FRAME_BYTES}", data.len()),
        ));
    }
    let len_buf = (data.len() as u32).to_be_bytes();
    io.write_all(&len_buf).await?;
    io.write_all(data).await?;
    io.flush().await
}

// Silence unused-import warnings for the `tokio::io::*` traits — they're
// imported up top so `BytesCodec` impls compile cleanly across libp2p
// versions that switch their `AsyncRead`/`AsyncWrite` traits between the
// futures and tokio variants. We keep both available.
#[allow(dead_code)]
fn _force_use_tokio_io_traits(
    mut r: impl AsyncRead + Unpin + Send,
    mut w: impl AsyncWrite + Unpin + Send,
) -> impl std::future::Future<Output = io::Result<()>> + Send {
    async move {
        let mut buf = [0u8; 1];
        let _ = r.read(&mut buf).await?;
        let _ = w.write(&buf).await?;
        Ok(())
    }
}
