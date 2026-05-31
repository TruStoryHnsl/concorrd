//! Phase G — connection-gate integration test.
//!
//! Spins up two libp2p swarms in one process:
//!   * A — gate built with `enforce=true` and a literally-empty
//!     trusted-CIDR set (NO loopback). Loopback is what the dialer
//!     uses, so under enforce the inbound is rejected at the gate.
//!   * B — vanilla gate (enforce=false) dialing A's QUIC multiaddr.
//!
//! Acceptance: after a bounded settle window, A's connected-peers
//! set does NOT contain B's PeerId. The connection is short-
//! circuited inside the `ConnectionGate` behaviour BEFORE the
//! noise/yamux upgrade completes; A never tracks B as connected.
//!
//! Cold-reader perspective: the test inspects A's
//! `Swarm::connected_peers()` directly (the canonical "are we
//! actually connected to this remote?" surface) rather than racing
//! on `ConnectionEstablished` / `OutgoingConnectionError` events,
//! which can interleave nondeterministically in the swarm event
//! stream.

use std::time::Duration;

use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::network::connection_gate::GateState;
use app_lib::servitude::network::TunnelInterfaces;
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};

fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("gate-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
}

fn multiaddr_contains_quic_v1(addr: &Multiaddr) -> bool {
    use libp2p::multiaddr::Protocol;
    addr.iter().any(|p| matches!(p, Protocol::QuicV1))
}

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inbound_rejected_when_source_not_in_tunnel_cidr() {
    let (_sh_a, handle_a) = fresh_handle("reject-a");
    let (_sh_b, handle_b) = fresh_handle("reject-b");

    let identity_a = identity::load_or_create(&handle_a)
        .await
        .expect("identity a");
    let identity_b = identity::load_or_create(&handle_b)
        .await
        .expect("identity b");

    // A's gate: enforce=true AND trusted-CIDR set is LITERALLY empty
    // (via `TunnelInterfaces::from_cidrs(vec![])`). Production code
    // never builds this — `detect()` always prepends loopback — but
    // the test needs the gate to reject a loopback dial in order to
    // prove rejection works at all.
    let a_gate = GateState::new(true, TunnelInterfaces::from_cidrs(Vec::new()));
    let mut transport_a = LibP2pTransport::new_with_gate(&identity_a, &handle_a, a_gate)
        .await
        .expect("transport a");
    let mut transport_b = LibP2pTransport::new(&identity_b, &handle_b)
        .await
        .expect("transport b");

    let peer_a = transport_a.local_peer_id();
    let peer_b = transport_b.local_peer_id();
    assert_ne!(peer_a, peer_b);

    // Drain A's events until we see its first QUIC listen address.
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
        .expect("A timed out reporting QUIC listen addr")
    };

    let dial_addr = quic_loopback_with_peer_id(&a_quic_addr, peer_a);
    transport_b
        .swarm_mut()
        .dial(dial_addr.clone())
        .expect("dial submission");

    // Pump both swarms for a bounded window so each one observes the
    // dial outcome (rejection for A, OutgoingConnectionError for B).
    // We do NOT assert on the per-event stream — only on the
    // canonical post-settle state: A has zero connected peers, OR at
    // least does not have peer_b connected. This is the
    // load-bearing assertion.
    let settle = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            tokio::select! {
                _ = transport_a.swarm_mut().select_next_some() => {}
                _ = transport_b.swarm_mut().select_next_some() => {}
            }
            // Cheap polling exit — if A connected to B, we want to
            // surface that as a fast failure. If not, the timeout
            // arm fires after 8s of pumping and we assert the
            // post-settle state.
            let a_has_b = transport_a
                .swarm_mut()
                .connected_peers()
                .any(|p| *p == peer_b);
            if a_has_b {
                return Some(());
            }
        }
    })
    .await;

    // `settle == Ok(_)` means A actually connected to B — the gate
    // failed. `settle == Err(_)` means the 8s timer fired without A
    // ever accepting B — the gate worked.
    assert!(
        settle.is_err(),
        "A accepted an inbound from a non-trusted IP — the connection \
         gate did NOT reject. This is the load-bearing failure mode \
         the test exists to catch."
    );

    // Belt-and-braces check the post-settle state directly.
    let a_connected: Vec<PeerId> = transport_a
        .swarm_mut()
        .connected_peers()
        .copied()
        .collect();
    assert!(
        !a_connected.contains(&peer_b),
        "A's connected-peers set still contains B={peer_b} after the \
         settle window — gate failed to keep B out. connected={a_connected:?}"
    );
}
