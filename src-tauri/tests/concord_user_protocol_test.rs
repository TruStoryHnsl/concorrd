//! F-A — integration tests for the Concord-native user-definition
//! protocol over libp2p.
//!
//! Test fixtures mirror the pattern in `federation_test.rs`: two
//! transports spun up against in-memory Strongholds, one registers the
//! [`ConcordUserHandler`], the other opens an outbound stream and asserts
//! the round-tripped descriptor matches.

use std::sync::Arc;
use std::time::Duration;

use app_lib::servitude::concord_user::{
    derive_signing_key, open_descriptor_stream, AvatarRef, ConcordUserDescriptor,
    ConcordUserHandler, ConcordUserRequest, ServerId, ServerProfile, TrustEdge,
    TrustLogEntry,
};
use app_lib::servitude::concord_user::protocol::StaticDescriptorApi;
use app_lib::servitude::identity::{self, StrongholdHandle, SECRET_SEED_LEN};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};
use rand::{rngs::OsRng, RngCore};

fn fresh_handle(label: &str) -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client_name = format!("concord-user-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let (sh, handle) = fresh_handle(label);
    Box::leak(Box::new(sh));
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("phase 2 load_or_create must succeed");
    let mut transport = LibP2pTransport::new(&peer_identity, &handle, None)
        .await
        .expect("transport must construct");
    let peer_id = transport.local_peer_id();

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
    .expect("transport timed out waiting for its QUIC listen addr");

    Box::leak(Box::new(handle));
    (transport, peer_id, quic_loopback_with_peer_id(&raw_addr, peer_id))
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

/// Build a deterministic test descriptor with N server rows + an optional
/// trust edge between the first two rows.
fn build_test_descriptor(seed: [u8; SECRET_SEED_LEN], edge_first_two: bool)
    -> ConcordUserDescriptor
{
    let (signing_key, uid) = derive_signing_key(&seed);
    let mut desc = ConcordUserDescriptor::empty(uid, "Hero McTest");

    desc.upsert_server_profile(ServerProfile::sign_new(
        &signing_key,
        &uid,
        ServerId::new("concord:alpha.example"),
        "Alpha-Persona".to_string(),
        None,
        AvatarRef::None,
    ));
    desc.upsert_server_profile(ServerProfile::sign_new(
        &signing_key,
        &uid,
        ServerId::new("concord:beta.example"),
        "Beta-Persona".to_string(),
        None,
        AvatarRef::None,
    ));
    desc.upsert_server_profile(ServerProfile::sign_new(
        &signing_key,
        &uid,
        ServerId::new("matrix:gamma.example"),
        "Gamma-Persona".to_string(),
        Some("placeholder bio".to_string()),
        AvatarRef::MatrixMxc {
            mxc: "mxc://matrix.example/a1b2c3".to_string(),
        },
    ));

    if edge_first_two {
        let edge = TrustEdge::sign_new(
            &signing_key,
            uid,
            ServerId::new("concord:alpha.example"),
            ServerId::new("concord:beta.example"),
            1_700_000_000,
        );
        desc.append_trust(TrustLogEntry::Edge(edge));
    }

    desc
}

/// Phase F-A acceptance: two paired peers exchange ConcordUserDescriptors
/// over `/concord/user-profile/1.0.0` and both sides reach the same
/// merge_view output.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_peers_exchange_descriptors_and_agree_on_merge_view() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-in").await;

    // Build a deterministic descriptor for B and stand up a static
    // responder for the user-profile handler.
    let mut b_seed = [0u8; SECRET_SEED_LEN];
    OsRng.fill_bytes(&mut b_seed);
    let descriptor_b = build_test_descriptor(b_seed, true);

    let api = Arc::new(StaticDescriptorApi::new(descriptor_b.clone()));
    let handler = Arc::new(ConcordUserHandler::new(api));
    transport_b.register_federation_handler(handler);

    let mut control_a = transport_a.stream_control();

    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // A asks B for B's descriptor over the user-profile protocol.
    let request = ConcordUserRequest::GetSelf { request_id: 42 };
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        open_descriptor_stream(&mut control_a, peer_b, request),
    )
    .await
    .expect("open_descriptor_stream timed out — A could not reach B within 10s")
    .expect("open_descriptor_stream returned an error");

    assert_eq!(response.request_id, 42, "request_id must echo");
    assert!(response.error.is_none(), "response must not carry an error");
    let received = response
        .descriptor
        .expect("response must carry a descriptor");

    // The received descriptor must equal B's local one — same wire
    // bytes, no fields lost in transit.
    assert_eq!(
        received, descriptor_b,
        "received descriptor must equal B's local descriptor"
    );

    // Verify signatures survive the wire — both sides verify against
    // the same concord_uid.
    received
        .verify_all_signatures()
        .expect("received descriptor's signatures must verify");

    // Both sides compute the SAME merge view. The build_test_descriptor
    // helper ships an edge between alpha + beta + an unmerged gamma, so
    // the merge view has exactly 2 effective profiles.
    let view_a = received.merge_view();
    let view_b = descriptor_b.merge_view();
    assert_eq!(view_a, view_b, "A and B must agree on the merge view");
    assert_eq!(
        view_a.len(),
        2,
        "alpha+beta merged, gamma isolated → 2 effective profiles"
    );
}
