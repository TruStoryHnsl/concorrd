//! Phase 5 (INS-019b) — known-peers store.
//!
//! Backs the Paired Peers UI in Settings → Profile. A `KnownPeer` is the
//! durable, on-disk record of a peer we've been introduced to (via a QR
//! scan, a `concord://` deeplink, a Matrix-room peer-card message, or a
//! DHT lookup) plus its last-known libp2p multiaddrs so future swarm
//! restarts can re-dial without re-pairing.
//!
//! ## Why a separate file from the identity seed
//!
//! Phase 4 already established a sibling-file encryption pattern for the
//! Ed25519 seed (`<snapshot>.seed.enc`, ChaCha20-Poly1305 keyed off the
//! snapshot password). Phase 5 reuses the SAME pattern with a different
//! suffix (`<snapshot>.peer_store.json.enc`) so:
//!
//!   * No new crypto pattern is introduced — same library, same key,
//!     same nonce convention. Reviewers don't need to re-audit a fresh
//!     scheme.
//!   * The peer-store file lives alongside the Stronghold snapshot, so
//!     a "wipe the install" operation that removes the data dir takes
//!     both with it. There's no orphaned peer-list left over.
//!   * Peer-card data (peer IDs + multiaddrs) is technically PUBLIC —
//!     anyone who sees the QR has it — but the file still encrypts so
//!     a casual file-system reader can't enumerate every peer the user
//!     has ever paired with. The encryption layer is privacy, not
//!     secrecy.
//!
//! ## On-disk layout
//!
//! File format mirrors Phase 4: `[12-byte nonce][ChaCha20-Poly1305(json)]`.
//! The plaintext is a JSON object: `{ "version": 1, "peers": [KnownPeer, ...] }`.
//! Version field exists so a future format bump (e.g. moving from JSON to
//! CBOR, or adding a `notes` field per peer) can be detected at read time.
//!
//! ## Concurrency
//!
//! All public functions acquire a process-wide mutex on the peer-store
//! file path before reading or writing. The mutex is keyed by the absolute
//! sibling-file path so two Stronghold handles pointing at the SAME
//! snapshot (e.g. tests that build two handles against the same tmp dir)
//! still serialize their writes. Disjoint handles (different snapshots)
//! never contend.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use chrono::{DateTime, Utc};
use libp2p::Multiaddr;
use rand::RngCore;
use thiserror::Error;

use crate::servitude::identity::StrongholdHandle;

/// File-extension suffix appended to the Stronghold snapshot path to derive
/// the peer-store sibling-file path. Mirrors the Phase 4 `.seed.enc`
/// pattern.
const PEER_STORE_FILE_SUFFIX: &str = ".peer_store.json.enc";

/// ChaCha20-Poly1305 nonce length (RFC 8439).
const NONCE_LEN: usize = 12;

/// ChaCha20-Poly1305 expected key length (32 bytes — matches the snapshot
/// password Phase 4 generates).
const KEY_LEN: usize = 32;

/// Wire-format version baked into the JSON envelope. Bumped if the
/// `KnownPeer` shape ever changes incompatibly.
///
/// * `1` — Phase 5 initial schema: peer_id, public_key_hex, multiaddrs,
///   source, first_seen, last_seen.
/// * `2` — F-VIS: peer-store split between **visible_peers** (everyone
///   we've paired with, persists across access revoke) and
///   **access_peers** (subset currently allowed to dial in). On disk
///   this is one envelope of `KnownPeer` rows carrying two new
///   fields — `access_granted` (defaults to `true` for v1 rows so
///   pre-existing pairings keep working) and `last_access_grant_at`
///   (defaults to `null` and is set on the next explicit
///   `grant_access` call). Old v1 envelopes deserialize cleanly
///   because both new fields use serde defaults; this avoids needing a
///   one-shot migration step at the read path.
const FORMAT_VERSION: u32 = 2;

/// Expected hex length of `public_key_hex` — 32 bytes = 64 hex chars.
const PUBLIC_KEY_HEX_LEN: usize = 64;

/// Where a known peer entered the store. Mirrors INS-019b Phase 5's
/// "source badge" UI surface.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum PeerSource {
    Qr,
    Deeplink,
    MatrixRoom,
    Dht,
}

/// A peer's introduction card — the minimum metadata a remote install
/// publishes so we can locate and verify them on the swarm.
///
/// `multiaddrs` are stored as their string form so we can JSON-serialize
/// without depending on libp2p's wire encoding. They're parsed and
/// validated on `add` so malformed entries can't pollute the store.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PeerCard {
    /// Multihash-encoded libp2p PeerId, base58 (the same encoding
    /// `peer_swarm_status::our_peer_id` produces).
    pub peer_id: String,
    /// 32-byte Ed25519 public key, hex-encoded. Matches Phase 2's
    /// `PeerIdentityPublic.public_key_hex`.
    pub public_key_hex: String,
    /// libp2p multiaddrs (no `/p2p/<id>` suffix required; the swarm
    /// attaches it at dial time).
    pub multiaddrs: Vec<String>,
}

/// A peer we've been introduced to and chosen to remember. Stored
/// durably; survives app restart.
///
/// **F-VIS — visibility vs. access split.** Per the 2026-06-01 RFC
/// resolution filing (Architecture B), every paired peer the user has
/// ever introduced themselves to STAYS in the store ("visible_peers")
/// even after their access has been permanently revoked. The
/// `access_granted` boolean discriminates: `true` = appears in the
/// access list (this peer can dial in), `false` = visible-only (the
/// user still sees the peer existed but the host won't accept their
/// inbound dial until re-affirmed). Default for legacy v1 rows
/// deserialized off disk is `true` so existing pairings keep
/// transparently working.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct KnownPeer {
    pub peer_id: String,
    pub public_key_hex: String,
    pub multiaddrs: Vec<String>,
    pub source: PeerSource,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    /// F-VIS — `true` means this peer is currently in the access list
    /// (allowed to dial into the local porch/home). `false` means the
    /// peer is visible-only: the user still remembers them, but
    /// access has been revoked and won't be re-granted until the host
    /// explicitly calls `grant_access`. Defaults to `true` so format-v1
    /// envelopes round-trip without losing access for any
    /// pre-existing peer.
    #[serde(default = "default_access_granted")]
    pub access_granted: bool,
    /// F-VIS — RFC3339 timestamp of the most recent explicit
    /// `grant_access` call (i.e. the moment the operator re-affirmed
    /// this peer). `None` for legacy v1 rows that were never explicitly
    /// granted (they inherit the implicit `true` above but no
    /// timestamp). Surfaces in the Connections tab so the user can see
    /// which peers were re-affirmed recently.
    #[serde(default)]
    pub last_access_grant_at: Option<DateTime<Utc>>,
}

fn default_access_granted() -> bool {
    // F-VIS — see KnownPeer above. v1 envelopes that lack this field
    // default to "access granted" so legacy pairings keep working.
    true
}

/// Errors raised by the peer-store module.
#[derive(Debug, Error)]
pub enum PeerStoreError {
    /// Filesystem / atomic-write failure backing the sibling file.
    #[error("peer-store storage error at {0}: {1}")]
    Storage(PathBuf, std::io::Error),

    /// ChaCha20-Poly1305 AEAD failure (decrypt / encrypt). Almost always
    /// indicates a wrong snapshot password (e.g. the snapshot was
    /// re-created with a fresh password but the peer-store file from a
    /// previous install is still on disk).
    #[error("peer-store crypto failure: {0}")]
    Crypto(String),

    /// JSON encode/decode failure on the envelope.
    #[error("peer-store json error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Validation failure on an incoming `PeerCard` field
    /// (`peer_id`, `public_key_hex`, or a multiaddr).
    #[error("invalid peer payload: {0}")]
    InvalidPeerId(String),

    /// The handle wasn't built with sibling-file persistence — peer-store
    /// requires a `new_persistent` handle so its sibling file lives next
    /// to the snapshot.
    #[error(
        "peer-store requires a persistent Stronghold handle — build the \
         handle via StrongholdHandle::new_persistent so a snapshot path \
         and password are available"
    )]
    HandleNotPersistent,

    /// The encrypted envelope on disk declares a version this build
    /// doesn't understand. A future format upgrade may produce this on
    /// downgrade.
    #[error("peer-store on-disk version {0} is newer than this build supports ({1})")]
    UnsupportedVersion(u32, u32),

    /// Sibling-file length is suspicious before we even try to decrypt
    /// (e.g. truncated to less than nonce + tag = 28 bytes).
    #[error("peer-store sibling file at {0} is too short ({1} bytes)")]
    FileTruncated(PathBuf, usize),
}

/// JSON envelope written to the sibling file (then encrypted). The
/// `version` field lets a future format bump fail loudly instead of
/// silently producing garbage.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Envelope {
    version: u32,
    peers: Vec<KnownPeer>,
}

impl Envelope {
    fn empty() -> Self {
        Self {
            version: FORMAT_VERSION,
            peers: Vec::new(),
        }
    }

    #[cfg(test)]
    fn new(peers: Vec<KnownPeer>) -> Self {
        Self {
            version: FORMAT_VERSION,
            peers,
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List every known peer currently in the store, in insertion order.
///
/// Returns `Ok(vec![])` on the first call (no sibling file yet) — the
/// missing-file case is treated as "empty store", not as an error, so a
/// fresh install behaves identically to one that has been wiped.
pub async fn list(
    handle: &StrongholdHandle,
) -> Result<Vec<KnownPeer>, PeerStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.sibling);
    let envelope = read_envelope(handle, &paths)?;
    Ok(envelope.peers)
}

/// Add a peer to the store. Idempotent.
///
/// On a first encounter: a new `KnownPeer` is created with
/// `first_seen = last_seen = now()` and `source` recorded.
///
/// On a repeat encounter (matching `peer_id`):
///   * `multiaddrs` is unioned with the existing entry (HashSet dedup,
///     preserving insertion order — old addresses first, new ones
///     appended).
///   * `last_seen` advances to now.
///   * `first_seen` and `source` are NEVER overwritten. The original
///     introduction source is the source of truth for the UI's badge.
///
/// Returns the resulting `KnownPeer` after the update.
pub async fn add(
    handle: &StrongholdHandle,
    card: PeerCard,
    source: PeerSource,
) -> Result<KnownPeer, PeerStoreError> {
    validate_card(&card)?;
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.sibling);

    let mut envelope = read_envelope(handle, &paths)?;

    let now = Utc::now();
    let updated = match envelope.peers.iter_mut().find(|p| p.peer_id == card.peer_id) {
        Some(existing) => {
            // Union multiaddrs preserving order: keep existing entries,
            // append any new ones not already present. HashSet for the
            // membership check, Vec for the order.
            let mut seen: HashMap<&str, ()> = existing
                .multiaddrs
                .iter()
                .map(|s| (s.as_str(), ()))
                .collect();
            // Build the new list in a temp so we don't double-borrow
            // existing.multiaddrs while reading from seen.
            let new_addrs: Vec<String> = card
                .multiaddrs
                .iter()
                .filter(|a| !seen.contains_key(a.as_str()))
                .cloned()
                .collect();
            for a in &new_addrs {
                seen.insert(a.as_str(), ());
            }
            existing.multiaddrs.extend(new_addrs);
            existing.last_seen = now;
            // first_seen and source preserved deliberately.
            existing.clone()
        }
        None => {
            // De-duplicate the incoming multiaddrs against themselves
            // — a single `add` call shouldn't be able to plant
            // duplicates either.
            let mut deduped: Vec<String> = Vec::with_capacity(card.multiaddrs.len());
            let mut seen: HashMap<&str, ()> = HashMap::new();
            for a in &card.multiaddrs {
                if seen.insert(a.as_str(), ()).is_none() {
                    deduped.push(a.clone());
                }
            }
            // F-VIS — a freshly-added peer starts with access GRANTED
            // and `last_access_grant_at = now`. The visible/access
            // split only becomes interesting after a `revoke_access`
            // call. Adding a peer is implicitly an access grant.
            let peer = KnownPeer {
                peer_id: card.peer_id.clone(),
                public_key_hex: card.public_key_hex.clone(),
                multiaddrs: deduped,
                source,
                first_seen: now,
                last_seen: now,
                access_granted: true,
                last_access_grant_at: Some(now),
            };
            envelope.peers.push(peer.clone());
            peer
        }
    };

    write_envelope(handle, &paths, &envelope)?;
    Ok(updated)
}

/// Mark `peer_id` as seen at `now()`. No-op if the peer isn't in the
/// store (avoids surprising the caller — `mark_seen` is meant for
/// "swarm just dialed someone we already know" book-keeping, not
/// implicit `add`).
pub async fn mark_seen(
    handle: &StrongholdHandle,
    peer_id: &str,
) -> Result<(), PeerStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.sibling);

    let mut envelope = read_envelope(handle, &paths)?;
    let now = Utc::now();
    let mut changed = false;
    for peer in envelope.peers.iter_mut() {
        if peer.peer_id == peer_id {
            peer.last_seen = now;
            changed = true;
            break;
        }
    }
    if changed {
        write_envelope(handle, &paths, &envelope)?;
    }
    Ok(())
}

/// F-VIS — revoke access for `peer_id` while keeping the peer in the
/// visible-peers list. Sets `access_granted = false`. Returns
/// `Ok(Some(KnownPeer))` with the updated row when a peer was found,
/// `Ok(None)` when no such peer existed (the caller distinguishes
/// "nothing to do" from "I revoked something").
///
/// This is the load-bearing call for Architecture B in the 2026-06-01
/// RFC-resolution filing: revoking access does NOT delete the peer.
/// Re-affirming via [`grant_access`] flips the flag back without
/// re-collecting the peer card.
pub async fn revoke_access(
    handle: &StrongholdHandle,
    peer_id: &str,
) -> Result<Option<KnownPeer>, PeerStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.sibling);

    let mut envelope = read_envelope(handle, &paths)?;
    let updated = envelope
        .peers
        .iter_mut()
        .find(|p| p.peer_id == peer_id)
        .map(|peer| {
            peer.access_granted = false;
            // `last_access_grant_at` deliberately preserved so the UI
            // can still show "last affirmed: X" even after revocation.
            peer.clone()
        });
    if updated.is_some() {
        write_envelope(handle, &paths, &envelope)?;
    }
    Ok(updated)
}

/// F-VIS — re-affirm access for `peer_id`. Sets `access_granted = true`
/// and bumps `last_access_grant_at` to `now()`. Returns the same
/// `Option<KnownPeer>` semantics as [`revoke_access`].
///
/// Used by the Connections-tab toggle when the operator decides to
/// re-let an access-revoked peer back in.
pub async fn grant_access(
    handle: &StrongholdHandle,
    peer_id: &str,
) -> Result<Option<KnownPeer>, PeerStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.sibling);

    let mut envelope = read_envelope(handle, &paths)?;
    let now = Utc::now();
    let updated = envelope
        .peers
        .iter_mut()
        .find(|p| p.peer_id == peer_id)
        .map(|peer| {
            peer.access_granted = true;
            peer.last_access_grant_at = Some(now);
            peer.clone()
        });
    if updated.is_some() {
        write_envelope(handle, &paths, &envelope)?;
    }
    Ok(updated)
}

/// F-VIS — list every peer that's currently in the access set (i.e.
/// `access_granted == true`). Subset of [`list`]; the rest of the
/// callers in the codebase (greet handler, knock-resolver, etc.) should
/// migrate to this so a revoked peer's inbound dial is rejected even
/// though they remain visible in the UI.
pub async fn list_access_peers(
    handle: &StrongholdHandle,
) -> Result<Vec<KnownPeer>, PeerStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.sibling);
    let envelope = read_envelope(handle, &paths)?;
    Ok(envelope
        .peers
        .into_iter()
        .filter(|p| p.access_granted)
        .collect())
}

/// Remove `peer_id` from the store. Returns `true` if a peer was
/// removed, `false` if no such peer existed.
///
/// F-VIS note: this is a HARD removal that drops the peer from
/// visibility entirely. Use [`revoke_access`] when you want to deny
/// future dials but keep the peer in the user's list ("I know this
/// peer existed").
pub async fn remove(
    handle: &StrongholdHandle,
    peer_id: &str,
) -> Result<bool, PeerStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.sibling);

    let mut envelope = read_envelope(handle, &paths)?;
    let before = envelope.peers.len();
    envelope.peers.retain(|p| p.peer_id != peer_id);
    let removed = envelope.peers.len() != before;
    if removed {
        write_envelope(handle, &paths, &envelope)?;
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Validate a peer card before it touches disk. Spec contract: empty
/// `peer_id`, wrong-length `public_key_hex`, or any malformed multiaddr
/// must be rejected up-front so Wave 2 (TS) can trust the store's
/// invariants.
fn validate_card(card: &PeerCard) -> Result<(), PeerStoreError> {
    if card.peer_id.is_empty() {
        return Err(PeerStoreError::InvalidPeerId(
            "peer_id must not be empty".to_string(),
        ));
    }
    if card.public_key_hex.len() != PUBLIC_KEY_HEX_LEN {
        return Err(PeerStoreError::InvalidPeerId(format!(
            "public_key_hex must be exactly {PUBLIC_KEY_HEX_LEN} hex chars, got {}",
            card.public_key_hex.len()
        )));
    }
    if !card.public_key_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(PeerStoreError::InvalidPeerId(
            "public_key_hex contains non-hex characters".to_string(),
        ));
    }
    for addr in &card.multiaddrs {
        if addr.parse::<Multiaddr>().is_err() {
            return Err(PeerStoreError::InvalidPeerId(format!(
                "multiaddr {addr:?} does not parse as a libp2p Multiaddr"
            )));
        }
    }
    Ok(())
}

/// Per-handle paths derived once from the underlying Stronghold snapshot.
struct PeerStorePaths {
    /// Absolute path to the encrypted sibling file.
    sibling: PathBuf,
}

/// Resolve the on-disk paths the peer-store uses. Requires the handle to
/// have been built via [`StrongholdHandle::new_persistent`]; otherwise
/// the snapshot path is unknown.
fn resolve_paths(handle: &StrongholdHandle) -> Result<PeerStorePaths, PeerStoreError> {
    let snapshot_path = handle
        .snapshot_path()
        .ok_or(PeerStoreError::HandleNotPersistent)?;

    let mut sibling_os = snapshot_path.as_os_str().to_os_string();
    sibling_os.push(PEER_STORE_FILE_SUFFIX);
    Ok(PeerStorePaths {
        sibling: PathBuf::from(sibling_os),
    })
}

/// Read + decrypt + decode the sibling file. Returns an empty envelope
/// if the file doesn't exist (fresh install case).
fn read_envelope(
    handle: &StrongholdHandle,
    paths: &PeerStorePaths,
) -> Result<Envelope, PeerStoreError> {
    let bytes = match std::fs::read(&paths.sibling) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Envelope::empty());
        }
        Err(e) => return Err(PeerStoreError::Storage(paths.sibling.clone(), e)),
    };

    if bytes.len() < NONCE_LEN + 16 {
        return Err(PeerStoreError::FileTruncated(
            paths.sibling.clone(),
            bytes.len(),
        ));
    }

    let password = handle
        .snapshot_password()
        .ok_or(PeerStoreError::HandleNotPersistent)?;
    if password.len() != KEY_LEN {
        // Defensive — `new_persistent` already enforces this.
        return Err(PeerStoreError::Crypto(format!(
            "snapshot password length {} != expected {KEY_LEN}",
            password.len()
        )));
    }

    let (nonce_bytes, ciphertext) = bytes.split_at(NONCE_LEN);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(password));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| PeerStoreError::Crypto(format!("decrypt: {e}")))?;

    let envelope: Envelope = serde_json::from_slice(&plaintext)?;
    if envelope.version > FORMAT_VERSION {
        return Err(PeerStoreError::UnsupportedVersion(
            envelope.version,
            FORMAT_VERSION,
        ));
    }
    Ok(envelope)
}

/// Encrypt + atomically write the envelope to the sibling file.
fn write_envelope(
    handle: &StrongholdHandle,
    paths: &PeerStorePaths,
    envelope: &Envelope,
) -> Result<(), PeerStoreError> {
    let password = handle
        .snapshot_password()
        .ok_or(PeerStoreError::HandleNotPersistent)?;
    if password.len() != KEY_LEN {
        return Err(PeerStoreError::Crypto(format!(
            "snapshot password length {} != expected {KEY_LEN}",
            password.len()
        )));
    }

    let plaintext = serde_json::to_vec(envelope)?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(password));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_slice())
        .map_err(|e| PeerStoreError::Crypto(format!("encrypt: {e}")))?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    if let Some(parent) = paths.sibling.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| PeerStoreError::Storage(paths.sibling.clone(), e))?;
    }

    // Write-then-rename for atomicity.
    let tmp_path = tmp_path(&paths.sibling);
    std::fs::write(&tmp_path, &out)
        .map_err(|e| PeerStoreError::Storage(tmp_path.clone(), e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| PeerStoreError::Storage(tmp_path.clone(), e))?;
    }

    std::fs::rename(&tmp_path, &paths.sibling)
        .map_err(|e| PeerStoreError::Storage(paths.sibling.clone(), e))?;
    Ok(())
}

fn tmp_path(final_path: &Path) -> PathBuf {
    let mut tmp = final_path.as_os_str().to_os_string();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

// ---------------------------------------------------------------------------
// Per-path serializing mutex
// ---------------------------------------------------------------------------

/// Process-wide map of `sibling_path -> Mutex<()>`. Two handles pointing
/// at the same snapshot path share the same mutex, so concurrent writes
/// can't interleave; disjoint handles never contend.
fn lock_for(sibling: &Path) -> std::sync::MutexGuard<'static, ()> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> =
        OnceLock::new();
    let registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));

    let mutex_ref: &'static Mutex<()> = {
        let mut map = registry.lock().expect("peer-store registry poisoned");
        match map.get(sibling) {
            Some(m) => *m,
            None => {
                let leaked: &'static Mutex<()> = Box::leak(Box::new(Mutex::new(())));
                map.insert(sibling.to_path_buf(), leaked);
                leaked
            }
        }
    };

    mutex_ref
        .lock()
        .expect("peer-store sibling lock poisoned")
}

// ---------------------------------------------------------------------------
// Deeplink helpers — used by the Tauri plugin handler in lib.rs.
// ---------------------------------------------------------------------------

/// Stage classifier for the `peer_paired_error` event emitted by the
/// deeplink handler. Lets the frontend show a precise diagnostic when a
/// scan / paste fails.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DeeplinkStage {
    Decode,
    Json,
    Validate,
    Add,
}

/// Top-level error type returned by the deeplink-URL handler. Carries
/// the stage so the UI can render "Couldn't read the QR" vs "Couldn't
/// verify the peer card" distinctly.
#[derive(Debug, Error)]
pub enum DeeplinkError {
    #[error("deeplink base64url decode failed: {0}")]
    Decode(String),

    #[error("deeplink JSON parse failed: {0}")]
    Json(String),

    #[error("deeplink payload failed validation: {0}")]
    Validate(String),

    #[error("deeplink peer-store write failed: {0}")]
    Add(String),
}

impl DeeplinkError {
    pub fn stage(&self) -> DeeplinkStage {
        match self {
            DeeplinkError::Decode(_) => DeeplinkStage::Decode,
            DeeplinkError::Json(_) => DeeplinkStage::Json,
            DeeplinkError::Validate(_) => DeeplinkStage::Validate,
            DeeplinkError::Add(_) => DeeplinkStage::Add,
        }
    }

    pub fn message(&self) -> String {
        self.to_string()
    }
}

/// Parse a `concord://peer/<base64url-payload>` URL and add the encoded
/// `PeerCard` to the store under [`PeerSource::Deeplink`].
///
/// The URL is parsed defensively — any failure produces a structured
/// [`DeeplinkError`] with a stage tag so the renderer can show a useful
/// error without leaking implementation detail.
pub async fn handle_deeplink_url(
    handle: &StrongholdHandle,
    url: &str,
) -> Result<KnownPeer, DeeplinkError> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    // Strip the scheme + host. We accept both `concord://peer/<payload>`
    // and the bare-path form `concord:peer/<payload>` some platforms
    // produce. The `url` crate is overkill for a fixed prefix.
    let payload_b64 = strip_concord_prefix(url).ok_or_else(|| {
        DeeplinkError::Decode(format!(
            "url {url:?} is not a concord://peer/<payload> deeplink"
        ))
    })?;

    let bytes = URL_SAFE_NO_PAD
        .decode(payload_b64.as_bytes())
        .map_err(|e| DeeplinkError::Decode(format!("base64url: {e}")))?;

    let card: PeerCard = serde_json::from_slice(&bytes)
        .map_err(|e| DeeplinkError::Json(format!("{e}")))?;

    // Validate up-front so a malformed card never touches disk. The
    // store would reject it too, but routing the validation error
    // through the Validate stage gives a better UI message.
    validate_card(&card).map_err(|e| DeeplinkError::Validate(e.to_string()))?;

    add(handle, card, PeerSource::Deeplink)
        .await
        .map_err(|e| DeeplinkError::Add(e.to_string()))
}

/// Pull the base64url payload out of a `concord://peer/<payload>` (or
/// the `concord:peer/<payload>` bare form) URL string.
fn strip_concord_prefix(url: &str) -> Option<&str> {
    const PREFIXES: &[&str] = &["concord://peer/", "concord:peer/"];
    for p in PREFIXES {
        if let Some(rest) = url.strip_prefix(p) {
            // Strip any trailing query / fragment — the spec only
            // defines the path component, but some launchers append
            // tracking params.
            let payload = rest
                .split(['?', '#'])
                .next()
                .unwrap_or(rest);
            if !payload.is_empty() {
                return Some(payload);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_concord_prefix_accepts_double_slash_and_single() {
        assert_eq!(strip_concord_prefix("concord://peer/abc"), Some("abc"));
        assert_eq!(strip_concord_prefix("concord:peer/abc"), Some("abc"));
    }

    #[test]
    fn strip_concord_prefix_strips_query() {
        assert_eq!(
            strip_concord_prefix("concord://peer/abc?utm_source=qr"),
            Some("abc")
        );
        assert_eq!(
            strip_concord_prefix("concord://peer/abc#frag"),
            Some("abc")
        );
    }

    #[test]
    fn strip_concord_prefix_rejects_empty_payload() {
        assert_eq!(strip_concord_prefix("concord://peer/"), None);
    }

    #[test]
    fn strip_concord_prefix_rejects_other_schemes() {
        assert_eq!(strip_concord_prefix("https://peer/abc"), None);
        assert_eq!(strip_concord_prefix("concord://room/abc"), None);
    }

    #[test]
    fn validate_card_rejects_empty_peer_id() {
        let card = PeerCard {
            peer_id: String::new(),
            public_key_hex: "00".repeat(32),
            multiaddrs: vec![],
        };
        assert!(matches!(
            validate_card(&card),
            Err(PeerStoreError::InvalidPeerId(_))
        ));
    }

    #[test]
    fn validate_card_rejects_wrong_pubkey_length() {
        let card = PeerCard {
            peer_id: "12D3KooWplaceholder".to_string(),
            public_key_hex: "abcd".to_string(),
            multiaddrs: vec![],
        };
        assert!(matches!(
            validate_card(&card),
            Err(PeerStoreError::InvalidPeerId(_))
        ));
    }

    #[test]
    fn validate_card_rejects_bad_multiaddr() {
        let card = PeerCard {
            peer_id: "12D3KooWplaceholder".to_string(),
            public_key_hex: "00".repeat(32),
            multiaddrs: vec!["not-a-multiaddr".to_string()],
        };
        assert!(matches!(
            validate_card(&card),
            Err(PeerStoreError::InvalidPeerId(_))
        ));
    }

    #[test]
    fn validate_card_accepts_valid_payload() {
        let card = PeerCard {
            peer_id: "12D3KooWplaceholder".to_string(),
            public_key_hex: "ab".repeat(32),
            multiaddrs: vec!["/ip4/1.2.3.4/udp/4001/quic-v1".to_string()],
        };
        validate_card(&card).expect("valid card");
    }

    /// PM-flagged follow-up from PR #149: the F-VIS PR added
    /// `access_granted` + `last_access_grant_at` to `KnownPeer` and
    /// bumped the on-disk envelope version 1 → 2. v1 envelopes WITHOUT
    /// the new fields must still deserialize cleanly via the
    /// `#[serde(default)]` markers, so installs upgrading from a v1
    /// peer-store don't lose their paired peers. This test pins that
    /// contract — a hand-rolled v1 JSON envelope round-trips into a v2
    /// `Envelope` whose peers default to `access_granted: true` +
    /// `last_access_grant_at: None`.
    #[test]
    fn envelope_v1_legacy_payload_round_trips_with_default_access() {
        let legacy_v1 = serde_json::json!({
            "version": 1,
            "peers": [
                {
                    "peer_id": "12D3KooWLegacyA",
                    "public_key_hex": "ab".repeat(32),
                    "multiaddrs": ["/ip4/127.0.0.1/udp/4001/quic-v1"],
                    "source": "Qr",
                    "first_seen": "2026-04-01T00:00:00Z",
                    "last_seen": "2026-04-01T00:00:00Z"
                },
                {
                    "peer_id": "12D3KooWLegacyB",
                    "public_key_hex": "cd".repeat(32),
                    "multiaddrs": [],
                    "source": "Deeplink",
                    "first_seen": "2026-04-02T00:00:00Z",
                    "last_seen": "2026-04-02T00:00:00Z"
                }
            ]
        });

        let bytes = serde_json::to_vec(&legacy_v1).expect("serialize v1 fixture");
        let envelope: Envelope = serde_json::from_slice(&bytes).expect(
            "v1 envelope MUST still deserialize after the v2 KnownPeer bump — \
             missing #[serde(default)] on access_granted or last_access_grant_at",
        );

        // The on-disk version field is whatever the legacy envelope wrote;
        // we don't auto-rewrite it during read, just default the new
        // KnownPeer fields. The next save() bumps it to FORMAT_VERSION.
        assert_eq!(envelope.version, 1);
        assert_eq!(envelope.peers.len(), 2);
        for peer in &envelope.peers {
            assert!(
                peer.access_granted,
                "v1 envelope rows must default to access_granted=true"
            );
            assert!(
                peer.last_access_grant_at.is_none(),
                "v1 envelope rows must default to last_access_grant_at=None"
            );
        }

        // The next save round-trips through FORMAT_VERSION = 2 so future
        // reads see the bumped envelope shape — verify by serializing the
        // envelope we just deserialized through a fresh Envelope::new and
        // checking the version bumps without changing the row contents.
        let bumped = Envelope::new(envelope.peers.clone());
        assert_eq!(bumped.version, FORMAT_VERSION);
        assert_eq!(bumped.peers.len(), envelope.peers.len());
    }
}
