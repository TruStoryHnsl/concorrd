// Simplified E2E encryption module.
//
// Uses X25519 for key exchange and ChaCha20-Poly1305 for symmetric encryption.
// This is a practical starting point — a full Double Ratchet can replace it later.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("encryption failed")]
    EncryptionFailed,
    #[error("decryption failed")]
    DecryptionFailed,
    #[error("invalid nonce length: expected 12, got {0}")]
    InvalidNonceLength(usize),
}

/// A simplified E2E encryption session between two peers.
///
/// Uses a shared secret (derived from X25519 key exchange) with
/// ChaCha20-Poly1305 AEAD. Each message gets a unique nonce derived
/// from a monotonic counter.
pub struct E2ESession {
    shared_secret: [u8; 32],
    send_nonce_counter: u64,
    recv_nonce_counter: u64,
}

impl E2ESession {
    /// Create a session from a shared secret (derived from X25519 key exchange).
    pub fn from_shared_secret(secret: [u8; 32]) -> Self {
        Self {
            shared_secret: secret,
            send_nonce_counter: 0,
            recv_nonce_counter: 0,
        }
    }

    /// Get the shared secret bytes (for persistence).
    pub fn shared_secret(&self) -> &[u8; 32] {
        &self.shared_secret
    }

    /// Get the current send counter.
    pub fn send_count(&self) -> u64 {
        self.send_nonce_counter
    }

    /// Get the current recv counter.
    pub fn recv_count(&self) -> u64 {
        self.recv_nonce_counter
    }

    /// Restore a session with specific counter values.
    pub fn with_counters(mut self, send_count: u64, recv_count: u64) -> Self {
        self.send_nonce_counter = send_count;
        self.recv_nonce_counter = recv_count;
        self
    }

    /// Build a 12-byte nonce from a counter value.
    /// First 4 bytes are zero (reserved), last 8 bytes are the counter in big-endian.
    fn nonce_from_counter(counter: u64) -> [u8; 12] {
        let mut nonce = [0u8; 12];
        nonce[4..12].copy_from_slice(&counter.to_be_bytes());
        nonce
    }

    /// Encrypt a plaintext message. Returns (ciphertext, nonce).
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(Vec<u8>, [u8; 12]), CryptoError> {
        let cipher =
            ChaCha20Poly1305::new_from_slice(&self.shared_secret).map_err(|_| CryptoError::EncryptionFailed)?;

        let nonce_bytes = Self::nonce_from_counter(self.send_nonce_counter);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|_| CryptoError::EncryptionFailed)?;

        self.send_nonce_counter += 1;

        Ok((ciphertext, nonce_bytes))
    }

    /// Decrypt a ciphertext with the given nonce.
    pub fn decrypt(
        &mut self,
        ciphertext: &[u8],
        nonce: &[u8; 12],
    ) -> Result<Vec<u8>, CryptoError> {
        let cipher =
            ChaCha20Poly1305::new_from_slice(&self.shared_secret).map_err(|_| CryptoError::DecryptionFailed)?;

        let nonce_obj = Nonce::from_slice(nonce);

        let plaintext = cipher
            .decrypt(nonce_obj, ciphertext)
            .map_err(|_| CryptoError::DecryptionFailed)?;

        self.recv_nonce_counter += 1;

        Ok(plaintext)
    }
}

/// Generate an X25519 keypair for key exchange.
pub fn generate_x25519_keypair() -> (StaticSecret, PublicKey) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    (secret, public)
}

/// Compute a shared secret from our secret key and their public key.
pub fn compute_shared_secret(
    our_secret: &StaticSecret,
    their_public: &PublicKey,
) -> [u8; 32] {
    let shared = our_secret.diffie_hellman(their_public);
    *shared.as_bytes()
}

// ─── Channel / Server Encryption ────────────────────────────────────

/// Generate a cryptographically random 12-byte nonce.
pub fn generate_random_nonce() -> [u8; 12] {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

/// Generate a cryptographically random 32-byte key (used as server secret).
pub fn generate_random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

/// Derive a channel encryption key from the server key + channel ID.
/// All members of a channel share this key.
pub fn derive_channel_key(server_secret: &[u8; 32], channel_id: &str) -> [u8; 32] {
    // HMAC-SHA256: server_secret as key, "concord-channel-key:" || channel_id as message
    let mut mac =
        <HmacSha256 as KeyInit>::new_from_slice(server_secret).unwrap();
    mac.update(b"concord-channel-key:");
    mac.update(channel_id.as_bytes());
    let result = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

/// Encrypt a message payload for a channel.
pub fn encrypt_channel_message(
    channel_key: &[u8; 32],
    plaintext: &[u8],
) -> Result<(Vec<u8>, [u8; 12]), CryptoError> {
    let cipher = ChaCha20Poly1305::new_from_slice(channel_key)
        .map_err(|_| CryptoError::EncryptionFailed)?;
    let nonce_bytes = generate_random_nonce();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| CryptoError::EncryptionFailed)?;
    Ok((ciphertext, nonce_bytes))
}

/// Decrypt a channel message.
pub fn decrypt_channel_message(
    channel_key: &[u8; 32],
    ciphertext: &[u8],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = ChaCha20Poly1305::new_from_slice(channel_key)
        .map_err(|_| CryptoError::DecryptionFailed)?;
    let nonce = Nonce::from_slice(nonce);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| CryptoError::DecryptionFailed)
}

/// Derive a forum encryption key from a scope string.
///
/// This provides "encrypted radio" — any Concord node can derive the same key,
/// but external observers (non-Concord) cannot read GossipSub traffic.
pub fn derive_forum_key(scope: &str) -> [u8; 32] {
    let mut mac =
        <HmacSha256 as KeyInit>::new_from_slice(b"concord-forum-well-known-seed-v1").unwrap();
    mac.update(b"concord-forum-key:");
    mac.update(scope.as_bytes());
    let result = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

/// Derive a storage encryption key from the user's signing key.
///
/// Used to encrypt sensitive data at rest (TOTP secrets, etc.).
/// The signing key itself is the root of trust — protecting it requires a
/// user passphrase (future enhancement).
pub fn derive_storage_key(signing_key_bytes: &[u8; 32]) -> [u8; 32] {
    let mut mac = <HmacSha256 as KeyInit>::new_from_slice(signing_key_bytes).unwrap();
    mac.update(b"concord-storage-encryption-key");
    let result = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

/// Generate a random device key for local storage encryption.
pub fn generate_device_key() -> [u8; 32] {
    generate_random_key()
}

/// Encrypt identity key bytes for storage using a device key.
pub fn encrypt_identity(device_key: &[u8; 32], signing_key: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
    encrypt_storage(device_key, signing_key)
}

/// Decrypt identity key bytes from storage using a device key.
pub fn decrypt_identity(device_key: &[u8; 32], encrypted: &[u8]) -> Result<Vec<u8>, CryptoError> {
    decrypt_storage(device_key, encrypted)
}

/// Encrypt DM session secrets for storage using a device key.
pub fn encrypt_dm_secret(device_key: &[u8; 32], secret: &[u8]) -> Result<Vec<u8>, CryptoError> {
    encrypt_storage(device_key, secret)
}

/// Decrypt DM session secrets from storage using a device key.
pub fn decrypt_dm_secret(device_key: &[u8; 32], encrypted: &[u8]) -> Result<Vec<u8>, CryptoError> {
    decrypt_storage(device_key, encrypted)
}

/// Encrypt data for local storage using a device key.
pub fn encrypt_storage(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher =
        ChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::EncryptionFailed)?;
    let nonce_bytes = generate_random_nonce();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|_| CryptoError::EncryptionFailed)?;
    // Prepend the nonce so decryption can extract it
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// Decrypt data from local storage using a device key.
/// Expects the nonce prepended (first 12 bytes).
pub fn decrypt_storage(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if data.len() < 12 {
        return Err(CryptoError::DecryptionFailed);
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher =
        ChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::DecryptionFailed)?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| CryptoError::DecryptionFailed)
}

// ─── Peer-to-Peer Key Encryption ──────────────────────────────

/// An encrypted envelope for transmitting secrets to a specific peer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EncryptedEnvelope {
    pub sender_public_key: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
}

/// Encrypt data for a specific peer using an ephemeral X25519 key exchange.
/// The sender generates a one-time keypair and includes the public key in the envelope.
pub fn encrypt_for_peer(
    their_public_bytes: &[u8; 32],
    plaintext: &[u8],
) -> Result<EncryptedEnvelope, CryptoError> {
    let their_public = PublicKey::from(*their_public_bytes);
    let (ephemeral_secret, ephemeral_public) = generate_x25519_keypair();
    let shared = compute_shared_secret(&ephemeral_secret, &their_public);
    let cipher =
        ChaCha20Poly1305::new_from_slice(&shared).map_err(|_| CryptoError::EncryptionFailed)?;
    let nonce_bytes = generate_random_nonce();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| CryptoError::EncryptionFailed)?;
    Ok(EncryptedEnvelope {
        sender_public_key: ephemeral_public.as_bytes().to_vec(),
        ciphertext,
        nonce: nonce_bytes.to_vec(),
    })
}

/// Decrypt an envelope received from another peer using our X25519 secret key.
pub fn decrypt_from_peer(
    our_secret: &StaticSecret,
    envelope: &EncryptedEnvelope,
) -> Result<Vec<u8>, CryptoError> {
    if envelope.sender_public_key.len() != 32 || envelope.nonce.len() != 12 {
        return Err(CryptoError::DecryptionFailed);
    }
    let mut pub_bytes = [0u8; 32];
    pub_bytes.copy_from_slice(&envelope.sender_public_key);
    let their_public = PublicKey::from(pub_bytes);
    let shared = compute_shared_secret(our_secret, &their_public);
    let cipher =
        ChaCha20Poly1305::new_from_slice(&shared).map_err(|_| CryptoError::DecryptionFailed)?;
    let nonce = Nonce::from_slice(&envelope.nonce);
    cipher
        .decrypt(nonce, envelope.ciphertext.as_ref())
        .map_err(|_| CryptoError::DecryptionFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x25519_key_exchange_produces_same_shared_secret() {
        let (alice_secret, alice_public) = generate_x25519_keypair();
        let (bob_secret, bob_public) = generate_x25519_keypair();

        let alice_shared = compute_shared_secret(&alice_secret, &bob_public);
        let bob_shared = compute_shared_secret(&bob_secret, &alice_public);

        assert_eq!(alice_shared, bob_shared);
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (alice_secret, alice_public) = generate_x25519_keypair();
        let (bob_secret, bob_public) = generate_x25519_keypair();

        let shared = compute_shared_secret(&alice_secret, &bob_public);

        let mut alice_session = E2ESession::from_shared_secret(shared);
        let mut bob_session = E2ESession::from_shared_secret(
            compute_shared_secret(&bob_secret, &alice_public),
        );

        let plaintext = b"Hello from Alice to Bob!";
        let (ciphertext, nonce) = alice_session.encrypt(plaintext).unwrap();

        let decrypted = bob_session.decrypt(&ciphertext, &nonce).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn multiple_messages_use_different_nonces() {
        let shared = [42u8; 32];
        let mut session = E2ESession::from_shared_secret(shared);

        let (_, nonce1) = session.encrypt(b"msg1").unwrap();
        let (_, nonce2) = session.encrypt(b"msg2").unwrap();

        assert_ne!(nonce1, nonce2);
        assert_eq!(session.send_count(), 2);
    }

    #[test]
    fn wrong_key_fails_decryption() {
        let shared1 = [1u8; 32];
        let shared2 = [2u8; 32];

        let mut sender = E2ESession::from_shared_secret(shared1);
        let mut receiver = E2ESession::from_shared_secret(shared2);

        let (ciphertext, nonce) = sender.encrypt(b"secret").unwrap();
        assert!(receiver.decrypt(&ciphertext, &nonce).is_err());
    }

    #[test]
    fn session_counter_persistence() {
        let shared = [99u8; 32];
        let session = E2ESession::from_shared_secret(shared).with_counters(10, 5);
        assert_eq!(session.send_count(), 10);
        assert_eq!(session.recv_count(), 5);
    }

    // ─── Channel encryption tests ───────────────────────────────────

    #[test]
    fn channel_key_derivation_deterministic() {
        let server_secret = [42u8; 32];
        let key1 = derive_channel_key(&server_secret, "channel-abc");
        let key2 = derive_channel_key(&server_secret, "channel-abc");
        assert_eq!(key1, key2);
    }

    #[test]
    fn channel_key_differs_by_channel() {
        let server_secret = [42u8; 32];
        let key1 = derive_channel_key(&server_secret, "general");
        let key2 = derive_channel_key(&server_secret, "random");
        assert_ne!(key1, key2);
    }

    #[test]
    fn channel_key_differs_by_server() {
        let secret1 = [1u8; 32];
        let secret2 = [2u8; 32];
        let key1 = derive_channel_key(&secret1, "general");
        let key2 = derive_channel_key(&secret2, "general");
        assert_ne!(key1, key2);
    }

    #[test]
    fn channel_encrypt_decrypt_roundtrip() {
        let server_secret = [42u8; 32];
        let channel_key = derive_channel_key(&server_secret, "test-channel");
        let plaintext = b"Hello, encrypted channel!";

        let (ciphertext, nonce) = encrypt_channel_message(&channel_key, plaintext).unwrap();
        assert_ne!(ciphertext, plaintext.to_vec());

        let decrypted = decrypt_channel_message(&channel_key, &ciphertext, &nonce).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn channel_wrong_key_fails_decryption() {
        let key1 = derive_channel_key(&[1u8; 32], "ch1");
        let key2 = derive_channel_key(&[2u8; 32], "ch1");

        let (ciphertext, nonce) = encrypt_channel_message(&key1, b"secret").unwrap();
        assert!(decrypt_channel_message(&key2, &ciphertext, &nonce).is_err());
    }

    #[test]
    fn forum_key_derivation() {
        let key_local = derive_forum_key("local");
        let key_global = derive_forum_key("global");
        assert_ne!(key_local, key_global);

        // Deterministic
        let key_local2 = derive_forum_key("local");
        assert_eq!(key_local, key_local2);
    }

    #[test]
    fn forum_encrypt_decrypt_roundtrip() {
        let key = derive_forum_key("global");
        let plaintext = b"A forum post";

        let (ct, nonce) = encrypt_channel_message(&key, plaintext).unwrap();
        let decrypted = decrypt_channel_message(&key, &ct, &nonce).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn storage_encrypt_decrypt_roundtrip() {
        let signing_key = [99u8; 32];
        let storage_key = derive_storage_key(&signing_key);
        let data = b"TOTP secret data here";

        let encrypted = encrypt_storage(&storage_key, data).unwrap();
        assert_ne!(&encrypted[12..], data); // ciphertext differs
        assert!(encrypted.len() > data.len()); // nonce + AEAD tag overhead

        let decrypted = decrypt_storage(&storage_key, &encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn storage_wrong_key_fails() {
        let key1 = derive_storage_key(&[1u8; 32]);
        let key2 = derive_storage_key(&[2u8; 32]);

        let encrypted = encrypt_storage(&key1, b"secret").unwrap();
        assert!(decrypt_storage(&key2, &encrypted).is_err());
    }

    #[test]
    fn storage_short_data_fails() {
        let key = derive_storage_key(&[1u8; 32]);
        // Less than 12 bytes (nonce size)
        assert!(decrypt_storage(&key, &[0u8; 5]).is_err());
    }

    #[test]
    fn random_nonce_uniqueness() {
        let n1 = generate_random_nonce();
        let n2 = generate_random_nonce();
        assert_ne!(n1, n2);
    }

    #[test]
    fn random_key_uniqueness() {
        let k1 = generate_random_key();
        let k2 = generate_random_key();
        assert_ne!(k1, k2);
    }

    #[test]
    fn encrypt_for_peer_roundtrip() {
        let (recipient_secret, recipient_public) = generate_x25519_keypair();
        let plaintext = b"server-secret-key-32-bytes-here!";
        let envelope =
            encrypt_for_peer(recipient_public.as_bytes(), plaintext).unwrap();
        let decrypted = decrypt_from_peer(&recipient_secret, &envelope).unwrap();
        assert_eq!(&decrypted, plaintext);
    }

    #[test]
    fn encrypt_for_peer_wrong_recipient_fails() {
        let (_recipient_secret, recipient_public) = generate_x25519_keypair();
        let (wrong_secret, _wrong_public) = generate_x25519_keypair();
        let plaintext = b"secret data";
        let envelope =
            encrypt_for_peer(recipient_public.as_bytes(), plaintext).unwrap();
        let result = decrypt_from_peer(&wrong_secret, &envelope);
        assert!(result.is_err());
    }

    #[test]
    fn device_key_generation() {
        let k1 = generate_device_key();
        let k2 = generate_device_key();
        assert_ne!(k1, k2);
        assert_eq!(k1.len(), 32);
    }

    #[test]
    fn encrypt_identity_roundtrip() {
        let device_key = generate_device_key();
        let signing_key = [42u8; 32];
        let encrypted = encrypt_identity(&device_key, &signing_key).unwrap();
        assert_ne!(&encrypted[12..], &signing_key[..]);
        let decrypted = decrypt_identity(&device_key, &encrypted).unwrap();
        assert_eq!(decrypted.as_slice(), &signing_key);
    }

    #[test]
    fn encrypt_identity_wrong_key_fails() {
        let device_key1 = generate_device_key();
        let device_key2 = generate_device_key();
        let signing_key = [42u8; 32];
        let encrypted = encrypt_identity(&device_key1, &signing_key).unwrap();
        assert!(decrypt_identity(&device_key2, &encrypted).is_err());
    }

    #[test]
    fn encrypt_dm_secret_roundtrip() {
        let device_key = generate_device_key();
        let shared_secret = [99u8; 32];
        let encrypted = encrypt_dm_secret(&device_key, &shared_secret).unwrap();
        let decrypted = decrypt_dm_secret(&device_key, &encrypted).unwrap();
        assert_eq!(decrypted.as_slice(), &shared_secret);
    }

    #[test]
    fn encrypt_dm_secret_wrong_key_fails() {
        let device_key1 = generate_device_key();
        let device_key2 = generate_device_key();
        let shared_secret = [99u8; 32];
        let encrypted = encrypt_dm_secret(&device_key1, &shared_secret).unwrap();
        assert!(decrypt_dm_secret(&device_key2, &encrypted).is_err());
    }
}
