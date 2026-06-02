//! Porch Phase B — knock-to-enter integration tests.
//!
//! Mirrors the structure of `porch_test.rs` (Phase A): each test maps
//! to a Phase B acceptance criterion, assertions reflect what an
//! external observer can verify (the DB row exists, the ACL is
//! granted atomically, the two-swarm wire round-trips the knock
//! lifecycle).

use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::{
    AclMode, AclRole, ChannelKind, ChannelVisibility, Knock, KnockStatus, Porch, PorchHandler,
    PorchListChannelRow, PorchRequest,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};

// ---------------------------------------------------------------------------
// (1) knock_creates_pending_row — a knock from a visitor on an
//     allowlist-gated inner channel records a row with status=pending
//     and the supplied message.
// ---------------------------------------------------------------------------

#[test]
fn knock_creates_pending_row() {
    let porch = inner_porch_with_allowlist("inner-1");
    let knock = porch
        .knock("inner-1", "12D3Visitor", Some("let me in"))
        .expect("knock ok");
    assert_eq!(knock.channel_id, "inner-1");
    assert_eq!(knock.knocker_peer_id, "12D3Visitor");
    assert_eq!(knock.message.as_deref(), Some("let me in"));
    assert_eq!(knock.status, KnockStatus::Pending);
    assert!(knock.resolved_at.is_none());

    let pending = porch.pending_knocks().expect("pending ok");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, knock.id);
}

// ---------------------------------------------------------------------------
// (2) knock_dedupe_on_existing_pending — a second knock for the same
//     (channel, peer) while pending returns the existing row and does
//     NOT insert a duplicate (would otherwise hit the partial unique
//     index).
// ---------------------------------------------------------------------------

#[test]
fn knock_dedupe_on_existing_pending() {
    let porch = inner_porch_with_allowlist("inner-1");
    let first = porch.knock("inner-1", "12D3V", Some("hi")).expect("knock 1");
    let second = porch
        .knock("inner-1", "12D3V", Some("hi again"))
        .expect("knock 2");
    assert_eq!(first.id, second.id, "must return existing pending knock");
    assert_eq!(first.message, second.message);
    let pending = porch.pending_knocks().expect("pending ok");
    assert_eq!(
        pending.len(),
        1,
        "dedupe must keep exactly one pending row"
    );
}

// ---------------------------------------------------------------------------
// (3) accept_knock_grants_member_acl_atomically — accepting flips the
//     knock row to accepted AND inserts a `member` ACL grant for the
//     knocker in the same transaction.
// ---------------------------------------------------------------------------

#[test]
fn accept_knock_grants_member_acl_atomically() {
    let porch = inner_porch_with_allowlist("inner-1");
    let k = porch.knock("inner-1", "12D3V", None).expect("knock ok");
    let role_before = porch.lookup_acl("inner-1", "12D3V").expect("lookup ok");
    assert_eq!(role_before, None, "no ACL row before accept");

    let accepted = porch.accept_knock(&k.id).expect("accept ok");
    assert_eq!(accepted.status, KnockStatus::Accepted);
    assert!(accepted.resolved_at.is_some());

    let role_after = porch.lookup_acl("inner-1", "12D3V").expect("lookup ok");
    assert_eq!(
        role_after,
        Some(AclRole::Member),
        "accept must insert a `member` ACL row atomically"
    );

    // The knock is no longer in pending_knocks.
    let pending = porch.pending_knocks().expect("pending ok");
    assert!(pending.is_empty(), "accepted knock must clear pending list");
}

// ---------------------------------------------------------------------------
// (4) reject_knock_does_not_grant_acl — rejecting flips the knock row
//     to rejected and leaves channel_acl untouched.
// ---------------------------------------------------------------------------

#[test]
fn reject_knock_does_not_grant_acl() {
    let porch = inner_porch_with_allowlist("inner-1");
    let k = porch.knock("inner-1", "12D3V", None).expect("knock ok");
    let rejected = porch.reject_knock(&k.id).expect("reject ok");
    assert_eq!(rejected.status, KnockStatus::Rejected);
    let role = porch.lookup_acl("inner-1", "12D3V").expect("lookup ok");
    assert_eq!(role, None, "reject must NOT grant ACL");
}

// ---------------------------------------------------------------------------
// (5) withdraw_only_works_for_knocker — only the original knocker can
//     withdraw their own row; another peer's attempt returns
//     AccessDenied.
// ---------------------------------------------------------------------------

#[test]
fn withdraw_only_works_for_knocker() {
    let porch = inner_porch_with_allowlist("inner-1");
    let k = porch.knock("inner-1", "12D3V", None).expect("knock ok");
    let err = porch
        .withdraw_knock(&k.id, "12D3OtherPeer")
        .expect_err("other peer must be denied");
    assert!(
        matches!(err, app_lib::porch::PorchError::AccessDenied { .. }),
        "got: {err:?}"
    );
    let ok = porch
        .withdraw_knock(&k.id, "12D3V")
        .expect("knocker can withdraw");
    assert_eq!(ok.status, KnockStatus::Withdrawn);
}

// ---------------------------------------------------------------------------
// (6) list_channels_after_phase_b_shows_visibility — over the
//     dispatcher, ListChannels returns visibility per row: the open
//     default porch as Visible; a gated inner channel without a knock
//     as NeedsKnock{existing_knock: None}; a gated inner channel WITH
//     a prior pending knock as NeedsKnock{existing_knock: Some(Pending)}.
// ---------------------------------------------------------------------------

#[test]
fn list_channels_after_phase_b_shows_visibility() {
    let porch = Arc::new(Porch::open_in_memory().expect("open ok"));
    porch
        .insert_channel(
            "inner-clean",
            "Clean Inner",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ok");
    porch
        .insert_channel(
            "inner-pending",
            "Pending Inner",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ok");

    let handler = PorchHandler::new(porch.clone());
    let visitor = fake_peer_id();

    // Pre-seed: visitor has already knocked on inner-pending.
    porch
        .knock("inner-pending", &visitor.to_base58(), Some("please"))
        .expect("seed knock ok");

    let response = handler.dispatch(visitor, PorchRequest::ListChannels);
    assert!(response.ok);
    let rows: Vec<PorchListChannelRow> =
        serde_json::from_value(response.result.unwrap()).unwrap();
    assert_eq!(rows.len(), 3, "three channels visible to visitor: {rows:?}");

    let mut by_id = std::collections::HashMap::new();
    for r in &rows {
        by_id.insert(r.channel.id.clone(), r);
    }
    let porch_row = by_id
        .get(app_lib::porch::DEFAULT_PORCH_CHANNEL_ID)
        .expect("porch row");
    assert!(matches!(porch_row.visibility, ChannelVisibility::Visible));

    let clean_row = by_id.get("inner-clean").expect("inner-clean row");
    assert!(
        matches!(
            clean_row.visibility,
            ChannelVisibility::NeedsKnock { existing_knock: None }
        ),
        "clean inner channel must be NeedsKnock with no existing knock: {:?}",
        clean_row.visibility
    );

    let pending_row = by_id.get("inner-pending").expect("inner-pending row");
    assert!(
        matches!(
            pending_row.visibility,
            ChannelVisibility::NeedsKnock {
                existing_knock: Some(KnockStatus::Pending)
            }
        ),
        "pending inner channel must surface the visitor's existing pending knock: {:?}",
        pending_row.visibility
    );
}

// ---------------------------------------------------------------------------
// (7) knock_round_trip_over_libp2p — two-swarm visit test. Peer A
//     knocks on B's inner channel over the wire, polls KnockStatus,
//     and (after B's owner-side accept) sees the channel as Visible
//     on the next ListChannels.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn knock_round_trip_over_libp2p() {
    let (mut transport_a, peer_a, _addr_a) = spawn_transport("a-knock-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-knock-in").await;

    // B's porch with one gated inner channel.
    let porch_b = Arc::new(Porch::open_in_memory().expect("porch ok"));
    porch_b
        .insert_channel(
            "campaign-notes",
            "Campaign Notes",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ok");
    let handler = Arc::new(PorchHandler::new(porch_b.clone()));
    transport_b.register_federation_handler(handler);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B) must enqueue");

    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // (1) ListChannels — A sees the campaign channel as NeedsKnock.
    let rows = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_list_channels(&mut control_a, peer_b),
    )
    .await
    .expect("visit_list_channels timed out")
    .expect("visit_list_channels err");
    let campaign = rows
        .iter()
        .find(|r| r.channel.id == "campaign-notes")
        .expect("must see campaign channel");
    assert!(
        matches!(
            campaign.visibility,
            ChannelVisibility::NeedsKnock { existing_knock: None }
        ),
        "before knocking, must be NeedsKnock with no existing knock"
    );

    // (2) Knock — A files a knock with a message.
    let knock = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_knock(
            &mut control_a,
            peer_b,
            "campaign-notes".to_string(),
            Some("DM let me into the campaign please".to_string()),
        ),
    )
    .await
    .expect("visit_knock timed out")
    .expect("visit_knock err");
    assert_eq!(knock.status, KnockStatus::Pending);
    assert_eq!(knock.knocker_peer_id, peer_a.to_base58());

    // (3) KnockStatus — A polls and sees their own pending knock.
    let status_before = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_knock_status(
            &mut control_a,
            peer_b,
            "campaign-notes".to_string(),
        ),
    )
    .await
    .expect("status timeout")
    .expect("status err");
    let s: Knock = status_before.expect("must have a knock");
    assert_eq!(s.status, KnockStatus::Pending);

    // (4) B's owner accepts (locally — not over the wire).
    let accepted = porch_b.accept_knock(&knock.id).expect("accept ok");
    assert_eq!(accepted.status, KnockStatus::Accepted);

    // (5) ListChannels again — A now sees the channel as Visible.
    let rows2 = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_list_channels(&mut control_a, peer_b),
    )
    .await
    .expect("visit_list_channels 2 timed out")
    .expect("visit_list_channels 2 err");
    let campaign2 = rows2
        .iter()
        .find(|r| r.channel.id == "campaign-notes")
        .expect("must still see campaign channel");
    assert!(
        matches!(campaign2.visibility, ChannelVisibility::Visible),
        "after accept, A's view must flip to Visible"
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn inner_porch_with_allowlist(channel_id: &str) -> Porch {
    let porch = Porch::open_in_memory().expect("open ok");
    porch
        .insert_channel(channel_id, "Inner", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert ok");
    porch
}

fn fake_peer_id() -> PeerId {
    let keypair = libp2p::identity::Keypair::generate_ed25519();
    PeerId::from(keypair.public())
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let stronghold = Stronghold::default();
    let client_name = format!("porch-knock-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client ok");
    let handle = StrongholdHandle::new(client);
    Box::leak(Box::new(stronghold));
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("identity ok");
    let mut transport = LibP2pTransport::new(&peer_identity, &handle, None)
        .await
        .expect("transport ok");
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
    .expect("transport timed out waiting for QUIC listen addr");

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
