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
}
