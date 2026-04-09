//! Transport layer for the embedded servitude module.
//!
//! The [`Transport`] trait abstracts "something that needs to be brought up
//! and torn down as part of the servitude lifecycle." In the 2026-04-08
//! design the concrete transports are:
//!
//!   * [`matrix_federation::MatrixFederationTransport`] — spawns a bundled
//!     tuwunel Matrix homeserver as a child process. This is the first
//!     real transport and lands in INS-022 Wave 2.
//!   * `WireGuard` — orrtellite-style tunnel that gives the node a
//!     publicly-reachable IP. Not yet implemented.
//!   * `Mesh` — libp2p over BLE/WiFi Direct/WiFi AP. Lives in the
//!     `concord_beta` repo, not here.
//!   * `Tunnel` — HTTP/QUIC tunnel through cooperating relays. Not yet
//!     implemented.
//!
//! The module exposes an enum-dispatched runtime object
//! ([`TransportRuntime`]) rather than trait objects, so
//! `ServitudeHandle::start`/`stop` don't have to touch a `Box<dyn
//! Transport>` surface — the enum variants are compile-time exhaustive
//! and the config knows which runtime to build from each
//! [`crate::servitude::config::Transport`] variant.
//!
//! Error handling: every fallible call returns [`TransportError`]. The
//! error type is `thiserror`-backed for consistency with the rest of the
//! servitude module, and flows up into [`crate::servitude::ServitudeError`]
//! via `#[from]`.

use async_trait::async_trait;
use thiserror::Error;

use crate::servitude::config::{ServitudeConfig, Transport as TransportVariant};

pub mod matrix_federation;

/// Errors surfaced by any transport implementation.
#[derive(Debug, Error)]
pub enum TransportError {
    /// Could not spawn the transport. Usually means the bundled binary
    /// is missing, permissions are wrong, or the listen port is already
    /// bound by another process.
    #[error("transport start failed: {0}")]
    StartFailed(String),

    /// Transport was asked to stop but the tear-down path failed.
    /// Graceful-shutdown timeouts fall under this.
    #[error("transport stop failed: {0}")]
    StopFailed(String),

    /// Health check against a running transport did not succeed inside
    /// the configured timeout.
    #[error("transport health check failed: {0}")]
    HealthCheck(String),

    /// The bundled child-process binary for this transport was not
    /// found on disk at any of the configured discovery paths.
    #[error("transport binary not found: {0}")]
    BinaryNotFound(String),

    /// A transport was already in the running state and we asked it to
    /// start again. Caller's responsibility to guard against this, but
    /// we return an error rather than panic so misuse is recoverable.
    #[error("transport is already running")]
    AlreadyRunning,

    /// A transport was asked to stop while it was not running.
    #[error("transport is not running")]
    NotRunning,

    /// A variant that hasn't been implemented yet. The MVP only ships
    /// [`matrix_federation::MatrixFederationTransport`]; the other three
    /// `Transport` enum variants return this so they can be referenced
    /// in config without crashing.
    #[error("transport not yet implemented: {0}")]
    NotImplemented(&'static str),
}

/// Async trait implemented by every transport runtime. Used internally
/// by [`TransportRuntime`] to dispatch; callers outside this module
/// should prefer the enum.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Identifier for logs — matches the config variant name, lowercased.
    fn name(&self) -> &'static str;

    /// Bring the transport up. Must succeed before the servitude
    /// lifecycle is permitted to transition `Starting -> Running`.
    async fn start(&mut self) -> Result<(), TransportError>;

    /// Gracefully tear the transport down. Implementations must not
    /// leave orphaned child processes or bound ports behind.
    async fn stop(&mut self) -> Result<(), TransportError>;

    /// Cheap liveness check — used by the UI polling loop so the user
    /// sees a status that reflects actual health, not just last-known
    /// lifecycle state. Return `false` when the transport is down or
    /// the check itself errors; details go to logs.
    async fn is_healthy(&self) -> bool;
}

/// Enum-dispatched runtime object owned by a running servitude handle.
///
/// We use an enum instead of `Box<dyn Transport>` so the call sites
/// inside `ServitudeHandle` can stay on the concrete types and the
/// compiler guarantees every transport variant is handled.
#[derive(Debug)]
pub enum TransportRuntime {
    /// Embedded tuwunel Matrix homeserver as a child process.
    MatrixFederation(matrix_federation::MatrixFederationTransport),
    /// Placeholder for WireGuard tunnel — returns `NotImplemented`
    /// until the wire-up lands in a later wave.
    WireGuard,
    /// Placeholder for local-radio mesh (lives in `concord_beta`).
    Mesh,
    /// Placeholder for HTTP/QUIC tunnel — returns `NotImplemented`
    /// until the wire-up lands.
    Tunnel,
    /// No-op runtime used only by unit tests that drive the
    /// `ServitudeHandle` state machine without spawning any real
    /// transport. Intentionally `#[doc(hidden)]` — the public
    /// [`Self::for_variant`] factory never returns this variant, so
    /// production code paths cannot land on it.
    #[doc(hidden)]
    Noop,
}

impl TransportRuntime {
    /// Build the runtime object appropriate for the given transport
    /// variant, reading any per-transport settings out of the shared
    /// `ServitudeConfig`. This is the single factory seam between the
    /// config and the transport layer.
    pub fn for_variant(
        variant: TransportVariant,
        config: &ServitudeConfig,
    ) -> Self {
        match variant {
            TransportVariant::MatrixFederation => TransportRuntime::MatrixFederation(
                matrix_federation::MatrixFederationTransport::from_config(config),
            ),
            TransportVariant::WireGuard => TransportRuntime::WireGuard,
            TransportVariant::Mesh => TransportRuntime::Mesh,
            TransportVariant::Tunnel => TransportRuntime::Tunnel,
        }
    }

    /// Human-readable name for logs — matches
    /// [`Transport::name`] on the active variant.
    pub fn name(&self) -> &'static str {
        match self {
            TransportRuntime::MatrixFederation(_) => "matrix_federation",
            TransportRuntime::WireGuard => "wireguard",
            TransportRuntime::Mesh => "mesh",
            TransportRuntime::Tunnel => "tunnel",
            TransportRuntime::Noop => "noop",
        }
    }

    /// Dispatch start to the active variant. Placeholder variants
    /// return [`TransportError::NotImplemented`] so misconfiguration
    /// surfaces as a clean error instead of a silent skip. The
    /// `Noop` variant succeeds unconditionally — it exists only to
    /// make lifecycle unit tests cheap.
    pub async fn start(&mut self) -> Result<(), TransportError> {
        match self {
            TransportRuntime::MatrixFederation(t) => t.start().await,
            TransportRuntime::WireGuard => {
                Err(TransportError::NotImplemented("wireguard"))
            }
            TransportRuntime::Mesh => Err(TransportError::NotImplemented("mesh")),
            TransportRuntime::Tunnel => {
                Err(TransportError::NotImplemented("tunnel"))
            }
            TransportRuntime::Noop => Ok(()),
        }
    }

    /// Dispatch stop to the active variant. Placeholder variants are
    /// no-ops on stop (there's nothing to tear down if there was
    /// nothing to bring up), which keeps lifecycle state machine
    /// rollback paths simple.
    pub async fn stop(&mut self) -> Result<(), TransportError> {
        match self {
            TransportRuntime::MatrixFederation(t) => t.stop().await,
            TransportRuntime::WireGuard
            | TransportRuntime::Mesh
            | TransportRuntime::Tunnel
            | TransportRuntime::Noop => Ok(()),
        }
    }

    /// Dispatch health check to the active variant. Placeholders
    /// report unhealthy so the UI never shows a green light for a
    /// transport that hasn't been implemented. `Noop` reports
    /// healthy (tests that exercise the lifecycle expect a Running
    /// state to be consistent with a healthy report).
    pub async fn is_healthy(&self) -> bool {
        match self {
            TransportRuntime::MatrixFederation(t) => t.is_healthy().await,
            TransportRuntime::WireGuard
            | TransportRuntime::Mesh
            | TransportRuntime::Tunnel => false,
            TransportRuntime::Noop => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servitude::config::{ServitudeConfig, Transport as TransportVariant};

    fn test_config() -> ServitudeConfig {
        ServitudeConfig {
            display_name: "test-node".to_string(),
            max_peers: 16,
            listen_port: 8765,
            allow_privileged_port: false,
            enabled_transports: vec![TransportVariant::MatrixFederation],
        }
    }

    #[test]
    fn test_factory_returns_matrix_federation_for_variant() {
        let runtime = TransportRuntime::for_variant(
            TransportVariant::MatrixFederation,
            &test_config(),
        );
        assert_eq!(runtime.name(), "matrix_federation");
    }

    #[test]
    fn test_factory_returns_placeholder_variants_correctly() {
        let wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        assert_eq!(wg.name(), "wireguard");
        let mesh = TransportRuntime::for_variant(TransportVariant::Mesh, &test_config());
        assert_eq!(mesh.name(), "mesh");
        let tunnel = TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        assert_eq!(tunnel.name(), "tunnel");
    }

    #[tokio::test]
    async fn test_placeholder_variants_report_not_implemented_on_start() {
        let mut wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        let err = wg.start().await.expect_err("wireguard must not start");
        assert!(matches!(err, TransportError::NotImplemented("wireguard")));

        let mut tunnel =
            TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        let err = tunnel.start().await.expect_err("tunnel must not start");
        assert!(matches!(err, TransportError::NotImplemented("tunnel")));
    }

    #[tokio::test]
    async fn test_placeholder_variants_report_unhealthy() {
        let wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        assert!(!wg.is_healthy().await);
        let mesh = TransportRuntime::for_variant(TransportVariant::Mesh, &test_config());
        assert!(!mesh.is_healthy().await);
        let tunnel = TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        assert!(!tunnel.is_healthy().await);
    }

    #[tokio::test]
    async fn test_placeholder_variants_stop_is_noop() {
        // Stopping an un-started placeholder is a no-op by design —
        // lifecycle rollback paths rely on this, so the test pins it.
        let mut wg = TransportRuntime::for_variant(TransportVariant::WireGuard, &test_config());
        wg.stop().await.expect("wg stop must be a noop");
        let mut mesh = TransportRuntime::for_variant(TransportVariant::Mesh, &test_config());
        mesh.stop().await.expect("mesh stop must be a noop");
        let mut tunnel =
            TransportRuntime::for_variant(TransportVariant::Tunnel, &test_config());
        tunnel.stop().await.expect("tunnel stop must be a noop");
    }
}
