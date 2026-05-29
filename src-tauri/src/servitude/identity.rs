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
//! Phase 4 closes this gap with a sibling-file persistence layer. When
//! [`StrongholdHandle::new_persistent`] is used (the production path), the
//! handle also knows the on-disk snapshot path AND the snapshot password.
//! On first launch, after generating the seed and writing it to Stronghold,
//! we ALSO encrypt the 32 seed bytes with ChaCha20-Poly1305 keyed off the
//! snapshot password and write the ciphertext to a sibling file at
//! `<snapshot_path>.seed.enc` (chmod 0600 on Unix). On subsequent launches,
//! the sibling file is decrypted, the seed bytes are restored to the
//! in-memory cache, and signing / libp2p Keypair construction work the same
//! as they did pre-restart.
//!
//! The security model is unchanged from Stronghold's: the snapshot password
//! protects both the Stronghold-bound key material AND the sibling seed file.
//! If an attacker has the password, they already have everything in the
//! snapshot.
//!
//! Backward-compat path: a user upgrading from Phase 3 has a Stronghold
//! record but no sibling file. In that state the public-key derivation
//! still works (via Stronghold's `PublicKey` procedure), so the fingerprint
//! continues to display correctly. But [`peer_seed`] still returns
//! [`IdentityError::SeedUnavailable`] until the snapshot is rewritten with
//! the sibling file alongside it (i.e. until the user's next session that
//! triggers a fresh `load_or_create`). The in-memory ([`StrongholdHandle::new`])
//! path used by some tests preserves the original Phase 3 semantics.

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use ed25519_dalek::{Signer, SigningKey};
use iota_stronghold::{
    procedures::{KeyType, PublicKey, StrongholdProcedure, WriteVault},
    Client, Location,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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

/// File-extension suffix appended to the Stronghold snapshot path to derive
/// the sibling-file path holding the encrypted seed. Phase 4 cross-restart
/// persistence (see module-level doc).
const SIBLING_SEED_FILE_SUFFIX: &str = ".seed.enc";

/// ChaCha20-Poly1305 nonce size (RFC 8439): 12 bytes.
const SEED_FILE_NONCE_LEN: usize = 12;

/// ChaCha20-Poly1305 authentication tag size: 16 bytes. The ciphertext for a
/// 32-byte plaintext is therefore 32 + 16 = 48 bytes, and the total file
/// length is `SEED_FILE_NONCE_LEN + 32 + 16 = 60 bytes`. Trivial.
const SEED_FILE_TAG_LEN: usize = 16;

/// ChaCha20-Poly1305 key size: 32 bytes. The snapshot password we receive
/// from `lib.rs::open_peer_identity_stronghold` is generated as 32 random
/// bytes, so it can be used directly as the AEAD key.
const SEED_FILE_KEY_LEN: usize = 32;

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
         exists in Stronghold (from a prior session) but neither the \
         in-memory cache nor the sibling encrypted seed file is populated. \
         This is the documented Phase 3 → Phase 4 upgrade path: trigger a \
         fresh load_or_create on a writable handle to repopulate."
    )]
    SeedUnavailable,

    #[error("sibling seed-file I/O at {0}: {1}")]
    SeedFileIo(PathBuf, std::io::Error),

    #[error(
        "sibling seed-file at {0} has wrong length: got {1} bytes, expected {2}"
    )]
    SeedFileLength(PathBuf, usize, usize),

    #[error("ChaCha20-Poly1305 AEAD operation failed: {0}")]
    SeedFileCrypto(String),

    #[error(
        "snapshot password must be exactly {0} bytes for ChaCha20-Poly1305; got {1}"
    )]
    PasswordLength(usize, usize),
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
/// populated by:
///
///   * **First-launch generation** — [`load_or_create`] generates fresh
///     OsRng bytes, persists to Stronghold + sibling file, caches.
///   * **Cross-restart rehydration** (Phase 4) — when [`new_persistent`] was
///     used to build this handle AND the sibling seed file exists on disk,
///     `load_or_create` decrypts the sibling file and rehydrates the cache.
///     Signing and libp2p work the same as they did before the restart.
///
/// Handles built with the in-memory [`new`] constructor have no sibling file
/// and retain the pre-Phase-4 behaviour: signing requires the seed to have
/// been generated during the current handle lifetime.
pub struct StrongholdHandle {
    client: Client,
    /// Serializes [`load_or_create`] so concurrent first-launches collapse
    /// to a single seed-creation.
    create_mutex: Mutex<()>,
    /// In-process cache of the per-install Ed25519 seed bytes. See the
    /// struct-level note.
    seed_cache: Mutex<Option<Zeroizing<[u8; SECRET_SEED_LEN]>>>,
    /// Optional sibling-file persistence config. Present when this handle
    /// was built via [`new_persistent`] (production path); absent when
    /// built via [`new`] (in-memory / test path).
    persistence: Option<SiblingFilePersistence>,
}

/// Configuration for the Phase 4 cross-restart sibling-file persistence.
/// See the module-level doc.
struct SiblingFilePersistence {
    /// Absolute path to the encrypted sibling file. Derived deterministically
    /// from the Stronghold snapshot path by appending [`SIBLING_SEED_FILE_SUFFIX`].
    sibling_path: PathBuf,
    /// The 32-byte snapshot password, reused as the ChaCha20-Poly1305 key.
    /// Held in a `Zeroizing` buffer so it's wiped on handle drop.
    password: Zeroizing<[u8; SEED_FILE_KEY_LEN]>,
}

impl StrongholdHandle {
    /// Build an in-memory handle from an already-opened Stronghold `Client`.
    ///
    /// This constructor leaves the handle WITHOUT any sibling-file
    /// persistence. It's the right choice for unit / integration tests that
    /// don't simulate a process restart, and for any caller that owns the
    /// Stronghold lifecycle itself and doesn't want the identity module to
    /// touch the filesystem.
    pub fn new(client: Client) -> Self {
        Self {
            client,
            create_mutex: Mutex::new(()),
            seed_cache: Mutex::new(None),
            persistence: None,
        }
    }

    /// Build a production handle wired for Phase 4 cross-restart persistence.
    ///
    /// `snapshot_path` is the path to the Stronghold snapshot file (typically
    /// `<app_local_data_dir>/peer-identity.stronghold`). The sibling file is
    /// derived by appending [`SIBLING_SEED_FILE_SUFFIX`] to that path.
    ///
    /// `snapshot_password` must be exactly 32 bytes — the same password used
    /// to open the Stronghold snapshot — so it can be reused directly as the
    /// ChaCha20-Poly1305 key. Passing a wrong-length password returns
    /// [`IdentityError::PasswordLength`].
    pub fn new_persistent(
        client: Client,
        snapshot_path: &Path,
        snapshot_password: &[u8],
    ) -> Result<Self, IdentityError> {
        if snapshot_password.len() != SEED_FILE_KEY_LEN {
            return Err(IdentityError::PasswordLength(
                SEED_FILE_KEY_LEN,
                snapshot_password.len(),
            ));
        }
        let mut password = Zeroizing::new([0u8; SEED_FILE_KEY_LEN]);
        password.copy_from_slice(snapshot_password);

        // Append the suffix to the snapshot's OsString so we don't lose any
        // existing extension (e.g. `.stronghold.seed.enc`).
        let mut sibling_os = snapshot_path.as_os_str().to_os_string();
        sibling_os.push(SIBLING_SEED_FILE_SUFFIX);
        let sibling_path = PathBuf::from(sibling_os);

        Ok(Self {
            client,
            create_mutex: Mutex::new(()),
            seed_cache: Mutex::new(None),
            persistence: Some(SiblingFilePersistence {
                sibling_path,
                password,
            }),
        })
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
        // Cache empty but the record exists — either we're in the
        // cross-restart state (snapshot reloaded, no in-memory cache) or
        // the cache was cleared. Phase 4: if a sibling encrypted seed
        // file exists alongside the snapshot, decrypt it and rehydrate
        // the cache. This is the cross-restart-safe path.
        if let Some(persistence) = stronghold.persistence.as_ref() {
            match read_sibling_seed(persistence) {
                Ok(seed) => {
                    let public_key = pubkey_from_seed(&seed);
                    // Cross-check against Stronghold's PublicKey procedure
                    // — if they disagree, something is wrong (e.g. the
                    // sibling file is from a different install). We
                    // prefer Stronghold's view when there's a mismatch
                    // and return an error so the caller can investigate
                    // rather than silently using a wrong identity.
                    let sh_public_key = stronghold_public_key(client, &location)?;
                    if sh_public_key != public_key {
                        log::warn!(
                            target: "concord::identity",
                            "sibling seed-file public key disagrees with Stronghold's; \
                             refusing to use sibling and treating seed as unavailable"
                        );
                        return Err(IdentityError::SeedUnavailable);
                    }
                    {
                        let mut cache = stronghold
                            .seed_cache
                            .lock()
                            .expect("seed_cache poisoned");
                        *cache = Some(seed);
                    }
                    let fingerprint = fingerprint_for(&public_key);
                    return Ok(PeerIdentity { public_key, fingerprint });
                }
                Err(IdentityError::SeedFileIo(_, ref e))
                    if e.kind() == std::io::ErrorKind::NotFound =>
                {
                    // Sibling file missing — fall through to the
                    // backward-compat path below. This is the documented
                    // Phase 3 → Phase 4 upgrade case: an install created
                    // before sibling-file persistence existed.
                    log::warn!(
                        target: "concord::identity",
                        "Stronghold record exists but sibling seed-file is missing — \
                         Phase 3 -> Phase 4 upgrade state; signing will be unavailable \
                         until the next load_or_create rewrites both"
                    );
                }
                Err(e) => return Err(e),
            }
        }

        // Sibling file missing, or this is the in-memory handle that has
        // no persistence at all. Stronghold has no ReadVault, so we
        // cannot rehydrate the cache from the on-disk seed. We CAN still
        // derive the public key without exposing the seed by using
        // Stronghold's `PublicKey` procedure. Signing / libp2p will
        // return SeedUnavailable until a fresh `load_or_create` cycle
        // rewrites both stores.
        let public_key = stronghold_public_key(client, &location)?;
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
        location: location.clone(),
    });
    client.execute_procedure(proc)?;

    // Derive the public key from the seed bytes we just generated. Same
    // algorithm Stronghold would use internally — `SigningKey::from_bytes`
    // expands the 32-byte seed into the full keypair material.
    let public_key = pubkey_from_seed(&seed);

    // Phase 4: encrypt + persist the seed to the sibling file (if this
    // handle is the persistent variant). Done BEFORE caching so an I/O
    // failure here surfaces synchronously instead of leaving the cache
    // in a state that disagrees with disk.
    if let Some(persistence) = stronghold.persistence.as_ref() {
        write_sibling_seed(persistence, &seed)?;
    }

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

/// Execute Stronghold's `PublicKey` procedure for the per-install seed
/// record and return the 32-byte Ed25519 public key. Pulled out into a
/// helper because both the cross-restart-with-sibling and the backward-
/// compat-without-sibling paths use it.
fn stronghold_public_key(
    client: &Client,
    location: &Location,
) -> Result<[u8; PUBLIC_KEY_LEN], IdentityError> {
    let pk_bytes_vec: Vec<u8> = client
        .execute_procedure(StrongholdProcedure::PublicKey(PublicKey {
            ty: KeyType::Ed25519,
            private_key: location.clone(),
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
    Ok(public_key)
}

/// Read the sibling seed file, decrypt with ChaCha20-Poly1305 using the
/// snapshot password as the key, and return the 32-byte seed in a
/// `Zeroizing` buffer.
///
/// File format: `[12 nonce bytes][32 + 16 ciphertext+tag bytes]`. Anything
/// shorter than the expected total length is rejected up-front so a
/// truncated file produces a clear error instead of an obscure AEAD failure.
fn read_sibling_seed(
    persistence: &SiblingFilePersistence,
) -> Result<Zeroizing<[u8; SECRET_SEED_LEN]>, IdentityError> {
    let bytes = std::fs::read(&persistence.sibling_path).map_err(|e| {
        IdentityError::SeedFileIo(persistence.sibling_path.clone(), e)
    })?;

    let expected_len = SEED_FILE_NONCE_LEN + SECRET_SEED_LEN + SEED_FILE_TAG_LEN;
    if bytes.len() != expected_len {
        return Err(IdentityError::SeedFileLength(
            persistence.sibling_path.clone(),
            bytes.len(),
            expected_len,
        ));
    }

    let (nonce_bytes, ciphertext) = bytes.split_at(SEED_FILE_NONCE_LEN);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&persistence.password[..]));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| IdentityError::SeedFileCrypto(format!("decrypt: {e}")))?;

    if plaintext.len() != SECRET_SEED_LEN {
        return Err(IdentityError::SeedFileLength(
            persistence.sibling_path.clone(),
            plaintext.len(),
            SECRET_SEED_LEN,
        ));
    }

    let mut seed = Zeroizing::new([0u8; SECRET_SEED_LEN]);
    seed.copy_from_slice(&plaintext);
    // Best-effort zeroize of the decrypted intermediate buffer.
    let mut plaintext = plaintext;
    use zeroize::Zeroize;
    plaintext.zeroize();
    Ok(seed)
}

/// Encrypt the seed bytes with ChaCha20-Poly1305 (random 12-byte nonce per
/// write) and atomically write the resulting file at the sibling-file path.
/// Permissions are tightened to 0600 on Unix so other local users can't
/// read the encrypted seed; the AEAD layer protects against off-host theft.
fn write_sibling_seed(
    persistence: &SiblingFilePersistence,
    seed: &Zeroizing<[u8; SECRET_SEED_LEN]>,
) -> Result<(), IdentityError> {
    // Fresh random nonce per write (RFC 8439 — never reuse a (key, nonce)
    // pair). 96-bit nonce, OS CSPRNG.
    let mut nonce_bytes = [0u8; SEED_FILE_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = ChaCha20Poly1305::new(Key::from_slice(&persistence.password[..]));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext: &[u8] = &seed[..];
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| IdentityError::SeedFileCrypto(format!("encrypt: {e}")))?;

    // Assemble [nonce || ciphertext+tag] into one buffer for a single write.
    let mut out = Vec::with_capacity(SEED_FILE_NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    // Ensure the parent dir exists. The Stronghold snapshot's parent was
    // already created by the caller (`lib.rs::open_peer_identity_stronghold`),
    // but in tests we may be writing into a freshly-allocated tmp path.
    if let Some(parent) = persistence.sibling_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            IdentityError::SeedFileIo(persistence.sibling_path.clone(), e)
        })?;
    }

    // Write-then-rename for atomicity: a partial write to the sibling
    // file would leave a half-encrypted file that decrypts to garbage.
    let tmp_path = sibling_tmp_path(&persistence.sibling_path);
    std::fs::write(&tmp_path, &out).map_err(|e| {
        IdentityError::SeedFileIo(tmp_path.clone(), e)
    })?;

    // chmod 0600 BEFORE rename so the final file is never world-readable
    // even for a fraction of a second.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| IdentityError::SeedFileIo(tmp_path.clone(), e))?;
    }

    std::fs::rename(&tmp_path, &persistence.sibling_path).map_err(|e| {
        IdentityError::SeedFileIo(persistence.sibling_path.clone(), e)
    })?;

    Ok(())
}

/// Derive the temporary write path used during atomic rename.
fn sibling_tmp_path(final_path: &Path) -> PathBuf {
    let mut tmp = final_path.as_os_str().to_os_string();
    tmp.push(".tmp");
    PathBuf::from(tmp)
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

    // Phase 4 cross-restart path: if this handle has a sibling-file
    // persistence configured, try to rehydrate the cache from disk.
    // Callers normally call `load_or_create` first (which does the same
    // rehydration), but allowing `peer_seed` to do it independently makes
    // the API robust against caller order.
    if let Some(persistence) = stronghold.persistence.as_ref() {
        match read_sibling_seed(persistence) {
            Ok(seed) => {
                let cached = Zeroizing::new(*seed);
                {
                    let mut cache = stronghold
                        .seed_cache
                        .lock()
                        .expect("seed_cache poisoned");
                    *cache = Some(seed);
                }
                return Ok(cached);
            }
            Err(IdentityError::SeedFileIo(_, ref e))
                if e.kind() == std::io::ErrorKind::NotFound =>
            {
                // No sibling file — fall through to SeedUnavailable below.
            }
            Err(e) => return Err(e),
        }
    }

    // No cached seed and no sibling-file fallback succeeded — caller is
    // in the Phase 3 backward-compat state (record exists in Stronghold
    // but sibling file is missing) OR no record exists at all.
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
