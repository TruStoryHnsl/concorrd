//! Phase 3 (INS-019b) — integration tests for the libp2p swarm transport.
//!
//! Each test maps 1:1 to a design-doc acceptance criterion. Written from a
//! cold-reader perspective per the project's MANDATORY testing rules: we
//! assert what an external observer sees (a non-empty PeerId, a multiaddr
//! string containing `/quic-v1/`, two swarms exchanging a connection), not
//! the author's beliefs about how the swarm machinery is wired internally.

use std::time::Duration;

use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::{LibP2pTransport, SwarmEvent};
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{
    swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId,
};

/// Build an in-memory Stronghold + handle for tests. Mirrors the Phase 2
/// pattern in `identity_test.rs`. Each call gets a unique client name so
/// concurrent tests don't collide.
fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("p2p-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
}

// ---------------------------------------------------------------------------
// (1) Design-doc criterion: "swarm starts cleanly" with a valid PeerId
//     derived deterministically from the Phase 2 Stronghold-backed Ed25519
//     identity.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn swarm_starts_with_valid_peer_id() {
    let (_sh, handle) = fresh_handle("starts");
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("phase 2 load_or_create must succeed");

    let transport = LibP2pTransport::new(&peer_identity, &handle)
        .await
        .expect("LibP2pTransport::new must succeed on a fresh handle");

    let peer_id_1 = transport.local_peer_id();

    // PeerId must be non-empty when serialized — the libp2p type guarantees
    // 32+ byte payload, but we verify the surface contract here so a future
    // refactor that accidentally hands back `PeerId::random()` (or an empty
    // placeholder) fails this test loudly.
    let s = peer_id_1.to_base58();
    assert!(
        s.len() >= 30,
        "local PeerId base58 representation suspiciously short: {s:?} \
         (len={}) — implementation may be returning a placeholder",
        s.len()
    );

    // Determinism: building a SECOND transport against the SAME Stronghold
    // handle yields the SAME PeerId. This is what makes a libp2p swarm
    // recoverable across restarts — the seed exported from the handle's
    // cache is bit-for-bit identical.
    drop(transport);
    let transport_2 = LibP2pTransport::new(&peer_identity, &handle)
        .await
        .expect("second LibP2pTransport::new must succeed");
    let peer_id_2 = transport_2.local_peer_id();
    assert_eq!(
        peer_id_1, peer_id_2,
        "two transports built from the same Stronghold handle must produce \
         the same PeerId — non-deterministic identity breaks reconnection"
    );

    // Independent cross-check: build a libp2p Keypair from the same seed
    // `peer_seed()` returns and assert the PeerId derived from THAT matches
    // `transport.local_peer_id()`. This is the explicit "deterministic
    // derivation from Ed25519 secret" assertion the spec requires.
    let mut seed_owned = *identity::peer_seed(&handle)
        .await
        .expect("peer_seed must succeed");
    let kp = libp2p::identity::Keypair::ed25519_from_bytes(&mut seed_owned)
        .expect("ed25519_from_bytes must accept a 32-byte seed");
    let derived_peer_id = PeerId::from_public_key(&kp.public());
    assert_eq!(
        peer_id_1, derived_peer_id,
        "PeerId reported by LibP2pTransport must match the PeerId derived \
         independently from the same Ed25519 seed bytes — the seed-to-PeerId \
         pipeline is broken"
    );

    // Architectural unification assertion (the whole point of the seed
    // refactor): the public-key bytes underlying the libp2p PeerId must
    // equal `peer_identity.public_key`. Both come from the same per-install
    // seed via the same Ed25519 math — one identity per install, not two.
    let libp2p_pub_bytes = kp
        .public()
        .try_into_ed25519()
        .expect("ed25519_from_bytes always yields an ed25519 keypair")
        .to_bytes();
    assert_eq!(
        libp2p_pub_bytes, peer_identity.public_key,
        "libp2p public key MUST equal PeerIdentity.public_key — Phase 2 \
         fingerprint and Phase 3 PeerId are required to derive from the \
         same seed (single per-install identity); divergence here would \
         surface as two different identifiers in Settings → Profile for \
         the same user."
    );
}

// ---------------------------------------------------------------------------
// (2) Design-doc criterion: "swarm identifies its own multiaddr" — we expect
//     a `/quic-v1` listener to come up on an ephemeral port within a short
//     timeout when the swarm event loop is driven.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn swarm_reports_listening_multiaddr_on_quic() {
    let (_sh, handle) = fresh_handle("listen-quic");
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("phase 2 load_or_create must succeed");

    let mut transport = LibP2pTransport::new(&peer_identity, &handle)
        .await
        .expect("transport must construct");

    // Drive the raw swarm directly here — we want to observe the very
    // first `NewListenAddr` event without going through the broadcast
    // channel (which would race against subscribe()). Take ownership of
    // the swarm via the test-only mutable accessor.
    let swarm = transport.swarm_mut();

    let result = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match swarm.select_next_some().await {
                RawSwarmEvent::NewListenAddr { address, .. } => {
                    if multiaddr_contains_quic_v1(&address) {
                        return Some(address);
                    }
                    // Keep waiting — the TCP listener may surface first.
                }
                _ => continue,
            }
        }
    })
    .await
    .expect("timeout waiting for /quic-v1 listen address");

    let addr = result.expect("loop returned None");
    let rendered = addr.to_string();
    assert!(
        rendered.contains("/quic-v1"),
        "expected listen multiaddr to contain `/quic-v1`, got: {rendered}"
    );
    assert!(
        rendered.contains("/udp/"),
        "QUIC listen multiaddr should be carried over UDP, got: {rendered}"
    );
}

fn multiaddr_contains_quic_v1(addr: &Multiaddr) -> bool {
    use libp2p::multiaddr::Protocol;
    addr.iter().any(|p| matches!(p, Protocol::QuicV1))
}

// ---------------------------------------------------------------------------
// (3) Design-doc criterion: "accepts an incoming connection on QUIC".
//     Spin up two transports in the same process, have B dial A's QUIC
//     multiaddr, assert a connection establishes within a short timeout.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_swarms_dial_and_connect() {
    // Use two distinct labels so each gets its own Stronghold (and
    // therefore its own libp2p seed → its own PeerId).
    let (_sh_a, handle_a) = fresh_handle("dial-a");
    let (_sh_b, handle_b) = fresh_handle("dial-b");

    let identity_a = identity::load_or_create(&handle_a)
        .await
        .expect("identity a");
    let identity_b = identity::load_or_create(&handle_b)
        .await
        .expect("identity b");

    let mut transport_a = LibP2pTransport::new(&identity_a, &handle_a)
        .await
        .expect("transport a");
    let mut transport_b = LibP2pTransport::new(&identity_b, &handle_b)
        .await
        .expect("transport b");

    let peer_a = transport_a.local_peer_id();
    let peer_b = transport_b.local_peer_id();
    assert_ne!(
        peer_a, peer_b,
        "two independent strongholds must yield distinct PeerIds"
    );

    // Drain A's events until we see its first QUIC listen address. That's
    // the address B will dial.
    let a_quic_addr = {
        let swarm = transport_a.swarm_mut();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let RawSwarmEvent::NewListenAddr { address, .. } =
                    swarm.select_next_some().await
                {
                    if multiaddr_contains_quic_v1(&address) {
                        return address;
                    }
                }
            }
        })
        .await
        .expect("A timed out before reporting a quic listen addr")
    };

    // Append A's PeerId to the dial multiaddr so QUIC's noise handshake
    // can verify the remote identity. Convert /0.0.0.0/ to /127.0.0.1/ so
    // we dial loopback specifically.
    let dial_addr = quic_loopback_with_peer_id(&a_quic_addr, peer_a);

    // Have B dial A.
    transport_b
        .swarm_mut()
        .dial(dial_addr.clone())
        .expect("B::dial returned an error before driving the swarm");

    // Drive both swarms concurrently until each reports a
    // ConnectionEstablished — that's the empirical proof the connection
    // really came up on both sides. 10s timeout per the task spec.
    let connect_result = tokio::time::timeout(Duration::from_secs(10), async {
        let mut a_connected = false;
        let mut b_connected = false;
        loop {
            tokio::select! {
                ev = transport_a.swarm_mut().select_next_some() => {
                    if let RawSwarmEvent::ConnectionEstablished { peer_id, .. } = ev {
                        if peer_id == peer_b {
                            a_connected = true;
                        }
                    }
                }
                ev = transport_b.swarm_mut().select_next_some() => {
                    if let RawSwarmEvent::ConnectionEstablished { peer_id, .. } = ev {
                        if peer_id == peer_a {
                            b_connected = true;
                        }
                    }
                }
            }
            if a_connected && b_connected {
                return;
            }
        }
    })
    .await;

    assert!(
        connect_result.is_ok(),
        "two swarms failed to establish a QUIC connection within 10s — \
         dial address was {dial_addr}, peer_a={peer_a}, peer_b={peer_b}"
    );

    // Drop the SwarmEvent enum import explicitly so unused-import warnings
    // don't fire in case the test path doesn't currently exercise our
    // lightweight broadcast surface. The import stays in place so future
    // additions to this test can subscribe without re-importing.
    let _ = std::any::type_name::<SwarmEvent>();
}

/// Take a `/ip4/0.0.0.0/udp/PORT/quic-v1` and rebuild it as
/// `/ip4/127.0.0.1/udp/PORT/quic-v1/p2p/<peer>` for loopback dialing.
fn quic_loopback_with_peer_id(addr: &Multiaddr, peer: PeerId) -> Multiaddr {
    use libp2p::multiaddr::Protocol;
    let mut rebuilt = Multiaddr::empty();
    for proto in addr.iter() {
        match proto {
            Protocol::Ip4(_) => rebuilt.push(Protocol::Ip4(std::net::Ipv4Addr::LOCALHOST)),
            other => rebuilt.push(other),
        }
    }
    rebuilt.push(Protocol::P2p(peer));
    rebuilt
}

// ---------------------------------------------------------------------------
// Phase 4 helpers — spin up "bootstrap-like" swarms locally and drive them in
// parallel with the swarm under test.
// ---------------------------------------------------------------------------

/// Build a transport with an empty bootstrap list, flip Kad to Server
/// mode (the role real project bootstrap nodes play in production), and
/// wait until its first QUIC listen address materializes. Returns the
/// transport + the loopback multiaddr with `/p2p/<peer>` appended,
/// ready to inject as a bootstrap seed into another swarm.
///
/// The owning `Stronghold` is intentionally leaked so it outlives the
/// returned transport — `iota_stronghold::Client` doesn't keep the
/// `Stronghold` itself alive, and dropping the Stronghold while the
/// transport is still using its client invalidates the keypair. The
/// test process is short-lived so the leak is fine.
async fn spawn_bootstrap_swarm(label: &str) -> (LibP2pTransport, Multiaddr) {
    let (sh, handle) = fresh_handle(label);
    Box::leak(Box::new(sh));
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("phase 2 load_or_create must succeed for bootstrap swarm");
    let mut transport = LibP2pTransport::new_with_bootstrap_override(
        &peer_identity,
        &handle,
        Vec::new(),
    )
    .await
    .expect("bootstrap swarm must construct");

    // Real bootstrap VPS instances run in Server mode so they advertise
    // themselves as routable to the wider DHT. Match that here so the
    // node under test can complete its Kad queries against them.
    transport
        .swarm_mut()
        .behaviour_mut()
        .kad
        .set_mode(Some(libp2p::kad::Mode::Server));

    let peer = transport.local_peer_id();
    let raw_addr = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let RawSwarmEvent::NewListenAddr { address, .. } =
                transport.swarm_mut().select_next_some().await
            {
                if multiaddr_contains_quic_v1(&address) {
                    return address;
                }
            }
        }
    })
    .await
    .expect("bootstrap swarm timed out waiting for its QUIC listen addr");

    // Leak the handle too — same reason as Stronghold above.
    Box::leak(Box::new(handle));

    (transport, quic_loopback_with_peer_id(&raw_addr, peer))
}

/// Drive a list of swarms in parallel from a single async task, returning
/// when `done(&events)` predicate returns true OR the timeout elapses.
/// Each polled event is appended to a shared Vec keyed by swarm index.
///
/// This is the workhorse used by tests 4–6: it lets the test express
/// "drive everyone for up to N seconds until I see condition X" without
/// hand-rolling a `tokio::select!` over five+ moving parts.
async fn drive_until<F>(
    transports: &mut [&mut LibP2pTransport],
    timeout: Duration,
    mut done: F,
) -> bool
where
    F: FnMut(usize, &RawSwarmEvent<app_lib::servitude::p2p::BehaviourEvent>) -> bool,
{
    tokio::time::timeout(timeout, async {
        loop {
            // Tokio's select! macro requires a static number of branches,
            // so for an arbitrary list we use `futures::future::select_all`
            // over a vector of boxed futures, one per swarm.
            let next: futures::future::SelectAll<_> = futures::future::select_all(
                transports
                    .iter_mut()
                    .map(|t| Box::pin(t.swarm_mut().select_next_some())),
            );
            let (event, idx, _) = next.await;
            if done(idx, &event) {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// (4) Phase 4 acceptance criterion: DHT joins the network via bootstrap seeds.
//     Spin up TWO bootstrap-like swarms, then a THIRD swarm configured with
//     those two as its bootstrap list. Assert the third swarm sees
//     RoutingUpdated for at least one of the bootstrap peers.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dht_joins_network_via_bootstrap_seeds() {
    use libp2p::kad;
    use app_lib::servitude::p2p::BehaviourEvent;

    let (mut bs_a, bs_a_addr) = spawn_bootstrap_swarm("dht-bs-a").await;
    let (mut bs_b, bs_b_addr) = spawn_bootstrap_swarm("dht-bs-b").await;
    let bs_a_peer = bs_a.local_peer_id();
    let bs_b_peer = bs_b.local_peer_id();

    let (_sh, handle) = fresh_handle("dht-node");
    let peer_identity = identity::load_or_create(&handle).await.unwrap();
    let mut node = LibP2pTransport::new_with_bootstrap_override(
        &peer_identity,
        &handle,
        vec![bs_a_addr.clone(), bs_b_addr.clone()],
    )
    .await
    .expect("node-under-test must construct");

    // Drive all three swarms until the test node reports RoutingUpdated
    // for one of the bootstrap peers. 30s timeout per spec.
    let saw_routing = drive_until(
        &mut [&mut bs_a, &mut bs_b, &mut node],
        Duration::from_secs(30),
        |idx, ev| {
            // idx==2 is our node-under-test in the slice above.
            if idx != 2 {
                return false;
            }
            matches!(
                ev,
                RawSwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::RoutingUpdated {
                    peer, ..
                })) if *peer == bs_a_peer || *peer == bs_b_peer
            )
        },
    )
    .await;

    assert!(
        saw_routing,
        "node-under-test must observe Kad RoutingUpdated for at least one \
         bootstrap peer ({bs_a_peer} or {bs_b_peer}) within 30s"
    );
}

// ---------------------------------------------------------------------------
// (5) Phase 4 acceptance criterion: peer-key lookups round-trip via the
//     bootstrap nodes. After joining, the node issues a `get_closest_peers`
//     query and must see a successful OutboundQueryProgressed.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kad_lookup_round_trips_via_bootstrap() {
    use libp2p::kad;
    use app_lib::servitude::p2p::BehaviourEvent;

    let (mut bs_a, bs_a_addr) = spawn_bootstrap_swarm("dht-lookup-bs-a").await;
    let (mut bs_b, bs_b_addr) = spawn_bootstrap_swarm("dht-lookup-bs-b").await;

    let (_sh, handle) = fresh_handle("dht-lookup-node");
    let peer_identity = identity::load_or_create(&handle).await.unwrap();
    let mut node = LibP2pTransport::new_with_bootstrap_override(
        &peer_identity,
        &handle,
        vec![bs_a_addr, bs_b_addr],
    )
    .await
    .expect("node must construct");
    let local_peer_id = node.local_peer_id();

    // Issue the lookup against our own PeerId — semantically it's
    // asking "who are the closest k peers to me?" which is the same
    // shape of query the production bootstrap routine fires.
    node.swarm_mut()
        .behaviour_mut()
        .kad
        .get_closest_peers(local_peer_id);

    let saw_lookup = drive_until(
        &mut [&mut bs_a, &mut bs_b, &mut node],
        Duration::from_secs(30),
        |idx, ev| {
            if idx != 2 {
                return false;
            }
            matches!(
                ev,
                RawSwarmEvent::Behaviour(BehaviourEvent::Kad(
                    kad::Event::OutboundQueryProgressed {
                        result: kad::QueryResult::GetClosestPeers(Ok(_)),
                        ..
                    }
                ))
            )
        },
    )
    .await;

    assert!(
        saw_lookup,
        "node must complete a GetClosestPeers query via the bootstrap nodes \
         within 30s — Kad lookup round-trip is broken"
    );
}

// ---------------------------------------------------------------------------
// (6) Phase 4 acceptance criterion: bootstrap survives one node going offline.
//     Spin up THREE bootstrap-like swarms, drop one before the node-under-test
//     starts bootstrapping. Assert the node still successfully bootstraps
//     against the remaining two.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn survives_bootstrap_node_going_offline() {
    use libp2p::kad;
    use app_lib::servitude::p2p::BehaviourEvent;

    let (mut bs_a, bs_a_addr) = spawn_bootstrap_swarm("dht-fail-bs-a").await;
    let (mut bs_b, bs_b_addr) = spawn_bootstrap_swarm("dht-fail-bs-b").await;
    let (bs_c, bs_c_addr) = spawn_bootstrap_swarm("dht-fail-bs-c").await;

    let bs_a_peer = bs_a.local_peer_id();
    let bs_b_peer = bs_b.local_peer_id();
    let bs_c_peer = bs_c.local_peer_id();

    // Drop the third bootstrap before the node tries to use it. This
    // also closes its QUIC listener — any dial to bs_c_addr is now
    // expected to fail. The node must still bootstrap against the
    // remaining two without erroring, panicking, or failing the test.
    drop(bs_c);

    let (_sh, handle) = fresh_handle("dht-fail-node");
    let peer_identity = identity::load_or_create(&handle).await.unwrap();
    let mut node = LibP2pTransport::new_with_bootstrap_override(
        &peer_identity,
        &handle,
        vec![bs_a_addr, bs_b_addr, bs_c_addr],
    )
    .await
    .expect("node must construct even with one bootstrap addr unreachable");

    // We just need to see ONE routing-update from a surviving bootstrap.
    // The dead bs_c_peer must not be the only routing event we observe.
    let saw_surviving_routing = drive_until(
        &mut [&mut bs_a, &mut bs_b, &mut node],
        Duration::from_secs(30),
        |idx, ev| {
            if idx != 2 {
                return false;
            }
            matches!(
                ev,
                RawSwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::RoutingUpdated {
                    peer, ..
                })) if *peer == bs_a_peer || *peer == bs_b_peer
            )
        },
    )
    .await;

    assert!(
        saw_surviving_routing,
        "node must still bootstrap against the two surviving bootstrap peers \
         ({bs_a_peer}, {bs_b_peer}) within 30s even with {bs_c_peer} offline"
    );
}
