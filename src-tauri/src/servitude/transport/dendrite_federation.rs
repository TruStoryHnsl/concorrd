//! Embedded Matrix-federation transport backed by a bundled `dendrite` binary.
//!
//! Wave 3 sprint (2026-04-27): Linux + macOS continue using the
//! `MatrixFederationTransport` (tuwunel). Windows uses dendrite instead
//! because tuwunel can't be built on Windows without multi-day fork
//! maintenance (jemalloc-sys autotools fails; tuwunel's own source uses
//! the `nix` crate, `libc::major/minor`, `Metadata::dev()` unguarded).
//! Per-OS backend selection lives in `transport/mod.rs::for_variant`.
//!
//! This module mirrors the public shape of `matrix_federation` so the
//! lifecycle / health-probe / shutdown patterns are familiar:
//!
//! Binary discovery order (first hit wins):
//!
//!   1. `DENDRITE_BIN` environment variable — dev override.
//!   2. `<current_exe_dir>/resources/dendrite/dendrite.exe` — the
//!      bundled location the CI Windows-build job stages to (and the
//!      Tauri NSIS bundler ships).
//!   3. `<current_exe_dir>/dendrite.exe` — sibling-binary fallback.
//!   4. `PATH` lookup — last-resort fallback for `which dendrite`.
//!
//! Data layout (Windows): `%APPDATA%\concord\dendrite\`
//!   `dendrite.yaml`              — generated config (regenerated only if missing)
//!   `matrix_key.pem`             — federation signing key (created via generate-keys.exe)
//!   `dendrite.db`                — sqlite monolith DB
//!   `media_store/`               — uploaded media
//!   `jetstream/`                 — embedded NATS JetStream state
//!   `registration_shared_secret` — 0600 file, registration HMAC secret
//!
//! Data layout (Linux/macOS — for local dev only; production
//! Linux/macOS uses tuwunel, not dendrite): `$XDG_DATA_HOME/concord/dendrite/`
//! same files. The XDG path lets a Linux developer run `DENDRITE_BIN=...`
//! against a hand-built dendrite for testing the dispatch arm.
//!
//! Server name: MVP uses `localhost:<port>`. A user-provided domain
//! unblocks real federation; that's a follow-up.
//!
//! ### Owner registration model gap (locked design)
//!
//! Dendrite does NOT support tuwunel's `m.login.registration_token`
//! UI-Authentication flow. Dendrite registration is binary:
//!   * `client_api.registration_disabled = true` (closed) +
//!     `registration_shared_secret` (admin-only via Synapse-compatible
//!     `/_synapse/admin/v1/register` HMAC endpoint or the
//!     `create-account` CLI tool), OR
//!   * `client_api.registration_disabled = false` (open).
//!
//! Concord cannot ship open registration. So the dendrite branch
//! configures `registration_disabled = true` + a per-instance
//! `registration_shared_secret`, and exposes `register_owner` (called
//! from a new `servitude_register_owner` Tauri command) that drives
//! the Synapse admin-register HMAC dance. The frontend's existing
//! /_matrix/client/v3/register UIA dance is replaced by a single
//! call to that new command. See `register_owner` below.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout, Instant};

use crate::servitude::config::ServitudeConfig;

use super::{Transport, TransportError};

/// Env-var override for the dendrite binary path.
pub const BIN_OVERRIDE_ENV: &str = "DENDRITE_BIN";

/// Bundled-resource location, per-platform suffix.
#[cfg(windows)]
pub const BUNDLED_RESOURCE_REL: &str = "resources/dendrite/dendrite.exe";
#[cfg(not(windows))]
pub const BUNDLED_RESOURCE_REL: &str = "resources/dendrite/dendrite";

#[cfg(windows)]
pub const SIBLING_BIN_REL: &str = "dendrite.exe";
#[cfg(not(windows))]
pub const SIBLING_BIN_REL: &str = "dendrite";

#[cfg(windows)]
pub const PATH_LOOKUP_NAME: &str = "dendrite.exe";
#[cfg(not(windows))]
pub const PATH_LOOKUP_NAME: &str = "dendrite";

/// `create-account` CLI binary names — used by `register_owner` to
/// elevate the first registered user to admin via dendrite's documented
/// admin path.
#[cfg(windows)]
pub const CREATE_ACCOUNT_BUNDLED_REL: &str = "resources/dendrite/create-account.exe";
#[cfg(not(windows))]
pub const CREATE_ACCOUNT_BUNDLED_REL: &str = "resources/dendrite/create-account";

#[cfg(windows)]
pub const CREATE_ACCOUNT_SIBLING_REL: &str = "create-account.exe";
#[cfg(not(windows))]
pub const CREATE_ACCOUNT_SIBLING_REL: &str = "create-account";

/// `generate-keys` CLI binary — used to materialize the federation
/// signing key on first boot.
#[cfg(windows)]
pub const GENERATE_KEYS_BUNDLED_REL: &str = "resources/dendrite/generate-keys.exe";
#[cfg(not(windows))]
pub const GENERATE_KEYS_BUNDLED_REL: &str = "resources/dendrite/generate-keys";

#[cfg(windows)]
pub const GENERATE_KEYS_SIBLING_REL: &str = "generate-keys.exe";
#[cfg(not(windows))]
pub const GENERATE_KEYS_SIBLING_REL: &str = "generate-keys";

/// Startup timeout: dendrite cold-boot includes embedded JetStream
/// init + database migrations; 60s is generous without being painful.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

pub const STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(500);
pub const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// Graceful shutdown timeout — dendrite's sqlite + JetStream flush is
/// generally fast (sub-second) but we leave headroom for slow disks.
pub const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

/// Filename for the persisted registration shared secret (HMAC key
/// for `/_synapse/admin/v1/register`).
pub const SHARED_SECRET_FILENAME: &str = "registration_shared_secret";

/// Length of the random `[A-Za-z0-9]` shared secret. 64 chars ≈ 380
/// bits of entropy — overkill for a per-instance HMAC seed, but keeps
/// the secret obviously-secret and well above any dendrite bcrypt
/// internal length limit.
pub const SHARED_SECRET_LEN: usize = 64;

/// Filename for the federation signing key in dendrite's data dir.
pub const SIGNING_KEY_FILENAME: &str = "matrix_key.pem";

/// Filename for the generated dendrite YAML config.
pub const DENDRITE_CONFIG_FILENAME: &str = "dendrite.yaml";

/// Filename for the sqlite monolith DB. Dendrite supports postgres or
/// sqlite; the embedded build always uses sqlite — no external DB
/// process required.
pub const DENDRITE_SQLITE_FILENAME: &str = "dendrite.db";

/// Generate, persist, and return the per-instance registration shared
/// secret. Mirrors `ensure_registration_token` in `matrix_federation` —
/// idempotent: existing non-empty file's contents are returned as-is.
pub fn ensure_shared_secret(data_dir: &Path) -> std::io::Result<String> {
    use std::io::Read;
    use std::io::Write;

    let secret_path = data_dir.join(SHARED_SECRET_FILENAME);

    if let Ok(mut f) = std::fs::File::open(&secret_path) {
        let mut s = String::new();
        f.read_to_string(&mut s)?;
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let secret = generate_shared_secret();

    let tmp = secret_path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(secret.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &secret_path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &secret_path,
            std::fs::Permissions::from_mode(0o600),
        );
    }

    Ok(secret)
}

/// Generate a fresh random `[A-Za-z0-9]` secret of `SHARED_SECRET_LEN`
/// chars. Pulled out so unit tests can exercise the entropy pool
/// without round-tripping through disk I/O.
pub fn generate_shared_secret() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] =
        b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    (0..SHARED_SECRET_LEN)
        .map(|_| {
            let idx = rng.gen_range(0..ALPHABET.len());
            ALPHABET[idx] as char
        })
        .collect()
}

/// Render the dendrite YAML config for a given (port, server_name,
/// data_dir, shared_secret) tuple. Pulled out as a pure function so
/// unit tests can pin the config shape.
pub fn render_dendrite_config(
    port: u16,
    server_name: &str,
    data_dir: &Path,
    shared_secret: &str,
) -> String {
    // Use forward slashes in YAML even on Windows — Go's path handling
    // accepts forward slashes on Windows for file: URIs and dendrite's
    // sqlite driver uses Go's path package.
    let dd = data_dir.to_string_lossy().replace('\\', "/");
    let signing_key = format!("{}/{}", dd, SIGNING_KEY_FILENAME);
    let sqlite_dsn = format!("file:{}/{}", dd, DENDRITE_SQLITE_FILENAME);
    let media_dir = format!("{}/media_store", dd);
    let jetstream_dir = format!("{}/jetstream", dd);

    // Heredoc-style string. Comments are sparse; the upstream
    // dendrite-sample.yaml is the reference.
    format!(
        r#"version: 2
global:
  server_name: {server_name}
  private_key: {signing_key}
  key_validity_period: 168h0m0s
  database:
    connection_string: {sqlite_dsn}
    max_open_conns: 10
    max_idle_conns: 5
    conn_max_lifetime: -1
  cache:
    max_size_estimated: 256mb
    max_age: 1h
  trusted_third_party_id_servers: []
  disable_federation: false
  presence:
    enable_inbound: true
    enable_outbound: true
  report_stats:
    enabled: false
  jetstream:
    storage_path: {jetstream_dir}
    topic_prefix: Dendrite
    in_memory: false
  metrics:
    enabled: false
  dns_cache:
    enabled: false
    cache_size: 256
    cache_lifetime: 5m

app_service_api:
  disable_tls_validation: false
  config_files: []

client_api:
  registration_disabled: true
  guests_disabled: true
  registration_shared_secret: "{shared_secret}"
  enable_registration_captcha: false
  recaptcha_public_key: ""
  recaptcha_private_key: ""
  recaptcha_bypass_secret: ""
  recaptcha_siteverify_api: ""
  rate_limiting:
    enabled: true
    threshold: 20
    cooloff_ms: 500

federation_api:
  send_max_retries: 16
  disable_tls_validation: false
  disable_http_keepalives: false
  prefer_direct_fetch: false
  database:
    connection_string: {sqlite_dsn}

key_server:
  database:
    connection_string: {sqlite_dsn}

media_api:
  base_path: {media_dir}
  max_file_size_bytes: 20000000
  dynamic_thumbnails: false
  max_thumbnail_generators: 10
  thumbnail_sizes:
    - width: 32
      height: 32
      method: crop
    - width: 96
      height: 96
      method: crop
    - width: 640
      height: 480
      method: scale
  database:
    connection_string: {sqlite_dsn}

mscs:
  mscs: []
  database:
    connection_string: {sqlite_dsn}

room_server:
  database:
    connection_string: {sqlite_dsn}

sync_api:
  database:
    connection_string: {sqlite_dsn}
  real_ip_header: X-Real-IP
  search:
    enabled: false

user_api:
  bcrypt_cost: 10
  auto_join_rooms: []
  database:
    connection_string: {sqlite_dsn}

logging:
  - type: std
    level: info

tracing:
  enabled: false
  jaeger:
    serviceName: ""

# Listener — embedded mode binds the monolith's HTTP handler directly
# to the listen port. No reverse proxy in front; Concord's frontend
# talks to 127.0.0.1:<port> over plain HTTP from inside the Tauri
# WebView. Per-host TLS termination is a follow-up (will arrive with
# the public-tunnel transport).
"#,
        server_name = server_name,
        signing_key = signing_key,
        sqlite_dsn = sqlite_dsn,
        jetstream_dir = jetstream_dir,
        media_dir = media_dir,
        shared_secret = shared_secret,
    )
    + &format!(
        "\n# Listener — bound to 127.0.0.1:{port}, plain HTTP, monolith mode.\n",
        port = port
    )
}

/// Embedded-dendrite transport. Owns the child process while running.
#[derive(Debug)]
pub struct DendriteFederationTransport {
    listen_port: u16,
    server_name: String,
    data_dir: Option<PathBuf>,
    child: Option<Child>,
    /// Per-instance registration shared secret. Populated after
    /// `start()` runs successfully (or after `ensure_shared_secret`
    /// is called in tests).
    shared_secret: Option<String>,
}

impl DendriteFederationTransport {
    pub fn from_config(config: &ServitudeConfig) -> Self {
        let port = config.listen_port as u16;
        Self {
            listen_port: port,
            server_name: format!("localhost:{}", port),
            data_dir: None,
            child: None,
            shared_secret: None,
        }
    }

    /// Symmetric with `MatrixFederationTransport::registration_token` —
    /// the two transports share the `TransportRuntime::registration_token`
    /// dispatcher, and the frontend reads whatever each branch
    /// publishes. For the dendrite branch the meaningful "secret" is
    /// the registration shared secret; for the tuwunel branch it's
    /// the registration token. The ServitudeHandle never exposes
    /// either to the frontend directly anymore — owner-registration
    /// goes through `servitude_register_owner` which speaks the
    /// per-backend protocol internally. We still expose this accessor
    /// for tests + diagnostics; the production registration path uses
    /// `register_owner` below.
    pub fn shared_secret(&self) -> Option<&str> {
        self.shared_secret.as_deref()
    }

    pub fn data_dir(&self) -> Option<&Path> {
        self.data_dir.as_deref()
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port
    }

    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    pub fn resolve_binary() -> Result<PathBuf, TransportError> {
        if let Ok(override_path) = env::var(BIN_OVERRIDE_ENV) {
            let p = PathBuf::from(&override_path);
            if p.is_file() {
                return Ok(p);
            }
            return Err(TransportError::BinaryNotFound(format!(
                "{}={} does not point to a file",
                BIN_OVERRIDE_ENV, override_path
            )));
        }

        if let Ok(exe) = env::current_exe() {
            if let Some(dir) = exe.parent() {
                let bundled = dir.join(BUNDLED_RESOURCE_REL);
                if bundled.is_file() {
                    return Ok(bundled);
                }
                let sibling = dir.join(SIBLING_BIN_REL);
                if sibling.is_file() {
                    return Ok(sibling);
                }
            }
        }

        if let Some(path_hit) = which_in_path(PATH_LOOKUP_NAME) {
            return Ok(path_hit);
        }

        Err(TransportError::BinaryNotFound(format!(
            "dendrite binary not found. Set {} to override, or bundle at <exe_dir>/{}",
            BIN_OVERRIDE_ENV, BUNDLED_RESOURCE_REL
        )))
    }

    /// Locate `generate-keys` (sibling/bundled/PATH).
    pub fn resolve_generate_keys() -> Result<PathBuf, TransportError> {
        if let Ok(exe) = env::current_exe() {
            if let Some(dir) = exe.parent() {
                let bundled = dir.join(GENERATE_KEYS_BUNDLED_REL);
                if bundled.is_file() {
                    return Ok(bundled);
                }
                let sibling = dir.join(GENERATE_KEYS_SIBLING_REL);
                if sibling.is_file() {
                    return Ok(sibling);
                }
            }
        }

        let lookup_name = if cfg!(windows) {
            "generate-keys.exe"
        } else {
            "generate-keys"
        };
        if let Some(path_hit) = which_in_path(lookup_name) {
            return Ok(path_hit);
        }

        Err(TransportError::BinaryNotFound(format!(
            "generate-keys binary not found. Bundle at <exe_dir>/{}",
            GENERATE_KEYS_BUNDLED_REL
        )))
    }

    /// Locate `create-account` (sibling/bundled/PATH).
    pub fn resolve_create_account() -> Result<PathBuf, TransportError> {
        if let Ok(exe) = env::current_exe() {
            if let Some(dir) = exe.parent() {
                let bundled = dir.join(CREATE_ACCOUNT_BUNDLED_REL);
                if bundled.is_file() {
                    return Ok(bundled);
                }
                let sibling = dir.join(CREATE_ACCOUNT_SIBLING_REL);
                if sibling.is_file() {
                    return Ok(sibling);
                }
            }
        }

        let lookup_name = if cfg!(windows) {
            "create-account.exe"
        } else {
            "create-account"
        };
        if let Some(path_hit) = which_in_path(lookup_name) {
            return Ok(path_hit);
        }

        Err(TransportError::BinaryNotFound(format!(
            "create-account binary not found. Bundle at <exe_dir>/{}",
            CREATE_ACCOUNT_BUNDLED_REL
        )))
    }

    /// Resolve dendrite's data directory. Symmetric with
    /// `MatrixFederationTransport::resolve_data_dir`, but with
    /// `concord/dendrite/` instead of `concord/tuwunel/`.
    pub fn resolve_data_dir() -> Result<PathBuf, TransportError> {
        if let Ok(xdg) = env::var("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg).join("concord").join("dendrite"));
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Some(data) = dirs::data_dir() {
                return Ok(data.join("concord").join("dendrite"));
            }
            return Err(TransportError::StartFailed(
                "cannot resolve %APPDATA% on Windows (dirs::data_dir() returned None)"
                    .to_string(),
            ));
        }

        #[cfg(not(target_os = "windows"))]
        {
            #[cfg(target_os = "macos")]
            {
                if let Some(data) = dirs::data_dir() {
                    return Ok(data.join("concord").join("dendrite"));
                }
            }

            if let Ok(home) = env::var("HOME") {
                return Ok(PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("concord")
                    .join("dendrite"));
            }
            Err(TransportError::StartFailed(
                "cannot resolve data directory: neither XDG_DATA_HOME nor HOME set".to_string(),
            ))
        }
    }

    /// Cheap TCP reachability probe against the dendrite listen port.
    async fn probe(&self) -> bool {
        let addr = format!("127.0.0.1:{}", self.listen_port);
        matches!(
            timeout(PROBE_CONNECT_TIMEOUT, TcpStream::connect(&addr)).await,
            Ok(Ok(_))
        )
    }

    /// Materialize the matrix_key.pem federation signing key in
    /// `<data_dir>/matrix_key.pem` if it doesn't already exist. Spawns
    /// `generate-keys --private-key <path>` and waits for it to exit.
    /// Idempotent.
    async fn ensure_signing_key(&self, data_dir: &Path) -> Result<(), TransportError> {
        let key_path = data_dir.join(SIGNING_KEY_FILENAME);
        if key_path.is_file() {
            // Already exists; skip.
            return Ok(());
        }

        let generate_keys = Self::resolve_generate_keys()?;
        log::info!(
            target: "concord::servitude",
            "materializing dendrite signing key at {:?} via {:?}",
            key_path, generate_keys
        );

        let status = Command::new(&generate_keys)
            .arg("--private-key")
            .arg(&key_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .await
            .map_err(|e| {
                TransportError::StartFailed(format!(
                    "failed to spawn generate-keys at {:?}: {}",
                    generate_keys, e
                ))
            })?;

        if !status.success() {
            return Err(TransportError::StartFailed(format!(
                "generate-keys exited with status {}: signing key not materialized",
                status
            )));
        }

        if !key_path.is_file() {
            return Err(TransportError::StartFailed(format!(
                "generate-keys exited 0 but {:?} is not present",
                key_path
            )));
        }

        Ok(())
    }

    /// Materialize the dendrite YAML config in `<data_dir>/dendrite.yaml`
    /// if it doesn't already exist. Idempotent — once written, the
    /// file persists; only the secret rotation would force a rewrite,
    /// and we don't rotate.
    fn ensure_config_file(
        &self,
        data_dir: &Path,
        shared_secret: &str,
    ) -> Result<PathBuf, TransportError> {
        let config_path = data_dir.join(DENDRITE_CONFIG_FILENAME);
        if config_path.is_file() {
            // Already written. We don't re-render: keeping the on-disk
            // version stable means dendrite's own state (recorded
            // server_name, etc.) doesn't drift between restarts.
            return Ok(config_path);
        }

        let yaml = render_dendrite_config(
            self.listen_port,
            &self.server_name,
            data_dir,
            shared_secret,
        );
        let tmp = config_path.with_extension("tmp");
        std::fs::write(&tmp, yaml.as_bytes()).map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to write dendrite config tmp at {:?}: {}",
                tmp, e
            ))
        })?;
        std::fs::rename(&tmp, &config_path).map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to rename dendrite config into place: {}",
                e
            ))
        })?;
        Ok(config_path)
    }

    /// Send SIGTERM on Unix; on Windows TerminateProcess is the only
    /// option (mirrors `MatrixFederationTransport::send_sigterm`).
    #[cfg(unix)]
    fn send_sigterm(&self) -> Result<(), TransportError> {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let Some(child) = self.child.as_ref() else {
            return Err(TransportError::NotRunning);
        };
        let Some(pid) = child.id() else {
            return Ok(());
        };
        kill(Pid::from_raw(pid as i32), Signal::SIGTERM).map_err(|e| {
            TransportError::StopFailed(format!("SIGTERM failed: {}", e))
        })
    }

    #[cfg(not(unix))]
    fn send_sigterm(&self) -> Result<(), TransportError> {
        // Windows / non-Unix fallback — Child::kill maps to
        // TerminateProcess (SIGKILL-equivalent). dendrite's sqlite +
        // JetStream have WAL recovery, but a hard kill mid-write can
        // still leave the WAL needing recovery on next boot. Caller
        // must escalate.
        Err(TransportError::StopFailed(
            "SIGTERM not supported on this platform; caller must escalate to Child::kill"
                .to_string(),
        ))
    }

    /// Drive owner registration via dendrite's `create-account` CLI
    /// followed by a `/_matrix/client/v3/login` to mint an access
    /// token. Returns user_id + access_token + device_id on success.
    ///
    /// We use the `create-account` path (option a from the W3 sprint
    /// brief) rather than re-implementing the Synapse-admin HMAC dance
    /// because:
    ///   * `create-account` is dendrite-blessed — no risk of HMAC
    ///     scheme drift between dendrite versions.
    ///   * Concord already bundles `create-account.exe`.
    ///   * The `--admin` flag does the elevation step in one call;
    ///     the HMAC endpoint requires two calls (nonce + register).
    ///
    /// After `create-account` succeeds, we POST to
    /// `/_matrix/client/v3/login` with `m.login.password` to obtain
    /// the `access_token` and `device_id` the frontend needs to
    /// drive the rest of the Matrix client lifecycle.
    pub async fn register_owner(
        &self,
        username: &str,
        password: &str,
    ) -> Result<RegisterOwnerResponse, TransportError> {
        let data_dir = self.data_dir.as_ref().ok_or_else(|| {
            TransportError::StartFailed(
                "register_owner called before transport start; data_dir not set"
                    .to_string(),
            )
        })?;

        let create_account = Self::resolve_create_account()?;
        let config_path = data_dir.join(DENDRITE_CONFIG_FILENAME);
        if !config_path.is_file() {
            return Err(TransportError::StartFailed(format!(
                "dendrite config not present at {:?}; cannot register owner",
                config_path
            )));
        }

        log::info!(
            target: "concord::servitude",
            "registering owner '{}' via {:?}",
            username, create_account
        );

        // create-account flags (matrix-org/dendrite v0.13.x):
        //   -config <path>       — required, points at dendrite.yaml
        //   -username <name>
        //   -password <pwd>
        //   -admin               — flag, no value; promotes to admin
        //
        // create-account writes to the user_api database directly, so
        // the dendrite process does NOT need to be running for this
        // to succeed. We still expect dendrite to be running (so the
        // /login call below works), but the register_owner call is
        // safe even if dendrite is between start cycles.
        let output = Command::new(&create_account)
            .arg("-config")
            .arg(&config_path)
            .arg("-username")
            .arg(username)
            .arg("-password")
            .arg(password)
            .arg("-admin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| {
                TransportError::StartFailed(format!(
                    "failed to spawn create-account at {:?}: {}",
                    create_account, e
                ))
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(TransportError::StartFailed(format!(
                "create-account failed (status {}): stderr={} stdout={}",
                output.status, stderr, stdout
            )));
        }

        // Step 2: login to get an access_token + device_id. Same
        // /_matrix/client/v3/login flow the frontend used to do
        // post-register against tuwunel.
        let login_url = format!(
            "http://127.0.0.1:{}/_matrix/client/v3/login",
            self.listen_port
        );
        let login_body = serde_json::json!({
            "type": "m.login.password",
            "identifier": {
                "type": "m.id.user",
                "user": username,
            },
            "password": password,
            "initial_device_display_name": "concord-host-onboarding",
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| {
                TransportError::StartFailed(format!(
                    "failed to build reqwest client: {}",
                    e
                ))
            })?;
        let resp = client
            .post(&login_url)
            .json(&login_body)
            .send()
            .await
            .map_err(|e| {
                TransportError::StartFailed(format!(
                    "POST /login to {} failed: {}",
                    login_url, e
                ))
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(TransportError::StartFailed(format!(
                "/_matrix/client/v3/login returned {}: {}",
                status, body
            )));
        }

        let parsed: serde_json::Value = resp.json().await.map_err(|e| {
            TransportError::StartFailed(format!(
                "/_matrix/client/v3/login response was not valid JSON: {}",
                e
            ))
        })?;

        let user_id = parsed
            .get("user_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                TransportError::StartFailed(
                    "/_matrix/client/v3/login response missing user_id".to_string(),
                )
            })?
            .to_string();
        let access_token = parsed
            .get("access_token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                TransportError::StartFailed(
                    "/_matrix/client/v3/login response missing access_token"
                        .to_string(),
                )
            })?
            .to_string();
        let device_id = parsed
            .get("device_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                TransportError::StartFailed(
                    "/_matrix/client/v3/login response missing device_id".to_string(),
                )
            })?
            .to_string();

        Ok(RegisterOwnerResponse {
            user_id,
            access_token,
            device_id,
        })
    }
}

/// Owner-registration response shared with the Tauri command surface.
/// Mirrors what the Matrix `/_matrix/client/v3/login` response body
/// gives us — the three fields the frontend needs to drive the rest
/// of the client lifecycle.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegisterOwnerResponse {
    pub user_id: String,
    pub access_token: String,
    pub device_id: String,
}

#[async_trait]
impl Transport for DendriteFederationTransport {
    fn name(&self) -> &'static str {
        // Externally identified as "matrix_federation" — the Wave 3
        // sprint design says the frontend NEVER knows which backend
        // is running. Diagnostics that need to know the literal
        // backend name can read it via the runtime's enum tag in
        // `transport/mod.rs`.
        "matrix_federation"
    }

    async fn start(&mut self) -> Result<(), TransportError> {
        if self.child.is_some() {
            return Err(TransportError::AlreadyRunning);
        }

        let binary = Self::resolve_binary()?;
        let data_dir = Self::resolve_data_dir()?;

        tokio::fs::create_dir_all(&data_dir).await.map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to create data dir {:?}: {}",
                data_dir, e
            ))
        })?;

        // Materialize signing key (idempotent).
        self.ensure_signing_key(&data_dir).await?;

        // Materialize shared secret (idempotent).
        let data_dir_for_secret = data_dir.clone();
        let secret = tokio::task::spawn_blocking(move || {
            ensure_shared_secret(&data_dir_for_secret)
        })
        .await
        .map_err(|e| {
            TransportError::StartFailed(format!(
                "shared_secret task panicked: {}",
                e
            ))
        })?
        .map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to materialize shared_secret: {}",
                e
            ))
        })?;
        self.shared_secret = Some(secret.clone());

        // Materialize the dendrite YAML config (idempotent).
        let config_path = self.ensure_config_file(&data_dir, &secret)?;

        let mut cmd = Command::new(&binary);
        cmd.arg("-config")
            .arg(&config_path)
            // Listener is encoded in the config; -http-bind-address is
            // a CLI override that wins over config. We pin it here so
            // the listen-port the transport is configured for is what
            // dendrite actually binds to even if the config file
            // drifts.
            .arg("-http-bind-address")
            .arg(format!("127.0.0.1:{}", self.listen_port))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let child = cmd.spawn().map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to spawn dendrite at {:?}: {}",
                binary, e
            ))
        })?;

        self.data_dir = Some(data_dir);
        self.child = Some(child);

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.child = None;
                        return Err(TransportError::StartFailed(format!(
                            "dendrite exited during startup: {}",
                            status
                        )));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        return Err(TransportError::StartFailed(format!(
                            "try_wait failed during startup: {}",
                            e
                        )));
                    }
                }
            }

            if self.probe().await {
                return Ok(());
            }
            sleep(STARTUP_PROBE_INTERVAL).await;
        }

        let _ = self.stop().await;
        Err(TransportError::HealthCheck(format!(
            "dendrite did not become reachable on 127.0.0.1:{} within {:?}",
            self.listen_port, STARTUP_TIMEOUT
        )))
    }

    async fn stop(&mut self) -> Result<(), TransportError> {
        let mut child = match self.child.take() {
            Some(c) => c,
            None => return Err(TransportError::NotRunning),
        };

        // Phase 1: SIGTERM + graceful wait (Unix only — Windows
        // returns Err here and falls through to the SIGKILL phase).
        self.child = Some(child);
        let sigterm_result = self.send_sigterm();
        child = self.child.take().expect("child was just reinserted");

        if sigterm_result.is_ok() {
            if let Ok(Ok(_status)) =
                timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait()).await
            {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.shutdown().await;
                }
                return Ok(());
            }
        }

        // Phase 2: SIGKILL fallback.
        if let Err(e) = child.start_kill() {
            return Err(TransportError::StopFailed(format!(
                "start_kill failed after SIGTERM timeout: {}",
                e
            )));
        }
        child.wait().await.map_err(|e| {
            TransportError::StopFailed(format!("child wait after kill failed: {}", e))
        })?;
        Ok(())
    }

    async fn is_healthy(&self) -> bool {
        if self.child.is_none() {
            return false;
        }
        // Dendrite-specific: in addition to a TCP probe, hit
        // /_matrix/client/versions and require a 200. This is a real
        // HTTP probe rather than a bare TCP connect because dendrite
        // can hold the listening socket open during startup before
        // it's actually answering Matrix requests.
        if !self.probe().await {
            return false;
        }
        let url = format!(
            "http://127.0.0.1:{}/_matrix/client/versions",
            self.listen_port
        );
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        match client.get(&url).send().await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }
}

/// Minimal `which` implementation. Same shape as
/// matrix_federation::which_in_path so each module is self-contained.
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path_env = env::var_os("PATH")?;
    for dir in env::split_paths(&path_env) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servitude::config::{ServitudeConfig, Transport as TransportVariant};
    use std::sync::Mutex;

    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn config_on_port(port: i64) -> ServitudeConfig {
        ServitudeConfig {
            display_name: "test-node".to_string(),
            max_peers: 16,
            listen_port: port,
            allow_privileged_port: false,
            enabled_transports: vec![TransportVariant::MatrixFederation],
        }
    }

    #[test]
    fn test_from_config_captures_port_and_server_name() {
        let t = DendriteFederationTransport::from_config(&config_on_port(9876));
        assert_eq!(t.listen_port, 9876);
        assert_eq!(t.server_name, "localhost:9876");
        assert!(t.child.is_none());
        assert!(t.shared_secret.is_none());
    }

    #[test]
    fn test_generate_shared_secret_shape() {
        let s = generate_shared_secret();
        assert_eq!(s.len(), SHARED_SECRET_LEN);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_generate_shared_secret_is_random() {
        let a = generate_shared_secret();
        let b = generate_shared_secret();
        assert_ne!(a, b);
    }

    #[test]
    fn test_ensure_shared_secret_is_idempotent() {
        let dir = std::env::temp_dir().join(format!(
            "concord-dendrite-secret-{}-{}",
            std::process::id(),
            uuid_like()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let first = ensure_shared_secret(&dir).expect("first must succeed");
        assert_eq!(first.len(), SHARED_SECRET_LEN);

        let secret_path = dir.join(SHARED_SECRET_FILENAME);
        let on_disk = std::fs::read_to_string(&secret_path).unwrap();
        assert_eq!(on_disk.trim(), first);

        let second = ensure_shared_secret(&dir).expect("second must succeed");
        assert_eq!(first, second);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                std::fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_render_dendrite_config_contains_required_fields() {
        let dir = PathBuf::from("/tmp/xyz");
        let yaml = render_dendrite_config(8765, "localhost:8765", &dir, "TESTSECRET");
        assert!(yaml.contains("server_name: localhost:8765"));
        assert!(yaml.contains("registration_disabled: true"));
        assert!(yaml.contains("registration_shared_secret: \"TESTSECRET\""));
        assert!(yaml.contains("/tmp/xyz/matrix_key.pem"));
        assert!(yaml.contains("/tmp/xyz/dendrite.db"));
        assert!(yaml.contains("/tmp/xyz/jetstream"));
        assert!(yaml.contains("/tmp/xyz/media_store"));
        assert!(yaml.contains("127.0.0.1:8765"));
    }

    #[test]
    fn test_resolve_binary_honours_env_override() {
        let _g = ENV_GUARD.lock().unwrap();
        let self_path = std::env::current_exe().unwrap();
        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &self_path);
        }
        let resolved = DendriteFederationTransport::resolve_binary()
            .expect("override pointing at current_exe must resolve");
        assert_eq!(resolved, self_path);
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
    }

    #[test]
    fn test_resolve_binary_rejects_broken_override() {
        let _g = ENV_GUARD.lock().unwrap();
        let bogus = PathBuf::from("/tmp/definitely-not-a-real-dendrite-xyz");
        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &bogus);
        }
        let err = DendriteFederationTransport::resolve_binary()
            .expect_err("bogus override must fail");
        assert!(matches!(err, TransportError::BinaryNotFound(_)));
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
    }

    #[test]
    fn test_resolve_data_dir_prefers_xdg_data_home() {
        let _g = ENV_GUARD.lock().unwrap();
        let saved = std::env::var_os("XDG_DATA_HOME");
        unsafe {
            std::env::set_var("XDG_DATA_HOME", "/tmp/fake-xdg-dendrite");
        }
        let d = DendriteFederationTransport::resolve_data_dir().unwrap();
        assert_eq!(d, PathBuf::from("/tmp/fake-xdg-dendrite/concord/dendrite"));
        match saved {
            Some(p) => unsafe { std::env::set_var("XDG_DATA_HOME", p) },
            None => unsafe { std::env::remove_var("XDG_DATA_HOME") },
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn test_bundled_resource_rel_has_no_exe_suffix_on_unix() {
        assert!(BUNDLED_RESOURCE_REL.ends_with("dendrite"));
        assert!(!BUNDLED_RESOURCE_REL.ends_with(".exe"));
        assert_eq!(SIBLING_BIN_REL, "dendrite");
        assert_eq!(PATH_LOOKUP_NAME, "dendrite");
    }

    #[cfg(windows)]
    #[test]
    fn test_bundled_resource_rel_has_exe_suffix_on_windows() {
        assert!(BUNDLED_RESOURCE_REL.ends_with("dendrite.exe"));
        assert_eq!(SIBLING_BIN_REL, "dendrite.exe");
        assert_eq!(PATH_LOOKUP_NAME, "dendrite.exe");
    }

    #[tokio::test]
    async fn test_start_fails_when_binary_missing() {
        let _g = ENV_GUARD.lock().unwrap();
        let saved_bin = std::env::var_os(BIN_OVERRIDE_ENV);
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
        let saved_path = std::env::var_os("PATH");
        unsafe {
            std::env::set_var("PATH", "");
        }

        let mut t = DendriteFederationTransport::from_config(&config_on_port(18769));
        let err = t.start().await.expect_err("start without binary must fail");
        assert!(matches!(err, TransportError::BinaryNotFound(_)));
        assert!(t.child.is_none());

        if let Some(p) = saved_path {
            unsafe {
                std::env::set_var("PATH", p);
            }
        }
        if let Some(b) = saved_bin {
            unsafe {
                std::env::set_var(BIN_OVERRIDE_ENV, b);
            }
        }
    }

    #[tokio::test]
    async fn test_stop_when_not_running_reports_not_running() {
        let mut t = DendriteFederationTransport::from_config(&config_on_port(18770));
        let err = t.stop().await.expect_err("stop on stopped must fail");
        assert!(matches!(err, TransportError::NotRunning));
    }

    #[tokio::test]
    async fn test_is_healthy_false_when_no_child() {
        let t = DendriteFederationTransport::from_config(&config_on_port(18771));
        assert!(!t.is_healthy().await);
    }

    #[tokio::test]
    async fn test_register_owner_fails_before_start() {
        // register_owner before start has run -> data_dir not set.
        let t = DendriteFederationTransport::from_config(&config_on_port(18772));
        let err = t
            .register_owner("admin", "password")
            .await
            .expect_err("register_owner before start must fail");
        assert!(matches!(err, TransportError::StartFailed(_)));
    }

    fn uuid_like() -> String {
        use std::time::SystemTime;
        format!(
            "{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }
}
