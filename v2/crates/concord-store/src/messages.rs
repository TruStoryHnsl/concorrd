use std::collections::HashMap;

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::params;
use tracing::debug;

use concord_core::types::Message;

use crate::db::{Database, Result};

impl Database {
    /// Insert a message into the local store. Ignores duplicates.
    pub fn insert_message(&self, msg: &Message) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO messages (id, channel_id, sender_id, content, timestamp, signature, alias_id, alias_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                msg.id,
                msg.channel_id,
                msg.sender_id,
                msg.content,
                msg.timestamp.timestamp_millis(),
                msg.signature,
                msg.alias_id,
                msg.alias_name,
            ],
        )?;
        debug!(msg_id = %msg.id, "message stored");
        Ok(())
    }

    /// Retrieve messages for a channel, ordered by timestamp descending.
    ///
    /// - `channel_id`: the channel to query
    /// - `limit`: maximum number of messages to return
    /// - `before`: if provided, only return messages with timestamp before this value (unix millis)
    pub fn get_messages(
        &self,
        channel_id: &str,
        limit: u32,
        before: Option<i64>,
    ) -> Result<Vec<Message>> {
        let mut messages = match before {
            Some(before_ts) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, channel_id, sender_id, content, timestamp, signature, alias_id, alias_name
                     FROM messages
                     WHERE channel_id = ?1 AND timestamp < ?2
                     ORDER BY timestamp DESC
                     LIMIT ?3",
                )?;
                let rows = stmt.query_map(params![channel_id, before_ts, limit], row_to_message)?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            }
            None => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, channel_id, sender_id, content, timestamp, signature, alias_id, alias_name
                     FROM messages
                     WHERE channel_id = ?1
                     ORDER BY timestamp DESC
                     LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![channel_id, limit], row_to_message)?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            }
        };

        // Reverse so messages are in chronological order (oldest first).
        messages.reverse();
        Ok(messages)
    }

    /// Get the latest message in a channel.
    pub fn get_latest_message(&self, channel_id: &str) -> Result<Option<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, channel_id, sender_id, content, timestamp, signature, alias_id, alias_name
             FROM messages
             WHERE channel_id = ?1
             ORDER BY timestamp DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![channel_id], row_to_message)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Delete a message by ID. Returns true if a row was actually deleted.
    pub fn delete_message(&self, message_id: &str) -> Result<bool> {
        let deleted = self.conn.execute(
            "DELETE FROM messages WHERE id = ?1",
            params![message_id],
        )?;
        Ok(deleted > 0)
    }

    /// Full-text search across all messages. Returns matches ordered by timestamp descending.
    pub fn search_messages(&self, query: &str, limit: u32) -> Result<Vec<Message>> {
        let pattern = format!("%{query}%");
        let mut stmt = self.conn.prepare(
            "SELECT id, channel_id, sender_id, content, timestamp, signature, alias_id, alias_name
             FROM messages
             WHERE content LIKE ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], row_to_message)?;
        let messages: Vec<Message> = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(messages)
    }

    /// Get the latest message timestamp per channel (for building a vector clock).
    /// Returns a map of channel_id to the latest message timestamp in unix millis.
    pub fn get_vector_clock(&self) -> Result<HashMap<String, i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT channel_id, MAX(timestamp) FROM messages GROUP BY channel_id",
        )?;
        let rows = stmt.query_map([], |row| {
            let channel_id: String = row.get(0)?;
            let timestamp: i64 = row.get(1)?;
            Ok((channel_id, timestamp))
        })?;
        let mut clock = HashMap::new();
        for row in rows {
            let (channel_id, timestamp) = row?;
            clock.insert(channel_id, timestamp);
        }
        Ok(clock)
    }

    /// Get messages in a channel with timestamps strictly after the given value.
    /// Results are ordered by timestamp ascending and capped at `limit`.
    pub fn get_messages_after(
        &self,
        channel_id: &str,
        after_timestamp: i64,
        limit: u32,
    ) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, channel_id, sender_id, content, timestamp, signature, alias_id, alias_name
             FROM messages
             WHERE channel_id = ?1 AND timestamp > ?2
             ORDER BY timestamp ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![channel_id, after_timestamp, limit], row_to_message)?;
        let messages: Vec<Message> = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(messages)
    }
}

/// Map a rusqlite row to a Message.
fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    let millis: i64 = row.get(4)?;
    let timestamp: DateTime<Utc> = Utc
        .timestamp_millis_opt(millis)
        .single()
        .unwrap_or_default();
    Ok(Message {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        sender_id: row.get(2)?,
        content: row.get(3)?,
        timestamp,
        signature: row.get(5)?,
        alias_id: row.get(6)?,
        alias_name: row.get(7)?,
        // Stored messages are always decrypted locally; encryption fields are wire-only.
        encrypted_content: None,
        nonce: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_message(id: &str, channel: &str, content: &str, millis_offset: i64) -> Message {
        Message {
            id: id.to_string(),
            channel_id: channel.to_string(),
            sender_id: "user1".to_string(),
            content: content.to_string(),
            timestamp: Utc
                .timestamp_millis_opt(1_700_000_000_000 + millis_offset)
                .single()
                .unwrap(),
            signature: vec![0u8; 64],
            alias_id: None,
            alias_name: None,
            encrypted_content: None,
            nonce: None,
        }
    }

    #[test]
    fn insert_and_retrieve() {
        let db = Database::open_in_memory().unwrap();

        let msg = make_message("m1", "ch1", "hello world", 0);
        db.insert_message(&msg).unwrap();

        let messages = db.get_messages("ch1", 50, None).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "m1");
        assert_eq!(messages[0].content, "hello world");
        assert_eq!(messages[0].channel_id, "ch1");
        assert_eq!(messages[0].signature.len(), 64);
    }

    #[test]
    fn get_messages_with_before() {
        let db = Database::open_in_memory().unwrap();

        db.insert_message(&make_message("m1", "ch1", "first", 0)).unwrap();
        db.insert_message(&make_message("m2", "ch1", "second", 1000)).unwrap();
        db.insert_message(&make_message("m3", "ch1", "third", 2000)).unwrap();

        // Get messages before the third one
        let msgs = db.get_messages("ch1", 50, Some(1_700_000_002_000)).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[1].id, "m2");
    }

    #[test]
    fn get_latest_message() {
        let db = Database::open_in_memory().unwrap();

        assert!(db.get_latest_message("ch1").unwrap().is_none());

        db.insert_message(&make_message("m1", "ch1", "first", 0)).unwrap();
        db.insert_message(&make_message("m2", "ch1", "second", 1000)).unwrap();

        let latest = db.get_latest_message("ch1").unwrap().unwrap();
        assert_eq!(latest.id, "m2");
    }

    #[test]
    fn delete_message() {
        let db = Database::open_in_memory().unwrap();

        db.insert_message(&make_message("m1", "ch1", "hello", 0)).unwrap();
        assert!(db.delete_message("m1").unwrap());
        assert!(!db.delete_message("m1").unwrap()); // already deleted

        let msgs = db.get_messages("ch1", 50, None).unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn search_messages() {
        let db = Database::open_in_memory().unwrap();

        db.insert_message(&make_message("m1", "ch1", "hello world", 0)).unwrap();
        db.insert_message(&make_message("m2", "ch1", "goodbye world", 1000)).unwrap();
        db.insert_message(&make_message("m3", "ch1", "hello there", 2000)).unwrap();

        let results = db.search_messages("hello", 50).unwrap();
        assert_eq!(results.len(), 2);

        let results = db.search_messages("world", 50).unwrap();
        assert_eq!(results.len(), 2);

        let results = db.search_messages("goodbye", 50).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "m2");
    }

    #[test]
    fn duplicate_insert_ignored() {
        let db = Database::open_in_memory().unwrap();

        let msg = make_message("m1", "ch1", "hello", 0);
        db.insert_message(&msg).unwrap();
        db.insert_message(&msg).unwrap(); // should not error

        let msgs = db.get_messages("ch1", 50, None).unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn messages_isolated_by_channel() {
        let db = Database::open_in_memory().unwrap();

        db.insert_message(&make_message("m1", "ch1", "in ch1", 0)).unwrap();
        db.insert_message(&make_message("m2", "ch2", "in ch2", 0)).unwrap();

        assert_eq!(db.get_messages("ch1", 50, None).unwrap().len(), 1);
        assert_eq!(db.get_messages("ch2", 50, None).unwrap().len(), 1);
        assert_eq!(db.get_messages("ch3", 50, None).unwrap().len(), 0);
    }
}
