//! F1c — encrypted home-server export integration tests.
//!
//! Spec maps to:
//!
//!   * "Fixture: write a tiny porch DB with known rows + a `home_assets/`
//!     file." — see [`home_export_round_trip_reconstructs_db_and_assets`].
//!   * "Export → decrypt → untar → reconstruct → row counts + asset
//!     bytes match." — same test.
//!   * "Negative: wrong passphrase → decryption fails with auth tag
//!     error." — see [`home_export_wrong_passphrase_rejects_with_auth_error`].
//!
//! Tests are cold-reader style: assertions describe what an external
//! observer can verify (the package file exists; decrypted plaintext is
//! a valid tar; reopening the restored SQLite returns the original
//! rows + asset bytes).

use std::fs;
use std::io::Read;
use std::sync::Arc;

use app_lib::porch::{
    build_home_export_package, decrypt_home_export_package, read_meta_from_tar, AclMode,
    ChannelKind, Porch, PorchError, DEFAULT_PORCH_CHANNEL_ID, PACKAGE_FORMAT_VERSION,
    SUBJECT_HOME,
};

/// Walk a tar archive, returning `(in_tar_path, body_bytes)` for every
/// regular file entry. Order is preserved.
fn collect_tar_entries(tar_bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut archive = tar::Archive::new(tar_bytes);
    for entry_res in archive.entries().expect("tar entries") {
        let mut entry = entry_res.expect("tar entry");
        let path = entry
            .path()
            .expect("path")
            .to_string_lossy()
            .into_owned();
        let mut body = Vec::new();
        entry.read_to_end(&mut body).expect("read entry body");
        out.push((path, body));
    }
    out
}

/// (Spec) Fixture: porch with known rows + a `home_assets/` file.
/// Export → decrypt → untar → reconstruct → row counts + asset bytes
/// match.
#[test]
fn home_export_round_trip_reconstructs_db_and_assets() {
    // ── Fixture ──────────────────────────────────────────────────
    let porch_dir = tempfile::tempdir().expect("porch tmpdir");
    let porch = Arc::new(Porch::open(porch_dir.path()).expect("open porch"));

    // Plant some known data. Two channels + a few messages so the row
    // count assertion has signal.
    porch
        .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Alice", "hello")
        .expect("post 1");
    porch
        .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Bob", "general kenobi")
        .expect("post 2");
    porch
        .insert_channel(
            "topic-room",
            "Topic Room",
            ChannelKind::Inner,
            AclMode::Allowlist,
        )
        .expect("insert ch");
    porch
        .post_message("topic-room", "12D3Carol", "yo")
        .expect("post 3");

    // Plant a known file under porch_assets/. The home-export module
    // reuses the existing porch_assets/ directory (the rename to
    // home_assets/ happens INSIDE the tar payload). Doing it this way
    // means we don't have to re-home the on-disk directory in this PR.
    let assets_root = porch_dir.path().join("porch_assets");
    fs::create_dir_all(&assets_root).expect("mkdir assets");
    let asset_payload = b"PNG\x00\x01\x02\x03this is a fake asset" as &[u8];
    fs::write(assets_root.join("avatar-1.bin"), asset_payload).expect("write asset");

    // Plant a known file under porch_backups/. Likewise reused.
    let backups_root = porch_dir.path().join("porch_backups");
    fs::create_dir_all(&backups_root).expect("mkdir backups");
    let backup_payload = b"this is a fake received backup blob (opaque)";
    fs::write(backups_root.join("inbound-from-peer.bin"), backup_payload)
        .expect("write backup");

    // ── Export ───────────────────────────────────────────────────
    let app_data = tempfile::tempdir().expect("app_data tmp");
    let passphrase = "correct horse battery staple — Argon2id, please";
    let manifest = build_home_export_package(
        &porch,
        passphrase,
        "12D3KooWTrustedOutsideInstance",
        "12D3KooWThisInstance",
        app_data.path(),
    )
    .expect("build export");

    // Manifest plumbing — surface-level invariants.
    assert!(
        manifest.package_path.ends_with(".concord-pkg"),
        "package path should end with .concord-pkg, got: {}",
        manifest.package_path
    );
    let pkg_bytes = fs::read(&manifest.package_path).expect("read package");
    assert_eq!(pkg_bytes.len() as u64, manifest.size_bytes);
    assert_eq!(manifest.target_peer_id, "12D3KooWTrustedOutsideInstance");
    assert_eq!(manifest.sha256.len(), 64, "SHA-256 hex is 64 chars");

    // ── Decrypt + untar ──────────────────────────────────────────
    let plaintext = decrypt_home_export_package(&pkg_bytes, passphrase)
        .expect("decrypt round trip");

    // The meta lives at meta.json, FIRST entry per the spec.
    let entries = collect_tar_entries(&plaintext);
    assert!(!entries.is_empty(), "tar has entries");
    assert_eq!(
        entries[0].0, "meta.json",
        "meta.json MUST be the first entry — frozen format"
    );

    // Meta sanity.
    let meta = read_meta_from_tar(&plaintext).expect("read meta");
    assert_eq!(meta.package_format_version, PACKAGE_FORMAT_VERSION);
    assert_eq!(meta.subject, SUBJECT_HOME);
    assert_eq!(meta.exporter_peer_id, "12D3KooWThisInstance");
    assert_eq!(meta.target_peer_id, "12D3KooWTrustedOutsideInstance");

    // Locate the home.sqlite + home_assets/avatar-1.bin entries.
    let mut sqlite_bytes: Option<Vec<u8>> = None;
    let mut asset_in_tar: Option<Vec<u8>> = None;
    let mut backup_in_tar: Option<Vec<u8>> = None;
    for (path, body) in &entries {
        match path.as_str() {
            "home.sqlite" => sqlite_bytes = Some(body.clone()),
            "home_assets/avatar-1.bin" => asset_in_tar = Some(body.clone()),
            "home_backups/inbound-from-peer.bin" => backup_in_tar = Some(body.clone()),
            _ => {}
        }
    }
    let sqlite_bytes = sqlite_bytes.expect("tar must contain home.sqlite");
    let asset_in_tar = asset_in_tar.expect("tar must contain home_assets/avatar-1.bin");
    let backup_in_tar = backup_in_tar.expect(
        "tar must contain home_backups/inbound-from-peer.bin",
    );

    // Asset round-trips byte-for-byte.
    assert_eq!(
        asset_in_tar.as_slice(),
        asset_payload,
        "home_assets/avatar-1.bin bytes must match the original",
    );
    // Backup file round-trips byte-for-byte.
    assert_eq!(
        backup_in_tar.as_slice(),
        backup_payload,
        "home_backups/inbound-from-peer.bin bytes must match",
    );

    // ── Reconstruct: write home.sqlite to a fresh dir + reopen. ──
    let restore_dir = tempfile::tempdir().expect("restore dir");
    let restored_path = restore_dir.path().join("porch.sqlite");
    fs::write(&restored_path, &sqlite_bytes).expect("write restored sqlite");
    let restored = Porch::open(restore_dir.path()).expect("reopen restored porch");

    // Row counts match — default porch channel + topic-room must both
    // be present, message counts on each preserved.
    let channels = restored.list_channels().expect("list channels restored");
    let chan_ids: Vec<&str> = channels.iter().map(|c| c.id.as_str()).collect();
    assert!(
        chan_ids.contains(&DEFAULT_PORCH_CHANNEL_ID),
        "restored porch must contain the default channel; got: {chan_ids:?}"
    );
    assert!(
        chan_ids.contains(&"topic-room"),
        "restored porch must contain the topic-room channel; got: {chan_ids:?}"
    );

    let porch_msgs = restored
        .get_messages(DEFAULT_PORCH_CHANNEL_ID, None, 100)
        .expect("get porch msgs");
    let porch_bodies: Vec<&str> = porch_msgs.iter().map(|m| m.body.as_str()).collect();
    assert_eq!(
        porch_bodies.len(),
        2,
        "default porch channel should have 2 restored messages; got: {porch_bodies:?}"
    );
    assert!(
        porch_bodies.contains(&"hello"),
        "restored porch channel must contain the 'hello' message: {porch_bodies:?}"
    );
    assert!(
        porch_bodies.contains(&"general kenobi"),
        "restored porch channel must contain the second message: {porch_bodies:?}"
    );

    let topic_msgs = restored
        .get_messages("topic-room", None, 100)
        .expect("get topic msgs");
    let topic_bodies: Vec<&str> = topic_msgs.iter().map(|m| m.body.as_str()).collect();
    assert_eq!(
        topic_bodies,
        vec!["yo"],
        "restored topic-room must contain its single message"
    );
}

/// (Spec) Wrong passphrase must reject with a typed auth-tag error.
#[test]
fn home_export_wrong_passphrase_rejects_with_auth_error() {
    let porch_dir = tempfile::tempdir().expect("porch tmpdir");
    let porch = Arc::new(Porch::open(porch_dir.path()).expect("open porch"));
    porch
        .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Author", "secret payload")
        .expect("post");
    let app_data = tempfile::tempdir().expect("app_data tmp");

    let manifest = build_home_export_package(
        &porch,
        "the-real-passphrase",
        "12D3KooWTarget",
        "12D3KooWExporter",
        app_data.path(),
    )
    .expect("build export");
    let blob = fs::read(&manifest.package_path).expect("read blob");

    let err = decrypt_home_export_package(&blob, "WRONG-passphrase")
        .expect_err("wrong passphrase MUST fail");
    match err {
        PorchError::InvalidInput(msg) => {
            assert!(
                msg.contains("AEAD decrypt failed"),
                "error must reference AEAD/auth failure; got: {msg}"
            );
        }
        other => panic!(
            "expected InvalidInput from auth-tag failure, got: {other:?}"
        ),
    }
}
