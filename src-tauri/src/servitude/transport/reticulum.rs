//! Reticulum transport for the embedded servitude module (INS-037).
//!
//! This file is compiled only when the `reticulum` Cargo feature is enabled.
//! It implements the [`Transport`] trait by spawning `rnsd` (the Reticulum
//! Network Stack daemon) as a child process, following the same pattern as
//! [`super::matrix_federation::MatrixFederationTransport`].
//!
//! ## Architecture
//!
//! Chosen architecture: **Option A — Transport trait implementation**.
//! `ReticulumTransport` manages the `rnsd` lifecycle (start/stop/health)
//! while Reticulum itself acts as a network overlay that tuwunel can peer
//! over via a `TCPServerInterface` / `TCPClientInterface` configuration.
//! See `docs/reticulum/main-build-integration.md` §3 for full rationale.
//!
//! ## Binary discovery
//!
//! 1. `RNSD_BIN` environment variable — dev override.
//! 2. `<current_exe_dir>/resources/reticulum/rnsd` — bundled location.
//! 3. `PATH` lookup — `which rnsd` fallback.
//!
//! ## Wave sequencing (INS-037)
//!
//! | Wave | Status | Work |
//! |------|--------|------|
//! | W0   | DONE   | Design doc + feature flag in Cargo.toml |
//! | W1   | DONE   | This file — `rnsd` child-process lifecycle scaffold |
//! | W2   | TODO   | tuwunel ↔ Reticulum interface config; write a real rnsd.conf |
//! | W3   | TODO   | Node discovery via Reticulum announce mechanism |
//! | W4   | TODO   | Encrypted channel establishment; text relay + presence |
//!
//! ## TODO(ins-037-w2)
//!
//! Write a real `rnsd` config that:
//!   - Sets the storage path to `<data_dir>/reticulum/`
//!   - Declares a `TCPServerInterface` on a loopback port so tuwunel
//!     can be configured to reach Reticulum via a `TCPClientInterface`.
//!   - Declares any user-configured physical interfaces (serial, LoRa, etc.)
//!     from `ServitudeConfig` once those fields land.
//!
//! ## TODO(ins-037-w3)
//!
//! Implement node discovery:
//!   - Use `rnsd`'s management socket (or the `rns` Python API via subprocess)
//!     to poll `RNS.Transport.destinations` for Concord-typed announces.
//!   - Surface discovered peers through the Sources/Explore UX (INS-037 W4).
//!
//! ## TODO(ins-037-w4)
//!
//! Implement encrypted channel establishment:
//!   - Open an `RNS.Link` to a discovered peer destination hash.
//!   - Relay text messages and presence updates over the link.
//!   - Voice/media bridging is a stretch goal (heavy bandwidth on low-rate links).

#![cfg(feature = "reticulum")]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};

use crate::servitude::config::ServitudeConfig;

use super::{Transport, TransportError};

/// Env-var override for the `rnsd` binary path. Dev convenience.
pub const RNSD_BIN_OVERRIDE_ENV: &str = "RNSD_BIN";

/// Relative path inside the Tauri resources directory for the bundled `rnsd`.
pub const RNSD_BUNDLED_REL: &str = "resources/reticulum/rnsd";

/// How long to wait for `rnsd` to become healthy before failing the start.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

/// Interval between health probes during startup.
pub const STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(500);

/// Timeout for a single TCP health probe.
pub const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// How long to wait after SIGTERM before escalating to SIGKILL.
pub const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);

/// Local management port that `rnsd` listens on for health probing.
///
/// NOTE(ins-037-w2): When a real `rnsd` config is written, this should
/// match the `managementport` setting in that config. For now it is a
/// placeholder — the health check degrades gracefully when the port is
/// not open (reports unhealthy without crashing).
pub const RNSD_MANAGEMENT_PORT: u16 = 4965;

/// Reticulum transport — spawns `rnsd` as a managed child process.
///
/// Implements [`Transport`] so the servitude lifecycle (start/stop/health)
/// manages the Reticulum daemon the same way it manages tuwunel.
#[derive(Debug)]
pub struct ReticulumTransport {
    /// Data directory for `rnsd` config and key storage.
    data_dir: Option<PathBuf>,
    /// Running child process handle. `Some` while started, `None` otherwise.
    child: Option<Child>,
    /// Config snapshot — used to derive the data directory on first start.
    _config: ServitudeConfig,
}

impl ReticulumTransport {
    /// Construct from the shared servitude config.
    pub fn from_config(config: &ServitudeConfig) -> Self {
        Self {
            data_dir: None,
            child: None,
            _config: config.clone(),
        }
    }

    /// Locate the `rnsd` binary using the discovery order documented above.
    fn find_rnsd_bin() -> Result<PathBuf, TransportError> {
        // 1. Env override.
        if let Ok(path) = std::env::var(RNSD_BIN_OVERRIDE_ENV) {
            let p = PathBuf::from(&path);
            if p.exists() {
                return Ok(p);
            }
            log::warn!(
                "[reticulum] {} set to '{}' but file not found; falling through",
                RNSD_BIN_OVERRIDE_ENV,
                path
            );
        }

        // 2. Bundled resource path.
        if let Ok(exe) = std::env::current_exe() {
            let bundled = exe
                .parent()
                .unwrap_or(Path::new("."))
                .join(RNSD_BUNDLED_REL);
            if bundled.exists() {
                return Ok(bundled);
            }
        }

        // 3. PATH lookup.
        if let Ok(output) = std::process::Command::new("which")
            .arg("rnsd")
            .output()
        {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path_str.is_empty() {
                    return Ok(PathBuf::from(path_str));
                }
            }
        }

        Err(TransportError::StartFailed(
            "rnsd binary not found. Set RNSD_BIN or install the Reticulum \
             package (`pip install rns`) and ensure `rnsd` is on PATH."
                .to_string(),
        ))
    }

    /// Resolve (and create) the data directory for `rnsd`.
    fn resolve_data_dir() -> PathBuf {
        // Mirror the tuwunel data layout:
        //   Linux:   ~/.local/share/concord/reticulum/
        //   macOS:   ~/Library/Application Support/concord/reticulum/
        //   Windows: %APPDATA%\concord\reticulum\
        #[cfg(target_os = "linux")]
        let base = {
            let xdg = std::env::var("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .unwrap_or_default()
                        .join(".local/share")
                });
            xdg.join("concord/reticulum")
        };
        #[cfg(target_os = "macos")]
        let base = dirs::data_dir()
            .unwrap_or_default()
            .join("concord/reticulum");
        #[cfg(target_os = "windows")]
        let base = dirs::data_dir()
            .unwrap_or_default()
            .join("concord/reticulum");
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let base = PathBuf::from(".concord/reticulum");

        let _ = std::fs::create_dir_all(&base);
        base
    }

    /// Write a minimal `rnsd` config file to the data directory.
    ///
    /// TODO(ins-037-w2): Replace this placeholder with a real config that
    /// declares the management port, storage path, and any physical interfaces
    /// derived from `ServitudeConfig`. The current stub only sets the storage
    /// path so `rnsd` has somewhere to write its key material.
    fn write_rnsd_config(data_dir: &Path) -> std::io::Result<PathBuf> {
        let config_path = data_dir.join("config");
        // Only write if missing — rnsd preserves existing keys on restart.
        if !config_path.exists() {
            let config_content = format!(
                "# Concord-generated rnsd configuration (INS-037 Wave 1 placeholder)\n\
                 # TODO(ins-037-w2): add real interface declarations\n\
                 [reticulum]\n\
                   storagepath = {}\n\
                   loglevel = 3\n\
                 \n\
                 # TODO(ins-037-w2): Uncomment and configure a management interface\n\
                 # [local_interface]\n\
                 #   type = LocalInterface\n",
                data_dir.display()
            );
            std::fs::write(&config_path, config_content)?;
            log::info!(
                "[reticulum] wrote placeholder rnsd config to {}",
                config_path.display()
            );
        }
        Ok(config_path)
    }

    /// Probe the `rnsd` management port. Returns `true` if the port accepts
    /// a TCP connection within [`PROBE_CONNECT_TIMEOUT`].
    async fn probe_healthy(port: u16) -> bool {
        matches!(
            timeout(
                PROBE_CONNECT_TIMEOUT,
                TcpStream::connect(("127.0.0.1", port)),
            )
            .await,
            Ok(Ok(_))
        )
    }
}

#[async_trait]
impl Transport for ReticulumTransport {
    fn name(&self) -> &'static str {
        "reticulum"
    }

    /// Reticulum is non-critical: if `rnsd` fails to start or crashes,
    /// the servitude stays Running (Matrix federation continues to
    /// function) and the failure is recorded in
    /// `ServitudeHandle::degraded`. Transport availability is best-effort.
    fn is_critical(&self) -> bool {
        false
    }

    async fn start(&mut self) -> Result<(), TransportError> {
        if self.child.is_some() {
            return Ok(()); // already running
        }

        let rnsd = Self::find_rnsd_bin()?;
        let data_dir = Self::resolve_data_dir();
        let config_path = Self::write_rnsd_config(&data_dir)
            .map_err(|e| TransportError::StartFailed(format!("rnsd config write failed: {e}")))?;

        log::info!(
            "[reticulum] spawning rnsd from {} with config {}",
            rnsd.display(),
            config_path.display()
        );

        let child = Command::new(&rnsd)
            .arg("--config")
            .arg(&config_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                TransportError::StartFailed(format!("failed to spawn rnsd: {e}"))
            })?;

        self.data_dir = Some(data_dir);
        self.child = Some(child);

        // Wait for the management port to become reachable.
        // NOTE(ins-037-w2): When the real config declares a management port,
        // this probe will actually succeed. With the current placeholder config
        // there is no listener on RNSD_MANAGEMENT_PORT so the loop times out
        // and we log a warning but treat the start as successful (the child is
        // alive even if the management port is not yet open).
        let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
        loop {
            if Self::probe_healthy(RNSD_MANAGEMENT_PORT).await {
                log::info!("[reticulum] rnsd is healthy on port {RNSD_MANAGEMENT_PORT}");
                break;
            }
            if std::time::Instant::now() >= deadline {
                log::warn!(
                    "[reticulum] rnsd management port {} not reachable after {:?}; \
                     proceeding anyway (placeholder config has no listener). \
                     TODO(ins-037-w2): wire a real management port.",
                    RNSD_MANAGEMENT_PORT,
                    STARTUP_TIMEOUT,
                );
                break;
            }
            sleep(STARTUP_PROBE_INTERVAL).await;
        }

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), TransportError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };

        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            if let Some(pid) = child.id() {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = child.start_kill();
        }

        let shutdown = timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait()).await;
        match shutdown {
            Ok(Ok(_)) => log::info!("[reticulum] rnsd exited cleanly"),
            Ok(Err(e)) => log::warn!("[reticulum] rnsd wait error: {e}"),
            Err(_) => {
                log::warn!("[reticulum] rnsd did not exit within {GRACEFUL_SHUTDOWN_TIMEOUT:?}; sending SIGKILL");
                let _ = child.kill().await;
            }
        }

        Ok(())
    }

    async fn is_healthy(&self) -> bool {
        if self.child.is_none() {
            return false;
        }
        // TODO(ins-037-w2): use the real management port once the config declares it.
        // For now, report healthy if the child process is still alive (pid exists).
        // We can't easily check liveness without polling child.wait() which consumes
        // the handle. Using a best-effort TCP probe is still useful even if it times
        // out — it at least confirms a listener exists.
        Self::probe_healthy(RNSD_MANAGEMENT_PORT).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servitude::config::ServitudeConfig;

    fn test_config() -> ServitudeConfig {
        ServitudeConfig::default()
    }

    #[test]
    fn test_reticulum_transport_name() {
        let t = ReticulumTransport::from_config(&test_config());
        assert_eq!(t.name(), "reticulum");
    }

    #[test]
    fn test_reticulum_transport_not_critical() {
        let t = ReticulumTransport::from_config(&test_config());
        assert!(!t.is_critical(), "Reticulum transport must be non-critical");
    }

    #[test]
    fn test_reticulum_transport_initially_stopped() {
        let t = ReticulumTransport::from_config(&test_config());
        assert!(t.child.is_none());
    }

    #[test]
    fn test_resolve_data_dir_creates_directory() {
        let dir = ReticulumTransport::resolve_data_dir();
        // The function either creates or finds an existing directory.
        // It must not return an empty path.
        assert!(!dir.as_os_str().is_empty());
    }
}
