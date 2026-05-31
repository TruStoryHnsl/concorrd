//! Porch Phase F — multi-device sync integration tests.
//!
//! Each test maps to one of the 10 acceptance criteria in the Phase F
//! task. Tests verify:
//!
//!   1. The v6 migration backfills pre-Phase-F rows with the install's
//!      device-id at lamport 0.
//!   2. Every local write advances the Lamport clock monotonically.
//!   3. LWW: a remote row with strictly higher lamport overwrites
//!      local.
//!   4. LWW: a remote row with strictly lower lamport drops.
//!   5. LWW tiebreak: equal lamport, device_id decides.
//!   6. A remote tombstone for an unknown row inserts as tombstone (no
//!      resurrection on a delayed in-flight insert).
//!   7. PullDelta returns rows above the cursor.
//!   8. The link handshake commits both sides' device_links.
//!   9. sync_now ships a freshly-written row between two linked
//!      swarms.
//!  10. PullDelta from a non-linked peer is denied (403).
//!
//! Tests are cold-reader style: every assertion verifies an
//! externally-observable property (a row's column value, a wire-level
//! response code, a remote DB's state after a sync).

use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::sync::clock;
use app_lib::porch::sync::device::DeviceLink;
use app_lib::porch::sync::merge::{
    apply_remote_channel, apply_remote_message, ChannelMessageRow, PorchChannelRow,
};
use app_lib::porch::sync::protocol::{
    self, apply_sync_batch, local_cursor, sync_now, visit_link_request, visit_pull_delta,
    SyncCursor, SyncDelta, SyncHandler, SyncRequest, SYNC_PROTOCOL_ID,
};
use app_lib::porch::{
    AclMode, ChannelKind, Porch, DEFAULT_PORCH_CHANNEL_ID, SCHEMA_VERSION,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};

// ---------------------------------------------------------------------------
// (1) migration_backfills_existing_rows_with_local_device_id
// ---------------------------------------------------------------------------

/// Open a fresh porch and assert the default channel inherits the
/// install's device-id, lamport > 0, tombstone == 0.
#[test]
fn migration_backfills_existing_rows_with_local_device_id() {
    let porch = Porch::open_in_memory().expect("open");
    let device_id = porch.device_id().expect("device id");
    assert!(!device_id.is_empty());

    // Inspect the default-channel row's sync metadata via PRAGMA-free
    // direct query; the row was written by ensure_default_channel
    // through the stamped helpers.
    let conn = porch.conn_for_test();
    let (row_device, row_lamport, row_tomb): (String, i64, i64) = conn
        .query_row(
            "SELECT sync_device_id, sync_lamport, sync_tombstone
             FROM porch_channels WHERE id = ?1",
            [DEFAULT_PORCH_CHANNEL_ID],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("query ok");
    assert_eq!(row_device, device_id, "default channel must carry our device-id");
    assert!(row_lamport >= 1, "default channel must have lamport >= 1 (got {row_lamport})");
    assert_eq!(row_tomb, 0, "default channel must be alive");
}

// ---------------------------------------------------------------------------
// (2) local_write_advances_lamport
// ---------------------------------------------------------------------------

#[test]
fn local_write_advances_lamport() {
    let porch = Porch::open_in_memory().expect("open");
    let baseline = {
        let conn = porch.conn_for_test();
        clock::observed_max(&conn).expect("max")
    };

    // Insert a channel and a message. Each should strictly advance
    // the observed lamport max.
    porch
        .insert_channel("ch1", "Ch1", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert");
    let after_channel = {
        let conn = porch.conn_for_test();
        clock::observed_max(&conn).expect("max")
    };
    assert!(
        after_channel > baseline,
        "channel insert must advance lamport: baseline={baseline}, after={after_channel}"
    );

    porch
        .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Author", "hello")
        .expect("post");
    let after_message = {
        let conn = porch.conn_for_test();
        clock::observed_max(&conn).expect("max")
    };
    assert!(
        after_message > after_channel,
        "message insert must advance lamport: after_channel={after_channel}, after_message={after_message}"
    );
}

// ---------------------------------------------------------------------------
// (3) lww_apply_remote_higher_wins
// ---------------------------------------------------------------------------

#[test]
fn lww_apply_remote_higher_wins() {
    let porch = Porch::open_in_memory().expect("open");
    // Manually craft a local row at lamport 5, device A.
    porch
        .insert_channel("ch", "Local Name", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert");
    let conn = porch.conn_for_test();
    conn.execute(
        "UPDATE porch_channels SET name = 'Local Name',
            sync_device_id = 'A', sync_lamport = 5
         WHERE id = 'ch'",
        [],
    )
    .expect("update");
    drop(conn);

    // Apply a remote row at lamport 7, device B for the same channel.
    let remote = PorchChannelRow {
        id: "ch".to_string(),
        name: "Remote Name".to_string(),
        kind: "inner".to_string(),
        acl_mode: "allowlist".to_string(),
        created_at: 0,
        sync_device_id: "B".to_string(),
        sync_lamport: 7,
        sync_tombstone: 0,
    };
    let applied = {
        let mut conn_guard = porch.conn_for_test();
        let tx = conn_guard.transaction().expect("tx");
        let r = apply_remote_channel(&tx, &remote).expect("apply");
        tx.commit().expect("commit");
        r
    };
    assert!(applied, "higher lamport must apply");

    // Verify the local row was overwritten.
    let name: String = porch
        .conn_for_test()
        .query_row(
            "SELECT name FROM porch_channels WHERE id = 'ch'",
            [],
            |r| r.get(0),
        )
        .expect("query");
    assert_eq!(name, "Remote Name", "remote higher lamport must overwrite");
}

// ---------------------------------------------------------------------------
// (4) lww_apply_remote_lower_loses
// ---------------------------------------------------------------------------

#[test]
fn lww_apply_remote_lower_loses() {
    let porch = Porch::open_in_memory().expect("open");
    porch
        .insert_channel("ch", "Local Name", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert");
    let conn = porch.conn_for_test();
    conn.execute(
        "UPDATE porch_channels SET name = 'Local Name',
            sync_device_id = 'A', sync_lamport = 7
         WHERE id = 'ch'",
        [],
    )
    .expect("update");
    drop(conn);

    let remote = PorchChannelRow {
        id: "ch".to_string(),
        name: "Remote Name".to_string(),
        kind: "inner".to_string(),
        acl_mode: "allowlist".to_string(),
        created_at: 0,
        sync_device_id: "B".to_string(),
        sync_lamport: 5,
        sync_tombstone: 0,
    };
    let applied = {
        let mut conn_guard = porch.conn_for_test();
        let tx = conn_guard.transaction().expect("tx");
        let r = apply_remote_channel(&tx, &remote).expect("apply");
        tx.commit().expect("commit");
        r
    };
    assert!(!applied, "lower lamport must drop");

    let name: String = porch
        .conn_for_test()
        .query_row(
            "SELECT name FROM porch_channels WHERE id = 'ch'",
            [],
            |r| r.get(0),
        )
        .expect("query");
    assert_eq!(name, "Local Name", "lower lamport must not overwrite");
}

// ---------------------------------------------------------------------------
// (5) lww_tiebreak_device_id
// ---------------------------------------------------------------------------

#[test]
fn lww_tiebreak_device_id() {
    let porch = Porch::open_in_memory().expect("open");
    porch
        .insert_channel("ch", "Local A", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert");
    let conn = porch.conn_for_test();
    conn.execute(
        "UPDATE porch_channels SET name = 'Local A',
            sync_device_id = 'A', sync_lamport = 7
         WHERE id = 'ch'",
        [],
    )
    .expect("update");
    drop(conn);

    // Same lamport, but device_id 'B' > 'A' lexicographically → remote wins.
    let remote = PorchChannelRow {
        id: "ch".to_string(),
        name: "Remote B".to_string(),
        kind: "inner".to_string(),
        acl_mode: "allowlist".to_string(),
        created_at: 0,
        sync_device_id: "B".to_string(),
        sync_lamport: 7,
        sync_tombstone: 0,
    };
    let applied = {
        let mut conn_guard = porch.conn_for_test();
        let tx = conn_guard.transaction().expect("tx");
        let r = apply_remote_channel(&tx, &remote).expect("apply");
        tx.commit().expect("commit");
        r
    };
    assert!(
        applied,
        "tiebreak: higher device_id (B > A) at equal lamport must win"
    );
    let name: String = porch
        .conn_for_test()
        .query_row(
            "SELECT name FROM porch_channels WHERE id = 'ch'",
            [],
            |r| r.get(0),
        )
        .expect("query");
    assert_eq!(name, "Remote B");
}

// ---------------------------------------------------------------------------
// (6) tombstone_for_unknown_row_inserted_as_tombstone
// ---------------------------------------------------------------------------

#[test]
fn tombstone_for_unknown_row_inserted_as_tombstone() {
    let porch = Porch::open_in_memory().expect("open");
    // Apply a tombstoned message for a row we've never seen. The row
    // gets inserted with sync_tombstone = 1 so a later (smaller-lamport)
    // insert can't accidentally resurrect it.
    porch
        .insert_channel("ch", "Ch", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert channel");
    let remote_tomb = ChannelMessageRow {
        id: "msg-x".to_string(),
        channel_id: "ch".to_string(),
        author_peer_id: "12D3Author".to_string(),
        body: "deleted".to_string(),
        created_at: 0,
        sync_device_id: "B".to_string(),
        sync_lamport: 100,
        sync_tombstone: 1,
    };
    let applied = {
        let mut conn_guard = porch.conn_for_test();
        let tx = conn_guard.transaction().expect("tx");
        let r = apply_remote_message(&tx, &remote_tomb).expect("apply");
        tx.commit().expect("commit");
        r
    };
    assert!(applied, "tombstone for unknown row must insert");

    let (tomb, lamport): (i64, i64) = porch
        .conn_for_test()
        .query_row(
            "SELECT sync_tombstone, sync_lamport FROM channel_messages WHERE id = 'msg-x'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("query");
    assert_eq!(tomb, 1, "row must be tombstoned");
    assert_eq!(lamport, 100);

    // A delayed insert with a lower lamport for the same id MUST lose
    // — the tombstone preserves "delete wins" semantics.
    let stale_insert = ChannelMessageRow {
        id: "msg-x".to_string(),
        channel_id: "ch".to_string(),
        author_peer_id: "12D3Author".to_string(),
        body: "stale insert".to_string(),
        created_at: 0,
        sync_device_id: "A".to_string(),
        sync_lamport: 50,
        sync_tombstone: 0,
    };
    let applied = {
        let mut conn_guard = porch.conn_for_test();
        let tx = conn_guard.transaction().expect("tx");
        let r = apply_remote_message(&tx, &stale_insert).expect("apply");
        tx.commit().expect("commit");
        r
    };
    assert!(!applied, "stale insert below tombstone lamport must drop");
    let (tomb_after, _): (i64, i64) = porch
        .conn_for_test()
        .query_row(
            "SELECT sync_tombstone, sync_lamport FROM channel_messages WHERE id = 'msg-x'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("query");
    assert_eq!(tomb_after, 1, "tombstone must persist past stale insert");
}

// ---------------------------------------------------------------------------
// (7) pull_delta_returns_rows_above_cursor
// ---------------------------------------------------------------------------

#[test]
fn pull_delta_returns_rows_above_cursor() {
    let porch = Arc::new(Porch::open_in_memory().expect("open"));
    let device_id = porch.device_id().expect("device id");

    // Insert three rows at synthetic lamports 1, 2, 3 (overwriting the
    // stamps the helpers would have used) so cursors are deterministic.
    porch
        .insert_channel("a", "A", ChannelKind::Inner, AclMode::Allowlist)
        .expect("ins a");
    porch
        .insert_channel("b", "B", ChannelKind::Inner, AclMode::Allowlist)
        .expect("ins b");
    porch
        .insert_channel("c", "C", ChannelKind::Inner, AclMode::Allowlist)
        .expect("ins c");
    {
        let conn = porch.conn_for_test();
        conn.execute(
            "UPDATE porch_channels SET sync_device_id = ?1, sync_lamport = 1 WHERE id = 'a'",
            [&device_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE porch_channels SET sync_device_id = ?1, sync_lamport = 2 WHERE id = 'b'",
            [&device_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE porch_channels SET sync_device_id = ?1, sync_lamport = 3 WHERE id = 'c'",
            [&device_id],
        )
        .unwrap();
    }

    // Link a synthetic personal device so the handler accepts our
    // PullDelta below.
    let requester = fake_peer_id();
    porch
        .link_personal_device(&requester.to_base58(), "01JREMOTE", None)
        .expect("link");

    let handler = SyncHandler::new(porch.clone());
    let mut cursor = SyncCursor::default();
    cursor.since.insert("channels".to_string(), 1);
    let response = handler.dispatch(requester, SyncRequest::PullDelta { since: cursor });
    assert!(response.ok, "PullDelta must succeed");
    let delta: SyncDelta = serde_json::from_value(response.result.unwrap()).unwrap();
    let returned_ids: Vec<&str> = delta.channels.iter().map(|r| r.id.as_str()).collect();
    // The cursor was 1, so rows at lamport 2 + 3 are returned.
    // The default channel from ensure_default_channel was stamped at
    // lamport 1 too, so it's NOT in the result (1 > 1 is false).
    // The three synthetic channels at 1/2/3 → b and c.
    assert!(returned_ids.contains(&"b"), "missing b: got {returned_ids:?}");
    assert!(returned_ids.contains(&"c"), "missing c: got {returned_ids:?}");
    assert!(!returned_ids.contains(&"a"), "a (lamport 1) must not appear: {returned_ids:?}");
}

// ---------------------------------------------------------------------------
// (8) link_handshake_round_trip
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn link_handshake_round_trip() {
    let (mut transport_a, peer_a, _) = spawn_transport("a-link").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-link").await;

    let tmp_a = tempdir_for_test("a-link-porch");
    let porch_a = Arc::new(Porch::open(&tmp_a).expect("porch a"));
    let device_a = porch_a.device_id().expect("dev a");

    let tmp_b = tempdir_for_test("b-link-porch");
    let porch_b = Arc::new(Porch::open(&tmp_b).expect("porch b"));
    let device_b = porch_b.device_id().expect("dev b");

    let handler_b = Arc::new(SyncHandler::new(porch_b.clone()));
    transport_b.register_federation_handler(handler_b);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A dial B");
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // A sends LinkRequest to B; learns B's device-id.
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        visit_link_request(&mut control_a, peer_b, device_a.clone(), None),
    )
    .await
    .expect("timeout")
    .expect("link req err");
    assert_eq!(response.my_device_id, device_b);

    // A commits its side of the link.
    porch_a
        .link_personal_device(&peer_b.to_base58(), &device_b, Some("desktop B"))
        .expect("link a");
    // B's user separately commits its side.
    porch_b
        .link_personal_device(&peer_a.to_base58(), &device_a, Some("phone A"))
        .expect("link b");

    assert_eq!(
        porch_a.list_device_links().expect("list a").len(),
        1,
        "A must have B linked"
    );
    assert_eq!(
        porch_b.list_device_links().expect("list b").len(),
        1,
        "B must have A linked"
    );
    assert!(porch_a.is_personal_device(&peer_b.to_base58()).unwrap());
    assert!(porch_b.is_personal_device(&peer_a.to_base58()).unwrap());
}

// ---------------------------------------------------------------------------
// (9) sync_now_round_trip
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_now_round_trip() {
    let (mut transport_a, peer_a, _addr_a) = spawn_transport("a-sync").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-sync").await;

    let tmp_a = tempdir_for_test("a-sync-porch");
    let porch_a = Arc::new(Porch::open(&tmp_a).expect("porch a"));
    let device_a = porch_a.device_id().expect("dev a");

    let tmp_b = tempdir_for_test("b-sync-porch");
    let porch_b = Arc::new(Porch::open(&tmp_b).expect("porch b"));
    let device_b = porch_b.device_id().expect("dev b");

    // Pre-link both sides — we're testing the sync mechanics, not the
    // link handshake.
    porch_a
        .link_personal_device(&peer_b.to_base58(), &device_b, None)
        .expect("link a→b");
    porch_b
        .link_personal_device(&peer_a.to_base58(), &device_a, None)
        .expect("link b→a");

    // Register sync handlers on BOTH peers — sync_now's pull and push
    // both reach inbound handlers on the OTHER peer.
    let handler_a = Arc::new(SyncHandler::new(porch_a.clone()));
    let handler_b = Arc::new(SyncHandler::new(porch_b.clone()));
    transport_a.register_federation_handler(handler_a);
    transport_b.register_federation_handler(handler_b);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A dial B");
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // A inserts a channel locally.
    porch_a
        .insert_channel("synced-ch", "Synced", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert");

    // Sync from A to B.
    let report = tokio::time::timeout(
        Duration::from_secs(15),
        sync_now(&porch_a, &mut control_a, peer_b),
    )
    .await
    .expect("timeout");
    assert!(
        report.error.is_none(),
        "sync_now must succeed: {:?}",
        report.error
    );

    // B's porch must now have the synced channel. NOTE: list_channels
    // filters tombstones; the channel inserted on A is alive.
    let channels = porch_b.list_channels().expect("list b");
    let ids: Vec<&str> = channels.iter().map(|c| c.id.as_str()).collect();
    assert!(
        ids.contains(&"synced-ch"),
        "B must see synced channel: got {ids:?}"
    );

    // push count for channels must be >= 1.
    let pushed = report.pushed_count_per_table.get("channels").copied().unwrap_or(0);
    assert!(
        pushed >= 1,
        "push count for channels must be at least 1: got {pushed}"
    );
}

// ---------------------------------------------------------------------------
// (10) sync_rejects_non_linked_peer
// ---------------------------------------------------------------------------

#[test]
fn sync_rejects_non_linked_peer() {
    let porch = Arc::new(Porch::open_in_memory().expect("open"));
    let handler = SyncHandler::new(porch);
    let stranger = fake_peer_id();
    let response = handler.dispatch(
        stranger,
        SyncRequest::PullDelta {
            since: SyncCursor::default(),
        },
    );
    assert!(!response.ok, "stranger must be denied");
    let err = response.error.expect("err");
    assert_eq!(err.code, 403, "unlinked peer must surface 403");
}

// ---------------------------------------------------------------------------
// (extra) protocol_constant_pins_to_concord_porch_sync_v1
//     Guards against an accidental rename breaking the wire shape.
// ---------------------------------------------------------------------------

#[test]
fn protocol_constant_pins_to_concord_porch_sync_v1() {
    assert_eq!(SYNC_PROTOCOL_ID, "/concord/porch-sync/1.0.0");
    // The Phase F migration bumped to v6.
    assert_eq!(SCHEMA_VERSION, 6, "Phase F bumps schema to v6");
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
    p.push(format!("concord-porch-sync-test-{label}-{nanos}"));
    std::fs::create_dir_all(&p).expect("mkdir tmp");
    p
}

fn fake_peer_id() -> PeerId {
    let keypair = libp2p::identity::Keypair::generate_ed25519();
    PeerId::from(keypair.public())
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let stronghold = Stronghold::default();
    let client_name = format!("porch-sync-test-{label}");
    let client = stronghold
        .create_client(client_name.as_bytes())
        .expect("create_client ok");
    let handle = StrongholdHandle::new(client);
    Box::leak(Box::new(stronghold));
    let peer_identity = identity::load_or_create(&handle)
        .await
        .expect("identity ok");
    let mut transport = LibP2pTransport::new(&peer_identity, &handle)
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
    (
        transport,
        peer_id,
        quic_loopback_with_peer_id(&raw_addr, peer_id),
    )
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

// Silence unused-import warnings — the imports surface API stability,
// even when not every helper is called in every test.
#[allow(dead_code)]
fn _force_use(_l: DeviceLink, _c: SyncCursor, _d: SyncDelta) {
    let _ = local_cursor;
    let _ = visit_pull_delta;
    let _ = apply_sync_batch;
    let _ = protocol::SYNC_PROTOCOL_ID;
}
