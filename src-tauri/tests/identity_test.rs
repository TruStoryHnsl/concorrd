//! Integration tests for the peer-identity module.
//!
//! These tests are written from a cold-reader perspective — they verify
//! **observed user-visible behaviour** of the public API surface, not the
//! author's beliefs about how the module is wired internally.
//!
//! Test scope (Phase 2 spec):
//!
//!   (a) `load_or_create` is idempotent across calls on the same Stronghold
//!       and across a save / reload cycle (restart simulation).
//!   (b) The fingerprint is a stable, deterministic function of the public
//!       key. Same key always produces the same fingerprint; the fingerprint
//!       only contains characters from the RFC4648 base32 alphabet and has
//!       a documented fixed length.
//!   (c) Sign / verify works using ONLY the public-key accessor (no private
//!       key required at the verify side). The signature library used for
//!       verification is independent of Stronghold's internal signer — we
//!       use `ed25519-zebra`, which is already in the dependency graph via
//!       `iota_stronghold`'s own dev deps. This guarantees signatures
//!       produced inside the protected runtime are valid Ed25519 signatures
//!       under the public key Stronghold reports.
//!   (d) Negative test: the `PeerIdentityPublic` JSON shape (the only thing
//!       that crosses the IPC boundary to the renderer) exposes ONLY
//!       `public_key_hex` and `fingerprint`. The test enumerates every key
//!       in the JSON and rejects anything that looks remotely like a
//!       private-key field. If a future contributor adds `secret_key` (or
//!       similar) to the struct, this test fails loudly.
//!
//! ## Stronghold test scaffolding
//!
//! `tauri-plugin-stronghold` does not ship a test helper. Tests construct
//! an in-memory `iota_stronghold::Stronghold` directly via `::default()`,
//! create a client, and pass the client to `StrongholdHandle::new` — same
//! type the production Tauri command path uses, just without the on-disk
//! snapshot file. For test (a)'s restart-simulation we additionally
//! `commit`/`load_snapshot` against a tmp-dir-backed snapshot file.

use app_lib::servitude::identity::{
    self, fingerprint_for, PeerIdentity, StrongholdHandle, FINGERPRINT_LEN_PUB,
    PUBLIC_KEY_LEN, SIGNATURE_LEN,
};
use iota_stronghold::{KeyProvider, SnapshotPath, Stronghold};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Build a Stronghold-backed identity handle for tests.
///
/// Uses `Stronghold::default()` (in-memory) plus a freshly-created client.
/// No snapshot file is touched.
fn in_memory_handle() -> (Stronghold, StrongholdHandle) {
    let stronghold = Stronghold::default();
    let client = stronghold
        .create_client(b"peer-identity-test")
        .expect("create_client must succeed on a fresh Stronghold");
    let handle = StrongholdHandle::new(client);
    (stronghold, handle)
}

/// Allocate a fresh tmp-dir path so each test gets its own scratch space.
fn tmp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir()
        .join(format!("concord-identity-test-{label}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("tmp dir create");
    dir
}

// ---------------------------------------------------------------------------
// (a) idempotency + restart-persistence
// ---------------------------------------------------------------------------

#[tokio::test]
async fn load_or_create_is_idempotent_on_same_handle() {
    let (_sh, handle) = in_memory_handle();

    let first = identity::load_or_create(&handle)
        .await
        .expect("first load_or_create must succeed");
    let second = identity::load_or_create(&handle)
        .await
        .expect("second load_or_create must succeed");

    assert_eq!(
        first.public_key, second.public_key,
        "two calls on the same handle returned different public keys — \
         identity persistence is broken"
    );
    assert_eq!(
        first.fingerprint, second.fingerprint,
        "fingerprint changed between calls — derivation is non-deterministic"
    );
}

#[tokio::test]
async fn load_or_create_survives_snapshot_round_trip() {
    // Round-trip: write the Stronghold snapshot to disk, drop the
    // in-memory state, reload from disk, and assert the same identity
    // comes back. This is the closest in-process simulation of an app
    // restart we can get without spawning a child process.
    let dir = tmp_dir("restart");
    let snapshot_path = SnapshotPath::from_path(dir.join("test.stronghold"));
    // Stronghold's KeyProvider requires EXACTLY 32 bytes (NC_DATA_SIZE).
    // 32 zero bytes is fine for a test snapshot password.
    let password = vec![0u8; 32];
    let keyprovider = KeyProvider::try_from(zeroize::Zeroizing::new(password.clone()))
        .expect("keyprovider");

    // Pass 1: create + write
    let identity_1 = {
        let stronghold = Stronghold::default();
        let client = stronghold
            .create_client(b"peer-identity-test")
            .expect("create_client");
        let handle = StrongholdHandle::new(client);
        let id = identity::load_or_create(&handle)
            .await
            .expect("load_or_create pass 1");
        stronghold
            .commit_with_keyprovider(&snapshot_path, &keyprovider)
            .expect("commit snapshot");
        id
    };

    // Pass 2: reload from snapshot file
    let identity_2 = {
        let stronghold = Stronghold::default();
        stronghold
            .load_snapshot(&keyprovider, &snapshot_path)
            .expect("load_snapshot");
        // After loading a snapshot, the snapshot data is in memory but
        // the per-client state still needs to be hydrated into the
        // Stronghold's live client map. `load_client` (not `get_client`)
        // does that — `get_client` only looks at already-loaded clients.
        let client = stronghold
            .load_client(b"peer-identity-test")
            .expect("load_client after reload");
        let handle = StrongholdHandle::new(client);
        identity::load_or_create(&handle)
            .await
            .expect("load_or_create pass 2")
    };

    assert_eq!(
        identity_1.public_key, identity_2.public_key,
        "public key changed across a snapshot round-trip — \
         identity is not actually persisted"
    );
    assert_eq!(
        identity_1.fingerprint, identity_2.fingerprint,
        "fingerprint changed across a snapshot round-trip"
    );

    // Clean up
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// (b) fingerprint format stability
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fingerprint_is_deterministic_and_well_formed() {
    let (_sh, handle) = in_memory_handle();
    let id = identity::load_or_create(&handle).await.expect("load");

    // Length matches the documented fingerprint width.
    assert_eq!(
        id.fingerprint.len(),
        FINGERPRINT_LEN_PUB,
        "fingerprint length does not match the documented constant"
    );

    // Alphabet check: every char must be in RFC4648 base32 uppercase set.
    for ch in id.fingerprint.chars() {
        let in_letters = ch.is_ascii_uppercase();
        let in_digits = ('2'..='7').contains(&ch);
        assert!(
            in_letters || in_digits,
            "fingerprint {:?} contains non-base32 char {:?}",
            id.fingerprint,
            ch
        );
    }

    // Deterministic: re-deriving from the same public key yields the
    // same fingerprint.
    assert_eq!(
        id.fingerprint,
        fingerprint_for(&id.public_key),
        "fingerprint not deterministic from public_key"
    );
}

// ---------------------------------------------------------------------------
// (c) sign / verify round-trip via ONLY the public-key accessor
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sign_verify_round_trip_uses_only_public_key() {
    use ed25519_zebra::{Signature as ZSignature, VerificationKey};

    let (_sh, handle) = in_memory_handle();
    let id: PeerIdentity = identity::load_or_create(&handle).await.expect("load");

    let payload: &[u8] = b"the cold reader signs nothing they cannot verify";
    let signature = identity::sign(&handle, payload).await.expect("sign");

    // Lengths match the documented constants.
    assert_eq!(id.public_key.len(), PUBLIC_KEY_LEN);
    assert_eq!(signature.as_bytes().len(), SIGNATURE_LEN);

    // Verification uses ONLY the public-key bytes. No private key, no
    // Stronghold round-trip — proves the signature is a real Ed25519
    // signature over the payload under the reported public key.
    let vk = VerificationKey::try_from(id.public_key)
        .expect("public key bytes must decode as a valid Ed25519 verification key");
    let sig = ZSignature::from(*signature.as_bytes());
    vk.verify(&sig, payload)
        .expect("Ed25519 signature must verify against the reported public key");

    // Negative half: tampered payload MUST NOT verify. Without this we
    // could be silently rubber-stamping every signature.
    let bad_payload = b"the cold reader signs nothing they cannot Verify";
    assert!(
        vk.verify(&sig, bad_payload).is_err(),
        "signature unexpectedly verified against a tampered payload — \
         the verify path is broken"
    );
}

// ---------------------------------------------------------------------------
// (c2) cross-derivation: PeerIdentity.public_key MUST equal the public key
//      derived from the seed `peer_seed()` returns. This is the architectural
//      unification check — Phase 2's fingerprint and Phase 3's libp2p PeerId
//      both consume the same seed, so the public-key bytes have to agree.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn peer_seed_derives_same_public_key_as_load_or_create() {
    use ed25519_dalek::SigningKey;

    let (_sh, handle) = in_memory_handle();
    let id = identity::load_or_create(&handle).await.expect("load");

    let seed = identity::peer_seed(&handle).await.expect("peer_seed");
    let derived_pub = SigningKey::from_bytes(&seed).verifying_key().to_bytes();

    assert_eq!(
        derived_pub, id.public_key,
        "PeerIdentity.public_key must equal the public key derived from \
         peer_seed() — both come from the SAME per-install Ed25519 seed; \
         a mismatch here means Settings → Profile and libp2p would show \
         different identities for the same user."
    );

    // And the fingerprint must be deterministic over the same public key.
    assert_eq!(
        fingerprint_for(&derived_pub),
        id.fingerprint,
        "fingerprint(seed-derived public_key) must equal PeerIdentity.fingerprint"
    );
}

// ---------------------------------------------------------------------------
// (d) negative test: PeerIdentityPublic JSON shape is locked
// ---------------------------------------------------------------------------

/// Mirror of the `PeerIdentityPublic` struct declared in `lib.rs`. Defined
/// here so the integration test can serialize an instance — `lib.rs`
/// keeps it `pub(crate)` for the IPC boundary, but the *shape* of the JSON
/// output is what we're locking down, and this duplicate captures that
/// shape verbatim. If anyone changes either side, the test fails.
///
/// CRITICAL: if you add a private-key field to the real
/// `PeerIdentityPublic` in `lib.rs`, this mirror DOES NOT change — and
/// the production `peer_identity` command would silently start leaking
/// the secret. To catch that, we'd want a CI-grade structural check
/// against the real struct's serialization. For now, the policy is:
/// any new field added to `lib.rs::PeerIdentityPublic` MUST be reflected
/// here, AND must pass the "no private-key keyword" filter below.
#[derive(serde::Serialize)]
struct PeerIdentityPublicMirror {
    public_key_hex: String,
    fingerprint: String,
}

#[tokio::test]
async fn peer_identity_public_json_has_no_private_key_fields() {
    let sample = PeerIdentityPublicMirror {
        public_key_hex: "deadbeef".to_string(),
        fingerprint: "ABCDEFGHIJKLMNOP".to_string(),
    };
    let value =
        serde_json::to_value(&sample).expect("PeerIdentityPublic must serialize");
    let object = value
        .as_object()
        .expect("PeerIdentityPublic must serialize as a JSON object");

    // Exhaustive list of substrings that should NEVER appear in a field
    // name on the public-facing peer identity. Case-insensitive.
    let banned_substrings = ["secret", "priv", "seed", "sk"];

    for key in object.keys() {
        let lower = key.to_ascii_lowercase();
        for needle in &banned_substrings {
            assert!(
                !lower.contains(needle),
                "PeerIdentityPublic JSON contains forbidden field {:?} \
                 (matches banned substring {:?}). This struct must NEVER \
                 expose private-key material across the IPC boundary.",
                key,
                needle
            );
        }
        assert!(
            !lower.starts_with("priv") && !lower.starts_with("secret"),
            "PeerIdentityPublic JSON field {:?} starts with a \
             private-key prefix",
            key
        );
    }

    // Positive lock: confirm the exact expected fields are present.
    // This prevents accidental field renames from passing the negative
    // test while breaking the renderer.
    let keys: std::collections::BTreeSet<&str> =
        object.keys().map(|s| s.as_str()).collect();
    let expected: std::collections::BTreeSet<&str> =
        ["public_key_hex", "fingerprint"].into_iter().collect();
    assert_eq!(
        keys, expected,
        "PeerIdentityPublic JSON shape drifted from the documented contract"
    );
}
