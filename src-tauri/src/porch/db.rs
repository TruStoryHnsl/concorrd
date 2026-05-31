//! Porch DB layer — owns the `rusqlite::Connection`, applies migrations
//! idempotently on open, exposes thin CRUD helpers used by the Tauri
//! commands + the libp2p protocol handler.
//!
//! The DB file lives at `<porch_root>/porch.sqlite` (Phase A: callers
//! pass an `app_local_data_dir`-derived path). One process owns the
//! connection at a time; concurrent reads/writes from inside the
//! process go through a `Mutex<Connection>`-style wrapper in the Tauri
//! state layer.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use ulid::Ulid;

use super::channel::{AclMode, AclRole, ChannelKind, ChannelMessage, PorchChannel};
use super::error::PorchError;
use super::DEFAULT_PORCH_CHANNEL_ID;

/// Current schema version. Bump whenever a migration lands.
///
/// * `1` — Phase A: `porch_channels`, `channel_acl`, `channel_messages`.
/// * `2` — Phase B: `channel_knocks` (knock-to-enter pending requests
///   for inner channels with `acl_mode = 'allowlist'`).
/// * `3` — Phase C: `channel_themes` (per-channel aesthetic theme rows)
///   plus `porch_assets` (uploaded image blobs referenced by themes).
/// * `4` — Phase D: `obsidian_channels` (per-channel vault-root binding
///   for `kind = 'obsidian'` channels).
/// * `5` — Phase E: `backup_targets` (per backing-up side, who we
///   send our backup to) + `received_backups` (per backup-peer side,
///   opaque ciphertext blobs keyed by uploader peer-id).
pub const SCHEMA_VERSION: i64 = 5;

/// Subdirectory under the porch data dir where uploaded theme assets
/// (image bytes) live. The DB stores the relative file path
/// (`<asset_id>.<ext>`) under this root.
pub const PORCH_ASSETS_DIRNAME: &str = "porch_assets";

/// Subdirectory under the porch data dir where received encrypted backup
/// blobs (Phase E) land. One file per uploader peer-id; overwritten on
/// each subsequent upload.
pub const PORCH_BACKUPS_DIRNAME: &str = "porch_backups";

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
    /// `pub(super)` so sibling modules in `crate::porch` (e.g.
    /// [`crate::porch::knock`]) can drive the underlying connection
    /// without re-exposing it to the rest of the crate.
    pub(super) conn: Mutex<Connection>,
    /// Absolute path to the `porch_assets/` subdirectory under the
    /// porch's data dir. Phase C theme image uploads land here as
    /// `<asset_id>.<ext>`. `None` for in-memory porches — uploads
    /// fail with `PorchError::InvalidInput` in that case.
    pub(super) assets_root: Option<PathBuf>,
    /// Absolute path to the `porch_backups/` subdirectory under the
    /// porch's data dir. Phase E received-backup blobs land here as
    /// `<uploader_peer_id>.bin`. `None` for in-memory porches — the
    /// backup-peer side rejects uploads in that case.
    pub(super) backups_root: Option<PathBuf>,
    /// Absolute path to this porch's own `porch.sqlite` file. `None`
    /// for in-memory porches. Phase E uses this on the backing-up side
    /// to know which file to `VACUUM INTO` for the dump, and on the
    /// restore path to know where to write the decrypted bytes.
    pub(super) db_path: Option<PathBuf>,
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
        // Phase C — ensure the asset-storage subdir exists so theme
        // image uploads have somewhere to land. Idempotent.
        let assets_root = dir.join(PORCH_ASSETS_DIRNAME);
        std::fs::create_dir_all(&assets_root).map_err(PorchError::Io)?;
        // Phase E — ensure the received-backups subdir exists so the
        // backup-peer side has somewhere to land incoming blobs.
        let backups_root = dir.join(PORCH_BACKUPS_DIRNAME);
        std::fs::create_dir_all(&backups_root).map_err(PorchError::Io)?;
        let porch = Porch {
            conn: Mutex::new(conn),
            assets_root: Some(assets_root),
            backups_root: Some(backups_root),
            db_path: Some(path),
        };
        porch.migrate()?;
        porch.ensure_default_channel()?;
        Ok(porch)
    }

    /// Open an in-memory porch. Used by tests so they can spin up many
    /// independent instances cheaply without touching disk.
    ///
    /// In-memory porches have no `assets_root`, so Phase C asset
    /// uploads error with `PorchError::InvalidInput`. Tests that need
    /// the file-write path use `Porch::open` against a tempdir.
    pub fn open_in_memory() -> Result<Self, PorchError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let porch = Porch {
            conn: Mutex::new(conn),
            assets_root: None,
            backups_root: None,
            db_path: None,
        };
        porch.migrate()?;
        porch.ensure_default_channel()?;
        Ok(porch)
    }

    /// Absolute path to this porch's `porch_assets/` directory, if any.
    /// `None` for in-memory porches.
    pub fn assets_root(&self) -> Option<&Path> {
        self.assets_root.as_deref()
    }

    /// Absolute path to this porch's `porch_backups/` directory, if any.
    /// `None` for in-memory porches. Phase E uses this on the
    /// backup-peer side to land incoming encrypted blobs.
    pub fn backups_root(&self) -> Option<&Path> {
        self.backups_root.as_deref()
    }

    /// Absolute path to this porch's `porch.sqlite` file, if any. `None`
    /// for in-memory porches. Phase E uses this to drive the `VACUUM
    /// INTO` snapshot during backup creation.
    pub fn db_path(&self) -> Option<&Path> {
        self.db_path.as_deref()
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
        // Phase C migration runs after Phase B; both migrate fresh
        // installs and pre-Phase-C DBs in a single open call.
        if current < 2 {
            // Phase B migration. `channel_knocks` carries the
            // knock-to-enter request lifecycle. The partial unique index
            // enforces "at most one open knock per (channel, peer)";
            // withdraw/reject closes the slot so a peer can knock again
            // later. Re-knocking while a `pending` row already exists is
            // a no-op at the application layer (returns the existing
            // row) — see `Porch::knock`.
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE channel_knocks (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    knocker_peer_id TEXT NOT NULL,
                    message TEXT,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
                    created_at INTEGER NOT NULL,
                    resolved_at INTEGER,
                    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX idx_knock_pending_one_per_pair
                    ON channel_knocks(channel_id, knocker_peer_id)
                    WHERE status = 'pending';
                CREATE INDEX idx_knock_channel ON channel_knocks(channel_id);
                CREATE INDEX idx_knock_status ON channel_knocks(status);
                INSERT INTO schema_version (version) VALUES (2);
                COMMIT;",
            )?;
        }
        if current < 3 {
            // Phase C migration. Two new tables:
            //
            // * `channel_themes` — one row per channel, holds the four
            //   color anchors + font family + background descriptor.
            //   Hex colors are `#RRGGBB` (7 chars including the `#`).
            //   `background_kind` is one of none/solid/gradient/image;
            //   `background_value` holds either a hex color, a CSS
            //   gradient string, or the `id` of a row in
            //   `porch_assets`. The Rust layer is responsible for
            //   keeping `background_value` shape-consistent with
            //   `background_kind`.
            //
            // * `porch_assets` — per-channel uploaded image blobs. The
            //   bytes live on disk under `<data_dir>/porch_assets/`;
            //   the DB just carries the metadata + SHA-256 so themes
            //   can reference the asset by id without round-tripping
            //   the bytes through the wire envelope.
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE channel_themes (
                    channel_id TEXT PRIMARY KEY,
                    primary_color TEXT NOT NULL CHECK (length(primary_color) = 7 AND substr(primary_color, 1, 1) = '#'),
                    surface_color TEXT NOT NULL CHECK (length(surface_color) = 7 AND substr(surface_color, 1, 1) = '#'),
                    on_surface_color TEXT NOT NULL CHECK (length(on_surface_color) = 7 AND substr(on_surface_color, 1, 1) = '#'),
                    accent_color TEXT NOT NULL CHECK (length(accent_color) = 7 AND substr(accent_color, 1, 1) = '#'),
                    font_family TEXT NOT NULL,
                    background_kind TEXT NOT NULL CHECK (background_kind IN ('none', 'solid', 'gradient', 'image')),
                    background_value TEXT,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
                );
                CREATE TABLE porch_assets (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
                );
                CREATE INDEX idx_assets_channel ON porch_assets(channel_id);
                INSERT INTO schema_version (version) VALUES (3);
                COMMIT;",
            )?;
        }
        if current < 4 {
            // Phase D migration. `obsidian_channels` binds a channel of
            // `kind = 'obsidian'` to a vault directory on the owner's
            // disk. `vault_root` is canonicalized (realpath) on insert
            // so future security checks can prefix-compare directly. A
            // `subfolder` (optional, relative to vault_root) lets the
            // owner expose only a sub-tree of a larger vault.
            // `follow_symlinks` is OFF by default — a symlink pointing
            // out of the vault would otherwise be a trivial sandbox
            // escape (the design doc's Phase D open-question #1).
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE obsidian_channels (
                    channel_id TEXT PRIMARY KEY,
                    vault_root TEXT NOT NULL,
                    subfolder TEXT,
                    follow_symlinks INTEGER NOT NULL CHECK (follow_symlinks IN (0, 1)),
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
                );
                INSERT INTO schema_version (version) VALUES (4);
                COMMIT;",
            )?;
        }
        if current < 5 {
            // Phase E migration. Two new tables — they describe two
            // different SIDES of the backup flow and are independent on
            // any given install (a docker-hosted Concord acts only as a
            // backup PEER; a personal install acts mostly as a
            // backing-up side, but may also accept backups from a
            // partner reciprocally):
            //
            // * `backup_targets` — per backing-up side, the peers we've
            //   designated as recipients of our encrypted backup. The
            //   `last_*` columns surface in the Backup settings tab so
            //   the user can see whether the most recent push succeeded.
            //   A peer can be a target and not yet have received any
            //   blob — `last_success_at` is `NULL` in that state.
            //
            // * `received_backups` — per backup-peer side, the LATEST
            //   blob received from each uploader peer-id. The blob
            //   itself lives on disk under `<data_dir>/porch_backups/`;
            //   the row carries only the metadata + SHA-256 so the
            //   backup peer can disclose what it's holding without
            //   round-tripping ciphertext through SQL. PRIMARY KEY on
            //   `uploader_peer_id` enforces the "only the latest, no
            //   history" semantics — replays overwrite. (Revision
            //   pruning is a Phase E follow-up.)
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE backup_targets (
                    peer_id TEXT PRIMARY KEY,
                    label TEXT,
                    added_at INTEGER NOT NULL,
                    last_success_at INTEGER,
                    last_failure_at INTEGER,
                    last_failure_reason TEXT
                );
                CREATE TABLE received_backups (
                    uploader_peer_id TEXT PRIMARY KEY,
                    blob_path TEXT NOT NULL,
                    blob_size INTEGER NOT NULL,
                    blob_sha256 TEXT NOT NULL,
                    schema_version INTEGER NOT NULL,
                    received_at INTEGER NOT NULL
                );
                INSERT INTO schema_version (version) VALUES (5);
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
pub(super) fn unix_millis() -> i64 {
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
