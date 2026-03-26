use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum IdentityError {
    #[error("invalid key bytes: expected 32 bytes, got {0}")]
    InvalidKeyLength(usize),
    #[error("signature verification failed")]
    VerificationFailed(#[from] ed25519_dalek::SignatureError),
}

/// A cryptographic identity backed by an Ed25519 signing key.
#[derive(Debug, Clone)]
pub struct Keypair {
    signing_key: SigningKey,
}

impl Keypair {
    /// Generate a new random keypair.
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        Self { signing_key }
    }

    /// Derive the peer ID from the public key (hex-encoded).
    pub fn peer_id(&self) -> String {
        let verifying_key = self.signing_key.verifying_key();
        hex_encode(verifying_key.as_bytes())
    }

    /// Sign a message, returning the 64-byte signature.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        let signature = self.signing_key.sign(message);
        signature.to_bytes().to_vec()
    }

    /// Verify a signature against a public key and message.
    pub fn verify(
        public_key_bytes: &[u8; 32],
        message: &[u8],
        signature_bytes: &[u8; 64],
    ) -> Result<(), IdentityError> {
        let verifying_key = VerifyingKey::from_bytes(public_key_bytes)?;
        let signature = ed25519_dalek::Signature::from_bytes(signature_bytes);
        verifying_key.verify(message, &signature)?;
        Ok(())
    }

    /// Serialize the signing key to 32 bytes.
    pub fn to_bytes(&self) -> [u8; 32] {
        self.signing_key.to_bytes()
    }

    /// Restore a keypair from 32 secret key bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, IdentityError> {
        if bytes.len() != 32 {
            return Err(IdentityError::InvalidKeyLength(bytes.len()));
        }
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(bytes);
        let signing_key = SigningKey::from_bytes(&key_bytes);
        Ok(Self { signing_key })
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, IdentityError> {
    if s.len() % 2 != 0 {
        return Err(IdentityError::InvalidKeyLength(s.len() / 2));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|_| IdentityError::InvalidKeyLength(0))
        })
        .collect()
}

/// Decode a hex-encoded peer ID back to 32-byte public key bytes.
pub fn peer_id_to_public_key_bytes(peer_id: &str) -> Result<[u8; 32], IdentityError> {
    let bytes = hex_decode(peer_id)?;
    if bytes.len() != 32 {
        return Err(IdentityError::InvalidKeyLength(bytes.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// Verify an attestation signature given the attester's peer ID (hex-encoded public key).
/// Returns Ok(true) if valid, Ok(false) if the signature is invalid.
pub fn verify_attestation_signature(
    attester_peer_id: &str,
    subject_id: &str,
    since_timestamp: u64,
    signature: &[u8],
) -> Result<bool, IdentityError> {
    let pub_bytes = peer_id_to_public_key_bytes(attester_peer_id)?;
    let message = format!("{attester_peer_id}:{subject_id}:{since_timestamp}");
    if signature.len() != 64 {
        return Ok(false);
    }
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(signature);
    match Keypair::verify(&pub_bytes, message.as_bytes(), &sig_arr) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_and_sign_verify() {
        let kp = Keypair::generate();
        let message = b"hello concord";
        let sig = kp.sign(message);

        let pub_bytes = {
            let vk = kp.signing_key.verifying_key();
            *vk.as_bytes()
        };
        let sig_bytes: [u8; 64] = sig.try_into().unwrap();
        Keypair::verify(&pub_bytes, message, &sig_bytes).unwrap();
    }

    #[test]
    fn roundtrip_bytes() {
        let kp = Keypair::generate();
        let bytes = kp.to_bytes();
        let restored = Keypair::from_bytes(&bytes).unwrap();
        assert_eq!(kp.peer_id(), restored.peer_id());
    }

    #[test]
    fn peer_id_to_public_key_roundtrip() {
        let kp = Keypair::generate();
        let peer_id = kp.peer_id();
        let pub_bytes = super::peer_id_to_public_key_bytes(&peer_id).unwrap();
        let vk = kp.signing_key.verifying_key();
        assert_eq!(&pub_bytes, vk.as_bytes());
    }

    #[test]
    fn verify_attestation_valid() {
        let kp = Keypair::generate();
        let subject = "some_subject_id";
        let timestamp = 1234567890u64;
        let message = format!("{}:{}:{}", kp.peer_id(), subject, timestamp);
        let sig = kp.sign(message.as_bytes());
        assert!(
            super::verify_attestation_signature(&kp.peer_id(), subject, timestamp, &sig).unwrap()
        );
    }

    #[test]
    fn verify_attestation_forged_subject() {
        let kp = Keypair::generate();
        let subject = "real_subject";
        let timestamp = 1234567890u64;
        let message = format!("{}:{}:{}", kp.peer_id(), subject, timestamp);
        let sig = kp.sign(message.as_bytes());
        // Try to verify with a different subject
        assert!(
            !super::verify_attestation_signature(&kp.peer_id(), "forged_subject", timestamp, &sig)
                .unwrap()
        );
    }

    #[test]
    fn verify_attestation_wrong_key() {
        let kp1 = Keypair::generate();
        let kp2 = Keypair::generate();
        let subject = "subject";
        let timestamp = 1234567890u64;
        let message = format!("{}:{}:{}", kp1.peer_id(), subject, timestamp);
        let sig = kp1.sign(message.as_bytes());
        // Try to verify with a different attester's peer_id
        assert!(
            !super::verify_attestation_signature(&kp2.peer_id(), subject, timestamp, &sig)
                .unwrap()
        );
    }
}
