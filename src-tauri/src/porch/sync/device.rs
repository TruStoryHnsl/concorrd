//! Porch Phase F — device-identity + device-link management.
//!
//! Two install-scoped concepts:
//!
//! * **Device identity** — a ULID minted on first Phase F boot,
//!   persisted in `device_identity`. This is the stable `(device_id,
//!   lamport)` author tag on every row this install writes. It does
//!   NOT change across restarts or porch re-opens.
//!
//! * **Device link** — a peer marked "personal device of mine". A link
//!   is **bilateral**: both peer A and peer B must call
//!   [`Porch::link_personal_device`] independently before sync runs.
//!   The protocol handler rejects sync requests from peers not in
//!   `device_links` (see `sync::protocol::SyncHandler`).
//!
//! The bilateral consent requirement is what makes the link
//! tamper-resistant. A malicious peer can't unilaterally promote
//! themselves into another user's device set — the other side has to
//! consent on their own UI. Both sides MAY exchange the initial
//! request via the wire `LinkRequest` method (`sync::protocol`), but
//! the row insert on each side still requires a local code path
//! (Tauri command call from the user's UI) to commit.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::porch::db::{unix_millis, Porch};
use crate::porch::error::PorchError;

/// One linked-personal-device row. Surfaces in the Personal Devices
/// settings tab; the UI shows `label` + `last_sync_at` per row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceLink {
    /// Libp2p peer-id of the linked device. PRIMARY KEY.
    pub peer_id: String,
    /// The remote install's Phase-F device-id (a ULID). Learned during
    /// the LinkRequest handshake.
    pub device_id: String,
    /// Always `"personal_device"` in Phase F. Future tiers (e.g.
    /// "read-only mirror") would add additional roles.
    pub role: String,
    /// Unix milliseconds — when this side first inserted the link.
    pub linked_at: i64,
    /// Unix milliseconds of the most recent successful sync round
    /// (pull-then-push) with this device, or `None` if no sync has yet
    /// completed.
    pub last_sync_at: Option<i64>,
    /// The highest `sync_lamport` we've ever observed in a row
    /// authored by this remote device. Drives the PullDelta cursor so
    /// subsequent rounds only pull deltas.
    pub last_sync_lamport: i64,
    /// User-facing nickname. Optional.
    pub label: Option<String>,
}

/// Always-`personal_device` role string. The CHECK constraint on
/// `device_links.role` admits only this value in Phase F.
pub const ROLE_PERSONAL_DEVICE: &str = "personal_device";

impl Porch {
    /// Phase F — this install's stable device-id (a ULID). The id is
    /// minted by the v6 migration and never changes for the life of
    /// the install. Returns `PorchError::InvalidInput` if the schema
    /// hasn't been migrated to v6 (which would only happen if a caller
    /// tried to use a too-old Porch struct — `Porch::open` always
    /// migrates to current).
    pub fn device_id(&self) -> Result<String, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let id: Option<String> = conn
            .query_row("SELECT device_id FROM device_identity LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;
        id.ok_or_else(|| {
            PorchError::InvalidInput(
                "device_identity row missing — Phase F migration did not run".to_string(),
            )
        })
    }

    /// Phase F — record that the local user has chosen to upgrade
    /// `peer_id` to "personal device" status. Idempotent — re-linking
    /// the same peer updates the label and refreshes
    /// `device_id` (in case the remote re-installed and minted a new
    /// device-id), but PRESERVES `linked_at` and the sync watermark so
    /// re-running the link doesn't reset our delta cursor.
    ///
    /// IMPORTANT: this is the LOCAL side of the link. The remote MUST
    /// call its own equivalent before sync over `/concord/porch-sync/`
    /// will succeed in the other direction.
    pub fn link_personal_device(
        &self,
        peer_id: &str,
        remote_device_id: &str,
        label: Option<&str>,
    ) -> Result<DeviceLink, PorchError> {
        if peer_id.trim().is_empty() {
            return Err(PorchError::InvalidInput(
                "peer_id must not be empty".to_string(),
            ));
        }
        if remote_device_id.trim().is_empty() {
            return Err(PorchError::InvalidInput(
                "device_id must not be empty".to_string(),
            ));
        }
        let now = unix_millis();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO device_links
                (peer_id, device_id, role, linked_at, last_sync_at,
                 last_sync_lamport, label)
             VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5)
             ON CONFLICT(peer_id) DO UPDATE SET
                 device_id = excluded.device_id,
                 label = excluded.label",
            params![peer_id, remote_device_id, ROLE_PERSONAL_DEVICE, now, label],
        )?;
        let row = read_link(&conn, peer_id)?
            .ok_or_else(|| {
                PorchError::InvalidInput("device_link insert vanished".to_string())
            })?;
        Ok(row)
    }

    /// Phase F — remove a personal-device link. Subsequent sync
    /// requests from `peer_id` will be refused by the protocol
    /// handler.
    pub fn unlink_device(&self, peer_id: &str) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "DELETE FROM device_links WHERE peer_id = ?1",
            params![peer_id],
        )?;
        Ok(())
    }

    /// Phase F — list every linked personal device, ordered by
    /// `linked_at` ascending so the UI surfaces them in the order the
    /// user added them.
    pub fn list_device_links(&self) -> Result<Vec<DeviceLink>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT peer_id, device_id, role, linked_at, last_sync_at,
                    last_sync_lamport, label
             FROM device_links
             ORDER BY linked_at ASC, peer_id ASC",
        )?;
        let rows = stmt.query_map([], row_to_link)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Phase F — is `peer_id` an authorized personal device?
    /// The protocol handler calls this BEFORE applying any inbound
    /// sync delta to enforce the trust boundary.
    pub fn is_personal_device(&self, peer_id: &str) -> Result<bool, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM device_links WHERE peer_id = ?1",
                params![peer_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(row.is_some())
    }

    /// Phase F — update `last_sync_at` after a successful round.
    /// Optionally advances `last_sync_lamport` if the supplied value
    /// is higher than the stored one (the cursor never moves
    /// backwards).
    pub fn record_sync_success(
        &self,
        peer_id: &str,
        at_ms: i64,
        observed_lamport: i64,
    ) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "UPDATE device_links
             SET last_sync_at = ?2,
                 last_sync_lamport = MAX(last_sync_lamport, ?3)
             WHERE peer_id = ?1",
            params![peer_id, at_ms, observed_lamport],
        )?;
        Ok(())
    }
}

fn read_link(
    conn: &rusqlite::Connection,
    peer_id: &str,
) -> Result<Option<DeviceLink>, PorchError> {
    let row = conn
        .query_row(
            "SELECT peer_id, device_id, role, linked_at, last_sync_at,
                    last_sync_lamport, label
             FROM device_links WHERE peer_id = ?1",
            params![peer_id],
            row_to_link,
        )
        .optional()?;
    Ok(row)
}

fn row_to_link(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceLink> {
    Ok(DeviceLink {
        peer_id: r.get(0)?,
        device_id: r.get(1)?,
        role: r.get(2)?,
        linked_at: r.get(3)?,
        last_sync_at: r.get(4)?,
        last_sync_lamport: r.get(5)?,
        label: r.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_is_minted_on_first_open() {
        let porch = Porch::open_in_memory().expect("open");
        let id = porch.device_id().expect("device id");
        assert!(!id.is_empty());
    }

    #[test]
    fn device_id_persists_across_reopen_when_filebacked() {
        let dir = tempfile::tempdir().expect("tmp");
        let id1 = {
            let porch = Porch::open(dir.path()).expect("open");
            porch.device_id().expect("device id")
        };
        let id2 = {
            let porch = Porch::open(dir.path()).expect("re-open");
            porch.device_id().expect("device id")
        };
        assert_eq!(id1, id2, "device_id must persist across re-open");
    }

    #[test]
    fn link_and_list_device_links() {
        let porch = Porch::open_in_memory().expect("open");
        let link = porch
            .link_personal_device("12D3KooWPhone", "01J5DEVICE", Some("My phone"))
            .expect("link ok");
        assert_eq!(link.peer_id, "12D3KooWPhone");
        assert_eq!(link.device_id, "01J5DEVICE");
        assert_eq!(link.label.as_deref(), Some("My phone"));
        assert_eq!(link.last_sync_lamport, 0);

        let list = porch.list_device_links().expect("list");
        assert_eq!(list.len(), 1);
        assert!(porch.is_personal_device("12D3KooWPhone").expect("is"));
        assert!(!porch.is_personal_device("12D3KooWStranger").expect("is"));
    }

    #[test]
    fn unlink_removes_row() {
        let porch = Porch::open_in_memory().expect("open");
        porch
            .link_personal_device("12D3KooWPhone", "01J", None)
            .expect("link");
        porch.unlink_device("12D3KooWPhone").expect("unlink");
        assert!(porch.list_device_links().expect("list").is_empty());
    }

    #[test]
    fn relink_preserves_sync_watermark() {
        let porch = Porch::open_in_memory().expect("open");
        porch
            .link_personal_device("12D3KooWPhone", "01JA", None)
            .expect("link");
        porch
            .record_sync_success("12D3KooWPhone", 1234, 99)
            .expect("record");
        // Re-link with a new label + device-id should preserve
        // the high watermark (so we don't accidentally re-pull
        // history on a label change).
        porch
            .link_personal_device("12D3KooWPhone", "01JB", Some("Renamed"))
            .expect("re-link");
        let row = &porch.list_device_links().expect("list")[0];
        assert_eq!(row.device_id, "01JB");
        assert_eq!(row.label.as_deref(), Some("Renamed"));
        assert_eq!(
            row.last_sync_lamport, 99,
            "sync watermark must survive re-link"
        );
    }
}
