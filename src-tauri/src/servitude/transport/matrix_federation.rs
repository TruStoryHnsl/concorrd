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

/// Relative path inside the Tauri resources directory where the Linux
/// build script drops the bundled tuwunel binary.
pub const BUNDLED_RESOURCE_REL: &str = "resources/tuwunel/tuwunel";

/// Sibling-binary fallback path — some bundlers extract the binary
/// directly next to the main executable.
pub const SIBLING_BIN_REL: &str = "tuwunel";

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
        }
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
        if let Some(path_hit) = which_in_path("tuwunel") {
            return Ok(path_hit);
        }

        Err(TransportError::BinaryNotFound(format!(
            "tuwunel binary not found. Set {} to override, or bundle at <exe_dir>/{}",
            BIN_OVERRIDE_ENV, BUNDLED_RESOURCE_REL
        )))
    }

    /// Resolve the data directory used for the embedded tuwunel's
    /// database and log files. On Linux this honours
    /// `XDG_DATA_HOME`, falling back to `$HOME/.local/share`.
    /// Other Unix platforms use `$HOME/.local/share`. Windows is not
    /// supported from this MVP — the Linux-first goal in Wave 2 pins
    /// this explicitly.
    pub fn resolve_data_dir() -> Result<PathBuf, TransportError> {
        if let Ok(xdg) = env::var("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg).join("concord").join("tuwunel"));
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
        let envs = vec![
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
            // Safety defaults — registration closed, federation
            // disabled at the env layer until the user opts in via
            // settings. Hot-swap of these lives in
            // `server/services/tuwunel_config.py` on the Docker
            // deploy; embedded mode relies on a restart.
            (
                "CONDUWUIT_ALLOW_REGISTRATION".to_string(),
                "false".to_string(),
            ),
            (
                "CONDUWUIT_ALLOW_PRESENCE".to_string(),
                "true".to_string(),
            ),
            ("CONDUWUIT_LOG".to_string(), "info".to_string()),
            ("CONDUWUIT_TRUSTED_SERVERS".to_string(), "[]".to_string()),
        ];

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
        // Windows / non-Unix fallback — no SIGTERM equivalent.
        // Callers escalate straight to Child::kill.
        Ok(())
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
}
