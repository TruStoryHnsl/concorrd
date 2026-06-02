//! Porch Phase F — multi-device sync.
//!
//! Two installs the same user has marked as personal devices keep
//! their porch state convergent via a hand-rolled per-table CRDT.
//! Every CRDT-tracked row carries `(sync_device_id, sync_lamport,
//! sync_tombstone)` and the merge layer picks LWW with
//! `(lamport, device_id)` as the total ordering.
//!
//! Submodules:
//!
//! * [`clock`] — Lamport clock helpers + the `next_lamport` advancer
//!   that every local write threads through.
//! * [`device`] — `device_identity` + `device_links` CRUD. The
//!   bilateral link is the trust boundary: sync requests from a peer
//!   not in `device_links` are refused at the protocol handler.
//! * [`merge`] — per-table `apply_remote_*` functions implementing the
//!   LWW comparator + table-shape-aware INSERT/UPDATE.
//! * [`protocol`] — `/concord/porch-sync/1.0.0` handler + outbound
//!   helpers. Defines `SyncRequest::{LinkRequest, PullDelta, PushDelta}`
//!   on the wire.
//! * [`link`] — high-level "click Add personal device" helper that
//!   wraps the outbound side of the bilateral handshake.

pub mod clock;
pub mod device;
pub mod link;
pub mod merge;
pub mod protocol;

pub use device::{DeviceLink, ROLE_PERSONAL_DEVICE};
pub use merge::{
    apply_remote_acl, apply_remote_asset, apply_remote_channel, apply_remote_knock,
    apply_remote_message, apply_remote_obsidian, apply_remote_theme, remote_wins,
    ApplyCounts, ChannelAclRow, ChannelKnockRow, ChannelMessageRow, ChannelThemeRow,
    ObsidianChannelRow, PorchAssetRow, PorchChannelRow,
};
pub use protocol::{
    apply_sync_batch, local_cursor, sync_now, visit_link_request, visit_pull_delta,
    visit_push_delta, LinkResponse, PushResult, SyncCursor, SyncDelta, SyncErrorBody,
    SyncHandler, SyncReport, SyncRequest, SyncResponse, MAX_SYNC_ENVELOPE_BYTES,
    SYNC_PROTOCOL_ID,
};
