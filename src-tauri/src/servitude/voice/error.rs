//! Phase 8 follow-up — voice subsystem error type.
//!
//! Wraps the failure modes of:
//!
//!   * the `webrtc-rs` PeerConnection (SDP parsing, transceiver setup,
//!     ICE candidate add, close — see [`webrtc::Error`]),
//!   * the libp2p signaling stream layer (already typed as
//!     [`crate::servitude::federation::FederationError`]),
//!   * the voice-call orchestration layer itself (call not found,
//!     peer already exists, etc.).
//!
//! Kept as a separate module so call.rs / media.rs / lib.rs all
//! reference one canonical error name. The Tauri command surface
//! `Display`s these to a String for the IPC boundary.

use thiserror::Error;

use crate::servitude::federation::FederationError;

/// Voice-subsystem error type. Surfaced to:
///
///   * the Tauri command layer (via `Display` → `Result<_, String>`),
///   * `tracing` / `log` for diagnostics,
///   * the orchestration tests in `src-tauri/tests/voice_mesh_test.rs`.
#[derive(Debug, Error)]
pub enum VoiceError {
    /// Underlying `webrtc-rs` failure — SDP parse error, transceiver
    /// setup failure, ICE candidate rejection, etc. Boxed `String`
    /// because [`webrtc::Error`] is not `Clone` and we want a cheap,
    /// owned error path.
    #[error("webrtc error: {0}")]
    WebRtc(String),

    /// Failure on the libp2p signaling stream layer (open_stream
    /// rejection, framing error, JSON parse failure).
    #[error("signaling error: {0}")]
    Signaling(#[from] FederationError),

    /// Voice call with the given `room_id` is not registered. Tauri
    /// commands return this as a user-readable string so the React
    /// side knows the local state is stale.
    #[error("voice call not found for room_id={0:?}")]
    CallNotFound(String),

    /// Tried to add a peer that is already part of the call. The
    /// orchestrator is idempotent on the wire — duplicate join intents
    /// from the frontend are filtered here.
    #[error("peer already in call: {0}")]
    PeerAlreadyPresent(libp2p::PeerId),

    /// Tried to reference a peer that isn't part of the call. Surfaces
    /// when an inbound signaling envelope races with a leave/teardown.
    #[error("peer not in call: {0}")]
    PeerNotPresent(libp2p::PeerId),

    /// Internal channel send failure — the orchestrator's outbound
    /// signaling queue is closed, or a `Notify` lost its peer.
    #[error("internal channel closed: {0}")]
    ChannelClosed(String),

    /// Audio pipeline error — cpal device open failed, opus encoder
    /// reject, etc. See [`crate::servitude::voice::audio::AudioError`]
    /// for the concrete classification; this variant just carries
    /// the display string so the Tauri command surface can ship a
    /// user-readable message.
    #[error("audio pipeline error: {0}")]
    Audio(String),

    /// Audio capture/playback is not supported on this platform.
    /// Returned by iOS callers so the path selector can fall back
    /// to LiveKit. Native desktop never returns this.
    #[error("audio not supported on this platform — fall back to LiveKit")]
    AudioNotSupported,
}

impl From<webrtc::Error> for VoiceError {
    fn from(e: webrtc::Error) -> Self {
        VoiceError::WebRtc(e.to_string())
    }
}
