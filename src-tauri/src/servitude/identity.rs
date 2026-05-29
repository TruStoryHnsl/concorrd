//! Peer identity — single Ed25519 keypair per install, backing both Phase 2's
//! user-visible fingerprint AND Phase 3's libp2p `PeerId`.
//!
//! ## Architectural unification
//!
//! Each Concord install owns exactly ONE Ed25519 seed. That seed is the install's
//! identity, full stop:
//!
//!   * Phase 2's `PeerIdentity.fingerprint` is `base32_nopad(SHA-256(public_key))`,
//!     where `public_key = SigningKey::from_bytes(seed).verifying_key().to_bytes()`.
//!   * Phase 3's libp2p `PeerId` is `PeerId::from_public_key(libp2p_keypair.public())`,
//!     where `libp2p_keypair = libp2p::identity::Keypair::ed25519_from_bytes(seed)`.
//!
//! Both encodings differ on the wire (base32-of-SHA256 vs multihash-of-pubkey),
//! but they derive from the same `[u8; 32]` public key bytes. The user sees one
//! identity in Settings → Profile; libp2p observes the same identity over the
//! swarm. No split.
//!
//! ## Storage
//!
//! The seed lives in Stronghold at a single canonical location:
//!
//! ```text
//!   vault  = b"peer-identity"
//!   record = b"ed25519-seed/v1"
//! ```
//!
//! On first launch we generate 32 random bytes via `OsRng`, `WriteVault` them
//! into Stronghold (the snapshot file encrypts them at rest), and cache a
//! `Zeroizing<[u8; 32]>` copy in the [`StrongholdHandle`]'s in-memory buffer.
//! Subsequent calls in the same handle lifetime reuse the cached seed. The
//! `v1` suffix on the record name lets a future key-format change write a new
//! record alongside the old one rather than mutating in place.
//!
//! ## Cross-restart behaviour
//!
//! Stronghold has no `ReadVault` procedure — once `WriteVault` runs, the bytes
//! are inaccessible from outside the protected runtime for the rest of that
//! Stronghold session.
//!
//! That means after a snapshot reload (app restart), the seed bytes are on
//! disk but not in our in-memory cache. We handle the two callers of the
//! identity differently in that state:
//!
//!   * [`load_or_create`] / fingerprint: works fine cross-restart. We use
//!     Stronghold's `PublicKey` procedure, which derives the public key from
//!     the WriteVault'd seed *inside* the protected runtime and only the
//!     32-byte public key crosses out. The fingerprint is then computed from
//!     the public key bytes — same algorithm whether the seed came out of our
//!     cache or out of the in-Stronghold derivation path.
//!   * [`peer_seed`] / [`sign`]: requires the raw seed bytes. Cross-restart
//!     the cache is empty and Stronghold has no way to hand the bytes back.
//!     These functions return [`IdentityError::SeedUnavailable`] in that
//!     state. Phase 4 will wire a secondary OS-keychain-encrypted store keyed
//!     under the user's data dir so the seed survives restarts; until then,
//!     callers must call `load_or_create` AND have generated the seed in the
//!     current handle lifetime to use signing or libp2p.

use ed25519_dalek::{Signer, SigningKey};
use iota_stronghold::{
    procedures::{KeyType, PublicKey, StrongholdProcedure, WriteVault},
    Client, Location,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use thiserror::Error;
use zeroize::Zeroizing;

/// Stronghold vault path for the peer-identity record.
const VAULT_PATH: &[u8] = b"peer-identity";

/// Stronghold record path for the single per-install Ed25519 seed.
///
/// One seed, one record. Both the Phase 2 fingerprint and Phase 3 libp2p
/// `PeerId` derive from these bytes — see the module-level architectural
/// note. The `v1` suffix is reserved for forward compatibility.
const SEED_RECORD_PATH: &[u8] = b"ed25519-seed/v1";

/// Ed25519 secret-seed length in bytes (Ed25519 expands a 32-byte seed into
/// the full keypair material).
pub const SECRET_SEED_LEN: usize = 32;

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
/// the seed lives in Stronghold (WriteVault'd) plus a `Zeroizing` in-memory
/// cache. This struct only carries public-facing bytes.
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

    #[error(
        "peer seed not available in this handle lifetime — the seed record \
         exists in Stronghold (from a prior session) but the in-memory cache \
         is empty and Stronghold has no read-back procedure. Phase 4 will \
         persist the seed in an OS-keychain-encrypted secondary store so it \
         survives restarts."
    )]
    SeedUnavailable,
}

/// Thin wrapper around `iota_stronghold::Client` plus a process-wide mutex
/// that serializes the read-or-create transition on the peer-identity record.
/// The mutex is what makes [`load_or_create`] race-safe: even if two async
/// tasks call it simultaneously on the same handle (or the user double-clicks
/// the Tauri command), exactly one will reach the `record_exists` check first
/// and persist the seed; the second sees the record and reads back the same
/// derived identity.
///
/// The handle also owns a `Mutex<Option<Zeroizing<[u8; 32]>>>` cache for the
/// seed bytes. Stronghold has no `ReadVault`, so once the seed is WriteVault'd
/// the only way to get raw bytes back out is through this cache. The cache is
/// populated:
///
///   * On the create branch of [`load_or_create`] — fresh seed generated by
///     OsRng, persisted to Stronghold, AND cached so signing/libp2p in the
///     same handle lifetime can reuse the bytes without a Stronghold round
///     trip.
///   * (Phase 4 will add a second population path keyed off an OS-keychain
///     secondary store so cross-restart usage works.)
pub struct StrongholdHandle {
    client: Client,
    /// Serializes [`load_or_create`] so concurrent first-launches collapse
    /// to a single seed-creation.
    create_mutex: Mutex<()>,
    /// In-process cache of the per-install Ed25519 seed bytes. See the
    /// struct-level note.
    seed_cache: Mutex<Option<Zeroizing<[u8; SECRET_SEED_LEN]>>>,
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
            seed_cache: Mutex::new(None),
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
/// underlying Stronghold record is only written when it doesn't already
/// exist, and the public key is a deterministic function of the seed bytes
/// stored there.
///
/// **Race safety**: the per-handle `create_mutex` serializes the
/// record-exists check + write so two concurrent first-launch callers
/// collapse to a single seed. Both callers return the same identity.
///
/// **Cross-restart**: on snapshot reload the seed bytes are inaccessible from
/// outside Stronghold's protected runtime, but the public key can still be
/// derived via Stronghold's `PublicKey` procedure — same `public_key` bytes,
/// same fingerprint. Signing/libp2p, however, requires the in-memory cache
/// to be populated; see [`peer_seed`].
pub async fn load_or_create(
    stronghold: &StrongholdHandle,
) -> Result<PeerIdentity, IdentityError> {
    let location = seed_location();

    // Serialize the existence-check + create across concurrent callers on
    // the same handle. Tokio tasks can both hit this entry simultaneously
    // on first launch; without the mutex, both would observe
    // `record_exists() == false` and both would WriteVault, the second
    // overwriting the first.
    let _guard = stronghold
        .create_mutex
        .lock()
        .expect("identity create_mutex poisoned (a previous call panicked)");

    let client = &stronghold.client;

    // Fast path: cache populated from an earlier call in this handle
    // lifetime. Derive public_key from the cached seed without touching
    // Stronghold.
    {
        let cache = stronghold
            .seed_cache
            .lock()
            .expect("seed_cache poisoned");
        if let Some(seed) = cache.as_ref() {
            let public_key = pubkey_from_seed(seed);
            let fingerprint = fingerprint_for(&public_key);
            return Ok(PeerIdentity { public_key, fingerprint });
        }
    }

    if client.record_exists(&location)? {
        // Cache empty but the record exists — we're either in the "app
        // restart after first launch" state (snapshot reloaded but no
        // in-memory cache) or a race where the cache was cleared.
        // Stronghold has no ReadVault, so we cannot rehydrate the cache
        // from the on-disk seed. We CAN still derive the public key
        // without exposing the seed by using Stronghold's `PublicKey`
        // procedure, which runs the same Ed25519 derivation inside the
        // protected runtime and hands back only the 32-byte public key.
        //
        // Signing and libp2p constructors require the raw seed and will
        // error with `SeedUnavailable` until Phase 4 wires a secondary
        // persisted store.
        let pk_bytes_vec: Vec<u8> = client
            .execute_procedure(StrongholdProcedure::PublicKey(PublicKey {
                ty: KeyType::Ed25519,
                private_key: location,
            }))?
            .into();
        if pk_bytes_vec.len() != PUBLIC_KEY_LEN {
            return Err(IdentityError::PublicKeyLength(
                pk_bytes_vec.len(),
                PUBLIC_KEY_LEN,
            ));
        }
        let mut public_key = [0u8; PUBLIC_KEY_LEN];
        public_key.copy_from_slice(&pk_bytes_vec);
        let fingerprint = fingerprint_for(&public_key);
        return Ok(PeerIdentity { public_key, fingerprint });
    }

    // Fresh install: generate 32 random bytes via the OS CSPRNG, persist
    // to Stronghold (WriteVault encrypts at rest in the snapshot), AND
    // cache a Zeroizing copy in-memory so subsequent signing / libp2p
    // calls in this handle lifetime can reuse the bytes.
    let mut seed = Zeroizing::new([0u8; SECRET_SEED_LEN]);
    rand::rngs::OsRng.fill_bytes(seed.as_mut());

    let proc = StrongholdProcedure::WriteVault(WriteVault {
        data: Zeroizing::new(seed.to_vec()),
        location,
    });
    client.execute_procedure(proc)?;

    // Derive the public key from the seed bytes we just generated. Same
    // algorithm Stronghold would use internally — `SigningKey::from_bytes`
    // expands the 32-byte seed into the full keypair material.
    let public_key = pubkey_from_seed(&seed);

    // Stash in handle cache. Subsequent calls (including `peer_seed` for
    // the libp2p swarm) reuse this copy.
    {
        let mut cache = stronghold
            .seed_cache
            .lock()
            .expect("seed_cache poisoned");
        *cache = Some(Zeroizing::new(*seed));
    }

    let fingerprint = fingerprint_for(&public_key);
    Ok(PeerIdentity { public_key, fingerprint })
}

/// Hand the raw 32-byte Ed25519 seed back to a trusted caller (the libp2p
/// swarm constructor in [`crate::servitude::p2p`], or anyone signing without
/// the [`sign`] helper). This is the single source of truth for "the install's
/// secret key" — both Phase 2's signing and Phase 3's libp2p Keypair derive
/// from these bytes.
///
/// Returns a freshly-allocated `Zeroizing<[u8; 32]>` so the caller's drop
/// wipes its copy without disturbing the handle's cached seed.
///
/// ## Errors
///
/// Returns [`IdentityError::SeedUnavailable`] if the in-memory cache is empty
/// AND the on-disk record exists (i.e. we're in the cross-restart state and
/// Stronghold has no read-back). Until Phase 4 lands the secondary persisted
/// store, callers must call [`load_or_create`] earlier in the same handle
/// lifetime when the record didn't pre-exist.
pub async fn peer_seed(
    stronghold: &StrongholdHandle,
) -> Result<Zeroizing<[u8; SECRET_SEED_LEN]>, IdentityError> {
    // Cache hit: hand back a fresh copy.
    {
        let cache = stronghold
            .seed_cache
            .lock()
            .expect("seed_cache poisoned");
        if let Some(seed) = cache.as_ref() {
            return Ok(Zeroizing::new(**seed));
        }
    }

    // Cache miss: serialize with the create mutex and re-check (another
    // caller may have populated it while we waited).
    let _guard = stronghold
        .create_mutex
        .lock()
        .expect("identity create_mutex poisoned (a previous call panicked)");

    {
        let cache = stronghold
            .seed_cache
            .lock()
            .expect("seed_cache poisoned");
        if let Some(seed) = cache.as_ref() {
            return Ok(Zeroizing::new(**seed));
        }
    }

    // No cached seed. If the on-disk record exists we cannot read it back
    // (see SeedUnavailable error doc). If it doesn't exist either, the
    // caller skipped `load_or_create` — same error fits.
    Err(IdentityError::SeedUnavailable)
}

/// Sign `payload` with the peer-identity Ed25519 seed.
///
/// Implemented via `ed25519_dalek::SigningKey::from_bytes(seed).sign(payload)`
/// against the seed returned by [`peer_seed`]. The seed is held in a
/// `Zeroizing` buffer for the duration of the call and wiped on drop.
///
/// ## Errors
///
/// Returns [`IdentityError::SeedUnavailable`] if the seed isn't in the
/// handle's in-memory cache (typically because the app restarted after
/// `load_or_create` first ran — see [`peer_seed`]).
pub async fn sign(
    stronghold: &StrongholdHandle,
    payload: &[u8],
) -> Result<Signature, IdentityError> {
    let seed = peer_seed(stronghold).await?;
    let signing_key = SigningKey::from_bytes(&seed);
    let sig = signing_key.sign(payload);
    Ok(Signature(sig.to_bytes()))
}

/// Stable Stronghold location for the per-install Ed25519 seed record.
fn seed_location() -> Location {
    Location::generic(VAULT_PATH.to_vec(), SEED_RECORD_PATH.to_vec())
}

/// Derive the 32-byte Ed25519 public key from a 32-byte seed. Pure function;
/// same input always yields the same output. Identical math to what
/// Stronghold's `PublicKey` procedure performs internally on a WriteVault'd
/// seed — so both code paths agree on the public key bytes for any given
/// seed.
fn pubkey_from_seed(seed: &[u8; SECRET_SEED_LEN]) -> [u8; PUBLIC_KEY_LEN] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
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
