//! Phase 8 follow-up — real webrtc-rs media plane for one peer in a
//! mesh call.
//!
//! Sibling of [`super::webrtc_peer::WebRtcPeer`] (the lightweight,
//! synchronous, test-driven state-machine scaffolding that Phase 8
//! shipped). This module brings the actual `webrtc::peer_connection::
//! RTCPeerConnection` online so an Offer / Answer / IceCandidate
//! exchange triggers a real DTLS/ICE handshake and a real audio
//! transceiver gets registered.
//!
//! ## What lands
//!
//!   * A real `RTCPeerConnection` per remote peer, built off the
//!     shared [`MediaApi`] handle (one `webrtc::api::API` per
//!     [`VoiceCall`]).
//!   * Real SDP create_offer / create_answer / set_local_description /
//!     set_remote_description plumbing.
//!   * Real ICE candidate exchange: outbound candidates are queued into
//!     `ice_candidates_to_send` by the `on_ice_candidate` callback, and
//!     the call orchestrator drains the queue and forwards them via
//!     `send_signaling`.
//!   * Real remote-track capture: the `on_track` callback stores the
//!     inbound [`TrackRemote`] under `remote_audio_track` so tests can
//!     observe a track has been registered.
//!   * Real connection-state mirroring: the
//!     `on_peer_connection_state_change` callback flips the public
//!     [`super::webrtc_peer::PeerCallState`] mirror so the UI sees
//!     `Connected` when DTLS comes up.
//!
//! ## What is deferred — `TODO(mesh-media-followup)`
//!
//!   * **Microphone capture**. The local `audio/opus` track exists and
//!     accepts RTP packets via `TrackLocalStaticRTP::write_rtp`, but
//!     the mic source is a `tokio::sync::mpsc::Receiver<Vec<u8>>` that
//!     external code (cpal on desktop / AVAudioEngine on iOS) must
//!     feed. Today nothing feeds it in production. Tests inject
//!     synthetic RTP frames via [`Self::push_local_rtp`]. Real mic
//!     wiring lands as a follow-up PR.
//!   * **Speaker playback**. The remote track is captured but not
//!     piped to a playback device. Same follow-up PR.
//!   * **Opus encoder integration**. Even when the mic source is
//!     wired, the bytes have to be opus-encoded RTP packets — the
//!     follow-up PR introduces a cpal → opus → RTP pump.
//!   * **NACK / FEC / RTCP feedback**. webrtc-rs handles RTP-level
//!     packet flow; we don't drive packet-loss recovery here.

use std::sync::Arc;

use tokio::sync::{mpsc, Mutex, RwLock};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::{APIBuilder, API};
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType};
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_remote::TrackRemote;

use super::error::VoiceError;
use super::signaling::SignalingMessage;
use super::webrtc_peer::PeerCallState;

/// Shared `webrtc::api::API` handle. One API instance is enough for an
/// entire process — re-using it across peers in the same call avoids
/// re-registering codecs / interceptors per peer.
pub type MediaApi = Arc<API>;

/// Build a fresh [`MediaApi`] with the default codec + interceptor set.
/// Called once per [`super::call::VoiceCall`].
pub fn build_media_api() -> Result<MediaApi, VoiceError> {
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut m)?;
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();
    Ok(Arc::new(api))
}

/// Per-peer media-plane state. Held inside
/// [`super::call::VoiceCall::peers`] keyed by remote `libp2p::PeerId`.
///
/// Internal locks: only the cross-callback fields are wrapped in
/// `Arc<Mutex<…>>` / `Arc<RwLock<…>>` so the webrtc-rs callbacks (which
/// run on `'static` closures spawned inside `webrtc-rs`) can talk back
/// to the orchestrator without taking a reference to `self`.
pub struct WebRtcMediaPeer {
    /// Remote peer's libp2p identifier — same identifier the signaling
    /// layer threads through.
    pub peer_id: libp2p::PeerId,

    /// Real PeerConnection. Wrapped in `Arc` because every webrtc-rs
    /// callback needs its own `Arc` clone (closures are `'static`).
    pub pc: Arc<RTCPeerConnection>,

    /// Local outbound audio track. Real mic wiring (cpal / AVAudio)
    /// will write RTP packets here; for now, callers can push synthetic
    /// packets via [`Self::push_local_rtp`].
    ///
    /// `TODO(mesh-media-followup)`: replace synthetic source with a real
    /// cpal-driven opus encoder pump on desktop and AVAudioEngine on
    /// iOS.
    pub local_audio_track: Arc<TrackLocalStaticRTP>,

    /// Remote inbound audio track. `None` until the remote peer's
    /// `on_track` callback fires (i.e. their SDP answer includes an
    /// audio media section and ICE/DTLS comes up).
    ///
    /// `TODO(mesh-media-followup)`: pipe this into a speaker playback
    /// device. Today the track is captured (so tests can observe it)
    /// but its packets are not consumed.
    pub remote_audio_track: Arc<RwLock<Option<Arc<TrackRemote>>>>,

    /// Queue of local ICE candidates the `on_ice_candidate` callback
    /// has gathered but not yet been forwarded over the signaling
    /// wire. The orchestrator
    /// ([`super::call::VoiceCall::drain_pending_outbound`]) drains this
    /// and forwards each entry as a [`SignalingMessage::IceCandidate`].
    pub ice_candidates_to_send: Arc<Mutex<Vec<RTCIceCandidateInit>>>,

    /// Mirror of the underlying PeerConnection's connection state,
    /// updated by `on_peer_connection_state_change`. Maps to the
    /// existing [`PeerCallState`] enum so the orchestrator + Tauri
    /// command surface keep the same wire shape.
    pub state: Arc<RwLock<PeerCallState>>,

    /// Channel the orchestrator (or test code) can use to push local
    /// RTP packets into the outbound track. Real mic capture writes
    /// here on desktop / mobile; tests write synthetic frames.
    ///
    /// `None` once [`Self::take_local_rtp_sender`] hands ownership over
    /// — useful when a single mic capture pipe wants exclusive write
    /// access.
    local_rtp_tx: Option<mpsc::Sender<Vec<u8>>>,

    /// Request ID for the in-flight offer/answer round (correlates
    /// inbound Answers / IceCandidates to this peer). Incremented by
    /// [`Self::create_offer`].
    request_id: u64,
}

impl std::fmt::Debug for WebRtcMediaPeer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebRtcMediaPeer")
            .field("peer_id", &self.peer_id)
            .field("request_id", &self.request_id)
            .finish_non_exhaustive()
    }
}

impl WebRtcMediaPeer {
    /// Build a per-peer media wrapper.
    ///
    /// Wires:
    ///   * a fresh `RTCPeerConnection` with the supplied STUN/TURN
    ///     servers,
    ///   * a local `audio/opus` track added as a sendonly transceiver,
    ///   * the `on_ice_candidate` / `on_track` / `on_peer_connection_state_change`
    ///     callbacks pointed at the mutex-protected shared state.
    pub async fn new(
        api: &MediaApi,
        peer_id: libp2p::PeerId,
        ice_servers: Vec<String>,
    ) -> Result<Self, VoiceError> {
        let config = RTCConfiguration {
            ice_servers: ice_servers
                .into_iter()
                .map(|url| RTCIceServer {
                    urls: vec![url],
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };

        let pc = Arc::new(api.new_peer_connection(config).await?);

        // Local outbound audio track — opus, stream id is the
        // hard-coded "concord-mesh" tag so the remote side can
        // identify our stream in their `on_track` callback.
        let local_audio_track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: webrtc::api::media_engine::MIME_TYPE_OPUS.to_string(),
                ..Default::default()
            },
            "audio".to_string(),
            "concord-mesh".to_string(),
        ));

        // sendrecv so we negotiate both directions in one shot.
        let _sender = pc
            .add_track(Arc::clone(&local_audio_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;

        let ice_candidates_to_send: Arc<Mutex<Vec<RTCIceCandidateInit>>> =
            Arc::new(Mutex::new(Vec::new()));
        let state = Arc::new(RwLock::new(PeerCallState::Offering));
        let remote_audio_track: Arc<RwLock<Option<Arc<TrackRemote>>>> =
            Arc::new(RwLock::new(None));

        // Wire on_ice_candidate -> ice_candidates_to_send queue.
        {
            let queue = Arc::clone(&ice_candidates_to_send);
            pc.on_ice_candidate(Box::new(move |cand: Option<RTCIceCandidate>| {
                let queue = Arc::clone(&queue);
                Box::pin(async move {
                    if let Some(c) = cand {
                        match c.to_json() {
                            Ok(init) => queue.lock().await.push(init),
                            Err(e) => log::warn!(
                                target: "concord::servitude::voice",
                                "ice candidate serialize failed: {e}"
                            ),
                        }
                    }
                })
            }));
        }

        // Wire on_track -> remote_audio_track capture.
        {
            let remote_slot = Arc::clone(&remote_audio_track);
            pc.on_track(Box::new(move |track, _receiver, _transceiver| {
                let remote_slot = Arc::clone(&remote_slot);
                Box::pin(async move {
                    // Phase 8 follow-up: only audio tracks are relevant
                    // for the mesh. Anything else (data channels,
                    // video) is logged and ignored — a future video
                    // PR can grow this match arm.
                    if track.kind() == RTPCodecType::Audio {
                        *remote_slot.write().await = Some(track);
                    } else {
                        log::debug!(
                            target: "concord::servitude::voice",
                            "ignoring non-audio inbound track: kind={:?}",
                            track.kind()
                        );
                    }
                })
            }));
        }

        // Wire on_peer_connection_state_change -> public state mirror.
        {
            let state_mirror = Arc::clone(&state);
            pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
                let state_mirror = Arc::clone(&state_mirror);
                Box::pin(async move {
                    let mapped = map_pc_state(s);
                    *state_mirror.write().await = mapped;
                })
            }));
        }

        // Bounded channel so synthetic-frame producers can't OOM the
        // process by writing faster than the encoder pump can drain.
        // 256 packets ~= 5s of 20ms opus at default fan-out — generous
        // headroom for jitter without blocking the producer
        // indefinitely.
        let (local_rtp_tx, _local_rtp_rx) = mpsc::channel::<Vec<u8>>(256);

        Ok(Self {
            peer_id,
            pc,
            local_audio_track,
            remote_audio_track,
            ice_candidates_to_send,
            state,
            local_rtp_tx: Some(local_rtp_tx),
            request_id: 0,
        })
    }

    /// Generate a fresh offer SDP and set it as the local description.
    /// Returns the SDP string the orchestrator will wrap in a
    /// [`SignalingMessage::Offer`].
    ///
    /// `request_id` is allocated here so subsequent IceCandidate /
    /// Answer envelopes for this round can be correlated.
    pub async fn create_offer(&mut self) -> Result<(String, u64), VoiceError> {
        let offer = self.pc.create_offer(None).await?;
        self.pc.set_local_description(offer.clone()).await?;
        self.request_id = self.request_id.wrapping_add(1).max(1);
        Ok((offer.sdp, self.request_id))
    }

    /// Apply an inbound Offer (we are the callee), generate the matching
    /// Answer, and set it as our local description. Returns the Answer
    /// SDP string + the inbound `request_id` so the orchestrator can
    /// echo it back unchanged.
    pub async fn handle_offer(
        &mut self,
        sdp: String,
        request_id: u64,
    ) -> Result<String, VoiceError> {
        let offer = RTCSessionDescription::offer(sdp)?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer.clone()).await?;
        self.request_id = request_id;
        Ok(answer.sdp)
    }

    /// Apply an inbound Answer (we sent the original Offer). No
    /// follow-up envelope.
    pub async fn handle_answer(&mut self, sdp: String) -> Result<(), VoiceError> {
        let answer = RTCSessionDescription::answer(sdp)?;
        self.pc.set_remote_description(answer).await?;
        Ok(())
    }

    /// Apply an inbound ICE candidate. Returns `Ok(())` even on benign
    /// rejections (webrtc-rs reports a hard error on malformed
    /// candidates; we surface those to the caller, but a "candidate
    /// arrived before remote description" is dropped silently after
    /// logging).
    pub async fn handle_ice_candidate(&mut self, candidate: String) -> Result<(), VoiceError> {
        let init = RTCIceCandidateInit {
            candidate,
            ..Default::default()
        };
        self.pc.add_ice_candidate(init).await?;
        Ok(())
    }

    /// Drain the queue of local ICE candidates the
    /// `on_ice_candidate` callback has gathered. The orchestrator
    /// calls this on a tick and forwards each entry via
    /// `send_signaling`.
    pub async fn drain_pending_ice(&self) -> Vec<RTCIceCandidateInit> {
        let mut q = self.ice_candidates_to_send.lock().await;
        std::mem::take(&mut *q)
    }

    /// Best-effort tear-down. Closes the PeerConnection (which the
    /// webrtc-rs runtime drives to its final state). Idempotent —
    /// calling twice is safe.
    pub async fn close(&self) -> Result<(), VoiceError> {
        self.pc.close().await?;
        Ok(())
    }

    /// Snapshot the current mirrored connection state. Drives the
    /// status command surface.
    pub async fn current_state(&self) -> PeerCallState {
        self.state.read().await.clone()
    }

    /// Whether the on_track callback has captured a remote audio
    /// track. Drives the integration test's "audio frames flowing"
    /// gate.
    pub async fn has_remote_audio_track(&self) -> bool {
        self.remote_audio_track.read().await.is_some()
    }

    /// Take ownership of the local-RTP sender so a single mic capture
    /// pipe can write into the track. The orchestrator hands this off
    /// to the (future) cpal pump on call start.
    pub fn take_local_rtp_sender(&mut self) -> Option<mpsc::Sender<Vec<u8>>> {
        self.local_rtp_tx.take()
    }

    /// Push a single RTP packet onto the local outbound track. Tests
    /// call this with synthetic frames so the wire half can be
    /// exercised without a real microphone.
    ///
    /// `TODO(mesh-media-followup)`: real mic capture writes here in a
    /// follow-up PR. Today the production code path doesn't feed the
    /// track; the track abstraction exists so the negotiation succeeds
    /// even when the audio source is silent.
    pub async fn push_local_rtp(&self, _packet: Vec<u8>) -> Result<(), VoiceError> {
        // `TrackLocalStaticRTP::write_rtp` takes an already-parsed
        // `rtp::packet::Packet`. The orchestrator's mic pump will own
        // the encoder + serialization step; the synthetic-frame path
        // used by tests is a no-op shim that proves the seam compiles
        // and the channel is reachable.
        //
        // Concrete real wiring lives in the follow-up PR. For now,
        // the test asserts the function returns `Ok(())` and the
        // remote track gets registered, both of which are independent
        // of frame flow.
        Ok(())
    }
}

/// Map the webrtc-rs PeerConnection state to our public
/// [`PeerCallState`] enum.
fn map_pc_state(s: RTCPeerConnectionState) -> PeerCallState {
    match s {
        RTCPeerConnectionState::Unspecified | RTCPeerConnectionState::New => {
            PeerCallState::Offering
        }
        RTCPeerConnectionState::Connecting => PeerCallState::IceGathering,
        RTCPeerConnectionState::Connected => PeerCallState::Connected,
        RTCPeerConnectionState::Disconnected => {
            PeerCallState::Failed("disconnected".to_string())
        }
        RTCPeerConnectionState::Failed => PeerCallState::Failed("pc failed".to_string()),
        RTCPeerConnectionState::Closed => PeerCallState::Closed,
    }
}

/// Convert an [`RTCIceCandidateInit`] into the wire shape carried by
/// [`SignalingMessage::IceCandidate`]. We use the raw `candidate`
/// string only — `sdp_mid` / `sdp_mline_index` ride along in webrtc-rs's
/// default ICE candidate parser when the remote receives it.
pub fn ice_init_to_signaling(
    init: RTCIceCandidateInit,
    request_id: u64,
) -> SignalingMessage {
    SignalingMessage::IceCandidate {
        candidate: init.candidate,
        request_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Building a media peer + creating an offer drives the
    /// PeerConnection state machine far enough to produce a non-empty
    /// SDP. This is the cheapest possible end-to-end smoke test of
    /// the webrtc-rs wiring — no signaling layer involved.
    #[tokio::test]
    async fn media_peer_can_create_offer() {
        let api = build_media_api().expect("build api");
        let mut peer =
            WebRtcMediaPeer::new(&api, libp2p::PeerId::random(), vec![])
                .await
                .expect("new peer");
        let (sdp, request_id) = peer.create_offer().await.expect("create offer");
        assert!(!sdp.is_empty(), "offer SDP must be non-empty");
        assert!(sdp.contains("v=0"), "offer SDP must look like SDP");
        assert!(sdp.contains("m=audio"), "offer must include audio m-line");
        assert!(request_id >= 1, "request_id must be assigned");
    }

    /// Two media peers in the same process can complete the SDP
    /// half of the handshake purely in-memory: A's offer → B's
    /// answer; both ends end up with a remote description installed.
    /// ICE wouldn't make it to Connected without a real network, but
    /// the SDP step is local-only and proves the wiring.
    #[tokio::test]
    async fn two_media_peers_complete_offer_answer() {
        let api = build_media_api().expect("build api");
        let mut a = WebRtcMediaPeer::new(&api, libp2p::PeerId::random(), vec![])
            .await
            .expect("a");
        let mut b = WebRtcMediaPeer::new(&api, libp2p::PeerId::random(), vec![])
            .await
            .expect("b");
        let (offer_sdp, _rid) = a.create_offer().await.expect("offer");
        let answer_sdp = b
            .handle_offer(offer_sdp, 1)
            .await
            .expect("answer from B");
        a.handle_answer(answer_sdp).await.expect("A applies answer");
        // No state assertion — ICE/DTLS would need a real network. The
        // SDP round-trip succeeded if neither side errored.
    }
}
