//! Porch — Phase A — per-install local server backed by SQLite, surfaced
//! to paired peers over the `/concord/porch/1.0.0` libp2p protocol.
//!
//! The porch is intentionally smaller than a traditional server: every
//! install runs one, the owner is always the local peer-id, and the
//! default `Porch` channel is the user's "front door" — paired peers can
//! visit without explicit approval. Inner channels (Phase B) are gated by
//! ACL. Per-channel theming, Obsidian channels, encrypted backups,
//! multi-device sync, and WireGuard hardening are documented in
//! `docs/architecture/porch-design.md` as Phases C/D/E/F/G and are out of
//! scope for this PR.
//!
//! The module layout:
//!
//! - [`db`]: `Porch` struct wrapping the `rusqlite::Connection`,
//!   migrations, and CRUD helpers.
//! - [`channel`]: `PorchChannel` / `ChannelKind` / `AclMode` /
//!   `ChannelMessage` data types — serializable on the IPC and libp2p
//!   wire.
//! - [`acl`]: ACL helpers (`can_visit` / `grant` / `revoke`). Phase A
//!   only ships the open default porch; the allowlist machinery is here
//!   so Phase B can land without a schema migration.
//! - [`protocol`]: `FederationHandler` implementation for
//!   `/concord/porch/1.0.0`, plus the outbound `visit_*` helpers used by
//!   the Tauri commands.
//! - [`error`]: `PorchError` — the single failure type the public
//!   surface returns. SQLite, JSON, IO, and ACL-denied errors all funnel
//!   through here.

pub mod acl;
pub mod backup;
pub mod backup_protocol;
pub mod channel;
pub mod db;
pub mod error;
pub mod knock;
pub mod obsidian;
pub mod protocol;
pub mod sync;
pub mod theme;
pub mod users;

pub use backup::{
    list_received_backups, read_received_backup, read_received_backup_info, restore_from_blob,
    store_received_backup, targets as backup_targets, BackupTarget, EncryptedBackup,
    ReceivedBackupSummary, SeedAccess, StrongholdSeedAccess, HKDF_INFO_V1,
};
pub use backup_protocol::{
    visit_backup_get_my_backup, visit_backup_get_my_backup_info, visit_backup_upload,
    BackupErrorBody, BackupHandler, BackupRequest, BackupResponse, BACKUP_PROTOCOL_ID,
};
pub use channel::{AclMode, AclRole, ChannelKind, ChannelMessage, PorchChannel};
pub use db::{Porch, SCHEMA_VERSION};
pub use error::PorchError;
pub use knock::{Knock, KnockStatus};
pub use obsidian::{
    EntryKind, ObsidianChannelConfig, VaultEntry, MAX_VAULT_FILE_BYTES,
};
pub use protocol::{
    visit_get_asset_bytes, visit_get_messages, visit_get_theme, visit_knock, visit_knock_status,
    visit_list_channels, visit_list_vault, visit_post_message, visit_read_vault_file,
    visit_withdraw_knock, ChannelVisibility, PorchErrorBody, PorchHandler, PorchListChannelRow,
    PorchRequest, PorchResponse, VaultFileResponse, PORCH_PROTOCOL_ID,
};
pub use sync::{
    apply_sync_batch, local_cursor, sync_now, visit_link_request, visit_pull_delta,
    visit_push_delta, DeviceLink, LinkResponse, PushResult, SyncCursor, SyncDelta,
    SyncHandler, SyncReport, SyncRequest, SyncResponse, SYNC_PROTOCOL_ID,
};
pub use theme::{
    Background, ChannelTheme, FontFamily, PorchAsset, ThemeSummary, MAX_ASSET_UPLOAD_BYTES,
    MAX_INLINE_ASSET_BYTES,
};
pub use users::{
    KeychainEntry, PlaintextCredentials, Provenance, SourceKind, UserProfile,
    KEYCHAIN_HKDF_INFO_V1,
};

/// The id of the default porch channel created on first boot. Stable
/// across installs so Phase B's UI can reason about it ("you can't
/// delete the front door").
pub const DEFAULT_PORCH_CHANNEL_ID: &str = "porch-default";
