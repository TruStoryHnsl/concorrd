//! Servitude lifecycle state machine.
//!
//! The canonical happy-path graph is:
//!
//! ```text
//!     Stopped ──► Starting ──► Running ──► Stopping ──► Stopped
//! ```
//!
//! There is one additional rollback edge — `Starting ──► Stopping` —
//! added for the transport-failure-during-start path. When a transport
//! fails mid-`Starting`, the handle tears down whatever it already
//! brought up and must drive the lifecycle back to `Stopped`. Without
//! this edge the rollback would be stuck in `Starting` indefinitely.
//! The edge exists purely for error recovery; the happy path never
//! uses it.
//!
//! Skipping a state along any other edge (e.g. `Stopped → Running`
//! directly) is rejected. Going backwards is rejected. The state
//! machine has no `Failed` state in v0.1 — transport errors flow up
//! through `ServitudeError` and the caller is responsible for
//! resetting the handle.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Discrete lifecycle states the embedded servitude can occupy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Stopped,
    Starting,
    Running,
    Stopping,
}

/// Errors emitted when an invalid transition is attempted.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LifecycleError {
    #[error("invalid transition: {from:?} -> {to:?}")]
    InvalidTransition {
        from: LifecycleState,
        to: LifecycleState,
    },
}

/// Tiny owning state machine.
///
/// Holds the current state and validates each transition. Not thread-safe by
/// itself — wrap in a `Mutex` if you share it across threads. The MVP runs
/// servitude on a single async runtime so wrapping has been deferred.
#[derive(Debug, Clone)]
pub struct Lifecycle {
    state: LifecycleState,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl Lifecycle {
    /// Construct a new lifecycle in the [`LifecycleState::Stopped`] state.
    pub fn new() -> Self {
        Self {
            state: LifecycleState::Stopped,
        }
    }

    /// Read the current state.
    pub fn state(&self) -> LifecycleState {
        self.state
    }

    /// Attempt to transition to a new state. Returns
    /// [`LifecycleError::InvalidTransition`] if the requested step is not on
    /// the canonical state graph.
    pub fn transition(&mut self, to: LifecycleState) -> Result<(), LifecycleError> {
        if !is_valid_transition(self.state, to) {
            return Err(LifecycleError::InvalidTransition {
                from: self.state,
                to,
            });
        }
        self.state = to;
        Ok(())
    }
}

/// Encodes the canonical state graph. The graph is small enough that an
/// explicit match is clearer (and easier to audit) than a transition table.
fn is_valid_transition(from: LifecycleState, to: LifecycleState) -> bool {
    use LifecycleState::*;
    matches!(
        (from, to),
        (Stopped, Starting)
            | (Starting, Running)
            | (Starting, Stopping) // rollback edge when a transport fails mid-start
            | (Running, Stopping)
            | (Stopping, Stopped)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lifecycle_starts_stopped() {
        let lc = Lifecycle::new();
        assert_eq!(lc.state(), LifecycleState::Stopped);
    }

    #[test]
    fn test_lifecycle_transitions_stopped_to_running() {
        let mut lc = Lifecycle::new();
        lc.transition(LifecycleState::Starting).unwrap();
        assert_eq!(lc.state(), LifecycleState::Starting);
        lc.transition(LifecycleState::Running).unwrap();
        assert_eq!(lc.state(), LifecycleState::Running);
    }

    #[test]
    fn test_lifecycle_transitions_running_to_stopped() {
        let mut lc = Lifecycle::new();
        lc.transition(LifecycleState::Starting).unwrap();
        lc.transition(LifecycleState::Running).unwrap();
        lc.transition(LifecycleState::Stopping).unwrap();
        lc.transition(LifecycleState::Stopped).unwrap();
        assert_eq!(lc.state(), LifecycleState::Stopped);
    }

    #[test]
    fn test_lifecycle_rejects_invalid_transition() {
        let mut lc = Lifecycle::new();
        // Stopped -> Running (skipping Starting) is invalid.
        let err = lc
            .transition(LifecycleState::Running)
            .expect_err("skip should fail");
        assert_eq!(
            err,
            LifecycleError::InvalidTransition {
                from: LifecycleState::Stopped,
                to: LifecycleState::Running,
            }
        );

        // Stopped -> Stopping is also invalid.
        let err = lc
            .transition(LifecycleState::Stopping)
            .expect_err("backwards step should fail");
        assert!(matches!(err, LifecycleError::InvalidTransition { .. }));
    }

    #[test]
    fn test_lifecycle_rejects_running_to_starting() {
        let mut lc = Lifecycle::new();
        lc.transition(LifecycleState::Starting).unwrap();
        lc.transition(LifecycleState::Running).unwrap();
        let err = lc
            .transition(LifecycleState::Starting)
            .expect_err("running -> starting should fail");
        assert!(matches!(err, LifecycleError::InvalidTransition { .. }));
    }
}
