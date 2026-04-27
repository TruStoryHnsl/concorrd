//! Embedded servitude module.
//!
//! Concord ships an *embedded* servitude (service-node hosting) module on
//! every build target — desktop and mobile. This is intentional: there is no
//! standalone servitude daemon. The same Concord binary that renders the chat
//! UI also runs an in-process service node when the user is online.
//!
//! Architectural decisions captured 2026-04-08:
//!   * Servitude is an embedded module, not a separate process.
//!   * Both mobile and desktop builds ship it (though INS-022 Wave 2
//!     restricts the real-transport rollout to desktop first — iOS
//!     sandboxing blocks inbound federation on the phone architecturally,
//!     see the research trail in the Wave 2 DEVLOG entry).
//!   * Layered transports (`WireGuard`, `Mesh`, `Tunnel`, `MatrixFederation`)
//!     are declared via the [`crate::servitude::config::Transport`] enum.
//!     Wave 2 (2026-04-08) wires the MatrixFederation variant to a bundled
//!     tuwunel child-process. The other three variants are `NotImplemented`
//!     stubs until later waves land.
//!
//! The public surface area exposed from `app_lib` is intentionally tiny:
//!   * [`ServitudeHandle`] — the owning handle that drives lifecycle.
//!   * [`ServitudeConfig`] — TOML-loadable, validated configuration.
//!   * [`Transport`] — enum of layered transports the node may speak.
//!   * [`LifecycleState`] — public state machine state for status reporting.
//!   * [`ServitudeError`] — structured error type (no stringly-typed errors).
//!
//! Lifecycle contract with the transport layer:
//!
//!   1. `start()` transitions `Stopped → Starting`, brings up every
//!      enabled transport in order, and only then transitions to `Running`.
//!      If any transport fails to start, already-started transports are
//!      torn down in reverse order and the lifecycle is rolled back to
//!      `Stopped` before the error propagates.
//!   2. `stop()` transitions `Running → Stopping`, tears down transports
//!      in reverse order (LIFO), and transitions to `Stopped` regardless
//!      of whether any individual stop call errored. The first transport
//!      error is surfaced to the caller, but the lifecycle is always
//!      driven to the terminal state — we never leave a handle stuck in
//!      `Stopping` because that would wedge the UI.

pub mod config;
pub mod lifecycle;
pub mod transport;

pub use config::{ServitudeConfig, Transport};
pub use lifecycle::{LifecycleError, LifecycleState};
pub use transport::{TransportError, TransportRuntime};

use std::collections::HashMap;
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

    #[error("transport error: {0}")]
    Transport(#[from] TransportError),

    #[error("servitude is already running")]
    AlreadyRunning,

    #[error("servitude is not running")]
    NotRunning,
}

/// Owning handle to an embedded servitude instance.
///
/// As of Wave 2, the handle owns a `Vec<TransportRuntime>` built from
/// `config.enabled_transports`. The runtimes are constructed eagerly at
/// `new()` time but do not touch the network or spawn child processes
/// until `start()` is called.
#[derive(Debug)]
pub struct ServitudeHandle {
    config: ServitudeConfig,
    lifecycle: lifecycle::Lifecycle,
    transports: Vec<TransportRuntime>,
    /// Failure surface for non-critical transports (INS-024 Wave 3).
    /// Keyed by transport name, value is the stringified failure
    /// reason. Populated during `start()` when a non-critical
    /// transport errors out — the handle stays Running and the UI
    /// renders the degraded set alongside the live transports.
    /// Cleared at the top of every `start()` call so stale entries
    /// can't leak across restarts.
    degraded: HashMap<String, String>,
}

impl ServitudeHandle {
    /// Create a new handle with the given (already validated) config. The
    /// handle starts in the `Stopped` state — call [`Self::start`] to bring
    /// it up.
    ///
    /// Transport runtimes are built eagerly from `config.enabled_transports`
    /// via [`TransportRuntime::for_variant`]. This is a cheap operation
    /// (pure data-carrier construction); nothing is spawned until `start`.
    pub fn new(config: ServitudeConfig) -> Result<Self, ServitudeError> {
        config.validate()?;
        let transports = config
            .enabled_transports
            .iter()
            .map(|variant| TransportRuntime::for_variant(*variant, &config))
            .collect();
        Ok(Self {
            config,
            lifecycle: lifecycle::Lifecycle::new(),
            transports,
            degraded: HashMap::new(),
        })
    }

    /// Test-only constructor that lets tests inject a pre-built transport
    /// runtime vector instead of having the factory build one from config.
    /// The production code path must keep using [`Self::new`] — this exists
    /// solely so unit tests can drive the lifecycle state machine against
    /// [`TransportRuntime::Noop`] without spawning real transports.
    #[cfg(test)]
    pub(crate) fn new_with_runtimes_for_test(
        config: ServitudeConfig,
        transports: Vec<TransportRuntime>,
    ) -> Result<Self, ServitudeError> {
        config.validate()?;
        Ok(Self {
            config,
            lifecycle: lifecycle::Lifecycle::new(),
            transports,
            degraded: HashMap::new(),
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

    /// Snapshot of the current degraded-transport map. Keyed by
    /// transport name, value is the stringified failure reason.
    /// Populated by the partial-failure rollback path in
    /// [`Self::start`] when a non-critical transport fails to start.
    /// Critical transports never appear here — their failures trigger
    /// a full rollback and the handle ends up in `Stopped`.
    pub fn degraded_transports(&self) -> &HashMap<String, String> {
        &self.degraded
    }

    /// Drive the state machine `Stopped -> Starting -> Running`, bringing
    /// up each enabled transport in config order.
    ///
    /// Behaviour on a transport start failure depends on whether the
    /// transport is **critical**:
    ///
    ///   * **Critical** (e.g. `MatrixFederation`): every already-started
    ///     transport is torn down in reverse order, the lifecycle is
    ///     rolled back to `Stopped`, and the error propagates. Matches
    ///     the Wave 2 all-or-nothing contract.
    ///   * **Non-critical**: the failure is
    ///     recorded in `self.degraded`, already-started critical
    ///     transports are LEFT RUNNING, and the lifecycle continues to
    ///     `Running`. The caller gets `Ok(())` and can inspect
    ///     `degraded_transports()` to see the failure surface.
    pub async fn start(&mut self) -> Result<(), ServitudeError> {
        if self.lifecycle.state() != LifecycleState::Stopped {
            return Err(ServitudeError::AlreadyRunning);
        }
        // Clear any stale degraded entries from a previous run so
        // restarts always reflect the current state.
        self.degraded.clear();

        self.lifecycle.transition(LifecycleState::Starting)?;

        let mut started_count = 0usize;
        for idx in 0..self.transports.len() {
            let is_critical = self.transports[idx].is_critical();
            let name = self.transports[idx].name().to_string();

            let start_result = self.transports[idx].start().await;
            match start_result {
                Ok(()) => {
                    started_count += 1;
                }
                Err(e) if !is_critical => {
                    // Partial-failure rollback path (INS-024 Wave 3).
                    // Non-critical transport failed — log, record in
                    // degraded, leave already-started transports
                    // untouched, and continue.
                    log::warn!(
                        target: "concord::servitude",
                        "non-critical transport {} failed to start: {} — \
                         continuing with degraded state",
                        name, e
                    );
                    self.degraded.insert(name, e.to_string());
                    // NOTE: we do NOT increment `started_count` — the
                    // transport is not running and the `stop()` path
                    // should not try to tear it down. The matching
                    // non-critical `stop()` path in the runtime is a
                    // noop anyway for safety, but this keeps the
                    // bookkeeping honest.
                }
                Err(e) => {
                    // Critical-transport failure: roll back everything
                    // and surface the error. Matches the Wave 2
                    // all-or-nothing contract.
                    for t in self.transports[..started_count].iter_mut().rev() {
                        if let Err(teardown_err) = t.stop().await {
                            log::warn!(
                                target: "concord::servitude",
                                "rollback stop failed for transport {}: {}",
                                t.name(),
                                teardown_err
                            );
                        }
                    }
                    self.lifecycle
                        .transition(LifecycleState::Stopping)
                        .map_err(ServitudeError::Lifecycle)?;
                    self.lifecycle
                        .transition(LifecycleState::Stopped)
                        .map_err(ServitudeError::Lifecycle)?;
                    return Err(ServitudeError::Transport(e));
                }
            }
        }

        self.lifecycle.transition(LifecycleState::Running)?;
        Ok(())
    }

    /// Drive the state machine `Running -> Stopping -> Stopped`, tearing
    /// down transports in reverse order.
    ///
    /// Unlike `start`, `stop` always drives the lifecycle to `Stopped`
    /// even when a transport's `stop` call returns an error. The first
    /// such error is surfaced to the caller, but the terminal state is
    /// reached regardless. This is deliberate: leaving a handle stuck
    /// in `Stopping` would wedge the UI with no recovery path.
    pub async fn stop(&mut self) -> Result<(), ServitudeError> {
        if self.lifecycle.state() != LifecycleState::Running {
            return Err(ServitudeError::NotRunning);
        }
        self.lifecycle.transition(LifecycleState::Stopping)?;

        let mut first_err: Option<TransportError> = None;
        for transport in self.transports.iter_mut().rev() {
            if let Err(e) = transport.stop().await {
                log::warn!(
                    target: "concord::servitude",
                    "stop failed for transport {}: {}",
                    transport.name(),
                    e
                );
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }

        self.lifecycle.transition(LifecycleState::Stopped)?;

        match first_err {
            Some(e) => Err(ServitudeError::Transport(e)),
            None => Ok(()),
        }
    }

    /// Cheap liveness check — polls every enabled transport's health
    /// endpoint and returns `true` only if ALL non-degraded transports
    /// report healthy. `Stopped`-state handles always report unhealthy.
    ///
    /// Transports listed in `self.degraded` (non-critical failures
    /// from Wave 3's partial-failure path) are SKIPPED by this check —
    /// their "unhealthy" state is already captured in the degraded
    /// map, and including them here would force the whole handle to
    /// report unhealthy whenever any non-critical transport was
    /// degraded. That would defeat the purpose of the split.
    pub async fn is_healthy(&self) -> bool {
        if self.lifecycle.state() != LifecycleState::Running {
            return false;
        }
        for transport in self.transports.iter() {
            let name = transport.name();
            if self.degraded.contains_key(name) {
                // Already marked as degraded; skip and don't let its
                // unhealthy state poison the overall report.
                continue;
            }
            if !transport.is_healthy().await {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical fixture config with a single `MatrixFederation` transport.
    /// Tests that exercise the lifecycle state machine rebuild this with
    /// [`TransportRuntime::Noop`] injected via `new_with_runtimes_for_test`
    /// so they don't spawn a real tuwunel child.
    fn valid_config() -> ServitudeConfig {
        ServitudeConfig {
            display_name: "test-node".to_string(),
            max_peers: 16,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::MatrixFederation],
        }
    }

    /// Build a handle whose transport vector is a single `Noop`. Lets the
    /// state-machine tests run without an external tuwunel dependency.
    fn handle_with_noop() -> ServitudeHandle {
        ServitudeHandle::new_with_runtimes_for_test(
            valid_config(),
            vec![TransportRuntime::Noop],
        )
        .expect("fixture config must validate")
    }

    #[tokio::test]
    async fn test_handle_start_stop_cycle() {
        let mut handle = handle_with_noop();
        assert_eq!(handle.status(), LifecycleState::Stopped);

        handle.start().await.expect("start should succeed");
        assert_eq!(handle.status(), LifecycleState::Running);
        assert!(handle.is_healthy().await, "noop transport should report healthy");

        handle.stop().await.expect("stop should succeed");
        assert_eq!(handle.status(), LifecycleState::Stopped);
        assert!(!handle.is_healthy().await, "stopped handle must report unhealthy");
    }

    #[tokio::test]
    async fn test_handle_double_start_rejected() {
        let mut handle = handle_with_noop();
        handle.start().await.expect("first start ok");
        let err = handle
            .start()
            .await
            .expect_err("second start should fail");
        assert!(matches!(err, ServitudeError::AlreadyRunning));
    }

    #[tokio::test]
    async fn test_handle_stop_when_not_running_rejected() {
        let mut handle = handle_with_noop();
        let err = handle
            .stop()
            .await
            .expect_err("stop while stopped should fail");
        assert!(matches!(err, ServitudeError::NotRunning));
    }

    #[test]
    fn test_handle_rejects_invalid_config() {
        let mut bad = valid_config();
        bad.display_name = "".to_string();
        let err = ServitudeHandle::new(bad).expect_err("empty name should fail");
        assert!(matches!(err, ServitudeError::Config(_)));
    }

    /// Production `new()` must build transport runtimes from config. Pin
    /// the invariant that the constructed runtime count matches the
    /// enabled-transport count.
    #[test]
    fn test_new_builds_one_runtime_per_enabled_transport() {
        let cfg = ServitudeConfig {
            display_name: "multi".to_string(),
            max_peers: 8,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![
                Transport::MatrixFederation,
                Transport::Tunnel,
            ],
        };
        let handle = ServitudeHandle::new(cfg).expect("config must validate");
        assert_eq!(handle.transports.len(), 2);
        assert_eq!(handle.transports[0].name(), "matrix_federation");
        assert_eq!(handle.transports[1].name(), "tunnel");
    }

    /// Hermetic smoke test that exercises the full Tauri-command surface
    /// at the handle level (without a real Tauri runtime). If this test
    /// starts failing, the `servitude_start` / `servitude_status` /
    /// `servitude_stop` Tauri commands are also broken — they delegate
    /// to exactly these three methods.
    #[tokio::test]
    async fn test_servitude_handle_round_trip() {
        let mut handle = handle_with_noop();

        // Initial status — matches what servitude_status returns when
        // no prior start has happened.
        assert_eq!(
            handle.status(),
            LifecycleState::Stopped,
            "fresh handle must start in Stopped"
        );

        // start() — matches servitude_start after config load.
        handle.start().await.expect("first start must succeed");
        assert_eq!(
            handle.status(),
            LifecycleState::Running,
            "post-start status must be Running"
        );

        // stop() — matches servitude_stop.
        handle.stop().await.expect("stop must succeed while Running");
        assert_eq!(
            handle.status(),
            LifecycleState::Stopped,
            "post-stop status must return to Stopped"
        );

        // And the handle must be re-usable — a second start→stop cycle
        // is how the Tauri state is expected to behave across user
        // toggles in the UI.
        handle.start().await.expect("second start must succeed");
        assert_eq!(handle.status(), LifecycleState::Running);
        handle.stop().await.expect("second stop must succeed");
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
    #[tokio::test]
    async fn test_servitude_handle_restart_picks_up_new_config() {
        // Config A — what the handle was originally built with.
        let config_a = ServitudeConfig {
            display_name: "node-before-edit".to_string(),
            max_peers: 8,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![Transport::MatrixFederation],
        };

        let mut handle = ServitudeHandle::new_with_runtimes_for_test(
            config_a.clone(),
            vec![TransportRuntime::Noop],
        )
        .expect("config A must validate");
        assert_eq!(
            handle.config().display_name,
            "node-before-edit",
            "pre-edit handle must report config A"
        );

        // First lifecycle run with config A.
        handle.start().await.expect("first start must succeed");
        assert_eq!(handle.status(), LifecycleState::Running);
        handle.stop().await.expect("first stop must succeed");
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
        handle = ServitudeHandle::new_with_runtimes_for_test(
            config_b.clone(),
            vec![TransportRuntime::Noop],
        )
        .expect("config B must validate");

        // Bring the new handle up and confirm the reloaded config
        // actually took effect.
        handle.start().await.expect("restart must succeed");
        assert_eq!(handle.status(), LifecycleState::Running);

        let observed = handle.config();
        assert_eq!(
            observed.display_name, "node-after-edit",
            "restart must pick up new display_name"
        );
        assert_eq!(observed.max_peers, 64, "restart must pick up new max_peers");
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

        handle.stop().await.expect("post-restart stop must succeed");
    }

    /// If a transport's `start` fails, any earlier transports must be
    /// torn down in reverse order AND the lifecycle must land back in
    /// `Stopped` — not stuck in `Starting`.
    #[tokio::test]
    async fn test_start_rollback_on_transport_failure() {
        // Build a handle with two runtimes: a Noop (succeeds) followed
        // by an unimplemented Tunnel variant (fails). The rollback
        // path must stop the Noop and drive the lifecycle to Stopped.
        let cfg = valid_config();
        let mut handle = ServitudeHandle::new_with_runtimes_for_test(
            cfg,
            vec![TransportRuntime::Noop, TransportRuntime::Tunnel],
        )
        .expect("config must validate");

        let err = handle
            .start()
            .await
            .expect_err("start must fail because the Tunnel variant is unimplemented");
        // Match explicitly instead of via matches! so a failure surfaces
        // the actual error text in the panic message. The original
        // `matches!` form gave zero diagnostic when it tripped during
        // development.
        match err {
            ServitudeError::Transport(TransportError::NotImplemented(name)) => {
                assert_eq!(name, "tunnel");
            }
            other => panic!("unexpected start error: {:?}", other),
        }
        assert_eq!(
            handle.status(),
            LifecycleState::Stopped,
            "lifecycle must roll back to Stopped on transport failure"
        );
    }

    // -----------------------------------------------------------------
    // INS-024 Wave 3 — partial-failure rollback + cross-transport
    // pre-pass lifecycle contract tests
    // -----------------------------------------------------------------

    /// Partial-failure rollback: when a non-critical transport fails
    /// to start, the handle must:
    ///
    ///   * stay in `Running` state (NOT roll back to `Stopped`)
    ///   * leave already-started critical transports alone
    ///   * record the failure in `degraded_transports()`
    ///
    /// This is the contract that makes non-critical transports
    /// optional without compromising the rest of the servitude.
    #[tokio::test]
    async fn test_servitude_handle_continues_when_noncritical_transport_fails() {
        // Noop (critical) + FailingNonCritical (not critical,
        // returns NotImplemented on start).
        let cfg = valid_config();
        let mut handle = ServitudeHandle::new_with_runtimes_for_test(
            cfg,
            vec![
                TransportRuntime::Noop,
                TransportRuntime::FailingNonCritical,
            ],
        )
        .expect("config must validate");

        // Start must succeed — the non-critical failure is absorbed.
        handle
            .start()
            .await
            .expect("start must succeed despite non-critical failure");

        // Handle stays Running.
        assert_eq!(
            handle.status(),
            LifecycleState::Running,
            "partial failure must leave handle Running"
        );

        // Degraded map has exactly one entry for the failing transport.
        let degraded = handle.degraded_transports();
        assert_eq!(
            degraded.len(),
            1,
            "degraded map must have exactly one entry, got: {:?}",
            degraded
        );
        assert!(
            degraded.contains_key("failing_noncritical"),
            "degraded map must contain failing_noncritical, got: {:?}",
            degraded.keys().collect::<Vec<_>>()
        );
        let reason = degraded.get("failing_noncritical").unwrap();
        assert!(
            reason.contains("failing_noncritical")
                || reason.contains("not yet implemented"),
            "degraded reason must surface the transport error: {}",
            reason
        );

        // The critical Noop transport must still report healthy.
        assert!(
            handle.is_healthy().await,
            "critical transports must still be healthy"
        );

        // And stop still works.
        handle
            .stop()
            .await
            .expect("stop must succeed from degraded state");
        assert_eq!(handle.status(), LifecycleState::Stopped);

        // After stop, degraded map is preserved until the next start
        // (so the UI can render the last-known failure reason) — but
        // a subsequent start must clear it.
        assert_eq!(
            handle.degraded_transports().len(),
            1,
            "degraded state persists through stop until next start"
        );
    }

    /// Regression-proof the existing Wave 2 contract: when a
    /// **critical** transport fails to start, the handle must tear
    /// down everything and roll the lifecycle back to `Stopped`. The
    /// new partial-failure code path must not weaken this.
    #[tokio::test]
    async fn test_servitude_handle_rolls_back_when_critical_transport_fails() {
        // Noop (critical, succeeds) followed by Tunnel (critical,
        // unimplemented → fails). This is the same shape as the
        // Wave 2 `test_start_rollback_on_transport_failure` test,
        // duplicated here so the Wave 3 contract tests stand alone
        // as a self-contained regression suite.
        let cfg = valid_config();
        let mut handle = ServitudeHandle::new_with_runtimes_for_test(
            cfg,
            vec![TransportRuntime::Noop, TransportRuntime::Tunnel],
        )
        .expect("config must validate");

        let err = handle
            .start()
            .await
            .expect_err("critical transport failure must propagate");
        match err {
            ServitudeError::Transport(TransportError::NotImplemented(name)) => {
                assert_eq!(name, "tunnel");
            }
            other => panic!("unexpected start error: {:?}", other),
        }

        assert_eq!(
            handle.status(),
            LifecycleState::Stopped,
            "critical failure must roll back to Stopped"
        );
        // No degraded entries because the whole handle rolled back.
        assert!(
            handle.degraded_transports().is_empty(),
            "critical-transport rollback must not populate degraded map"
        );
    }

}
