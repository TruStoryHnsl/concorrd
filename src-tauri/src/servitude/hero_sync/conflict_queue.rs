//! F-C — `conflict_queue` hand-off contract.
//!
//! When a hero-sync round surfaces a DESTRUCTIVE conflict (per the
//! RFC §5.c catalogue — `concurrent_rename`, `tombstone_vs_write`,
//! `acl_change`), F-C **enqueues** it. F-C does NOT resolve. The drain
//! is the responsibility of Architecture D (`docs/architecture/resumable-conflict-agent-scope.md`),
//! which dispatches an agent in a separate session.
//!
//! ## Schema
//!
//! ```sql
//! CREATE TABLE conflict_queue (
//!     conflict_id    BLOB PRIMARY KEY,    -- ULID, raw 16 bytes
//!     conflict_kind  TEXT NOT NULL,       -- enum: see HERO_SYNC_CONFLICT_KINDS
//!     payload_json   BLOB NOT NULL,       -- opaque JSON: the two
//!                                          --   competing events + context
//!     queued_at      INTEGER NOT NULL,    -- unix milliseconds
//!     resolved_at    INTEGER,             -- nullable; F-D stamps
//!     agent_verdict  BLOB                 -- nullable JSON; F-D writes
//! );
//! CREATE INDEX idx_conflict_queue_pending
//!     ON conflict_queue(queued_at) WHERE resolved_at IS NULL;
//! ```
//!
//! ## Contract for F-D
//!
//! F-D reads rows where `resolved_at IS NULL`, sorted by `queued_at` ASC
//! (FIFO). For each row, F-D invokes the agent, captures the verdict,
//! and writes:
//!
//!   * `resolved_at = unix_millis()`
//!   * `agent_verdict = <JSON envelope per RFC §5.d>`
//!
//! `agent_verdict` schema mirrors the RFC's `ConflictVerdict` struct:
//! `{ verdict_kind, rationale, confidence, agent_signature?, applied_event_id? }`.
//! F-D must NOT delete rows — the queue is the audit trail. Resolved
//! rows stay forever, partitioned by the `WHERE resolved_at IS NULL`
//! index for efficient pending scans.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::porch::db::{unix_millis, Porch};
use crate::porch::error::PorchError;

/// The destructive-conflict kinds F-C surfaces. Mirrors RFC §5.c.
///
/// Non-destructive concurrencies (two messages in different channels,
/// two unrelated theme tweaks) DO NOT enqueue here — they're handled
/// by the existing porch CRDT row-tables' LWW path.
pub const HERO_SYNC_CONFLICT_KINDS: &[&str] = &[
    "concurrent_rename",
    "tombstone_vs_write",
    "acl_change",
];

/// Type-safe enum over the conflict kinds. The wire/SQL representation
/// is the kebab-case string in [`HERO_SYNC_CONFLICT_KINDS`]; use
/// `as_str()` / `parse()` for round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    /// Two devices renamed the same row at the same time. RFC example
    /// #1.
    ConcurrentRename,
    /// One side wrote a row that the other side concurrently
    /// tombstoned. RFC example #2.
    TombstoneVsWrite,
    /// Two devices set different ACL states on the same (channel, peer)
    /// row. RFC example #3.
    AclChange,
}

impl ConflictKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ConcurrentRename => "concurrent_rename",
            Self::TombstoneVsWrite => "tombstone_vs_write",
            Self::AclChange => "acl_change",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "concurrent_rename" => Some(Self::ConcurrentRename),
            "tombstone_vs_write" => Some(Self::TombstoneVsWrite),
            "acl_change" => Some(Self::AclChange),
            _ => None,
        }
    }
}

/// The full conflict record F-C enqueues. The `payload` field is
/// opaque-to-F-C JSON — F-D reads it.
///
/// `payload` is JSON rather than typed Rust so the structure can grow
/// post-merge without a code change here. F-D's agent prompt construction
/// reads whatever fields the enqueueing site filled in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictRecord {
    pub kind: ConflictKind,
    pub payload: serde_json::Value,
}

/// One row out of `conflict_queue`, hydrated for diagnostic surfaces.
/// `conflict_id` is rendered as a hex string for UI ease.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictQueueRow {
    pub conflict_id: String,
    pub conflict_kind: String,
    pub payload_json: serde_json::Value,
    pub queued_at: i64,
    pub resolved_at: Option<i64>,
    pub agent_verdict: Option<serde_json::Value>,
}

/// Mint a fresh ULID-shaped 16-byte identifier. We don't depend on the
/// `ulid` crate here — the timestamp prefix + 80 random bits gives the
/// same sortability/uniqueness properties without the extra dep.
fn fresh_conflict_id() -> [u8; 16] {
    use rand::RngCore;
    let now_ms = unix_millis() as u128;
    let mut out = [0u8; 16];
    // 48-bit big-endian timestamp prefix; 80 random bits.
    out[0] = ((now_ms >> 40) & 0xFF) as u8;
    out[1] = ((now_ms >> 32) & 0xFF) as u8;
    out[2] = ((now_ms >> 24) & 0xFF) as u8;
    out[3] = ((now_ms >> 16) & 0xFF) as u8;
    out[4] = ((now_ms >> 8) & 0xFF) as u8;
    out[5] = (now_ms & 0xFF) as u8;
    let mut rng = rand::thread_rng();
    rng.fill_bytes(&mut out[6..]);
    out
}

/// Append a conflict to the queue. Returns the freshly minted
/// `conflict_id` so callers can correlate sync-round logs to queue
/// rows.
pub fn enqueue(
    porch: &Porch,
    record: &ConflictRecord,
) -> Result<[u8; 16], PorchError> {
    let conflict_id = fresh_conflict_id();
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    let payload_bytes = serde_json::to_vec(&record.payload).map_err(PorchError::Serde)?;
    conn.execute(
        "INSERT INTO conflict_queue
            (conflict_id, conflict_kind, payload_json, queued_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            conflict_id.as_slice(),
            record.kind.as_str(),
            payload_bytes.as_slice(),
            unix_millis(),
        ],
    )?;
    Ok(conflict_id)
}

/// Drain query — every row where `resolved_at IS NULL`, oldest first.
/// F-D calls this; F-C exposes it for inspection + tests.
pub fn list_pending(porch: &Porch) -> Result<Vec<ConflictQueueRow>, PorchError> {
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT conflict_id, conflict_kind, payload_json, queued_at,
                resolved_at, agent_verdict
         FROM conflict_queue
         WHERE resolved_at IS NULL
         ORDER BY queued_at ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let id_bytes: Vec<u8> = r.get(0)?;
            let kind: String = r.get(1)?;
            let payload_bytes: Vec<u8> = r.get(2)?;
            let queued_at: i64 = r.get(3)?;
            let resolved_at: Option<i64> = r.get(4)?;
            let verdict_bytes: Option<Vec<u8>> = r.get(5)?;
            let payload_json: serde_json::Value =
                serde_json::from_slice(&payload_bytes).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Blob,
                        Box::new(e),
                    )
                })?;
            let agent_verdict = match verdict_bytes {
                Some(bytes) => Some(serde_json::from_slice(&bytes).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Blob,
                        Box::new(e),
                    )
                })?),
                None => None,
            };
            Ok(ConflictQueueRow {
                conflict_id: hex::encode(id_bytes),
                conflict_kind: kind,
                payload_json,
                queued_at,
                resolved_at,
                agent_verdict,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Count pending conflicts. Cheap; used by the UI's "N conflicts pending"
/// badge without paying the full list query.
pub fn pending_count(porch: &Porch) -> Result<i64, PorchError> {
    let conn = porch.conn.lock().expect("porch conn mutex poisoned");
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM conflict_queue WHERE resolved_at IS NULL",
        [],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: ConflictKind, label: &str) -> ConflictRecord {
        ConflictRecord {
            kind,
            payload: serde_json::json!({
                "row_id": label,
                "event_a": { "device_id": "dev-a", "lamport": 1, "value": "rename-A" },
                "event_b": { "device_id": "dev-b", "lamport": 1, "value": "rename-B" },
            }),
        }
    }

    #[test]
    fn enqueue_then_list_pending_round_trips() {
        let porch = Porch::open_in_memory().expect("open");
        let _id = enqueue(&porch, &record(ConflictKind::ConcurrentRename, "row-1"))
            .expect("enqueue");
        let pending = list_pending(&porch).expect("list");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].conflict_kind, "concurrent_rename");
        assert_eq!(pending[0].payload_json["row_id"], "row-1");
        assert!(pending[0].resolved_at.is_none());
    }

    #[test]
    fn enqueue_three_kinds_each_distinct() {
        let porch = Porch::open_in_memory().expect("open");
        enqueue(&porch, &record(ConflictKind::ConcurrentRename, "r")).unwrap();
        enqueue(&porch, &record(ConflictKind::TombstoneVsWrite, "t")).unwrap();
        enqueue(&porch, &record(ConflictKind::AclChange, "a")).unwrap();
        assert_eq!(pending_count(&porch).unwrap(), 3);
        let kinds: Vec<String> = list_pending(&porch)
            .unwrap()
            .into_iter()
            .map(|r| r.conflict_kind)
            .collect();
        assert!(kinds.contains(&"concurrent_rename".to_string()));
        assert!(kinds.contains(&"tombstone_vs_write".to_string()));
        assert!(kinds.contains(&"acl_change".to_string()));
    }

    #[test]
    fn conflict_kind_string_round_trip() {
        for k in &[
            ConflictKind::ConcurrentRename,
            ConflictKind::TombstoneVsWrite,
            ConflictKind::AclChange,
        ] {
            let s = k.as_str();
            assert_eq!(ConflictKind::parse(s), Some(*k));
        }
        assert!(ConflictKind::parse("not_a_kind").is_none());
    }

    #[test]
    fn pending_count_excludes_resolved_rows() {
        let porch = Porch::open_in_memory().expect("open");
        let id = enqueue(&porch, &record(ConflictKind::AclChange, "r"))
            .expect("enqueue");
        assert_eq!(pending_count(&porch).unwrap(), 1);
        // Simulate F-D writing a verdict.
        {
            let conn = porch.conn.lock().unwrap();
            conn.execute(
                "UPDATE conflict_queue
                 SET resolved_at = ?1, agent_verdict = ?2
                 WHERE conflict_id = ?3",
                params![
                    unix_millis(),
                    serde_json::to_vec(&serde_json::json!({
                        "verdict_kind": "pick_a",
                        "rationale": "tie-break by device-id"
                    }))
                    .unwrap(),
                    id.as_slice(),
                ],
            )
            .unwrap();
        }
        assert_eq!(pending_count(&porch).unwrap(), 0);
        // The row is still there — audit trail intact.
        let conn = porch.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM conflict_queue", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn fresh_conflict_ids_are_unique_and_sortable() {
        let mut ids = Vec::new();
        for _ in 0..16 {
            ids.push(fresh_conflict_id());
        }
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            assert!(seen.insert(*id), "duplicate ULID: {:?}", id);
        }
        // Timestamp prefix means consecutive IDs sort weakly-monotonically.
        let mut sorted = ids.clone();
        sorted.sort();
        // Can't guarantee strict order at sub-millisecond granularity,
        // but a sort+dedup should yield no losses.
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len());
    }

    #[test]
    fn payload_json_survives_roundtrip_with_unicode() {
        let porch = Porch::open_in_memory().expect("open");
        let rec = ConflictRecord {
            kind: ConflictKind::ConcurrentRename,
            payload: serde_json::json!({
                "row_id": "🦀-channel",
                "names": ["#general", "#общий", "#一般"],
            }),
        };
        enqueue(&porch, &rec).unwrap();
        let pending = list_pending(&porch).unwrap();
        assert_eq!(pending[0].payload_json["row_id"], "🦀-channel");
        assert_eq!(pending[0].payload_json["names"][1], "#общий");
    }
}
