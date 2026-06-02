//! Porch Phase D — Obsidian vault accessor.
//!
//! A channel of `kind = 'obsidian'` is bound to a directory on the
//! owner's disk (an Obsidian vault, or any folder full of markdown +
//! images). Paired peers with channel access can browse the directory
//! tree and read individual files over the existing
//! `/concord/porch/1.0.0` protocol — additive `ListVault` and
//! `GetVaultFile` request variants.
//!
//! ## Security model
//!
//! This module is the load-bearing security boundary that prevents a
//! malicious or compromised visitor from coercing the host into serving
//! arbitrary files (e.g. `/etc/passwd`). Three independent defences,
//! every one of which must hold:
//!
//! 1. **Canonicalization at config time.** [`Porch::set_obsidian_config`]
//!    calls [`std::fs::canonicalize`] on `vault_root` and stores the
//!    canonical (`..`-resolved, symlink-resolved) absolute form. The
//!    `subfolder` argument, if present, is canonicalized against the
//!    canonical root and rejected if it escapes.
//! 2. **Prefix check on every access.** [`Porch::list_vault`] and
//!    [`Porch::read_vault_file`] canonicalize the resolved absolute path
//!    AND assert it starts with the stored canonical effective root.
//!    Any traversal attempt (`../`, absolute-path injection, symlink to
//!    outside the vault when `follow_symlinks = false`) is rejected
//!    with [`PorchError::InvalidInput`].
//! 3. **MIME allow-list on reads.** Only a small set of safe text and
//!    image MIME types is served — markdown, plain text, PNG, JPEG,
//!    WebP, GIF, SVG, PDF. Everything else is rejected.
//!
//! In addition, hidden entries (leading `.`) are filtered out on
//! [`Porch::list_vault`] so Obsidian's own `.obsidian/` config dir,
//! plus any `.git/` etc., never surface to visitors.

use std::path::{Component, Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::db::{device_id_unchecked, unix_millis, Porch};
use super::error::PorchError;
use super::sync::clock::next_lamport;

/// Hard cap on a single vault file read. 5 MiB matches the design
/// doc's guidance (markdown is small; attached images are the big
/// case). Anything larger is refused with a typed "too large" marker
/// so the visitor's UI can surface "ask the owner to share directly"
/// rather than retrying.
pub const MAX_VAULT_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Per-channel obsidian binding row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObsidianChannelConfig {
    pub channel_id: String,
    /// Canonicalized absolute path to the vault root on disk. Stored
    /// in canonical form so prefix checks at access time can compare
    /// directly without re-canonicalizing.
    pub vault_root: PathBuf,
    /// Optional subfolder relative to `vault_root`. Forward-slash form
    /// on the wire; the OS-native form is rebuilt from segments.
    /// `None` = expose the whole vault.
    pub subfolder: Option<PathBuf>,
    /// Whether to traverse symlinks that point outside `vault_root`.
    /// Default-off (see module docs).
    pub follow_symlinks: bool,
}

impl ObsidianChannelConfig {
    /// Compute the effective root the visitor sees as `""`.
    /// `vault_root` if `subfolder` is `None`, else `vault_root.join(subfolder)`.
    pub fn effective_root(&self) -> PathBuf {
        match &self.subfolder {
            Some(sub) => self.vault_root.join(sub),
            None => self.vault_root.clone(),
        }
    }
}

/// A single entry surfaced inside a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultEntry {
    /// Forward-slash-normalized path, relative to the effective root.
    /// Empty string would be the root itself; root never appears as an
    /// entry inside its own listing.
    pub path: String,
    pub kind: EntryKind,
    /// Bytes for files, `None` for directories.
    pub size: Option<u64>,
    /// Unix milliseconds (file/dir mtime), or `None` if unavailable.
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
}

impl Porch {
    // -----------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------

    /// Owner-side: configure a channel as Obsidian-backed.
    ///
    /// The channel must already exist (typically created via
    /// `porch_create_channel` with `kind = 'obsidian'`). The
    /// `vault_root` argument is [`std::fs::canonicalize`]'d before
    /// storage so the prefix-check security gate at access time can
    /// compare against the canonical form directly. Paths that don't
    /// exist on disk are rejected.
    ///
    /// `subfolder`, if present, is interpreted relative to the
    /// canonical `vault_root` and must canonicalize back inside it
    /// (the same trap-door check the read/list paths use).
    pub fn set_obsidian_config(
        &self,
        channel_id: &str,
        vault_root: &Path,
        subfolder: Option<&Path>,
        follow_symlinks: bool,
    ) -> Result<ObsidianChannelConfig, PorchError> {
        if self.get_channel(channel_id)?.is_none() {
            return Err(PorchError::ChannelNotFound {
                channel_id: channel_id.to_string(),
            });
        }
        let canonical_root = std::fs::canonicalize(vault_root).map_err(|e| {
            PorchError::InvalidInput(format!(
                "vault_root {} does not exist or is not accessible: {e}",
                vault_root.display()
            ))
        })?;
        if !canonical_root.is_dir() {
            return Err(PorchError::InvalidInput(format!(
                "vault_root {} is not a directory",
                canonical_root.display()
            )));
        }
        // Subfolder validation: must canonicalize inside the canonical
        // root. We accept either a relative path (joined against the
        // root) or an absolute path (validated for prefix).
        let canonical_sub: Option<PathBuf> = match subfolder {
            None => None,
            Some(sub) => {
                if sub.as_os_str().is_empty() {
                    None
                } else {
                    let absolute = if sub.is_absolute() {
                        sub.to_path_buf()
                    } else {
                        canonical_root.join(sub)
                    };
                    let canon_sub = std::fs::canonicalize(&absolute).map_err(|e| {
                        PorchError::InvalidInput(format!(
                            "subfolder {} does not exist or is not accessible: {e}",
                            sub.display()
                        ))
                    })?;
                    if !canon_sub.starts_with(&canonical_root) {
                        return Err(PorchError::InvalidInput(format!(
                            "subfolder {} escapes vault_root",
                            sub.display()
                        )));
                    }
                    if !canon_sub.is_dir() {
                        return Err(PorchError::InvalidInput(format!(
                            "subfolder {} is not a directory",
                            sub.display()
                        )));
                    }
                    // Store the subfolder as the *relative* form so the
                    // wire surface doesn't leak the absolute root path
                    // a second time. The relative form is rebuilt at
                    // load.
                    let rel = canon_sub
                        .strip_prefix(&canonical_root)
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|_| PathBuf::new());
                    if rel.as_os_str().is_empty() {
                        None
                    } else {
                        Some(rel)
                    }
                }
            }
        };

        let now = unix_millis();
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        // Phase F — Obsidian channel binding is LWW per channel_id.
        // The vault_root path is DEVICE-LOCAL by design — a vault that
        // exists on laptop A doesn't necessarily exist at the same
        // path on laptop B. Sync DOES replicate the row across
        // personal devices so the channel kind is consistent, but the
        // path-on-disk is a per-device user choice.
        let device_id = device_id_unchecked(&conn)?;
        let lamport = next_lamport(&conn)?;
        conn.execute(
            "INSERT INTO obsidian_channels
                (channel_id, vault_root, subfolder, follow_symlinks, updated_at,
                 sync_device_id, sync_lamport, sync_tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
             ON CONFLICT(channel_id) DO UPDATE SET
                 vault_root = excluded.vault_root,
                 subfolder = excluded.subfolder,
                 follow_symlinks = excluded.follow_symlinks,
                 updated_at = excluded.updated_at,
                 sync_device_id = excluded.sync_device_id,
                 sync_lamport = excluded.sync_lamport,
                 sync_tombstone = 0",
            params![
                channel_id,
                canonical_root.to_string_lossy().to_string(),
                canonical_sub
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                if follow_symlinks { 1_i64 } else { 0 },
                now,
                device_id,
                lamport,
            ],
        )?;
        Ok(ObsidianChannelConfig {
            channel_id: channel_id.to_string(),
            vault_root: canonical_root,
            subfolder: canonical_sub,
            follow_symlinks,
        })
    }

    /// Owner-side: fetch the binding for a channel. `None` if the
    /// channel is not yet bound to a vault.
    pub fn get_obsidian_config(
        &self,
        channel_id: &str,
    ) -> Result<Option<ObsidianChannelConfig>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row = conn
            .query_row(
                "SELECT channel_id, vault_root, subfolder, follow_symlinks
                 FROM obsidian_channels WHERE channel_id = ?1",
                params![channel_id],
                |r| {
                    let channel_id: String = r.get(0)?;
                    let root_str: String = r.get(1)?;
                    let sub_str: Option<String> = r.get(2)?;
                    let follow: i64 = r.get(3)?;
                    Ok(ObsidianChannelConfig {
                        channel_id,
                        vault_root: PathBuf::from(root_str),
                        subfolder: sub_str.map(PathBuf::from),
                        follow_symlinks: follow != 0,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    // -----------------------------------------------------------------
    // List / read
    // -----------------------------------------------------------------

    /// List the contents of `rel_path` within the channel's vault.
    /// `rel_path` is forward-slash form, relative to the effective root
    /// (`vault_root` joined with optional subfolder). An empty string
    /// lists the effective root.
    ///
    /// Ordering: directories first, then files; alphabetical within
    /// each group. Hidden entries (leading `.`) are filtered out so
    /// `.obsidian/`, `.git/`, etc. never leak to visitors.
    pub fn list_vault(
        &self,
        channel_id: &str,
        rel_path: &str,
    ) -> Result<Vec<VaultEntry>, PorchError> {
        let cfg = self.get_obsidian_config(channel_id)?.ok_or_else(|| {
            PorchError::InvalidInput(format!(
                "channel {channel_id} has no obsidian binding"
            ))
        })?;
        let effective_root = cfg.effective_root();
        let target = resolve_vault_path(&cfg, &effective_root, rel_path)?;

        let read_dir = std::fs::read_dir(&target).map_err(PorchError::Io)?;
        let mut out: Vec<VaultEntry> = Vec::new();
        for entry in read_dir {
            let entry = entry.map_err(PorchError::Io)?;
            let name = entry.file_name();
            let name_str = match name.to_str() {
                Some(s) => s.to_string(),
                None => continue, // skip non-UTF8 filenames
            };
            // Filter hidden entries — Obsidian config dirs, VCS dirs,
            // and any other dotfile the owner doesn't expect to ship.
            if name_str.starts_with('.') {
                continue;
            }
            // Skip symlinks pointing outside vault when follow disabled.
            let entry_path = entry.path();
            let metadata = match std::fs::symlink_metadata(&entry_path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() && !cfg.follow_symlinks {
                // Resolve target; skip entirely if it escapes the vault.
                let resolved = match std::fs::canonicalize(&entry_path) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if !resolved.starts_with(&cfg.vault_root) {
                    continue;
                }
            }
            let file_meta = match std::fs::metadata(&entry_path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let kind = if file_meta.is_dir() {
                EntryKind::Directory
            } else if file_meta.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            let size = if matches!(kind, EntryKind::File) {
                Some(file_meta.len())
            } else {
                None
            };
            let modified_at = file_meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);

            // Path is forward-slash form relative to effective root.
            let rel_to_effective = if rel_path.is_empty() {
                name_str.clone()
            } else {
                format!("{}/{}", rel_path.trim_matches('/'), name_str)
            };
            out.push(VaultEntry {
                path: rel_to_effective,
                kind,
                size,
                modified_at,
            });
        }
        // Sort: dirs first, then files, alphabetical within each.
        out.sort_by(|a, b| match (a.kind, b.kind) {
            (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
            (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
            _ => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
        });
        Ok(out)
    }

    /// Read a single file out of the vault. Returns the bytes plus the
    /// inferred MIME type (from the extension; MIME allow-list enforced).
    ///
    /// The size cap is [`MAX_VAULT_FILE_BYTES`] — anything larger is
    /// refused with `PorchError::InvalidInput("file too large: ...")`.
    /// The wire layer surfaces a typed marker so the visitor sees a
    /// friendly "ask the owner to share directly" message rather than a
    /// transport-layer error.
    pub fn read_vault_file(
        &self,
        channel_id: &str,
        rel_path: &str,
    ) -> Result<(Vec<u8>, String), PorchError> {
        let cfg = self.get_obsidian_config(channel_id)?.ok_or_else(|| {
            PorchError::InvalidInput(format!(
                "channel {channel_id} has no obsidian binding"
            ))
        })?;
        let effective_root = cfg.effective_root();
        let target = resolve_vault_path(&cfg, &effective_root, rel_path)?;
        let meta = std::fs::metadata(&target).map_err(PorchError::Io)?;
        if !meta.is_file() {
            return Err(PorchError::InvalidInput(format!(
                "path {rel_path} is not a file"
            )));
        }
        if meta.len() > MAX_VAULT_FILE_BYTES {
            return Err(PorchError::InvalidInput(format!(
                "file too large: {} > {}",
                meta.len(),
                MAX_VAULT_FILE_BYTES
            )));
        }
        let mime = mime_for_path(&target).ok_or_else(|| {
            PorchError::InvalidInput(format!(
                "unsupported file type for {rel_path} — only markdown, text, common images and PDF are served"
            ))
        })?;
        let bytes = std::fs::read(&target).map_err(PorchError::Io)?;
        Ok((bytes, mime.to_string()))
    }
}

/// Resolve a wire-supplied relative path against the configured
/// effective root, applying every security gate before returning the
/// resolved absolute path. Returns `PorchError::InvalidInput` on any
/// traversal attempt.
fn resolve_vault_path(
    cfg: &ObsidianChannelConfig,
    effective_root: &Path,
    rel_path: &str,
) -> Result<PathBuf, PorchError> {
    // Normalize the wire path: strip leading slashes, reject empty
    // segments (which would let `///etc/passwd` slip through trivial
    // checks), and reject any `..` component up front. We canonicalize
    // for the second-line defence below.
    let cleaned = rel_path.trim_matches('/');
    let mut accum = PathBuf::new();
    for seg in cleaned.split('/') {
        if seg.is_empty() {
            continue;
        }
        if seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(PorchError::InvalidInput(format!(
                "path traversal not allowed: {rel_path}"
            )));
        }
        accum.push(seg);
    }
    let joined = effective_root.join(&accum);
    // Belt + suspenders: canonicalize and prefix-check. If the path
    // doesn't exist (e.g. listing a missing directory), fall back to
    // component-wise inspection on the joined path itself — every
    // component is already `..`-checked above.
    let resolved = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        Err(_) => {
            // Verify the joined path is still inside effective_root
            // even though it doesn't exist (so we surface a more
            // descriptive ENOENT to the visitor than a confusing
            // permissions error).
            if joined
                .components()
                .any(|c| matches!(c, Component::ParentDir))
            {
                return Err(PorchError::InvalidInput(format!(
                    "path traversal not allowed: {rel_path}"
                )));
            }
            return Err(PorchError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("path not found: {rel_path}"),
            )));
        }
    };
    // The fundamental boundary: resolved path MUST be inside the
    // canonical vault_root (and effective_root, which itself is inside
    // the vault_root). Symlink escapes are caught here unless the
    // owner has explicitly opted into following symlinks.
    if !resolved.starts_with(&cfg.vault_root) {
        return Err(PorchError::InvalidInput(format!(
            "path escapes vault: {rel_path}"
        )));
    }
    if !cfg.follow_symlinks {
        // Walk the joined path component by component; if any
        // intermediate symlink points outside the vault, reject.
        let mut cursor = effective_root.to_path_buf();
        for component in accum.components() {
            cursor.push(component);
            if let Ok(md) = std::fs::symlink_metadata(&cursor) {
                if md.file_type().is_symlink() {
                    let target = match std::fs::canonicalize(&cursor) {
                        Ok(t) => t,
                        Err(_) => {
                            return Err(PorchError::InvalidInput(format!(
                                "symlink resolution failed: {rel_path}"
                            )));
                        }
                    };
                    if !target.starts_with(&cfg.vault_root) {
                        return Err(PorchError::InvalidInput(format!(
                            "symlink escapes vault: {rel_path}"
                        )));
                    }
                }
            }
        }
    }
    Ok(resolved)
}

/// MIME inference + allow-list. Returns `None` for any unsupported
/// type; the caller surfaces that to the visitor as a typed error.
pub fn mime_for_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())?;
    match ext.as_str() {
        "md" | "markdown" => Some("text/markdown"),
        "txt" => Some("text/plain"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::channel::{AclMode, ChannelKind};

    fn fresh_porch_with_obsidian_channel() -> (Porch, tempfile::TempDir, tempfile::TempDir) {
        let tmp_porch = tempfile::tempdir().expect("tmp porch dir");
        let porch = Porch::open(tmp_porch.path()).expect("porch open ok");
        porch
            .insert_channel("ob-1", "Vault", ChannelKind::Obsidian, AclMode::Allowlist)
            .expect("insert channel ok");
        let tmp_vault = tempfile::tempdir().expect("tmp vault dir");
        (porch, tmp_porch, tmp_vault)
    }

    #[test]
    fn set_then_get_round_trips_config() {
        let (porch, _tmp_porch, tmp_vault) = fresh_porch_with_obsidian_channel();
        let cfg = porch
            .set_obsidian_config("ob-1", tmp_vault.path(), None, false)
            .expect("set ok");
        assert_eq!(cfg.channel_id, "ob-1");
        assert!(cfg.vault_root.is_absolute());
        assert_eq!(cfg.subfolder, None);
        assert!(!cfg.follow_symlinks);
        let fetched = porch
            .get_obsidian_config("ob-1")
            .expect("get ok")
            .expect("must exist");
        assert_eq!(fetched.vault_root, cfg.vault_root);
    }

    #[test]
    fn mime_for_path_allowlist() {
        assert_eq!(mime_for_path(Path::new("x.md")), Some("text/markdown"));
        assert_eq!(mime_for_path(Path::new("X.MARKDOWN")), Some("text/markdown"));
        assert_eq!(mime_for_path(Path::new("x.png")), Some("image/png"));
        assert_eq!(mime_for_path(Path::new("x.PDF")), Some("application/pdf"));
        assert_eq!(mime_for_path(Path::new("x.exe")), None);
        assert_eq!(mime_for_path(Path::new("Makefile")), None);
    }
}
