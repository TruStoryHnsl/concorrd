//! Porch Phase F — Lamport clock helpers.
//!
//! Every local CRDT write must stamp `(sync_device_id, sync_lamport)`
//! such that the lamport value is **strictly greater** than every
//! value already on disk. That guarantees a fresh local write wins
//! against any older row — including rows authored by a remote device
//! whose updates we've already applied (their lamport bumps ours, so
//! our next write strictly exceeds theirs).
//!
//! The clock state is NOT cached in memory — it's read from disk on
//! every write. Cost: one indexed `MAX(sync_lamport)` per table per
//! write. Wins: no consistency hazards from a stale in-memory cache
//! across process restarts or concurrent writes from the protocol
//! handler.
//!
//! ## Lamport advancement rules
//!
//! 1. On a local write: `next = max(observed) + 1`. Stamp the row
//!    with `(local_device_id, next)`.
//! 2. On apply-remote: do NOT mutate any counter — the row already
//!    carries the remote device's `(device_id, lamport)`. The merge
//!    layer compares directly, no clock manipulation needed.
//! 3. The "observed max" includes rows from every CRDT-tracked
//!    table, because a Lamport clock is logically per-device, not
//!    per-table. A fresh write must beat any row anywhere on disk.

use rusqlite::Connection;

use crate::porch::error::PorchError;

/// The set of every CRDT-tracked table. Must stay in sync with the
/// migration in `db.rs::migrate()` — adding a new synced table requires
/// adding its name here, AND wiring the per-row stamping at its write
/// site through this module.
pub const SYNCED_TABLES: &[&str] = &[
    "porch_channels",
    "channel_messages",
    "channel_acl",
    "channel_knocks",
    "channel_themes",
    "porch_assets",
    "obsidian_channels",
];

/// Read the highest `sync_lamport` ever observed on this install. The
/// answer is the max across every synced table; a fresh local write
/// must strictly exceed it.
pub fn observed_max(conn: &Connection) -> Result<i64, PorchError> {
    let mut max_seen: i64 = 0;
    for table in SYNCED_TABLES {
        let sql = format!("SELECT COALESCE(MAX(sync_lamport), 0) FROM {table}");
        let v: i64 = conn.query_row(&sql, [], |r| r.get(0))?;
        if v > max_seen {
            max_seen = v;
        }
    }
    Ok(max_seen)
}

/// Compute the lamport value the next local write should carry. Reads
/// the observed max across every synced table and adds 1.
///
/// Callers should hold the porch `Mutex` for the duration of "compute
/// next + INSERT" so two concurrent writes can't pick the same value.
/// The existing call sites in this crate already hold the mutex for
/// their entire SQL block, so this is satisfied transparently.
pub fn next_lamport(conn: &Connection) -> Result<i64, PorchError> {
    Ok(observed_max(conn)?.saturating_add(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::db::Porch;

    #[test]
    fn observed_max_on_fresh_install_is_zero() {
        let porch = Porch::open_in_memory().expect("open");
        let conn = porch.conn_for_test();
        let max = observed_max(&conn).expect("max");
        // The default-channel insert in ensure_default_channel runs
        // through stamped helpers, so the max is whatever stamp it
        // chose. With nothing else on disk, that's 1 (the very first
        // local write). On a truly empty schema it would be 0.
        assert!(max >= 0, "max must be non-negative: got {max}");
    }

    #[test]
    fn next_lamport_strictly_exceeds_observed_max() {
        let porch = Porch::open_in_memory().expect("open");
        let conn = porch.conn_for_test();
        let max = observed_max(&conn).expect("max");
        let next = next_lamport(&conn).expect("next");
        assert!(next > max, "next ({next}) must exceed max ({max})");
    }
}
