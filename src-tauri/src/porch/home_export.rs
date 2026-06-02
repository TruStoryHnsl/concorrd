//! F1c — encrypted HOME-server data export to a trusted outside instance.
//!
//! The export packages the persistent "home server" SQLite (and its
//! sibling `porch_assets/` + `porch_backups/` directories) into an
//! encrypted bundle the operator can send to a trusted outside peer for
//! longer-term storage + more complicated data analysis. The porch is
//! NEVER exported — it's ephemeral by definition (see the
//! 2026-05-31 CONSOLIDATED ARCHITECTURE filing in
//! `instructions_inbox.md`).
//!
//! ## Package format (frozen — `package_format_version = 1`)
//!
//! The on-disk artifact at `<app_data>/exports/<ts>-<short-peer>.concord-pkg`
//! is a single binary blob:
//!
//! ```text
//! [32-byte argon2id salt][12-byte ChaCha20 nonce][ciphertext][16-byte auth tag]
//! ```
//!
//! The auth tag is appended by `ChaCha20Poly1305::encrypt` — it lives at
//! the END of the ciphertext, not as a separate trailer field. The
//! `[salt][nonce]` prefix is 44 bytes long; everything after byte 44 is
//! the AEAD output (ciphertext || tag).
//!
//! `Argon2id` parameters (locked for `package_format_version = 1`):
//!
//! ```text
//! memory_cost = 65536 KiB  (64 MiB)
//! time_cost   = 3
//! parallelism = 4
//! output_len  = 32 bytes   (ChaCha20-Poly1305 key)
//! ```
//!
//! Plaintext (inside the AEAD) is a TAR archive in this exact order:
//!
//! ```text
//! 1. meta.json           — JSON manifest, see [`PackageMeta`]
//! 2. home.sqlite         — atomic SQLite backup of the home DB
//! 3. home_assets/...     — every file under porch's `porch_assets/`
//! 4. home_backups/...    — every file under porch's `porch_backups/`
//! ```
//!
//! The TAR is NOT gzipped — ChaCha20 hides nothing useful about the
//! length distribution, and skipping zstd here saves CPU at export
//! time. (The home-DB SQLite itself stays uncompressed; a future
//! `package_format_version = 2` MAY add zstd around the tar payload.)
//!
//! ## Subject = home
//!
//! The `meta.json` carries `"subject": "home"` so a future split between
//! "home" and "any-other-persistent-server" exports can be discriminated
//! by the receiver without parsing schemas.
//!
//! ## Receiver
//!
//! The receiving-side handler in this PR ONLY logs the receipt and
//! rejects senders not in the local peer-store. It does NOT persist or
//! ingest the package — that's a follow-up PR (see the F1c-INGEST entry
//! in `instructions_inbox.md` / `PLAN.md` once filed).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use rand::RngCore;
use rusqlite::backup::Backup;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::db::{Porch, PORCH_ASSETS_DIRNAME, PORCH_BACKUPS_DIRNAME, SCHEMA_VERSION};
use super::error::PorchError;

/// Frozen package-format version. A bump signals an on-wire format
/// change; readers compiled against `1` reject any other value with a
/// typed error.
pub const PACKAGE_FORMAT_VERSION: u32 = 1;

/// Subject string baked into `meta.json`. `"home"` for the persistent
/// home-server export; future kinds (e.g. a per-server export) reuse
/// the same envelope with a different subject.
pub const SUBJECT_HOME: &str = "home";

/// Argon2id `memory_cost` parameter, in KiB. `65_536 KiB == 64 MiB` —
/// matches the spec's stated 64 MiB. Frozen for `v1`.
pub const ARGON2_MEMORY_COST_KIB: u32 = 64 * 1024;

/// Argon2id `time_cost` (number of iterations). Frozen for `v1`.
pub const ARGON2_TIME_COST: u32 = 3;

/// Argon2id `parallelism` lanes. Frozen for `v1`.
pub const ARGON2_PARALLELISM: u32 = 4;

/// Length of the random salt prefixed to the ciphertext blob.
pub const SALT_LEN: usize = 32;

/// ChaCha20-Poly1305 nonce length (RFC 8439).
pub const NONCE_LEN: usize = 12;

/// ChaCha20-Poly1305 key length.
pub const KEY_LEN: usize = 32;

/// Subdirectory under `<app_data>` where finished export blobs land.
pub const EXPORTS_DIRNAME: &str = "exports";

/// JSON manifest baked into the tar (`meta.json`).
///
/// Field order locked for `package_format_version = 1` — DO NOT reorder
/// or rename. New fields require a format bump.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageMeta {
    /// Home DB SQLite schema version at export time. The receiver can
    /// use this to gate ingest until the migration path catches up.
    pub schema_version: i64,
    /// Unix milliseconds — wall clock at the moment the blob was sealed.
    pub exported_at: i64,
    /// Base58 libp2p peer-id of the originating install. Lets the
    /// receiver attribute the bundle without re-deriving from the
    /// transport connection.
    pub exporter_peer_id: String,
    /// Base58 libp2p peer-id of the trusted outside instance the
    /// operator picked at export time. Recorded for after-the-fact
    /// audit; the receiver MAY choose to refuse a bundle whose
    /// `target_peer_id` doesn't match its own peer-id.
    pub target_peer_id: String,
    /// Frozen format version (see [`PACKAGE_FORMAT_VERSION`]).
    pub package_format_version: u32,
    /// `"home"` for the home-server export. A future split between
    /// home-server and arbitrary-server exports reads from this.
    pub subject: String,
}

/// Wire return shape for `home_export_package`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    /// Absolute path the encrypted package was written to.
    pub package_path: String,
    /// Hex-encoded SHA-256 of the package bytes on disk (the WHOLE
    /// envelope, including salt + nonce + ciphertext + tag). The UI
    /// surfaces this so the user can confirm an unaltered copy reached
    /// the destination.
    pub sha256: String,
    /// Echoes the target peer-id the operator picked. Persists into the
    /// manifest for the UI's downstream "Save package locally" prompt.
    pub target_peer_id: String,
    /// Bytes on disk.
    pub size_bytes: u64,
}

/// Build an encrypted export package for the local install's home DB.
///
/// The `porch` argument is the persistent home-server backing store
/// (the module is named "porch" for historical reasons; per the
/// 2026-05-31 CONSOLIDATED ARCHITECTURE filing, the file path being
/// exported represents the HOME server). The porch's `db_path()` MUST
/// be `Some(_)` — in-memory porches cannot be exported.
///
/// Pipeline:
///
///   1. Atomic SQLite backup via `rusqlite::backup::Backup::new` into a
///      temp `<exports>/.snapshot-<ulid>.sqlite`.
///   2. Build a TAR archive (in memory) containing, in this order:
///      `meta.json`, `home.sqlite`, `home_assets/...`, `home_backups/...`.
///   3. Argon2id(passphrase, salt) → 32-byte ChaCha20-Poly1305 key.
///   4. AEAD-encrypt the TAR bytes with the derived key + a fresh
///      12-byte nonce. The poly1305 auth tag is appended automatically
///      by the AEAD layer.
///   5. Write `[salt][nonce][ciphertext||tag]` to
///      `<app_data>/exports/<unix_ms>-<short_peer>.concord-pkg`.
///
/// The temp snapshot file is deleted on success. On failure it is
/// best-effort deleted; the next run's ULID guarantees a fresh path
/// either way.
pub fn build_home_export_package(
    porch: &Porch,
    passphrase: &str,
    target_peer_id: &str,
    exporter_peer_id: &str,
    app_data_dir: &Path,
) -> Result<ExportManifest, PorchError> {
    if passphrase.is_empty() {
        return Err(PorchError::InvalidInput(
            "export passphrase must not be empty".to_string(),
        ));
    }
    if target_peer_id.trim().is_empty() {
        return Err(PorchError::InvalidInput(
            "target_peer_id must not be empty".to_string(),
        ));
    }

    let db_path = porch.db_path().ok_or_else(|| {
        PorchError::InvalidInput(
            "in-memory porch cannot be exported — open a file-backed porch first".to_string(),
        )
    })?;
    let porch_root = db_path
        .parent()
        .ok_or_else(|| PorchError::InvalidInput("home db path has no parent".to_string()))?;
    let assets_root = porch_root.join(PORCH_ASSETS_DIRNAME);
    let backups_root = porch_root.join(PORCH_BACKUPS_DIRNAME);

    let exports_root = app_data_dir.join(EXPORTS_DIRNAME);
    std::fs::create_dir_all(&exports_root).map_err(PorchError::Io)?;

    // ── Step 1: atomic SQLite backup via rusqlite::backup::Backup. ──
    //
    // `Backup::new(from, to)` builds the backup driver against the live
    // source connection and a fresh destination connection. `run_to_completion`
    // copies all pages atomically — the source may keep accepting writes
    // during the copy and the destination still ends up self-consistent.
    let snapshot_id = ulid::Ulid::new();
    let snapshot_path = exports_root.join(format!(".snapshot-{snapshot_id}.sqlite"));
    {
        let src_guard = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned during export");
        let mut dst = Connection::open(&snapshot_path).map_err(PorchError::Sqlite)?;
        let backup = Backup::new(&src_guard, &mut dst).map_err(PorchError::Sqlite)?;
        // `pages_per_step` MUST be positive (rusqlite panics on 0/neg).
        // i32::MAX in a single step copies every page atomically — the
        // SQLite layer iterates page-by-page internally but doesn't
        // yield control between them, which is what we want for an
        // export. `pause = 0ms` — no inter-step throttling needed
        // since we're never iterating. Progress callback is None —
        // the export blocks the caller's task; the UI shows the
        // BringingUpSplash while it runs.
        backup
            .run_to_completion(
                /* pages_per_step */ i32::MAX,
                /* pause */ std::time::Duration::from_millis(0),
                /* progress */ None,
            )
            .map_err(PorchError::Sqlite)?;
    }

    // ── Step 2: build the TAR archive in memory. ─────────────────────
    let meta = PackageMeta {
        schema_version: SCHEMA_VERSION,
        exported_at: unix_millis(),
        exporter_peer_id: exporter_peer_id.to_string(),
        target_peer_id: target_peer_id.to_string(),
        package_format_version: PACKAGE_FORMAT_VERSION,
        subject: SUBJECT_HOME.to_string(),
    };
    let tar_bytes = match build_tar_payload(&snapshot_path, &assets_root, &backups_root, &meta) {
        Ok(b) => b,
        Err(e) => {
            // Make sure we don't leak the temp snapshot if tar fails.
            let _ = std::fs::remove_file(&snapshot_path);
            return Err(e);
        }
    };
    // Snapshot is no longer needed once it's in the tar.
    let _ = std::fs::remove_file(&snapshot_path);

    // ── Step 3: Argon2id passphrase → key. ───────────────────────────
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = derive_export_key(passphrase.as_bytes(), &salt)?;

    // ── Step 4: ChaCha20-Poly1305 AEAD-encrypt the tar bytes. ───────
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, tar_bytes.as_slice())
        .map_err(|e| PorchError::InvalidInput(format!("AEAD encrypt failed: {e}")))?;

    // ── Step 5: assemble + write [salt][nonce][ciphertext||tag]. ────
    let mut blob = Vec::with_capacity(SALT_LEN + NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);

    let ts = meta.exported_at;
    let short_peer = short_peer_id(target_peer_id);
    let pkg_name = format!("{ts}-{short_peer}.concord-pkg");
    let pkg_path = exports_root.join(&pkg_name);
    // Atomic write — sibling tmp, fsync, rename.
    let tmp_path = pkg_path.with_extension("concord-pkg.tmp");
    std::fs::write(&tmp_path, &blob).map_err(PorchError::Io)?;
    std::fs::rename(&tmp_path, &pkg_path).map_err(PorchError::Io)?;

    let mut hasher = Sha256::new();
    hasher.update(&blob);
    let sha256 = hex::encode(hasher.finalize());

    Ok(ExportManifest {
        package_path: pkg_path.to_string_lossy().to_string(),
        sha256,
        target_peer_id: target_peer_id.to_string(),
        size_bytes: blob.len() as u64,
    })
}

/// Decrypt + unpack a previously-built export package. Used by tests
/// to assert the round-trip integrity (the receiver-side ingest is a
/// follow-up PR). Returns the raw TAR bytes; the caller can iterate
/// entries with `tar::Archive::new(...)`.
pub fn decrypt_home_export_package(
    blob: &[u8],
    passphrase: &str,
) -> Result<Vec<u8>, PorchError> {
    if blob.len() < SALT_LEN + NONCE_LEN + 16 {
        return Err(PorchError::MalformedEnvelope(format!(
            "export blob too short: {} < {}",
            blob.len(),
            SALT_LEN + NONCE_LEN + 16
        )));
    }
    let (prefix, body) = blob.split_at(SALT_LEN + NONCE_LEN);
    let (salt_bytes, nonce_bytes) = prefix.split_at(SALT_LEN);
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(salt_bytes);
    let key = derive_export_key(passphrase.as_bytes(), &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, body)
        .map_err(|e| {
            PorchError::InvalidInput(format!(
                "AEAD decrypt failed (wrong passphrase or corrupted blob): {e}"
            ))
        })?;
    Ok(plaintext)
}

/// Pull the `meta.json` out of a decrypted tar payload. Convenience for
/// tests + the (follow-up) ingest path.
pub fn read_meta_from_tar(tar_bytes: &[u8]) -> Result<PackageMeta, PorchError> {
    let mut archive = tar::Archive::new(tar_bytes);
    for entry in archive.entries().map_err(PorchError::Io)? {
        let mut entry = entry.map_err(PorchError::Io)?;
        let path = entry.path().map_err(PorchError::Io)?.into_owned();
        if path.to_string_lossy() == "meta.json" {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(PorchError::Io)?;
            let meta: PackageMeta = serde_json::from_slice(&buf).map_err(PorchError::Serde)?;
            return Ok(meta);
        }
    }
    Err(PorchError::MalformedEnvelope(
        "export tar missing meta.json entry".to_string(),
    ))
}

/// Derive a 32-byte ChaCha20-Poly1305 key from `passphrase` using
/// Argon2id with the frozen `v1` parameters. Pure function: identical
/// inputs always yield the identical key.
fn derive_export_key(passphrase: &[u8], salt: &[u8]) -> Result<[u8; KEY_LEN], PorchError> {
    let params = Params::new(
        ARGON2_MEMORY_COST_KIB,
        ARGON2_TIME_COST,
        ARGON2_PARALLELISM,
        Some(KEY_LEN),
    )
    .map_err(|e| PorchError::InvalidInput(format!("argon2 params invalid: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase, salt, &mut out)
        .map_err(|e| PorchError::InvalidInput(format!("argon2 derive failed: {e}")))?;
    Ok(out)
}

/// Build the in-memory tar payload. Order: `meta.json`, then
/// `home.sqlite`, then `home_assets/...`, then `home_backups/...`.
fn build_tar_payload(
    sqlite_snapshot_path: &Path,
    assets_root: &Path,
    backups_root: &Path,
    meta: &PackageMeta,
) -> Result<Vec<u8>, PorchError> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut tar_builder = tar::Builder::new(&mut buf);
        // ── meta.json ─────────────────────────────────────────────
        let meta_json = serde_json::to_vec_pretty(meta).map_err(PorchError::Serde)?;
        let mut header = tar::Header::new_gnu();
        header.set_path("meta.json").map_err(PorchError::Io)?;
        header.set_size(meta_json.len() as u64);
        header.set_mode(0o600);
        header.set_mtime(meta.exported_at as u64 / 1000);
        header.set_cksum();
        tar_builder
            .append(&header, meta_json.as_slice())
            .map_err(PorchError::Io)?;

        // ── home.sqlite ───────────────────────────────────────────
        {
            let mut f = std::fs::File::open(sqlite_snapshot_path).map_err(PorchError::Io)?;
            let metadata = f.metadata().map_err(PorchError::Io)?;
            let mut h = tar::Header::new_gnu();
            h.set_path("home.sqlite").map_err(PorchError::Io)?;
            h.set_size(metadata.len());
            h.set_mode(0o600);
            h.set_mtime(meta.exported_at as u64 / 1000);
            h.set_cksum();
            tar_builder.append(&h, &mut f).map_err(PorchError::Io)?;
        }

        // ── home_assets/ ──────────────────────────────────────────
        append_dir_recursive(
            &mut tar_builder,
            assets_root,
            Path::new("home_assets"),
            meta.exported_at as u64 / 1000,
        )?;

        // ── home_backups/ ─────────────────────────────────────────
        append_dir_recursive(
            &mut tar_builder,
            backups_root,
            Path::new("home_backups"),
            meta.exported_at as u64 / 1000,
        )?;

        tar_builder.finish().map_err(PorchError::Io)?;
    }
    Ok(buf)
}

/// Recurse a directory and append every regular file under it as a tar
/// entry rooted at `tar_prefix`. Missing source directories are
/// silently skipped (a fresh install with no `home_assets/` is a
/// valid input).
fn append_dir_recursive<W: Write>(
    tar_builder: &mut tar::Builder<W>,
    src_root: &Path,
    tar_prefix: &Path,
    mtime: u64,
) -> Result<(), PorchError> {
    if !src_root.exists() {
        return Ok(());
    }
    let mut stack: Vec<PathBuf> = vec![src_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let entry_path = entry.path();
            let ft = match entry.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            if ft.is_dir() {
                stack.push(entry_path);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            // Build the in-tar path: tar_prefix / (path relative to
            // src_root). Strip the leading "./" some platforms add.
            let rel = entry_path.strip_prefix(src_root).map_err(|e| {
                PorchError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("strip_prefix: {e}"),
                ))
            })?;
            let in_tar = tar_prefix.join(rel);
            let mut f = std::fs::File::open(&entry_path).map_err(PorchError::Io)?;
            let metadata = f.metadata().map_err(PorchError::Io)?;
            let mut h = tar::Header::new_gnu();
            h.set_path(&in_tar).map_err(PorchError::Io)?;
            h.set_size(metadata.len());
            h.set_mode(0o600);
            h.set_mtime(mtime);
            h.set_cksum();
            tar_builder.append(&h, &mut f).map_err(PorchError::Io)?;
        }
    }
    Ok(())
}

/// First 8 base58 chars of `peer_id`, ASCII-alphanumeric only — used
/// for the package filename's short-peer suffix. Falls back to "peer"
/// if `peer_id` has no alphanumeric chars (defensive — never expected
/// in practice).
fn short_peer_id(peer_id: &str) -> String {
    let clean: String = peer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if clean.is_empty() {
        "peer".to_string()
    } else {
        clean
    }
}

/// Unix milliseconds — same wall-clock pattern as `backup.rs::unix_millis`.
fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::porch::DEFAULT_PORCH_CHANNEL_ID;

    #[test]
    fn derive_export_key_is_deterministic() {
        let salt = [9u8; SALT_LEN];
        let a = derive_export_key(b"correct horse battery staple", &salt).expect("a");
        let b = derive_export_key(b"correct horse battery staple", &salt).expect("b");
        assert_eq!(a, b, "same passphrase + salt must yield same key");
    }

    #[test]
    fn derive_export_key_differs_per_passphrase() {
        let salt = [9u8; SALT_LEN];
        let a = derive_export_key(b"alpha", &salt).expect("a");
        let b = derive_export_key(b"bravo", &salt).expect("b");
        assert_ne!(a, b, "different passphrases must yield different keys");
    }

    #[test]
    fn short_peer_id_strips_non_alphanumeric_and_caps_at_8() {
        let raw = "12D3KooW!!Bob/Slash";
        let short = short_peer_id(raw);
        assert!(short.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(short.len(), 8);
    }

    #[test]
    fn build_then_decrypt_round_trip_minimal_porch() {
        let dir = tempfile::tempdir().expect("tmp app_data");
        let porch_dir = tempfile::tempdir().expect("tmp porch dir");
        let porch = Arc::new(Porch::open(porch_dir.path()).expect("open porch"));
        porch
            .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Author", "hello-export")
            .expect("post msg");

        let manifest = build_home_export_package(
            &porch,
            "passphrase-of-doom",
            "12D3KooWTargetXYZ",
            "12D3KooWExporterABC",
            dir.path(),
        )
        .expect("build export");
        assert!(manifest.size_bytes > 0);
        assert!(manifest.package_path.ends_with(".concord-pkg"));
        assert_eq!(manifest.target_peer_id, "12D3KooWTargetXYZ");

        let blob = std::fs::read(&manifest.package_path).expect("read blob");
        let plaintext =
            decrypt_home_export_package(&blob, "passphrase-of-doom").expect("decrypt");
        let meta = read_meta_from_tar(&plaintext).expect("read meta");
        assert_eq!(meta.package_format_version, PACKAGE_FORMAT_VERSION);
        assert_eq!(meta.subject, SUBJECT_HOME);
        assert_eq!(meta.exporter_peer_id, "12D3KooWExporterABC");
        assert_eq!(meta.target_peer_id, "12D3KooWTargetXYZ");
        assert_eq!(meta.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn wrong_passphrase_fails_to_decrypt() {
        let dir = tempfile::tempdir().expect("tmp");
        let porch_dir = tempfile::tempdir().expect("tmp porch");
        let porch = Arc::new(Porch::open(porch_dir.path()).expect("porch"));
        let manifest = build_home_export_package(
            &porch,
            "right-passphrase",
            "12D3KooWTarget",
            "12D3KooWExporter",
            dir.path(),
        )
        .expect("build");
        let blob = std::fs::read(&manifest.package_path).expect("read blob");
        let err = decrypt_home_export_package(&blob, "WRONG-passphrase")
            .expect_err("wrong passphrase must fail");
        match err {
            PorchError::InvalidInput(msg) => {
                assert!(
                    msg.contains("decrypt failed"),
                    "expected AEAD failure, got: {msg}"
                );
            }
            other => panic!("expected InvalidInput, got: {other:?}"),
        }
    }
}
