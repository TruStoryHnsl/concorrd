//! Porch Phase A — integration tests.
//!
//! Each test maps to a Phase A acceptance criterion. Tests are written
//! from a cold-reader perspective: assertions reflect what an external
//! observer can verify (the SQLite shows one default row; an inbound
//! ACL-denied request gets a 403 envelope; a two-swarm visit
//! round-trips the channel list).

use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::{
    AclMode, AclRole, ChannelKind, ChannelMessage, ChannelVisibility, Porch, PorchHandler,
    PorchListChannelRow, PorchRequest, DEFAULT_PORCH_CHANNEL_ID, PORCH_PROTOCOL_ID,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};

// ---------------------------------------------------------------------------
// (1) First boot — opening a fresh porch creates exactly one default
//     channel of kind=porch, acl_mode=open, with the stable
//     `porch-default` id.
// ---------------------------------------------------------------------------

#[test]
fn default_porch_channel_exists_on_first_boot() {
    let tmp = tempdir_for_test("first-boot");
    let porch = Porch::open(&tmp).expect("open ok");
    let channels = porch.list_channels().expect("list ok");
    assert_eq!(
        channels.len(),
        1,
        "fresh porch must have exactly one channel, got: {channels:?}"
    );
    let ch = &channels[0];
    assert_eq!(ch.id, DEFAULT_PORCH_CHANNEL_ID);
    assert_eq!(ch.kind, ChannelKind::Porch);
    assert_eq!(ch.acl_mode, AclMode::Open);

    // Re-opening the same path must NOT duplicate the default.
    drop(porch);
    let porch2 = Porch::open(&tmp).expect("re-open ok");
    let channels2 = porch2.list_channels().expect("list ok");
    assert_eq!(channels2.len(), 1, "default must not duplicate on re-open");
    assert_eq!(channels2[0].id, DEFAULT_PORCH_CHANNEL_ID);
}

// ---------------------------------------------------------------------------
// (2) ACL filtering — a visitor with no ACL row sees only the open
//     default porch, not any inner channels.
// ---------------------------------------------------------------------------

#[test]
fn list_channels_filters_by_visitor_acl() {
    let porch = Arc::new(Porch::open_in_memory().expect("open ok"));
    // Insert an allowlist-gated inner channel via the same SQL path
    // Phase B will use. We poke the SQL directly via a thin helper
    // because Phase A doesn't expose `create_channel` as public API
    // yet.
    insert_inner_channel(&porch, "inner-test", "Inner", AclMode::Allowlist);

    // Verify list_channels (host view) sees BOTH the default + the
    // inner channel.
    let all = porch.list_channels().expect("list ok");
    assert_eq!(all.len(), 2, "host must see all channels, got: {all:?}");

    // Visitor view via the handler — Phase B exposes BOTH channels but
    // marks the gated one `NeedsKnock` so the visitor's UI can render
    // a knock affordance instead of hiding the room entirely.
    let handler = PorchHandler::new(porch.clone());
    let visitor = fake_peer_id();
    let response = handler.dispatch(visitor, PorchRequest::ListChannels);
    assert!(response.ok, "ListChannels must succeed");
    let rows: Vec<PorchListChannelRow> =
        serde_json::from_value(response.result.unwrap()).unwrap();
    let mut by_id: std::collections::HashMap<&str, &ChannelVisibility> = std::collections::HashMap::new();
    for r in &rows {
        by_id.insert(r.channel.id.as_str(), &r.visibility);
    }
    assert!(
        matches!(by_id.get(DEFAULT_PORCH_CHANNEL_ID), Some(ChannelVisibility::Visible)),
        "open default porch must be Visible"
    );
    assert!(
        matches!(
            by_id.get("inner-test"),
            Some(ChannelVisibility::NeedsKnock { existing_knock: None })
        ),
        "gated inner channel must be NeedsKnock with no existing knock yet"
    );

    // Grant the visitor `member` on the inner channel — they now see
    // the inner channel as Visible.
    porch
        .grant_acl("inner-test", &visitor.to_base58(), AclRole::Member)
        .expect("grant ok");
    let response2 = handler.dispatch(visitor, PorchRequest::ListChannels);
    let rows2: Vec<PorchListChannelRow> =
        serde_json::from_value(response2.result.unwrap()).unwrap();
    let mut by_id2: std::collections::HashMap<&str, &ChannelVisibility> = std::collections::HashMap::new();
    for r in &rows2 {
        by_id2.insert(r.channel.id.as_str(), &r.visibility);
    }
    assert!(
        matches!(by_id2.get(DEFAULT_PORCH_CHANNEL_ID), Some(ChannelVisibility::Visible)),
    );
    assert!(
        matches!(by_id2.get("inner-test"), Some(ChannelVisibility::Visible)),
        "post-grant, visitor must see the inner channel as Visible"
    );
}

// ---------------------------------------------------------------------------
// (3) Posting + reading — three posted messages come back in
//     created_at ascending order.
// ---------------------------------------------------------------------------

#[test]
fn post_message_appends_and_get_messages_returns_in_order() {
    let porch = Arc::new(Porch::open_in_memory().expect("open ok"));
    let handler = PorchHandler::new(porch.clone());
    let visitor = fake_peer_id();

    for body in ["alpha", "beta", "gamma"] {
        let response = handler.dispatch(
            visitor,
            PorchRequest::PostMessage {
                channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
                body: body.to_string(),
            },
        );
        assert!(response.ok, "PostMessage {body} must succeed: {response:?}");
        // Tiny sleep so created_at timestamps don't tie. ULIDs are the
        // tiebreaker even when they do, but a clean ordering keeps the
        // assertion robust.
        std::thread::sleep(Duration::from_millis(2));
    }

    let response = handler.dispatch(
        visitor,
        PorchRequest::GetMessages {
            channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
            since: None,
            limit: 10,
        },
    );
    assert!(response.ok, "GetMessages must succeed: {response:?}");
    let messages: Vec<ChannelMessage> =
        serde_json::from_value(response.result.unwrap()).unwrap();
    assert_eq!(messages.len(), 3, "got {messages:?}");
    let bodies: Vec<&str> = messages.iter().map(|m| m.body.as_str()).collect();
    assert_eq!(
        bodies,
        vec!["alpha", "beta", "gamma"],
        "messages must come back in created_at ascending order"
    );

    // Each message's author_peer_id must equal the connected visitor
    // — the host doesn't trust the visitor to set this field.
    let visitor_b58 = visitor.to_base58();
    for m in &messages {
        assert_eq!(
            m.author_peer_id, visitor_b58,
            "author_peer_id must be the connected visitor"
        );
    }
}

// ---------------------------------------------------------------------------
// (4) Two-swarm visit round-trip — peer A dials peer B over libp2p,
//     opens a stream on /concord/porch/1.0.0, sends ListChannels,
//     receives B's default porch channel back. Same harness shape as
//     federation_test.rs.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_swarm_visit_round_trip() {
    let (mut transport_a, _peer_a, _addr_a) = spawn_transport("a-porch-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-porch-in").await;

    // Register the Porch handler on B BEFORE run() consumes the transport.
    let porch_b = Arc::new(Porch::open_in_memory().expect("porch ok"));
    let handler = Arc::new(PorchHandler::new(porch_b.clone()));
    transport_b.register_federation_handler(handler);

    let mut control_a = transport_a.stream_control();

    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // Open a porch visit stream and round-trip the ListChannels
    // request. The visit helper opens the stream, sends one request,
    // reads one response, closes.
    let rows = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_list_channels(&mut control_a, peer_b),
    )
    .await
    .expect("visit_list_channels timed out — A could not reach B within 10s")
    .expect("visit_list_channels returned an error");

    assert_eq!(rows.len(), 1, "B's porch must report exactly one default channel");
    assert_eq!(rows[0].channel.id, DEFAULT_PORCH_CHANNEL_ID);
    assert_eq!(rows[0].channel.kind, ChannelKind::Porch);
    assert_eq!(rows[0].channel.acl_mode, AclMode::Open);
    assert!(
        matches!(rows[0].visibility, ChannelVisibility::Visible),
        "default porch must be Visible over the wire"
    );

    // Now post a message via the visit path and verify it lands in
    // B's local porch (sanity-check the write side of the protocol).
    let posted = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_post_message(
            &mut control_a,
            peer_b,
            DEFAULT_PORCH_CHANNEL_ID.to_string(),
            "hello from A".to_string(),
        ),
    )
    .await
    .expect("visit_post_message timed out")
    .expect("visit_post_message returned an error");
    assert_eq!(posted.body, "hello from A");

    // Read B's porch directly — the message is there.
    let local = porch_b
        .get_messages(DEFAULT_PORCH_CHANNEL_ID, None, 10)
        .expect("local get_messages ok");
    assert_eq!(local.len(), 1, "B's porch must have exactly the visit-posted message");
    assert_eq!(local[0].body, "hello from A");
}

// Pin the protocol constant — guards against an accidental rename
// breaking the wire shape.
#[test]
fn protocol_constant_pins_to_concord_porch_v1() {
    assert_eq!(PORCH_PROTOCOL_ID, "/concord/porch/1.0.0");
    assert_eq!(
        <PorchHandler as app_lib::servitude::federation::FederationProtocol>::PROTOCOL_ID,
        PORCH_PROTOCOL_ID
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn tempdir_for_test(label: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("concord-porch-test-{label}-{nanos}"));
    std::fs::create_dir_all(&p).expect("mkdir tmp");
    p
}

fn fake_peer_id() -> PeerId {
    let keypair = libp2p::identity::Keypair::generate_ed25519();
    PeerId::from(keypair.public())
}

/// Insert an inner channel through the public `Porch::insert_channel`
/// seam. Phase A doesn't yet expose `porch_create_channel` as a Tauri
/// command — Phase B will — but the DB-level method is public so
/// tests + future Phase B implementation share one path.
fn insert_inner_channel(porch: &Porch, id: &str, name: &str, mode: AclMode) {
    porch
        .insert_channel(id, name, ChannelKind::Inner, mode)
        .expect("insert inner channel ok");
}

/// Build a transport without bootstrap noise, then drive its swarm until
/// it reports a QUIC listen address. Returns the transport, its peer ID,
/// and the loopback multiaddr the other test peer should dial. Mirror of
/// `federation_test.rs::spawn_transport`.
async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let stronghold = Stronghold::default();
    let client_name = format!("porch-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    Box::leak(Box::new(stronghold));
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("phase 2 load_or_create must succeed");
    let mut transport = LibP2pTransport::new(&peer_identity, &handle)
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

