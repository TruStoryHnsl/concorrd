//! F-A — append-only on-disk record of the user's trust-edge declarations.
//!
//! Sits alongside the peer-store sibling file in the
//! `<snapshot_path>.concord_user_trust.log.enc` file. Each line is one
//! ChaCha20-Poly1305-encrypted [`TrustLogEntry`] (a `TrustEdge` or a
//! `TrustEdgeRevocation`). Append-only — adding an entry seeks to the
//! end and writes; revoking an edge writes a NEW entry of kind
//! `Revocation` rather than mutating any existing line.
//!
//! ## Why a log instead of a JSON envelope
//!
//! peer_store uses a single encrypted JSON blob because the store is
//! small AND the operations are read-modify-write (e.g. `mark_seen`).
//! The trust log is strictly append-only by spec — revoking an edge is a
//! new line, never an edit — so a log-shaped file is simpler and matches
//! the spec literally: the bytes on disk reflect the sequence of user
//! decisions, not a digest.
//!
//! The log is encrypted line-by-line so that a partial write at process
//! exit can leave at most ONE corrupted tail entry, which the reader
//! skips at parse time. The header at the top of every entry is a
//! 4-byte big-endian length so we can advance past corrupt entries
//! without consulting the rest of the file.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use rand::RngCore;
use std::collections::HashMap;
use thiserror::Error;

use crate::servitude::identity::StrongholdHandle;

use super::{
    ConcordUid, ServerId, TrustEdge, TrustEdgeId, TrustEdgeRevocation, TrustLogEntry,
};

/// File-extension suffix appended to the Stronghold snapshot path to
/// derive the trust-log path. Mirrors the Phase 4 `.seed.enc` /
/// peer-store `.peer_store.json.enc` patterns.
const TRUST_LOG_FILE_SUFFIX: &str = ".concord_user_trust.log.enc";

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

// One on-disk record header. 4 bytes length prefix; the bytes after that
// are nonce || ciphertext(serde_json(TrustLogEntry)).
const RECORD_LENGTH_PREFIX_BYTES: usize = 4;

#[derive(Debug, Error)]
pub enum TrustStoreError {
    #[error("trust-store storage error at {0}: {1}")]
    Storage(PathBuf, std::io::Error),

    #[error("trust-store crypto failure: {0}")]
    Crypto(String),

    #[error("trust-store json error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("trust-store requires a persistent Stronghold handle")]
    HandleNotPersistent,

    #[error("signature on the supplied trust entry does not verify")]
    InvalidSignature,

    #[error("attempt to revoke unknown edge_id: {0}")]
    UnknownEdgeId(TrustEdgeId),
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Append a fresh trust-edge declaration to the log.
///
/// **Verifies the signature** before persisting. If the supplied edge's
/// Ed25519 signature does not match its declared `concord_uid`, the call
/// returns [`TrustStoreError::InvalidSignature`] WITHOUT touching disk.
/// This is the load-bearing safety net: nothing in the store can ever
/// have a signature that doesn't verify under its own declared key.
pub async fn add_edge(
    handle: &StrongholdHandle,
    edge: TrustEdge,
) -> Result<(), TrustStoreError> {
    if !edge.verify() {
        return Err(TrustStoreError::InvalidSignature);
    }
    let entry = TrustLogEntry::Edge(edge);
    append_entry(handle, &entry).await
}

/// Append a revocation of an existing edge. The revocation must be signed
/// by the hero who declared the original edge; this function does NOT
/// look up the edge in the store first — it just signs + appends. The
/// merge view picks up the revocation on the next read.
///
/// Returns [`TrustStoreError::UnknownEdgeId`] if the edge has never been
/// declared in this log. Use [`list_edges`] to check before calling.
pub async fn revoke_edge(
    handle: &StrongholdHandle,
    revocation: TrustEdgeRevocation,
) -> Result<(), TrustStoreError> {
    if !revocation.verify() {
        return Err(TrustStoreError::InvalidSignature);
    }
    let edge_id = revocation.edge_id.clone();
    let log = list_log(handle).await?;
    if !log.iter().any(|e| e.edge_id() == edge_id) {
        return Err(TrustStoreError::UnknownEdgeId(edge_id));
    }
    let entry = TrustLogEntry::Revocation(revocation);
    append_entry(handle, &entry).await
}

/// Replay the on-disk log and return every entry, in append order.
pub async fn list_log(
    handle: &StrongholdHandle,
) -> Result<Vec<TrustLogEntry>, TrustStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.log);
    read_log(handle, &paths)
}

/// Return the CURRENTLY-ACTIVE edges (after replaying revocations). An
/// edge is active iff the latest entry for its `edge_id` is a
/// [`TrustLogEntry::Edge`].
pub async fn list_edges(
    handle: &StrongholdHandle,
) -> Result<Vec<TrustEdge>, TrustStoreError> {
    let entries = list_log(handle).await?;
    let mut latest: HashMap<TrustEdgeId, TrustLogEntry> = HashMap::new();
    for entry in entries {
        let id = entry.edge_id().to_string();
        let ts = entry.timestamp();
        match latest.get(&id) {
            None => {
                latest.insert(id, entry);
            }
            Some(prev) if entry_strictly_newer(&entry, prev, ts) => {
                latest.insert(id, entry);
            }
            _ => {}
        }
    }
    let mut edges: Vec<TrustEdge> = latest
        .into_values()
        .filter_map(|e| match e {
            TrustLogEntry::Edge(edge) => Some(edge),
            TrustLogEntry::Revocation(_) => None,
        })
        .collect();
    edges.sort_by(|a, b| a.edge_id.cmp(&b.edge_id));
    Ok(edges)
}

fn entry_strictly_newer(candidate: &TrustLogEntry, current: &TrustLogEntry, _ts: u64) -> bool {
    let c = candidate.timestamp();
    let p = current.timestamp();
    c > p || (c == p)
    // Tie → candidate (later-appended) wins. We're iterating in append
    // order, so the candidate IS the later entry.
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

struct TrustStorePaths {
    log: PathBuf,
}

fn resolve_paths(handle: &StrongholdHandle) -> Result<TrustStorePaths, TrustStoreError> {
    let snapshot_path = handle
        .snapshot_path()
        .ok_or(TrustStoreError::HandleNotPersistent)?;
    let mut log_os = snapshot_path.as_os_str().to_os_string();
    log_os.push(TRUST_LOG_FILE_SUFFIX);
    Ok(TrustStorePaths {
        log: PathBuf::from(log_os),
    })
}

async fn append_entry(
    handle: &StrongholdHandle,
    entry: &TrustLogEntry,
) -> Result<(), TrustStoreError> {
    let paths = resolve_paths(handle)?;
    let _guard = lock_for(&paths.log);

    let password = handle
        .snapshot_password()
        .ok_or(TrustStoreError::HandleNotPersistent)?;
    if password.len() != KEY_LEN {
        return Err(TrustStoreError::Crypto(format!(
            "snapshot password length {} != expected {KEY_LEN}",
            password.len()
        )));
    }

    let plaintext = serde_json::to_vec(entry)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(password));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_slice())
        .map_err(|e| TrustStoreError::Crypto(format!("encrypt: {e}")))?;

    let mut record = Vec::with_capacity(
        RECORD_LENGTH_PREFIX_BYTES + NONCE_LEN + ciphertext.len(),
    );
    let total_payload_len = (NONCE_LEN + ciphertext.len()) as u32;
    record.extend_from_slice(&total_payload_len.to_be_bytes());
    record.extend_from_slice(&nonce_bytes);
    record.extend_from_slice(&ciphertext);

    if let Some(parent) = paths.log.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| TrustStoreError::Storage(paths.log.clone(), e))?;
    }

    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&paths.log)
        .map_err(|e| TrustStoreError::Storage(paths.log.clone(), e))?;
    file.write_all(&record)
        .map_err(|e| TrustStoreError::Storage(paths.log.clone(), e))?;
    file.sync_data()
        .map_err(|e| TrustStoreError::Storage(paths.log.clone(), e))?;
    Ok(())
}

fn read_log(
    handle: &StrongholdHandle,
    paths: &TrustStorePaths,
) -> Result<Vec<TrustLogEntry>, TrustStoreError> {
    let bytes = match std::fs::read(&paths.log) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(TrustStoreError::Storage(paths.log.clone(), e)),
    };

    let password = handle
        .snapshot_password()
        .ok_or(TrustStoreError::HandleNotPersistent)?;
    if password.len() != KEY_LEN {
        return Err(TrustStoreError::Crypto(format!(
            "snapshot password length {} != expected {KEY_LEN}",
            password.len()
        )));
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(password));

    let mut out: Vec<TrustLogEntry> = Vec::new();
    let mut cursor: usize = 0;
    while cursor + RECORD_LENGTH_PREFIX_BYTES <= bytes.len() {
        let len_bytes: [u8; 4] = bytes[cursor..cursor + 4]
            .try_into()
            .expect("4 bytes available");
        let payload_len = u32::from_be_bytes(len_bytes) as usize;
        cursor += RECORD_LENGTH_PREFIX_BYTES;
        if cursor + payload_len > bytes.len() {
            // Truncated tail — stop here. Append-only semantics mean a
            // partial write at process exit can leave a half-record; we
            // silently skip it instead of failing the whole read.
            log::warn!(
                target: "concord::concord_user::trust_store",
                "truncated trust-log entry at offset {} ({} required, {} available)",
                cursor, payload_len, bytes.len() - cursor
            );
            break;
        }
        let payload = &bytes[cursor..cursor + payload_len];
        cursor += payload_len;
        if payload.len() < NONCE_LEN + 16 {
            log::warn!(
                target: "concord::concord_user::trust_store",
                "skipping too-short trust-log entry ({} bytes)",
                payload.len()
            );
            continue;
        }
        let (nonce_bytes, ciphertext) = payload.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = match cipher.decrypt(nonce, ciphertext) {
            Ok(pt) => pt,
            Err(e) => {
                log::warn!(
                    target: "concord::concord_user::trust_store",
                    "skipping un-decryptable trust-log entry: {e}"
                );
                continue;
            }
        };
        match serde_json::from_slice::<TrustLogEntry>(&plaintext) {
            Ok(entry) => {
                // Defensive: only accept entries whose signatures verify.
                // Anything else is corruption / tampering and is skipped.
                let ok = match &entry {
                    TrustLogEntry::Edge(e) => e.verify(),
                    TrustLogEntry::Revocation(r) => r.verify(),
                };
                if ok {
                    out.push(entry);
                } else {
                    log::warn!(
                        target: "concord::concord_user::trust_store",
                        "skipping trust-log entry with bad signature"
                    );
                }
            }
            Err(e) => {
                log::warn!(
                    target: "concord::concord_user::trust_store",
                    "skipping un-parseable trust-log entry: {e}"
                );
            }
        }
    }
    Ok(out)
}

/// Per-path serializing mutex (mirrors the peer-store pattern).
fn lock_for(log_path: &Path) -> std::sync::MutexGuard<'static, ()> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();
    let registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    let mutex_ref: &'static Mutex<()> = {
        let mut map = registry.lock().expect("trust-store registry poisoned");
        match map.get(log_path) {
            Some(m) => *m,
            None => {
                let leaked: &'static Mutex<()> = Box::leak(Box::new(Mutex::new(())));
                map.insert(log_path.to_path_buf(), leaked);
                leaked
            }
        }
    };
    mutex_ref.lock().expect("trust-store sibling lock poisoned")
}

// Silence dead-code lint for currently-unused re-exports — these are
// part of the public API and may be referenced by future modules /
// tests, but the file itself doesn't reach them.
#[allow(dead_code)]
fn _ensure_imports_used() {
    let _ = std::mem::size_of::<ConcordUid>();
    let _ = std::mem::size_of::<ServerId>();
}
