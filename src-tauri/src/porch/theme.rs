//! Porch Phase C — per-channel aesthetic customization.
//!
//! Themes belong to channels, not to the porch as a whole. The owner
//! picks a theme for each channel; the visitor sees the owner's theme
//! when they enter. The porch (default channel) has its own theme;
//! inner rooms can be wildly different — a DND campaign room might be
//! sepia + serif + parchment-image; the porch might be neon-on-black.
//!
//! Data model:
//!
//! * [`ChannelTheme`] — one per channel. Four color anchors
//!   (`primary`, `surface`, `on_surface`, `accent`), a [`FontFamily`]
//!   discriminator, and a [`Background`] descriptor (none / solid /
//!   gradient / image-id).
//! * [`PorchAsset`] — uploaded image blob metadata. The bytes live on
//!   disk under `<data_dir>/porch_assets/<id>.<ext>`; the DB only
//!   carries the metadata + SHA-256 so themes can reference an asset
//!   by id without round-tripping the bytes through the wire envelope.
//!
//! Validation rules (enforced before hitting SQLite, so the error
//! surfacing is user-friendly rather than a CHECK-constraint failure):
//!
//! * Hex colors must match `#RRGGBB` (7 chars, leading `#`,
//!   `[0-9a-fA-F]` × 6).
//! * `Background::Image { asset_id }` must reference an existing
//!   `porch_assets` row whose `channel_id` matches the theme's
//!   `channel_id` (no cross-channel image reuse — keeps the visitor
//!   ACL check tight: "you can see this asset iff you can visit this
//!   channel").
//! * Asset uploads: MIME whitelisted to `image/png` / `image/jpeg` /
//!   `image/webp` / `image/gif`; size capped at
//!   [`MAX_ASSET_UPLOAD_BYTES`] (5 MiB) at the storage layer. The
//!   on-the-wire inline cap is tighter — see
//!   [`MAX_INLINE_ASSET_BYTES`].

use std::io::Write;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use super::db::{unix_millis, Porch};
use super::error::PorchError;

/// Max raw bytes accepted by [`Porch::upload_asset`]. Anything larger
/// is rejected with `PorchError::InvalidInput` — themes should reuse
/// existing assets rather than ship megabytes of background art per
/// channel.
pub const MAX_ASSET_UPLOAD_BYTES: usize = 5 * 1024 * 1024;

/// Max bytes a single inline `GetAssetBytes` response can carry. Larger
/// assets are explicitly refused over the libp2p protocol so the 1 MiB
/// envelope cap on `/concord/porch/1.0.0` stays comfortable; a future
/// `/concord/porch-asset/1.0.0` streaming protocol will lift this.
pub const MAX_INLINE_ASSET_BYTES: usize = 256 * 1024;

/// Font family the theme renderer maps to a concrete CSS `font-family`
/// stack. The enum stays small + closed so a visitor can't smuggle an
/// arbitrary font directive through the wire (which would otherwise be
/// a fingerprinting + CSS-injection vector).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FontFamily {
    System,
    Serif,
    Mono,
    Display,
}

impl FontFamily {
    pub fn as_str(&self) -> &'static str {
        match self {
            FontFamily::System => "system",
            FontFamily::Serif => "serif",
            FontFamily::Mono => "mono",
            FontFamily::Display => "display",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "system" => Some(FontFamily::System),
            "serif" => Some(FontFamily::Serif),
            "mono" => Some(FontFamily::Mono),
            "display" => Some(FontFamily::Display),
            _ => None,
        }
    }
}

/// Background descriptor on a [`ChannelTheme`].
///
/// Serialized with `#[serde(tag = "kind", content = "value")]` so the
/// wire JSON is:
///
/// ```json
/// {"kind":"none","value":null}
/// {"kind":"solid","value":"#101010"}
/// {"kind":"gradient","value":"linear-gradient(180deg,#101010,#202020)"}
/// {"kind":"image","value":{"asset_id":"01JABCDEF..."}}
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Background {
    None,
    Solid(String),
    Gradient(String),
    Image { asset_id: String },
}

impl Background {
    pub(super) fn kind_str(&self) -> &'static str {
        match self {
            Background::None => "none",
            Background::Solid(_) => "solid",
            Background::Gradient(_) => "gradient",
            Background::Image { .. } => "image",
        }
    }

    /// The string stored in `channel_themes.background_value`. `None`
    /// for `Background::None`.
    pub(super) fn value_str(&self) -> Option<String> {
        match self {
            Background::None => None,
            Background::Solid(s) | Background::Gradient(s) => Some(s.clone()),
            Background::Image { asset_id } => Some(asset_id.clone()),
        }
    }

    pub(super) fn from_db(kind: &str, value: Option<String>) -> Option<Self> {
        match (kind, value) {
            ("none", _) => Some(Background::None),
            ("solid", Some(v)) => Some(Background::Solid(v)),
            ("gradient", Some(v)) => Some(Background::Gradient(v)),
            ("image", Some(v)) => Some(Background::Image { asset_id: v }),
            _ => None,
        }
    }
}

/// Theme metadata for a channel. The on-wire `kind` discriminator on
/// [`Background`] keeps the JSON shape additive — Phase D can add a new
/// variant (e.g. video, gradient mesh) without breaking older clients
/// (they get `Background::None` from the forward-compat fallback).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelTheme {
    pub channel_id: String,
    pub primary_color: String,
    pub surface_color: String,
    pub on_surface_color: String,
    pub accent_color: String,
    pub font_family: FontFamily,
    pub background: Background,
    pub updated_at: i64,
}

impl ChannelTheme {
    /// Sensible neutral default for any channel that doesn't yet have a
    /// row in `channel_themes`. The colors pick a dark base that
    /// passes WCAG AA against the chosen `on_surface_color`.
    pub fn default_for(channel_id: &str) -> Self {
        ChannelTheme {
            channel_id: channel_id.to_string(),
            primary_color: "#4f9eff".to_string(),
            surface_color: "#18191c".to_string(),
            on_surface_color: "#e3e4e6".to_string(),
            accent_color: "#7c4dff".to_string(),
            font_family: FontFamily::System,
            background: Background::None,
            // 0 is the "never set" sentinel; serialized just like a
            // real timestamp, but the renderer can ignore it.
            updated_at: 0,
        }
    }
}

/// Per-channel theme summary surfaced inside `ListChannels` rows so
/// the visitor's channel list rail can show small color swatches
/// without a per-row GetTheme round-trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeSummary {
    pub primary_color: String,
    pub accent_color: String,
}

/// Public porch-asset record. The bytes are NOT included — the wire
/// path is `Porch::get_asset_bytes` (with the 256 KiB cap) or, in a
/// future phase, a chunked streaming protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PorchAsset {
    pub id: String,
    pub channel_id: String,
    pub mime_type: String,
    /// Path relative to `<data_dir>/porch_assets/`. e.g.
    /// `01JABCDEFG.png`. The Rust layer never returns the full
    /// absolute path through the wire — file paths are an
    /// implementation detail.
    pub file_path: String,
    pub bytes: u64,
    pub sha256: String,
    pub created_at: i64,
}

impl Porch {
    /// Fetch the theme stored for `channel_id`. Returns `None` if no
    /// row exists — callers usually want
    /// [`ChannelTheme::default_for`] in that case. The wire handler in
    /// `protocol.rs` performs that substitution so the visitor never
    /// sees a `null` response.
    pub fn get_theme(&self, channel_id: &str) -> Result<Option<ChannelTheme>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row = conn
            .query_row(
                "SELECT channel_id, primary_color, surface_color, on_surface_color,
                        accent_color, font_family, background_kind, background_value,
                        updated_at
                 FROM channel_themes WHERE channel_id = ?1",
                params![channel_id],
                |r| {
                    let font_str: String = r.get(5)?;
                    let bg_kind: String = r.get(6)?;
                    let bg_value: Option<String> = r.get(7)?;
                    Ok(ChannelTheme {
                        channel_id: r.get(0)?,
                        primary_color: r.get(1)?,
                        surface_color: r.get(2)?,
                        on_surface_color: r.get(3)?,
                        accent_color: r.get(4)?,
                        font_family: FontFamily::from_str(&font_str)
                            .unwrap_or(FontFamily::System),
                        background: Background::from_db(&bg_kind, bg_value)
                            .unwrap_or(Background::None),
                        updated_at: r.get(8)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Insert (or replace) the theme row for the given channel. The
    /// returned [`ChannelTheme`] is the persisted form (with
    /// `updated_at` stamped server-side).
    pub fn set_theme(&self, theme: ChannelTheme) -> Result<ChannelTheme, PorchError> {
        // Channel must exist — gives a 404 instead of a generic FK
        // violation if the caller passed a bogus channel id.
        if self.get_channel(&theme.channel_id)?.is_none() {
            return Err(PorchError::ChannelNotFound {
                channel_id: theme.channel_id.clone(),
            });
        }
        validate_hex(&theme.primary_color, "primary_color")?;
        validate_hex(&theme.surface_color, "surface_color")?;
        validate_hex(&theme.on_surface_color, "on_surface_color")?;
        validate_hex(&theme.accent_color, "accent_color")?;
        validate_background(&theme)?;

        // Validate Image background asset belongs to this channel
        // BEFORE we open a write txn, so the error surface is user
        // friendly rather than an FK trigger.
        if let Background::Image { asset_id } = &theme.background {
            match self.get_asset(asset_id)? {
                Some(a) if a.channel_id == theme.channel_id => {}
                Some(_) => {
                    return Err(PorchError::InvalidInput(format!(
                        "asset {asset_id} belongs to a different channel"
                    )));
                }
                None => {
                    return Err(PorchError::InvalidInput(format!(
                        "asset {asset_id} does not exist"
                    )));
                }
            }
        }

        let now = unix_millis();
        let bg_kind = theme.background.kind_str();
        let bg_value = theme.background.value_str();
        let font_str = theme.font_family.as_str();

        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO channel_themes
                (channel_id, primary_color, surface_color, on_surface_color,
                 accent_color, font_family, background_kind, background_value,
                 updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(channel_id) DO UPDATE SET
                 primary_color = excluded.primary_color,
                 surface_color = excluded.surface_color,
                 on_surface_color = excluded.on_surface_color,
                 accent_color = excluded.accent_color,
                 font_family = excluded.font_family,
                 background_kind = excluded.background_kind,
                 background_value = excluded.background_value,
                 updated_at = excluded.updated_at",
            params![
                theme.channel_id,
                theme.primary_color,
                theme.surface_color,
                theme.on_surface_color,
                theme.accent_color,
                font_str,
                bg_kind,
                bg_value,
                now,
            ],
        )?;
        Ok(ChannelTheme {
            updated_at: now,
            ..theme
        })
    }

    /// Compact summary for use inside `ListChannels` rows. Reads the
    /// row if it exists; otherwise returns `None` (the wire layer
    /// substitutes the default-theme summary).
    pub fn get_theme_summary(
        &self,
        channel_id: &str,
    ) -> Result<Option<ThemeSummary>, PorchError> {
        Ok(self.get_theme(channel_id)?.map(|t| ThemeSummary {
            primary_color: t.primary_color,
            accent_color: t.accent_color,
        }))
    }

    /// Upload an image asset for `channel_id`. The bytes are written
    /// to `<assets_root>/<asset_id>.<ext>` and a row is inserted into
    /// `porch_assets`. Returns the persisted metadata.
    ///
    /// Validation:
    /// * `mime_type` must be one of [`is_allowed_image_mime`].
    /// * Byte length must be > 0 and <= [`MAX_ASSET_UPLOAD_BYTES`].
    /// * Channel must exist.
    /// * Porch must have a filesystem root (in-memory porches reject).
    pub fn upload_asset(
        &self,
        channel_id: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> Result<PorchAsset, PorchError> {
        if bytes.is_empty() {
            return Err(PorchError::InvalidInput(
                "asset upload: bytes must not be empty".to_string(),
            ));
        }
        if bytes.len() > MAX_ASSET_UPLOAD_BYTES {
            return Err(PorchError::InvalidInput(format!(
                "asset upload: {} > {}",
                bytes.len(),
                MAX_ASSET_UPLOAD_BYTES
            )));
        }
        let ext = ext_for_mime(mime_type).ok_or_else(|| {
            PorchError::InvalidInput(format!(
                "asset upload: mime {mime_type} not allowed (png, jpeg, webp, gif only)"
            ))
        })?;
        if self.get_channel(channel_id)?.is_none() {
            return Err(PorchError::ChannelNotFound {
                channel_id: channel_id.to_string(),
            });
        }
        let root = self.assets_root.as_ref().ok_or_else(|| {
            PorchError::InvalidInput(
                "asset upload: in-memory porch has no filesystem asset root".to_string(),
            )
        })?;
        // Defensive: the dir was created on open, but it may have
        // been removed externally. Recreate idempotently so the
        // following write doesn't fail with a confusing ENOENT.
        std::fs::create_dir_all(root).map_err(PorchError::Io)?;

        let id = Ulid::new().to_string();
        let file_name = format!("{id}.{ext}");
        let file_path = root.join(&file_name);
        // Write atomically: tmp file + rename so a crashed write
        // doesn't leave a half-written file the DB row points at.
        let tmp = root.join(format!("{file_name}.tmp"));
        {
            let mut f = std::fs::File::create(&tmp).map_err(PorchError::Io)?;
            f.write_all(bytes).map_err(PorchError::Io)?;
            f.sync_all().map_err(PorchError::Io)?;
        }
        std::fs::rename(&tmp, &file_path).map_err(PorchError::Io)?;

        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let sha = hex::encode(hasher.finalize());

        let now = unix_millis();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO porch_assets
                (id, channel_id, mime_type, file_path, bytes, sha256, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                channel_id,
                mime_type,
                file_name,
                bytes.len() as i64,
                sha,
                now,
            ],
        )?;
        Ok(PorchAsset {
            id,
            channel_id: channel_id.to_string(),
            mime_type: mime_type.to_string(),
            file_path: file_name,
            bytes: bytes.len() as u64,
            sha256: sha,
            created_at: now,
        })
    }

    /// List all assets uploaded for a channel.
    pub fn list_assets(&self, channel_id: &str) -> Result<Vec<PorchAsset>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, mime_type, file_path, bytes, sha256, created_at
             FROM porch_assets WHERE channel_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![channel_id], row_to_asset)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Look up an asset by id.
    pub fn get_asset(&self, asset_id: &str) -> Result<Option<PorchAsset>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row = conn
            .query_row(
                "SELECT id, channel_id, mime_type, file_path, bytes, sha256, created_at
                 FROM porch_assets WHERE id = ?1",
                params![asset_id],
                row_to_asset,
            )
            .optional()?;
        Ok(row)
    }

    /// Read the raw bytes of an asset off disk. Returns
    /// `PorchError::InvalidInput` if the asset row exists but the
    /// porch is in-memory (no filesystem root), or
    /// `PorchError::ChannelNotFound` if no row exists.
    ///
    /// The size is NOT bounded here — the wire layer enforces the
    /// [`MAX_INLINE_ASSET_BYTES`] cap before serializing the response,
    /// because the local owner needs to be able to read their own
    /// full-resolution assets through the Tauri command.
    pub fn read_asset_bytes(&self, asset_id: &str) -> Result<(PorchAsset, Vec<u8>), PorchError> {
        let asset = self.get_asset(asset_id)?.ok_or_else(|| {
            // Reuse ChannelNotFound for "asset doesn't exist" — saves a
            // new error variant and the wire layer doesn't distinguish
            // between channel and asset 404s.
            PorchError::ChannelNotFound {
                channel_id: asset_id.to_string(),
            }
        })?;
        let root = self.assets_root.as_ref().ok_or_else(|| {
            PorchError::InvalidInput(
                "asset bytes: in-memory porch has no filesystem asset root".to_string(),
            )
        })?;
        let path = root.join(&asset.file_path);
        let bytes = std::fs::read(&path).map_err(PorchError::Io)?;
        Ok((asset, bytes))
    }
}

/// MIME → file extension mapping, also acts as the allow-list.
pub fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// `true` if `mime` is in the Phase C image allow-list.
pub fn is_allowed_image_mime(mime: &str) -> bool {
    ext_for_mime(mime).is_some()
}

fn validate_hex(value: &str, field: &str) -> Result<(), PorchError> {
    if value.len() != 7 || !value.starts_with('#') {
        return Err(PorchError::InvalidInput(format!(
            "{field} must be #RRGGBB (got {value:?})"
        )));
    }
    if !value[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(PorchError::InvalidInput(format!(
            "{field} must be hex (got {value:?})"
        )));
    }
    Ok(())
}

fn validate_background(theme: &ChannelTheme) -> Result<(), PorchError> {
    match &theme.background {
        Background::None => Ok(()),
        Background::Solid(hex) => validate_hex(hex, "background.solid"),
        Background::Gradient(s) => {
            if s.is_empty() {
                return Err(PorchError::InvalidInput(
                    "background.gradient must not be empty".to_string(),
                ));
            }
            // Length cap so a hostile owner can't ship a megabyte
            // gradient through the wire.
            if s.len() > 2048 {
                return Err(PorchError::InvalidInput(format!(
                    "background.gradient too long: {} > 2048",
                    s.len()
                )));
            }
            Ok(())
        }
        Background::Image { asset_id } => {
            if asset_id.is_empty() {
                return Err(PorchError::InvalidInput(
                    "background.image.asset_id must not be empty".to_string(),
                ));
            }
            Ok(())
        }
    }
}

fn row_to_asset(r: &rusqlite::Row<'_>) -> rusqlite::Result<PorchAsset> {
    Ok(PorchAsset {
        id: r.get(0)?,
        channel_id: r.get(1)?,
        mime_type: r.get(2)?,
        file_path: r.get(3)?,
        bytes: r.get::<_, i64>(4)? as u64,
        sha256: r.get(5)?,
        created_at: r.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::channel::{AclMode, ChannelKind};
    use crate::porch::DEFAULT_PORCH_CHANNEL_ID;

    #[test]
    fn get_theme_returns_none_when_unset() {
        let porch = Porch::open_in_memory().expect("open ok");
        let theme = porch.get_theme(DEFAULT_PORCH_CHANNEL_ID).expect("get ok");
        assert!(theme.is_none(), "fresh porch must have no theme row");
    }

    #[test]
    fn set_then_get_round_trips_theme() {
        let porch = Porch::open_in_memory().expect("open ok");
        let saved = porch
            .set_theme(ChannelTheme {
                channel_id: DEFAULT_PORCH_CHANNEL_ID.to_string(),
                primary_color: "#ff00aa".to_string(),
                surface_color: "#101010".to_string(),
                on_surface_color: "#ffffff".to_string(),
                accent_color: "#00ffcc".to_string(),
                font_family: FontFamily::Serif,
                background: Background::Solid("#222222".to_string()),
                updated_at: 0,
            })
            .expect("set ok");
        assert!(saved.updated_at > 0, "updated_at must be stamped");
        let fetched = porch
            .get_theme(DEFAULT_PORCH_CHANNEL_ID)
            .expect("get ok")
            .expect("must exist");
        assert_eq!(fetched.primary_color, "#ff00aa");
        assert_eq!(fetched.font_family, FontFamily::Serif);
        assert!(matches!(fetched.background, Background::Solid(ref s) if s == "#222222"));
    }

    #[test]
    fn set_theme_rejects_bad_hex() {
        let porch = Porch::open_in_memory().expect("open ok");
        let mut theme = ChannelTheme::default_for(DEFAULT_PORCH_CHANNEL_ID);
        theme.primary_color = "not-hex".to_string();
        let err = porch.set_theme(theme).expect_err("must reject");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn set_theme_rejects_missing_channel() {
        let porch = Porch::open_in_memory().expect("open ok");
        let theme = ChannelTheme::default_for("does-not-exist");
        let err = porch.set_theme(theme).expect_err("must reject");
        assert!(matches!(err, PorchError::ChannelNotFound { .. }));
    }

    #[test]
    fn upload_asset_in_memory_porch_errors() {
        // In-memory porch has no filesystem root — uploads must reject
        // with InvalidInput rather than panic or write to cwd.
        let porch = Porch::open_in_memory().expect("open ok");
        let err = porch
            .upload_asset(DEFAULT_PORCH_CHANNEL_ID, "image/png", b"\x89PNG\r\n")
            .expect_err("must reject");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn upload_asset_rejects_bad_mime() {
        let porch = Porch::open_in_memory().expect("open ok");
        let err = porch
            .upload_asset(DEFAULT_PORCH_CHANNEL_ID, "text/html", b"<html></html>")
            .expect_err("must reject");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn upload_asset_rejects_oversize() {
        let porch = Porch::open_in_memory().expect("open ok");
        let big = vec![0u8; MAX_ASSET_UPLOAD_BYTES + 1];
        let err = porch
            .upload_asset(DEFAULT_PORCH_CHANNEL_ID, "image/png", &big)
            .expect_err("must reject");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn theme_with_image_background_requires_existing_asset() {
        let porch = Porch::open_in_memory().expect("open ok");
        porch
            .insert_channel("inner-x", "Inner", ChannelKind::Inner, AclMode::Allowlist)
            .expect("insert ok");
        let mut theme = ChannelTheme::default_for("inner-x");
        theme.background = Background::Image {
            asset_id: "does-not-exist".to_string(),
        };
        let err = porch.set_theme(theme).expect_err("must reject");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }
}
