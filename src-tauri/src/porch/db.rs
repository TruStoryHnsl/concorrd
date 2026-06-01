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
/// * `6` — Phase F: `device_identity` (this install's stable device-id
///   ULID, generated once on first F-boot), `device_links` (peers
///   bilaterally upgraded to "personal device" status — sync is gated
///   on a row existing here), plus `sync_device_id` / `sync_lamport` /
///   `sync_tombstone` columns added to every CRDT-tracked table
///   (`porch_channels`, `channel_messages`, `channel_acl`,
///   `channel_knocks`, `channel_themes`, `porch_assets`,
///   `obsidian_channels`). Pre-Phase-F rows are backfilled with this
///   install's `device_id` and `sync_lamport = 0`.
/// * `7` — User Management Phase 1: `user_profiles` (per-install
///   identities; `is_primary` partial-unique-index enforces "at most
///   one primary at a time"; `provenance` discriminates local vs.
///   relay-restored origin) + `keychain_entries` (FK to a profile,
///   ChaCha20-Poly1305 ciphertext + nonce — credentials encrypted at
///   the keychain layer, NOT inside SQLite). Both tables carry Phase F
///   sync metadata from the get-go so Phase 4 can ride the existing
///   CRDT layer without a schema migration. A default "Local" primary
///   profile is seeded so the install always has somewhere for Phase 2
///   source-add flows to write.
/// * `8` — F1b-IMPL — "home server" re-hosting: `home_meta`
///   key/value table to carry the user-set name of the persistent
///   home server (default `"home"`) and any future home-server
///   meta. The existing `porch.sqlite` file is being repurposed as
///   the home server's backing store; the module + file rename
///   from `porch` → `home` is deliberately deferred to a follow-up
///   PR to keep this migration small. See `instructions_inbox.md`
///   2026-06-01 CONSOLIDATED ARCHITECTURE filing for the full
///   re-scope rationale.
/// * `9` — F-VIS — per-server mesh-hop visibility property:
///   `visibility_meta` table keyed by `server_id` ("porch", "home", or
///   a future user-created server's UUID). Carries `max_hops` (0 =
///   owner-only; 1 = direct paired; N = up to N mesh hops away) and
///   `last_changed_at` for sync ordering. Seeded on first open with
///   the defaults from the 2026-06-01 RFC-resolution filing: porch at
///   hop-1, home at hop-0. See [`crate::porch::visibility`] for the
///   CRUD layer + the gossipsub propagation payload that flows
///   through F3's address-rotation topic.
/// * `10` — F-D — Resumable conflict-agent session:
///   `conflict_queue` (one row per detected destructive sync conflict,
///   per RFC §5.c–d) + `conflict_attempts` (append-only per-attempt
///   audit trail with per-attempt partial-context snapshots that flow
///   into the NEXT attempt's preamble when a previous attempt timed
///   out). The orchestration loop in
///   [`crate::porch::conflict_agent`] drives these tables; F-D is the
///   first hand-off contract from F-C's conflict-detection layer to
///   the agent-dispatch layer. See `docs/architecture/
///   resumable-conflict-agent-scope.md` for the full design.
pub const SCHEMA_VERSION: i64 = 10;

/// Server id used by `visibility_meta` for the ephemeral PORCH server.
/// Hard-coded literal because the porch is intrinsic — not user-created
/// and not assigned a UUID.
pub const VISIBILITY_SERVER_ID_PORCH: &str = "porch";

/// Server id used by `visibility_meta` for the persistent HOME server.
/// Hard-coded literal — the home server is intrinsic on every install.
pub const VISIBILITY_SERVER_ID_HOME: &str = "home";

/// Default max-hops for the porch server. Hop-1 = direct paired peers
/// only; matches the 2026-06-01 CONSOLIDATED ARCHITECTURE filing.
pub const DEFAULT_PORCH_MAX_HOPS: u8 = 1;

/// Default max-hops for the home server. Hop-0 = owner-only; the user
/// must explicitly open it via the Hosting → Visibility surface.
pub const DEFAULT_HOME_MAX_HOPS: u8 = 0;

/// Default name of the persistent home server. Stored in `home_meta`
/// under the `server_name` key on first open. The user can rename it
/// via the Tauri command `home_set_server_name`.
pub const DEFAULT_HOME_SERVER_NAME: &str = "home";

/// Maximum allowed length (in chars) for the user-set home server
/// name. Matches the `set_instance_name` cap so both vanity-label
/// surfaces are consistent on the wire.
pub const MAX_HOME_SERVER_NAME_CHARS: usize = 64;

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

/// F-VIS — one row of the `visibility_meta` table. Serializable so the
/// renderer can render it directly + so the gossipsub propagation
/// layer can use the same struct on the wire (a small additive payload
/// — see [`crate::porch::visibility::VisibilityUpdate`]).
///
/// `server_id` is the stable identifier ("porch", "home", or a future
/// user-created server's UUID). `max_hops` is the configurable mesh-hop
/// visibility ceiling: 0 = owner only, 1 = direct paired, N = up to N
/// hops away. `last_changed_at` is unix-millis; the LWW merge rule for
/// inbound updates is "strictly greater wins."
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct VisibilityRow {
    pub server_id: String,
    pub max_hops: u8,
    pub last_changed_at: i64,
}

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
        if current < 6 {
            // Phase F migration. Two new tables + sync metadata columns
            // on every CRDT-tracked table. The migration is idempotent
            // across both fresh installs (where the v1-v5 tables were
            // just created above) and pre-Phase-F DBs (where rows
            // already exist and need backfilling).
            //
            // Backfill semantics: every pre-Phase-F row is treated as
            // having been authored by THIS install's device-id at
            // lamport 0. That gives merge.rs a stable LWW basis — a
            // newer write on any device produces a strictly larger
            // lamport, so backfilled rows never spuriously win against
            // legitimate post-migration writes.
            //
            // The device_id is generated here (a ULID) the first time
            // the migration runs and persisted in `device_identity`.
            // Subsequent migrations are a no-op because `current >= 6`.
            let device_id = Ulid::new().to_string();
            let now = unix_millis();
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE device_identity (
                    device_id TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL,
                    label TEXT
                );
                CREATE TABLE device_links (
                    peer_id TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('personal_device')),
                    linked_at INTEGER NOT NULL,
                    last_sync_at INTEGER,
                    last_sync_lamport INTEGER NOT NULL DEFAULT 0,
                    label TEXT
                );
                COMMIT;",
            )?;
            conn.execute(
                "INSERT INTO device_identity (device_id, created_at, label)
                 VALUES (?1, ?2, NULL)",
                params![device_id, now],
            )?;

            // ALTER TABLE … ADD COLUMN: rusqlite executes one statement
            // per call. The columns may already exist if a prior
            // partial migration ran — guard with a PRAGMA table_info
            // check so this stays idempotent on top of half-applied
            // databases.
            for table in [
                "porch_channels",
                "channel_messages",
                "channel_acl",
                "channel_knocks",
                "channel_themes",
                "porch_assets",
                "obsidian_channels",
            ] {
                add_sync_columns_if_missing(&conn, table)?;
            }

            // Backfill: every existing row gets stamped with this
            // install's device-id at lamport 0. Tombstone defaults to
            // 0 (alive) per the ADD COLUMN default.
            for table in [
                "porch_channels",
                "channel_messages",
                "channel_acl",
                "channel_knocks",
                "channel_themes",
                "porch_assets",
                "obsidian_channels",
            ] {
                let sql = format!(
                    "UPDATE {table} SET sync_device_id = ?1
                     WHERE sync_device_id IS NULL"
                );
                conn.execute(&sql, params![device_id])?;
            }

            // Per-table sync indexes for "give me everything newer
            // than X" queries that drive PullDelta. Lamport is
            // monotonically increasing per-device, so the index is
            // a useful B-tree.
            conn.execute_batch(
                "BEGIN;
                CREATE INDEX IF NOT EXISTS idx_channels_sync   ON porch_channels(sync_lamport);
                CREATE INDEX IF NOT EXISTS idx_messages_sync   ON channel_messages(sync_lamport);
                CREATE INDEX IF NOT EXISTS idx_acl_sync        ON channel_acl(sync_lamport);
                CREATE INDEX IF NOT EXISTS idx_knocks_sync     ON channel_knocks(sync_lamport);
                CREATE INDEX IF NOT EXISTS idx_themes_sync     ON channel_themes(sync_lamport);
                CREATE INDEX IF NOT EXISTS idx_assets_sync     ON porch_assets(sync_lamport);
                CREATE INDEX IF NOT EXISTS idx_obsidian_sync   ON obsidian_channels(sync_lamport);
                INSERT INTO schema_version (version) VALUES (6);
                COMMIT;",
            )?;
        }
        if current < 7 {
            // User Management Phase 1 migration. Two new tables:
            //
            // * `user_profiles` — per-install user identities. Each
            //   row is a Concord profile that may own zero-or-more
            //   keychain entries. `is_primary` is enforced "at most
            //   one row = 1" by a partial unique index, NOT by a
            //   per-row CHECK — the application layer is responsible
            //   for atomically clearing the previous primary in the
            //   same transaction when promoting a new one. The
            //   provenance column records where the profile came from:
            //   `local` for any profile created on this install,
            //   `relay_restored` for any profile pulled from an
            //   account relay (Phase 3 lights this variant up; in
            //   Phase 1 every profile is `local`).
            //
            // * `keychain_entries` — encrypted credential bag owned by
            //   a profile. The plaintext credentials (access_token,
            //   user_id, device_id, etc.) live inside `ciphertext`
            //   encrypted with ChaCha20-Poly1305 keyed by HKDF-SHA256
            //   from the Stronghold seed; the `nonce` column carries
            //   the per-entry 12-byte AEAD nonce. SQLite never sees
            //   plaintext credentials — that's the load-bearing
            //   security property. `FOREIGN KEY … ON DELETE CASCADE`
            //   makes profile deletion drop the owned keychain rows
            //   automatically.
            //
            // Both tables carry the Phase F sync metadata columns
            // (`sync_device_id`, `sync_lamport`, `sync_tombstone`)
            // from the get-go so Phase 4 (multi-device sync of the
            // keychain) can ride the existing CRDT layer without a
            // schema migration. The lamport stamping is done at the
            // application layer in `porch::users`; the columns are
            // NOT enforced NOT NULL at the SQL level for symmetry
            // with how Phase F ALTER-added the same columns to
            // pre-existing tables.
            //
            // Default seed: a single primary "Local" profile so the
            // install always has somewhere for Phase 2 source-add
            // flows to write. Done unconditionally during this
            // migration; subsequent app boots see `current >= 7` and
            // never re-seed.
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE user_profiles (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    avatar_url TEXT,
                    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
                    provenance TEXT NOT NULL CHECK (provenance IN ('local', 'relay_restored')),
                    created_at INTEGER NOT NULL,
                    sync_device_id TEXT,
                    sync_lamport INTEGER DEFAULT 0,
                    sync_tombstone INTEGER DEFAULT 0
                );
                CREATE TABLE keychain_entries (
                    id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL,
                    source_kind TEXT NOT NULL CHECK (source_kind IN ('concord', 'matrix', 'p2p_peer')),
                    source_host TEXT NOT NULL,
                    label TEXT,
                    ciphertext BLOB NOT NULL,
                    nonce BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER,
                    sync_device_id TEXT,
                    sync_lamport INTEGER DEFAULT 0,
                    sync_tombstone INTEGER DEFAULT 0,
                    FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX idx_only_one_primary
                    ON user_profiles(is_primary)
                    WHERE is_primary = 1;
                CREATE INDEX idx_keychain_by_profile ON keychain_entries(profile_id);
                CREATE INDEX idx_keychain_by_source  ON keychain_entries(source_host);
                CREATE INDEX idx_profiles_sync       ON user_profiles(sync_lamport);
                CREATE INDEX idx_keychain_sync       ON keychain_entries(sync_lamport);
                INSERT INTO schema_version (version) VALUES (7);
                COMMIT;",
            )?;

            // Seed a single primary "Local" profile so the install
            // always has somewhere for Phase 2 source-add flows to
            // write. Stamped with this install's device-id at the
            // next lamport value, so Phase 4 sync attribution is
            // correct from row zero.
            let device_id = device_id_unchecked(&conn)?;
            let lamport = crate::porch::sync::clock::next_lamport(&conn)?;
            let now = unix_millis();
            let profile_id = Ulid::new().to_string();
            conn.execute(
                "INSERT INTO user_profiles
                    (id, display_name, avatar_url, is_primary, provenance,
                     created_at, sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, 'Local', NULL, 1, 'local', ?2, ?3, ?4, 0)",
                params![profile_id, now, device_id, lamport],
            )?;
        }
        if current < 8 {
            // F1b-IMPL — "home server" re-hosting.
            //
            // The existing `porch.sqlite` is being repurposed as the
            // backing store of the persistent HOME server (see the
            // 2026-06-01 CONSOLIDATED ARCHITECTURE filing in
            // `instructions_inbox.md`). Renaming the module + file from
            // `porch` to `home` is deferred to a follow-up PR; this
            // migration just adds a tiny `home_meta` key/value table so
            // we can surface and persist the user-set home-server name
            // without touching any of the legacy `porch_*` tables.
            //
            // The default `server_name` row is seeded here with the
            // literal `"home"`; the user can rename it via the
            // `home_set_server_name` Tauri command. `INSERT OR IGNORE`
            // makes a subsequent boot a no-op (the seed only applies
            // when there's nothing in the table yet, mirroring the
            // `ensure_default_channel` semantics).
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE IF NOT EXISTS home_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT INTO schema_version (version) VALUES (8);
                COMMIT;",
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO home_meta (key, value) VALUES ('server_name', ?1)",
                params![DEFAULT_HOME_SERVER_NAME],
            )?;
        }
        if current < 9 {
            // F-VIS — per-server mesh-hop visibility property.
            //
            // The `visibility_meta` table stores a single
            // (server_id, max_hops, last_changed_at) tuple per server
            // the operator hosts. The two intrinsic servers (porch +
            // home) are seeded immediately with the defaults from the
            // 2026-06-01 RFC-resolution filing: porch at hop-1 (only
            // direct paired peers see it in their explore menu), home
            // at hop-0 (owner-only until explicitly opened).
            //
            // `max_hops` is stored as INTEGER for SQLite simplicity but
            // capped at 0..=255 at the application layer
            // (visibility::set_max_hops). 255 is plenty for any
            // realistic mesh diameter and keeps the wire payload tiny.
            //
            // `last_changed_at` is unix-milliseconds — same convention
            // as the other `*_at` columns in this schema. It exists so
            // future cross-device sync (via the existing F gossipsub
            // topic) can resolve "who has the freshest setting" by
            // strict numeric comparison, no Lamport bookkeeping needed
            // because a single owner edits per row.
            //
            // The `INSERT OR IGNORE` seeding mirrors `home_meta`'s
            // first-open pattern; on a re-run (which can't happen at
            // current >= 9, but is defended-in-depth anyway) the rows
            // stay untouched.
            let now = unix_millis();
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE IF NOT EXISTS visibility_meta (
                    server_id TEXT PRIMARY KEY,
                    max_hops INTEGER NOT NULL DEFAULT 0,
                    last_changed_at INTEGER NOT NULL
                );
                INSERT INTO schema_version (version) VALUES (9);
                COMMIT;",
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO visibility_meta
                    (server_id, max_hops, last_changed_at)
                 VALUES (?1, ?2, ?3)",
                params![
                    VISIBILITY_SERVER_ID_PORCH,
                    DEFAULT_PORCH_MAX_HOPS as i64,
                    now,
                ],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO visibility_meta
                    (server_id, max_hops, last_changed_at)
                 VALUES (?1, ?2, ?3)",
                params![
                    VISIBILITY_SERVER_ID_HOME,
                    DEFAULT_HOME_MAX_HOPS as i64,
                    now,
                ],
            )?;
        }
        if current < 10 {
            // F-D — Resumable conflict-agent session.
            //
            // Two new tables drive the conflict-resolver loop:
            //
            // * `conflict_queue` — one row per destructive sync conflict
            //   detected by F-C. `conflict_kind` is the discriminator
            //   from RFC §5.c (`concurrent_rename`, `tombstone_vs_write`,
            //   `acl_change`, etc.); `payload_json` carries the two
            //   competing event payloads + their Lamport stamps as a
            //   self-contained JSON blob so the resolver can reason about
            //   the conflict without joining back to `event_log`.
            //
            //   `resolved_at` + `final_verdict_json` are populated when
            //   the first successful attempt completes. The
            //   `manual_required` status (column `status` defaulting to
            //   `'pending'`) is set when the orchestrator has burned its
            //   retry budget; a user manually resolving via
            //   `conflict_queue_manual_resolve` ALSO populates these
            //   columns, with `final_verdict_json` carrying the user's
            //   verdict.
            //
            // * `conflict_attempts` — append-only audit trail. Each
            //   attempt records `started_at`, `ended_at`, `state`
            //   (`running` | `succeeded` | `timeout` | `aborted`),
            //   `partial_context_blob` (the agent's working state at the
            //   most recent heartbeat snapshot — see the conflict_agent
            //   module's hand-off contract), and `partial_verdict_json`
            //   (any tentative reasoning the agent emitted before
            //   succeeding or timing out).
            //
            //   The orchestration loop picks up where a timed-out attempt
            //   left off by reading the last attempt's
            //   `partial_context_blob` and embedding it as a
            //   `<<previous-session>>` preamble in the NEW attempt's
            //   input. That's the resume-on-timeout pipeline described
            //   in `docs/architecture/resumable-conflict-agent-scope.md`.
            //
            // `ON DELETE CASCADE` keeps the attempts log tied to its
            // conflict, so dropping a conflict (rare — typically the
            // orchestrator marks `manual_required` instead) cleans up
            // its history. The indices accelerate the two hot queries:
            // "give me unresolved conflicts in queued order" and "give
            // me the most-recent attempt for this conflict."
            conn.execute_batch(
                "BEGIN;
                CREATE TABLE IF NOT EXISTS conflict_queue (
                    conflict_id TEXT PRIMARY KEY,
                    conflict_kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    queued_at INTEGER NOT NULL,
                    resolved_at INTEGER,
                    final_verdict_json TEXT,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'resolved', 'manual_required'))
                );
                CREATE TABLE IF NOT EXISTS conflict_attempts (
                    attempt_id TEXT PRIMARY KEY,
                    conflict_id TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    state TEXT NOT NULL
                        CHECK (state IN ('running', 'succeeded', 'timeout', 'aborted')),
                    partial_context_blob TEXT,
                    partial_verdict_json TEXT,
                    FOREIGN KEY (conflict_id) REFERENCES conflict_queue(conflict_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_conflict_queue_unresolved
                    ON conflict_queue(queued_at)
                    WHERE resolved_at IS NULL;
                CREATE INDEX IF NOT EXISTS idx_conflict_attempts_by_conflict
                    ON conflict_attempts(conflict_id, started_at);
                INSERT INTO schema_version (version) VALUES (10);
                COMMIT;",
            )?;
        }
        // Future migrations: branch on `current` and apply incremental
        // batches here.
        Ok(())
    }

    /// Read the user-set name of the home server from `home_meta`.
    /// Returns the literal default [`DEFAULT_HOME_SERVER_NAME`] when no
    /// row is present (defensive — the migration seeds it, so this only
    /// fires on a hypothetically-damaged DB).
    pub fn home_server_name(&self) -> Result<String, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM home_meta WHERE key = 'server_name'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(value.unwrap_or_else(|| DEFAULT_HOME_SERVER_NAME.to_string()))
    }

    /// Persist a new user-set name for the home server. Validation:
    /// trims whitespace, rejects an empty result, caps length at
    /// [`MAX_HOME_SERVER_NAME_CHARS`] chars. Idempotent on the same
    /// value.
    pub fn set_home_server_name(&self, name: &str) -> Result<(), PorchError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(PorchError::InvalidInput(
                "home server name must not be empty".to_string(),
            ));
        }
        if trimmed.chars().count() > MAX_HOME_SERVER_NAME_CHARS {
            return Err(PorchError::InvalidInput(format!(
                "home server name must be {} characters or fewer",
                MAX_HOME_SERVER_NAME_CHARS
            )));
        }
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO home_meta (key, value) VALUES ('server_name', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![trimmed],
        )?;
        Ok(())
    }

    /// F-VIS — read a single `visibility_meta` row. Returns the
    /// seeded defaults for the intrinsic porch / home servers, or
    /// whatever value the user (or a remote update) has persisted
    /// since. `None` for an unknown `server_id` so callers can
    /// distinguish "no such server" from "default value".
    pub fn get_visibility(
        &self,
        server_id: &str,
    ) -> Result<Option<VisibilityRow>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row: Option<(i64, i64)> = conn
            .query_row(
                "SELECT max_hops, last_changed_at
                 FROM visibility_meta WHERE server_id = ?1",
                params![server_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(hops, ts)| VisibilityRow {
            server_id: server_id.to_string(),
            // Clamp at 0..=255 on read so a corrupt DB never panics
            // the renderer.
            max_hops: hops.clamp(0, u8::MAX as i64) as u8,
            last_changed_at: ts,
        }))
    }

    /// F-VIS — write or update a `visibility_meta` row. Validates
    /// `max_hops` is in `0..=255` (255 is the SQL-side INTEGER cap we
    /// enforce). Bumps `last_changed_at` to `unix_millis()` so the
    /// gossipsub propagation layer can pick the freshest setting on
    /// merge.
    ///
    /// Returns the resulting [`VisibilityRow`] so the caller can echo
    /// the persisted state to the renderer without a follow-up SELECT.
    pub fn set_visibility(
        &self,
        server_id: &str,
        max_hops: u8,
    ) -> Result<VisibilityRow, PorchError> {
        if server_id.trim().is_empty() {
            return Err(PorchError::InvalidInput(
                "server_id must not be empty".to_string(),
            ));
        }
        let now = unix_millis();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO visibility_meta
                (server_id, max_hops, last_changed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(server_id) DO UPDATE SET
                max_hops = excluded.max_hops,
                last_changed_at = excluded.last_changed_at",
            params![server_id, max_hops as i64, now],
        )?;
        Ok(VisibilityRow {
            server_id: server_id.to_string(),
            max_hops,
            last_changed_at: now,
        })
    }

    /// F-VIS — apply an inbound `VisibilityRow` only if its
    /// `last_changed_at` is strictly greater than the local value
    /// (LWW). Used by the gossipsub receiver to merge neighbour-broadcast
    /// updates without clobbering a fresher local edit. Returns `true`
    /// if the row was actually written, `false` if the inbound value
    /// was equal-or-older and silently ignored.
    pub fn apply_visibility_if_newer(
        &self,
        row: &VisibilityRow,
    ) -> Result<bool, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let existing: Option<i64> = conn
            .query_row(
                "SELECT last_changed_at FROM visibility_meta WHERE server_id = ?1",
                params![row.server_id],
                |r| r.get(0),
            )
            .optional()?;
        let should_write = match existing {
            Some(local_ts) => row.last_changed_at > local_ts,
            None => true,
        };
        if !should_write {
            return Ok(false);
        }
        conn.execute(
            "INSERT INTO visibility_meta
                (server_id, max_hops, last_changed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(server_id) DO UPDATE SET
                max_hops = excluded.max_hops,
                last_changed_at = excluded.last_changed_at",
            params![
                row.server_id,
                row.max_hops as i64,
                row.last_changed_at,
            ],
        )?;
        Ok(true)
    }

    /// F-VIS — list every visibility row. Used by the renderer's
    /// Hosting tab to show all currently-tracked server visibility
    /// settings at once. Order is `server_id ASC` for deterministic
    /// rendering.
    pub fn list_visibility(&self) -> Result<Vec<VisibilityRow>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT server_id, max_hops, last_changed_at
             FROM visibility_meta ORDER BY server_id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let hops: i64 = r.get(1)?;
            Ok(VisibilityRow {
                server_id: r.get(0)?,
                max_hops: hops.clamp(0, u8::MAX as i64) as u8,
                last_changed_at: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
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
            // Phase F — stamp the row with this install's device-id at
            // the next lamport value. The default-channel insert is the
            // very first row written; if no other row is on disk, the
            // lamport ends up at 1 (next_lamport adds 1 to the
            // observed max of 0). The insert-ordering matters because
            // the LWW comparator in merge.rs uses (lamport, device_id)
            // — a fresh local edit must strictly exceed this baseline.
            let device_id = device_id_unchecked(&conn)?;
            let lamport = crate::porch::sync::clock::next_lamport(&conn)?;
            conn.execute(
                "INSERT INTO porch_channels
                    (id, name, kind, acl_mode, created_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, 'porch', 'open', ?3, ?4, ?5, 0)",
                params![
                    DEFAULT_PORCH_CHANNEL_ID,
                    DEFAULT_PORCH_CHANNEL_NAME,
                    now,
                    device_id,
                    lamport,
                ],
            )?;
        }
        Ok(())
    }

    /// Test-only escape hatch: hand back the locked `Connection` so
    /// integration tests can inspect/poke CRDT metadata without going
    /// through the public Porch API. Hidden behind the `test-support`
    /// feature in production builds; integration tests always have
    /// `cfg(test)` so they see it too.
    #[doc(hidden)]
    pub fn conn_for_test(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("porch conn mutex poisoned")
    }

    /// List every channel in the porch. Sorted by `created_at` so the
    /// default `Porch` row reliably sits first.
    pub fn list_channels(&self) -> Result<Vec<PorchChannel>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        // Phase F — tombstoned channels (from a delete on another
        // device synced over) are hidden from the listing surface so
        // the UI doesn't show deleted rooms.
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, acl_mode, created_at
             FROM porch_channels
             WHERE sync_tombstone = 0
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
        // Phase F — stamp every new message with this install's
        // (device_id, next_lamport) so the row is correctly attributed
        // for CRDT merge. Messages are insert-only in Phase F (deletes
        // are tombstones, not implemented yet) so sync_tombstone is
        // hard-coded to 0.
        let device_id = device_id_unchecked(&conn)?;
        let lamport = crate::porch::sync::clock::next_lamport(&conn)?;
        conn.execute(
            "INSERT INTO channel_messages
                (id, channel_id, author_peer_id, body, created_at,
                 sync_device_id, sync_lamport, sync_tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            params![id, channel_id, author_peer_id, body, now, device_id, lamport],
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
        // Phase F — stamp the ACL row with this install's
        // (device_id, next_lamport). The CRDT shape on ACL is LWW per
        // (channel_id, peer_id, role); both fresh inserts and
        // role-updates carry a fresh stamp because the design treats
        // role-change as a new write.
        let device_id = device_id_unchecked(&conn)?;
        let lamport = crate::porch::sync::clock::next_lamport(&conn)?;
        conn.execute(
            "INSERT INTO channel_acl
                (channel_id, peer_id, role, granted_at,
                 sync_device_id, sync_lamport, sync_tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(channel_id, peer_id) DO UPDATE SET
                 role = excluded.role,
                 granted_at = excluded.granted_at,
                 sync_device_id = excluded.sync_device_id,
                 sync_lamport = excluded.sync_lamport,
                 sync_tombstone = 0",
            params![channel_id, peer_id, role.as_str(), now, device_id, lamport],
        )?;
        Ok(())
    }

    /// Revoke an ACL row. Returns true if a row was removed.
    ///
    /// Phase F — revoke is a TOMBSTONE in the CRDT: the row stays in
    /// the table with `sync_tombstone = 1` so a later sync from a
    /// device that hasn't yet seen the revoke will lose to it under
    /// LWW. The wire path treats tombstoned ACL rows as absent —
    /// `lookup_acl` filters them. This preserves the "delete-wins-on-
    /// later-write" semantics without losing the LWW basis.
    pub fn revoke_acl(&self, channel_id: &str, peer_id: &str) -> Result<bool, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let device_id = device_id_unchecked(&conn)?;
        let lamport = crate::porch::sync::clock::next_lamport(&conn)?;
        let n = conn.execute(
            "UPDATE channel_acl
             SET sync_tombstone = 1,
                 sync_device_id = ?3,
                 sync_lamport = ?4
             WHERE channel_id = ?1 AND peer_id = ?2 AND sync_tombstone = 0",
            params![channel_id, peer_id, device_id, lamport],
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
        let device_id = device_id_unchecked(&conn)?;
        let lamport = crate::porch::sync::clock::next_lamport(&conn)?;
        conn.execute(
            "INSERT INTO porch_channels
                (id, name, kind, acl_mode, created_at,
                 sync_device_id, sync_lamport, sync_tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
             ON CONFLICT(id) DO NOTHING",
            params![
                id,
                name,
                kind.as_str(),
                acl_mode.as_str(),
                now,
                device_id,
                lamport,
            ],
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
        // Phase F — tombstoned ACL rows are treated as absent so a
        // revoke takes effect immediately even though the row still
        // physically exists (the row is kept for CRDT LWW basis).
        let role: Option<String> = conn
            .query_row(
                "SELECT role FROM channel_acl
                 WHERE channel_id = ?1 AND peer_id = ?2 AND sync_tombstone = 0",
                params![channel_id, peer_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(role.and_then(|s| AclRole::from_str(&s)))
    }
}

/// Phase F — read the install's device-id directly from a connection.
/// Used inside write helpers that already hold the porch mutex; calling
/// `Porch::device_id` would deadlock because it re-locks.
pub(super) fn device_id_unchecked(conn: &Connection) -> Result<String, PorchError> {
    let id: Option<String> = conn
        .query_row("SELECT device_id FROM device_identity LIMIT 1", [], |r| {
            r.get(0)
        })
        .ok();
    id.ok_or_else(|| {
        PorchError::InvalidInput(
            "device_identity row missing — Phase F migration did not run".to_string(),
        )
    })
}

/// Phase F — check whether `column` exists on `table` via PRAGMA
/// `table_info` and ADD it idempotently. The columns are nullable
/// (no NOT NULL constraint at the SQL level) because ALTER TABLE …
/// ADD COLUMN against a populated table cannot retroactively enforce
/// NOT NULL — the application-layer write helpers (`clock::next_lamport`
/// + the stamped INSERT/UPDATE helpers) are what guarantee no live row
/// carries `NULL` after the backfill.
fn add_sync_columns_if_missing(
    conn: &Connection,
    table: &str,
) -> Result<(), PorchError> {
    let cols = read_columns(conn, table)?;
    if !cols.iter().any(|c| c == "sync_device_id") {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN sync_device_id TEXT;"
        ))?;
    }
    if !cols.iter().any(|c| c == "sync_lamport") {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN sync_lamport INTEGER NOT NULL DEFAULT 0;"
        ))?;
    }
    if !cols.iter().any(|c| c == "sync_tombstone") {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN sync_tombstone INTEGER NOT NULL DEFAULT 0;"
        ))?;
    }
    Ok(())
}

/// Read the list of column names for a table via `PRAGMA table_info`.
/// Returns an empty vec for a missing table (caller's responsibility to
/// validate beforehand if that's an error).
fn read_columns(conn: &Connection, table: &str) -> Result<Vec<String>, PorchError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
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
    fn home_meta_default_seeded() {
        // F1b-IMPL — schema v8 seeds `server_name` = "home" on first
        // open. A fresh in-memory porch should reflect that default.
        let porch = Porch::open_in_memory().expect("open ok");
        let name = porch.home_server_name().expect("read ok");
        assert_eq!(name, DEFAULT_HOME_SERVER_NAME);
    }

    #[test]
    fn home_meta_rename_round_trip() {
        // F1b-IMPL — writing a new name persists across reads.
        let porch = Porch::open_in_memory().expect("open ok");
        porch.set_home_server_name("studio").expect("set ok");
        assert_eq!(porch.home_server_name().expect("read ok"), "studio");
        // Renaming again replaces (not appends).
        porch.set_home_server_name("workshop").expect("set ok");
        assert_eq!(
            porch.home_server_name().expect("read ok"),
            "workshop"
        );
    }

    #[test]
    fn home_meta_rejects_empty_and_oversize() {
        let porch = Porch::open_in_memory().expect("open ok");
        let err = porch.set_home_server_name("").expect_err("must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
        let err = porch.set_home_server_name("   ").expect_err("must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
        let oversized = "a".repeat(MAX_HOME_SERVER_NAME_CHARS + 1);
        let err = porch
            .set_home_server_name(&oversized)
            .expect_err("must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn home_meta_trims_whitespace_on_write() {
        let porch = Porch::open_in_memory().expect("open ok");
        porch
            .set_home_server_name("  studio  ")
            .expect("set ok");
        assert_eq!(porch.home_server_name().expect("read ok"), "studio");
    }

    #[test]
    fn visibility_seeded_with_porch_and_home_defaults() {
        // F-VIS — schema v9 seeds the two intrinsic servers on first
        // open. A fresh in-memory porch should reflect both defaults.
        let porch = Porch::open_in_memory().expect("open ok");
        let porch_row = porch
            .get_visibility(VISIBILITY_SERVER_ID_PORCH)
            .expect("read ok")
            .expect("seeded row");
        assert_eq!(porch_row.max_hops, DEFAULT_PORCH_MAX_HOPS);
        assert_eq!(porch_row.server_id, "porch");

        let home_row = porch
            .get_visibility(VISIBILITY_SERVER_ID_HOME)
            .expect("read ok")
            .expect("seeded row");
        assert_eq!(home_row.max_hops, DEFAULT_HOME_MAX_HOPS);
        assert_eq!(home_row.server_id, "home");

        // Unknown server id → None, not an error.
        assert!(porch
            .get_visibility("does-not-exist")
            .expect("read ok")
            .is_none());
    }

    #[test]
    fn visibility_set_get_round_trip() {
        let porch = Porch::open_in_memory().expect("open ok");
        let original = porch
            .get_visibility(VISIBILITY_SERVER_ID_HOME)
            .expect("ok")
            .expect("seeded");
        // Tiny sleep so last_changed_at strictly advances.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let updated = porch
            .set_visibility(VISIBILITY_SERVER_ID_HOME, 3)
            .expect("set ok");
        assert_eq!(updated.max_hops, 3);
        assert!(
            updated.last_changed_at > original.last_changed_at,
            "set_visibility must bump last_changed_at: {} > {}",
            updated.last_changed_at,
            original.last_changed_at,
        );
        let read_back = porch
            .get_visibility(VISIBILITY_SERVER_ID_HOME)
            .expect("ok")
            .expect("present");
        assert_eq!(read_back, updated);
    }

    #[test]
    fn visibility_set_accepts_full_u8_range() {
        let porch = Porch::open_in_memory().expect("open ok");
        for hops in [0u8, 1, 5, 64, 255] {
            let row = porch
                .set_visibility(VISIBILITY_SERVER_ID_HOME, hops)
                .expect("set ok");
            assert_eq!(row.max_hops, hops, "round-trip preserves {}", hops);
        }
    }

    #[test]
    fn visibility_set_rejects_empty_server_id() {
        let porch = Porch::open_in_memory().expect("open ok");
        let err = porch.set_visibility("", 1).expect_err("must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
        let err = porch.set_visibility("   ", 1).expect_err("must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn visibility_apply_if_newer_wins_when_strictly_newer() {
        let porch = Porch::open_in_memory().expect("open ok");
        let local = porch
            .get_visibility(VISIBILITY_SERVER_ID_HOME)
            .expect("ok")
            .expect("seeded");
        // Inbound from a neighbour with a strictly-newer ts and a
        // different value.
        let inbound = VisibilityRow {
            server_id: VISIBILITY_SERVER_ID_HOME.to_string(),
            max_hops: 7,
            last_changed_at: local.last_changed_at + 1_000,
        };
        let written = porch
            .apply_visibility_if_newer(&inbound)
            .expect("apply ok");
        assert!(written, "newer inbound update must win");
        let read_back = porch
            .get_visibility(VISIBILITY_SERVER_ID_HOME)
            .expect("ok")
            .expect("present");
        assert_eq!(read_back.max_hops, 7);
        assert_eq!(read_back.last_changed_at, inbound.last_changed_at);
    }

    #[test]
    fn visibility_apply_if_newer_ignores_equal_or_older_ts() {
        let porch = Porch::open_in_memory().expect("open ok");
        let local = porch
            .get_visibility(VISIBILITY_SERVER_ID_HOME)
            .expect("ok")
            .expect("seeded");
        // Equal ts — must be ignored (strictly-greater semantics).
        let equal = VisibilityRow {
            server_id: VISIBILITY_SERVER_ID_HOME.to_string(),
            max_hops: 7,
            last_changed_at: local.last_changed_at,
        };
        let written = porch
            .apply_visibility_if_newer(&equal)
            .expect("apply ok");
        assert!(!written, "equal-ts inbound must be ignored");
        let read_back = porch
            .get_visibility(VISIBILITY_SERVER_ID_HOME)
            .expect("ok")
            .expect("present");
        assert_eq!(read_back.max_hops, DEFAULT_HOME_MAX_HOPS);

        // Older ts — same.
        let older = VisibilityRow {
            server_id: VISIBILITY_SERVER_ID_HOME.to_string(),
            max_hops: 9,
            last_changed_at: local.last_changed_at - 1,
        };
        let written = porch
            .apply_visibility_if_newer(&older)
            .expect("apply ok");
        assert!(!written, "older-ts inbound must be ignored");
    }

    #[test]
    fn visibility_apply_if_newer_inserts_unknown_server() {
        // For a user-created server we've never seen, any inbound is
        // strictly-newer than "no row exists" — insert it.
        let porch = Porch::open_in_memory().expect("open ok");
        let inbound = VisibilityRow {
            server_id: "user-created-uuid".to_string(),
            max_hops: 2,
            last_changed_at: 12345,
        };
        let written = porch
            .apply_visibility_if_newer(&inbound)
            .expect("apply ok");
        assert!(written);
        let read_back = porch
            .get_visibility("user-created-uuid")
            .expect("ok")
            .expect("present");
        assert_eq!(read_back, inbound);
    }

    #[test]
    fn visibility_list_returns_seeded_rows_sorted() {
        let porch = Porch::open_in_memory().expect("open ok");
        let rows = porch.list_visibility().expect("ok");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].server_id, "home");
        assert_eq!(rows[1].server_id, "porch");
    }

    #[test]
    fn schema_migration_v8_to_v9_round_trip_on_persistent_db() {
        // Spec deliverable #9: schema migration v8 → v9 round-trip
        // test. We can't easily synthesize a v8 DB from scratch
        // without re-implementing the old migration here, so the
        // round-trip is "open a fresh DB (which runs v0 → v9), close
        // it, reopen it, observe the same state." That exercises the
        // idempotent re-open path through every prior migration
        // including v8 → v9. A future targeted v8-rollback test
        // would require a frozen v8 schema dump.
        let tmp = tempfile::tempdir().expect("tmp");
        {
            let porch = Porch::open(tmp.path()).expect("open ok");
            // Confirm v9 ran: visibility_meta table exists + seeded.
            let porch_row = porch
                .get_visibility(VISIBILITY_SERVER_ID_PORCH)
                .expect("ok")
                .expect("seeded");
            assert_eq!(porch_row.max_hops, DEFAULT_PORCH_MAX_HOPS);
            // Mutate the home row so we can verify it persists.
            porch
                .set_visibility(VISIBILITY_SERVER_ID_HOME, 4)
                .expect("set ok");
        }
        // Reopen — v9 migration must be a no-op AND the mutated home
        // row must survive.
        {
            let porch = Porch::open(tmp.path()).expect("reopen ok");
            let home_row = porch
                .get_visibility(VISIBILITY_SERVER_ID_HOME)
                .expect("ok")
                .expect("seeded");
            assert_eq!(home_row.max_hops, 4, "value survives reopen");
            // Migration is idempotent — re-running it must not error
            // or wipe the row.
            porch.migrate().expect("re-migrate ok");
            let home_row_after = porch
                .get_visibility(VISIBILITY_SERVER_ID_HOME)
                .expect("ok")
                .expect("seeded");
            assert_eq!(home_row_after.max_hops, 4);
        }
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
