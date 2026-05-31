//! Porch DB layer — owns the `rusqlite::Connection`, applies migrations
//! idempotently on open, exposes thin CRUD helpers used by the Tauri
//! commands + the libp2p protocol handler.
//!
//! The DB file lives at `<porch_root>/porch.sqlite` (Phase A: callers
//! pass an `app_local_data_dir`-derived path). One process owns the
//! connection at a time; concurrent reads/writes from inside the
//! process go through a `Mutex<Connection>`-style wrapper in the Tauri
//! state layer.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use ulid::Ulid;

use super::channel::{AclMode, AclRole, ChannelKind, ChannelMessage, PorchChannel};
use super::error::PorchError;
use super::DEFAULT_PORCH_CHANNEL_ID;

/// Current schema version. Bump whenever a migration lands.
const SCHEMA_VERSION: i64 = 1;

/// Default porch channel display name. Cosmetic — the id is the stable
/// reference.
const DEFAULT_PORCH_CHANNEL_NAME: &str = "Porch";

/// Default body cap for `PostMessage`. Anything larger is rejected with
/// `PorchError::InvalidInput`. The libp2p wire envelope itself is
/// capped at 1 MiB (in `protocol.rs`); this is the tighter per-message
/// limit applied at the application layer.
pub const MAX_MESSAGE_BODY_BYTES: usize = 64 * 1024;

/// Default limit cap on `get_messages` — even when the caller asks for
/// more, we cap here so a single envelope can't ship megabytes of
/// rows.
pub const MAX_MESSAGES_PER_QUERY: u32 = 500;

/// Owner of the porch SQLite connection. Single instance per install.
///
/// The connection is wrapped in a `Mutex` because every code path that
/// reads/writes must serialize — SQLite's `Connection` is `!Sync`. The
/// mutex is held only across single SQL operations; long-running
/// queries (cursor iteration) materialize results into Vec eagerly so
/// the lock isn't held across `.await` points.
pub struct Porch {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for Porch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Porch")
            .field("schema_version", &SCHEMA_VERSION)
            .finish_non_exhaustive()
    }
}

impl Porch {
    /// Open (or create) the porch DB at `<data_dir>/porch.sqlite`.
    /// Applies all migrations idempotently — safe to call repeatedly.
    /// Creates the directory if missing.
    pub fn open<P: AsRef<Path>>(data_dir: P) -> Result<Self, PorchError> {
        let dir = data_dir.as_ref();
        std::fs::create_dir_all(dir).map_err(PorchError::Io)?;
        let path = dir.join("porch.sqlite");
        let conn = Connection::open(&path)?;
        // Foreign keys are off by default in sqlite — turn them on so
        // the `ON DELETE CASCADE` on `channel_acl` / `channel_messages`
        // actually fires when a channel is deleted in a future phase.
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let porch = Porch {
            conn: Mutex::new(conn),
        };
        porch.migrate()?;
        porch.ensure_default_channel()?;
        Ok(porch)
    }

    /// Open an in-memory porch. Used by tests so they can spin up many
    /// independent instances cheaply without touching disk.
    pub fn open_in_memory() -> Result<Self, PorchError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let porch = Porch {
            conn: Mutex::new(conn),
        };
        porch.migrate()?;
        porch.ensure_default_channel()?;
        Ok(porch)
    }

    fn migrate(&self) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        // Migrations table — created unconditionally; idempotent.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
        )?;
        let current: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if current < 1 {
            // Phase A migration. All tables in one transaction.
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE porch_channels (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind IN ('porch', 'inner', 'obsidian')),
                    acl_mode TEXT NOT NULL CHECK (acl_mode IN ('open', 'allowlist', 'owner_only')),
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE channel_acl (
                    channel_id TEXT NOT NULL,
                    peer_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('visitor', 'member', 'owner')),
                    granted_at INTEGER NOT NULL,
                    PRIMARY KEY (channel_id, peer_id),
                    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
                );
                CREATE TABLE channel_messages (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    author_peer_id TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
                );
                CREATE INDEX idx_messages_channel_time ON channel_messages(channel_id, created_at);
                CREATE INDEX idx_acl_peer ON channel_acl(peer_id);
                INSERT INTO schema_version (version) VALUES (1);
                COMMIT;",
            )?;
        }
        // Future migrations: branch on `current` and apply incremental
        // batches here.
        Ok(())
    }

    fn ensure_default_channel(&self) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        // Only insert if NO channel exists yet — the test "open a fresh
        // porch sees exactly one row" depends on this. We deliberately
        // don't key on the well-known id alone, because a future
        // migration might want to import existing rows without creating
        // a spurious default.
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM porch_channels", [], |r| r.get(0))?;
        if count == 0 {
            let now = unix_millis();
            conn.execute(
                "INSERT INTO porch_channels (id, name, kind, acl_mode, created_at)
                 VALUES (?1, ?2, 'porch', 'open', ?3)",
                params![DEFAULT_PORCH_CHANNEL_ID, DEFAULT_PORCH_CHANNEL_NAME, now],
            )?;
        }
        Ok(())
    }

    /// List every channel in the porch. Sorted by `created_at` so the
    /// default `Porch` row reliably sits first.
    pub fn list_channels(&self) -> Result<Vec<PorchChannel>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, acl_mode, created_at
             FROM porch_channels
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let kind: String = r.get(2)?;
            let acl_mode: String = r.get(3)?;
            Ok(PorchChannel {
                id: r.get(0)?,
                name: r.get(1)?,
                // CHECK constraint guarantees valid; the `.unwrap_or`
                // is defence-in-depth against a future migration that
                // adds a variant the host doesn't know about yet.
                kind: ChannelKind::from_str(&kind).unwrap_or(ChannelKind::Inner),
                acl_mode: AclMode::from_str(&acl_mode).unwrap_or(AclMode::OwnerOnly),
                created_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Fetch a single channel by id. Returns `None` if the channel
    /// doesn't exist.
    pub fn get_channel(&self, channel_id: &str) -> Result<Option<PorchChannel>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row = conn
            .query_row(
                "SELECT id, name, kind, acl_mode, created_at
                 FROM porch_channels WHERE id = ?1",
                params![channel_id],
                |r| {
                    let kind: String = r.get(2)?;
                    let acl_mode: String = r.get(3)?;
                    Ok(PorchChannel {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        kind: ChannelKind::from_str(&kind).unwrap_or(ChannelKind::Inner),
                        acl_mode: AclMode::from_str(&acl_mode).unwrap_or(AclMode::OwnerOnly),
                        created_at: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Append a message to a channel. The id is a fresh ULID; the
    /// `created_at` field is the host's current unix-millis.
    ///
    /// Returns the inserted [`ChannelMessage`] so the caller can echo
    /// it back to the UI without a follow-up SELECT.
    pub fn post_message(
        &self,
        channel_id: &str,
        author_peer_id: &str,
        body: &str,
    ) -> Result<ChannelMessage, PorchError> {
        if body.is_empty() {
            return Err(PorchError::InvalidInput(
                "message body must not be empty".to_string(),
            ));
        }
        if body.len() > MAX_MESSAGE_BODY_BYTES {
            return Err(PorchError::InvalidInput(format!(
                "message body too large: {} > {}",
                body.len(),
                MAX_MESSAGE_BODY_BYTES
            )));
        }
        // Channel-existence check: the FOREIGN KEY would fire here too,
        // but we surface the typed `ChannelNotFound` so the wire layer
        // can return 404 instead of a generic 500.
        if self.get_channel(channel_id)?.is_none() {
            return Err(PorchError::ChannelNotFound {
                channel_id: channel_id.to_string(),
            });
        }
        let id = Ulid::new().to_string();
        let now = unix_millis();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO channel_messages (id, channel_id, author_peer_id, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, channel_id, author_peer_id, body, now],
        )?;
        Ok(ChannelMessage {
            id,
            channel_id: channel_id.to_string(),
            author_peer_id: author_peer_id.to_string(),
            body: body.to_string(),
            created_at: now,
        })
    }

    /// Page messages from a channel in `created_at` ascending order.
    /// `since` filters to rows newer than the cutoff (exclusive). Limit
    /// is capped at [`MAX_MESSAGES_PER_QUERY`] regardless of what the
    /// caller asked for.
    pub fn get_messages(
        &self,
        channel_id: &str,
        since: Option<i64>,
        limit: u32,
    ) -> Result<Vec<ChannelMessage>, PorchError> {
        // Channel-existence check first so the wire layer can 404
        // before we materialize any rows.
        if self.get_channel(channel_id)?.is_none() {
            return Err(PorchError::ChannelNotFound {
                channel_id: channel_id.to_string(),
            });
        }
        let capped = limit.min(MAX_MESSAGES_PER_QUERY);
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let since_value = since.unwrap_or(i64::MIN);
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, author_peer_id, body, created_at
             FROM channel_messages
             WHERE channel_id = ?1 AND created_at > ?2
             ORDER BY created_at ASC, id ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![channel_id, since_value, capped], |r| {
            Ok(ChannelMessage {
                id: r.get(0)?,
                channel_id: r.get(1)?,
                author_peer_id: r.get(2)?,
                body: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Grant (or update) an ACL row for the given peer + channel.
    /// Idempotent — re-granting the same role refreshes `granted_at`.
    pub fn grant_acl(
        &self,
        channel_id: &str,
        peer_id: &str,
        role: AclRole,
    ) -> Result<(), PorchError> {
        if self.get_channel(channel_id)?.is_none() {
            return Err(PorchError::ChannelNotFound {
                channel_id: channel_id.to_string(),
            });
        }
        let now = unix_millis();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO channel_acl (channel_id, peer_id, role, granted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(channel_id, peer_id) DO UPDATE SET
                 role = excluded.role,
                 granted_at = excluded.granted_at",
            params![channel_id, peer_id, role.as_str(), now],
        )?;
        Ok(())
    }

    /// Revoke an ACL row. Returns true if a row was removed.
    pub fn revoke_acl(&self, channel_id: &str, peer_id: &str) -> Result<bool, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let n = conn.execute(
            "DELETE FROM channel_acl WHERE channel_id = ?1 AND peer_id = ?2",
            params![channel_id, peer_id],
        )?;
        Ok(n > 0)
    }

    /// Insert a channel row directly. Phase A doesn't yet expose a
    /// `porch_create_channel` Tauri command — Phase B will — but
    /// tests need a way to mint inner channels with non-default ACL
    /// modes, so this stays public + module-doc'd as test-support
    /// + future-Phase-B seam.
    ///
    /// Idempotent on duplicate id: an INSERT-on-conflict-do-nothing
    /// makes re-running test setup harmless.
    pub fn insert_channel(
        &self,
        id: &str,
        name: &str,
        kind: ChannelKind,
        acl_mode: AclMode,
    ) -> Result<PorchChannel, PorchError> {
        let now = unix_millis();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO porch_channels (id, name, kind, acl_mode, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![id, name, kind.as_str(), acl_mode.as_str(), now],
        )?;
        Ok(PorchChannel {
            id: id.to_string(),
            name: name.to_string(),
            kind,
            acl_mode,
            created_at: now,
        })
    }

    /// Read the ACL role assigned to `peer_id` for `channel_id`, if
    /// any. `None` means the peer has no row.
    pub fn lookup_acl(
        &self,
        channel_id: &str,
        peer_id: &str,
    ) -> Result<Option<AclRole>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let role: Option<String> = conn
            .query_row(
                "SELECT role FROM channel_acl WHERE channel_id = ?1 AND peer_id = ?2",
                params![channel_id, peer_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(role.and_then(|s| AclRole::from_str(&s)))
    }
}

/// Current unix time in milliseconds. Used as the `created_at` /
/// `granted_at` source of truth. Saturates to 0 on the (impossible)
/// case of a negative `SystemTime::now()`.
fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_inserts_one_default_channel() {
        let porch = Porch::open_in_memory().expect("open ok");
        let channels = porch.list_channels().expect("list ok");
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].id, DEFAULT_PORCH_CHANNEL_ID);
        assert_eq!(channels[0].kind, ChannelKind::Porch);
        assert_eq!(channels[0].acl_mode, AclMode::Open);
    }

    #[test]
    fn migrate_is_idempotent() {
        let porch = Porch::open_in_memory().expect("open ok");
        // Re-running migrations on the same conn must not error or
        // produce duplicate default channels.
        porch.migrate().expect("re-migrate ok");
        porch.ensure_default_channel().expect("re-ensure ok");
        let channels = porch.list_channels().expect("list ok");
        assert_eq!(channels.len(), 1, "default channel must not duplicate");
    }

    #[test]
    fn post_message_round_trip_in_order() {
        let porch = Porch::open_in_memory().expect("open ok");
        for body in ["one", "two", "three"] {
            porch
                .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3Author", body)
                .expect("post ok");
            // Bump the clock floor so ULIDs are monotonic in tests
            // that race the millisecond boundary.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let messages = porch
            .get_messages(DEFAULT_PORCH_CHANNEL_ID, None, 10)
            .expect("get ok");
        assert_eq!(messages.len(), 3);
        let bodies: Vec<&str> = messages.iter().map(|m| m.body.as_str()).collect();
        assert_eq!(bodies, vec!["one", "two", "three"]);
    }

    #[test]
    fn post_to_missing_channel_errors() {
        let porch = Porch::open_in_memory().expect("open ok");
        let err = porch
            .post_message("does-not-exist", "12D3", "hi")
            .expect_err("must error");
        assert!(matches!(err, PorchError::ChannelNotFound { .. }));
    }

    #[test]
    fn empty_body_rejected() {
        let porch = Porch::open_in_memory().expect("open ok");
        let err = porch
            .post_message(DEFAULT_PORCH_CHANNEL_ID, "12D3", "")
            .expect_err("must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn acl_grant_revoke_lookup() {
        let porch = Porch::open_in_memory().expect("open ok");
        porch
            .grant_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Visitor", AclRole::Member)
            .expect("grant ok");
        let role = porch
            .lookup_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Visitor")
            .expect("lookup ok");
        assert_eq!(role, Some(AclRole::Member));
        // Idempotent re-grant updates without erroring.
        porch
            .grant_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Visitor", AclRole::Owner)
            .expect("re-grant ok");
        let role = porch
            .lookup_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Visitor")
            .expect("lookup ok");
        assert_eq!(role, Some(AclRole::Owner));
        // Revoke + verify.
        assert!(porch
            .revoke_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Visitor")
            .expect("revoke ok"));
        let role = porch
            .lookup_acl(DEFAULT_PORCH_CHANNEL_ID, "12D3Visitor")
            .expect("lookup ok");
        assert_eq!(role, None);
    }

    #[test]
    fn get_messages_since_filters_older_rows() {
        let porch = Porch::open_in_memory().expect("open ok");
        let m1 = porch
            .post_message(DEFAULT_PORCH_CHANNEL_ID, "a", "early")
            .expect("post ok");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let _m2 = porch
            .post_message(DEFAULT_PORCH_CHANNEL_ID, "a", "late")
            .expect("post ok");
        let only_late = porch
            .get_messages(DEFAULT_PORCH_CHANNEL_ID, Some(m1.created_at), 10)
            .expect("get ok");
        assert_eq!(only_late.len(), 1);
        assert_eq!(only_late[0].body, "late");
    }
}
