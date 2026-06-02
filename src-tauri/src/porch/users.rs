//! User Management Phase 1 — per-install user profiles and the
//! Stronghold-backed keychain abstraction.
//!
//! A **user profile** is a distinct identity inside Concord — NOT the
//! same as a Matrix `user_id`; one Concord profile may own several
//! Matrix logins to different homeservers, a Concord-instance invite
//! credential, and zero or more p2p-peer trust entries. Profiles are
//! per-install by default; an account relay (Phase 3) propagates the
//! primary profile's keychain to other devices.
//!
//! A **keychain entry** is one saved login: which source kind, which
//! host, and the credentials themselves stored as AEAD ciphertext. The
//! credentials only leave the keychain through [`Porch::decrypt_credentials`],
//! and only when the caller supplies the same Stronghold seed that
//! encrypted them.
//!
//! ## Encryption
//!
//! ```text
//! seed   = Stronghold-protected Ed25519 seed bytes (32 bytes)
//! key    = HKDF-SHA256(ikm=seed, info=b"concord/keychain/v1", L=32)
//! cipher = ChaCha20-Poly1305(key)
//! nonce  = 12 bytes from OsRng, fresh per entry
//! ```
//!
//! The HKDF info string is deliberately distinct from
//! `porch::backup::HKDF_INFO_V1` (`b"concord/porch-backup/v1"`) so the
//! two key streams remain disjoint even if both ever leaked. A future
//! format revision bumps the info string to `v2`; a v1 reader cannot
//! decrypt a v2 entry — AEAD verification fails (different key) and
//! the error surfaces as [`PorchError::InvalidInput`].
//!
//! ## Primary profile invariant
//!
//! Exactly one profile per install can be marked `is_primary = 1` at
//! any time. The invariant is enforced by a partial unique index in
//! the schema (`idx_only_one_primary`) and by the application-layer
//! [`Porch::set_primary`] helper which clears the previous primary in
//! the same transaction before promoting the new one.

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use ulid::Ulid;
use zeroize::Zeroizing;

use super::backup::SeedAccess;
use super::db::Porch;
use super::error::PorchError;

/// HKDF info string — the **format version marker** for the keychain
/// encryption layer. Bumping this string is the canonical way to rev
/// the on-disk credential blob format. A reader compiled with the v1
/// string cannot decrypt a v2 entry; AEAD verification fails and the
/// error surfaces as [`PorchError::InvalidInput`].
///
/// Deliberately distinct from [`crate::porch::HKDF_INFO_V1`] so the
/// keychain and porch-backup key streams remain disjoint.
pub const KEYCHAIN_HKDF_INFO_V1: &[u8] = b"concord/keychain/v1";

/// ChaCha20-Poly1305 key length (32 bytes).
const KEY_LEN: usize = 32;

/// ChaCha20-Poly1305 nonce length (RFC 8439: 12 bytes).
const NONCE_LEN: usize = 12;

/// Maximum length of a user-visible display name. Anything longer is
/// rejected with [`PorchError::InvalidInput`].
const MAX_DISPLAY_NAME_LEN: usize = 64;

/// Where a profile came from. Drives the provenance badge in the
/// Users settings tab so the user can tell at a glance which profiles
/// were created locally versus pulled from a relay (Phase 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    /// Profile was created on this install via the local UI. Phase 1
    /// only ever produces profiles with this variant.
    Local,
    /// Profile was imported from an account relay (Phase 3). Carried
    /// in the schema from Phase 1 so the relay-restore flow can land
    /// without a migration.
    RelayRestored,
}

impl Provenance {
    /// Wire-format string for SQLite CHECK / INSERT. Used by the
    /// relay-restore path (Phase 3); Phase 1 only inserts `Local`
    /// (hard-coded in the migration seed + `create_profile`).
    #[allow(dead_code)]
    fn as_str(self) -> &'static str {
        match self {
            Provenance::Local => "local",
            Provenance::RelayRestored => "relay_restored",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "local" => Some(Provenance::Local),
            "relay_restored" => Some(Provenance::RelayRestored),
            _ => None,
        }
    }
}

/// One user profile. Carries identity metadata only — credentials live
/// in associated [`KeychainEntry`] rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserProfile {
    /// ULID — stable identifier used as the FK target for
    /// `keychain_entries.profile_id`.
    pub id: String,
    /// User-visible display name. Validated to be non-empty after trim
    /// and at most [`MAX_DISPLAY_NAME_LEN`] chars.
    pub display_name: String,
    /// Optional avatar URL (mxc:// or http(s)). The renderer is
    /// responsible for fetching and caching; the porch only stores
    /// the URL.
    pub avatar_url: Option<String>,
    /// Exactly one profile per install carries `true`. The unique
    /// partial index on `user_profiles(is_primary) WHERE is_primary = 1`
    /// enforces the invariant at the SQL layer; `set_primary` is the
    /// application-layer transaction that clears the previous primary
    /// before promoting a new one.
    pub is_primary: bool,
    /// Where this profile came from. See [`Provenance`].
    pub provenance: Provenance,
    /// Unix milliseconds — when the profile was first created on this
    /// install (or when it was first imported, for relay-restored).
    pub created_at: i64,
}

/// Kind of source a keychain entry authenticates to. Drives the icon /
/// label rendering on the keychain UI and lets Phase 2's source-add
/// routing pick the right credential shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// A Concord-instance source — full Concord client login, owns a
    /// Matrix identity plus the Concord API session.
    Concord,
    /// A bare Matrix homeserver login — used for federation-only
    /// access to a non-Concord Matrix server.
    Matrix,
    /// A libp2p peer trust entry — credentials for paired-peer access
    /// to another personal device.
    P2pPeer,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            SourceKind::Concord => "concord",
            SourceKind::Matrix => "matrix",
            SourceKind::P2pPeer => "p2p_peer",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "concord" => Some(SourceKind::Concord),
            "matrix" => Some(SourceKind::Matrix),
            "p2p_peer" => Some(SourceKind::P2pPeer),
            _ => None,
        }
    }
}

/// One keychain entry — a saved login. The `ciphertext` and `nonce`
/// columns are intentionally NOT exposed: callers see the metadata so
/// the UI can render "you have a Matrix login for matrix.org", but the
/// credential bytes only leave the keychain through
/// [`Porch::decrypt_credentials`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeychainEntry {
    /// ULID — stable identifier.
    pub id: String,
    /// FK to [`UserProfile::id`]. The schema's
    /// `ON DELETE CASCADE` makes a profile delete drop its entries
    /// automatically.
    pub profile_id: String,
    /// What kind of source this entry authenticates to.
    pub source_kind: SourceKind,
    /// The source's host (e.g. `matrix.org`, `mycorp.example`).
    pub source_host: String,
    /// User-supplied nickname for this login (e.g. "work account").
    /// Optional.
    pub label: Option<String>,
    /// Unix milliseconds — when this entry was first added.
    pub created_at: i64,
    /// Unix milliseconds — when the credentials were last decrypted
    /// (i.e. used for an authenticated request). `None` if never.
    pub last_used_at: Option<i64>,
    // NOTE: `ciphertext` and `nonce` are deliberately omitted from
    // this struct — they are never exposed across IPC or to the
    // renderer. Credentials leave the keychain only through
    // `decrypt_credentials`.
}

/// Plaintext credentials decrypted from a keychain entry. The shape is
/// flexible — different source kinds carry different fields — so the
/// payload is modelled as opaque JSON. Callers parse into their own
/// typed shape on the consuming side.
///
/// The `Zeroize` derive is intentionally NOT applied here:
/// `serde_json::Value` doesn't implement `Zeroize`. The caller is
/// responsible for not retaining the value longer than necessary;
/// Phase 2's source-add routing flushes the credentials into the live
/// auth session and drops the wrapper immediately.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaintextCredentials(pub serde_json::Value);

/// Derive the 32-byte symmetric keychain key from the Stronghold seed
/// via HKDF-SHA256 using [`KEYCHAIN_HKDF_INFO_V1`] as the format-
/// version marker.
///
/// Pure function: same seed always yields the same key. A future
/// format revision bumps the info string and a v1 reader rejects v2
/// entries by construction.
fn derive_keychain_key(seed: &[u8; 32]) -> Zeroizing<[u8; KEY_LEN]> {
    // No salt — HKDF's "extract" step uses an all-zero salt by default,
    // and the Stronghold seed already has full entropy from the OS
    // CSPRNG. Mirrors the porch-backup derivation pattern.
    let hk = Hkdf::<sha2::Sha256>::new(None, seed);
    let mut okm = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(KEYCHAIN_HKDF_INFO_V1, okm.as_mut())
        .expect("HKDF-Expand for 32 bytes never fails");
    okm
}

/// Encrypt a serializable credentials payload under the seed-derived
/// keychain key. Returns `(ciphertext, nonce)`; the nonce is a fresh
/// 12-byte OsRng value per call.
fn encrypt_credentials(
    seed: &[u8; 32],
    plaintext: &serde_json::Value,
) -> Result<(Vec<u8>, [u8; NONCE_LEN]), PorchError> {
    let key = derive_keychain_key(seed);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let json = serde_json::to_vec(plaintext)?;
    let ciphertext = cipher
        .encrypt(nonce, json.as_slice())
        .map_err(|e| PorchError::InvalidInput(format!("AEAD encrypt failed: {e}")))?;
    Ok((ciphertext, nonce_bytes))
}

/// Decrypt a keychain ciphertext + nonce back into a JSON value. AEAD
/// verification failure (wrong seed, corrupted blob, format mismatch)
/// surfaces as [`PorchError::InvalidInput`].
fn decrypt_credentials_bytes(
    seed: &[u8; 32],
    ciphertext: &[u8],
    nonce_bytes: &[u8],
) -> Result<serde_json::Value, PorchError> {
    if nonce_bytes.len() != NONCE_LEN {
        return Err(PorchError::InvalidInput(format!(
            "keychain nonce wrong length: {} != {NONCE_LEN}",
            nonce_bytes.len()
        )));
    }
    let key = derive_keychain_key(seed);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|e| {
        PorchError::InvalidInput(format!(
            "keychain AEAD decrypt failed (wrong seed, corrupted blob, or format mismatch): {e}"
        ))
    })?;
    let value: serde_json::Value = serde_json::from_slice(&plaintext)?;
    Ok(value)
}

/// Validate a user-supplied display name: non-empty after trim, at
/// most [`MAX_DISPLAY_NAME_LEN`] chars. Returns the trimmed string.
fn validate_display_name(name: &str) -> Result<String, PorchError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(PorchError::InvalidInput(
            "display_name must not be empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_DISPLAY_NAME_LEN {
        return Err(PorchError::InvalidInput(format!(
            "display_name too long: {} > {MAX_DISPLAY_NAME_LEN}",
            trimmed.chars().count()
        )));
    }
    Ok(trimmed.to_string())
}

impl Porch {
    /// List every non-tombstoned user profile, primary first, then
    /// `created_at` ascending. Stable order across renders so the UI
    /// doesn't flicker.
    pub fn list_profiles(&self) -> Result<Vec<UserProfile>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, display_name, avatar_url, is_primary, provenance, created_at
             FROM user_profiles
             WHERE sync_tombstone = 0
             ORDER BY is_primary DESC, created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], row_to_profile)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Look up a single profile by id, or `None` if missing /
    /// tombstoned.
    pub fn get_profile(&self, id: &str) -> Result<Option<UserProfile>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT id, display_name, avatar_url, is_primary, provenance, created_at
                 FROM user_profiles
                 WHERE id = ?1 AND sync_tombstone = 0",
                params![id],
                row_to_profile,
            )
            .optional()?)
    }

    /// Create a new profile with the given display name. The new
    /// profile is NOT primary — promote it explicitly via
    /// [`Porch::set_primary`] if desired. Provenance is hard-coded to
    /// `Local`; the relay-restore path (Phase 3) gets its own
    /// internal helper that bypasses this.
    pub fn create_profile(&self, display_name: String) -> Result<UserProfile, PorchError> {
        let name = validate_display_name(&display_name)?;
        let id = Ulid::new().to_string();
        let now = unix_millis_porch();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let device_id = super::db::device_id_unchecked(&conn)?;
        let lamport = super::sync::clock::next_lamport(&conn)?;
        conn.execute(
            "INSERT INTO user_profiles
                (id, display_name, avatar_url, is_primary, provenance,
                 created_at, sync_device_id, sync_lamport, sync_tombstone)
             VALUES (?1, ?2, NULL, 0, 'local', ?3, ?4, ?5, 0)",
            params![id, name, now, device_id, lamport],
        )?;
        Ok(UserProfile {
            id,
            display_name: name,
            avatar_url: None,
            is_primary: false,
            provenance: Provenance::Local,
            created_at: now,
        })
    }

    /// Rename a profile. Returns the updated row, or
    /// [`PorchError::InvalidInput`] if the profile doesn't exist or
    /// the new name fails validation.
    pub fn rename_profile(
        &self,
        id: &str,
        display_name: String,
    ) -> Result<UserProfile, PorchError> {
        let name = validate_display_name(&display_name)?;
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let device_id = super::db::device_id_unchecked(&conn)?;
        let lamport = super::sync::clock::next_lamport(&conn)?;
        let n = conn.execute(
            "UPDATE user_profiles
             SET display_name = ?2,
                 sync_device_id = ?3,
                 sync_lamport = ?4
             WHERE id = ?1 AND sync_tombstone = 0",
            params![id, name, device_id, lamport],
        )?;
        if n == 0 {
            return Err(PorchError::InvalidInput(format!(
                "profile not found: {id}"
            )));
        }
        drop(conn);
        self.get_profile(id)?.ok_or_else(|| {
            PorchError::InvalidInput(format!("profile vanished after rename: {id}"))
        })
    }

    /// Set or clear the avatar URL for a profile.
    pub fn set_profile_avatar(
        &self,
        id: &str,
        avatar_url: Option<String>,
    ) -> Result<UserProfile, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let device_id = super::db::device_id_unchecked(&conn)?;
        let lamport = super::sync::clock::next_lamport(&conn)?;
        let n = conn.execute(
            "UPDATE user_profiles
             SET avatar_url = ?2,
                 sync_device_id = ?3,
                 sync_lamport = ?4
             WHERE id = ?1 AND sync_tombstone = 0",
            params![id, avatar_url, device_id, lamport],
        )?;
        if n == 0 {
            return Err(PorchError::InvalidInput(format!(
                "profile not found: {id}"
            )));
        }
        drop(conn);
        self.get_profile(id)?.ok_or_else(|| {
            PorchError::InvalidInput(format!("profile vanished after avatar update: {id}"))
        })
    }

    /// Promote `id` to primary, atomically demoting whatever profile
    /// is currently primary. The unique partial index forbids two
    /// primaries co-existing, so this MUST happen in a single
    /// transaction.
    pub fn set_primary(&self, id: &str) -> Result<UserProfile, PorchError> {
        let mut conn = self.conn.lock().expect("porch conn mutex poisoned");
        // Existence check up-front so we can return a typed error
        // instead of a no-op "0 rows updated".
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM user_profiles WHERE id = ?1 AND sync_tombstone = 0",
                params![id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(PorchError::InvalidInput(format!(
                "profile not found: {id}"
            )));
        }
        let device_id = super::db::device_id_unchecked(&conn)?;
        let lamport_demote = super::sync::clock::next_lamport(&conn)?;
        let tx = conn.transaction()?;
        // Step 1: demote whoever's currently primary. The
        // sync metadata is bumped so Phase 4's CRDT layer correctly
        // attributes the demotion to this install.
        tx.execute(
            "UPDATE user_profiles
             SET is_primary = 0,
                 sync_device_id = ?1,
                 sync_lamport = ?2
             WHERE is_primary = 1 AND sync_tombstone = 0",
            params![device_id, lamport_demote],
        )?;
        // Step 2: promote the requested profile. Lamport must
        // strictly exceed the demote stamp so the promote wins under
        // LWW even within the same transaction.
        let lamport_promote = lamport_demote + 1;
        tx.execute(
            "UPDATE user_profiles
             SET is_primary = 1,
                 sync_device_id = ?2,
                 sync_lamport = ?3
             WHERE id = ?1 AND sync_tombstone = 0",
            params![id, device_id, lamport_promote],
        )?;
        tx.commit()?;
        drop(conn);
        self.get_profile(id)?.ok_or_else(|| {
            PorchError::InvalidInput(format!("profile vanished after promote: {id}"))
        })
    }

    /// Delete a profile. The schema's `ON DELETE CASCADE` drops every
    /// keychain entry owned by the profile. Refuses to delete the
    /// last primary unless `confirm_primary_demotion` is true AND
    /// at least one other profile exists.
    pub fn delete_profile(
        &self,
        id: &str,
        confirm_primary_demotion: bool,
    ) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        // Look up the profile to decide whether the delete is
        // permitted.
        let row: Option<(bool, i64)> = conn
            .query_row(
                "SELECT is_primary,
                        (SELECT COUNT(*) FROM user_profiles WHERE sync_tombstone = 0) as total
                 FROM user_profiles
                 WHERE id = ?1 AND sync_tombstone = 0",
                params![id],
                |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let (is_primary, total) = match row {
            Some(v) => v,
            None => {
                return Err(PorchError::InvalidInput(format!(
                    "profile not found: {id}"
                )))
            }
        };
        if total <= 1 {
            return Err(PorchError::InvalidInput(
                "cannot delete the last profile on the install".to_string(),
            ));
        }
        if is_primary && !confirm_primary_demotion {
            return Err(PorchError::InvalidInput(
                "refusing to delete primary profile without confirm_primary_demotion=true \
                 — promote another profile first or pass the confirmation flag"
                    .to_string(),
            ));
        }
        // Physical delete: cascade handles keychain rows. Phase 4
        // adds a tombstone path so a delete propagates across
        // devices; for Phase 1 (no sync) the physical delete is
        // simpler and correct.
        let n = conn.execute(
            "DELETE FROM user_profiles WHERE id = ?1",
            params![id],
        )?;
        if n == 0 {
            return Err(PorchError::InvalidInput(format!(
                "profile delete affected 0 rows: {id}"
            )));
        }
        Ok(())
    }

    /// List every keychain entry owned by `profile_id`, ordered by
    /// `created_at` ascending.
    pub fn list_keychain(
        &self,
        profile_id: &str,
    ) -> Result<Vec<KeychainEntry>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, source_kind, source_host, label,
                    created_at, last_used_at
             FROM keychain_entries
             WHERE profile_id = ?1 AND sync_tombstone = 0
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![profile_id], row_to_keychain)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Look up a single keychain entry's metadata by id.
    pub fn get_keychain_entry(
        &self,
        entry_id: &str,
    ) -> Result<Option<KeychainEntry>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT id, profile_id, source_kind, source_host, label,
                        created_at, last_used_at
                 FROM keychain_entries
                 WHERE id = ?1 AND sync_tombstone = 0",
                params![entry_id],
                row_to_keychain,
            )
            .optional()?)
    }

    /// Encrypt the given credentials JSON under the seed-derived
    /// keychain key and insert a new entry owned by `profile_id`.
    ///
    /// Phase 2 wires this into the source-add UI; Phase 1 ships it as
    /// a Rust-side primitive so the tests can verify the round-trip.
    pub fn add_keychain_entry(
        &self,
        seed: &dyn SeedAccess,
        profile_id: &str,
        source_kind: SourceKind,
        source_host: String,
        label: Option<String>,
        credentials: serde_json::Value,
    ) -> Result<KeychainEntry, PorchError> {
        // Validation: profile must exist; source_host non-empty.
        if source_host.trim().is_empty() {
            return Err(PorchError::InvalidInput(
                "source_host must not be empty".to_string(),
            ));
        }
        if self.get_profile(profile_id)?.is_none() {
            return Err(PorchError::InvalidInput(format!(
                "profile not found: {profile_id}"
            )));
        }

        let seed_bytes = seed.export_seed_bytes()?;
        let (ciphertext, nonce_bytes) = encrypt_credentials(&seed_bytes, &credentials)?;

        let id = Ulid::new().to_string();
        let now = unix_millis_porch();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let device_id = super::db::device_id_unchecked(&conn)?;
        let lamport = super::sync::clock::next_lamport(&conn)?;
        conn.execute(
            "INSERT INTO keychain_entries
                (id, profile_id, source_kind, source_host, label,
                 ciphertext, nonce, created_at, last_used_at,
                 sync_device_id, sync_lamport, sync_tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, 0)",
            params![
                id,
                profile_id,
                source_kind.as_str(),
                source_host,
                label,
                ciphertext,
                nonce_bytes.to_vec(),
                now,
                device_id,
                lamport,
            ],
        )?;
        Ok(KeychainEntry {
            id,
            profile_id: profile_id.to_string(),
            source_kind,
            source_host,
            label,
            created_at: now,
            last_used_at: None,
        })
    }

    /// Decrypt a keychain entry's credentials using the supplied seed
    /// provider. Updates `last_used_at` on success. AEAD verification
    /// failure (wrong seed, corrupted blob, format mismatch) surfaces
    /// as [`PorchError::InvalidInput`].
    pub fn decrypt_credentials(
        &self,
        seed: &dyn SeedAccess,
        entry_id: &str,
    ) -> Result<PlaintextCredentials, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row: Option<(Vec<u8>, Vec<u8>)> = conn
            .query_row(
                "SELECT ciphertext, nonce FROM keychain_entries
                 WHERE id = ?1 AND sync_tombstone = 0",
                params![entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (ciphertext, nonce) = match row {
            Some(v) => v,
            None => {
                return Err(PorchError::InvalidInput(format!(
                    "keychain entry not found: {entry_id}"
                )))
            }
        };
        drop(conn);

        let seed_bytes = seed.export_seed_bytes()?;
        let value = decrypt_credentials_bytes(&seed_bytes, &ciphertext, &nonce)?;

        // Stamp last_used_at on the entry. Not load-bearing for
        // correctness — if this UPDATE fails we still hand back the
        // decrypted credentials. Phase 4's sync layer attributes the
        // stamp to this install.
        let now = unix_millis_porch();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        if let Ok(device_id) = super::db::device_id_unchecked(&conn) {
            if let Ok(lamport) = super::sync::clock::next_lamport(&conn) {
                let _ = conn.execute(
                    "UPDATE keychain_entries
                     SET last_used_at = ?2,
                         sync_device_id = ?3,
                         sync_lamport = ?4
                     WHERE id = ?1",
                    params![entry_id, now, device_id, lamport],
                );
            }
        }
        Ok(PlaintextCredentials(value))
    }

    /// Physically remove a keychain entry. Returns
    /// [`PorchError::InvalidInput`] if no entry with that id exists.
    pub fn remove_keychain_entry(&self, entry_id: &str) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let n = conn.execute(
            "DELETE FROM keychain_entries WHERE id = ?1",
            params![entry_id],
        )?;
        if n == 0 {
            return Err(PorchError::InvalidInput(format!(
                "keychain entry not found: {entry_id}"
            )));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Row decoders
// ---------------------------------------------------------------------------

fn row_to_profile(r: &rusqlite::Row) -> rusqlite::Result<UserProfile> {
    let provenance_str: String = r.get(4)?;
    let provenance = Provenance::from_str(&provenance_str).unwrap_or(Provenance::Local);
    Ok(UserProfile {
        id: r.get(0)?,
        display_name: r.get(1)?,
        avatar_url: r.get(2)?,
        is_primary: r.get::<_, i64>(3)? != 0,
        provenance,
        created_at: r.get(5)?,
    })
}

fn row_to_keychain(r: &rusqlite::Row) -> rusqlite::Result<KeychainEntry> {
    let source_kind_str: String = r.get(2)?;
    let source_kind = SourceKind::from_str(&source_kind_str).unwrap_or(SourceKind::Concord);
    Ok(KeychainEntry {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        source_kind,
        source_host: r.get(3)?,
        label: r.get(4)?,
        created_at: r.get(5)?,
        last_used_at: r.get(6)?,
    })
}

/// Unix milliseconds — same source-of-truth used by the rest of the
/// porch module. Defined locally so this file doesn't reach into
/// `db.rs`'s private `unix_millis`.
fn unix_millis_porch() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroizing;

    /// Inline `SeedAccess` returning a fixed seed.
    struct StaticSeed(pub [u8; 32]);

    impl SeedAccess for StaticSeed {
        fn export_seed_bytes(&self) -> Result<Zeroizing<[u8; 32]>, PorchError> {
            let mut out = Zeroizing::new([0u8; 32]);
            out.copy_from_slice(&self.0);
            Ok(out)
        }
    }

    #[test]
    fn derive_keychain_key_is_deterministic_per_seed() {
        let seed = [0xABu8; 32];
        let a = derive_keychain_key(&seed);
        let b = derive_keychain_key(&seed);
        assert_eq!(a[..], b[..]);
    }

    #[test]
    fn derive_keychain_key_differs_from_backup_key() {
        // Belt-and-suspenders: the keychain and porch-backup info
        // strings differ, so the derived keys MUST differ even on the
        // same seed.
        let seed = [0xCDu8; 32];
        let kc = derive_keychain_key(&seed);
        let bk = {
            let hk = Hkdf::<sha2::Sha256>::new(None, &seed);
            let mut okm = [0u8; KEY_LEN];
            hk.expand(crate::porch::HKDF_INFO_V1, &mut okm).expect("expand");
            okm
        };
        assert_ne!(
            kc[..],
            bk[..],
            "keychain and backup HKDF info strings must produce disjoint keys"
        );
    }

    #[test]
    fn validate_display_name_strips_whitespace_and_rejects_empty() {
        assert_eq!(validate_display_name("  Alice  ").unwrap(), "Alice");
        let err = validate_display_name("   ").expect_err("empty after trim");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn validate_display_name_rejects_too_long() {
        let s = "a".repeat(MAX_DISPLAY_NAME_LEN + 1);
        let err = validate_display_name(&s).expect_err("too long");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn encrypt_then_decrypt_round_trips() {
        let seed = [0x11u8; 32];
        let value = serde_json::json!({ "access_token": "abc", "user_id": "@a:b" });
        let (ct, nonce) = encrypt_credentials(&seed, &value).expect("encrypt");
        let back = decrypt_credentials_bytes(&seed, &ct, &nonce).expect("decrypt");
        assert_eq!(back, value);
    }

    #[test]
    fn decrypt_with_wrong_seed_fails() {
        let value = serde_json::json!({ "x": 1 });
        let (ct, nonce) = encrypt_credentials(&[1u8; 32], &value).expect("encrypt");
        let err = decrypt_credentials_bytes(&[2u8; 32], &ct, &nonce)
            .expect_err("wrong seed must reject");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn fresh_porch_seeds_one_primary_local_profile() {
        let porch = Porch::open_in_memory().expect("open");
        let profiles = porch.list_profiles().expect("list");
        assert_eq!(profiles.len(), 1);
        assert!(profiles[0].is_primary);
        assert_eq!(profiles[0].provenance, Provenance::Local);
        assert_eq!(profiles[0].display_name, "Local");
    }

    #[test]
    fn create_profile_yields_non_primary_row() {
        let porch = Porch::open_in_memory().expect("open");
        let p = porch.create_profile("Work".to_string()).expect("create");
        assert!(!p.is_primary);
        assert_eq!(p.display_name, "Work");
        let profiles = porch.list_profiles().expect("list");
        assert_eq!(profiles.len(), 2);
        let primaries: Vec<_> = profiles.iter().filter(|p| p.is_primary).collect();
        assert_eq!(primaries.len(), 1);
    }

    #[test]
    fn set_primary_demotes_previous() {
        let porch = Porch::open_in_memory().expect("open");
        let original_primary = porch.list_profiles().expect("list").into_iter()
            .find(|p| p.is_primary).expect("seeded primary");
        let new_p = porch.create_profile("Work".to_string()).expect("create");
        let promoted = porch.set_primary(&new_p.id).expect("promote");
        assert!(promoted.is_primary);
        // Original should now be non-primary.
        let after = porch.get_profile(&original_primary.id).expect("get").expect("present");
        assert!(!after.is_primary);
        let primaries: Vec<_> = porch.list_profiles().expect("list")
            .into_iter().filter(|p| p.is_primary).collect();
        assert_eq!(primaries.len(), 1);
        assert_eq!(primaries[0].id, new_p.id);
    }

    #[test]
    fn add_then_decrypt_round_trip() {
        let porch = Porch::open_in_memory().expect("open");
        let primary = porch.list_profiles().expect("list").into_iter()
            .find(|p| p.is_primary).expect("seeded primary");
        let seed = StaticSeed([0x42u8; 32]);
        let creds = serde_json::json!({
            "access_token": "syt_xxx",
            "user_id": "@alice:matrix.org",
            "device_id": "DEV"
        });
        let entry = porch.add_keychain_entry(
            &seed,
            &primary.id,
            SourceKind::Matrix,
            "matrix.org".to_string(),
            Some("personal".to_string()),
            creds.clone(),
        ).expect("add");
        assert_eq!(entry.source_host, "matrix.org");

        let decrypted = porch.decrypt_credentials(&seed, &entry.id).expect("decrypt");
        assert_eq!(decrypted.0, creds);
    }

    #[test]
    fn decrypt_with_wrong_seed_returns_typed_error() {
        let porch = Porch::open_in_memory().expect("open");
        let primary = porch.list_profiles().expect("list").into_iter()
            .find(|p| p.is_primary).expect("seeded primary");
        let entry = porch.add_keychain_entry(
            &StaticSeed([0x01u8; 32]),
            &primary.id,
            SourceKind::Concord,
            "host.example".to_string(),
            None,
            serde_json::json!({ "k": "v" }),
        ).expect("add");
        let err = porch.decrypt_credentials(&StaticSeed([0x02u8; 32]), &entry.id)
            .expect_err("wrong seed");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn delete_profile_cascades_keychain_entries() {
        let porch = Porch::open_in_memory().expect("open");
        // Use a non-primary profile so we don't trip the
        // "can't delete only primary" guard.
        let extra = porch.create_profile("Work".to_string()).expect("create");
        let seed = StaticSeed([0x33u8; 32]);
        porch.add_keychain_entry(
            &seed, &extra.id, SourceKind::Matrix, "ex.com".to_string(),
            None, serde_json::json!({}),
        ).expect("add 1");
        porch.add_keychain_entry(
            &seed, &extra.id, SourceKind::Concord, "ex.com".to_string(),
            None, serde_json::json!({}),
        ).expect("add 2");
        let before = porch.list_keychain(&extra.id).expect("list");
        assert_eq!(before.len(), 2);

        porch.delete_profile(&extra.id, false).expect("delete");
        let after = porch.list_keychain(&extra.id).expect("list");
        assert!(after.is_empty());
        assert!(porch.get_profile(&extra.id).expect("get").is_none());
    }

    #[test]
    fn cannot_delete_the_only_primary() {
        let porch = Porch::open_in_memory().expect("open");
        let primary = porch.list_profiles().expect("list").into_iter()
            .find(|p| p.is_primary).expect("seeded primary");
        let err = porch.delete_profile(&primary.id, true).expect_err("must reject");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }
}
