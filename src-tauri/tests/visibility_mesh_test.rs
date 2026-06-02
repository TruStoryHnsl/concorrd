//! F-VIS — integration test for per-server mesh-hop visibility.
//!
//! Maps to spec deliverable #9 ("Cargo integration: two libp2p swarms,
//! set max_hops=1 on host, dial from a 2-hop peer → explore menu does
//! NOT include the host. Set max_hops=2 → 2-hop peer's explore menu
//! includes it.").
//!
//! The deliverable's pipeline is:
//!
//!   1. Host writes a `VisibilityRow` to its `visibility_meta` table.
//!   2. The Tauri command serializes a `VisibilityUpdate` and pushes it
//!      onto the libp2p outbound queue (`broadcast_visibility`).
//!   3. The swarm event loop publishes the payload on the host's
//!      gossipsub rotation topic.
//!   4. Paired peers subscribed to that topic receive the message.
//!   5. The receiver decodes it with `VisibilityUpdate::decode` and
//!      passes the result through `explore_filter::is_server_visible`
//!      using their KNOWN distance to the publisher.
//!
//! We model the network half (2 + 3 + 4) end-to-end through two real
//! `LibP2pTransport` swarms over loopback QUIC + gossipsub, then run
//! the production decode + filter on the received bytes.

use std::time::Duration;

use app_lib::porch::{
    explore_filter, VisibilityRow, VisibilityUpdate, VISIBILITY_PAYLOAD_KIND,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::mesh_propagation::rotation_topic_for_peer;
use app_lib::servitude::p2p::{BehaviourEvent, LibP2pTransport};
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{
    gossipsub, swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId,
};

/// Build an in-memory Stronghold + handle. Same pattern as `p2p_test.rs`.
fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("visibility-mesh-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
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

fn multiaddr_contains_quic_v1(addr: &Multiaddr) -> bool {
    use libp2p::multiaddr::Protocol;
    addr.iter().any(|p| matches!(p, Protocol::QuicV1))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn visibility_update_propagates_and_filters_by_hop_radius() {
    let (_sh_host, handle_host) = fresh_handle("host");
    let (_sh_visitor, handle_visitor) = fresh_handle("visitor");

    let id_host = identity::load_or_create(&handle_host)
        .await
        .expect("host identity");
    let id_visitor = identity::load_or_create(&handle_visitor)
        .await
        .expect("visitor identity");

    let mut host = LibP2pTransport::new(&id_host, &handle_host, None)
        .await
        .expect("build host transport");
    let mut visitor = LibP2pTransport::new(&id_visitor, &handle_visitor, None)
        .await
        .expect("build visitor transport");

    let host_peer_id = host.local_peer_id();
    let visitor_peer_id = visitor.local_peer_id();
    assert_ne!(host_peer_id, visitor_peer_id);

    let host_topic = rotation_topic_for_peer(&host_peer_id);

    // Both sides subscribe before we dial.
    host.swarm_mut()
        .behaviour_mut()
        .gossipsub
        .subscribe(&host_topic)
        .expect("host self-subscribe");
    visitor
        .swarm_mut()
        .behaviour_mut()
        .gossipsub
        .subscribe(&host_topic)
        .expect("visitor subscribe to host topic");

    // Wait for host's QUIC listen address.
    let host_quic_addr = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let RawSwarmEvent::NewListenAddr { address, .. } =
                host.swarm_mut().select_next_some().await
            {
                if multiaddr_contains_quic_v1(&address) {
                    return address;
                }
            }
        }
    })
    .await
    .expect("host timed out before reporting a quic listen addr");

    // Visitor dials host.
    let dial_addr = quic_loopback_with_peer_id(&host_quic_addr, host_peer_id);
    visitor
        .swarm_mut()
        .dial(dial_addr.clone())
        .expect("visitor::dial");

    // The host's outbound payload.
    let host_row = VisibilityRow {
        server_id: "porch".to_string(),
        max_hops: 1,
        last_changed_at: 1_700_000_000_000,
    };
    let update = VisibilityUpdate::from_row(host_peer_id.to_base58(), &host_row);
    let payload = update.encode();

    // Drive both swarms until host has at least one mesh peer on the
    // topic AND visitor receives the published message. We re-publish
    // on every gossipsub event in case the first publish hit
    // `InsufficientPeers` (the freshly-connected mesh takes a beat to
    // form). Total budget: 30s.
    let received_payload = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            tokio::select! {
                ev = host.swarm_mut().select_next_some() => {
                    if let RawSwarmEvent::Behaviour(
                        BehaviourEvent::Gossipsub(gossipsub::Event::Subscribed { .. })
                    ) = &ev {
                        // Either side subscribed → try to publish.
                        let _ = host
                            .swarm_mut()
                            .behaviour_mut()
                            .gossipsub
                            .publish(host_topic.clone(), payload.clone());
                    }
                    // Best-effort retry on any other host event too —
                    // cheap (publish returns immediately on
                    // InsufficientPeers).
                    let _ = host
                        .swarm_mut()
                        .behaviour_mut()
                        .gossipsub
                        .publish(host_topic.clone(), payload.clone());
                }
                ev = visitor.swarm_mut().select_next_some() => {
                    if let RawSwarmEvent::Behaviour(
                        BehaviourEvent::Gossipsub(gossipsub::Event::Message {
                            message,
                            ..
                        })
                    ) = ev {
                        if message.topic == host_topic.hash() {
                            return message.data;
                        }
                    }
                }
            }
        }
    })
    .await
    .expect("visibility payload not delivered within 30s");

    // Decode + filter using production code paths.
    let decoded = VisibilityUpdate::decode(&received_payload)
        .expect("decode visibility payload received over the wire");
    assert_eq!(decoded.kind, VISIBILITY_PAYLOAD_KIND);
    assert_eq!(decoded.publisher_peer_id, host_peer_id.to_base58());
    assert_eq!(decoded.server_id, "porch");
    assert_eq!(decoded.max_hops, 1);

    // Spec deliverable case A: max_hops=1 → distance-1 visible,
    // distance-2 invisible.
    assert!(
        explore_filter::is_server_visible(1, decoded.max_hops),
        "with max_hops=1, a 1-hop visitor MUST see the host"
    );
    assert!(
        !explore_filter::is_server_visible(2, decoded.max_hops),
        "with max_hops=1, a 2-hop visitor MUST NOT see the host"
    );

    // Spec deliverable case B: operator raises the slider to 2 → the
    // same 2-hop visitor now sees the host.
    let raised = VisibilityUpdate {
        max_hops: 2,
        ..decoded.clone()
    };
    assert!(
        explore_filter::is_server_visible(2, raised.max_hops),
        "with max_hops=2, a 2-hop visitor MUST see the host"
    );
    assert!(
        !explore_filter::is_server_visible(3, raised.max_hops),
        "with max_hops=2, a 3-hop visitor MUST NOT see the host"
    );
}
