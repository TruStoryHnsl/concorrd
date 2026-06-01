//! User Management Phase 1 — integration tests.
//!
//! Each test maps to an acceptance criterion from the Phase 1 spec.
//! The keychain encryption / decryption / wrong-seed unit cases also
//! exist alongside the module in `src/porch/users.rs::tests`; this
//! file covers the integration paths that go through `Porch::open` to
//! exercise the v7 migration end-to-end.
//!
//! Tests are written cold-reader style: assertions reflect what an
//! external observer can verify (the row exists, the cipher round-
//! trips, the unique index rejects a hand-crafted UPDATE).

use app_lib::porch::{KeychainEntry, Porch, PorchError, Provenance, SeedAccess, SourceKind};
use rusqlite::params;
use zeroize::Zeroizing;

// ---------------------------------------------------------------------------
// 1. migration_creates_default_primary_profile
//    Open a porch on a fresh DB → list profiles → exactly one row
//    with is_primary = true and provenance = local.
// ---------------------------------------------------------------------------

#[test]
fn migration_creates_default_primary_profile() {
    let dir = tempfile::tempdir().expect("tmp");
    let porch = Porch::open(dir.path()).expect("open ok");
    let profiles = porch.list_profiles().expect("list ok");
    assert_eq!(profiles.len(), 1, "expect exactly one seeded profile");
    let p = &profiles[0];
    assert!(p.is_primary, "seeded profile must be primary");
    assert_eq!(p.provenance, Provenance::Local);
    assert_eq!(p.display_name, "Local");
    assert!(!p.id.is_empty(), "id must be a ULID, got empty string");
}

// ---------------------------------------------------------------------------
// 2. create_profile_adds_row_non_primary
//    create_profile returns the new row + DB has it; is_primary = false.
// ---------------------------------------------------------------------------

#[test]
fn create_profile_adds_row_non_primary() {
    let porch = Porch::open_in_memory().expect("open ok");
    let created = porch.create_profile("Work".to_string()).expect("create");
    assert_eq!(created.display_name, "Work");
    assert!(!created.is_primary, "new profile must NOT be primary");
    assert_eq!(created.provenance, Provenance::Local);

    let listed = porch.list_profiles().expect("list");
    assert_eq!(listed.len(), 2, "default + Work");
    let work_row = listed.iter().find(|p| p.id == created.id).expect("present");
    assert!(!work_row.is_primary);
    let primaries: Vec<_> = listed.iter().filter(|p| p.is_primary).collect();
    assert_eq!(primaries.len(), 1, "exactly one primary across all rows");
}

// ---------------------------------------------------------------------------
// 3. set_primary_demotes_previous_primary
//    A (primary) and B (not). Promote B. Exactly one is primary, and
//    it is B.
// ---------------------------------------------------------------------------

#[test]
fn set_primary_demotes_previous_primary() {
    let porch = Porch::open_in_memory().expect("open");
    let a = porch
        .list_profiles()
        .expect("list")
        .into_iter()
        .find(|p| p.is_primary)
        .expect("seeded primary");
    let b = porch.create_profile("Beta".to_string()).expect("create");

    let promoted = porch.set_primary(&b.id).expect("promote");
    assert!(promoted.is_primary);
    assert_eq!(promoted.id, b.id);

    let after = porch.list_profiles().expect("list");
    let primaries: Vec<_> = after.iter().filter(|p| p.is_primary).collect();
    assert_eq!(primaries.len(), 1, "exactly one primary after promote");
    assert_eq!(primaries[0].id, b.id);

    let a_after = porch
        .get_profile(&a.id)
        .expect("get")
        .expect("A still exists");
    assert!(!a_after.is_primary, "A must have been demoted");
}

// ---------------------------------------------------------------------------
// 4. unique_index_blocks_two_primaries
//    Hand-crafted UPDATE attempting to set two primaries simultaneously
//    must be rejected by the partial unique index.
// ---------------------------------------------------------------------------

#[test]
fn unique_index_blocks_two_primaries() {
    let porch = Porch::open_in_memory().expect("open");
    let b = porch.create_profile("Beta".to_string()).expect("create");

    let conn = porch.conn_for_test();
    // The seeded "Local" profile is already is_primary = 1. Trying to
    // promote B without first demoting Local must be rejected by the
    // partial unique index.
    let err = conn
        .execute(
            "UPDATE user_profiles SET is_primary = 1 WHERE id = ?1",
            params![b.id],
        )
        .expect_err("unique partial index must reject");
    let msg = err.to_string();
    assert!(
        msg.to_lowercase().contains("unique") || msg.to_lowercase().contains("constraint"),
        "expected UNIQUE / constraint violation, got: {msg}",
    );
}

// ---------------------------------------------------------------------------
// 5. add_keychain_entry_round_trip
//    add → decrypt → assert plaintext equals input.
// ---------------------------------------------------------------------------

#[test]
fn add_keychain_entry_round_trip() {
    let porch = Porch::open_in_memory().expect("open");
    let primary = porch
        .list_profiles()
        .expect("list")
        .into_iter()
        .find(|p| p.is_primary)
        .expect("seeded primary");
    let seed = StaticSeed([0x5Au8; 32]);
    let creds = serde_json::json!({
        "access_token": "syt_round_trip",
        "user_id": "@alice:home",
        "device_id": "DEV_A",
    });
    let entry: KeychainEntry = porch
        .add_keychain_entry(
            &seed,
            &primary.id,
            SourceKind::Matrix,
            "home.example".to_string(),
            Some("home".to_string()),
            creds.clone(),
        )
        .expect("add");
    assert_eq!(entry.source_kind, SourceKind::Matrix);
    assert_eq!(entry.source_host, "home.example");
    assert_eq!(entry.label.as_deref(), Some("home"));
    assert!(entry.last_used_at.is_none());

    let listed = porch.list_keychain(&primary.id).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, entry.id);

    let decrypted = porch.decrypt_credentials(&seed, &entry.id).expect("decrypt");
    assert_eq!(decrypted.0, creds);

    // last_used_at must be populated after a successful decrypt.
    let after = porch
        .get_keychain_entry(&entry.id)
        .expect("get")
        .expect("present");
    assert!(
        after.last_used_at.is_some(),
        "last_used_at must be populated after decrypt"
    );
}

// ---------------------------------------------------------------------------
// 6. keychain_decryption_fails_with_wrong_seed
//    The load-bearing security check. Encrypt with seed A; decrypt
//    with seed B → typed PorchError::InvalidInput.
// ---------------------------------------------------------------------------

#[test]
fn keychain_decryption_fails_with_wrong_seed() {
    let porch = Porch::open_in_memory().expect("open");
    let primary = porch
        .list_profiles()
        .expect("list")
        .into_iter()
        .find(|p| p.is_primary)
        .expect("seeded primary");
    let entry = porch
        .add_keychain_entry(
            &StaticSeed([0xAAu8; 32]),
            &primary.id,
            SourceKind::Concord,
            "concord.example".to_string(),
            None,
            serde_json::json!({ "token": "secret-payload" }),
        )
        .expect("add");

    let err = porch
        .decrypt_credentials(&StaticSeed([0xBBu8; 32]), &entry.id)
        .expect_err("wrong seed must reject");
    assert!(
        matches!(err, PorchError::InvalidInput(_)),
        "wrong seed must produce InvalidInput, got {err:?}",
    );
    let msg = err.to_string();
    assert!(
        msg.contains("decrypt") || msg.contains("AEAD"),
        "error message must reference AEAD/decrypt failure: {msg}",
    );
}

// ---------------------------------------------------------------------------
// 7. delete_profile_cascades_keychain_entries
//    Add a profile + entries → delete profile → keychain rows gone
//    (ON DELETE CASCADE).
// ---------------------------------------------------------------------------

#[test]
fn delete_profile_cascades_keychain_entries() {
    let porch = Porch::open_in_memory().expect("open");
    let extra = porch.create_profile("Cascade".to_string()).expect("create");
    let seed = StaticSeed([0x77u8; 32]);
    porch
        .add_keychain_entry(
            &seed,
            &extra.id,
            SourceKind::Matrix,
            "h1.example".to_string(),
            None,
            serde_json::json!({"a": 1}),
        )
        .expect("add 1");
    porch
        .add_keychain_entry(
            &seed,
            &extra.id,
            SourceKind::P2pPeer,
            "12D3K".to_string(),
            None,
            serde_json::json!({"a": 2}),
        )
        .expect("add 2");
    let before = porch.list_keychain(&extra.id).expect("list");
    assert_eq!(before.len(), 2);

    porch.delete_profile(&extra.id, false).expect("delete");
    // Profile gone:
    assert!(porch.get_profile(&extra.id).expect("get").is_none());
    // Keychain rows cascaded:
    let after = porch.list_keychain(&extra.id).expect("list");
    assert!(
        after.is_empty(),
        "FK ON DELETE CASCADE must drop keychain rows; got {after:?}",
    );
}

// ---------------------------------------------------------------------------
// 8. delete_only_primary_returns_typed_error
//    The one-and-only primary cannot be deleted without first
//    promoting another. Even with confirm_primary_demotion = true,
//    deleting the LAST profile must be rejected.
// ---------------------------------------------------------------------------

#[test]
fn delete_only_primary_returns_typed_error() {
    let porch = Porch::open_in_memory().expect("open");
    let primary = porch
        .list_profiles()
        .expect("list")
        .into_iter()
        .find(|p| p.is_primary)
        .expect("seeded primary");

    // With another non-primary profile in play, deleting the primary
    // without confirm must still reject ("primary, no confirm").
    let extra = porch.create_profile("Other".to_string()).expect("create");
    let err = porch
        .delete_profile(&primary.id, false)
        .expect_err("must reject primary delete without confirm");
    assert!(matches!(err, PorchError::InvalidInput(_)));

    // With confirm = true, deleting the primary in the presence of
    // another profile MUST succeed (the next primary promotion is the
    // caller's responsibility).
    porch
        .delete_profile(&primary.id, true)
        .expect("delete primary with confirm");

    // Now `extra` is the only profile left. Even with confirm = true,
    // deleting the last remaining profile must reject — the install
    // must always have at least one profile so Phase 2 source-add
    // flows have somewhere to write.
    let err_last = porch
        .delete_profile(&extra.id, true)
        .expect_err("must reject deleting the last profile");
    assert!(matches!(err_last, PorchError::InvalidInput(_)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Inline `SeedAccess` impl returning a fixed seed. The integration
/// tests use it to skip Stronghold setup — the users module doesn't
/// care where the bytes come from.
struct StaticSeed(pub [u8; 32]);

impl SeedAccess for StaticSeed {
    fn export_seed_bytes(&self) -> Result<Zeroizing<[u8; 32]>, PorchError> {
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&self.0);
        Ok(out)
    }
}
