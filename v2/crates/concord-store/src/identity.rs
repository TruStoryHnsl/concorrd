use rusqlite::params;
use tracing::info;

use concord_core::identity::Keypair;

use crate::db::{Database, Result};

impl Database {
    /// Save (or overwrite) the node's identity keypair.
    pub fn save_identity(&self, display_name: &str, keypair: &Keypair) -> Result<()> {
        let key_bytes = keypair.to_bytes();
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT OR REPLACE INTO identity (id, display_name, signing_key, created_at)
             VALUES (1, ?1, ?2, ?3)",
            params![display_name, key_bytes.as_slice(), now],
        )?;
        info!("identity saved");
        Ok(())
    }

    /// Load the stored identity, if one exists.
    /// Returns (display_name, Keypair).
    pub fn load_identity(&self) -> Result<Option<(String, Keypair)>> {
        let mut stmt = self.conn.prepare(
            "SELECT display_name, signing_key FROM identity WHERE id = 1",
        )?;
        let mut rows = stmt.query_map([], |row| {
            let name: String = row.get(0)?;
            let key_bytes: Vec<u8> = row.get(1)?;
            Ok((name, key_bytes))
        })?;

        match rows.next() {
            Some(row) => {
                let (name, key_bytes) = row?;
                let keypair = Keypair::from_bytes(&key_bytes)?;
                Ok(Some((name, keypair)))
            }
            None => Ok(None),
        }
    }

    /// Check whether an identity has been stored.
    pub fn has_identity(&self) -> Result<bool> {
        let count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM identity WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Save the identity with the signing key encrypted using a device key.
    pub fn save_identity_encrypted(
        &self,
        display_name: &str,
        keypair: &Keypair,
        device_key: &[u8; 32],
    ) -> Result<()> {
        let key_bytes = keypair.to_bytes();
        let encrypted = concord_core::crypto::encrypt_identity(device_key, &key_bytes)
            .map_err(|e| crate::db::StoreError::InvalidData(e.to_string()))?;
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT OR REPLACE INTO identity (id, display_name, signing_key, created_at)
             VALUES (1, ?1, ?2, ?3)",
            params![display_name, encrypted.as_slice(), now],
        )?;
        info!("identity saved (encrypted)");
        Ok(())
    }

    /// Load the stored identity, decrypting the signing key with the device key.
    /// Falls back to loading unencrypted if decryption fails (migration path).
    pub fn load_identity_encrypted(
        &self,
        device_key: &[u8; 32],
    ) -> Result<Option<(String, Keypair)>> {
        let mut stmt = self.conn.prepare(
            "SELECT display_name, signing_key FROM identity WHERE id = 1",
        )?;
        let mut rows = stmt.query_map([], |row| {
            let name: String = row.get(0)?;
            let key_bytes: Vec<u8> = row.get(1)?;
            Ok((name, key_bytes))
        })?;

        match rows.next() {
            Some(row) => {
                let (name, stored_bytes) = row?;

                // Try decrypting first (encrypted format)
                if let Ok(decrypted) = concord_core::crypto::decrypt_identity(device_key, &stored_bytes) {
                    if decrypted.len() == 64 || decrypted.len() == 32 {
                        if let Ok(keypair) = Keypair::from_bytes(&decrypted) {
                            return Ok(Some((name, keypair)));
                        }
                    }
                }

                // Fallback: try loading as unencrypted (migration from old format)
                if let Ok(keypair) = Keypair::from_bytes(&stored_bytes) {
                    info!("loaded unencrypted identity — will re-encrypt on next save");
                    return Ok(Some((name, keypair)));
                }

                Err(crate::db::StoreError::InvalidData(
                    "failed to load identity: decryption and plaintext parse both failed".to_string(),
                ))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_identity() {
        let db = Database::open_in_memory().unwrap();

        assert!(!db.has_identity().unwrap());
        assert!(db.load_identity().unwrap().is_none());

        let kp = Keypair::generate();
        let peer_id = kp.peer_id();
        db.save_identity("TestNode", &kp).unwrap();

        assert!(db.has_identity().unwrap());

        let (name, loaded_kp) = db.load_identity().unwrap().unwrap();
        assert_eq!(name, "TestNode");
        assert_eq!(loaded_kp.peer_id(), peer_id);
    }

    #[test]
    fn overwrite_identity() {
        let db = Database::open_in_memory().unwrap();

        let kp1 = Keypair::generate();
        db.save_identity("First", &kp1).unwrap();

        let kp2 = Keypair::generate();
        db.save_identity("Second", &kp2).unwrap();

        let (name, loaded) = db.load_identity().unwrap().unwrap();
        assert_eq!(name, "Second");
        assert_eq!(loaded.peer_id(), kp2.peer_id());
    }

    #[test]
    fn keypair_roundtrip_sign_verify() {
        let db = Database::open_in_memory().unwrap();

        let kp = Keypair::generate();
        db.save_identity("SignTest", &kp).unwrap();

        let (_, loaded) = db.load_identity().unwrap().unwrap();

        // Sign with loaded keypair, verify the signature matches original
        let message = b"test message";
        let sig_original = kp.sign(message);
        let sig_loaded = loaded.sign(message);
        assert_eq!(sig_original, sig_loaded);
    }

    #[test]
    fn encrypted_identity_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let device_key = concord_core::crypto::generate_device_key();

        let kp = Keypair::generate();
        let peer_id = kp.peer_id();
        db.save_identity_encrypted("EncTest", &kp, &device_key).unwrap();

        let (name, loaded_kp) = db.load_identity_encrypted(&device_key).unwrap().unwrap();
        assert_eq!(name, "EncTest");
        assert_eq!(loaded_kp.peer_id(), peer_id);

        // Verify signing still works after encrypt/decrypt roundtrip
        let message = b"test encrypted roundtrip";
        assert_eq!(kp.sign(message), loaded_kp.sign(message));
    }

    #[test]
    fn encrypted_identity_migration_from_plaintext() {
        let db = Database::open_in_memory().unwrap();
        let device_key = concord_core::crypto::generate_device_key();

        // Save with the old unencrypted method
        let kp = Keypair::generate();
        let peer_id = kp.peer_id();
        db.save_identity("MigrateTest", &kp).unwrap();

        // Load with the new encrypted method -- should fall back to plaintext
        let (name, loaded_kp) = db.load_identity_encrypted(&device_key).unwrap().unwrap();
        assert_eq!(name, "MigrateTest");
        assert_eq!(loaded_kp.peer_id(), peer_id);
    }

    #[test]
    fn encrypted_identity_wrong_key_falls_back() {
        let db = Database::open_in_memory().unwrap();
        let device_key = concord_core::crypto::generate_device_key();
        let wrong_key = concord_core::crypto::generate_device_key();

        let kp = Keypair::generate();
        db.save_identity_encrypted("WrongKeyTest", &kp, &device_key).unwrap();

        // Wrong key should fail decryption, and the encrypted bytes won't parse as
        // a valid keypair either, so this should return an error.
        let result = db.load_identity_encrypted(&wrong_key);
        assert!(result.is_err());
    }
}
