//! Porch Phase E — encrypted backup integration tests.
//!
//! Each test maps to a Phase E acceptance criterion in the spec. The
//! crypto / compression / file-IO unit tests live alongside the module
//! itself in `src-tauri/src/porch/backup.rs::tests`; THIS file covers
//! the integration paths that need a Porch struct + (in two cases) a
//! pair of libp2p swarms.
//!
//! Tests are written cold-reader style: assertions reflect what an
//! external observer can verify (the SQLite row exists; the file lands
//! on disk; the decrypted DB contains the original message; a wrong
//! seed produces a typed error).

use std::sync::Arc;
use std::time::Duration;

use app_lib::porch::{
    backup, backup_targets, AclMode, AclRole, BackupHandler, BackupRequest, ChannelKind,
    EncryptedBackup, Porch, PorchHandler, ReceivedBackupSummary, SeedAccess, BACKUP_PROTOCOL_ID,
    DEFAULT_PORCH_CHANNEL_ID,
};
use app_lib::servitude::identity::{self, StrongholdHandle};
use app_lib::servitude::p2p::LibP2pTransport;
use futures::StreamExt;
use iota_stronghold::Stronghold;
use libp2p::{swarm::SwarmEvent as RawSwarmEvent, Multiaddr, PeerId};
use zeroize::Zeroizing;

// ---------------------------------------------------------------------------
// (1) backup_round_trip_local
//     Open a porch, populate some data, build a backup, restore over a
//     fresh DB path, assert all data is intact. No libp2p — just the
//     encrypt/compress/decrypt/decompress path.
// ---------------------------------------------------------------------------

#[test]
fn backup_round_trip_local() {
    let dir = tempfile::tempdir().expect("tmp");
    let porch = Porch::open(dir.path()).expect("open ok");
    // Seed some real data: a few channels + a few messages.
    porch
        .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Author", "msg-one")
        .expect("post 1");
    porch
        .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Author", "msg-two")
        .expect("post 2");
    porch
        .insert_channel("inner-a", "Inner A", ChannelKind::Inner, AclMode::Allowlist)
        .expect("insert ok");
    porch
        .grant_acl("inner-a", "12D3Member", AclRole::Member)
        .expect("grant ok");

    let seed = StaticSeed([0x11; 32]);
    let blob =
        backup::build_encrypted_backup(&porch, "12D3Uploader", &seed).expect("build ok");
    assert_eq!(blob.uploader_peer_id, "12D3Uploader");
    assert!(!blob.ciphertext.is_empty());

    // Restore into a fresh DB and re-open. Drop the live porch first
    // so the SQLite lock doesn't block the atomic rename.
    drop(porch);
    let dir2 = tempfile::tempdir().expect("tmp 2");
    let db2_path = dir2.path().join("porch.sqlite");
    let restored_version =
        backup::restore_from_blob(&db2_path, &blob, &seed).expect("restore ok");
    assert_eq!(
        restored_version,
        app_lib::porch::SCHEMA_VERSION,
        "restored schema version must match the current SCHEMA_VERSION"
    );

    let porch2 = Porch::open(dir2.path()).expect("re-open ok");
    let msgs = porch2
        .get_messages(DEFAULT_PORCH_CHANNEL_ID, None, 100)
        .expect("get ok");
    let bodies: Vec<&str> = msgs.iter().map(|m| m.body.as_str()).collect();
    assert!(
        bodies.contains(&"msg-one") && bodies.contains(&"msg-two"),
        "restored DB must contain both original messages; got {bodies:?}",
    );
    // Channels: default + inner-a, in that order.
    let channels = porch2.list_channels().expect("list ok");
    let ids: Vec<&str> = channels.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&DEFAULT_PORCH_CHANNEL_ID));
    assert!(ids.contains(&"inner-a"));
    // ACL row survives the round trip.
    let role = porch2
        .lookup_acl("inner-a", "12D3Member")
        .expect("lookup ok");
    assert_eq!(role, Some(AclRole::Member));
}

// ---------------------------------------------------------------------------
// (2) backup_decryption_fails_with_wrong_seed
//     Build with seed A, attempt restore with seed B → typed error.
//     This is the load-bearing cross-seed safety property.
// ---------------------------------------------------------------------------

#[test]
fn backup_decryption_fails_with_wrong_seed() {
    let dir = tempfile::tempdir().expect("tmp");
    let porch = Porch::open(dir.path()).expect("open ok");
    porch
        .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3A", "secret")
        .expect("post ok");
    let blob = backup::build_encrypted_backup(&porch, "12D3U", &StaticSeed([1u8; 32]))
        .expect("build ok");
    drop(porch);
    let dir2 = tempfile::tempdir().expect("tmp 2");
    let db2_path = dir2.path().join("porch.sqlite");
    let err = backup::restore_from_blob(&db2_path, &blob, &StaticSeed([2u8; 32]))
        .expect_err("wrong seed must reject");
    assert!(
        matches!(err, app_lib::porch::PorchError::InvalidInput(_)),
        "wrong seed must produce InvalidInput, got {err:?}",
    );
    let msg = err.to_string();
    assert!(
        msg.contains("AEAD decrypt") || msg.contains("decrypt"),
        "error message must reference decrypt failure: {msg}",
    );
    // Critical: the destination DB MUST NOT have been touched. A
    // partially-written-then-failed restore would leave an empty file
    // and silently break the user's install.
    assert!(
        !db2_path.exists(),
        "wrong-seed restore must not leave a partial file",
    );
}

// ---------------------------------------------------------------------------
// (3) targets_add_list_remove_round_trip
//     CRUD on backup_targets — the surface the UI uses.
// ---------------------------------------------------------------------------

#[test]
fn targets_add_list_remove_round_trip() {
    let porch = Porch::open_in_memory().expect("open ok");
    assert!(backup_targets::list(&porch).expect("list").is_empty());

    let t1 = backup_targets::add(&porch, "12D3KooW1", Some("docker server"))
        .expect("add 1");
    assert_eq!(t1.label.as_deref(), Some("docker server"));
    assert!(t1.last_success_at.is_none());

    backup_targets::add(&porch, "12D3KooW2", None).expect("add 2");
    let all = backup_targets::list(&porch).expect("list");
    assert_eq!(all.len(), 2);

    // Re-adding the same peer updates the label without duplicating.
    backup_targets::add(&porch, "12D3KooW1", Some("renamed docker"))
        .expect("re-add");
    let after_relabel = backup_targets::list(&porch).expect("list");
    assert_eq!(after_relabel.len(), 2, "must not duplicate on re-add");
    let renamed = after_relabel
        .iter()
        .find(|t| t.peer_id == "12D3KooW1")
        .expect("present");
    assert_eq!(renamed.label.as_deref(), Some("renamed docker"));

    // Record a success → list reflects it.
    backup_targets::record_success(&porch, "12D3KooW1", 12345).expect("success");
    let with_success = backup_targets::list(&porch).expect("list");
    let row = with_success
        .iter()
        .find(|t| t.peer_id == "12D3KooW1")
        .expect("present");
    assert_eq!(row.last_success_at, Some(12345));

    // Remove.
    let n = backup_targets::remove(&porch, "12D3KooW1").expect("rm");
    assert_eq!(n, 1);
    let leftover = backup_targets::list(&porch).expect("list");
    assert_eq!(leftover.len(), 1);
    assert_eq!(leftover[0].peer_id, "12D3KooW2");
}

// ---------------------------------------------------------------------------
// (4) received_backup_stores_and_reads
//     Backup-peer side: store_received_backup then read_received_backup
//     yields an identical envelope (uploader_peer_id, ciphertext,
//     nonce, schema_version). Exercises the on-disk
//     `[nonce][ciphertext]` layout.
// ---------------------------------------------------------------------------

#[test]
fn received_backup_stores_and_reads() {
    let dir = tempfile::tempdir().expect("tmp");
    let porch = Porch::open(dir.path()).expect("open ok");

    let blob = EncryptedBackup {
        uploader_peer_id: "12D3KooWUploader".to_string(),
        ciphertext: (0u8..32u8).collect(),
        nonce: [7u8; 12],
        schema_version: 5,
        taken_at: 999,
    };
    backup::store_received_backup(&porch, &blob).expect("store ok");

    let back = backup::read_received_backup(&porch, "12D3KooWUploader")
        .expect("read ok")
        .expect("must be present");
    assert_eq!(back.uploader_peer_id, blob.uploader_peer_id);
    assert_eq!(back.ciphertext, blob.ciphertext);
    assert_eq!(back.nonce, blob.nonce);
    assert_eq!(back.schema_version, blob.schema_version);

    // read_received_backup_info gives summary without bytes.
    let info: Option<ReceivedBackupSummary> =
        backup::read_received_backup_info(&porch, "12D3KooWUploader").expect("info");
    let info = info.expect("must exist");
    assert_eq!(info.uploader_peer_id, blob.uploader_peer_id);
    assert_eq!(info.blob_size, blob.ciphertext.len() as i64);
    assert_eq!(info.schema_version, 5);

    // Unknown uploader → None on both surfaces.
    assert!(backup::read_received_backup(&porch, "12D3KooWOther")
        .expect("ok")
        .is_none());
    assert!(backup::read_received_backup_info(&porch, "12D3KooWOther")
        .expect("ok")
        .is_none());

    // Re-store overwrites the old blob in place — latest only.
    let blob2 = EncryptedBackup {
        uploader_peer_id: "12D3KooWUploader".to_string(),
        ciphertext: vec![99u8; 8],
        nonce: [1u8; 12],
        schema_version: 5,
        taken_at: 1000,
    };
    backup::store_received_backup(&porch, &blob2).expect("re-store");
    let after = backup::read_received_backup(&porch, "12D3KooWUploader")
        .expect("read")
        .expect("present");
    assert_eq!(after.ciphertext, blob2.ciphertext);
    assert_eq!(after.nonce, blob2.nonce);
    // One row only — `PRIMARY KEY(uploader_peer_id)` enforces this.
    let listed = backup::list_received_backups(&porch).expect("list");
    assert_eq!(listed.len(), 1);
}

// ---------------------------------------------------------------------------
// (5) two_swarm_backup_upload
//     A configures B as a backup target; A pushes a backup; B's porch
//     shows a `received_backups` row keyed by A's peer-id.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_swarm_backup_upload() {
    let (mut transport_a, peer_a, _addr_a) = spawn_transport("a-bk-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-bk-in").await;

    // A's porch — the one we'll back up.
    let tmp_a = tempdir_for_test("a-porch");
    let porch_a = Arc::new(Porch::open(&tmp_a).expect("porch a"));
    porch_a
        .post_message(DEFAULT_PORCH_CHANNEL_ID, &peer_a.to_base58(), "hi from A")
        .expect("post");

    // B's porch — the backup peer. B's handler will accept inbound
    // uploads from A and store them under A's peer-id.
    let tmp_b = tempdir_for_test("b-porch");
    let porch_b = Arc::new(Porch::open(&tmp_b).expect("porch b"));
    let backup_handler_b = Arc::new(BackupHandler::new(porch_b.clone()));
    // Also register a regular porch handler — not strictly necessary
    // for this test, but mirrors the real wire path where both
    // protocols live on the same swarm.
    let porch_handler_b = Arc::new(PorchHandler::new(porch_b.clone()));
    transport_b.register_federation_handler(backup_handler_b);
    transport_b.register_federation_handler(porch_handler_b);

    let mut control_a = transport_a.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A::dial(B)");
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });

    // Build A's encrypted blob with a fixed seed (the same seed
    // we'd use on restore). The uploader peer-id MUST match A's
    // libp2p PeerId — the handler enforces this server-side.
    let seed = StaticSeed([0x42; 32]);
    let blob = backup::build_encrypted_backup(&porch_a, &peer_a.to_base58(), &seed)
        .expect("build");

    // Push.
    tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_backup_upload(&mut control_a, peer_b, blob.clone()),
    )
    .await
    .expect("upload timed out")
    .expect("upload err");

    // B's porch must show the row keyed by A's peer-id.
    let info = backup::read_received_backup_info(&porch_b, &peer_a.to_base58())
        .expect("info ok")
        .expect("must be present");
    assert_eq!(info.uploader_peer_id, peer_a.to_base58());
    assert_eq!(info.schema_version, app_lib::porch::SCHEMA_VERSION);
    assert!(info.blob_size > 0, "blob must have been persisted");
}

// ---------------------------------------------------------------------------
// (6) two_swarm_backup_restore_only_for_original_uploader
//     Peer A uploads → peer C (different identity) opens a stream and
//     asks `GetMyBackup` → B's handler returns None (the backup is
//     keyed by A's peer-id, not C's).
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_swarm_backup_restore_only_for_original_uploader() {
    let (mut transport_a, peer_a, _) = spawn_transport("a-acl-out").await;
    let (mut transport_b, peer_b, addr_b) = spawn_transport("b-acl-in").await;
    let (mut transport_c, _peer_c, _) = spawn_transport("c-acl-out").await;

    let tmp_a = tempdir_for_test("a-acl");
    let porch_a = Arc::new(Porch::open(&tmp_a).expect("porch a"));
    porch_a
        .post_message(DEFAULT_PORCH_CHANNEL_ID, &peer_a.to_base58(), "only for A")
        .expect("post");

    let tmp_b = tempdir_for_test("b-acl");
    let porch_b = Arc::new(Porch::open(&tmp_b).expect("porch b"));
    let handler_b = Arc::new(BackupHandler::new(porch_b.clone()));
    transport_b.register_federation_handler(handler_b);

    let mut control_a = transport_a.stream_control();
    let mut control_c = transport_c.stream_control();
    transport_a
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("A dial B");
    transport_c
        .swarm_mut()
        .dial(addr_b.clone())
        .expect("C dial B");
    tokio::spawn(async move { transport_a.run().await });
    tokio::spawn(async move { transport_b.run().await });
    tokio::spawn(async move { transport_c.run().await });

    // A uploads a blob.
    let seed = StaticSeed([0x55; 32]);
    let blob = backup::build_encrypted_backup(&porch_a, &peer_a.to_base58(), &seed)
        .expect("build");
    tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_backup_upload(&mut control_a, peer_b, blob),
    )
    .await
    .expect("upload timed out")
    .expect("upload err");

    // C asks for "my backup" — the handler keys on C's PeerId, finds
    // nothing, returns None. Critically, C does NOT get A's blob.
    let c_result = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_backup_get_my_backup(&mut control_c, peer_b),
    )
    .await
    .expect("get_my_backup timed out")
    .expect("get_my_backup err");
    assert!(
        c_result.is_none(),
        "peer C must not receive peer A's backup — per-uploader ACL violated",
    );

    // Sanity check: A asking for their own works.
    let a_result = tokio::time::timeout(
        Duration::from_secs(10),
        app_lib::porch::visit_backup_get_my_backup(&mut control_a, peer_b),
    )
    .await
    .expect("get_my_backup A timed out")
    .expect("get_my_backup A err");
    assert!(
        a_result.is_some(),
        "peer A must receive their own backup back",
    );
}

// ---------------------------------------------------------------------------
// (extra) protocol_constant_pins_to_concord_porch_backup_v1
//     Guards against an accidental rename breaking the wire shape.
// ---------------------------------------------------------------------------

#[test]
fn protocol_constant_pins_to_concord_porch_backup_v1() {
    assert_eq!(BACKUP_PROTOCOL_ID, "/concord/porch-backup/1.0.0");
}

// ---------------------------------------------------------------------------
// (extra) backup_handler_rejects_forged_uploader_peer_id
//     The on-wire envelope carries a self-declared `uploader_peer_id`;
//     the dispatch path must verify it matches the connected libp2p
//     PeerId. Otherwise peer A could overwrite peer B's backup with
//     garbage.
// ---------------------------------------------------------------------------

#[test]
fn backup_handler_rejects_forged_uploader_peer_id() {
    let dir = tempfile::tempdir().expect("tmp");
    let porch = Arc::new(Porch::open(dir.path()).expect("open"));
    let handler = BackupHandler::new(porch);
    let connection_peer = fake_peer_id();
    let other_peer = fake_peer_id();
    assert_ne!(connection_peer, other_peer);
    let forged = EncryptedBackup {
        uploader_peer_id: other_peer.to_base58(),
        ciphertext: vec![0u8; 16],
        nonce: [0u8; 12],
        schema_version: 5,
        taken_at: 0,
    };
    let response =
        handler.dispatch(connection_peer, BackupRequest::UploadBackup { backup: forged });
    assert!(!response.ok);
    assert_eq!(response.error.unwrap().code, 403);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Inline `SeedAccess` impl returning a fixed seed. The integration
/// tests use it to skip Stronghold setup — the backup module doesn't
/// care where the bytes come from.
struct StaticSeed(pub [u8; 32]);

impl SeedAccess for StaticSeed {
    fn export_seed_bytes(&self) -> Result<Zeroizing<[u8; 32]>, app_lib::porch::PorchError> {
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&self.0);
        Ok(out)
    }
}

fn tempdir_for_test(label: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("concord-porch-backup-test-{label}-{nanos}"));
    std::fs::create_dir_all(&p).expect("mkdir tmp");
    p
}

fn fake_peer_id() -> PeerId {
    let keypair = libp2p::identity::Keypair::generate_ed25519();
    PeerId::from(keypair.public())
}

async fn spawn_transport(label: &str) -> (LibP2pTransport, PeerId, Multiaddr) {
    let stronghold = Stronghold::default();
    let client_name = format!("porch-backup-test-{label}");
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
