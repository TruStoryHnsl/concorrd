//! Phase 6 (INS-019b) — protocol-agnostic federation payload layer over
//! libp2p streams.
//!
//! Each federated protocol (Matrix federation today, ActivityPub queued for
//! Phase 6 follow-up) registers itself as a [`FederationHandler`] under a
//! distinct libp2p stream protocol ID (e.g. `/concord/matrix-federation/1.0.0`).
//! The dispatcher in [`crate::servitude::p2p::LibP2pTransport`] accepts inbound
//! streams per registered protocol ID and routes each new stream to the matching
//! handler. The swarm itself stays unaware of the payload type — adding a new
//! federated protocol is a new handler module, not a transport change.
//!
//! ## Trait split — why two traits instead of one
//!
//! The design doc's pseudocode places `const PROTOCOL_ID: &'static str` directly
//! on the trait. Rust forbids associated `const` on dyn-compatible traits, and
//! the dispatcher MUST hold heterogeneous handlers behind
//! `Box<dyn FederationHandler>` / `Arc<dyn FederationHandler>`. Resolution:
//!
//!   * [`FederationProtocol`] is a non-dyn-safe marker trait that publishes
//!     the protocol ID as an associated `const`. Outbound-stream code that
//!     knows the concrete handler type can use this at compile time
//!     (e.g. `MatrixFederationHandler::PROTOCOL_ID`).
//!   * [`FederationHandler`] is the dyn-safe trait the dispatcher actually
//!     holds. It exposes the protocol ID through an instance method
//!     [`FederationHandler::protocol_id`] so runtime dispatch works without
//!     reflection.
//!
//! Concrete handlers (e.g. [`MatrixFederationHandler`]) implement BOTH:
//! `FederationProtocol::PROTOCOL_ID` provides the compile-time constant,
//! and `FederationHandler::protocol_id()` returns the same string at
//! runtime.

use async_trait::async_trait;
use libp2p::{PeerId, Stream};
use thiserror::Error;

/// Distinguishes the wire payload a handler carries. Used for logging /
/// diagnostics; the dispatcher does NOT key on this — it keys on the
/// protocol ID string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadKind {
    /// Matrix federation payload — JSON-RPC envelopes over the
    /// `/concord/matrix-federation/1.0.0` stream protocol.
    Matrix,
    /// ActivityPub payload — queued for Phase 6 follow-up.
    ActivityPub,
    /// Escape hatch for future protocols whose `PayloadKind` is not yet
    /// represented here. The `&'static str` is a free-form label for
    /// diagnostics only.
    Other(&'static str),
}

/// Error type for the federation payload layer.
#[derive(Debug, Error)]
pub enum FederationError {
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Stream closed unexpectedly")]
    StreamClosed,
    #[error("Protocol mismatch: expected {expected}, got {actual}")]
    ProtocolMismatch {
        expected: &'static str,
        actual: String,
    },
    #[error("Malformed envelope: {0}")]
    MalformedEnvelope(String),
    #[error("Upstream API error: {0}")]
    Upstream(String),
}

/// Dyn-safe handler trait. The dispatcher holds these behind
/// `Arc<dyn FederationHandler>` so it can fan inbound libp2p streams out to
/// the right handler by `protocol_id()`.
#[async_trait]
pub trait FederationHandler: Send + Sync {
    /// Runtime accessor for the libp2p stream protocol ID this handler
    /// serves. Matches the value of [`FederationProtocol::PROTOCOL_ID`] on
    /// the concrete type.
    fn protocol_id(&self) -> &'static str;

    /// Coarse-grained classification of the wire payload — for logs and
    /// the FederationStreamOpened SwarmEvent's diagnostics field. Routing
    /// is by `protocol_id()`, not by this.
    fn payload_kind(&self) -> PayloadKind;

    /// Drive one inbound libp2p stream to completion. The handler owns the
    /// stream's full lifecycle (read framed envelopes, dispatch, write
    /// responses) until either the peer closes the stream or a fatal
    /// error occurs. Returning `Ok(())` is the normal exit; the
    /// dispatcher logs `Err(_)` at warn level and moves on.
    ///
    /// `peer_id` is the remote peer's libp2p `PeerId` (resolved by the
    /// `libp2p_stream::IncomingStreams` receiver before the stream is
    /// handed off). Phase 8 added this parameter so handlers like
    /// voice-signaling can attribute inbound envelopes to the right
    /// remote peer without inventing a sentinel.
    async fn handle_inbound(
        &self,
        peer_id: PeerId,
        stream: Stream,
    ) -> Result<(), FederationError>;
}

/// Compile-time-known protocol ID. Concrete handlers implement this in
/// addition to [`FederationHandler`] so outbound-stream code (which knows
/// the concrete handler type) can reference the protocol ID without an
/// instance.
///
/// Not dyn-safe on purpose — the dispatcher uses [`FederationHandler`]
/// for that.
pub trait FederationProtocol {
    const PROTOCOL_ID: &'static str;
}

pub mod activitypub;
pub mod matrix;

pub use activitypub::{
    ActivityPubApi, ActivityPubErrorBody, ActivityPubHandler, ActivityPubRequest,
    ActivityPubResponse, StubActivityPubClient, ACTIVITYPUB_PROTOCOL_ID,
};
pub use matrix::{
    ConduwuitClient, MatrixErrorBody, MatrixFederationApi, MatrixFederationHandler,
    MatrixRequest, MatrixResponse, MATRIX_PROTOCOL_ID,
};
