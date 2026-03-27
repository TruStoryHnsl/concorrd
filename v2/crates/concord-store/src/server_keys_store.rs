use rusqlite::params;
use tracing::debug;

use crate::db::{Database, Result};

impl Database {
    /// Store a server encryption key.
    pub fn store_server_key(&self, server_id: &str, key: &[u8; 32]) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT INTO server_keys (server_id, secret_key, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(server_id) DO UPDATE SET
                secret_key = ?2,
                created_at = ?3",
            params![server_id, key.as_slice(), now],
        )?;
        debug!(server_id, "server key stored");
        Ok(())
    }

    /// Retrieve a server encryption key.
    pub fn get_server_key(&self, server_id: &str) -> Result<Option<[u8; 32]>> {
        let mut stmt = self
            .conn
            .prepare("SELECT secret_key FROM server_keys WHERE server_id = ?1")?;
        let mut rows = stmt.query_map(params![server_id], |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(blob)
        })?;
        match rows.next() {
            Some(row) => {
                let blob = row?;
                if blob.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&blob);
                    Ok(Some(key))
                } else {
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    /// Store a server key encrypted with the device key.
    pub fn store_server_key_encrypted(
        &self,
        server_id: &str,
        key: &[u8; 32],
        device_key: &[u8; 32],
    ) -> Result<()> {
        let encrypted = concord_core::crypto::encrypt_storage(device_key, key)
            .map_err(|e| crate::db::StoreError::InvalidData(format!("encrypt server key: {e}")))?;
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT INTO server_keys (server_id, secret_key, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(server_id) DO UPDATE SET secret_key = ?2, created_at = ?3",
            params![server_id, encrypted, now],
        )?;
        debug!(server_id, "server key stored (encrypted)");
        Ok(())
    }

    /// Retrieve and decrypt a server key. Falls back to plaintext for migration.
    pub fn get_server_key_decrypted(
        &self,
        server_id: &str,
        device_key: &[u8; 32],
    ) -> Result<Option<[u8; 32]>> {
        let mut stmt = self
            .conn
            .prepare("SELECT secret_key FROM server_keys WHERE server_id = ?1")?;
        let mut rows = stmt.query_map(params![server_id], |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(blob)
        })?;
        match rows.next() {
            Some(row) => {
                let blob = row?;
                // Try decrypt first, fall back to plaintext (migration)
                if let Ok(decrypted) = concord_core::crypto::decrypt_storage(device_key, &blob) {
                    if decrypted.len() == 32 {
                        let mut key = [0u8; 32];
                        key.copy_from_slice(&decrypted);
                        return Ok(Some(key));
                    }
                }
                // Fallback: raw 32-byte key (pre-encryption migration)
                if blob.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&blob);
                    Ok(Some(key))
                } else {
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    /// Delete a server encryption key.
    pub fn delete_server_key(&self, server_id: &str) -> Result<bool> {
        let deleted = self.conn.execute(
            "DELETE FROM server_keys WHERE server_id = ?1",
            params![server_id],
        )?;
        Ok(deleted > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_get_server_key() {
        let db = Database::open_in_memory().unwrap();
        let key = [42u8; 32];
        db.store_server_key("srv1", &key).unwrap();

        let loaded = db.get_server_key("srv1").unwrap().unwrap();
        assert_eq!(loaded, key);
    }

    #[test]
    fn get_missing_server_key_returns_none() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_server_key("nonexistent").unwrap().is_none());
    }

    #[test]
    fn overwrite_server_key() {
        let db = Database::open_in_memory().unwrap();
        let key1 = [1u8; 32];
        let key2 = [2u8; 32];
        db.store_server_key("srv1", &key1).unwrap();
        db.store_server_key("srv1", &key2).unwrap();

        let loaded = db.get_server_key("srv1").unwrap().unwrap();
        assert_eq!(loaded, key2);
    }

    #[test]
    fn delete_server_key() {
        let db = Database::open_in_memory().unwrap();
        let key = [42u8; 32];
        db.store_server_key("srv1", &key).unwrap();

        assert!(db.delete_server_key("srv1").unwrap());
        assert!(db.get_server_key("srv1").unwrap().is_none());
        assert!(!db.delete_server_key("srv1").unwrap()); // already deleted
    }
}
