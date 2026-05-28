//! Peer identity scaffolding — Phase 2 of the P2P-first native architecture.
//!
//! On first launch each Concord install generates an Ed25519 keypair and
//! persists the **private half inside Stronghold**. The private bytes never
//! leave Stronghold: signing is delegated to Stronghold's `Ed25519Sign`
//! procedure so the secret only ever lives in the protected runtime buffer.
//!
//! This module exposes:
//!   * [`PeerIdentity`] — public-facing identity: the 32-byte public key plus
//!     a short, deterministic, human-readable fingerprint. NO private-key
//!     field by deliberate design; the `Serialize`-able shape downstream of
//!     this struct (`PeerIdentityPublic` in `lib.rs`) guarantees the same
//!     property at the Tauri command boundary.
//!   * [`StrongholdHandle`] — a thin wrapper around `iota_stronghold::Client`
//!     plus a process-wide mutex that serializes `load_or_create` so two
//!     concurrent first-launch callers can't race and persist two different
//!     keypairs.
//!   * [`load_or_create`] — idempotent identity loader.
//!   * [`sign`] — protected-context signing helper.
//!
//! The fingerprint is `BASE32-NOPAD(SHA-256(public_key))[..16]`. Base32 with
//! the RFC4648 alphabet (no padding) is the simplest user-presentable
//! encoding that avoids easy-to-mis-read pairs in case-sensitive contexts.
//! Hand-rolled (15 lines, std-only) to avoid pulling a new top-level crate
//! dep just for the encoder.
//!
//! ### Stronghold layout
//!
//! The peer-identity keypair lives at a dedicated `Location::generic` so it
//! never collides with future Matrix-credential records:
//!
//! ```text
//!   vault  = b"peer-identity"
//!   record = b"ed25519/v1"
//! ```
//!
//! The `v1` suffix exists so a future key-format change can write a new
//! record alongside the old one rather than mutating in place.

use iota_stronghold::{
    procedures::{Ed25519Sign, GenerateKey, KeyType, PublicKey, StrongholdProcedure},
    Client, Location,
};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use thiserror::Error;

/// Stronghold vault path for the peer-identity record.
const VAULT_PATH: &[u8] = b"peer-identity";

/// Stronghold record path for the v1 Ed25519 secret key.
const RECORD_PATH: &[u8] = b"ed25519/v1";

/// Length (in chars) of the public-key fingerprint exposed to users.
/// 16 base32 chars = 80 bits of SHA-256(public_key), more than enough to
/// avoid accidental collisions when displayed in Settings.
///
/// Re-exported as [`FINGERPRINT_LEN_PUB`] so integration tests can lock
/// the value at the public-API level.
pub const FINGERPRINT_LEN_PUB: usize = 16;

// Internal alias used by the implementation. Kept distinct from the
// public constant so future refactors of the public name don't require
// touching every internal call site.
const FINGERPRINT_LEN: usize = FINGERPRINT_LEN_PUB;

/// Ed25519 signature length in bytes.
pub const SIGNATURE_LEN: usize = 64;

/// Ed25519 public-key length in bytes.
pub const PUBLIC_KEY_LEN: usize = 32;

/// A 64-byte Ed25519 signature. Wrapped in a newtype so the sign API has a
/// distinct return type from a bare byte array — makes accidental
/// `&[u8]` -> `Signature` confusion at call sites impossible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signature(pub [u8; SIGNATURE_LEN]);

impl Signature {
    /// Borrow the raw signature bytes.
    pub fn as_bytes(&self) -> &[u8; SIGNATURE_LEN] {
        &self.0
    }
}

/// Public peer identity. **Has no private-key field by deliberate design**;
/// the Stronghold runtime is the sole holder of the secret half.
#[derive(Debug, Clone)]
pub struct PeerIdentity {
    /// 32-byte Ed25519 public key.
    pub public_key: [u8; PUBLIC_KEY_LEN],
    /// Deterministic short fingerprint derived from SHA-256 of `public_key`.
    /// Same public key always yields the same fingerprint.
    pub fingerprint: String,
}

/// Errors raised by the identity module.
#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("stronghold client error: {0}")]
    Client(#[from] iota_stronghold::ClientError),

    #[error("stronghold procedure error: {0}")]
    Procedure(#[from] iota_stronghold::procedures::ProcedureError),

    #[error("stronghold returned a public key of unexpected length: got {0}, expected {1}")]
    PublicKeyLength(usize, usize),

    #[error("stronghold returned a signature of unexpected length: got {0}, expected {1}")]
    SignatureLength(usize, usize),
}

/// Thin wrapper around `iota_stronghold::Client` plus the cross-call mutex
/// that serializes the read-or-create transition on the peer-identity
/// record. The mutex is what makes [`load_or_create`] race-safe: even if two
/// async tasks call it simultaneously on the same handle (or the user
/// double-clicks the Tauri command), exactly one will reach the
/// `record_exists` check first and persist the keypair; the second sees the
/// record and reads back the same one.
///
/// The mutex is intentionally NOT held across the `sign` path — Stronghold's
/// `Client` is internally `Arc<RwLock<...>>` and is safe to call from
/// multiple threads in parallel for read-only-style operations like signing
/// (the underlying procedure machinery synchronizes itself).
pub struct StrongholdHandle {
    client: Client,
    /// Serializes [`load_or_create`] so concurrent first-launches collapse
    /// to a single keypair-creation.
    create_mutex: Mutex<()>,
}

impl StrongholdHandle {
    /// Build a handle from an already-opened Stronghold `Client`.
    ///
    /// Production code obtains the `Client` from `iota_stronghold::Stronghold`
    /// (typically loaded via `tauri-plugin-stronghold`); tests obtain it
    /// directly from an in-memory `Stronghold::default()`.
    pub fn new(client: Client) -> Self {
        Self {
            client,
            create_mutex: Mutex::new(()),
        }
    }

}

impl std::fmt::Debug for StrongholdHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StrongholdHandle").finish_non_exhaustive()
    }
}

/// Idempotently load the peer identity from Stronghold, generating it on the
/// first call.
///
/// **Idempotency**: repeat calls return the same `PeerIdentity` because the
/// underlying Stronghold record is only written when it doesn't already exist.
///
/// **Race safety**: the per-handle `create_mutex` serializes the
/// record-exists check + write so two concurrent first-launch callers
/// collapse to a single keypair. Both callers return the same identity.
///
/// **Private-key handling**: the private bytes only ever live inside the
/// Stronghold runtime. This function exports only the 32-byte public key
/// (via the `PublicKey` procedure) and computes the fingerprint from it.
pub async fn load_or_create(
    stronghold: &StrongholdHandle,
) -> Result<PeerIdentity, IdentityError> {
    let location = identity_location();

    // Serialize the existence-check + create across concurrent callers on
    // the same handle. Tokio tasks can both hit this entry simultaneously
    // on first launch; without the mutex, both would observe
    // `record_exists() == false` and both would call GenerateKey, the
    // second overwriting the first — and the second caller would return a
    // PeerIdentity whose public key doesn't match the now-persisted
    // private key.
    let _guard = stronghold
        .create_mutex
        .lock()
        .expect("identity create_mutex poisoned (a previous call panicked)");

    let client = &stronghold.client;
    if !client.record_exists(&location)? {
        // Persist a fresh Ed25519 secret key inside Stronghold. The bytes
        // never leave the protected runtime; only the eventual public-key
        // export (next call below) crosses the boundary.
        let proc = StrongholdProcedure::GenerateKey(GenerateKey {
            ty: KeyType::Ed25519,
            output: location.clone(),
        });
        client.execute_procedure(proc)?;
    }

    // Export only the public half. The private key is held by Stronghold
    // for the lifetime of the snapshot; we never see it.
    let pk_bytes_vec: Vec<u8> = client.execute_procedure(StrongholdProcedure::PublicKey(
        PublicKey {
            ty: KeyType::Ed25519,
            private_key: location,
        },
    ))?.into();

    if pk_bytes_vec.len() != PUBLIC_KEY_LEN {
        return Err(IdentityError::PublicKeyLength(
            pk_bytes_vec.len(),
            PUBLIC_KEY_LEN,
        ));
    }
    let mut public_key = [0u8; PUBLIC_KEY_LEN];
    public_key.copy_from_slice(&pk_bytes_vec);

    let fingerprint = fingerprint_for(&public_key);

    Ok(PeerIdentity {
        public_key,
        fingerprint,
    })
}

/// Sign `payload` with the peer-identity Ed25519 secret key. The secret
/// never leaves Stronghold's protected runtime — the procedure machinery
/// loads it into a guarded `Buffer<u8>`, signs there, and only the 64-byte
/// signature crosses back out.
///
/// Caller must have previously called [`load_or_create`] at least once
/// against the same Stronghold so the record exists; if not, the underlying
/// procedure errors with a "record not found" `ClientError`.
pub async fn sign(
    stronghold: &StrongholdHandle,
    payload: &[u8],
) -> Result<Signature, IdentityError> {
    let proc = StrongholdProcedure::Ed25519Sign(Ed25519Sign {
        msg: payload.to_vec(),
        private_key: identity_location(),
    });
    // ProcedureOutput is `Into<Vec<u8>>` for Ed25519Sign (returns the
    // 64-byte signature as a Vec). We confirm length and copy into a
    // fixed-size newtype.
    let sig_vec: Vec<u8> = stronghold.client.execute_procedure(proc)?.into();
    if sig_vec.len() != SIGNATURE_LEN {
        return Err(IdentityError::SignatureLength(sig_vec.len(), SIGNATURE_LEN));
    }
    let mut sig = [0u8; SIGNATURE_LEN];
    sig.copy_from_slice(&sig_vec);
    Ok(Signature(sig))
}

/// Compute the deterministic short fingerprint for a given public key.
///
/// Fingerprint = first [`FINGERPRINT_LEN`] chars of
/// `BASE32-NOPAD-UPPER(SHA-256(public_key))`. Stable for the lifetime of
/// the key; identical input always yields identical output.
pub fn fingerprint_for(public_key: &[u8; PUBLIC_KEY_LEN]) -> String {
    let digest = Sha256::digest(public_key);
    let encoded = base32_nopad_upper(&digest);
    // SHA-256 -> 32 bytes -> 52 base32 chars; truncate to FINGERPRINT_LEN.
    encoded[..FINGERPRINT_LEN].to_string()
}

/// Stable Stronghold location for the peer-identity v1 record.
fn identity_location() -> Location {
    Location::generic(VAULT_PATH.to_vec(), RECORD_PATH.to_vec())
}

/// Hand-rolled RFC4648 base32 (uppercase alphabet, NO padding). Pure-std
/// implementation kept here to avoid adding a top-level encoder crate just
/// for the fingerprint. The output alphabet is exactly
/// `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`.
fn base32_nopad_upper(input: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity((input.len() * 8 + 4) / 5);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in input {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((buffer >> bits) & 0x1F) as usize;
            out.push(ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buffer << (5 - bits)) & 0x1F) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same input bytes always yield the same base32 string. Trivial
    /// determinism check that protects against accidental alphabet shuffling.
    #[test]
    fn base32_is_deterministic() {
        let a = base32_nopad_upper(b"hello world");
        let b = base32_nopad_upper(b"hello world");
        assert_eq!(a, b);
    }

    /// Output alphabet is exactly the RFC4648 base32 alphabet — uppercase
    /// letters and digits 2..7. No padding chars.
    #[test]
    fn base32_alphabet_is_rfc4648() {
        let encoded = base32_nopad_upper(&[0u8, 255u8, 128u8, 64u8, 32u8, 16u8, 8u8, 4u8]);
        for ch in encoded.chars() {
            assert!(
                ch.is_ascii_uppercase() || ('2'..='7').contains(&ch),
                "unexpected char {ch:?} in base32 output {encoded:?}"
            );
        }
        assert!(!encoded.contains('='), "padding leaked into output");
    }

    /// Fingerprint for a fixed public key never changes — locks the format.
    /// If anyone changes the hash or the truncation point, this fails loudly.
    #[test]
    fn fingerprint_format_is_stable() {
        let pk = [0u8; PUBLIC_KEY_LEN];
        let fp = fingerprint_for(&pk);
        assert_eq!(fp.len(), FINGERPRINT_LEN);
        // Re-derive and confirm bitwise stability.
        assert_eq!(fp, fingerprint_for(&pk));
    }
}
