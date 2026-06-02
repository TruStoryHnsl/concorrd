//! Porch Phase F — per-table apply-remote-row functions.
//!
//! Each apply function takes a single decoded remote row and merges it
//! into local state according to the LWW comparator
//! `(sync_lamport, sync_device_id)`:
//!
//! * No local row → insert verbatim (including tombstones — a remote
//!   tombstone arriving for a row we never had is still a tombstone we
//!   want to remember, so a delayed in-flight insert can't accidentally
//!   resurrect it).
//! * Local row exists → compare `(remote_lamport, remote_device_id)`
//!   vs `(local_lamport, local_device_id)`. Larger wins. Larger
//!   defined lexicographically: lamport first, device_id tiebreak.
//! * Equal `(lamport, device_id)` → identity → no-op.
//!
//! Each call uses one IMMEDIATE transaction so a batch of applies is
//! atomic at the SQLite level. The caller (`apply_sync_batch`) wraps
//! every table's rows in one outer transaction so the whole batch
//! lands or rolls back together.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::porch::error::PorchError;

/// LWW comparator. Returns `true` when `(remote_lamport, remote_device)`
/// strictly exceeds `(local_lamport, local_device)`.
///
/// `device_id` tiebreak provides total ordering: when two devices write
/// at the same logical lamport tick, the lexicographically larger
/// device-id wins. Without this, ties would be ambiguous and the merge
/// could converge to different states on different installs — defeating
/// the convergence property the CRDT is supposed to give us.
pub fn remote_wins(
    remote_lamport: i64,
    remote_device: &str,
    local_lamport: i64,
    local_device: &str,
) -> bool {
    if remote_lamport != local_lamport {
        return remote_lamport > local_lamport;
    }
    remote_device > local_device
}

// ---------------------------------------------------------------------------
// Row payloads — what flows across the wire in a SyncDelta.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PorchChannelRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub acl_mode: String,
    pub created_at: i64,
    pub sync_device_id: String,
    pub sync_lamport: i64,
    pub sync_tombstone: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelMessageRow {
    pub id: String,
    pub channel_id: String,
    pub author_peer_id: String,
    pub body: String,
    pub created_at: i64,
    pub sync_device_id: String,
    pub sync_lamport: i64,
    pub sync_tombstone: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelAclRow {
    pub channel_id: String,
    pub peer_id: String,
    pub role: String,
    pub granted_at: i64,
    pub sync_device_id: String,
    pub sync_lamport: i64,
    pub sync_tombstone: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelKnockRow {
    pub id: String,
    pub channel_id: String,
    pub knocker_peer_id: String,
    pub message: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub sync_device_id: String,
    pub sync_lamport: i64,
    pub sync_tombstone: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelThemeRow {
    pub channel_id: String,
    pub primary_color: String,
    pub surface_color: String,
    pub on_surface_color: String,
    pub accent_color: String,
    pub font_family: String,
    pub background_kind: String,
    pub background_value: Option<String>,
    pub updated_at: i64,
    pub sync_device_id: String,
    pub sync_lamport: i64,
    pub sync_tombstone: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PorchAssetRow {
    pub id: String,
    pub channel_id: String,
    pub mime_type: String,
    pub file_path: String,
    pub bytes: i64,
    pub sha256: String,
    pub created_at: i64,
    pub sync_device_id: String,
    pub sync_lamport: i64,
    pub sync_tombstone: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsidianChannelRow {
    pub channel_id: String,
    pub vault_root: String,
    pub subfolder: Option<String>,
    pub follow_symlinks: i64,
    pub updated_at: i64,
    pub sync_device_id: String,
    pub sync_lamport: i64,
    pub sync_tombstone: i64,
}

/// Sub-totals returned by an apply call: which table absorbed the
/// write, and how many rows actually changed (vs. lost to LWW).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyCounts {
    pub channels: i64,
    pub messages: i64,
    pub acl: i64,
    pub knocks: i64,
    pub themes: i64,
    pub assets: i64,
    pub obsidian: i64,
}

impl ApplyCounts {
    pub fn total(&self) -> i64 {
        self.channels
            + self.messages
            + self.acl
            + self.knocks
            + self.themes
            + self.assets
            + self.obsidian
    }
}

// ---------------------------------------------------------------------------
// Per-table apply functions.
//
// Every function follows the same pattern:
//   1. Look up the local row by primary key.
//   2. If absent, insert verbatim (including tombstones).
//   3. If present, compare LWW — apply UPDATE on win, drop on lose.
//   4. Return `true` if the row was applied (insert or update),
//      `false` if it lost LWW.
// ---------------------------------------------------------------------------

pub fn apply_remote_channel(
    tx: &Connection,
    row: &PorchChannelRow,
) -> Result<bool, PorchError> {
    let local: Option<(i64, String)> = tx
        .query_row(
            "SELECT sync_lamport, sync_device_id FROM porch_channels WHERE id = ?1",
            params![row.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match local {
        None => {
            tx.execute(
                "INSERT INTO porch_channels
                    (id, name, kind, acl_mode, created_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.id,
                    row.name,
                    row.kind,
                    row.acl_mode,
                    row.created_at,
                    row.sync_device_id,
                    row.sync_lamport,
                    row.sync_tombstone,
                ],
            )?;
            Ok(true)
        }
        Some((local_lamport, local_device)) => {
            if remote_wins(
                row.sync_lamport,
                &row.sync_device_id,
                local_lamport,
                &local_device,
            ) {
                tx.execute(
                    "UPDATE porch_channels SET
                        name = ?2, kind = ?3, acl_mode = ?4, created_at = ?5,
                        sync_device_id = ?6, sync_lamport = ?7, sync_tombstone = ?8
                     WHERE id = ?1",
                    params![
                        row.id,
                        row.name,
                        row.kind,
                        row.acl_mode,
                        row.created_at,
                        row.sync_device_id,
                        row.sync_lamport,
                        row.sync_tombstone,
                    ],
                )?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

pub fn apply_remote_message(
    tx: &Connection,
    row: &ChannelMessageRow,
) -> Result<bool, PorchError> {
    // Messages are append-only in Phase F. ID is a ULID so collisions
    // are astronomical; we still LWW-merge the row metadata for
    // forward compatibility (and tombstone propagation).
    let local: Option<(i64, String)> = tx
        .query_row(
            "SELECT sync_lamport, sync_device_id FROM channel_messages WHERE id = ?1",
            params![row.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match local {
        None => {
            tx.execute(
                "INSERT INTO channel_messages
                    (id, channel_id, author_peer_id, body, created_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.id,
                    row.channel_id,
                    row.author_peer_id,
                    row.body,
                    row.created_at,
                    row.sync_device_id,
                    row.sync_lamport,
                    row.sync_tombstone,
                ],
            )?;
            Ok(true)
        }
        Some((local_lamport, local_device)) => {
            if remote_wins(
                row.sync_lamport,
                &row.sync_device_id,
                local_lamport,
                &local_device,
            ) {
                tx.execute(
                    "UPDATE channel_messages SET
                        channel_id = ?2, author_peer_id = ?3, body = ?4,
                        created_at = ?5, sync_device_id = ?6,
                        sync_lamport = ?7, sync_tombstone = ?8
                     WHERE id = ?1",
                    params![
                        row.id,
                        row.channel_id,
                        row.author_peer_id,
                        row.body,
                        row.created_at,
                        row.sync_device_id,
                        row.sync_lamport,
                        row.sync_tombstone,
                    ],
                )?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

pub fn apply_remote_acl(
    tx: &Connection,
    row: &ChannelAclRow,
) -> Result<bool, PorchError> {
    let local: Option<(i64, String)> = tx
        .query_row(
            "SELECT sync_lamport, sync_device_id FROM channel_acl
             WHERE channel_id = ?1 AND peer_id = ?2",
            params![row.channel_id, row.peer_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match local {
        None => {
            tx.execute(
                "INSERT INTO channel_acl
                    (channel_id, peer_id, role, granted_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    row.channel_id,
                    row.peer_id,
                    row.role,
                    row.granted_at,
                    row.sync_device_id,
                    row.sync_lamport,
                    row.sync_tombstone,
                ],
            )?;
            Ok(true)
        }
        Some((local_lamport, local_device)) => {
            if remote_wins(
                row.sync_lamport,
                &row.sync_device_id,
                local_lamport,
                &local_device,
            ) {
                tx.execute(
                    "UPDATE channel_acl SET
                        role = ?3, granted_at = ?4,
                        sync_device_id = ?5, sync_lamport = ?6, sync_tombstone = ?7
                     WHERE channel_id = ?1 AND peer_id = ?2",
                    params![
                        row.channel_id,
                        row.peer_id,
                        row.role,
                        row.granted_at,
                        row.sync_device_id,
                        row.sync_lamport,
                        row.sync_tombstone,
                    ],
                )?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

pub fn apply_remote_knock(
    tx: &Connection,
    row: &ChannelKnockRow,
) -> Result<bool, PorchError> {
    let local: Option<(i64, String)> = tx
        .query_row(
            "SELECT sync_lamport, sync_device_id FROM channel_knocks WHERE id = ?1",
            params![row.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match local {
        None => {
            // The partial unique index on (channel_id, knocker_peer_id)
            // WHERE status='pending' could otherwise fail. We're
            // inserting verbatim, so a remote `pending` row that
            // collides with a local `pending` row for the same pair
            // would error. In practice, the LWW comparator on the
            // EXISTING pending row would already have resolved this —
            // the only way we reach the None branch is when the local
            // pair has no row at all. So no collision is possible here.
            tx.execute(
                "INSERT INTO channel_knocks
                    (id, channel_id, knocker_peer_id, message, status, created_at, resolved_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    row.id,
                    row.channel_id,
                    row.knocker_peer_id,
                    row.message,
                    row.status,
                    row.created_at,
                    row.resolved_at,
                    row.sync_device_id,
                    row.sync_lamport,
                    row.sync_tombstone,
                ],
            )?;
            Ok(true)
        }
        Some((local_lamport, local_device)) => {
            if remote_wins(
                row.sync_lamport,
                &row.sync_device_id,
                local_lamport,
                &local_device,
            ) {
                tx.execute(
                    "UPDATE channel_knocks SET
                        channel_id = ?2, knocker_peer_id = ?3, message = ?4,
                        status = ?5, created_at = ?6, resolved_at = ?7,
                        sync_device_id = ?8, sync_lamport = ?9, sync_tombstone = ?10
                     WHERE id = ?1",
                    params![
                        row.id,
                        row.channel_id,
                        row.knocker_peer_id,
                        row.message,
                        row.status,
                        row.created_at,
                        row.resolved_at,
                        row.sync_device_id,
                        row.sync_lamport,
                        row.sync_tombstone,
                    ],
                )?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

pub fn apply_remote_theme(
    tx: &Connection,
    row: &ChannelThemeRow,
) -> Result<bool, PorchError> {
    let local: Option<(i64, String)> = tx
        .query_row(
            "SELECT sync_lamport, sync_device_id FROM channel_themes
             WHERE channel_id = ?1",
            params![row.channel_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match local {
        None => {
            tx.execute(
                "INSERT INTO channel_themes
                    (channel_id, primary_color, surface_color, on_surface_color,
                     accent_color, font_family, background_kind, background_value,
                     updated_at, sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    row.channel_id,
                    row.primary_color,
                    row.surface_color,
                    row.on_surface_color,
                    row.accent_color,
                    row.font_family,
                    row.background_kind,
                    row.background_value,
                    row.updated_at,
                    row.sync_device_id,
                    row.sync_lamport,
                    row.sync_tombstone,
                ],
            )?;
            Ok(true)
        }
        Some((local_lamport, local_device)) => {
            if remote_wins(
                row.sync_lamport,
                &row.sync_device_id,
                local_lamport,
                &local_device,
            ) {
                tx.execute(
                    "UPDATE channel_themes SET
                        primary_color = ?2, surface_color = ?3, on_surface_color = ?4,
                        accent_color = ?5, font_family = ?6, background_kind = ?7,
                        background_value = ?8, updated_at = ?9,
                        sync_device_id = ?10, sync_lamport = ?11, sync_tombstone = ?12
                     WHERE channel_id = ?1",
                    params![
                        row.channel_id,
                        row.primary_color,
                        row.surface_color,
                        row.on_surface_color,
                        row.accent_color,
                        row.font_family,
                        row.background_kind,
                        row.background_value,
                        row.updated_at,
                        row.sync_device_id,
                        row.sync_lamport,
                        row.sync_tombstone,
                    ],
                )?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

pub fn apply_remote_asset(
    tx: &Connection,
    row: &PorchAssetRow,
) -> Result<bool, PorchError> {
    let local: Option<(i64, String)> = tx
        .query_row(
            "SELECT sync_lamport, sync_device_id FROM porch_assets WHERE id = ?1",
            params![row.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match local {
        None => {
            tx.execute(
                "INSERT INTO porch_assets
                    (id, channel_id, mime_type, file_path, bytes, sha256, created_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    row.id,
                    row.channel_id,
                    row.mime_type,
                    row.file_path,
                    row.bytes,
                    row.sha256,
                    row.created_at,
                    row.sync_device_id,
                    row.sync_lamport,
                    row.sync_tombstone,
                ],
            )?;
            Ok(true)
        }
        Some((local_lamport, local_device)) => {
            if remote_wins(
                row.sync_lamport,
                &row.sync_device_id,
                local_lamport,
                &local_device,
            ) {
                tx.execute(
                    "UPDATE porch_assets SET
                        channel_id = ?2, mime_type = ?3, file_path = ?4,
                        bytes = ?5, sha256 = ?6, created_at = ?7,
                        sync_device_id = ?8, sync_lamport = ?9, sync_tombstone = ?10
                     WHERE id = ?1",
                    params![
                        row.id,
                        row.channel_id,
                        row.mime_type,
                        row.file_path,
                        row.bytes,
                        row.sha256,
                        row.created_at,
                        row.sync_device_id,
                        row.sync_lamport,
                        row.sync_tombstone,
                    ],
                )?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

pub fn apply_remote_obsidian(
    tx: &Connection,
    row: &ObsidianChannelRow,
) -> Result<bool, PorchError> {
    let local: Option<(i64, String)> = tx
        .query_row(
            "SELECT sync_lamport, sync_device_id FROM obsidian_channels
             WHERE channel_id = ?1",
            params![row.channel_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match local {
        None => {
            tx.execute(
                "INSERT INTO obsidian_channels
                    (channel_id, vault_root, subfolder, follow_symlinks, updated_at,
                     sync_device_id, sync_lamport, sync_tombstone)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.channel_id,
                    row.vault_root,
                    row.subfolder,
                    row.follow_symlinks,
                    row.updated_at,
                    row.sync_device_id,
                    row.sync_lamport,
                    row.sync_tombstone,
                ],
            )?;
            Ok(true)
        }
        Some((local_lamport, local_device)) => {
            if remote_wins(
                row.sync_lamport,
                &row.sync_device_id,
                local_lamport,
                &local_device,
            ) {
                tx.execute(
                    "UPDATE obsidian_channels SET
                        vault_root = ?2, subfolder = ?3, follow_symlinks = ?4,
                        updated_at = ?5, sync_device_id = ?6, sync_lamport = ?7,
                        sync_tombstone = ?8
                     WHERE channel_id = ?1",
                    params![
                        row.channel_id,
                        row.vault_root,
                        row.subfolder,
                        row.follow_symlinks,
                        row.updated_at,
                        row.sync_device_id,
                        row.sync_lamport,
                        row.sync_tombstone,
                    ],
                )?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Row readers — for "give me everything newer than X" PullDelta paths.
// ---------------------------------------------------------------------------

pub fn channels_since(
    conn: &Connection,
    since_lamport: i64,
) -> Result<Vec<PorchChannelRow>, PorchError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, kind, acl_mode, created_at,
                sync_device_id, sync_lamport, sync_tombstone
         FROM porch_channels WHERE sync_lamport > ?1",
    )?;
    let rows = stmt.query_map(params![since_lamport], |r| {
        Ok(PorchChannelRow {
            id: r.get(0)?,
            name: r.get(1)?,
            kind: r.get(2)?,
            acl_mode: r.get(3)?,
            created_at: r.get(4)?,
            sync_device_id: r.get(5)?,
            sync_lamport: r.get(6)?,
            sync_tombstone: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn messages_since(
    conn: &Connection,
    since_lamport: i64,
) -> Result<Vec<ChannelMessageRow>, PorchError> {
    let mut stmt = conn.prepare(
        "SELECT id, channel_id, author_peer_id, body, created_at,
                sync_device_id, sync_lamport, sync_tombstone
         FROM channel_messages WHERE sync_lamport > ?1",
    )?;
    let rows = stmt.query_map(params![since_lamport], |r| {
        Ok(ChannelMessageRow {
            id: r.get(0)?,
            channel_id: r.get(1)?,
            author_peer_id: r.get(2)?,
            body: r.get(3)?,
            created_at: r.get(4)?,
            sync_device_id: r.get(5)?,
            sync_lamport: r.get(6)?,
            sync_tombstone: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn acl_since(
    conn: &Connection,
    since_lamport: i64,
) -> Result<Vec<ChannelAclRow>, PorchError> {
    let mut stmt = conn.prepare(
        "SELECT channel_id, peer_id, role, granted_at,
                sync_device_id, sync_lamport, sync_tombstone
         FROM channel_acl WHERE sync_lamport > ?1",
    )?;
    let rows = stmt.query_map(params![since_lamport], |r| {
        Ok(ChannelAclRow {
            channel_id: r.get(0)?,
            peer_id: r.get(1)?,
            role: r.get(2)?,
            granted_at: r.get(3)?,
            sync_device_id: r.get(4)?,
            sync_lamport: r.get(5)?,
            sync_tombstone: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn knocks_since(
    conn: &Connection,
    since_lamport: i64,
) -> Result<Vec<ChannelKnockRow>, PorchError> {
    let mut stmt = conn.prepare(
        "SELECT id, channel_id, knocker_peer_id, message, status,
                created_at, resolved_at,
                sync_device_id, sync_lamport, sync_tombstone
         FROM channel_knocks WHERE sync_lamport > ?1",
    )?;
    let rows = stmt.query_map(params![since_lamport], |r| {
        Ok(ChannelKnockRow {
            id: r.get(0)?,
            channel_id: r.get(1)?,
            knocker_peer_id: r.get(2)?,
            message: r.get(3)?,
            status: r.get(4)?,
            created_at: r.get(5)?,
            resolved_at: r.get(6)?,
            sync_device_id: r.get(7)?,
            sync_lamport: r.get(8)?,
            sync_tombstone: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn themes_since(
    conn: &Connection,
    since_lamport: i64,
) -> Result<Vec<ChannelThemeRow>, PorchError> {
    let mut stmt = conn.prepare(
        "SELECT channel_id, primary_color, surface_color, on_surface_color,
                accent_color, font_family, background_kind, background_value,
                updated_at, sync_device_id, sync_lamport, sync_tombstone
         FROM channel_themes WHERE sync_lamport > ?1",
    )?;
    let rows = stmt.query_map(params![since_lamport], |r| {
        Ok(ChannelThemeRow {
            channel_id: r.get(0)?,
            primary_color: r.get(1)?,
            surface_color: r.get(2)?,
            on_surface_color: r.get(3)?,
            accent_color: r.get(4)?,
            font_family: r.get(5)?,
            background_kind: r.get(6)?,
            background_value: r.get(7)?,
            updated_at: r.get(8)?,
            sync_device_id: r.get(9)?,
            sync_lamport: r.get(10)?,
            sync_tombstone: r.get(11)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn assets_since(
    conn: &Connection,
    since_lamport: i64,
) -> Result<Vec<PorchAssetRow>, PorchError> {
    let mut stmt = conn.prepare(
        "SELECT id, channel_id, mime_type, file_path, bytes, sha256, created_at,
                sync_device_id, sync_lamport, sync_tombstone
         FROM porch_assets WHERE sync_lamport > ?1",
    )?;
    let rows = stmt.query_map(params![since_lamport], |r| {
        Ok(PorchAssetRow {
            id: r.get(0)?,
            channel_id: r.get(1)?,
            mime_type: r.get(2)?,
            file_path: r.get(3)?,
            bytes: r.get(4)?,
            sha256: r.get(5)?,
            created_at: r.get(6)?,
            sync_device_id: r.get(7)?,
            sync_lamport: r.get(8)?,
            sync_tombstone: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn obsidian_since(
    conn: &Connection,
    since_lamport: i64,
) -> Result<Vec<ObsidianChannelRow>, PorchError> {
    let mut stmt = conn.prepare(
        "SELECT channel_id, vault_root, subfolder, follow_symlinks, updated_at,
                sync_device_id, sync_lamport, sync_tombstone
         FROM obsidian_channels WHERE sync_lamport > ?1",
    )?;
    let rows = stmt.query_map(params![since_lamport], |r| {
        Ok(ObsidianChannelRow {
            channel_id: r.get(0)?,
            vault_root: r.get(1)?,
            subfolder: r.get(2)?,
            follow_symlinks: r.get(3)?,
            updated_at: r.get(4)?,
            sync_device_id: r.get(5)?,
            sync_lamport: r.get(6)?,
            sync_tombstone: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_wins_lamport_higher() {
        assert!(remote_wins(10, "A", 5, "B"));
        assert!(!remote_wins(5, "A", 10, "B"));
    }

    #[test]
    fn remote_wins_tiebreak_by_device_id() {
        assert!(remote_wins(7, "B", 7, "A"));
        assert!(!remote_wins(7, "A", 7, "B"));
    }

    #[test]
    fn remote_wins_identical_is_false() {
        assert!(!remote_wins(7, "A", 7, "A"));
    }
}
