//! Phase 8 (INS-019b) — per-peer WebRTC call-state scaffolding.
//!
//! Thin Rust shim around the WebRTC PeerConnection state machine.
//! Phase 8 ships the **scaffolding + tests**; the actual `webrtc-rs`
//! integration (real SDP negotiation, ICE candidate gathering, RTP
//! frame routing) is explicitly deferred to a Phase 8 follow-up.
//!
//! Why deferred: `webrtc-rs` integration is a sizable separate piece of
//! work (audio capture via cpal on desktop, AVAudioEngine on iOS,
//! opus encoding, RTCP, NACK / FEC). Phase 8's job is the decision
//! layer (selector) + signaling protocol (signaling.rs). The media
//! layer rides on the same `WebRtcPeer` struct, but the negotiation
//! is stubbed: any Offer produces a placeholder Answer; any
//! IceCandidate flips the state to Connected. That's enough for the
//! integration tests to prove the signaling wire works end-to-end —
//! they don't need real audio to flow.

use libp2p::PeerId;
use serde::{Deserialize, Serialize};

use crate::servitude::voice::signaling::SignalingMessage;

/// Per-peer call lifecycle. Each [`WebRtcPeer`] in a mesh call holds
/// one of these for every remote participant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PeerCallState {
    /// We've sent an Offer to the remote, awaiting their Answer.
    Offering,
    /// We've received their Offer, prepping our Answer.
    AnsweringPending,
    /// Both sides exchanged offer + answer; ICE candidate gathering
    /// + nomination in progress.
    IceGathering,
    /// Call is up — audio flowing (or would be, once the media layer
    /// lands).
    Connected,
    /// Call ended cleanly via a Bye envelope.
    Closed,
    /// Call ended with an error. String carries the failure reason
    /// for the UI.
    Failed(String),
}

/// Per-peer call state. One instance per remote participant in a mesh
/// call.
///
/// Field-level access (rather than private fields + accessors) is
/// deliberate: the Phase 8 scaffolding stage doesn't need
/// encapsulation — the integration tests and the future media layer
/// will mutate this directly. Migrating to private fields is a
/// Phase 8 follow-up if the media layer needs invariant guards.
#[derive(Debug, Clone)]
pub struct WebRtcPeer {
    pub peer_id: PeerId,
    pub state: PeerCallState,
    pub local_sdp: Option<String>,
    pub remote_sdp: Option<String>,
    pub ice_candidates: Vec<String>,
}

impl WebRtcPeer {
    /// Build a new peer in the [`PeerCallState::Offering`] state —
    /// the constructor is meant for the call-initiator path. The
    /// callee path constructs a peer the same way then immediately
    /// drives it via [`Self::handle_signaling`] with the inbound
    /// Offer, which transitions the state through
    /// `AnsweringPending` → `IceGathering`.
    pub fn new(peer_id: PeerId) -> Self {
        Self {
            peer_id,
            state: PeerCallState::Offering,
            local_sdp: None,
            remote_sdp: None,
            ice_candidates: vec![],
        }
    }

    /// Apply a signaling message from the remote peer. Returns
    /// `Some(message)` if a response should be sent back (e.g. an
    /// inbound Offer triggers an outbound Answer); `None` otherwise.
    ///
    /// Phase 8 stub semantics:
    ///   * Offer → placeholder Answer SDP + state transitions to
    ///     `IceGathering`.
    ///   * Answer → state transitions to `IceGathering`.
    ///   * IceCandidate → appended + state transitions to
    ///     `Connected`. (Real impl would wait for an actual
    ///     nominated candidate pair.)
    ///   * Bye → state transitions to `Closed`.
    pub fn handle_signaling(&mut self, message: SignalingMessage) -> Option<SignalingMessage> {
        match message {
            SignalingMessage::Offer { sdp, request_id } => {
                self.remote_sdp = Some(sdp);
                self.state = PeerCallState::AnsweringPending;
                // Real impl would call into webrtc-rs to create an
                // answer. Stub: a minimal valid-shaped SDP so the
                // integration test can verify the round-trip works
                // without a real PeerConnection in the loop.
                let answer_sdp =
                    "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 0 RTP/AVP 0\r\n"
                        .to_string();
                self.local_sdp = Some(answer_sdp.clone());
                self.state = PeerCallState::IceGathering;
                Some(SignalingMessage::Answer {
                    sdp: answer_sdp,
                    request_id,
                })
            }
            SignalingMessage::Answer {
                sdp,
                request_id: _,
            } => {
                self.remote_sdp = Some(sdp);
                self.state = PeerCallState::IceGathering;
                None
            }
            SignalingMessage::IceCandidate {
                candidate,
                request_id: _,
            } => {
                self.ice_candidates.push(candidate);
                // Phase 8 stub: any ICE candidate flips us to
                // Connected. Real impl waits for the
                // negotiation-complete signal from webrtc-rs.
                self.state = PeerCallState::Connected;
                None
            }
            SignalingMessage::Bye { request_id: _ } => {
                self.state = PeerCallState::Closed;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_peer() -> WebRtcPeer {
        WebRtcPeer::new(PeerId::random())
    }

    /// A freshly-constructed peer starts in the `Offering` state —
    /// the initiator path is the default constructor flow.
    #[test]
    fn new_peer_starts_in_offering_state() {
        let peer = fresh_peer();
        assert_eq!(peer.state, PeerCallState::Offering);
        assert!(peer.local_sdp.is_none());
        assert!(peer.remote_sdp.is_none());
        assert!(peer.ice_candidates.is_empty());
    }

    /// Handling an Offer transitions to `IceGathering` (via
    /// `AnsweringPending` internally) AND returns an Answer envelope
    /// so the caller can forward it on the signaling wire. The
    /// returned envelope must carry the same `request_id` as the
    /// inbound Offer (correlation invariant for the signaling
    /// protocol).
    #[test]
    fn handling_offer_transitions_to_ice_gathering_and_returns_answer() {
        let mut peer = fresh_peer();
        let offer = SignalingMessage::Offer {
            sdp: "v=0\r\nremote-sdp\r\n".to_string(),
            request_id: 7,
        };
        let response = peer.handle_signaling(offer);
        match response {
            Some(SignalingMessage::Answer { sdp, request_id }) => {
                assert!(!sdp.is_empty(), "answer SDP must be non-empty");
                assert_eq!(
                    request_id, 7,
                    "answer request_id must echo offer request_id"
                );
            }
            other => panic!("expected Answer response, got: {:?}", other),
        }
        assert_eq!(peer.state, PeerCallState::IceGathering);
        assert_eq!(
            peer.remote_sdp.as_deref(),
            Some("v=0\r\nremote-sdp\r\n"),
            "remote SDP must be recorded from the inbound offer"
        );
        assert!(
            peer.local_sdp.is_some(),
            "local SDP must be populated from the generated answer"
        );
    }

    /// Handling an Answer transitions to `IceGathering` and returns
    /// no follow-up envelope (the initiator was already past the
    /// answer step from its side's perspective).
    #[test]
    fn handling_answer_transitions_to_ice_gathering() {
        let mut peer = fresh_peer();
        let answer = SignalingMessage::Answer {
            sdp: "v=0\r\nanswer-sdp\r\n".to_string(),
            request_id: 11,
        };
        let response = peer.handle_signaling(answer);
        assert!(response.is_none(), "Answer must not trigger a follow-up");
        assert_eq!(peer.state, PeerCallState::IceGathering);
        assert_eq!(
            peer.remote_sdp.as_deref(),
            Some("v=0\r\nanswer-sdp\r\n"),
            "remote SDP must be recorded from the inbound answer"
        );
    }

    /// Handling an IceCandidate appends to the candidate list and
    /// flips the state to Connected (Phase 8 stub semantics — the
    /// real impl waits for actual ICE nomination).
    #[test]
    fn handling_ice_candidate_appends_and_transitions_to_connected() {
        let mut peer = fresh_peer();
        let ice = SignalingMessage::IceCandidate {
            candidate: "candidate:1 1 UDP 12345 1.2.3.4 4444 typ host".to_string(),
            request_id: 3,
        };
        let response = peer.handle_signaling(ice);
        assert!(response.is_none(), "IceCandidate must not trigger a follow-up");
        assert_eq!(peer.state, PeerCallState::Connected);
        assert_eq!(peer.ice_candidates.len(), 1);
        assert_eq!(
            peer.ice_candidates[0],
            "candidate:1 1 UDP 12345 1.2.3.4 4444 typ host"
        );
    }

    /// Handling a Bye transitions to Closed and returns no follow-up.
    #[test]
    fn handling_bye_transitions_to_closed() {
        let mut peer = fresh_peer();
        let bye = SignalingMessage::Bye { request_id: 99 };
        let response = peer.handle_signaling(bye);
        assert!(response.is_none(), "Bye must not trigger a follow-up");
        assert_eq!(peer.state, PeerCallState::Closed);
    }

    /// A full initiator-side flow: send Offer (constructor places
    /// us in Offering), receive Answer (state → IceGathering),
    /// receive IceCandidate (state → Connected), receive Bye
    /// (state → Closed). The state machine has no illegal
    /// transitions along this happy path.
    #[test]
    fn initiator_side_happy_path() {
        let mut peer = fresh_peer();
        assert_eq!(peer.state, PeerCallState::Offering);

        peer.handle_signaling(SignalingMessage::Answer {
            sdp: "answer".to_string(),
            request_id: 1,
        });
        assert_eq!(peer.state, PeerCallState::IceGathering);

        peer.handle_signaling(SignalingMessage::IceCandidate {
            candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host".to_string(),
            request_id: 1,
        });
        assert_eq!(peer.state, PeerCallState::Connected);

        peer.handle_signaling(SignalingMessage::Bye { request_id: 1 });
        assert_eq!(peer.state, PeerCallState::Closed);
    }
}
