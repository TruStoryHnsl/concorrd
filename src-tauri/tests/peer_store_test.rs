//! Phase 5 (INS-019b) — integration tests for the peer-store module.
//!
//! Each test maps 1:1 to an acceptance criterion from the Phase 5 spec:
//!
//!   (1) `add_and_list_roundtrip`         — a card added via QR appears in
//!                                          the next `list()` with correct
//!                                          source + timestamps.
//!   (2) `add_is_idempotent_and_dedups_multiaddrs` — adding the same
//!                                          peer_id twice merges multiaddrs
//!                                          and preserves first_seen / source.
//!   (3) `add_rejects_malformed_payloads` — empty peer_id, wrong-length
//!                                          public_key_hex, and garbage
//!                                          multiaddrs all produce structured
//!                                          errors and leave the store empty.
//!
//! Test scaffolding follows the Phase 4 cross-restart test: each test
//! allocates a fresh tmp dir, a 32-byte test snapshot password, and
//! constructs `StrongholdHandle::new_persistent(...)`. The peer-store
//! sibling file lives at `<snapshot_path>.peer_store.json.enc` and is
//! cleaned up at the end of each test on success.
//!
//! These tests are written from a cold-reader perspective: they assert
//! observable behavior (list contents, error variants, multiaddr union
//! semantics), not implementation detail.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use app_lib::servitude::identity::StrongholdHandle;
use app_lib::servitude::peer_store::{
    self, KnownPeer, PeerCard, PeerSource, PeerStoreError,
};
use iota_stronghold::Stronghold;

/// Allocate a fresh tmp dir so each test gets its own scratch space.
fn tmp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir()
        .join(format!("concord-peer-store-test-{label}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("tmp dir create");
    dir
}

/// Build a Phase-4-style persistent Stronghold handle backed by a fresh
/// tmp snapshot path. The peer-store derives its sibling file by
/// appending `.peer_store.json.enc` to this snapshot path.
fn persistent_handle(label: &str) -> (Stronghold, StrongholdHandle, PathBuf) {
    let dir = tmp_dir(label);
    let snapshot_path = dir.join("test.stronghold");

    // 32-byte password — same length the production code uses.
    // Pattern bytes so a debugger trace doesn't confuse them with
    // anything else floating around.
    let password: [u8; 32] = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00,
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00,
    ];

    let stronghold = Stronghold::default();
    let client = stronghold
        .create_client(format!("peer-store-test-{label}").as_bytes())
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new_persistent(client, &snapshot_path, &password)
        .expect("new_persistent must accept a 32-byte password");

    (stronghold, handle, dir)
}

/// Canonical valid public_key_hex (64 hex chars, all `aa`). Tests don't
/// need a cryptographically meaningful key — they just need one that
/// passes the validation rules.
fn valid_pubkey_hex() -> String {
    "aa".repeat(32)
}

/// Canonical valid multiaddr. Pulled from Concord's bootstrap-node list
/// shape so it exercises the same parser real production payloads will
/// hit.
const ADDR_QUIC_4001: &str = "/ip4/1.2.3.4/udp/4001/quic-v1";
const ADDR_TCP_4001: &str = "/ip4/1.2.3.4/tcp/4001";
const ADDR_QUIC_5678: &str = "/ip4/5.6.7.8/udp/4001/quic-v1";

/// Canonical PeerId base58 string. Same value the rest of the test
/// suite uses (one of the Phase 3 bootstrap placeholders). It doesn't
/// matter that it's not a real peer — the store only stores the string.
const PEER_ID: &str = "12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W";

// ---------------------------------------------------------------------------
// (1) roundtrip — add a peer via QR, list, observe it.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn add_and_list_roundtrip() {
    let (_sh, handle, dir) = persistent_handle("roundtrip");

    // Sanity: a fresh handle's store is empty.
    let initial = peer_store::list(&handle).await.expect("initial list");
    assert!(
        initial.is_empty(),
        "fresh peer-store must list empty, got: {initial:?}"
    );

    let card = PeerCard {
        peer_id: PEER_ID.to_string(),
        public_key_hex: valid_pubkey_hex(),
        multiaddrs: vec![ADDR_QUIC_4001.to_string()],
    };

    let added: KnownPeer = peer_store::add(&handle, card, PeerSource::Qr)
        .await
        .expect("add must succeed on a valid card");

    // Return value reflects the persisted record.
    assert_eq!(added.peer_id, PEER_ID);
    assert_eq!(added.public_key_hex, valid_pubkey_hex());
    assert_eq!(added.multiaddrs, vec![ADDR_QUIC_4001.to_string()]);
    assert_eq!(added.source, PeerSource::Qr);
    assert_eq!(
        added.first_seen, added.last_seen,
        "first_seen and last_seen must match on a brand-new peer record"
    );

    // List reflects the addition.
    let listed = peer_store::list(&handle).await.expect("list after add");
    assert_eq!(listed.len(), 1, "list must contain exactly the peer we added");
    let entry = &listed[0];
    assert_eq!(entry.peer_id, PEER_ID);
    assert_eq!(entry.public_key_hex, valid_pubkey_hex());
    assert_eq!(entry.multiaddrs, vec![ADDR_QUIC_4001.to_string()]);
    assert_eq!(entry.source, PeerSource::Qr);
    assert_eq!(
        entry.first_seen, entry.last_seen,
        "first_seen and last_seen drifted after a single-call add"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// (2) idempotency — same peer_id twice; multiaddrs union; first_seen +
//     source preserved; last_seen advances.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn add_is_idempotent_and_dedups_multiaddrs() {
    let (_sh, handle, dir) = persistent_handle("idempotent");

    // First add — source QR, two addresses.
    let card_1 = PeerCard {
        peer_id: PEER_ID.to_string(),
        public_key_hex: valid_pubkey_hex(),
        multiaddrs: vec![
            ADDR_QUIC_4001.to_string(),
            ADDR_TCP_4001.to_string(),
        ],
    };
    let added_1 = peer_store::add(&handle, card_1, PeerSource::Qr)
        .await
        .expect("first add must succeed");
    let original_first_seen = added_1.first_seen;
    let original_source = added_1.source.clone();

    // Sleep a millisecond so last_seen can demonstrably advance. chrono's
    // `Utc::now()` has microsecond precision; a >=1ms gap is plenty.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    // Second add — same peer_id, overlapping + new multiaddrs, different
    // source. The store MUST keep the original source and merge addrs.
    let card_2 = PeerCard {
        peer_id: PEER_ID.to_string(),
        public_key_hex: valid_pubkey_hex(),
        multiaddrs: vec![
            ADDR_QUIC_4001.to_string(), // duplicate of first add
            ADDR_QUIC_5678.to_string(), // new
        ],
    };
    let added_2 = peer_store::add(&handle, card_2, PeerSource::Deeplink)
        .await
        .expect("second add must succeed");

    // The store now contains exactly ONE peer.
    let listed = peer_store::list(&handle).await.expect("list");
    assert_eq!(
        listed.len(),
        1,
        "idempotent add must not duplicate peer entries, got: {listed:?}"
    );

    let entry = &listed[0];

    // peer_id, public_key_hex unchanged.
    assert_eq!(entry.peer_id, PEER_ID);
    assert_eq!(entry.public_key_hex, valid_pubkey_hex());

    // Multiaddrs is the UNION (dedup), preserving original ordering with
    // new entries appended.
    assert_eq!(
        entry.multiaddrs,
        vec![
            ADDR_QUIC_4001.to_string(),
            ADDR_TCP_4001.to_string(),
            ADDR_QUIC_5678.to_string(),
        ],
        "multiaddrs must be the union of both adds (dedup, original first), \
         got: {:?}",
        entry.multiaddrs
    );

    // first_seen is the ORIGINAL timestamp (never overwritten).
    assert_eq!(
        entry.first_seen, original_first_seen,
        "first_seen must NOT be overwritten on repeat add — got {:?}, \
         expected {:?}",
        entry.first_seen, original_first_seen
    );

    // last_seen has advanced past first_seen.
    assert!(
        entry.last_seen > entry.first_seen,
        "last_seen must advance on repeat add: last_seen={:?}, \
         first_seen={:?}",
        entry.last_seen,
        entry.first_seen
    );

    // source is preserved — the original Qr remains; the second-call
    // Deeplink does NOT overwrite. This is the deliberate design.
    assert_eq!(
        entry.source, original_source,
        "source must be preserved across repeat add — got {:?}, \
         expected {:?}",
        entry.source, original_source
    );

    // And the second-add return value reflects the same merged record.
    assert_eq!(added_2.multiaddrs, entry.multiaddrs);
    assert_eq!(added_2.first_seen, entry.first_seen);
    assert_eq!(added_2.last_seen, entry.last_seen);
    assert_eq!(added_2.source, entry.source);

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// (3) reject malformed payloads — empty peer_id, wrong-length pubkey,
//     garbage multiaddr. Each returns InvalidPeerId. Store stays empty.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn add_rejects_malformed_payloads() {
    let (_sh, handle, dir) = persistent_handle("malformed");

    // (a) empty peer_id
    let card_empty_id = PeerCard {
        peer_id: String::new(),
        public_key_hex: valid_pubkey_hex(),
        multiaddrs: vec![ADDR_QUIC_4001.to_string()],
    };
    match peer_store::add(&handle, card_empty_id, PeerSource::Qr).await {
        Err(PeerStoreError::InvalidPeerId(_)) => {}
        other => panic!(
            "empty peer_id must return InvalidPeerId, got: {other:?}"
        ),
    }

    // (b) wrong-length public_key_hex
    let card_short_key = PeerCard {
        peer_id: PEER_ID.to_string(),
        public_key_hex: "abcd".to_string(), // 4 chars — way too short
        multiaddrs: vec![ADDR_QUIC_4001.to_string()],
    };
    match peer_store::add(&handle, card_short_key, PeerSource::Qr).await {
        Err(PeerStoreError::InvalidPeerId(_)) => {}
        other => panic!(
            "wrong-length public_key_hex must return InvalidPeerId, got: {other:?}"
        ),
    }

    // (c) garbage multiaddr
    let card_bad_addr = PeerCard {
        peer_id: PEER_ID.to_string(),
        public_key_hex: valid_pubkey_hex(),
        multiaddrs: vec!["not a multiaddr at all".to_string()],
    };
    match peer_store::add(&handle, card_bad_addr, PeerSource::Qr).await {
        Err(PeerStoreError::InvalidPeerId(_)) => {}
        other => panic!(
            "garbage multiaddr must return InvalidPeerId, got: {other:?}"
        ),
    }

    // Store stays empty across all three rejections.
    let listed = peer_store::list(&handle).await.expect("list after rejects");
    assert!(
        listed.is_empty(),
        "malformed-payload rejects must NOT pollute the store, got: {listed:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
