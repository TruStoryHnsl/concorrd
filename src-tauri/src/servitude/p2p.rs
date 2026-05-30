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
//! post-2026-05-29 architecture redirect (see
//! `docs/architecture/p2p-design.md` § Phase 4):
//!
//!   * [`libp2p::mdns::tokio::Behaviour`] — LAN-local peer discovery via
//!     multicast DNS. Replaces the prior Kademlia DHT + project-run
//!     bootstrap fleet. WAN peers are discovered exclusively through the
//!     Phase-5 peer-card flow (QR / `concord://` deeplink / Matrix-room
//!     exchange) — no project-run infrastructure, no third-party
//!     bootstrap dependency.
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
//! about listen-address changes, peer-count changes, dial outcomes, and
//! mDNS-discovered LAN peers.

use std::collections::HashSet;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::prelude::*;
use libp2p::{
    dcutr, gossipsub, identify, identity as libp2p_identity, mdns, ping, relay, request_response,
    swarm::{NetworkBehaviour, SwarmEvent as LibP2pSwarmEvent},
    Multiaddr, PeerId, StreamProtocol,
};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::broadcast;

use crate::servitude::federation::FederationHandler;
use crate::servitude::identity::{self, PeerIdentity, StrongholdHandle};

/// Identify protocol-version string. Pinned to the package version at
/// build time so Phase 3 nodes observe each other's exact Concord release.
const IDENTIFY_PROTOCOL_VERSION: &str = concat!("concord/", env!("CARGO_PKG_VERSION"));

/// Identify agent-version string — included in remote peers' Identify
/// payloads for human-readable diagnostics.
const IDENTIFY_AGENT_VERSION: &str = concat!("concord/", env!("CARGO_PKG_VERSION"));

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

    #[error("mdns init failed: {0}")]
    MdnsInit(String),

    #[error(
        "identity invariant violated: libp2p public key {libp2p_pub:?} does not \
         match PeerIdentity.public_key {peer_identity_pub:?} — seed pipeline broken"
    )]
    IdentityMismatch {
        libp2p_pub: [u8; 32],
        peer_identity_pub: [u8; 32],
    },

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
    /// Post-2026-05-29 redirect: mDNS picked up a peer on the local
    /// network. The UI surfaces these as "Peers on your LAN" alongside
    /// the persistent Phase-5 paired-peers list. The user can one-click
    /// pair any LAN peer to promote it into the persistent store.
    ///
    /// `peer_id` is the remote's libp2p `PeerId` in base58, and
    /// `multiaddrs` carries every multiaddr mDNS reported for that peer
    /// in the announcement burst. Both fields are pre-stringified so
    /// the React side doesn't need to import a Multiaddr type.
    MdnsPeerDiscovered {
        peer_id: String,
        multiaddrs: Vec<String>,
    },
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
    /// LAN-local peer discovery via multicast DNS. Replaces the prior
    /// Kademlia DHT (removed 2026-05-29) — see module docs.
    pub mdns: mdns::tokio::Behaviour,
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
    /// + QUIC ports and spins up mDNS for LAN-local peer discovery.
    ///
    /// `peer_identity` is taken for cross-derivation sanity — the libp2p
    /// keypair's public key bytes must match `peer_identity.public_key`,
    /// because both derive from the same seed via the same Ed25519 math.
    pub async fn new(
        peer_identity: &PeerIdentity,
        stronghold: &StrongholdHandle,
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
        //
        // This check is a runtime hard-fail, not a `debug_assert_eq!`. Debug
        // assertions strip in release builds, which is exactly when this
        // invariant matters most: a seed-pipeline regression that ships to
        // users would silently advertise the wrong identity to every peer,
        // with no log, no error, and no Settings-tab clue. The cost of the
        // check is one 32-byte compare at swarm startup — negligible.
        let libp2p_pub = keypair
            .public()
            .try_into_ed25519()
            .expect("ed25519_from_bytes always yields an ed25519 keypair")
            .to_bytes();
        if libp2p_pub != peer_identity.public_key {
            return Err(P2pError::IdentityMismatch {
                libp2p_pub,
                peer_identity_pub: peer_identity.public_key,
            });
        }

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

                // mDNS: LAN-local discovery. Default config matches the
                // standard libp2p multicast interval; no rendezvous
                // service, no DNS-SD external dependency, no project-run
                // infra. Fresh installs on the same tailnet / home LAN
                // see each other silently within seconds. WAN peers are
                // discovered via the Phase-5 peer-card flow exclusively.
                let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_id)
                    .map_err(|e| format!("mdns init: {e}"))?;

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
                    mdns,
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
        // because the QUIC listener is what `swarm_reports_listening_multiaddr_on_quic`
        // asserts on.
        let quic_addr: Multiaddr = LISTEN_QUIC.parse()?;
        swarm
            .listen_on(quic_addr)
            .map_err(|e| P2pError::ListenFailed(format!("quic: {e}")))?;
        let tcp_addr: Multiaddr = LISTEN_TCP.parse()?;
        swarm
            .listen_on(tcp_addr)
            .map_err(|e| P2pError::ListenFailed(format!("tcp: {e}")))?;

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
    /// to issue `dial()` calls without having to re-implement the event
    /// loop.
    pub fn swarm_mut(&mut self) -> &mut libp2p::Swarm<Behaviour> {
        &mut self.swarm
    }

    /// Drive the swarm event loop. Translates relevant `libp2p::swarm`
    /// events into the lightweight [`SwarmEvent`] enum and publishes them
    /// on the broadcast channel. Continues on per-event errors; exits only
    /// when the shutdown sender is signalled.
    pub async fn run(mut self) {
        let mut connected: HashSet<PeerId> = HashSet::new();

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
                event = self.swarm.select_next_some() => {
                    // Tap mDNS events first so LAN-discovered peers
                    // surface as SwarmEvent::MdnsPeerDiscovered. The
                    // generic translation below handles
                    // listen-addr/peer-count/dial signals.
                    handle_mdns_event(&event, &self.event_tx);
                    // `translate_event` returns a Vec because a single raw
                    // libp2p event can map to multiple UI-facing signals —
                    // e.g. ConnectionEstablished emits both a DialSuccess
                    // (per-peer signal) and a PeerCountChanged (aggregate).
                    for translated in translate_event(event, &mut connected) {
                        // broadcast::send errors only when there are no
                        // subscribers — drop silently.
                        let _ = self.event_tx.send(translated);
                    }
                }
            }
        }
    }
}

/// Inspect a raw swarm event for mDNS signals and publish one
/// `MdnsPeerDiscovered` per peer the announcement burst named.
///
/// Pure-ish helper kept outside `LibP2pTransport::run` so the borrow on
/// `&self.swarm` (via `select_next_some()`) doesn't conflict with the
/// event broadcaster. Takes the event by reference so the main
/// `translate_event` call still owns + consumes it.
fn handle_mdns_event(
    event: &LibP2pSwarmEvent<BehaviourEvent>,
    event_tx: &broadcast::Sender<SwarmEvent>,
) {
    let mdns_ev = match event {
        LibP2pSwarmEvent::Behaviour(BehaviourEvent::Mdns(e)) => e,
        _ => return,
    };
    match mdns_ev {
        mdns::Event::Discovered(list) => {
            // mDNS reports a flat list of (peer_id, multiaddr) tuples;
            // group by peer so a single discovery burst becomes one
            // event per distinct peer with every multiaddr the burst
            // reported.
            use std::collections::HashMap;
            let mut by_peer: HashMap<PeerId, Vec<String>> = HashMap::new();
            for (peer_id, addr) in list.iter() {
                by_peer
                    .entry(*peer_id)
                    .or_default()
                    .push(addr.to_string());
            }
            for (peer_id, multiaddrs) in by_peer {
                let _ = event_tx.send(SwarmEvent::MdnsPeerDiscovered {
                    peer_id: peer_id.to_string(),
                    multiaddrs,
                });
            }
        }
        mdns::Event::Expired(_) => {
            // Peer left the LAN. We intentionally do NOT publish an
            // "expired" variant — the React side treats the LAN list
            // as session-scoped and refreshes from live discovery only.
            // Letting expired peers age out of the UI alongside the
            // session lifecycle is simpler than tracking a per-peer
            // TTL across the IPC boundary.
        }
    }
}

/// Translate a raw `libp2p::swarm::SwarmEvent` into our UI-facing projection.
///
/// Returns a `Vec` because a single raw event sometimes maps to multiple
/// UI signals — most notably `ConnectionEstablished`, which fans out into
/// both a per-peer `DialSuccess` (for code that gates on individual dial
/// outcomes — e.g. peer-pairing flows that wait for a specific peer to
/// connect) AND an aggregate `PeerCountChanged` (for the swarm-status
/// header). An empty `Vec` means "ignore this raw event" — the libp2p
/// stream is noisy and the UI only cares about a handful of variants.
fn translate_event(
    event: LibP2pSwarmEvent<BehaviourEvent>,
    connected: &mut HashSet<PeerId>,
) -> Vec<SwarmEvent> {
    match event {
        LibP2pSwarmEvent::NewListenAddr { address, .. } => {
            vec![SwarmEvent::LocalAddrChanged { addr: address }]
        }
        LibP2pSwarmEvent::ConnectionEstablished { peer_id, .. } => {
            let was_new = connected.insert(peer_id);
            if was_new {
                // Emit DialSuccess first so per-peer listeners (e.g. the
                // peer-pairing UI waiting for a freshly-paired peer to
                // come online) see the dial outcome before the aggregate
                // count moves. Order matters when the UI demuxes by variant.
                vec![
                    SwarmEvent::DialSuccess { peer_id },
                    SwarmEvent::PeerCountChanged {
                        count: connected.len(),
                    },
                ]
            } else {
                // Reconnect of a peer we already track — no DialSuccess
                // (it isn't a "new" dial outcome) and no count change.
                vec![]
            }
        }
        LibP2pSwarmEvent::ConnectionClosed { peer_id, .. } => {
            let removed = connected.remove(&peer_id);
            if removed {
                vec![SwarmEvent::PeerCountChanged {
                    count: connected.len(),
                }]
            } else {
                vec![]
            }
        }
        LibP2pSwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
            vec![SwarmEvent::DialFailure {
                peer_id,
                reason: error.to_string(),
            }]
        }
        _ => vec![],
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
