use rusqlite::params;
use tracing::debug;

use crate::db::{Database, Result};

/// A stored DM session with key material.
#[derive(Debug, Clone)]
pub struct DmSessionRecord {
    pub peer_id: String,
    pub shared_secret: Vec<u8>,
    pub send_chain_key: Vec<u8>,
    pub recv_chain_key: Vec<u8>,
    pub send_count: u64,
    pub recv_count: u64,
    pub updated_at: i64,
}

/// A stored direct message record.
#[derive(Debug, Clone)]
pub struct DmRecord {
    pub id: String,
    pub peer_id: String,
    pub sender_id: String,
    pub content_encrypted: Vec<u8>,
    pub nonce: Vec<u8>,
    pub timestamp: i64,
}

impl Database {
    /// Save or update a DM session. The chain keys are placeholders for the
    /// simplified crypto (same as shared_secret until full ratchet is implemented).
    pub fn save_dm_session(
        &self,
        peer_id: &str,
        shared_secret: &[u8],
        send_count: u64,
        recv_count: u64,
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT INTO dm_sessions (peer_id, shared_secret, send_chain_key, recv_chain_key, send_count, recv_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(peer_id) DO UPDATE SET
                shared_secret = ?2,
                send_chain_key = ?3,
                recv_chain_key = ?4,
                send_count = ?5,
                recv_count = ?6,
                updated_at = ?7",
            params![
                peer_id,
                shared_secret,
                shared_secret, // send_chain_key = shared_secret (simplified)
                shared_secret, // recv_chain_key = shared_secret (simplified)
                send_count as i64,
                recv_count as i64,
                now,
            ],
        )?;
        debug!(peer_id, "DM session saved");
        Ok(())
    }

    /// Load a DM session for a peer.
    pub fn get_dm_session(&self, peer_id: &str) -> Result<Option<DmSessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT peer_id, shared_secret, send_chain_key, recv_chain_key, send_count, recv_count, updated_at
             FROM dm_sessions WHERE peer_id = ?1",
        )?;
        let mut rows = stmt.query_map(params![peer_id], |row| {
            Ok(DmSessionRecord {
                peer_id: row.get(0)?,
                shared_secret: row.get(1)?,
                send_chain_key: row.get(2)?,
                recv_chain_key: row.get(3)?,
                send_count: row.get::<_, i64>(4)? as u64,
                recv_count: row.get::<_, i64>(5)? as u64,
                updated_at: row.get(6)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Store an encrypted direct message.
    pub fn store_dm(
        &self,
        id: &str,
        peer_id: &str,
        sender_id: &str,
        content_encrypted: &[u8],
        nonce: &[u8],
        timestamp: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO direct_messages (id, peer_id, sender_id, content_encrypted, nonce, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, peer_id, sender_id, content_encrypted, nonce, timestamp],
        )?;
        debug!(id, peer_id, "DM stored");
        Ok(())
    }

    /// Get DM history with a peer, ordered by timestamp descending, with a limit.
    pub fn get_dm_history(&self, peer_id: &str, limit: u32) -> Result<Vec<DmRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, peer_id, sender_id, content_encrypted, nonce, timestamp
             FROM direct_messages
             WHERE peer_id = ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![peer_id, limit], |row| {
            Ok(DmRecord {
                id: row.get(0)?,
                peer_id: row.get(1)?,
                sender_id: row.get(2)?,
                content_encrypted: row.get(3)?,
                nonce: row.get(4)?,
                timestamp: row.get(5)?,
            })
        })?;
        let records: Vec<DmRecord> = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(records)
    }

    /// Delete a DM session (e.g., when the peer is removed).
    pub fn delete_dm_session(&self, peer_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM dm_sessions WHERE peer_id = ?1",
            params![peer_id],
        )?;
        Ok(())
    }

    /// Save a DM session with the shared secret and chain keys encrypted using a device key.
    pub fn save_dm_session_encrypted(
        &self,
        device_key: &[u8; 32],
        peer_id: &str,
        shared_secret: &[u8],
        send_count: u64,
        recv_count: u64,
    ) -> Result<()> {
        let encrypted_secret = concord_core::crypto::encrypt_dm_secret(device_key, shared_secret)
            .map_err(|e| crate::db::StoreError::InvalidData(e.to_string()))?;
        let now = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT INTO dm_sessions (peer_id, shared_secret, send_chain_key, recv_chain_key, send_count, recv_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(peer_id) DO UPDATE SET
                shared_secret = ?2,
                send_chain_key = ?3,
                recv_chain_key = ?4,
                send_count = ?5,
                recv_count = ?6,
                updated_at = ?7",
            params![
                peer_id,
                encrypted_secret,
                encrypted_secret, // send_chain_key = encrypted shared_secret (simplified)
                encrypted_secret, // recv_chain_key = encrypted shared_secret (simplified)
                send_count as i64,
                recv_count as i64,
                now,
            ],
        )?;
        debug!(peer_id, "DM session saved (encrypted)");
        Ok(())
    }

    /// Load a DM session for a peer, decrypting the shared secret and chain keys.
    /// Falls back to loading unencrypted data if decryption fails (migration path).
    pub fn get_dm_session_decrypted(
        &self,
        device_key: &[u8; 32],
        peer_id: &str,
    ) -> Result<Option<DmSessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT peer_id, shared_secret, send_chain_key, recv_chain_key, send_count, recv_count, updated_at
             FROM dm_sessions WHERE peer_id = ?1",
        )?;
        let mut rows = stmt.query_map(params![peer_id], |row| {
            Ok(DmSessionRecord {
                peer_id: row.get(0)?,
                shared_secret: row.get(1)?,
                send_chain_key: row.get(2)?,
                recv_chain_key: row.get(3)?,
                send_count: row.get::<_, i64>(4)? as u64,
                recv_count: row.get::<_, i64>(5)? as u64,
                updated_at: row.get(6)?,
            })
        })?;
        match rows.next() {
            Some(row) => {
                let mut record = row?;

                // Try decrypting the secret (encrypted format: nonce-prepended ciphertext)
                if let Ok(decrypted) = concord_core::crypto::decrypt_dm_secret(device_key, &record.shared_secret) {
                    record.shared_secret = decrypted.clone();
                    record.send_chain_key = decrypted.clone();
                    record.recv_chain_key = decrypted;
                    return Ok(Some(record));
                }

                // Fallback: data may be stored unencrypted (migration path).
                // If the shared_secret is exactly 32 bytes and looks like a raw key, use as-is.
                if record.shared_secret.len() == 32 {
                    debug!(peer_id, "loaded unencrypted DM session — will re-encrypt on next save");
                    return Ok(Some(record));
                }

                Err(crate::db::StoreError::InvalidData(
                    "failed to load DM session: decryption and plaintext parse both failed".to_string(),
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
    fn save_and_load_dm_session() {
        let db = Database::open_in_memory().unwrap();

        let secret = vec![42u8; 32];
        db.save_dm_session("peer1", &secret, 0, 0).unwrap();

        let session = db.get_dm_session("peer1").unwrap().unwrap();
        assert_eq!(session.peer_id, "peer1");
        assert_eq!(session.shared_secret, secret);
        assert_eq!(session.send_count, 0);
        assert_eq!(session.recv_count, 0);
    }

    #[test]
    fn dm_session_not_found() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_dm_session("nonexistent").unwrap().is_none());
    }

    #[test]
    fn update_dm_session_counters() {
        let db = Database::open_in_memory().unwrap();

        let secret = vec![42u8; 32];
        db.save_dm_session("peer1", &secret, 0, 0).unwrap();
        db.save_dm_session("peer1", &secret, 5, 3).unwrap();

        let session = db.get_dm_session("peer1").unwrap().unwrap();
        assert_eq!(session.send_count, 5);
        assert_eq!(session.recv_count, 3);
    }

    #[test]
    fn store_and_retrieve_dms() {
        let db = Database::open_in_memory().unwrap();

        db.store_dm("msg1", "peer1", "me", &[1, 2, 3], &[4, 5, 6], 1000)
            .unwrap();
        db.store_dm("msg2", "peer1", "peer1", &[7, 8, 9], &[10, 11, 12], 2000)
            .unwrap();
        db.store_dm("msg3", "peer2", "me", &[13, 14], &[15, 16], 3000)
            .unwrap();

        let history = db.get_dm_history("peer1", 50).unwrap();
        assert_eq!(history.len(), 2);
        // Ordered by timestamp DESC
        assert_eq!(history[0].id, "msg2");
        assert_eq!(history[1].id, "msg1");

        let history2 = db.get_dm_history("peer2", 50).unwrap();
        assert_eq!(history2.len(), 1);
    }

    #[test]
    fn dm_limit_works() {
        let db = Database::open_in_memory().unwrap();

        for i in 0..10 {
            db.store_dm(
                &format!("msg{i}"),
                "peer1",
                "me",
                &[i as u8],
                &[i as u8],
                i * 1000,
            )
            .unwrap();
        }

        let history = db.get_dm_history("peer1", 3).unwrap();
        assert_eq!(history.len(), 3);
    }

    #[test]
    fn delete_dm_session() {
        let db = Database::open_in_memory().unwrap();

        db.save_dm_session("peer1", &[42u8; 32], 0, 0).unwrap();
        assert!(db.get_dm_session("peer1").unwrap().is_some());

        db.delete_dm_session("peer1").unwrap();
        assert!(db.get_dm_session("peer1").unwrap().is_none());
    }

    #[test]
    fn encrypted_dm_session_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let device_key = concord_core::crypto::generate_device_key();

        let secret = vec![42u8; 32];
        db.save_dm_session_encrypted(&device_key, "peer1", &secret, 5, 3).unwrap();

        let session = db.get_dm_session_decrypted(&device_key, "peer1").unwrap().unwrap();
        assert_eq!(session.peer_id, "peer1");
        assert_eq!(session.shared_secret, secret);
        assert_eq!(session.send_count, 5);
        assert_eq!(session.recv_count, 3);
    }

    #[test]
    fn encrypted_dm_session_migration_from_plaintext() {
        let db = Database::open_in_memory().unwrap();
        let device_key = concord_core::crypto::generate_device_key();

        // Save with old unencrypted method
        let secret = vec![42u8; 32];
        db.save_dm_session("peer1", &secret, 0, 0).unwrap();

        // Load with new encrypted method -- should fall back to plaintext
        let session = db.get_dm_session_decrypted(&device_key, "peer1").unwrap().unwrap();
        assert_eq!(session.shared_secret, secret);
    }

    #[test]
    fn encrypted_dm_session_not_found() {
        let db = Database::open_in_memory().unwrap();
        let device_key = concord_core::crypto::generate_device_key();
        assert!(db.get_dm_session_decrypted(&device_key, "nonexistent").unwrap().is_none());
    }
}
