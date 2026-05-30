//! Phase 3 (INS-019b) — integration tests for the libp2p swarm transport.
//!
//! Each test maps 1:1 to a design-doc acceptance criterion. Written from a
//! cold-reader perspective per the project's MANDATORY testing rules: we
//! assert what an external observer sees (a non-empty PeerId, a multiaddr
//! string containing `/quic-v1/`, two swarms exchanging a connection), not
//! the author's beliefs about how the swarm machinery is wired internally.
//!
//! 2026-05-29 architecture redirect: the prior DHT-based bootstrap tests
//! (`dht_joins_network_via_bootstrap_seeds`,
//! `kad_lookup_round_trips_via_bootstrap`,
//! `survives_bootstrap_node_going_offline`) are gone. mDNS handles
//! LAN-local discovery and WAN peers come from the Phase-5 peer-card
//! flow exclusively — there are no Kad bootstrap nodes to exercise.

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
// (4) 2026-05-29 redirect criterion: mDNS discovers a peer on the same
//     network. Spin up two swarms in the same test process; assert each
//     observes the other via the broadcast SwarmEvent::MdnsPeerDiscovered
//     within 15s. Replaces the prior DHT-bootstrap acceptance tests.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mdns_discovers_peer_on_same_network() {
    let (_sh_a, handle_a) = fresh_handle("mdns-a");
    let (_sh_b, handle_b) = fresh_handle("mdns-b");

    let identity_a = identity::load_or_create(&handle_a)
        .await
        .expect("identity a");
    let identity_b = identity::load_or_create(&handle_b)
        .await
        .expect("identity b");

    let transport_a = LibP2pTransport::new(&identity_a, &handle_a)
        .await
        .expect("transport a");
    let transport_b = LibP2pTransport::new(&identity_b, &handle_b)
        .await
        .expect("transport b");

    let peer_a = transport_a.local_peer_id();
    let peer_b = transport_b.local_peer_id();

    let mut rx_a = transport_a.subscribe();
    let mut rx_b = transport_b.subscribe();

    // Drive both swarms via their main event loops so mDNS announcements
    // actually fire. We need handles to shutdown them cleanly afterward.
    let shutdown_a = transport_a.shutdown_handle();
    let shutdown_b = transport_b.shutdown_handle();
    let join_a = tokio::spawn(transport_a.run());
    let join_b = tokio::spawn(transport_b.run());

    // Wait for each side to see the other via mDNS. Generous timeout
    // (15s) absorbs the initial mDNS announce/query interval on slower
    // CI runners; in practice the discovery completes inside ~3s.
    let saw_each_other = tokio::time::timeout(Duration::from_secs(15), async {
        let mut a_saw_b = false;
        let mut b_saw_a = false;
        loop {
            tokio::select! {
                Ok(ev) = rx_a.recv() => {
                    if let SwarmEvent::MdnsPeerDiscovered { peer_id, .. } = ev {
                        if peer_id == peer_b.to_string() {
                            a_saw_b = true;
                        }
                    }
                }
                Ok(ev) = rx_b.recv() => {
                    if let SwarmEvent::MdnsPeerDiscovered { peer_id, .. } = ev {
                        if peer_id == peer_a.to_string() {
                            b_saw_a = true;
                        }
                    }
                }
            }
            if a_saw_b && b_saw_a {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false);

    // Clean shutdown regardless of outcome so the test runner doesn't
    // leak the swarm tasks across cases.
    let _ = shutdown_a.send(()).await;
    let _ = shutdown_b.send(()).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), join_a).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), join_b).await;

    assert!(
        saw_each_other,
        "two swarms on the same host must observe each other via mDNS \
         within 15s — peer_a={peer_a}, peer_b={peer_b}. If this test \
         times out in CI but passes locally, the runner is likely \
         filtering multicast (link-local mDNS requires unfiltered \
         UDP/5353)."
    );
}

// ---------------------------------------------------------------------------
// (5) 2026-05-29 redirect criterion: the swarm boots cleanly with no
//     bootstrap peers, no errors, no panics, no retries. This replaces
//     the prior "joins network via bootstrap seeds" assertion now that
//     the architecture has no project-run bootstrap fleet.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn swarm_starts_with_no_bootstrap() {
    let (_sh, handle) = fresh_handle("no-bootstrap");
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("phase 2 load_or_create must succeed");

    // Constructing the transport must not error — there is no bootstrap
    // path that could fail. The previous architecture had a
    // `new_with_bootstrap_override` test seam; in the mDNS world there's
    // nothing to inject.
    let transport = LibP2pTransport::new(&peer_identity, &handle)
        .await
        .expect("transport must construct with no bootstrap config");

    let peer_id = transport.local_peer_id();
    assert!(
        !peer_id.to_base58().is_empty(),
        "fresh swarm must still report a non-empty local PeerId"
    );

    // Drive the event loop briefly; assert no panic and that we
    // observe at least a NewListenAddr signal coming back through the
    // broadcast channel — the swarm makes forward progress without any
    // bootstrap dial.
    let mut rx = transport.subscribe();
    let shutdown = transport.shutdown_handle();
    let join = tokio::spawn(transport.run());

    let progressed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(SwarmEvent::LocalAddrChanged { .. }) => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false);

    let _ = shutdown.send(()).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), join).await;

    assert!(
        progressed,
        "swarm with no bootstrap must still report at least one \
         LocalAddrChanged within 5s — the event loop is wedged or no \
         listeners came up"
    );
}
