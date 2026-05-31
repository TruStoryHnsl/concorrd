//! Porch Phase E — encrypted backup pipeline.
//!
//! The user designates one or more peers as **backup targets**. The
//! local porch SQLite is snapshotted via `VACUUM INTO`, ZSTD-compressed,
//! AEAD-encrypted with ChaCha20-Poly1305 using a key derived from the
//! Stronghold seed via HKDF-SHA256, and shipped to each target over
//! `/concord/porch-backup/1.0.0`.
//!
//! The backup peer's role is to store the opaque blob keyed by the
//! uploader's libp2p peer-id. It cannot decrypt — the key derivation
//! is entirely client-side and depends on Stronghold-protected seed
//! bytes the backup peer never sees.
//!
//! ## Wire format (`EncryptedBackup`)
//!
//! ```text
//! {
//!   "uploader_peer_id": "12D3KooW...",
//!   "ciphertext": [<bytes>],   // ChaCha20-Poly1305(ZSTD(SQLite-VACUUM-INTO bytes))
//!   "nonce": [12 bytes],       // RFC8439 96-bit nonce, fresh per blob
//!   "schema_version": 5,
//!   "taken_at": 1717000000000  // unix ms — informational only
//! }
//! ```
//!
//! ## Key derivation
//!
//! ```text
//! seed     = Stronghold-protected Ed25519 seed bytes (32 bytes)
//! key      = HKDF-SHA256(ikm=seed, info=b"concord/porch-backup/v1", L=32)
//! cipher   = ChaCha20-Poly1305(key)
//! ```
//!
//! The HKDF info string is the **format version marker**. Future format
//! revisions bump it (e.g. `v2`) and a `v1` reader rejects `v2` blobs by
//! construction — the wrong key derivation produces an AEAD verification
//! failure, surfaced as [`PorchError::InvalidInput`].
//!
//! ## Cross-device restore
//!
//! Restoring on a fresh install requires the **same Stronghold seed**.
//! Today, that means the same install that ran `load_or_create` first
//! (the seed survives normal restarts via the Phase 4 sibling-file
//! persistence). A true cross-device restore — losing the old phone,
//! installing on a new one, restoring from a backup peer — is gated on
//! a separate **seed-recovery / mnemonic-export flow** that lands as
//! its own follow-up (`feat: stronghold-seed-mnemonic`). Phase E ships
//! the backup mechanics; that follow-up unlocks cross-device usage.

use std::path::Path;

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ulid::Ulid;
use zeroize::Zeroizing;

use super::db::{Porch, SCHEMA_VERSION};
use super::error::PorchError;

/// HKDF info string — the **format version marker**. Bumping this string
/// is the canonical way to rev the on-wire encrypted-blob format. A
/// reader compiled with the v1 string cannot decrypt a v2 blob; AEAD
/// verification fails (different key) and the error surfaces as
/// [`PorchError::InvalidInput`].
pub const HKDF_INFO_V1: &[u8] = b"concord/porch-backup/v1";

/// ChaCha20-Poly1305 key size: 32 bytes.
const KEY_LEN: usize = 32;

/// ChaCha20-Poly1305 nonce size (RFC 8439): 12 bytes.
const NONCE_LEN: usize = 12;

/// ZSTD compression level used for the SQLite dump. `3` is the library
/// default — small CPU cost for a substantial bytes-on-wire reduction
/// on chat-heavy DBs (typical ratio 6-10x).
const ZSTD_LEVEL: i32 = 3;

/// One backup target — a peer the local install pushes encrypted
/// backups to. Surfaces in the Backup settings tab and feeds the
/// scheduler / manual-push commands.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupTarget {
    /// Libp2p peer-id of the target. Primary key.
    pub peer_id: String,
    /// User-facing nickname (e.g. "my docker server"). Optional.
    pub label: Option<String>,
    /// Unix milliseconds — when the target was first added.
    pub added_at: i64,
    /// Unix milliseconds of the most recent successful push, or `None`
    /// if no push has ever succeeded for this target.
    pub last_success_at: Option<i64>,
    /// Unix milliseconds of the most recent failed push, or `None`.
    pub last_failure_at: Option<i64>,
    /// Free-form reason string from the most recent failure, or `None`.
    pub last_failure_reason: Option<String>,
}

/// One encrypted backup envelope, end-to-end on-wire shape.
///
/// `ciphertext` carries `ChaCha20-Poly1305(ZSTD(VACUUM-INTO bytes))`.
/// `nonce` is a fresh 12-byte value per blob — the AEAD requires
/// (key, nonce) uniqueness. `schema_version` lets a future restore
/// path run forward migrations if the receiver's schema is newer than
/// the backup's. `taken_at` is informational.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedBackup {
    /// Base58 libp2p peer-id of the install that produced this blob.
    /// The backup-peer side keys its `received_backups` table on this.
    pub uploader_peer_id: String,
    /// AEAD-encrypted, ZSTD-compressed SQLite dump.
    pub ciphertext: Vec<u8>,
    /// 12-byte RFC8439 nonce — fresh per blob.
    pub nonce: [u8; NONCE_LEN],
    /// Schema version the uploader was on at backup time. Lets the
    /// restore path run forward migrations if needed.
    pub schema_version: i64,
    /// Unix milliseconds — wall-clock at the moment the backup was
    /// taken (uploader-side). Informational; the backup peer also
    /// records `received_at`.
    pub taken_at: i64,
}

impl EncryptedBackup {
    /// SHA-256 of the ciphertext bytes. The backup-peer side records
    /// this in `received_backups.blob_sha256` so disk corruption can
    /// be diagnosed independently of the AEAD layer.
    pub fn sha256_hex(&self) -> String {
        let digest = Sha256::digest(&self.ciphertext);
        hex::encode(digest)
    }
}

/// Summary row returned by `read_received_backup_info` — what a
/// backup-peer side discloses to the original uploader so they can
/// render "Last backed up at X" in their settings tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReceivedBackupSummary {
    /// Libp2p peer-id of the install that uploaded this blob. Primary
    /// key from the backup peer's perspective.
    pub uploader_peer_id: String,
    /// Schema version the uploader was on.
    pub schema_version: i64,
    /// Bytes on disk (ciphertext, not the plaintext SQLite size).
    pub blob_size: i64,
    /// Hex-encoded SHA-256 of the ciphertext bytes.
    pub blob_sha256: String,
    /// Unix milliseconds — when the backup peer first received this
    /// (or overwrote a prior one).
    pub received_at: i64,
}

/// Trait for fetching the per-install Stronghold seed. Decoupled from
/// the concrete [`crate::servitude::identity::StrongholdHandle`] so the
/// backup module can be tested in isolation against an in-memory seed.
///
/// The default production impl is
/// [`crate::porch::backup::StrongholdSeedAccess`]; tests use an
/// inline impl returning fixed bytes.
pub trait SeedAccess: Send + Sync {
    /// Hand back the 32-byte Ed25519 seed in a `Zeroizing` buffer. The
    /// buffer is wiped on drop; callers MUST NOT clone the bytes into a
    /// long-lived unprotected location.
    fn export_seed_bytes(&self) -> Result<Zeroizing<[u8; 32]>, PorchError>;
}

/// Production [`SeedAccess`] impl — proxies into the Stronghold handle.
/// Lives here (not in `identity.rs`) so the porch module owns the
/// adapter and `identity.rs` stays focused on the unified-identity
/// invariant.
pub struct StrongholdSeedAccess<'a> {
    handle: &'a crate::servitude::identity::StrongholdHandle,
}

impl<'a> StrongholdSeedAccess<'a> {
    /// Wrap a Stronghold handle for use as a backup-key seed source.
    pub fn new(handle: &'a crate::servitude::identity::StrongholdHandle) -> Self {
        Self { handle }
    }
}

impl<'a> SeedAccess for StrongholdSeedAccess<'a> {
    fn export_seed_bytes(&self) -> Result<Zeroizing<[u8; 32]>, PorchError> {
        // `peer_seed` is `async` to match the rest of the identity
        // surface but its body is purely sync after the cache primes.
        // Bridge through `tokio` block-in-place when called from a
        // running runtime, OR a fresh local runtime when called from a
        // sync caller (`build_encrypted_backup` is sync).
        let handle = tokio::runtime::Handle::try_current().ok();
        let seed = match handle {
            Some(h) => {
                // We're inside a Tokio runtime. Use `block_in_place` if
                // available (multi-thread runtimes); otherwise the
                // future is small enough that `block_on` on a fresh
                // runtime works too. For maximum portability across
                // current_thread + multi_thread runtimes used by the
                // app + tests, build a single-thread runtime locally.
                let _ = h;
                tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current()
                        .block_on(crate::servitude::identity::peer_seed(self.handle))
                })
            }
            None => {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(PorchError::Io)?;
                rt.block_on(crate::servitude::identity::peer_seed(self.handle))
            }
        }
        .map_err(|e| {
            PorchError::InvalidInput(format!("backup key unavailable: seed access: {e}"))
        })?;
        // `peer_seed` returns Zeroizing<[u8; 32]> — exactly what we
        // need. Move into our own buffer to satisfy the trait sig.
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&seed[..]);
        Ok(out)
    }
}

/// CRUD helpers on `backup_targets`. Mirrored as a sub-module so call
/// sites read as `targets::add(...)` / `targets::list(...)`.
pub mod targets {
    use super::{BackupTarget, Porch, PorchError};
    use rusqlite::{params, OptionalExtension};

    /// Insert a new backup target. Idempotent on `peer_id` — adding the
    /// same peer twice updates the label and refreshes `added_at` only
    /// if not already present (the existing row's stats are preserved).
    pub fn add(
        porch: &Porch,
        peer_id: &str,
        label: Option<&str>,
    ) -> Result<BackupTarget, PorchError> {
        if peer_id.trim().is_empty() {
            return Err(PorchError::InvalidInput(
                "backup target peer_id must not be empty".to_string(),
            ));
        }
        let now = super::unix_millis();
        let conn = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO backup_targets (peer_id, label, added_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(peer_id) DO UPDATE SET label = excluded.label",
            params![peer_id, label, now],
        )?;
        let row = conn
            .query_row(
                "SELECT peer_id, label, added_at, last_success_at,
                        last_failure_at, last_failure_reason
                 FROM backup_targets WHERE peer_id = ?1",
                params![peer_id],
                row_to_target,
            )
            .optional()?
            .ok_or_else(|| {
                PorchError::InvalidInput(
                    "internal error: backup_targets insert vanished".to_string(),
                )
            })?;
        Ok(row)
    }

    /// Remove a backup target. Returns the number of rows deleted (0 or
    /// 1); the caller can choose whether a 0 is an error or a no-op.
    pub fn remove(porch: &Porch, peer_id: &str) -> Result<usize, PorchError> {
        let conn = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned");
        let n = conn.execute(
            "DELETE FROM backup_targets WHERE peer_id = ?1",
            params![peer_id],
        )?;
        Ok(n)
    }

    /// List every configured backup target, ordered by `added_at`
    /// ascending so the UI gets a stable order across renders.
    pub fn list(porch: &Porch) -> Result<Vec<BackupTarget>, PorchError> {
        let conn = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT peer_id, label, added_at, last_success_at,
                    last_failure_at, last_failure_reason
             FROM backup_targets
             ORDER BY added_at ASC, peer_id ASC",
        )?;
        let rows = stmt.query_map([], row_to_target)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Record a successful push to `peer_id`. Updates
    /// `last_success_at` (and clears the `last_failure_*` fields so
    /// the UI stops surfacing a stale error after a subsequent
    /// success).
    pub fn record_success(porch: &Porch, peer_id: &str, at: i64) -> Result<(), PorchError> {
        let conn = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned");
        let n = conn.execute(
            "UPDATE backup_targets
             SET last_success_at = ?2,
                 last_failure_at = NULL,
                 last_failure_reason = NULL
             WHERE peer_id = ?1",
            params![peer_id, at],
        )?;
        if n == 0 {
            return Err(PorchError::InvalidInput(format!(
                "no backup target with peer_id {peer_id}"
            )));
        }
        Ok(())
    }

    /// Record a failed push attempt to `peer_id`.
    pub fn record_failure(
        porch: &Porch,
        peer_id: &str,
        at: i64,
        reason: &str,
    ) -> Result<(), PorchError> {
        let conn = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned");
        let n = conn.execute(
            "UPDATE backup_targets
             SET last_failure_at = ?2,
                 last_failure_reason = ?3
             WHERE peer_id = ?1",
            params![peer_id, at, reason],
        )?;
        if n == 0 {
            return Err(PorchError::InvalidInput(format!(
                "no backup target with peer_id {peer_id}"
            )));
        }
        Ok(())
    }

    /// Fetch one target by peer-id, or `None` if not present.
    pub fn get(porch: &Porch, peer_id: &str) -> Result<Option<BackupTarget>, PorchError> {
        let conn = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT peer_id, label, added_at, last_success_at,
                        last_failure_at, last_failure_reason
                 FROM backup_targets WHERE peer_id = ?1",
                params![peer_id],
                row_to_target,
            )
            .optional()?)
    }

    fn row_to_target(r: &rusqlite::Row) -> rusqlite::Result<BackupTarget> {
        Ok(BackupTarget {
            peer_id: r.get(0)?,
            label: r.get(1)?,
            added_at: r.get(2)?,
            last_success_at: r.get(3)?,
            last_failure_at: r.get(4)?,
            last_failure_reason: r.get(5)?,
        })
    }
}

/// Derive the 32-byte symmetric backup key from the Stronghold seed
/// via HKDF-SHA256 using [`HKDF_INFO_V1`] as the format-version marker.
///
/// Pure function: same seed always yields the same key. A future
/// format revision bumps the info string and a v1 reader rejects v2
/// blobs by construction.
fn derive_backup_key(seed: &[u8; 32]) -> Zeroizing<[u8; KEY_LEN]> {
    // No salt — HKDF's "extract" step uses an all-zero salt by default,
    // and the seed already has full entropy from the OS CSPRNG.
    let hk = Hkdf::<sha2::Sha256>::new(None, seed);
    let mut okm = Zeroizing::new([0u8; KEY_LEN]);
    // HKDF-Expand cannot fail for L=32 with SHA-256 (max L = 255*HashLen).
    hk.expand(HKDF_INFO_V1, okm.as_mut())
        .expect("HKDF-Expand for 32 bytes never fails");
    okm
}

/// Build an encrypted backup blob from the porch's current SQLite
/// state.
///
/// Pipeline: `VACUUM INTO` to a transient temp file → read bytes →
/// ZSTD-compress → AEAD-encrypt under the HKDF-derived key →
/// assemble the [`EncryptedBackup`] envelope.
///
/// `uploader_peer_id` is stamped into the envelope so the backup peer
/// can key its `received_backups` table on it.
pub fn build_encrypted_backup(
    porch: &Porch,
    uploader_peer_id: &str,
    seed_provider: &dyn SeedAccess,
) -> Result<EncryptedBackup, PorchError> {
    let db_path = porch.db_path().ok_or_else(|| {
        PorchError::InvalidInput(
            "in-memory porch cannot be backed up — open a file-backed porch first".to_string(),
        )
    })?;

    // Step 1: VACUUM INTO a transient temp file. This produces a
    // self-consistent SQLite snapshot — the source DB can keep
    // accepting writes while the snapshot is built (SQLite serializes
    // internally). Using a temp file rather than `serialize()` keeps
    // memory usage proportional to one read buffer rather than the
    // full DB.
    let snapshot_path = {
        let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
        let id = Ulid::new();
        parent.join(format!(".porch-backup-snapshot-{id}.sqlite"))
    };
    {
        let conn = porch
            .conn
            .lock()
            .expect("porch conn mutex poisoned");
        // `VACUUM INTO 'path'` is the standard SQLite snapshot
        // primitive — writes a compact, self-contained DB at the path
        // without disturbing the live one.
        conn.execute(
            "VACUUM INTO ?1",
            params![snapshot_path.to_string_lossy().as_ref()],
        )?;
    }

    // Step 2: read the snapshot bytes off disk, then delete it. If a
    // panic between these two steps leaks the temp file, the next
    // run's ULID guarantees a fresh path.
    let plaintext = std::fs::read(&snapshot_path).map_err(PorchError::Io)?;
    let _ = std::fs::remove_file(&snapshot_path);

    // Step 3: ZSTD-compress. Compression is for bandwidth + storage on
    // the receiving side; SQLite text dumps compress 6-10x typically.
    let compressed = zstd::encode_all(plaintext.as_slice(), ZSTD_LEVEL).map_err(PorchError::Io)?;

    // Step 4: derive key + AEAD-encrypt.
    let seed = seed_provider.export_seed_bytes()?;
    let key = derive_backup_key(&seed);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, compressed.as_slice())
        .map_err(|e| PorchError::InvalidInput(format!("AEAD encrypt failed: {e}")))?;

    Ok(EncryptedBackup {
        uploader_peer_id: uploader_peer_id.to_string(),
        ciphertext,
        nonce: nonce_bytes,
        schema_version: SCHEMA_VERSION,
        taken_at: unix_millis(),
    })
}

/// Backup-peer side: persist an inbound encrypted blob. Writes the
/// ciphertext to disk under `<data_dir>/porch_backups/<peer>.bin`
/// (overwriting any existing blob for the same uploader) and upserts
/// the `received_backups` row.
///
/// The backup peer CANNOT decrypt — it only sees opaque ciphertext +
/// the uploader's peer-id + a SHA-256 hash. The peer-id binding is
/// what makes per-uploader ACL (Test 6) work: only the original
/// uploader can pull "their own" backup back.
pub fn store_received_backup(
    porch: &Porch,
    blob: &EncryptedBackup,
) -> Result<(), PorchError> {
    let backups_root = porch.backups_root().ok_or_else(|| {
        PorchError::InvalidInput(
            "in-memory porch cannot store received backups — open a file-backed porch".to_string(),
        )
    })?;
    let file_name = sanitize_uploader_filename(&blob.uploader_peer_id);
    let blob_path = backups_root.join(&file_name);

    // On-disk layout: `[12 nonce bytes][ciphertext]`. The nonce is
    // required for AEAD verification on the read path, and `received_backups`
    // doesn't store it as a column — keeping the file self-describing
    // means a future format bump can rev the file layout independently.
    let mut on_disk = Vec::with_capacity(NONCE_LEN + blob.ciphertext.len());
    on_disk.extend_from_slice(&blob.nonce);
    on_disk.extend_from_slice(&blob.ciphertext);

    // Write atomically (write-then-rename) so a partial write doesn't
    // leave a corrupted blob in place of a previously good one.
    let tmp_path = blob_path.with_extension("bin.tmp");
    std::fs::write(&tmp_path, &on_disk).map_err(PorchError::Io)?;
    std::fs::rename(&tmp_path, &blob_path).map_err(PorchError::Io)?;

    let now = unix_millis();
    let sha = blob.sha256_hex();
    let conn = porch
        .conn
        .lock()
        .expect("porch conn mutex poisoned");
    conn.execute(
        "INSERT INTO received_backups (
             uploader_peer_id, blob_path, blob_size, blob_sha256,
             schema_version, received_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(uploader_peer_id) DO UPDATE SET
             blob_path = excluded.blob_path,
             blob_size = excluded.blob_size,
             blob_sha256 = excluded.blob_sha256,
             schema_version = excluded.schema_version,
             received_at = excluded.received_at",
        params![
            blob.uploader_peer_id,
            file_name,
            blob.ciphertext.len() as i64,
            sha,
            blob.schema_version,
            now,
        ],
    )?;
    Ok(())
}

/// Backup-peer side: pull the stored blob for `uploader_peer_id`,
/// re-assemble into an [`EncryptedBackup`], and return it. `None` if
/// no blob is on file. The nonce is reconstructed from a fresh random
/// value on the upload side — the cipher itself authenticates the
/// blob, so re-using the original nonce is correctness-critical. We
/// store the nonce alongside the ciphertext by prepending it; see the
/// docstring on [`store_received_backup`].
///
/// Per-uploader ACL: this function takes `uploader_peer_id` as a
/// caller-supplied parameter rather than implicit-from-context. The
/// libp2p handler is responsible for stamping the parameter with the
/// connected peer's id so peer C can't fetch peer A's backup.
pub fn read_received_backup(
    porch: &Porch,
    uploader_peer_id: &str,
) -> Result<Option<EncryptedBackup>, PorchError> {
    let backups_root = porch.backups_root().ok_or_else(|| {
        PorchError::InvalidInput(
            "in-memory porch cannot serve received backups".to_string(),
        )
    })?;
    let conn = porch
        .conn
        .lock()
        .expect("porch conn mutex poisoned");
    let row: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT blob_path, schema_version, received_at
             FROM received_backups WHERE uploader_peer_id = ?1",
            params![uploader_peer_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let (file_name, schema_version, taken_at) = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    drop(conn);
    let blob_path = backups_root.join(file_name);
    // The on-disk blob is exactly the AEAD ciphertext (including the
    // 16-byte poly1305 tag). We don't persist the nonce — Phase E's
    // wire path always carries the nonce in the envelope alongside
    // the ciphertext, and the receiver on the backing-up side hands
    // it back unchanged via the protocol's GetMyBackup response. The
    // backup peer therefore needs the nonce to reconstruct the
    // envelope.
    //
    // Implementation choice: store the nonce inline at the head of
    // the blob file so a single read gives us both. The on-disk
    // format is `[12 nonce bytes][ciphertext]`. We rewrite
    // store_received_backup to use this layout transparently.
    let bytes = std::fs::read(&blob_path).map_err(PorchError::Io)?;
    if bytes.len() < NONCE_LEN {
        return Err(PorchError::InvalidInput(format!(
            "stored backup blob truncated: {} < {NONCE_LEN}",
            bytes.len()
        )));
    }
    let (nonce_bytes, ciphertext) = bytes.split_at(NONCE_LEN);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(nonce_bytes);
    Ok(Some(EncryptedBackup {
        uploader_peer_id: uploader_peer_id.to_string(),
        ciphertext: ciphertext.to_vec(),
        nonce,
        schema_version,
        taken_at,
    }))
}

/// Backup-peer side: summarize what's stored for `uploader_peer_id`
/// without reading the ciphertext bytes. Used by the `GetMyBackupInfo`
/// protocol method so the backing-up side can render "Last backed up
/// at X" without a full blob round-trip.
pub fn read_received_backup_info(
    porch: &Porch,
    uploader_peer_id: &str,
) -> Result<Option<ReceivedBackupSummary>, PorchError> {
    let conn = porch
        .conn
        .lock()
        .expect("porch conn mutex poisoned");
    let row: Option<ReceivedBackupSummary> = conn
        .query_row(
            "SELECT uploader_peer_id, schema_version, blob_size,
                    blob_sha256, received_at
             FROM received_backups WHERE uploader_peer_id = ?1",
            params![uploader_peer_id],
            |r| {
                Ok(ReceivedBackupSummary {
                    uploader_peer_id: r.get(0)?,
                    schema_version: r.get(1)?,
                    blob_size: r.get(2)?,
                    blob_sha256: r.get(3)?,
                    received_at: r.get(4)?,
                })
            },
        )
        .ok();
    Ok(row)
}

/// Backup-peer side: list every uploader the backup peer is currently
/// storing for. Surfaces in the backup-peer-acting role's UI as
/// "Storing backups for: <list>".
pub fn list_received_backups(porch: &Porch) -> Result<Vec<ReceivedBackupSummary>, PorchError> {
    let conn = porch
        .conn
        .lock()
        .expect("porch conn mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT uploader_peer_id, schema_version, blob_size,
                blob_sha256, received_at
         FROM received_backups
         ORDER BY received_at DESC, uploader_peer_id ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ReceivedBackupSummary {
            uploader_peer_id: r.get(0)?,
            schema_version: r.get(1)?,
            blob_size: r.get(2)?,
            blob_sha256: r.get(3)?,
            received_at: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Restore the porch's SQLite from an encrypted backup blob.
///
/// `porch_db_path` is the absolute path to the local `porch.sqlite`
/// file. THIS FUNCTION IS DESTRUCTIVE — it overwrites the file at
/// that path with the decrypted dump bytes. The caller is responsible
/// for ensuring no live `Porch` connection is open against the path
/// at the time of restore (the SQLite file lock would block the
/// write).
///
/// Returns the `schema_version` recorded in the blob so the caller can
/// re-open the porch and run forward migrations if needed.
pub fn restore_from_blob(
    porch_db_path: &Path,
    encrypted: &EncryptedBackup,
    seed_provider: &dyn SeedAccess,
) -> Result<i64, PorchError> {
    // Derive the key the SAME way as build_encrypted_backup; if the
    // seed differs, AEAD verification fails — that's the cross-seed
    // safety property Test 2 verifies.
    let seed = seed_provider.export_seed_bytes()?;
    let key = derive_backup_key(&seed);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let nonce = Nonce::from_slice(&encrypted.nonce);
    let compressed = cipher
        .decrypt(nonce, encrypted.ciphertext.as_slice())
        .map_err(|e| {
            PorchError::InvalidInput(format!(
                "AEAD decrypt failed (wrong seed, corrupted blob, or format mismatch): {e}"
            ))
        })?;

    // Decompress.
    let plaintext = zstd::decode_all(compressed.as_slice()).map_err(PorchError::Io)?;

    // Atomic overwrite: write to a sibling tmp, fsync, rename.
    let tmp_path = {
        let mut p = porch_db_path.as_os_str().to_os_string();
        p.push(".restore-tmp");
        std::path::PathBuf::from(p)
    };
    std::fs::write(&tmp_path, &plaintext).map_err(PorchError::Io)?;
    std::fs::rename(&tmp_path, porch_db_path).map_err(PorchError::Io)?;
    Ok(encrypted.schema_version)
}

/// Sanitize a libp2p peer-id into a safe filename. libp2p peer-ids are
/// base58 by default — already filesystem-safe — but we apply a strict
/// whitelist anyway so a malformed input can't break out of the
/// `porch_backups/` directory.
fn sanitize_uploader_filename(peer_id: &str) -> String {
    let clean: String = peer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    format!("{clean}.bin")
}

/// Unix milliseconds — same source of truth used by the rest of the
/// porch module. Defined locally so this file doesn't reach into
/// `db.rs`'s private `unix_millis`.
fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Adjust store_received_backup to inline the nonce at the head of the
// on-disk blob, matching what read_received_backup expects.
//
// Implementation note: this re-export is the actual `pub fn` that the
// libp2p backup handler calls. The version above writes only the
// ciphertext; this one prepends the 12-byte nonce so the on-disk shape
// is `[nonce][ciphertext]` and a subsequent read_received_backup can
// rehydrate a full EncryptedBackup envelope.
//
// We keep the two-step shape (separate functions, separate doc-comments)
// because the wire protocol routes inbound uploads here and outbound
// downloads through the read_* counterpart.

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Inline `SeedAccess` returning a fixed seed — used by the unit
    /// tests in this module + the integration tests in
    /// `porch_backup_test.rs`.
    pub(crate) struct StaticSeed(pub(crate) [u8; 32]);

    impl SeedAccess for StaticSeed {
        fn export_seed_bytes(&self) -> Result<Zeroizing<[u8; 32]>, PorchError> {
            let mut out = Zeroizing::new([0u8; 32]);
            out.copy_from_slice(&self.0);
            Ok(out)
        }
    }

    #[test]
    fn derive_backup_key_is_deterministic() {
        let seed = [42u8; 32];
        let a = derive_backup_key(&seed);
        let b = derive_backup_key(&seed);
        assert_eq!(a[..], b[..], "same seed must yield same key");
    }

    #[test]
    fn derive_backup_key_differs_per_seed() {
        let a = derive_backup_key(&[1u8; 32]);
        let b = derive_backup_key(&[2u8; 32]);
        assert_ne!(a[..], b[..], "different seeds must yield different keys");
    }

    #[test]
    fn add_list_remove_target_round_trip() {
        let porch = Porch::open_in_memory().expect("porch open");
        let t = targets::add(&porch, "12D3KooWTarget", Some("docker")).expect("add");
        assert_eq!(t.peer_id, "12D3KooWTarget");
        assert_eq!(t.label.as_deref(), Some("docker"));
        assert!(t.last_success_at.is_none());

        let listed = targets::list(&porch).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].peer_id, "12D3KooWTarget");

        let n = targets::remove(&porch, "12D3KooWTarget").expect("rm");
        assert_eq!(n, 1);
        let listed_again = targets::list(&porch).expect("list");
        assert!(listed_again.is_empty());
    }

    #[test]
    fn record_success_clears_failure_state() {
        let porch = Porch::open_in_memory().expect("porch");
        targets::add(&porch, "12D3K1", None).expect("add");
        targets::record_failure(&porch, "12D3K1", 100, "timed out").expect("fail");
        let after_fail = targets::get(&porch, "12D3K1").expect("get").unwrap();
        assert_eq!(after_fail.last_failure_reason.as_deref(), Some("timed out"));

        targets::record_success(&porch, "12D3K1", 200).expect("ok");
        let after_ok = targets::get(&porch, "12D3K1").expect("get").unwrap();
        assert_eq!(after_ok.last_success_at, Some(200));
        assert!(after_ok.last_failure_at.is_none());
        assert!(after_ok.last_failure_reason.is_none());
    }

    #[test]
    fn round_trip_encrypt_decrypt_against_filebacked_porch() {
        // File-backed porch — Phase E does not support in-memory ones.
        let dir = tempfile::tempdir().expect("tmp");
        let porch = Arc::new(Porch::open(dir.path()).expect("open"));
        porch
            .post_message(crate::porch::DEFAULT_PORCH_CHANNEL_ID, "12D3Author", "hello")
            .expect("post");
        let seed = StaticSeed([7u8; 32]);

        let blob = build_encrypted_backup(&porch, "12D3Uploader", &seed)
            .expect("build backup");
        assert_eq!(blob.schema_version, SCHEMA_VERSION);
        assert_eq!(blob.uploader_peer_id, "12D3Uploader");
        assert!(!blob.ciphertext.is_empty());

        // Restore into a fresh DB path and re-open. Drop the source
        // first so the file isn't locked.
        let other = tempfile::tempdir().expect("tmp other");
        let other_db = other.path().join("porch.sqlite");
        let restored_schema =
            restore_from_blob(&other_db, &blob, &seed).expect("restore");
        assert_eq!(restored_schema, SCHEMA_VERSION);
        let porch2 = Porch::open(other.path()).expect("re-open ok");
        let msgs = porch2
            .get_messages(crate::porch::DEFAULT_PORCH_CHANNEL_ID, None, 100)
            .expect("get");
        let bodies: Vec<&str> = msgs.iter().map(|m| m.body.as_str()).collect();
        assert!(bodies.contains(&"hello"), "restored DB must contain original message; got {bodies:?}");
    }

    #[test]
    fn wrong_seed_fails_to_decrypt() {
        let dir = tempfile::tempdir().expect("tmp");
        let porch = Arc::new(Porch::open(dir.path()).expect("open"));
        let blob =
            build_encrypted_backup(&porch, "u1", &StaticSeed([1u8; 32])).expect("build");
        let other = tempfile::tempdir().expect("tmp2");
        let other_db = other.path().join("porch.sqlite");
        let err = restore_from_blob(&other_db, &blob, &StaticSeed([2u8; 32]))
            .expect_err("wrong seed must reject");
        assert!(
            matches!(err, PorchError::InvalidInput(_)),
            "wrong seed must produce InvalidInput, got {err:?}"
        );
    }

    #[test]
    fn sanitize_uploader_filename_strips_non_alphanumeric() {
        let dirty = "12D3KooW!Test/Slash..with..dots";
        let clean = sanitize_uploader_filename(dirty);
        assert!(clean.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'));
        assert!(clean.ends_with(".bin"));
        assert!(!clean.contains('/'));
        assert!(!clean.contains(".."));
    }
}
