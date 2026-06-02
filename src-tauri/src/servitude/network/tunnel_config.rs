//! Phase G — operator-supplied tunnel-only mode configuration.
//!
//! The config is a tiny JSON file at
//! `<app_local_data_dir>/tunnel_config.json` with two fields:
//!
//!   * `enforce: bool` — when `true`, the libp2p
//!     [`crate::servitude::network::ConnectionGate`] rejects every
//!     inbound source IP that isn't on the allow-list. Defaults to
//!     `false` so an existing install doesn't suddenly lose
//!     connectivity after upgrading — the operator opts in via the
//!     Settings → Connections → Tunnel hardening surface.
//!   * `extra_cidrs: Vec<String>` — additional CIDRs to trust beyond
//!     the OS-level auto-detected interfaces. Stored as strings (not
//!     `ipnet::IpNet`) so the on-disk format is human-editable and
//!     round-trips through serde without a custom adapter; we parse
//!     at load and skip invalid entries with a warning.

use std::path::{Path, PathBuf};

use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// On-disk filename. Sibling to `peer-identity.stronghold` /
/// `porch.sqlite` inside the install's `app_local_data_dir`.
pub const TUNNEL_CONFIG_FILENAME: &str = "tunnel_config.json";

#[derive(Debug, Error)]
pub enum TunnelConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

/// Operator-facing tunnel-hardening preferences. Persisted to
/// `<data_dir>/tunnel_config.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    /// Hard switch — true enables the inbound gate, false disables
    /// it. Default false (see module docs).
    #[serde(default)]
    pub enforce: bool,
    /// Extra CIDR blocks (string form) to trust beyond auto-detected
    /// interfaces. Strings — not `IpNet` — because the on-disk format
    /// stays human-editable and the parse error is reported as a
    /// per-string skip + warning rather than a hard reload failure.
    #[serde(default)]
    pub extra_cidrs: Vec<String>,
}

impl TunnelConfig {
    /// Absolute path the config persists to inside `data_dir`.
    pub fn path_in(data_dir: &Path) -> PathBuf {
        data_dir.join(TUNNEL_CONFIG_FILENAME)
    }

    /// Load the config from `<data_dir>/tunnel_config.json`. Returns
    /// `Default::default()` (enforce=off, no extras) when the file is
    /// absent — first-boot behaviour by design.
    pub fn load(data_dir: &Path) -> Result<Self, TunnelConfigError> {
        let path = Self::path_in(data_dir);
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(&path)?;
        let cfg: Self = serde_json::from_slice(&bytes)?;
        Ok(cfg)
    }

    /// Persist the config to `<data_dir>/tunnel_config.json`. Creates
    /// the directory if missing. Uses an atomic write (write to
    /// `<path>.tmp`, rename) so a crash mid-write can't leave a
    /// truncated JSON file behind.
    pub fn save(&self, data_dir: &Path) -> Result<(), TunnelConfigError> {
        std::fs::create_dir_all(data_dir)?;
        let path = Self::path_in(data_dir);
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self)?;
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Parse `extra_cidrs` into typed `IpNet`s. Invalid entries are
    /// silently skipped (a debug-level log line is emitted by the
    /// caller); the caller is responsible for validating before save
    /// if it wants to surface errors to the operator.
    pub fn parsed_extras(&self) -> Vec<IpNet> {
        self.extra_cidrs
            .iter()
            .filter_map(|s| s.parse::<IpNet>().ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_is_permissive() {
        let cfg = TunnelConfig::default();
        assert!(!cfg.enforce);
        assert!(cfg.extra_cidrs.is_empty());
        assert!(cfg.parsed_extras().is_empty());
    }

    #[test]
    fn load_missing_file_returns_default() {
        let dir = tempdir().expect("tmp");
        let cfg = TunnelConfig::load(dir.path()).expect("load");
        assert_eq!(cfg, TunnelConfig::default());
    }

    #[test]
    fn save_then_load_round_trip() {
        let dir = tempdir().expect("tmp");
        let original = TunnelConfig {
            enforce: true,
            extra_cidrs: vec!["10.42.0.0/16".to_string(), "fd00::/8".to_string()],
        };
        original.save(dir.path()).expect("save");
        let reloaded = TunnelConfig::load(dir.path()).expect("load");
        assert_eq!(reloaded, original);
    }

    #[test]
    fn parsed_extras_skips_invalid_strings() {
        let cfg = TunnelConfig {
            enforce: false,
            extra_cidrs: vec![
                "10.42.0.0/16".to_string(),
                "not-a-cidr".to_string(),
                "fd00::/8".to_string(),
            ],
        };
        let parsed = cfg.parsed_extras();
        assert_eq!(parsed.len(), 2);
    }
}
