//! Embedded Matrix-federation transport backed by a bundled tuwunel binary.
//!
//! This is the first real transport wired into the servitude lifecycle
//! (INS-022 Wave 2, 2026-04-08). The implementation follows the PLAN.md
//! INS-023 "bundled child process" pathway explicitly permitted by the
//! desktop-embedded-server directive — tuwunel runs as a subprocess of
//! the Concord Tauri shell, not as a linked Rust library. This avoids
//! the rust-rocksdb / jemalloc / aws-lc-rs fork maintenance that full
//! in-process embedding would require, at the cost of some extra disk
//! usage and a child-process lifecycle to babysit.
//!
//! Binary discovery order (first hit wins):
//!
//!   1. `TUWUNEL_BIN` environment variable — dev override for running
//!      against a locally-built or hand-installed tuwunel.
//!   2. `<current_exe_dir>/resources/tuwunel/tuwunel` — the bundled
//!      location the Linux build script writes to.
//!   3. `<current_exe_dir>/tuwunel` — the "sibling binary" layout some
//!      bundlers prefer.
//!   4. `PATH` lookup — last-resort fallback for `which tuwunel`.
//!
//! Data layout on Linux:
//!
//!   `$XDG_DATA_HOME/concord/tuwunel/` (defaults to
//!   `~/.local/share/concord/tuwunel/`)
//!       `database/` — RocksDB state, owned by the child process
//!       `logs/` — captured stdout/stderr streams
//!
//! Server name: the MVP uses a loopback-only server name of the form
//! `localhost:<port>`. This is a valid Matrix server name per the
//! server-name grammar (`host [ ":" port ]`) and is sufficient for
//! self-test against the local tuwunel instance. Federating with
//! external peers will require a user-provided domain — that's a
//! follow-up (see TODO below).

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

/// Name of the env-var override for the tuwunel binary path. Lets
/// developers run against a hand-built tuwunel without rebuilding the
/// Concord installer.
pub const BIN_OVERRIDE_ENV: &str = "TUWUNEL_BIN";

/// Relative path inside the Tauri resources directory where the build
/// scripts drop the bundled tuwunel binary. The Windows variant carries
/// the `.exe` suffix so the MSI/NSIS bundler picks up a Windows PE32+
/// binary; non-Windows platforms use the bare name. Both Linux/macOS
/// builds (`scripts/build_linux_native.sh`, `scripts/build_macos_native.sh`)
/// and the Windows CI workflow (`.github/workflows/windows-build.yml`)
/// stage at this exact path so `tauri.conf.json`'s
/// `bundle.resources: ["resources/tuwunel/**/*"]` glob includes the
/// correct file.
#[cfg(windows)]
pub const BUNDLED_RESOURCE_REL: &str = "resources/tuwunel/tuwunel.exe";
#[cfg(not(windows))]
pub const BUNDLED_RESOURCE_REL: &str = "resources/tuwunel/tuwunel";

/// Sibling-binary fallback path — some bundlers extract the binary
/// directly next to the main executable. Same `.exe` rules apply.
#[cfg(windows)]
pub const SIBLING_BIN_REL: &str = "tuwunel.exe";
#[cfg(not(windows))]
pub const SIBLING_BIN_REL: &str = "tuwunel";

/// Bare name used for the `which`-style `PATH` lookup. The Rust
/// stdlib's `Path::is_file()` resolves Windows PE binaries by full
/// name only; PATHEXT-style implicit `.exe` resolution is a shell
/// behavior, not a syscall behavior. So we match the on-disk filename
/// directly per platform.
#[cfg(windows)]
pub const PATH_LOOKUP_NAME: &str = "tuwunel.exe";
#[cfg(not(windows))]
pub const PATH_LOOKUP_NAME: &str = "tuwunel";

/// How long to wait for the child process to become healthy after
/// spawn before giving up and marking the start as failed.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Interval between health probes during the startup wait loop.
pub const STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(500);

/// Timeout for an individual TCP health probe.
pub const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// How long to wait after sending SIGTERM before escalating to SIGKILL.
/// Tuwunel's RocksDB shutdown can take a few seconds on a warm cache;
/// 10 seconds is generous without being painful.
pub const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

/// Filename inside the data dir where the per-instance registration
/// token is persisted. Mode 0600 on Unix; default ACL on Windows
/// (only the owner user has full access by default in %APPDATA%).
pub const REGISTRATION_TOKEN_FILENAME: &str = "registration_token";

/// Length of the random ASCII registration token. 32 characters of
/// `[A-Za-z0-9]` carries roughly 190 bits of entropy — overkill for
/// a per-instance shared secret that gates account creation against
/// localhost, but cheap to produce and forces the token into the
/// "obviously-secret" length category visually.
pub const REGISTRATION_TOKEN_LEN: usize = 32;

/// Generate, persist, and return the embedded tuwunel's registration
/// token. The token is a random 32-char `[A-Za-z0-9]` string written
/// to `<data_dir>/registration_token`. If the file already exists and
/// is non-empty, its contents are returned verbatim — making this
/// function idempotent across servitude restarts so existing
/// in-flight invites stay valid.
///
/// Per the W2 sprint design (CRITICAL DESIGN DECISIONS #11): the
/// embedded tuwunel runs with `allow_registration=true` AND
/// `registration_token=<this>` so registration is OPEN structurally
/// but requires possession of the token (the Matrix
/// `m.login.registration_token` UI-Authentication flow). The Host
/// onboarding flow on the frontend reads this token via the
/// `servitude_get_registration_token` Tauri command, uses it to
/// register the owner account on first boot, then keeps it on hand
/// so the owner can issue invite links to subsequent users.
///
/// **Empirical basis** (verified against
/// https://matrix-construct.github.io/tuwunel/configuration/examples.html
/// on 2026-04-27):
///
/// > `registration_token` — A static registration token that new users
/// > will have to provide when creating an account.
/// >
/// > `allow_registration` — Enables registration. If set to false, no
/// > users can register on this server.
///
/// Tuwunel inherits Conduwuit's env-var prefix; `TUWUNEL_*` and
/// `CONDUWUIT_*` are both accepted. We use `CONDUWUIT_*` to match the
/// existing keys in this file.
pub fn ensure_registration_token(data_dir: &Path) -> std::io::Result<String> {
    use std::io::Read;
    use std::io::Write;
    let token_path = data_dir.join(REGISTRATION_TOKEN_FILENAME);

    // Idempotent: if the file already exists with a non-empty value,
    // return it. This means a tuwunel restart picks up the same
    // token, and any registration token the user has already shared
    // with friends keeps working.
    if let Ok(mut f) = std::fs::File::open(&token_path) {
        let mut s = String::new();
        f.read_to_string(&mut s)?;
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
        // Fall through: empty file means we never finished writing.
    }

    let token = generate_registration_token();

    // Write atomically: write to <name>.tmp then rename, so a crash
    // mid-write doesn't leave a partial file that the idempotent
    // read above would mistake for a real token.
    let tmp = token_path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(token.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &token_path)?;

    // Best-effort 0600 on Unix. Failure here is non-fatal — the
    // file lands somewhere only the user account has read access
    // to anyway (XDG_DATA_HOME is per-user; %APPDATA% likewise).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &token_path,
            std::fs::Permissions::from_mode(0o600),
        );
    }

    Ok(token)
}

/// Generate a random `[A-Za-z0-9]` token of REGISTRATION_TOKEN_LEN
/// characters. Pulled out of `ensure_registration_token` so unit tests
/// can characterise the entropy pool without round-tripping through
/// disk I/O.
pub fn generate_registration_token() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] =
        b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    (0..REGISTRATION_TOKEN_LEN)
        .map(|_| {
            let idx = rng.gen_range(0..ALPHABET.len());
            ALPHABET[idx] as char
        })
        .collect()
}

/// Embedded-tuwunel transport. Owns the child process handle while
/// running; the field is `None` in the stopped state.
#[derive(Debug)]
pub struct MatrixFederationTransport {
    /// Port the child tuwunel process binds to on 127.0.0.1.
    listen_port: u16,
    /// The `CONDUWUIT_SERVER_NAME` env var value — MVP uses
    /// `localhost:<port>`.
    server_name: String,
    /// Data directory (database + logs) — lazily resolved on start.
    data_dir: Option<PathBuf>,
    /// Child process handle. `Some` while running, `None` while stopped.
    child: Option<Child>,
    /// Paths to Application Service registration YAML files that
    /// tuwunel should load on startup. Passed to tuwunel via the
    /// `CONDUWUIT_APPSERVICES` env var as a JSON array of absolute paths.
    appservice_registrations: Vec<PathBuf>,
    /// Per-instance registration token. Lazily populated on `start()`
    /// from `<data_dir>/registration_token` (created if missing).
    /// `None` until first start completes; once populated, stays
    /// populated for the lifetime of the transport handle so the
    /// frontend can read it after a successful start via
    /// `servitude_get_registration_token`. See W2-11 in the W2 sprint
    /// design.
    registration_token: Option<String>,
}

impl MatrixFederationTransport {
    /// Build a transport bound to the relevant config fields. Nothing
    /// is spawned, no filesystem paths are touched — this is purely
    /// a data-carrier constructor.
    pub fn from_config(config: &ServitudeConfig) -> Self {
        let port = config.listen_port as u16;
        Self {
            listen_port: port,
            // MVP: loopback-only identity. Replacing this with a
            // user-provided domain unblocks real federation — captured
            // as TODO(server_name) below.
            server_name: format!("localhost:{}", port),
            data_dir: None,
            child: None,
            appservice_registrations: Vec::new(),
            registration_token: None,
        }
    }

    /// The current per-instance registration token. `None` until
    /// `start()` runs successfully and populates it. The Host
    /// onboarding flow reads this via `servitude_get_registration_token`
    /// to drive the owner-account creation step.
    pub fn registration_token(&self) -> Option<&str> {
        self.registration_token.as_deref()
    }

    /// Locate the bundled tuwunel binary on disk. Returns the first hit
    /// in the discovery order documented at the top of this module, or
    /// [`TransportError::BinaryNotFound`] if nothing matches.
    pub fn resolve_binary() -> Result<PathBuf, TransportError> {
        // 1. Env-var override
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

        // 2 + 3. Paths derived from the current executable location.
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

        // 4. PATH lookup fallback. Keep this last because in production
        // we want the bundled copy, not whatever the user has globally.
        // Windows requires the `.exe` suffix in `PATH_LOOKUP_NAME`
        // because `is_file()` matches the on-disk filename verbatim;
        // PATHEXT-style implicit `.exe` is a shell behavior, not a
        // syscall behavior.
        if let Some(path_hit) = which_in_path(PATH_LOOKUP_NAME) {
            return Ok(path_hit);
        }

        Err(TransportError::BinaryNotFound(format!(
            "tuwunel binary not found. Set {} to override, or bundle at <exe_dir>/{}",
            BIN_OVERRIDE_ENV, BUNDLED_RESOURCE_REL
        )))
    }

    /// Resolve the data directory used for the embedded tuwunel's
    /// database and log files. Per-platform layout:
    ///
    /// | Platform | Path |
    /// |----------|------|
    /// | Linux    | `$XDG_DATA_HOME/concord/tuwunel/` (fallback `$HOME/.local/share/concord/tuwunel/`) |
    /// | macOS    | `~/Library/Application Support/concord/tuwunel/` |
    /// | Windows  | `%APPDATA%\concord\tuwunel\` (Roaming, via `dirs::data_dir()`) |
    ///
    /// The Linux branch keeps explicit XDG handling rather than just
    /// using `dirs::data_dir()` because XDG_DATA_HOME overrides need
    /// to win even when `dirs` would prefer ~/.local/share — that's
    /// what test fixtures (and our own `XDG_DATA_HOME` test override
    /// below) depend on. macOS/Windows have well-defined OS-level
    /// answers and `dirs::data_dir()` returns them.
    pub fn resolve_data_dir() -> Result<PathBuf, TransportError> {
        // XDG_DATA_HOME wins on every platform that sets it. This
        // intentionally runs before the Windows branch — a developer
        // running tests on Windows with XDG_DATA_HOME set (e.g.
        // because they're using Git Bash or WSL) gets the path they
        // configured, not Roaming AppData.
        if let Ok(xdg) = env::var("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg).join("concord").join("tuwunel"));
            }
        }

        // Windows: %APPDATA% (Roaming). `dirs::data_dir()` resolves
        // to FOLDERID_RoamingAppData, which is what Tauri itself uses
        // for tauri-plugin-store paths under com.concord.chat.
        // `tauri-plugin-store` writes to
        //   %APPDATA%\com.concord.chat\
        // and we put tuwunel data under
        //   %APPDATA%\concord\tuwunel\
        // — deliberately a SEPARATE root so an uninstall that wipes
        // the app's plugin-store data doesn't blow away the user's
        // tuwunel database.
        #[cfg(target_os = "windows")]
        {
            if let Some(data) = dirs::data_dir() {
                return Ok(data.join("concord").join("tuwunel"));
            }
            return Err(TransportError::StartFailed(
                "cannot resolve %APPDATA% on Windows (dirs::data_dir() returned None)"
                    .to_string(),
            ));
        }

        // Unix-likes (Linux + macOS) fall back to $HOME-based
        // resolution. macOS gets ~/Library/Application Support via
        // the dirs::data_dir() path; we keep the explicit HOME
        // resolution as a Linux-specific fallback.
        #[cfg(not(target_os = "windows"))]
        {
            #[cfg(target_os = "macos")]
            {
                if let Some(data) = dirs::data_dir() {
                    return Ok(data.join("concord").join("tuwunel"));
                }
            }

            if let Ok(home) = env::var("HOME") {
                return Ok(PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("concord")
                    .join("tuwunel"));
            }
            Err(TransportError::StartFailed(
                "cannot resolve data directory: neither XDG_DATA_HOME nor HOME set".to_string(),
            ))
        }
    }

    /// Register an Application Service registration YAML file that
    /// tuwunel should load on startup. Called by the cross-transport
    /// pre-pass in `ServitudeHandle::start` before the transport's
    /// own `start()` method runs.
    ///
    /// The path must be an absolute path to a valid registration YAML.
    /// No validation is done here — tuwunel will reject malformed
    /// registrations at startup and surface the error in its logs.
    pub fn add_appservice_registration(&mut self, path: PathBuf) {
        self.appservice_registrations.push(path);
    }

    /// Read-only accessor for the registered appservice paths. Used
    /// by tests to verify the cross-transport pre-pass wired the
    /// registration correctly.
    pub fn appservice_registrations(&self) -> &[PathBuf] {
        &self.appservice_registrations
    }

    /// Build the env var map passed to the child tuwunel process.
    /// Mirrors the keys the production `docker-compose.yml` sets, minus
    /// federation-allowlist keys (those live in the runtime-swapped
    /// TOML config in the Docker deploy — the embedded MVP runs with
    /// federation disabled by default).
    fn env_vars(&self, data_dir: &Path) -> Vec<(String, String)> {
        let db_path = data_dir.join("database");
        let mut envs = vec![
            ("CONDUWUIT_SERVER_NAME".to_string(), self.server_name.clone()),
            (
                "CONDUWUIT_DATABASE_PATH".to_string(),
                db_path.to_string_lossy().into_owned(),
            ),
            (
                "CONDUWUIT_PORT".to_string(),
                self.listen_port.to_string(),
            ),
            // Loopback only — the MVP never exposes the child tuwunel
            // to the public network. A dedicated tunnel transport
            // (INS-022 Wave 3) will add the public-reachability layer.
            ("CONDUWUIT_ADDRESS".to_string(), "127.0.0.1".to_string()),
            (
                "CONDUWUIT_MAX_REQUEST_SIZE".to_string(),
                "20000000".to_string(),
            ),
            // Registration: token-gated by default. When a registration
            // token is present (the normal case after `start()` runs),
            // tuwunel must have `allow_registration = true` AND
            // `registration_token = <secret>` so the owner / invitees
            // register via the Matrix `m.login.registration_token`
            // UI-Authentication flow. Without the token they cannot
            // create accounts. When the token is absent (degenerate
            // case — pre-W2-11 build, or a transport instance that
            // never had `ensure_registration_token` run on it), we
            // fall back to the historical `allow_registration = false`
            // hard-close so a freshly-spawned tuwunel never accepts
            // self-service signups by accident.
            //
            // Empirical basis (verified 2026-04-27 against
            // https://matrix-construct.github.io/tuwunel/configuration/examples.html):
            //   allow_registration: bool  → toggles signup at all.
            //   registration_token: str   → token required during signup.
            //   yes_i_am_very_very_sure_i_want_an_open_registration_server_prone_to_abuse
            //                            → only relevant if you want
            //                              OPEN signup with no token,
            //                              which we never do.
            //
            // CONDUWUIT_* env-var prefix is preserved for tuwunel
            // backwards-compat (per upstream README: "anything else
            // named conduwuit is still recognized, including
            // environment variables").
            (
                "CONDUWUIT_ALLOW_PRESENCE".to_string(),
                "true".to_string(),
            ),
            ("CONDUWUIT_LOG".to_string(), "info".to_string()),
            ("CONDUWUIT_TRUSTED_SERVERS".to_string(), "[]".to_string()),
        ];

        match &self.registration_token {
            Some(token) => {
                envs.push((
                    "CONDUWUIT_ALLOW_REGISTRATION".to_string(),
                    "true".to_string(),
                ));
                envs.push((
                    "CONDUWUIT_REGISTRATION_TOKEN".to_string(),
                    token.clone(),
                ));
            }
            None => {
                envs.push((
                    "CONDUWUIT_ALLOW_REGISTRATION".to_string(),
                    "false".to_string(),
                ));
            }
        }

        // INS-024 Wave 5: appservice registrations are handled by
        // register_appservices() which runs after tuwunel is reachable,
        // not via env vars (tuwunel's admin_execute doesn't support the
        // multiline body format needed for appservice register).

        envs
    }

    /// Cheap TCP reachability probe against the tuwunel listen port.
    /// Used both during the startup wait loop and by `is_healthy`.
    /// We intentionally do NOT speak HTTP here — just open the TCP
    /// socket. A successful connect is sufficient evidence that the
    /// child is accepting connections; the Concord frontend will
    /// exercise the real Matrix API on subsequent calls.
    async fn probe(&self) -> bool {
        let addr = format!("127.0.0.1:{}", self.listen_port);
        matches!(
            timeout(PROBE_CONNECT_TIMEOUT, TcpStream::connect(&addr)).await,
            Ok(Ok(_))
        )
    }

    /// Send SIGTERM to the child (Unix only) so tuwunel can flush its
    /// RocksDB state. On non-Unix hosts this is a no-op and the caller
    /// is expected to fall back to the SIGKILL path via
    /// [`Child::kill`]. Returns `Ok(())` regardless of platform so the
    /// caller can retry the wait loop either way.
    #[cfg(unix)]
    fn send_sigterm(&self) -> Result<(), TransportError> {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let Some(child) = self.child.as_ref() else {
            return Err(TransportError::NotRunning);
        };
        let Some(pid) = child.id() else {
            // Child already exited — nothing to signal.
            return Ok(());
        };
        kill(Pid::from_raw(pid as i32), Signal::SIGTERM).map_err(|e| {
            TransportError::StopFailed(format!("SIGTERM failed: {}", e))
        })
    }

    #[cfg(not(unix))]
    fn send_sigterm(&self) -> Result<(), TransportError> {
        // Windows / non-Unix fallback — there is no graceful-stop
        // equivalent for std/tokio process Children on Windows.
        // `Child::kill` maps to TerminateProcess, which is the
        // moral equivalent of SIGKILL — the child gets no chance
        // to flush state.
        //
        // RocksDB consequence: the embedded tuwunel's RocksDB has
        // its own write-ahead log / atomic-rename machinery that
        // makes uncrashed termination *survivable*, but a hard
        // kill mid-write can still leave the WAL needing recovery
        // on next boot (slower startup; rare but real). This is
        // documented in docs/native-apps/windows-paths.md.
        //
        // We deliberately return an Err here (not Ok) so the
        // caller's "Phase 1: SIGTERM + graceful wait" branch is
        // skipped entirely — that wait is a 10-second no-op on
        // Windows and just delays uninstall / app-exit.
        Err(TransportError::StopFailed(
            "SIGTERM not supported on this platform; caller must escalate to Child::kill"
                .to_string(),
        ))
    }

    /// Build the `--execute` argument for tuwunel that registers all
    /// pending appservices at startup. Returns `None` if there are no
    /// registrations or none of the files are readable.
    fn build_execute_arg(&self) -> Option<String> {
        if self.appservice_registrations.is_empty() {
            return None;
        }

        let mut commands: Vec<String> = Vec::new();
        for path in &self.appservice_registrations {
            if let Ok(yaml_content) = std::fs::read_to_string(path) {
                commands.push(format!(
                    "appservices register\n```yaml\n{}\n```",
                    yaml_content.trim()
                ));
            }
        }

        if commands.is_empty() {
            None
        } else {
            Some(commands.join("\n\n"))
        }
    }
}

#[async_trait]
impl Transport for MatrixFederationTransport {
    fn name(&self) -> &'static str {
        "matrix_federation"
    }

    async fn start(&mut self) -> Result<(), TransportError> {
        if self.child.is_some() {
            return Err(TransportError::AlreadyRunning);
        }

        let binary = Self::resolve_binary()?;
        let data_dir = Self::resolve_data_dir()?;

        // Create the data directory eagerly so tuwunel doesn't crash
        // on first-run. This is idempotent.
        tokio::fs::create_dir_all(&data_dir).await.map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to create data dir {:?}: {}",
                data_dir, e
            ))
        })?;

        // Read or generate the per-instance registration token. Stored
        // on `self` so the frontend can pull it back via
        // `servitude_get_registration_token` after start. See W2-11.
        // Wrap the blocking File I/O in spawn_blocking so we don't
        // stall the tokio runtime on a slow disk.
        let data_dir_for_token = data_dir.clone();
        let token = tokio::task::spawn_blocking(move || {
            ensure_registration_token(&data_dir_for_token)
        })
        .await
        .map_err(|e| {
            TransportError::StartFailed(format!(
                "registration_token task panicked: {}",
                e
            ))
        })?
        .map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to materialize registration_token: {}",
                e
            ))
        })?;
        self.registration_token = Some(token);

        let envs = self.env_vars(&data_dir);

        let mut cmd = Command::new(&binary);
        cmd.envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Pass --execute to register appservices at startup.
        if let Some(execute_arg) = self.build_execute_arg() {
            cmd.arg("--execute").arg(&execute_arg);
            log::info!(
                target: "concord::servitude",
                "tuwunel will execute appservice registration on startup"
            );
        }

        let child = cmd.spawn().map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to spawn tuwunel at {:?}: {}",
                binary, e
            ))
        })?;

        self.data_dir = Some(data_dir);
        self.child = Some(child);

        // Wait for the child to become reachable on its listen port.
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            // Bail early if the child died during startup.
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.child = None;
                        return Err(TransportError::StartFailed(format!(
                            "tuwunel exited during startup: {}",
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

        // Startup timeout — reap the child so we don't leak a zombie.
        let _ = self.stop().await;
        Err(TransportError::HealthCheck(format!(
            "tuwunel did not become reachable on 127.0.0.1:{} within {:?}",
            self.listen_port, STARTUP_TIMEOUT
        )))
    }

    async fn stop(&mut self) -> Result<(), TransportError> {
        let mut child = match self.child.take() {
            Some(c) => c,
            None => return Err(TransportError::NotRunning),
        };

        // Phase 1: SIGTERM + graceful wait.
        // We already took the child out of `self`, so reattach it
        // temporarily to let `send_sigterm` see it. This is ugly but
        // avoids a refactor of send_sigterm's signature; the field
        // mutation is localised to this function.
        self.child = Some(child);
        let sigterm_result = self.send_sigterm();
        child = self.child.take().expect("child was just reinserted");

        if sigterm_result.is_ok() {
            if let Ok(Ok(_status)) =
                timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait()).await
            {
                // Graceful exit — flush stdin descriptor if still open
                // (belt and suspenders) then return.
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
        self.probe().await
    }
}

/// Minimal `which` implementation — walks `PATH` looking for an
/// executable with the given name. We don't pull in the `which` crate
/// just for one fallback lookup; this is short, audited in-place, and
/// avoids another dependency.
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

    /// Serializes tests that mutate process env vars (`BIN_OVERRIDE_ENV`,
    /// `PATH`, `XDG_DATA_HOME`). Cargo's default test runner uses
    /// multiple threads within a single process, so concurrent
    /// env-mutation tests race without this guard.
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
        let t = MatrixFederationTransport::from_config(&config_on_port(9876));
        assert_eq!(t.listen_port, 9876);
        assert_eq!(t.server_name, "localhost:9876");
        assert!(t.child.is_none());
    }

    #[test]
    fn test_env_vars_mirror_docker_compose_keys() {
        let t = MatrixFederationTransport::from_config(&config_on_port(8765));
        let tmp = std::env::temp_dir().join("concord-env-test");
        let envs = t.env_vars(&tmp);

        // Every key the production docker-compose.yml sets (minus the
        // federation-allowlist trio) must be present. The trio is
        // hot-swapped via TOML on the Docker deploy; embedded MVP
        // starts with federation disabled.
        let keys: Vec<&str> = envs.iter().map(|(k, _)| k.as_str()).collect();
        for required in &[
            "CONDUWUIT_SERVER_NAME",
            "CONDUWUIT_DATABASE_PATH",
            "CONDUWUIT_PORT",
            "CONDUWUIT_ADDRESS",
            "CONDUWUIT_MAX_REQUEST_SIZE",
            "CONDUWUIT_ALLOW_REGISTRATION",
            "CONDUWUIT_ALLOW_PRESENCE",
            "CONDUWUIT_LOG",
            "CONDUWUIT_TRUSTED_SERVERS",
        ] {
            assert!(
                keys.contains(required),
                "missing required tuwunel env var: {}",
                required
            );
        }

        // Safety invariants: bind loopback only, registration off.
        let get = |key: &str| {
            envs.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
                .unwrap()
        };
        assert_eq!(get("CONDUWUIT_ADDRESS"), "127.0.0.1");
        assert_eq!(get("CONDUWUIT_ALLOW_REGISTRATION"), "false");
        assert_eq!(get("CONDUWUIT_PORT"), "8765");
        assert!(get("CONDUWUIT_DATABASE_PATH").contains("database"));
    }

    #[test]
    fn test_resolve_binary_honours_env_override() {
        let _g = ENV_GUARD.lock().unwrap();
        // Point the override at ourselves — the current test binary is
        // guaranteed to be a file we can stat. The function only
        // validates `is_file`, not executability, so this is safe.
        let self_path = std::env::current_exe().unwrap();
        // Scope the env mutation to this test.
        // SAFETY: cargo runs tests in parallel across processes by
        // default, so setting env here only affects the current
        // process's env map.
        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &self_path);
        }
        let resolved = MatrixFederationTransport::resolve_binary()
            .expect("override pointing at current_exe must resolve");
        assert_eq!(resolved, self_path);
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
    }

    #[test]
    fn test_resolve_binary_rejects_broken_override() {
        let _g = ENV_GUARD.lock().unwrap();
        // Pointing at a path that does not exist must surface the
        // override failure explicitly — we don't want a silent
        // fallback to PATH when the user explicitly set the env var.
        let bogus = PathBuf::from("/tmp/definitely-not-a-real-tuwunel-xyz");
        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &bogus);
        }
        let err = MatrixFederationTransport::resolve_binary()
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
            std::env::set_var("XDG_DATA_HOME", "/tmp/fake-xdg-data");
        }
        let d = MatrixFederationTransport::resolve_data_dir().unwrap();
        assert_eq!(
            d,
            PathBuf::from("/tmp/fake-xdg-data/concord/tuwunel")
        );
        match saved {
            Some(p) => unsafe { std::env::set_var("XDG_DATA_HOME", p) },
            None => unsafe { std::env::remove_var("XDG_DATA_HOME") },
        }
    }

    /// Cross-platform binary-name constants must reflect the host
    /// platform's executable suffix conventions. Without this, the
    /// MSI/NSIS build embeds `tuwunel.exe` but the runtime resolver
    /// looks for `tuwunel` (no suffix) and surfaces BinaryNotFound at
    /// startup. See W2-03 in the W2 sprint plan.
    #[cfg(not(windows))]
    #[test]
    fn test_bundled_resource_rel_has_no_exe_suffix_on_unix() {
        assert!(
            BUNDLED_RESOURCE_REL.ends_with("tuwunel"),
            "Unix builds expect bare 'tuwunel' name, got: {}",
            BUNDLED_RESOURCE_REL
        );
        assert!(
            !BUNDLED_RESOURCE_REL.ends_with(".exe"),
            "Unix builds must NOT carry the .exe suffix, got: {}",
            BUNDLED_RESOURCE_REL
        );
        assert_eq!(SIBLING_BIN_REL, "tuwunel");
        assert_eq!(PATH_LOOKUP_NAME, "tuwunel");
    }

    #[cfg(windows)]
    #[test]
    fn test_bundled_resource_rel_has_exe_suffix_on_windows() {
        assert!(
            BUNDLED_RESOURCE_REL.ends_with("tuwunel.exe"),
            "Windows builds require the .exe suffix, got: {}",
            BUNDLED_RESOURCE_REL
        );
        assert_eq!(SIBLING_BIN_REL, "tuwunel.exe");
        assert_eq!(PATH_LOOKUP_NAME, "tuwunel.exe");
    }

    /// Empirical resolve_binary() exercise: stage a fake bundled binary
    /// in a tempdir, set BIN_OVERRIDE_ENV to point at it, and assert
    /// the resolver returns that exact path. Cross-platform — uses the
    /// platform-correct BUNDLED_RESOURCE_REL so the test passes on
    /// both Linux CI and the Windows-build CI job.
    #[test]
    fn test_resolve_binary_finds_bundled_via_override() {
        let _g = ENV_GUARD.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!(
            "concord-resolve-test-{}",
            std::process::id()
        ));
        let bundled_path = tmp.join(BUNDLED_RESOURCE_REL);
        if let Some(parent) = bundled_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&bundled_path, b"fake-binary").unwrap();

        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &bundled_path);
        }
        let resolved = MatrixFederationTransport::resolve_binary()
            .expect("override pointing at staged bundled path must resolve");
        assert_eq!(resolved, bundled_path);

        // Cleanup
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn test_start_fails_when_binary_missing() {
        let _g = ENV_GUARD.lock().unwrap();
        // No env override, and we assume the test host has no
        // `tuwunel` on its PATH nor bundled next to the test binary.
        // If some dev host happens to have one installed, this test
        // will flake — but that's an expected quirk of testing
        // binary-discovery logic without a hermetic fs sandbox.
        let saved_bin = std::env::var_os(BIN_OVERRIDE_ENV);
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }

        // Also neutralise PATH so the fallback can't accidentally
        // find a real tuwunel — this prevents flakes on hosts where
        // the operator has tuwunel installed globally.
        let saved_path = std::env::var_os("PATH");
        unsafe {
            std::env::set_var("PATH", "");
        }

        let mut t =
            MatrixFederationTransport::from_config(&config_on_port(18765));
        let err = t.start().await.expect_err("start without binary must fail");
        assert!(matches!(err, TransportError::BinaryNotFound(_)));
        assert!(t.child.is_none(), "failed start must leave child as None");

        // Restore PATH so later tests that depend on `sh` / `true` work.
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
        let mut t = MatrixFederationTransport::from_config(&config_on_port(18766));
        let err = t.stop().await.expect_err("stop on stopped transport must fail");
        assert!(matches!(err, TransportError::NotRunning));
    }

    #[tokio::test]
    async fn test_is_healthy_false_when_no_child() {
        let t = MatrixFederationTransport::from_config(&config_on_port(18767));
        assert!(!t.is_healthy().await);
    }

    /// Integration-style test: use `/bin/sh -c "sleep 300"` as a
    /// fake tuwunel, then exercise the full start/stop lifecycle
    /// against it. We can't test the health-probe success path with
    /// sh (it doesn't listen on a port), so this test only asserts
    /// the spawn + SIGTERM path by short-circuiting around the startup
    /// wait loop via a direct child-injection helper.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_stop_sends_sigterm_to_running_child() {
        // Hold ENV_GUARD so we don't race any concurrent env-mutating
        // test that might clear PATH and break the sh spawn below.
        // See the note on ENV_GUARD at the top of this module.
        let _g = ENV_GUARD.lock().unwrap();

        use std::process::Stdio;
        use tokio::process::Command;

        // Belt-and-suspenders: prefer an absolute path to sh so the
        // test survives a concurrent PATH mutation racing in before
        // the lock is acquired.
        let sh_path = if std::path::Path::new("/bin/sh").exists() {
            "/bin/sh"
        } else if std::path::Path::new("/usr/bin/sh").exists() {
            "/usr/bin/sh"
        } else {
            panic!("no sh found at /bin/sh or /usr/bin/sh on unix test host");
        };

        let mut t = MatrixFederationTransport::from_config(&config_on_port(18768));

        // Spawn a sleep process directly and inject it into the
        // transport so we bypass the healthcheck wait loop. This is
        // the intended test hook — the public API is still the real
        // thing, we're just building a controlled child.
        let child = Command::new(sh_path)
            .arg("-c")
            .arg("sleep 300")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("sh must spawn on any unix test host");

        t.child = Some(child);
        assert!(t.is_healthy().await == false); // no one is listening on 18768

        // stop() should land via the SIGTERM path because sleep exits
        // cleanly on SIGTERM.
        t.stop().await.expect("stop against sleep must succeed");
        assert!(t.child.is_none(), "post-stop child must be None");

        // Second stop returns NotRunning — lifecycle safety.
        let err = t.stop().await.expect_err("double-stop must fail");
        assert!(matches!(err, TransportError::NotRunning));
    }

    // -----------------------------------------------------------------
    // INS-024 Wave 5 — appservice registration wiring tests
    // -----------------------------------------------------------------

    #[test]
    fn test_env_vars_omit_admin_execute_when_none_registered() {
        let t = MatrixFederationTransport::from_config(&config_on_port(8765));
        let tmp = std::env::temp_dir().join("concord-env-test-no-as");
        let envs = t.env_vars(&tmp);
        let keys: Vec<&str> = envs.iter().map(|(k, _)| k.as_str()).collect();
        assert!(
            !keys.contains(&"CONDUWUIT_ADMIN_EXECUTE"),
            "CONDUWUIT_ADMIN_EXECUTE must NOT be present when no \
             registrations are added"
        );
    }

    #[test]
    fn test_build_execute_arg_emits_appservices_register_when_registered() {
        // Contract revision: CONDUWUIT_ADMIN_EXECUTE is NO LONGER emitted
        // from env_vars() — tuwunel's admin_execute doesn't support the
        // multiline body needed for `appservices register`. The post-
        // startup register_appservices() path now calls
        // build_execute_arg() to produce the register command and sends
        // it via the admin HTTP API after tuwunel is reachable. This
        // test pins the new contract: after add_appservice_registration,
        // (a) env_vars() MUST NOT contain CONDUWUIT_ADMIN_EXECUTE (so
        // stale readers don't resurrect the old path), (b) the
        // registration path is reachable via the accessor, and (c)
        // build_execute_arg() returns Some(cmd) containing the
        // `appservices register` verb + the file's YAML body.
        let tmp_dir = std::env::temp_dir().join("concord-env-test-with-as");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let reg_path = tmp_dir.join("registration.yaml");
        std::fs::write(&reg_path, "id: test_bridge\nas_token: abc\nhs_token: def\n")
            .expect("write test registration");

        let mut t = MatrixFederationTransport::from_config(&config_on_port(8765));
        t.add_appservice_registration(reg_path.clone());

        // (a) env_vars() must stay free of CONDUWUIT_ADMIN_EXECUTE.
        let envs = t.env_vars(&tmp_dir);
        let keys: Vec<&str> = envs.iter().map(|(k, _)| k.as_str()).collect();
        assert!(
            !keys.contains(&"CONDUWUIT_ADMIN_EXECUTE"),
            "CONDUWUIT_ADMIN_EXECUTE must NOT be emitted via env_vars \
             — registrations are registered post-startup via \
             register_appservices(), not via tuwunel's --execute env"
        );

        // (b) the registration path is retrievable through the
        // public accessor.
        assert_eq!(
            t.appservice_registrations(),
            &[reg_path],
            "add_appservice_registration must persist the path"
        );

        // (c) build_execute_arg produces a command containing both
        // the register verb and the YAML body.
        let cmd = t
            .build_execute_arg()
            .expect("build_execute_arg must return Some after registration added");
        assert!(
            cmd.contains("appservices register"),
            "command must contain 'appservices register' verb: {cmd}"
        );
        assert!(
            cmd.contains("test_bridge"),
            "command must contain registration YAML content: {cmd}"
        );
    }

    #[test]
    fn test_appservice_registrations_accessor() {
        let mut t = MatrixFederationTransport::from_config(&config_on_port(8765));
        assert!(t.appservice_registrations().is_empty());
        let p = PathBuf::from("/test/registration.yaml");
        t.add_appservice_registration(p.clone());
        assert_eq!(t.appservice_registrations(), &[p]);
    }

    // W2-11 — registration token plumbing.

    /// generate_registration_token returns a 32-char `[A-Za-z0-9]`
    /// string. The exact length is part of the API contract — the
    /// frontend's Host onboarding flow uses this length as a basic
    /// "did we get a real token?" sanity check.
    #[test]
    fn test_generate_registration_token_shape() {
        let token = generate_registration_token();
        assert_eq!(
            token.len(),
            REGISTRATION_TOKEN_LEN,
            "token length mismatch (expected {}, got {})",
            REGISTRATION_TOKEN_LEN,
            token.len()
        );
        assert!(
            token.chars().all(|c| c.is_ascii_alphanumeric()),
            "token must be ASCII alphanumeric, got: {:?}",
            token
        );
    }

    /// Two consecutive calls produce different values (entropy
    /// sanity check). Probability of collision at 32 alnum chars is
    /// 1 / 62^32 — about 1 in 2.2 × 10^57. If this test ever fails,
    /// the RNG is broken.
    #[test]
    fn test_generate_registration_token_is_random() {
        let a = generate_registration_token();
        let b = generate_registration_token();
        assert_ne!(a, b, "two RNG draws produced the same token");
    }

    /// First call to `ensure_registration_token` creates the file with
    /// the generated token; second call round-trips the SAME token
    /// (idempotency contract — restarts of tuwunel must preserve any
    /// invitation tokens already shared with friends).
    #[test]
    fn test_ensure_registration_token_is_idempotent() {
        let dir = std::env::temp_dir().join(format!(
            "concord-token-test-{}-{}",
            std::process::id(),
            uuid_like()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let first = ensure_registration_token(&dir).expect("first call must succeed");
        assert_eq!(first.len(), REGISTRATION_TOKEN_LEN);

        // The file must now exist and contain exactly the token.
        let token_path = dir.join(REGISTRATION_TOKEN_FILENAME);
        let on_disk = std::fs::read_to_string(&token_path).unwrap();
        assert_eq!(on_disk.trim(), first);

        let second =
            ensure_registration_token(&dir).expect("second call must succeed");
        assert_eq!(
            first, second,
            "ensure_registration_token must return the SAME token on a re-call"
        );

        // 0600 on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "registration_token file must be 0600 on unix, got {:o}",
                mode
            );
        }

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Helper: produce a per-test pseudo-uuid so concurrent test
    /// processes don't collide on the same tempdir name.
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

    /// `env_vars()` flips registration on with the live token when
    /// one is loaded. This is the runtime-correct shape — tuwunel
    /// must see `allow_registration=true` AND
    /// `registration_token=<secret>` together for token-gated signup
    /// to work.
    #[test]
    fn test_env_vars_emits_registration_token_when_loaded() {
        let mut t = MatrixFederationTransport::from_config(&config_on_port(8765));
        // Simulate a successful start that loaded the token.
        t.registration_token = Some("test-token-abcdef0123456789".to_string());

        let envs = t.env_vars(std::path::Path::new("/tmp"));
        let by_key: std::collections::HashMap<&str, &str> = envs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        assert_eq!(
            by_key.get("CONDUWUIT_ALLOW_REGISTRATION"),
            Some(&"true"),
            "with a token loaded, allow_registration must be true"
        );
        assert_eq!(
            by_key.get("CONDUWUIT_REGISTRATION_TOKEN"),
            Some(&"test-token-abcdef0123456789"),
            "registration_token env var must mirror the loaded token"
        );
    }

    /// Defensive default: if `registration_token` is None on the
    /// transport (e.g. start hasn't run yet, or this branch is
    /// exercised by a future test), the env vars must keep the
    /// historical hard-close so a freshly-spawned tuwunel never
    /// accepts open signups.
    #[test]
    fn test_env_vars_falls_back_to_closed_when_no_token() {
        let t = MatrixFederationTransport::from_config(&config_on_port(8765));
        assert!(t.registration_token().is_none());
        let envs = t.env_vars(std::path::Path::new("/tmp"));
        let by_key: std::collections::HashMap<&str, &str> = envs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        assert_eq!(
            by_key.get("CONDUWUIT_ALLOW_REGISTRATION"),
            Some(&"false"),
            "without a token, allow_registration must be false"
        );
        assert!(
            !by_key.contains_key("CONDUWUIT_REGISTRATION_TOKEN"),
            "no CONDUWUIT_REGISTRATION_TOKEN should be emitted when token is None"
        );
    }
}
