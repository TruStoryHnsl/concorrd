//! Servitude configuration loader and validator.
//!
//! Loads TOML config from disk (or from a string in tests), then runs a
//! Pydantic-style `validate()` pass that enforces invariants the type system
//! cannot express. The validator is intentionally explicit and easy to extend.
//!
//! All errors flow through [`ConfigError`], which feeds into the top-level
//! `ServitudeError` via `#[from]`.

use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

/// Key under which the servitude config is persisted in the shared
/// `settings.json` tauri store. Kept as a module-local const so callers never
/// stringify it themselves.
pub const SERVITUDE_STORE_KEY: &str = "servitude";

/// Store file name used for persistence. Matches the file already used by
/// the rest of the Concord settings surface (see `lib.rs`).
pub const SETTINGS_STORE_FILE: &str = "settings.json";

/// Env var used to override the persisted [`Profile`] at boot.
///
/// docker-compose.yml sets this to `web_first` for the
/// `concord-api` container so the docker stack always runs the full
/// web stack regardless of whatever value made it onto disk from a
/// prior native run. Native Tauri builds leave the variable unset,
/// so the persisted (or defaulted) profile is what takes effect.
pub const PROFILE_ENV_VAR: &str = "CONCORD_PROFILE";

/// Deployment profile — which subset of services the servitude brings up.
///
/// Phase 7 (INS-019b) introduces the explicit native/web split. The same
/// Rust binary ships in both contexts; only the chosen subset of
/// transports actually starts. The Phase-0 hosting status surface
/// (`/api/hosting/status`) is what the Settings UI uses to walk an
/// operator through DNS + port-forward when they flip native to web.
///
/// Default for native Tauri builds is [`Profile::P2pOnly`] — libp2p
/// runs, every other transport is gated behind an explicit toggle.
/// Docker builds set `CONCORD_PROFILE=web_first` in docker-compose so
/// every transport in `enabled_transports` materializes at boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    /// libp2p swarm only — no Caddy / LiveKit / coturn / sslh and no
    /// Matrix federation child process. The default for native Tauri
    /// builds: the install joins the Concord P2P mesh and can be
    /// reached via Phase-5 peer pairing, but a browser tab cannot
    /// load it directly because no public HTTP surface is bound.
    P2pOnly,
    /// Full web stack (Caddy + LiveKit + coturn + sslh, Matrix
    /// federation child process, etc.) plus libp2p. The default for
    /// docker / web-first deployments. Native installs flip to this
    /// via the Settings → Profile → "Make this instance
    /// web-accessible" toggle.
    WebFirst,
}

impl Profile {
    /// Parse a [`Profile`] from a string, matching the snake_case wire
    /// form. Used by [`Self::from_env`] so an invalid env value falls
    /// through to the persisted/default profile instead of crashing
    /// the boot.
    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "p2p_only" | "p2ponly" => Some(Profile::P2pOnly),
            "web_first" | "webfirst" => Some(Profile::WebFirst),
            _ => None,
        }
    }

    /// If the [`PROFILE_ENV_VAR`] is set and parseable, return its
    /// value. Otherwise `None` and the caller falls back to the
    /// persisted/default profile.
    pub fn from_env() -> Option<Self> {
        std::env::var(PROFILE_ENV_VAR)
            .ok()
            .and_then(|s| Self::parse_str(&s))
    }
}

impl Default for Profile {
    /// Native = `P2pOnly`. Docker = `WebFirst` via the
    /// `CONCORD_PROFILE` env var set in `docker-compose.yml`. We can't
    /// reliably tell at compile time which we are (the Rust binary in
    /// the Tauri sidecar is the same in both contexts) so the
    /// default is the safer one for native — and the docker stack
    /// MUST set the env var to flip it.
    fn default() -> Self {
        Profile::P2pOnly
    }
}

/// Layered transports the embedded servitude can advertise.
///
/// The actual runtime wiring lives in a separate task — this enum is the
/// declarative contract that downstream code can match on. Order matters
/// only for serialization (it is not a preference list).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    /// WireGuard tunnels (Headscale / Tailscale-style mesh). Stable backbone.
    WireGuard,
    /// Local-radio mesh (BLE / WiFi Direct / WiFi AP) for offline reach.
    Mesh,
    /// HTTP/QUIC tunnels through cooperating relays for NAT traversal.
    Tunnel,
    /// Matrix federation — the canonical Concord stable transport.
    MatrixFederation,
    /// Reticulum overlay transport (INS-037). Spawns `rnsd` as a child
    /// process and provides mesh-style peer discovery + encrypted channels
    /// as an additive overlay alongside Matrix federation in the main
    /// build. Feature-gated so default builds never pull it in.
    ///
    /// Available only when the `reticulum` Cargo feature is enabled.
    /// Non-critical: `rnsd` failures are recorded in
    /// `ServitudeHandle::degraded` without stopping the rest of the
    /// servitude. Requires `rnsd` on PATH or the `RNSD_BIN` env var.
    #[cfg(feature = "reticulum")]
    Reticulum,
}

/// Validated servitude configuration.
///
/// Loaded from a TOML file at startup. Field defaults intentionally match
/// the conservative MVP profile: foreground-active, single transport (Matrix
/// federation), modest peer cap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServitudeConfig {
    /// Human-readable name advertised to peers. Must be non-empty after trim.
    pub display_name: String,

    /// Maximum number of concurrent peer connections. Must be > 0.
    pub max_peers: i64,

    /// TCP/UDP port the embedded server listens on. By default constrained to
    /// the unprivileged range (1024..=65535) unless `allow_privileged_port`
    /// is set to `true`.
    pub listen_port: i64,

    /// Escape hatch for explicitly running on a privileged (<1024) port.
    /// Defaults to `false` so accidental misconfiguration is rejected.
    #[serde(default)]
    pub allow_privileged_port: bool,

    /// Layered transports this node will speak. At least one must be enabled.
    ///
    /// Deserialized via [`deserialize_tolerant_transports`] so a stored
    /// config from an older build that contains a now-removed variant
    /// (e.g. `discord_bridge`, the deprecated bridge that shipped in
    /// 0.4) does NOT brick the app at startup. Unknown variants are
    /// logged + dropped; if every entry is unknown the field falls
    /// back to [`default_transports`].
    #[serde(
        default = "default_transports",
        deserialize_with = "deserialize_tolerant_transports"
    )]
    pub enabled_transports: Vec<Transport>,

    /// Deployment profile. Native Tauri builds default to
    /// [`Profile::P2pOnly`]; the docker stack flips this to
    /// [`Profile::WebFirst`] via the `CONCORD_PROFILE` env var at boot
    /// (see [`PROFILE_ENV_VAR`] and [`Profile::from_env`]). The
    /// persisted value is what the user-facing Settings toggle writes
    /// to. The env var ALWAYS wins over the persisted value so the
    /// docker stack can never accidentally come up in p2p-only mode
    /// because of a stale on-disk config.
    #[serde(default)]
    pub profile: Profile,
}

/// Per-field default used by serde when `enabled_transports` is
/// omitted from a stored settings.json. MUST stay aligned with
/// `Default for ServitudeConfig` — both treat a fresh / field-absent
/// install as porch-only. Returning a non-empty `[MatrixFederation]`
/// here was the cause of "I disconnected but the host came back" on
/// any settings file that simply omitted the key (e.g. an older
/// build's persisted shape, or an upgrade write that didn't
/// re-emit the field). Keeping it empty makes the field-absent path
/// match the explicit-empty path.
fn default_transports() -> Vec<Transport> {
    Vec::new()
}

/// Deserialize `enabled_transports` while tolerating unknown variants.
///
/// Older builds shipped transport variants that no longer exist (the
/// most common offender is `discord_bridge`, removed pre-0.5 — a
/// stored settings.json carrying it would fail the strict
/// `Vec<Transport>` derive deserialize with a TOML/JSON parse error
/// and brick the app on startup). Tolerant deserialization fixes
/// that: every entry is read as a string, mapped to its `Transport`
/// variant if known, and dropped with a warning if not. When the
/// filter leaves the list empty (every entry was unknown) the field
/// falls back to [`default_transports`] so the user's instance still
/// comes up with a working transport set.
fn deserialize_tolerant_transports<'de, D>(
    d: D,
) -> Result<Vec<Transport>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: Vec<String> = Vec::<String>::deserialize(d)?;
    let raw_was_empty = raw.is_empty();
    let parsed: Vec<Transport> = raw
        .into_iter()
        .filter_map(|s| match s.as_str() {
            "wire_guard" => Some(Transport::WireGuard),
            "mesh" => Some(Transport::Mesh),
            "tunnel" => Some(Transport::Tunnel),
            "matrix_federation" => Some(Transport::MatrixFederation),
            #[cfg(feature = "reticulum")]
            "reticulum" => Some(Transport::Reticulum),
            other => {
                log::warn!(
                    target: "concord::config",
                    "skipping unknown enabled_transports variant {other:?} \
                     (likely from a removed or feature-gated transport); \
                     update the stored settings to silence this warning"
                );
                None
            }
        })
        .collect();
    // Respect an EXPLICITLY empty list — that's the operator saying
    // "run only the libp2p baseline, no MatrixFederation, no nothing
    // else." Falling back to defaults here would silently resurrect
    // tuwunel on an install that explicitly opted out. The fallback
    // is ONLY for the config-drift case: input was non-empty but
    // every entry was an unknown / removed variant.
    if parsed.is_empty() && !raw_was_empty {
        log::warn!(
            target: "concord::config",
            "no recognized transports in enabled_transports; falling back \
             to default ({:?})",
            default_transports()
        );
        return Ok(default_transports());
    }
    Ok(parsed)
}

impl Default for ServitudeConfig {
    fn default() -> Self {
        Self {
            display_name: "concord-node".to_string(),
            max_peers: 32,
            listen_port: 8765,
            allow_privileged_port: false,
            // Fresh install = porch-only. The libp2p baseline is
            // always-on and runs regardless of this list; optional
            // transports (MatrixFederation tuwunel, WireGuard, Mesh,
            // Tunnel) only come up when the operator EXPLICITLY adds
            // them. Defaulting to MatrixFederation here was the
            // root cause of every "I disconnected but it came back"
            // bug — a freshly nuked install with no settings.json
            // would auto-spawn tuwunel and pull the user back into
            // a hosted-Matrix posture they never opted into.
            enabled_transports: Vec::new(),
            profile: Profile::default(),
        }
    }
}

impl ServitudeConfig {
    /// Load and validate a config from a TOML file on disk.
    pub fn from_path<P: AsRef<Path>>(path: P) -> Result<Self, ConfigError> {
        let raw =
            std::fs::read_to_string(path.as_ref()).map_err(|e| ConfigError::Io(e.to_string()))?;
        Self::from_toml_str(&raw)
    }

    /// Parse a TOML string and run [`Self::validate`].
    pub fn from_toml_str(raw: &str) -> Result<Self, ConfigError> {
        let mut cfg: Self =
            toml::from_str(raw).map_err(|e| ConfigError::Parse(e.to_string()))?;
        cfg.apply_profile_env_override();
        cfg.validate()?;
        Ok(cfg)
    }

    /// If [`PROFILE_ENV_VAR`] is set to a parseable value, override the
    /// in-memory `profile` with it. The persisted value on disk is
    /// untouched — the override only affects this loaded handle.
    ///
    /// Docker compose sets this env var so the stack is guaranteed to
    /// boot in `web_first` regardless of any value the on-disk config
    /// might carry. Native builds leave it unset and the persisted
    /// (or default) value is what takes effect.
    fn apply_profile_env_override(&mut self) {
        if let Some(p) = Profile::from_env() {
            self.profile = p;
        }
    }

    /// Load a validated `ServitudeConfig` from the shared tauri settings
    /// store under the [`SERVITUDE_STORE_KEY`] key.
    ///
    /// If the key is absent (first-run / never persisted), returns
    /// [`ServitudeConfig::default`] — this is an explicit, non-error case
    /// so the embedded servitude can always come up.
    ///
    /// Any stored value that fails schema or validation checks is surfaced
    /// as a [`ConfigError`] so the caller can decide whether to reset or
    /// surface the failure to the user.
    pub fn from_store(app: &tauri::AppHandle) -> Result<Self, ConfigError> {
        use tauri_plugin_store::StoreExt;

        let store = app
            .store(SETTINGS_STORE_FILE)
            .map_err(|e| ConfigError::Store(e.to_string()))?;

        let Some(value) = store.get(SERVITUDE_STORE_KEY) else {
            let mut cfg = Self::default();
            cfg.apply_profile_env_override();
            return Ok(cfg);
        };

        let mut cfg: Self =
            serde_json::from_value(value).map_err(|e| ConfigError::Parse(e.to_string()))?;
        cfg.apply_profile_env_override();
        cfg.validate()?;
        Ok(cfg)
    }

    /// Persist this config to the shared tauri settings store under the
    /// [`SERVITUDE_STORE_KEY`] key. Validation runs before writing so a bad
    /// config can never land on disk.
    pub fn save_to_store(&self, app: &tauri::AppHandle) -> Result<(), ConfigError> {
        use tauri_plugin_store::StoreExt;

        self.validate()?;

        let store = app
            .store(SETTINGS_STORE_FILE)
            .map_err(|e| ConfigError::Store(e.to_string()))?;

        let value = serde_json::to_value(self).map_err(|e| ConfigError::Parse(e.to_string()))?;
        store.set(SERVITUDE_STORE_KEY, value);
        store
            .save()
            .map_err(|e| ConfigError::Store(e.to_string()))?;
        Ok(())
    }

    /// Pydantic-style validator. Enforces invariants the type system cannot
    /// express. Returns the first error encountered (fail-fast). Designed to
    /// be cheap so callers can re-run after edits.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.display_name.trim().is_empty() {
            return Err(ConfigError::EmptyDisplayName);
        }
        if self.max_peers <= 0 {
            return Err(ConfigError::InvalidMaxPeers(self.max_peers));
        }
        if self.listen_port < 1 || self.listen_port > 65_535 {
            return Err(ConfigError::PortOutOfRange(self.listen_port));
        }
        if self.listen_port < 1024 && !self.allow_privileged_port {
            return Err(ConfigError::PrivilegedPortNotAllowed(self.listen_port));
        }
        // `enabled_transports` is allowed to be empty under the porch
        // architecture: the libp2p baseline transport is always-on
        // and is intentionally NOT declared in this list. An empty
        // list = "porch-only install, no MatrixFederation, no
        // optional transports." Rejecting empty here was a holdover
        // from the pre-porch era when MatrixFederation was treated
        // as load-bearing.

        Ok(())
    }
}

/// Structured config error type. Every variant is actionable.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("failed to read config file: {0}")]
    Io(String),

    #[error("failed to parse config TOML: {0}")]
    Parse(String),

    #[error("display_name must not be empty")]
    EmptyDisplayName,

    #[error("max_peers must be > 0, got {0}")]
    InvalidMaxPeers(i64),

    #[error("listen_port {0} is outside the valid 1..=65535 range")]
    PortOutOfRange(i64),

    #[error("listen_port {0} is privileged (<1024); set allow_privileged_port = true to override")]
    PrivilegedPortNotAllowed(i64),

    #[error("settings store error: {0}")]
    Store(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ServitudeConfig {
        ServitudeConfig {
            display_name: "node-a".to_string(),
            max_peers: 8,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::MatrixFederation],
            profile: Profile::P2pOnly,
        }
    }

    #[test]
    fn test_config_validation_accepts_valid_config() {
        let cfg = base();
        cfg.validate().expect("base config should validate");
    }

    #[test]
    fn test_servitude_config_serde_round_trip() {
        // Every field intentionally set to a NON-default value so schema
        // drift (renamed/dropped fields) is caught by an assertion failure
        // rather than silently surviving because the default matched.
        let enabled_transports = {
            let mut transports = vec![
                Transport::WireGuard,
                Transport::Mesh,
                Transport::Tunnel,
                Transport::MatrixFederation,
            ];
            #[cfg(feature = "reticulum")]
            transports.push(Transport::Reticulum);
            transports
        };

        let original = ServitudeConfig {
            display_name: "round-trip-fixture".to_string(),
            max_peers: 99,
            listen_port: 31_337,
            allow_privileged_port: true,
            enabled_transports,
            profile: Profile::WebFirst,
        };

        let json =
            serde_json::to_string(&original).expect("ServitudeConfig should serialize to JSON");
        let decoded: ServitudeConfig = serde_json::from_str(&json)
            .expect("ServitudeConfig should deserialize from its own JSON");

        assert_eq!(decoded.display_name, original.display_name);
        assert_eq!(decoded.max_peers, original.max_peers);
        assert_eq!(decoded.listen_port, original.listen_port);
        assert_eq!(
            decoded.allow_privileged_port,
            original.allow_privileged_port
        );
        assert_eq!(decoded.enabled_transports, original.enabled_transports);
        assert_eq!(decoded.profile, original.profile);

        // And the decoded config must still pass validation (catches
        // "serde accepted garbage but validator would have rejected it").
        decoded
            .validate()
            .expect("round-tripped config should revalidate");
    }

    #[test]
    fn test_config_validation_rejects_empty_display_name() {
        let mut cfg = base();
        cfg.display_name = "".to_string();
        assert_eq!(cfg.validate(), Err(ConfigError::EmptyDisplayName));

        cfg.display_name = "   ".to_string();
        assert_eq!(cfg.validate(), Err(ConfigError::EmptyDisplayName));
    }

    #[test]
    fn test_config_validation_rejects_negative_max_peers() {
        let mut cfg = base();
        cfg.max_peers = -1;
        assert_eq!(cfg.validate(), Err(ConfigError::InvalidMaxPeers(-1)));

        cfg.max_peers = 0;
        assert_eq!(cfg.validate(), Err(ConfigError::InvalidMaxPeers(0)));
    }

    #[test]
    fn test_config_validation_rejects_invalid_port_range() {
        let mut cfg = base();
        cfg.listen_port = 0;
        assert_eq!(cfg.validate(), Err(ConfigError::PortOutOfRange(0)));

        cfg.listen_port = 70_000;
        assert_eq!(cfg.validate(), Err(ConfigError::PortOutOfRange(70_000)));

        // Privileged port without override is also rejected.
        cfg.listen_port = 80;
        assert_eq!(
            cfg.validate(),
            Err(ConfigError::PrivilegedPortNotAllowed(80))
        );

        // ...but allowed when explicitly flagged.
        cfg.allow_privileged_port = true;
        cfg.validate().expect("explicit override should succeed");
    }

    #[test]
    fn test_config_validation_allows_empty_transports() {
        // Empty `enabled_transports` is the porch-only configuration:
        // the always-on libp2p baseline runs and no optional
        // MatrixFederation / WireGuard / Mesh transports come up.
        // validate() MUST accept it — rejecting empty here was a
        // holdover from the pre-porch era and silently resurrected
        // tuwunel on installs that explicitly opted out.
        let mut cfg = base();
        cfg.enabled_transports.clear();
        cfg.validate().expect("empty enabled_transports is valid");
    }

    #[test]
    fn test_config_roundtrip_toml() {
        let raw = r#"
display_name = "loaded"
max_peers = 12
listen_port = 9000
enabled_transports = ["matrix_federation", "tunnel"]
"#;
        let cfg = ServitudeConfig::from_toml_str(raw).expect("toml should parse + validate");
        assert_eq!(cfg.display_name, "loaded");
        assert_eq!(cfg.max_peers, 12);
        assert_eq!(cfg.listen_port, 9000);
        assert_eq!(cfg.enabled_transports.len(), 2);
        assert!(cfg.enabled_transports.contains(&Transport::Tunnel));
    }

    #[test]
    fn test_config_toml_invalid_rejected() {
        let raw = r#"
display_name = ""
max_peers = 8
listen_port = 8765
"#;
        let err = ServitudeConfig::from_toml_str(raw)
            .expect_err("empty display_name should fail validation");
        assert_eq!(err, ConfigError::EmptyDisplayName);
    }

    // ---------------------------------------------------------------
    // BETA ATTACK TESTS — BT-*
    // ---------------------------------------------------------------

    #[test]
    fn test_BT_null_only_display_name_passes_validate() {
        // BT-19 [MEDIUM]: validate() uses `display_name.trim().is_empty()`
        // which rejects unicode whitespace (U+00A0, U+2000, U+3000) as
        // well as ASCII whitespace — GOOD. But it does NOT reject a
        // display name consisting only of null bytes (U+0000). A peer
        // receiving this node advertisement would see a literal null
        // string, which some downstream string handling may treat as
        // "empty" or may inject nulls into logs / UI strings.
        let cfg = ServitudeConfig {
            display_name: "\0".to_string(),
            max_peers: 8,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::MatrixFederation],
            profile: Profile::P2pOnly,
        };
        // This assertion currently PASSES — meaning validate() accepts
        // a null-only display name. That's the bug.
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn test_BT_display_name_with_control_chars_passes_validate() {
        // BT-20 [LOW]: The validator has no restriction on embedded
        // control characters. A display name like "foo\x1bbar" (ESC)
        // could smuggle terminal escape codes into operator logs or
        // console UIs that render peer names.
        let cfg = ServitudeConfig {
            display_name: "pwn\x1b[2J\x1b[Hgotcha".to_string(),
            max_peers: 8,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::MatrixFederation],
            profile: Profile::P2pOnly,
        };
        // PASSES — validator does not reject embedded ANSI escapes.
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn test_BT_pub_fields_allow_post_validate_mutation() {
        // BT-21 [LOW]: Because every ServitudeConfig field is pub, a
        // caller can construct a valid config, pass validate(), then
        // mutate display_name to "" and pass the mutated config
        // wherever it's still accepted. The handle re-validates in
        // new() so this is mitigated at construction time — but any
        // API that takes &ServitudeConfig and trusts it without
        // re-validating is vulnerable.
        //
        // Confirming mutability is present.
        let mut cfg = base();
        cfg.validate().expect("base config is valid");
        cfg.display_name = "".to_string();
        // The post-mutation config is now invalid but we still hold a
        // reference that could be trusted by downstream code.
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn test_BT_toml_negative_port_rejected_by_validate() {
        // BT-22 [LOW]: listen_port is i64 so negative numbers CAN be
        // represented. Confirm validate() rejects them via the
        // PortOutOfRange check.
        let raw = r#"
display_name = "neg-port"
max_peers = 8
listen_port = -1
"#;
        let err =
            ServitudeConfig::from_toml_str(raw).expect_err("negative port should fail validation");
        assert!(matches!(err, ConfigError::PortOutOfRange(-1)));
    }

    /// Regression: a stored config from an older build that contains
    /// `discord_bridge` (or any other removed transport variant) MUST
    /// NOT brick startup. The tolerant deserializer drops the unknown
    /// and keeps the recognized variants.
    #[test]
    fn unknown_transport_variants_are_dropped_with_warning() {
        let raw = r#"
display_name = "stale-config"
max_peers = 8
listen_port = 8765
enabled_transports = ["matrix_federation", "discord_bridge"]
"#;
        let cfg = ServitudeConfig::from_toml_str(raw)
            .expect("stored config with one stale transport variant must still parse");
        assert_eq!(cfg.enabled_transports, vec![Transport::MatrixFederation]);
    }

    /// Regression: a stored config whose ENTIRE `enabled_transports`
    /// list is unknown variants falls back to the default rather than
    /// failing validation with "at least one transport must be enabled".
    #[test]
    fn all_unknown_transport_variants_fall_back_to_default() {
        let raw = r#"
display_name = "everything-stale"
max_peers = 8
listen_port = 8765
enabled_transports = ["discord_bridge", "icq_relay"]
"#;
        let cfg = ServitudeConfig::from_toml_str(raw)
            .expect("all-unknown variants must fall back to the default");
        assert_eq!(cfg.enabled_transports, default_transports());
    }

    #[test]
    fn test_BT_toml_huge_max_peers_accepted() {
        // BT-23 [LOW]: validate() only checks max_peers > 0, not an
        // upper bound. An attacker can configure i64::MAX and cause
        // downstream code (if it allocates Vec<Peer> sized by
        // max_peers) to crash or exhaust memory.
        let raw = r#"
display_name = "huge-peers"
max_peers = 9223372036854775807
listen_port = 8765
"#;
        let cfg =
            ServitudeConfig::from_toml_str(raw).expect("huge max_peers passes validation (bug)");
        assert_eq!(cfg.max_peers, i64::MAX);
    }
}
