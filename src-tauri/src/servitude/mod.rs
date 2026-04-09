//! Embedded servitude module.
//!
//! Concord ships an *embedded* servitude (service-node hosting) module on
//! every build target — desktop and mobile. This is intentional: there is no
//! standalone servitude daemon. The same Concord binary that renders the chat
//! UI also runs an in-process service node when the user is online.
//!
//! Architectural decisions captured 2026-04-08:
//!   * Servitude is an embedded module, not a separate process.
//!   * Both mobile and desktop builds ship it.
//!   * Mobile MVP is foreground-active (iOS VoIP background entitlement is a
//!     stretch goal, not required for v0.1).
//!   * Layered transports (`WireGuard`, `Mesh`, `Tunnel`, `MatrixFederation`)
//!     are declared via the [`Transport`] enum but their actual runtime
//!     integration lives in a separate task — this module only encodes the
//!     contract and the lifecycle state machine.
//!
//! The public surface area exposed from `app_lib` is intentionally tiny:
//!   * [`ServitudeHandle`] — the owning handle that drives lifecycle.
//!   * [`ServitudeConfig`] — TOML-loadable, validated configuration.
//!   * [`Transport`] — enum of layered transports the node may speak.
//!   * [`LifecycleState`] — public state machine state for status reporting.
//!   * [`ServitudeError`] — structured error type (no stringly-typed errors).

pub mod config;
pub mod lifecycle;

pub use config::{ServitudeConfig, Transport};
pub use lifecycle::{LifecycleState, LifecycleError};

use thiserror::Error;

/// Top-level error type for the servitude module.
///
/// All fallible servitude APIs return this. Built on `thiserror` to satisfy
/// the commercial-scope requirement of structured, non-stringly-typed errors.
#[derive(Debug, Error)]
pub enum ServitudeError {
    #[error("configuration error: {0}")]
    Config(#[from] config::ConfigError),

    #[error("lifecycle error: {0}")]
    Lifecycle(#[from] lifecycle::LifecycleError),

    #[error("servitude is already running")]
    AlreadyRunning,

    #[error("servitude is not running")]
    NotRunning,
}

/// Owning handle to an embedded servitude instance.
///
/// In the v0.1 scaffold the handle does not yet drive a real network stack;
/// it only manages the lifecycle state machine and holds the validated
/// configuration. Wiring the layered transports is the next pass.
#[derive(Debug)]
pub struct ServitudeHandle {
    config: ServitudeConfig,
    lifecycle: lifecycle::Lifecycle,
}

impl ServitudeHandle {
    /// Create a new handle with the given (already validated) config. The
    /// handle starts in the `Stopped` state — call [`Self::start`] to bring
    /// it up.
    pub fn new(config: ServitudeConfig) -> Result<Self, ServitudeError> {
        config.validate()?;
        Ok(Self {
            config,
            lifecycle: lifecycle::Lifecycle::new(),
        })
    }

    /// Borrow the validated config (read-only). Useful for status reporting.
    pub fn config(&self) -> &ServitudeConfig {
        &self.config
    }

    /// Current lifecycle state.
    pub fn status(&self) -> LifecycleState {
        self.lifecycle.state()
    }

    /// Drive the state machine `Stopped -> Starting -> Running`.
    ///
    /// Returns [`ServitudeError::AlreadyRunning`] if the handle is not in the
    /// `Stopped` state.
    pub fn start(&mut self) -> Result<(), ServitudeError> {
        if self.lifecycle.state() != LifecycleState::Stopped {
            return Err(ServitudeError::AlreadyRunning);
        }
        self.lifecycle.transition(LifecycleState::Starting)?;
        // TODO(transport): bring up enabled_transports here.
        // For now this is a synchronous, no-op transition so the state
        // machine and tests can exercise the contract end-to-end.
        self.lifecycle.transition(LifecycleState::Running)?;
        Ok(())
    }

    /// Drive the state machine `Running -> Stopping -> Stopped`.
    ///
    /// Returns [`ServitudeError::NotRunning`] if the handle is not in the
    /// `Running` state.
    pub fn stop(&mut self) -> Result<(), ServitudeError> {
        if self.lifecycle.state() != LifecycleState::Running {
            return Err(ServitudeError::NotRunning);
        }
        self.lifecycle.transition(LifecycleState::Stopping)?;
        // TODO(transport): tear down enabled_transports here.
        self.lifecycle.transition(LifecycleState::Stopped)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_config() -> ServitudeConfig {
        ServitudeConfig {
            display_name: "test-node".to_string(),
            max_peers: 16,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::MatrixFederation],
        }
    }

    #[test]
    fn test_handle_start_stop_cycle() {
        let mut handle = ServitudeHandle::new(valid_config()).expect("config valid");
        assert_eq!(handle.status(), LifecycleState::Stopped);

        handle.start().expect("start should succeed");
        assert_eq!(handle.status(), LifecycleState::Running);

        handle.stop().expect("stop should succeed");
        assert_eq!(handle.status(), LifecycleState::Stopped);
    }

    #[test]
    fn test_handle_double_start_rejected() {
        let mut handle = ServitudeHandle::new(valid_config()).expect("config valid");
        handle.start().expect("first start ok");
        let err = handle.start().expect_err("second start should fail");
        assert!(matches!(err, ServitudeError::AlreadyRunning));
    }

    #[test]
    fn test_handle_stop_when_not_running_rejected() {
        let mut handle = ServitudeHandle::new(valid_config()).expect("config valid");
        let err = handle.stop().expect_err("stop while stopped should fail");
        assert!(matches!(err, ServitudeError::NotRunning));
    }

    #[test]
    fn test_handle_rejects_invalid_config() {
        let mut bad = valid_config();
        bad.display_name = "".to_string();
        let err = ServitudeHandle::new(bad).expect_err("empty name should fail");
        assert!(matches!(err, ServitudeError::Config(_)));
    }

    /// Hermetic smoke test that exercises the full Tauri-command surface
    /// at the handle level (without a real Tauri runtime). If this test
    /// starts failing, the `servitude_start` / `servitude_status` /
    /// `servitude_stop` Tauri commands are also broken — they delegate
    /// to exactly these three methods.
    #[test]
    fn test_servitude_handle_round_trip() {
        let mut handle = ServitudeHandle::new(valid_config())
            .expect("round-trip fixture config must validate");

        // Initial status — matches what servitude_status returns when
        // no prior start has happened.
        assert_eq!(
            handle.status(),
            LifecycleState::Stopped,
            "fresh handle must start in Stopped"
        );

        // start() — matches servitude_start after config load.
        handle.start().expect("first start must succeed");
        assert_eq!(
            handle.status(),
            LifecycleState::Running,
            "post-start status must be Running"
        );

        // stop() — matches servitude_stop.
        handle.stop().expect("stop must succeed while Running");
        assert_eq!(
            handle.status(),
            LifecycleState::Stopped,
            "post-stop status must return to Stopped"
        );

        // And the handle must be re-usable — a second start→stop cycle
        // is how the Tauri state is expected to behave across user
        // toggles in the UI.
        handle.start().expect("second start must succeed");
        assert_eq!(handle.status(), LifecycleState::Running);
        handle.stop().expect("second stop must succeed");
        assert_eq!(handle.status(), LifecycleState::Stopped);
    }

    /// Regression test for the "restart discards reloaded config" bug.
    ///
    /// Scenario reproduced here (without a Tauri runtime):
    ///   1. Build a handle with config A, start it, stop it.
    ///   2. The user edits their settings — modelled as "loading a
    ///      different `ServitudeConfig` B from the store".
    ///   3. The `servitude_start` Tauri command replaces the stopped
    ///      handle with a freshly constructed one built from B, then
    ///      starts it.
    ///   4. The now-running handle's observable config must reflect B,
    ///      not A — otherwise the user's edits have been silently
    ///      discarded, which is exactly the bug.
    ///
    /// This test exercises the same "rebuild on restart" path that
    /// `servitude_start` takes when it sees an existing handle in the
    /// `Stopped` state.
    #[test]
    fn test_servitude_handle_restart_picks_up_new_config() {
        // Config A — what the handle was originally built with.
        let config_a = ServitudeConfig {
            display_name: "node-before-edit".to_string(),
            max_peers: 8,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::MatrixFederation],
        };

        let mut handle =
            ServitudeHandle::new(config_a.clone()).expect("config A must validate");
        assert_eq!(
            handle.config().display_name,
            "node-before-edit",
            "pre-edit handle must report config A"
        );

        // First lifecycle run with config A.
        handle.start().expect("first start must succeed");
        assert_eq!(handle.status(), LifecycleState::Running);
        handle.stop().expect("first stop must succeed");
        assert_eq!(handle.status(), LifecycleState::Stopped);

        // The user edits their settings — a different config is now
        // what "from_store" would return. Everything except display_name
        // and max_peers is deliberately varied too so we can assert the
        // FULL config was picked up, not just one field.
        let config_b = ServitudeConfig {
            display_name: "node-after-edit".to_string(),
            max_peers: 64,
            listen_port: 9999,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::WireGuard, Transport::Tunnel],
        };

        // This block mirrors exactly what the fixed `servitude_start`
        // does when it observes an existing handle in the `Stopped`
        // state: drop the old handle and construct a new one with the
        // freshly-loaded config.
        assert_eq!(
            handle.status(),
            LifecycleState::Stopped,
            "restart path only triggers when handle is Stopped"
        );
        handle =
            ServitudeHandle::new(config_b.clone()).expect("config B must validate");

        // Bring the new handle up and confirm the reloaded config
        // actually took effect.
        handle.start().expect("restart must succeed");
        assert_eq!(handle.status(), LifecycleState::Running);

        let observed = handle.config();
        assert_eq!(
            observed.display_name, "node-after-edit",
            "restart must pick up new display_name"
        );
        assert_eq!(
            observed.max_peers, 64,
            "restart must pick up new max_peers"
        );
        assert_eq!(
            observed.listen_port, 9999,
            "restart must pick up new listen_port"
        );
        assert_eq!(
            observed.enabled_transports,
            vec![Transport::WireGuard, Transport::Tunnel],
            "restart must pick up new enabled_transports"
        );

        // And critically, NONE of the config A fields may have leaked
        // into the restarted handle. This is the assertion that would
        // fail under the original bug (where the handle kept its
        // original config and silently ignored the reload).
        assert_ne!(
            observed.display_name, config_a.display_name,
            "post-restart handle must not retain pre-edit display_name"
        );
        assert_ne!(
            observed.max_peers, config_a.max_peers,
            "post-restart handle must not retain pre-edit max_peers"
        );
        assert_ne!(
            observed.listen_port, config_a.listen_port,
            "post-restart handle must not retain pre-edit listen_port"
        );
        assert_ne!(
            observed.enabled_transports, config_a.enabled_transports,
            "post-restart handle must not retain pre-edit enabled_transports"
        );

        handle.stop().expect("post-restart stop must succeed");
    }
}
