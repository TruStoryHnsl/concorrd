//! Phase 8 (INS-019b) — voice subsystem.
//!
//! Three sub-modules together implement the Phase 8 design-doc
//! requirement:
//!
//!   * [`selector`] — path-selection logic. Given the call's
//!     participant set, decides between full libp2p WebRTC mesh
//!     ([`VoicePath::LibP2pMesh`]) and LiveKit SFU fallback
//!     ([`VoicePath::LiveKitSfu`]). Pure function, no IO.
//!   * [`signaling`] — libp2p stream-protocol handler under
//!     `/concord/voice-signaling/1.0.0`. Reuses the Phase 6
//!     `FederationHandler` trait — voice signaling is just another
//!     payload over the same transport abstraction. Out-of-band
//!     `Offer`/`Answer`/`IceCandidate`/`Bye` envelopes ride the
//!     same length-prefixed-JSON framing as Matrix federation.
//!   * [`webrtc_peer`] — per-peer call state scaffolding. Phase 8
//!     ships the state machine + stubbed signaling responses; full
//!     audio over `webrtc-rs` is queued as a Phase 8 follow-up
//!     (sizable separate integration: cpal/AVAudioEngine capture,
//!     opus encoding, RTP/RTCP).
//!
//! Path-selection happens regardless of `Profile::P2pOnly` vs
//! `Profile::WebFirst` (Phase 7). The fallback case requires a
//! reachable LiveKit SFU on a docker-deployed peer — on a strictly
//! `P2pOnly` deployment with no docker peer in the room, an
//! >8-participant or web-only call cannot complete. This is the
//! same property as the Phase 8 design doc's "What's NOT in scope"
//! note on CGNAT + no-docker mobile-mobile calls.

pub mod selector;
pub mod signaling;
pub mod webrtc_peer;

pub use selector::{ParticipantKind, VoicePath, VoicePathReason, VoicePathSelector};
pub use signaling::{
    send_signaling, SignalingMessage, VoiceCallSink, VoiceSignalingHandler,
    SIGNALING_PROTOCOL_ID,
};
pub use webrtc_peer::{PeerCallState, WebRtcPeer};
