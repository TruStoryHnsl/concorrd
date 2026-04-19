//! Sandboxed mautrix-discord transport backed by a bundled Go binary
//! wrapped in `bubblewrap` (`bwrap`).
//!
//! This is the second real transport wired into the servitude lifecycle
//! (INS-024 Wave 3, 2026-04-09) and it shares the bundled child-process
//! shape of `matrix_federation.rs` — the mautrix-discord binary is
//! downloaded at build time by `scripts/build_linux_native.sh`, shipped
//! alongside the Tauri bundle, and launched on demand by this module.
//!
//! What makes it different from `matrix_federation.rs` is the **commercial
//! scope sandbox contract**: the bridge MUST run inside `bubblewrap` with a
//! whitelist-only bind mount set, no `/home` access, dropped capabilities,
//! and a cleared environment. If `bwrap` is not present on the host the
//! transport REFUSES to start — there is no silent unsandboxed fallback.
//! This keeps the Discord API credentials, any supply-chain risk in
//! mautrix-discord itself, and the bridge's dependency surface strictly
//! contained.
//!
//! The bridge is a **non-critical** transport under the new
//! `Transport::is_critical` split introduced in Wave 3 — a bridge crash
//! is recorded in `ServitudeHandle::degraded` and the rest of the
//! servitude keeps running. See `src-tauri/src/servitude/mod.rs` for the
//! partial-failure rollback path.
//!
//! Binary discovery order (first hit wins), mirroring tuwunel:
//!
//!   1. `MAUTRIX_DISCORD_BIN` environment variable — dev override for
//!      running against a locally-built mautrix-discord.
//!   2. `<current_exe_dir>/resources/discord_bridge/mautrix-discord` —
//!      the bundled location the Linux build script writes to.
//!   3. `<current_exe_dir>/mautrix-discord` — the "sibling binary"
//!      layout some bundlers prefer.
//!   4. `PATH` lookup — last-resort fallback.
//!
//! Data layout on Linux:
//!
//!   `$XDG_DATA_HOME/concord/discord-bridge/`
//!       `config.yaml` — bridge config (0600), written on start
//!       `registration.yaml` — AS registration (0600), written on start
//!       `mautrix-discord.db` — bridge SQLite state (mautrix owned)
//!
//! Linux-first: per the same `matrix_federation.rs:157-158` restriction,
//! this transport returns `NotImplemented` on macOS and Windows. The
//! `bwrap` dependency alone makes it Linux-only.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout, Instant};

use crate::servitude::config::ServitudeConfig;

use super::{Transport, TransportError};

/// Env-var override for the mautrix-discord binary path. Lets developers
/// run against a hand-built mautrix-discord without rebuilding the
/// Concord installer.
pub const BIN_OVERRIDE_ENV: &str = "MAUTRIX_DISCORD_BIN";

/// Relative path inside the Tauri resources directory where the Linux
/// build script drops the bundled mautrix-discord binary.
pub const BUNDLED_RESOURCE_REL: &str = "resources/discord_bridge/mautrix-discord";

/// Sibling-binary fallback path — some bundlers extract the binary
/// directly next to the main executable.
pub const SIBLING_BIN_REL: &str = "mautrix-discord";

/// Name of the `bubblewrap` binary we expect on the host. Pinning it as a
/// const makes the "refuse to start when missing" contract greppable and
/// keeps the path resolution single-sourced.
pub const BWRAP_BIN: &str = "bwrap";

/// Default port the bridge listens on for the tuwunel AS push. Matches
/// the Docker-mode port in `docker-compose.yml` so Wave 2 runbooks stay
/// valid if an operator later mirrors the embedded path.
pub const DEFAULT_BRIDGE_PORT: u16 = 29_334;

/// How long to wait for the child bwrap+bridge to become reachable on
/// its listen port before giving up.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Interval between startup health probes.
pub const STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(500);

/// Timeout for an individual TCP health probe.
pub const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// How long to wait after sending SIGTERM before escalating to SIGKILL.
pub const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

/// Sandboxed mautrix-discord transport. Owns the child process handle
/// while running; the field is `None` in the stopped state.
#[derive(Debug)]
pub struct DiscordBridgeTransport {
    /// 127.0.0.1 port the embedded tuwunel listens on — the bridge
    /// reaches the homeserver via the loopback network from inside the
    /// sandbox (this is why `--share-net` is required in the bwrap
    /// argv).
    matrix_loopback_port: u16,
    /// Matrix server_name the bridge advertises. Matches the tuwunel
    /// transport's loopback server name, i.e. `localhost:<port>`.
    server_name: String,
    /// Port the bridge exposes for the AS push callback from tuwunel.
    bridge_listen_port: u16,
    /// Data directory (config, registration, SQLite) — lazily resolved
    /// on start.
    data_dir: Option<PathBuf>,
    /// Path of the AS registration file inside the bridge data dir.
    /// Kept so the cross-transport pre-pass in `ServitudeHandle::start`
    /// can locate it without duplicating the resolution logic.
    registration_path: Option<PathBuf>,
    /// Child process handle (bwrap wrapping mautrix-discord). `Some`
    /// while running, `None` while stopped.
    child: Option<Child>,
}

impl DiscordBridgeTransport {
    /// Build a transport from the validated servitude config. Pure
    /// data-carrier — nothing is spawned, no filesystem paths are
    /// touched. The caller is responsible for calling `start()` to
    /// actually bring the bridge up.
    pub fn from_config(config: &ServitudeConfig) -> Self {
        let port = config.listen_port as u16;
        Self {
            matrix_loopback_port: port,
            server_name: format!("localhost:{}", port),
            bridge_listen_port: DEFAULT_BRIDGE_PORT,
            data_dir: None,
            registration_path: None,
            child: None,
        }
    }

    /// Read-only accessor for the eagerly-captured matrix loopback port.
    /// Used by unit tests and the cross-transport pre-pass.
    pub fn matrix_loopback_port(&self) -> u16 {
        self.matrix_loopback_port
    }

    /// Locate the bundled mautrix-discord binary on disk. Returns the
    /// first hit in the discovery order documented at the top of this
    /// module, or [`TransportError::BinaryNotFound`] if nothing
    /// matches.
    pub fn resolve_binary() -> Result<PathBuf, TransportError> {
        // 1. Env-var override — hard failure if set to a bogus path so
        //    the developer notices immediately instead of silently
        //    falling back to PATH.
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

        // 4. Data directory (runtime download location).
        if let Ok(data_dir) = Self::resolve_data_dir() {
            let data_bin = data_dir.join("mautrix-discord");
            if data_bin.is_file() {
                return Ok(data_bin);
            }
        }

        // 5. PATH lookup fallback.
        if let Some(path_hit) = which_in_path("mautrix-discord") {
            return Ok(path_hit);
        }

        Err(TransportError::BinaryNotFound(format!(
            "mautrix-discord binary not found. Set {} to override, \
             or bundle at <exe_dir>/{}",
            BIN_OVERRIDE_ENV, BUNDLED_RESOURCE_REL
        )))
    }

    /// Locate `bwrap` on the host. Returns
    /// [`TransportError::BinaryNotFound`] if missing — commercial
    /// scope requires refusing to start rather than silently running
    /// the bridge unsandboxed.
    pub fn resolve_bwrap() -> Result<PathBuf, TransportError> {
        if let Some(path_hit) = which_in_path(BWRAP_BIN) {
            return Ok(path_hit);
        }
        Err(TransportError::BinaryNotFound(format!(
            "{} not found on PATH. The Discord bridge refuses to start \
             without a sandbox. Install bubblewrap (Debian/Ubuntu: \
             `apt install bubblewrap`; Arch: `pacman -S bubblewrap`) \
             and retry.",
            BWRAP_BIN
        )))
    }

    /// Resolve the data directory used for the bridge's config,
    /// registration, and SQLite state. Honours `XDG_DATA_HOME`, falls
    /// back to `$HOME/.local/share/concord/discord-bridge`.
    pub fn resolve_data_dir() -> Result<PathBuf, TransportError> {
        if let Ok(xdg) = env::var("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg)
                    .join("concord")
                    .join("discord-bridge"));
            }
        }
        if let Ok(home) = env::var("HOME") {
            return Ok(PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("concord")
                .join("discord-bridge"));
        }
        Err(TransportError::StartFailed(
            "cannot resolve data directory: neither XDG_DATA_HOME nor HOME set"
                .to_string(),
        ))
    }

    /// Env vars that would be set inside the sandboxed bridge process.
    /// These are expressed as `(k, v)` pairs because `bwrap` consumes
    /// them via `--setenv` flags, not via the child process's
    /// inherited env — `--clearenv` wipes the host env completely
    /// before these are re-applied inside the sandbox.
    ///
    /// The returned list mirrors the production `docker-compose.yml`
    /// `env_file` + `environment` shape for mautrix-discord as closely
    /// as the embedded mode allows.
    pub fn env_vars(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/data".to_string()),
            ("TZ".to_string(), "UTC".to_string()),
            ("LANG".to_string(), "C.UTF-8".to_string()),
            (
                "MAUTRIX_DISCORD_CONFIG".to_string(),
                "/data/config.yaml".to_string(),
            ),
            (
                "MAUTRIX_DISCORD_REGISTRATION".to_string(),
                "/data/registration.yaml".to_string(),
            ),
        ]
    }

    /// Ensure the bridge data directory exists with tight permissions
    /// (0700 on Linux) and write default `config.yaml` + a sentinel
    /// `registration.yaml` if either is missing. This is called from
    /// `start` before spawning bwrap so the sandbox's `--bind
    /// <data_dir> /data` always lands on a populated directory.
    ///
    /// INS-024 Wave 4: generates cryptographically random `as_token`
    /// and `hs_token` instead of placeholders. Existing tokens are
    /// preserved across restarts (only written on first run or when
    /// the file is missing).
    async fn ensure_config_and_registration(
        &mut self,
        data_dir: &Path,
    ) -> Result<(), TransportError> {
        tokio::fs::create_dir_all(data_dir).await.map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to create bridge data dir {:?}: {}",
                data_dir, e
            ))
        })?;

        // Tighten the directory mode on Unix — the data dir holds
        // Discord tokens and AS secrets, so non-owner readers are
        // explicitly denied.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = tokio::fs::metadata(data_dir)
                .await
                .map_err(|e| {
                    TransportError::StartFailed(format!(
                        "failed to stat data dir {:?}: {}",
                        data_dir, e
                    ))
                })?
                .permissions();
            perms.set_mode(0o700);
            tokio::fs::set_permissions(data_dir, perms).await.map_err(|e| {
                TransportError::StartFailed(format!(
                    "failed to chmod 0700 data dir {:?}: {}",
                    data_dir, e
                ))
            })?;
        }

        // Generate real random tokens (INS-024 Wave 4).
        let as_token = generate_random_hex_token();
        let hs_token = generate_random_hex_token();

        let config_path = data_dir.join("config.yaml");
        if !tokio::fs::try_exists(&config_path).await.unwrap_or(false) {
            // Initial config with real random AS tokens. The bot_token
            // field is left empty — the BridgesTab UI writes it via
            // the `discord_bridge_set_bot_token` Tauri command before
            // the user enables the bridge.
            let contents = format!(
                "# Generated by Concord (INS-024 Wave 4)\n\
                 homeserver:\n\
                 \x20\x20address: http://127.0.0.1:{port}\n\
                 \x20\x20domain: {server_name}\n\
                 appservice:\n\
                 \x20\x20address: http://127.0.0.1:{bridge_port}\n\
                 \x20\x20hostname: 127.0.0.1\n\
                 \x20\x20port: {bridge_port}\n\
                 \x20\x20id: concord_discord\n\
                 \x20\x20bot_username: _discord_bot\n\
                 \x20\x20as_token: {as_token}\n\
                 \x20\x20hs_token: {hs_token}\n\
                 bridge:\n\
                 \x20\x20username_template: _discord_{{{{.}}}}\n\
                 \x20\x20displayname_template: '{{{{.Username}}}} (Discord)'\n\
                 logging:\n\
                 \x20\x20min_level: info\n",
                port = self.matrix_loopback_port,
                server_name = self.server_name,
                bridge_port = self.bridge_listen_port,
                as_token = as_token,
                hs_token = hs_token,
            );
            write_file_0600(&config_path, contents.as_bytes()).await?;
        }

        let registration_path = data_dir.join("registration.yaml");
        if !tokio::fs::try_exists(&registration_path)
            .await
            .unwrap_or(false)
        {
            let contents = format!(
                "# Generated by Concord (INS-024 Wave 4)\n\
                 id: concord_discord\n\
                 url: http://127.0.0.1:{bridge_port}\n\
                 as_token: {as_token}\n\
                 hs_token: {hs_token}\n\
                 sender_localpart: _discord_bot\n\
                 rate_limited: false\n\
                 namespaces:\n\
                 \x20\x20users:\n\
                 \x20\x20\x20\x20- exclusive: true\n\
                 \x20\x20\x20\x20\x20\x20regex: '@_discord_.*:{server_name}'\n\
                 \x20\x20aliases:\n\
                 \x20\x20\x20\x20- exclusive: true\n\
                 \x20\x20\x20\x20\x20\x20regex: '#_discord_.*:{server_name}'\n\
                 \x20\x20rooms: []\n",
                bridge_port = self.bridge_listen_port,
                as_token = as_token,
                hs_token = hs_token,
                server_name = self.server_name,
            );
            write_file_0600(&registration_path, contents.as_bytes()).await?;
        }

        self.registration_path = Some(registration_path);
        Ok(())
    }

    /// Build the exact `bwrap` argv per PLAN §C.2. Returns a `Vec<String>`
    /// so tests can assert against individual flags without running
    /// the sandbox.
    ///
    /// Every argument in this function is load-bearing for the sandbox
    /// boundary — the tests in this module pin the must-have flags
    /// (`--unshare-user`, `--die-with-parent`, `--ro-bind /usr /usr`)
    /// and assert the absence of any `/home/` substring to make
    /// accidental regressions impossible.
    pub fn build_sandboxed_argv(
        &self,
        binary: &Path,
        data_dir: &Path,
    ) -> Vec<String> {
        let mut argv: Vec<String> = Vec::with_capacity(64);

        // Namespace isolation — drop every namespace we can.
        argv.push("--unshare-user".to_string());
        argv.push("--unshare-pid".to_string());
        argv.push("--unshare-ipc".to_string());
        argv.push("--unshare-uts".to_string());
        argv.push("--unshare-cgroup".to_string());

        // Wipe the host env; re-apply only the env vars we actually
        // want the bridge to see.
        argv.push("--clearenv".to_string());
        for (k, v) in self.env_vars() {
            argv.push("--setenv".to_string());
            argv.push(k);
            argv.push(v);
        }

        // Read-only host mounts — the whitelist. Nothing under
        // `/home`, nothing under `/var`, no dotfiles. The order here
        // matches PLAN §C.2 for diffability.
        let ro_binds = [
            ("/usr", "/usr"),
            ("/lib", "/lib"),
            ("/lib64", "/lib64"),
            ("/etc/ssl", "/etc/ssl"),
            ("/etc/resolv.conf", "/etc/resolv.conf"),
            ("/etc/ca-certificates", "/etc/ca-certificates"),
        ];
        for (src, dst) in &ro_binds {
            argv.push("--ro-bind".to_string());
            argv.push(src.to_string());
            argv.push(dst.to_string());
        }

        // The mautrix-discord binary itself, bind-mounted into the
        // sandbox at a fixed well-known path so the launch command
        // inside the sandbox does not depend on the host path.
        // Uses /usr/bin/ (which exists from the /usr ro-bind above)
        // rather than /usr/local/bin/ (which may not exist).
        argv.push("--ro-bind".to_string());
        argv.push(binary.to_string_lossy().into_owned());
        argv.push("/usr/bin/mautrix-discord".to_string());

        // The only read-write mount — the bridge's own data directory,
        // which holds its SQLite state, config, and AS registration.
        argv.push("--bind".to_string());
        argv.push(data_dir.to_string_lossy().into_owned());
        argv.push("/data".to_string());

        // Standard ephemeral mounts required by any Go HTTP server.
        argv.push("--proc".to_string());
        argv.push("/proc".to_string());
        argv.push("--dev".to_string());
        argv.push("/dev".to_string());
        argv.push("--tmpfs".to_string());
        argv.push("/tmp".to_string());

        // Process lifecycle + privilege reductions. `--die-with-parent`
        // is the critical one — it ensures a SIGKILL of Concord
        // cannot leave an orphan bridge process behind, closing the
        // blast-radius hole that `kill_on_drop` on the Child handle
        // does not by itself cover.
        argv.push("--die-with-parent".to_string());
        argv.push("--new-session".to_string());
        argv.push("--cap-drop".to_string());
        argv.push("ALL".to_string());

        // Network sharing is REQUIRED — the bridge needs to reach
        // `127.0.0.1:<matrix_loopback_port>` (embedded tuwunel) AND
        // `gateway.discord.gg:443` (Discord gateway). Dropping the
        // network namespace is not an option.
        argv.push("--share-net".to_string());

        // End of bwrap args — everything after `--` is the command
        // executed inside the sandbox.
        argv.push("--".to_string());
        argv.push("/usr/bin/mautrix-discord".to_string());
        argv.push("-c".to_string());
        argv.push("/data/config.yaml".to_string());
        argv.push("-r".to_string());
        argv.push("/data/registration.yaml".to_string());

        argv
    }

    /// Cheap TCP reachability probe against the bridge's listen port.
    async fn probe(&self) -> bool {
        let addr = format!("127.0.0.1:{}", self.bridge_listen_port);
        matches!(
            timeout(PROBE_CONNECT_TIMEOUT, TcpStream::connect(&addr)).await,
            Ok(Ok(_))
        )
    }

    /// Send SIGTERM to the child bwrap process. bwrap forwards signals
    /// to the wrapped mautrix-discord process, so this gives the
    /// bridge a chance to flush its SQLite state before we escalate
    /// to SIGKILL.
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
        Ok(())
    }
}

#[async_trait]
impl Transport for DiscordBridgeTransport {
    fn name(&self) -> &'static str {
        "discord_bridge"
    }

    /// Discord bridge is a non-critical transport. A failure to start
    /// it (or a crash of the running bridge) is recorded in
    /// `ServitudeHandle::degraded` and the rest of the servitude keeps
    /// running — see the partial-failure rollback path in
    /// `src-tauri/src/servitude/mod.rs`.
    fn is_critical(&self) -> bool {
        false
    }

    async fn start(&mut self) -> Result<(), TransportError> {
        if self.child.is_some() {
            return Err(TransportError::AlreadyRunning);
        }

        // Non-Linux hosts bail out early. The bwrap dependency alone
        // makes this transport Linux-only — matches the same
        // `matrix_federation.rs:157-158` restriction.
        #[cfg(not(target_os = "linux"))]
        {
            return Err(TransportError::NotImplemented("discord_bridge"));
        }

        #[cfg(target_os = "linux")]
        {
            // Step 1: resolve the two binaries BEFORE touching the
            // filesystem. If either is missing we fail fast without
            // leaving partially-written state on disk.
            let binary = Self::resolve_binary()?;
            let bwrap = Self::resolve_bwrap()?;

            // Step 2: ensure the data dir + config files exist.
            let data_dir = Self::resolve_data_dir()?;
            self.ensure_config_and_registration(&data_dir).await?;

            // Step 3: build the exact sandbox argv and spawn.
            let argv = self.build_sandboxed_argv(&binary, &data_dir);

            let mut cmd = Command::new(&bwrap);
            cmd.args(&argv)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);

            let child = cmd.spawn().map_err(|e| {
                TransportError::StartFailed(format!(
                    "failed to spawn bwrap at {:?}: {}",
                    bwrap, e
                ))
            })?;

            self.data_dir = Some(data_dir);
            self.child = Some(child);

            // Step 4: wait for the bridge to become reachable on its
            // listen port, or bail if the child dies.
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            while Instant::now() < deadline {
                if let Some(child) = self.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            // Capture stderr to diagnose why the bridge died.
                            let stderr_output = if let Some(stderr) = child.stderr.take() {
                                use tokio::io::AsyncReadExt;
                                let mut buf = Vec::new();
                                let mut stderr = stderr;
                                let _ = stderr.read_to_end(&mut buf).await;
                                String::from_utf8_lossy(&buf).to_string()
                            } else {
                                String::new()
                            };
                            let stdout_output = if let Some(stdout) = child.stdout.take() {
                                use tokio::io::AsyncReadExt;
                                let mut buf = Vec::new();
                                let mut stdout = stdout;
                                let _ = stdout.read_to_end(&mut buf).await;
                                String::from_utf8_lossy(&buf).to_string()
                            } else {
                                String::new()
                            };
                            let combined = format!("{}{}", stdout_output, stderr_output);
                            log::error!(
                                target: "concord::bridge",
                                "mautrix-discord (bwrap) died on startup:\n{}",
                                if combined.is_empty() { "(no output)" } else { &combined }
                            );
                            self.child = None;
                            return Err(TransportError::StartFailed(format!(
                                "mautrix-discord (bwrap) exited during startup: {} — {}",
                                status,
                                if combined.len() > 200 { &combined[..200] } else { &combined }
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
                "mautrix-discord did not become reachable on 127.0.0.1:{} \
                 within {:?}",
                self.bridge_listen_port, STARTUP_TIMEOUT
            )))
        }
    }

    async fn stop(&mut self) -> Result<(), TransportError> {
        let mut child = match self.child.take() {
            Some(c) => c,
            None => return Err(TransportError::NotRunning),
        };

        // Phase 1: SIGTERM + graceful wait.
        self.child = Some(child);
        let sigterm_result = self.send_sigterm();
        child = self.child.take().expect("child was just reinserted");

        if sigterm_result.is_ok() {
            if let Ok(Ok(_status)) =
                timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait()).await
            {
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

/// Generate a 32-byte cryptographically random token encoded as hex.
/// Used for AS registration `as_token` and `hs_token` fields.
///
/// INS-024 Wave 4: replaces the `CONCORD_PLACEHOLDER_*_TOKEN` strings
/// from Wave 3 with real random values.
fn generate_random_hex_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    hex::encode(bytes)
}

/// Write a file with 0600 mode (owner-only read/write) on Unix. Falls
/// back to a plain write on non-Unix hosts — those hosts never hit the
/// sandbox start path anyway because of the `#[cfg(target_os = "linux")]`
/// gate.
async fn write_file_0600(path: &Path, contents: &[u8]) -> Result<(), TransportError> {
    tokio::fs::write(path, contents).await.map_err(|e| {
        TransportError::StartFailed(format!(
            "failed to write {:?}: {}",
            path, e
        ))
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(path)
            .await
            .map_err(|e| {
                TransportError::StartFailed(format!(
                    "failed to stat {:?}: {}",
                    path, e
                ))
            })?
            .permissions();
        perms.set_mode(0o600);
        tokio::fs::set_permissions(path, perms).await.map_err(|e| {
            TransportError::StartFailed(format!(
                "failed to chmod 0600 {:?}: {}",
                path, e
            ))
        })?;
    }

    Ok(())
}

/// Minimal `which` implementation — walks `PATH` looking for an
/// executable with the given name. Duplicated from `matrix_federation.rs`
/// intentionally to keep the transport modules self-contained.
pub(crate) fn which_in_path(name: &str) -> Option<PathBuf> {
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
    /// `PATH`, `XDG_DATA_HOME`). Cargo runs unit tests on multiple
    /// threads by default within a single process, so concurrent
    /// env-mutation tests will race without this guard.
    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn config_on_port(port: i64) -> ServitudeConfig {
        ServitudeConfig {
            display_name: "test-bridge-node".to_string(),
            max_peers: 16,
            listen_port: port,
            allow_privileged_port: false,
            enabled_transports: vec![
                TransportVariant::MatrixFederation,
                TransportVariant::DiscordBridge,
            ],
        }
    }

    #[test]
    fn test_from_config_captures_matrix_loopback_port() {
        let t = DiscordBridgeTransport::from_config(&config_on_port(9876));
        assert_eq!(t.matrix_loopback_port, 9876);
        assert_eq!(t.matrix_loopback_port(), 9876);
        assert_eq!(t.server_name, "localhost:9876");
        assert_eq!(t.bridge_listen_port, DEFAULT_BRIDGE_PORT);
        assert!(t.child.is_none());
        assert!(t.data_dir.is_none());
        assert!(t.registration_path.is_none());
    }

    #[test]
    fn test_resolve_binary_honours_env_override() {
        let _g = ENV_GUARD.lock().unwrap();
        let self_path = std::env::current_exe().unwrap();
        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &self_path);
        }
        let resolved = DiscordBridgeTransport::resolve_binary()
            .expect("override pointing at current_exe must resolve");
        assert_eq!(resolved, self_path);
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
    }

    #[test]
    fn test_resolve_binary_rejects_broken_override() {
        let _g = ENV_GUARD.lock().unwrap();
        let bogus = PathBuf::from("/tmp/definitely-not-a-real-mautrix-discord-xyz");
        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &bogus);
        }
        let err = DiscordBridgeTransport::resolve_binary()
            .expect_err("bogus override must fail");
        assert!(
            matches!(err, TransportError::BinaryNotFound(_)),
            "expected BinaryNotFound, got {:?}",
            err
        );
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
    }

    #[test]
    fn test_resolve_bwrap_returns_error_when_missing() {
        // Neutralise PATH to guarantee the lookup fails regardless of
        // what the host has installed. Commercial scope requires the
        // refuse-to-start contract, so this test pins that contract.
        let _g = ENV_GUARD.lock().unwrap();
        let saved_path = std::env::var_os("PATH");
        unsafe {
            std::env::set_var("PATH", "");
        }
        let err = DiscordBridgeTransport::resolve_bwrap()
            .expect_err("bwrap must be absent on PATH=''");
        match err {
            TransportError::BinaryNotFound(msg) => {
                // Error message must be actionable so operators know
                // how to fix the problem.
                assert!(
                    msg.contains("bwrap"),
                    "error must mention bwrap: {}",
                    msg
                );
                assert!(
                    msg.contains("bubblewrap"),
                    "error must mention the package name: {}",
                    msg
                );
            }
            other => panic!("expected BinaryNotFound, got {:?}", other),
        }
        if let Some(p) = saved_path {
            unsafe {
                std::env::set_var("PATH", p);
            }
        }
    }

    #[test]
    fn test_env_vars_mirror_docker_compose_keys() {
        let t = DiscordBridgeTransport::from_config(&config_on_port(8765));
        let envs = t.env_vars();
        let keys: Vec<&str> = envs.iter().map(|(k, _)| k.as_str()).collect();
        for required in &[
            "PATH",
            "HOME",
            "TZ",
            "LANG",
            "MAUTRIX_DISCORD_CONFIG",
            "MAUTRIX_DISCORD_REGISTRATION",
        ] {
            assert!(
                keys.contains(required),
                "missing required env var: {}",
                required
            );
        }

        let get = |key: &str| {
            envs.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
                .unwrap()
        };
        // Paths point inside the sandbox, NOT at any host location.
        assert_eq!(get("HOME"), "/data");
        assert_eq!(get("MAUTRIX_DISCORD_CONFIG"), "/data/config.yaml");
        assert_eq!(get("MAUTRIX_DISCORD_REGISTRATION"), "/data/registration.yaml");
        assert_eq!(get("TZ"), "UTC");
    }

    #[tokio::test]
    async fn test_start_fails_when_binary_missing() {
        let _g = ENV_GUARD.lock().unwrap();
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
        let saved_path = std::env::var_os("PATH");
        unsafe {
            std::env::set_var("PATH", "");
        }

        let mut t = DiscordBridgeTransport::from_config(&config_on_port(18765));
        let err = t
            .start()
            .await
            .expect_err("start without binary must fail");
        #[cfg(target_os = "linux")]
        assert!(
            matches!(err, TransportError::BinaryNotFound(_)),
            "expected BinaryNotFound, got {:?}",
            err
        );
        #[cfg(not(target_os = "linux"))]
        assert!(
            matches!(err, TransportError::NotImplemented(_)),
            "non-linux hosts must return NotImplemented, got {:?}",
            err
        );
        assert!(t.child.is_none(), "failed start must leave child as None");

        if let Some(p) = saved_path {
            unsafe {
                std::env::set_var("PATH", p);
            }
        }
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn test_start_fails_when_bwrap_missing_on_linux() {
        let _g = ENV_GUARD.lock().unwrap();

        // Point the binary override at the current test executable
        // so `resolve_binary` succeeds — this isolates the failure
        // path to the `resolve_bwrap` call.
        let self_path = std::env::current_exe().unwrap();
        unsafe {
            std::env::set_var(BIN_OVERRIDE_ENV, &self_path);
        }

        // Kill PATH so `which_in_path("bwrap")` finds nothing.
        let saved_path = std::env::var_os("PATH");
        unsafe {
            std::env::set_var("PATH", "");
        }

        let mut t = DiscordBridgeTransport::from_config(&config_on_port(18766));
        let err = t
            .start()
            .await
            .expect_err("start without bwrap must fail");
        match err {
            TransportError::BinaryNotFound(msg) => {
                assert!(
                    msg.contains("bwrap"),
                    "bwrap missing error must name bwrap: {}",
                    msg
                );
            }
            other => panic!("expected BinaryNotFound for bwrap, got {:?}", other),
        }
        assert!(t.child.is_none(), "failed start must leave child as None");

        // Cleanup.
        unsafe {
            std::env::remove_var(BIN_OVERRIDE_ENV);
        }
        if let Some(p) = saved_path {
            unsafe {
                std::env::set_var("PATH", p);
            }
        }
    }

    #[tokio::test]
    async fn test_stop_when_not_running_reports_not_running() {
        let mut t = DiscordBridgeTransport::from_config(&config_on_port(18767));
        let err = t
            .stop()
            .await
            .expect_err("stop on stopped transport must fail");
        assert!(matches!(err, TransportError::NotRunning));
    }

    #[tokio::test]
    async fn test_is_healthy_false_when_no_child() {
        let t = DiscordBridgeTransport::from_config(&config_on_port(18768));
        assert!(!t.is_healthy().await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_stop_sends_sigterm_to_running_child() {
        // Hold ENV_GUARD for the duration of this test — the
        // `test_resolve_bwrap_returns_error_when_missing` and
        // `test_start_fails_when_binary_missing` tests in this
        // module mutate PATH, and cargo's parallel test runner can
        // race this test against them and leave PATH empty while we
        // try to spawn `sh` below.
        let _g = ENV_GUARD.lock().unwrap();

        use std::process::Stdio;
        use tokio::process::Command;

        // Belt-and-suspenders: spawn sh via an absolute path so the
        // test is robust even to a concurrent test leaving PATH in
        // a weird state. `/bin/sh` is POSIX-mandated and present on
        // every Unix CI host we target.
        let sh_path = if std::path::Path::new("/bin/sh").exists() {
            "/bin/sh"
        } else if std::path::Path::new("/usr/bin/sh").exists() {
            "/usr/bin/sh"
        } else {
            panic!("no sh found at /bin/sh or /usr/bin/sh on unix test host");
        };

        let mut t = DiscordBridgeTransport::from_config(&config_on_port(18769));

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
        assert!(!t.is_healthy().await);

        t.stop().await.expect("stop against sleep must succeed");
        assert!(t.child.is_none(), "post-stop child must be None");

        let err = t.stop().await.expect_err("double-stop must fail");
        assert!(matches!(err, TransportError::NotRunning));
    }

    #[test]
    fn test_build_sandboxed_argv_contains_required_bwrap_flags() {
        let t = DiscordBridgeTransport::from_config(&config_on_port(8765));
        let binary = PathBuf::from("/fake/path/to/mautrix-discord");
        let data_dir = PathBuf::from("/fake/xdg/data/concord/discord-bridge");
        let argv = t.build_sandboxed_argv(&binary, &data_dir);

        // Namespace isolation — every unshare flag must be present.
        for flag in &[
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-cgroup",
        ] {
            assert!(
                argv.iter().any(|a| a == flag),
                "missing namespace flag: {}",
                flag
            );
        }

        // Host wipe + die-with-parent + cap drop.
        assert!(argv.iter().any(|a| a == "--clearenv"));
        assert!(argv.iter().any(|a| a == "--die-with-parent"));
        assert!(argv.iter().any(|a| a == "--new-session"));
        assert!(argv.iter().any(|a| a == "--cap-drop"));
        assert!(argv.iter().any(|a| a == "ALL"));
        assert!(argv.iter().any(|a| a == "--share-net"));

        // /usr is mounted read-only — scan the argv for the exact
        // three-token sequence `--ro-bind /usr /usr` to catch any
        // future refactor that silently drops one of the binds.
        let mut found_usr_ro_bind = false;
        for window in argv.windows(3) {
            if window[0] == "--ro-bind" && window[1] == "/usr" && window[2] == "/usr" {
                found_usr_ro_bind = true;
                break;
            }
        }
        assert!(
            found_usr_ro_bind,
            "expected `--ro-bind /usr /usr` triplet in argv"
        );

        // Every required ro-bind must be present as a triplet.
        for (src, dst) in &[
            ("/lib", "/lib"),
            ("/lib64", "/lib64"),
            ("/etc/ssl", "/etc/ssl"),
            ("/etc/resolv.conf", "/etc/resolv.conf"),
            ("/etc/ca-certificates", "/etc/ca-certificates"),
        ] {
            let mut found = false;
            for window in argv.windows(3) {
                if window[0] == "--ro-bind" && window[1] == *src && window[2] == *dst {
                    found = true;
                    break;
                }
            }
            assert!(
                found,
                "expected `--ro-bind {} {}` triplet in argv",
                src, dst
            );
        }

        // `--` separator must exist and the command after it must be
        // the sandbox-internal binary path, not the host path. We use
        // `/usr/bin/mautrix-discord` (NOT `/usr/local/bin/`) because
        // `/usr/bin` is guaranteed to exist inside the sandbox via the
        // `--ro-bind /usr /usr` triplet above; `/usr/local/bin` is not
        // always present on minimal hosts and would break the launch.
        let sep_idx = argv
            .iter()
            .position(|a| a == "--")
            .expect("missing `--` separator before command");
        assert!(
            sep_idx < argv.len() - 1,
            "`--` separator must not be the last argv entry"
        );
        assert_eq!(argv[sep_idx + 1], "/usr/bin/mautrix-discord");
        assert_eq!(argv[sep_idx + 2], "-c");
        assert_eq!(argv[sep_idx + 3], "/data/config.yaml");
        assert_eq!(argv[sep_idx + 4], "-r");
        assert_eq!(argv[sep_idx + 5], "/data/registration.yaml");

        // Defense-in-depth: the binary must also be ro-bound INTO
        // `/usr/bin/mautrix-discord` so the launch command above
        // actually has a file to execute. Verify the triplet.
        let mut found_binary_rebind = false;
        for window in argv.windows(3) {
            if window[0] == "--ro-bind" && window[2] == "/usr/bin/mautrix-discord" {
                found_binary_rebind = true;
                break;
            }
        }
        assert!(
            found_binary_rebind,
            "expected `--ro-bind <host> /usr/bin/mautrix-discord` triplet in argv"
        );
    }

    #[test]
    fn test_generate_random_hex_token_properties() {
        let t1 = generate_random_hex_token();
        let t2 = generate_random_hex_token();
        // 32 bytes -> 64 hex chars.
        assert_eq!(t1.len(), 64, "token must be 64 hex chars");
        assert_eq!(t2.len(), 64, "token must be 64 hex chars");
        // Tokens must be unique (collision probability negligible).
        assert_ne!(t1, t2, "two generated tokens must be different");
        // Must be valid hex.
        assert!(hex::decode(&t1).is_ok(), "token must be valid hex");
        // Must NOT contain placeholder strings.
        assert!(
            !t1.contains("PLACEHOLDER"),
            "generated token must not contain PLACEHOLDER"
        );
    }

    #[tokio::test]
    async fn test_ensure_config_uses_real_tokens_not_placeholders() {
        let _g = ENV_GUARD.lock().unwrap();
        let scratch = std::env::temp_dir().join(format!(
            "concord-wave4-token-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).expect("create scratch dir");

        let mut t = DiscordBridgeTransport::from_config(&config_on_port(18770));
        t.ensure_config_and_registration(&scratch)
            .await
            .expect("ensure must succeed");

        // Read back the config and registration files.
        let config = std::fs::read_to_string(scratch.join("config.yaml"))
            .expect("config.yaml must exist");
        let reg = std::fs::read_to_string(scratch.join("registration.yaml"))
            .expect("registration.yaml must exist");

        // Placeholder strings MUST NOT appear.
        assert!(
            !config.contains("CONCORD_PLACEHOLDER"),
            "config.yaml must not contain placeholders:\n{}",
            config
        );
        assert!(
            !reg.contains("CONCORD_PLACEHOLDER"),
            "registration.yaml must not contain placeholders:\n{}",
            reg
        );

        // Real hex tokens must be present (64 hex chars).
        // Extract as_token from config.
        let as_line = config
            .lines()
            .find(|l| l.trim().starts_with("as_token:"))
            .expect("config must contain as_token");
        let as_token = as_line.split(':').last().unwrap().trim();
        assert_eq!(as_token.len(), 64, "as_token must be 64 hex chars: {}", as_token);
        assert!(hex::decode(as_token).is_ok(), "as_token must be valid hex");

        // Same tokens in registration.
        let reg_as_line = reg
            .lines()
            .find(|l| l.trim().starts_with("as_token:"))
            .expect("registration must contain as_token");
        let reg_as_token = reg_as_line.split(':').last().unwrap().trim();
        assert_eq!(
            as_token, reg_as_token,
            "config and registration as_token must match"
        );

        // Cleanup.
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn test_build_sandboxed_argv_does_not_leak_host_home() {
        // NEGATIVE test — the whole point of the sandbox is that the
        // bridge cannot see /home. A refactor that accidentally adds
        // `--ro-bind /home /home` or `--bind $HOME /data` would break
        // the blast-radius contract silently. This test makes that
        // regression impossible.
        let t = DiscordBridgeTransport::from_config(&config_on_port(8765));
        let binary = PathBuf::from("/fake/path/to/mautrix-discord");

        // Data dir intentionally placed under `/var/lib` so we catch
        // a bug where the data dir itself ends up under `/home`
        // during resolution. (In production it lives under
        // XDG_DATA_HOME, but the argv-building function takes the
        // data_dir as a parameter so tests can pin it explicitly.)
        let data_dir = PathBuf::from("/var/lib/concord-bridge-test");
        let argv = t.build_sandboxed_argv(&binary, &data_dir);

        for arg in &argv {
            assert!(
                !arg.contains("/home/"),
                "sandbox argv leaked a /home/ path: {:?}",
                arg
            );
            assert!(
                !arg.contains("/home\0"),
                "sandbox argv leaked a /home path: {:?}",
                arg
            );
        }

        // Double-check: even with data_dir explicitly set to a
        // /home/... path (what would happen if XDG_DATA_HOME was
        // unset and HOME fallback kicked in), the argv still MUST
        // contain the data dir because it's bind-mounted to /data.
        // That bind target is `/data`, so the HOST path `/home/...`
        // appears in argv as a `--bind` source — but only ONCE, and
        // the sandbox's internal path is `/data`, never `/home`.
        let home_like = PathBuf::from("/home/example/.local/share/concord/discord-bridge");
        let argv_with_home_src = t.build_sandboxed_argv(&binary, &home_like);
        // The host-side data dir string is ALLOWED to contain /home
        // (it's the user's XDG path) — but it must appear exactly
        // once (as the --bind source) and nothing else in argv may
        // reference /home. This keeps the bind target fixed at
        // /data and catches any accidental /home dual-mount.
        let home_count = argv_with_home_src
            .iter()
            .filter(|a| a.contains("/home/"))
            .count();
        assert_eq!(
            home_count, 1,
            "exactly one /home/ reference allowed (the bind source), \
             got {}: {:?}",
            home_count, argv_with_home_src
        );
        // And that one reference must be followed by `/data`, not
        // `/home`.
        let idx = argv_with_home_src
            .iter()
            .position(|a| a.contains("/home/"))
            .unwrap();
        assert_eq!(
            argv_with_home_src[idx + 1], "/data",
            "host /home/... dir must be bind-mounted to /data inside \
             sandbox, not to a /home path"
        );
    }
}
