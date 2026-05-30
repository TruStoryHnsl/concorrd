//! Phase 8 follow-up — voice-call orchestration.
//!
//! A [`VoiceCall`] is the per-room state owned by the native servitude
//! when the path selector picks `LibP2pMesh` and the local user joins
//! the call. It tracks:
//!
//!   * the local libp2p `PeerId` (carried so test code can render
//!     "from" attributions deterministically),
//!   * one [`WebRtcMediaPeer`] per remote participant,
//!   * the outbound signaling sink — a `mpsc::Sender` the orchestrator
//!     drains and forwards to [`super::signaling::send_signaling`] in
//!     the swarm event loop,
//!   * a shared [`MediaApi`] handle so every peer in the call reuses
//!     one webrtc-rs registry.
//!
//! Inbound signaling envelopes are handed to [`VoiceCall::on_signaling_in`]
//! by [`VoiceCallSinkImpl`] (the registry's [`VoiceCallSink`]
//! implementation). The handler:
//!
//!   1. Looks up (or creates) the [`WebRtcMediaPeer`] for the inbound
//!      `from` peer.
//!   2. Drives the SDP / ICE state forward.
//!   3. If a response envelope is needed (e.g. inbound Offer →
//!      outbound Answer), puts it on the outbound queue tagged with
//!      the same remote peer id.
//!   4. Drains any newly-gathered local ICE candidates from the
//!      peer's queue and pushes them onto the outbound side as well.
//!
//! ## Registry
//!
//! [`VoiceCallRegistry`] is the Tauri-managed state shape. It maps a
//! `room_id` to a `VoiceCall` so multiple concurrent voice rooms can
//! coexist (e.g. the user is in the "general voice" channel and also
//! a 2-person huddle on a different room). The registry is also the
//! signaling sink — `LibP2pRuntime::start` wires
//! [`VoiceCallSinkImpl`] (a thin Arc'd wrapper around the registry)
//! as the `VoiceCallSink` so the dispatcher routes every inbound
//! envelope to the matching call.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use libp2p::PeerId;
use tokio::sync::{mpsc, Mutex};

use super::error::VoiceError;
use super::media::{build_media_api, ice_init_to_signaling, MediaApi, WebRtcMediaPeer};
use super::signaling::{SignalingMessage, VoiceCallSink};
use super::webrtc_peer::PeerCallState;

/// Lifecycle marker for a [`VoiceCall`] — used by status reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallState {
    /// Call is active; per-peer state is in `VoiceCall.peers`.
    Active,
    /// Call was torn down via [`VoiceCall::leave`]. Kept briefly so
    /// the UI can render the disconnect animation; the registry
    /// removes it shortly after.
    Closed,
}

/// Snapshot returned by [`VoiceCallRegistry::snapshot_status`].
/// Owned values only — the Tauri command serializes this without
/// holding any registry locks.
#[derive(Debug, Clone)]
pub struct RegistryCallSnapshot {
    /// `"active"` or `"closed"`.
    pub state: String,
    /// Per-peer call state, keyed by remote `PeerId`.
    pub peers: Vec<(PeerId, PeerCallState)>,
}

/// One live mesh-mode voice call.
///
/// Owned by [`VoiceCallRegistry`] and addressable by `room_id`. The
/// orchestrator (this struct) is the only thing that mutates the
/// per-peer media wrappers — handlers register an `Arc<Mutex<VoiceCall>>`
/// via the registry so concurrent inbound envelopes serialize cleanly.
pub struct VoiceCall {
    pub room_id: String,
    pub local_peer_id: PeerId,
    pub peers: HashMap<PeerId, WebRtcMediaPeer>,
    pub state: CallState,

    /// Shared webrtc API for this call — reused across every peer in
    /// `peers`.
    api: MediaApi,

    /// Bounded channel feeding the outbound signaling drain. The
    /// `LibP2pRuntime` event loop receives on the matching `Receiver`
    /// and calls `send_signaling(control, peer_id, message)` for each
    /// entry.
    signaling_outbound: mpsc::Sender<(PeerId, SignalingMessage)>,

    /// ICE servers passed to every peer constructed in this call.
    /// Comes from the Tauri command's `voice_mesh_join` argument
    /// (originally derived from `getVoiceToken`'s `ice_servers` list).
    ice_servers: Vec<String>,
}

impl std::fmt::Debug for VoiceCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VoiceCall")
            .field("room_id", &self.room_id)
            .field("local_peer_id", &self.local_peer_id)
            .field("peer_count", &self.peers.len())
            .field("state", &self.state)
            .finish()
    }
}

impl VoiceCall {
    /// Construct a fresh call. Builds the shared [`MediaApi`] up-front
    /// so [`Self::add_peer`] doesn't pay per-peer init cost.
    pub fn new(
        room_id: String,
        local_peer_id: PeerId,
        signaling_outbound: mpsc::Sender<(PeerId, SignalingMessage)>,
        ice_servers: Vec<String>,
    ) -> Result<Self, VoiceError> {
        let api = build_media_api()?;
        Ok(Self {
            room_id,
            local_peer_id,
            peers: HashMap::new(),
            state: CallState::Active,
            api,
            signaling_outbound,
            ice_servers,
        })
    }

    /// Add a remote peer to the call AS AN INITIATOR — builds the
    /// PeerConnection, creates an Offer, and queues it for the
    /// outbound signaling drain. The remote will reply with an
    /// Answer; [`Self::on_signaling_in`] handles the response.
    pub async fn add_peer_as_initiator(
        &mut self,
        peer_id: PeerId,
    ) -> Result<(), VoiceError> {
        if self.peers.contains_key(&peer_id) {
            return Err(VoiceError::PeerAlreadyPresent(peer_id));
        }
        let mut media =
            WebRtcMediaPeer::new(&self.api, peer_id, self.ice_servers.clone()).await?;
        let (sdp, request_id) = media.create_offer().await?;
        self.peers.insert(peer_id, media);
        self.send_outbound(peer_id, SignalingMessage::Offer { sdp, request_id })
            .await?;
        Ok(())
    }

    /// Inbound dispatch — called by [`VoiceCallSinkImpl::deliver`] for
    /// every envelope whose `from` is a member of this call's room.
    pub async fn on_signaling_in(
        &mut self,
        from: PeerId,
        message: SignalingMessage,
    ) -> Result<(), VoiceError> {
        // Auto-create a peer entry when an Offer arrives from someone
        // we haven't seen yet — the callee path. Every other envelope
        // type requires an existing entry; if we get one without a
        // peer, the message is ignored (probably arrived after a
        // leave / before a stale Offer was retransmitted).
        match &message {
            SignalingMessage::Offer { .. } => {
                if !self.peers.contains_key(&from) {
                    let media =
                        WebRtcMediaPeer::new(&self.api, from, self.ice_servers.clone())
                            .await?;
                    self.peers.insert(from, media);
                }
            }
            _ => {
                if !self.peers.contains_key(&from) {
                    log::debug!(
                        target: "concord::servitude::voice",
                        "voice signaling envelope for unknown peer {from} \
                         (probably a stale message after leave); ignoring"
                    );
                    return Ok(());
                }
            }
        }

        let peer = self
            .peers
            .get_mut(&from)
            .ok_or(VoiceError::PeerNotPresent(from))?;

        match message {
            SignalingMessage::Offer { sdp, request_id } => {
                let answer_sdp = peer.handle_offer(sdp, request_id).await?;
                self.send_outbound(
                    from,
                    SignalingMessage::Answer {
                        sdp: answer_sdp,
                        request_id,
                    },
                )
                .await?;
            }
            SignalingMessage::Answer {
                sdp,
                request_id: _,
            } => {
                peer.handle_answer(sdp).await?;
            }
            SignalingMessage::IceCandidate {
                candidate,
                request_id: _,
            } => {
                if let Err(e) = peer.handle_ice_candidate(candidate).await {
                    // Tolerate "candidate arrived before remote
                    // description" — webrtc-rs reports it as an
                    // error, but real ICE traces often see this race
                    // and recover. Log + continue.
                    log::debug!(
                        target: "concord::servitude::voice",
                        "ice add error from {from}: {e}"
                    );
                }
            }
            SignalingMessage::Bye { request_id: _ } => {
                // Remote left. Stop our mic pump first (so we don't
                // keep writing into a doomed track), then close the
                // PC, which aborts the receive pipeline too.
                peer.stop_audio_capture().await;
                let _ = peer.close().await;
                self.peers.remove(&from);
            }
        }

        // After handling the inbound envelope, drain any newly-gathered
        // local ICE candidates and forward them. The on_ice_candidate
        // callback may have queued candidates between the start of
        // this method and now.
        self.drain_pending_outbound(from).await?;

        // If the PC just transitioned to Connected, start the mic
        // pump. Idempotent — the audio module no-ops if a pipeline
        // is already running for this peer.
        self.maybe_start_audio_capture(from).await;
        Ok(())
    }

    /// Check the per-peer state — if the PeerConnection has reached
    /// `Connected`, spawn the audio send pipeline (if not already
    /// running). Called from both the inbound dispatch path and from
    /// [`Self::tick`] so a Connected transition triggered by ICE
    /// gathering (no inbound envelope) is also picked up.
    async fn maybe_start_audio_capture(&mut self, peer_id: PeerId) {
        let peer = match self.peers.get_mut(&peer_id) {
            Some(p) => p,
            None => return,
        };
        let state = peer.current_state().await;
        if !matches!(state, PeerCallState::Connected) {
            return;
        }
        if let Err(e) = peer.start_audio_capture().await {
            // AudioNotSupported on iOS is expected; lower-severity log.
            // Other errors (no input device, opus init failure) are
            // worth a warn — the call still functions but the local
            // user sends silence.
            match &e {
                VoiceError::AudioNotSupported => log::debug!(
                    target: "concord::servitude::voice",
                    "audio capture not supported on this platform; \
                     remote will receive silence from {peer_id}"
                ),
                other => log::warn!(
                    target: "concord::servitude::voice",
                    "start_audio_capture({peer_id}) failed: {other}"
                ),
            }
        }
    }

    /// Drain ICE candidates from a single peer and push them onto the
    /// outbound signaling queue.
    async fn drain_pending_outbound(&mut self, peer_id: PeerId) -> Result<(), VoiceError> {
        // The signaling protocol's `request_id` only correlates
        // Offer→Answer; ICE candidates don't strictly need a matching
        // id, so we pass a stable per-peer value (1).
        let request_id: u64 = 1;
        let candidates = match self.peers.get(&peer_id) {
            Some(p) => p.drain_pending_ice().await,
            None => return Ok(()),
        };
        for init in candidates {
            let msg = ice_init_to_signaling(init, request_id);
            self.send_outbound(peer_id, msg).await?;
        }
        Ok(())
    }

    /// Periodic tick — drain ICE candidates from every peer + start
    /// the mic pump on any peer that reached Connected since the last
    /// tick. Called by the orchestrator's status / drain loop on a
    /// 200ms cadence in production.
    pub async fn tick(&mut self) -> Result<(), VoiceError> {
        let peer_ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for pid in peer_ids {
            self.drain_pending_outbound(pid).await?;
            self.maybe_start_audio_capture(pid).await;
        }
        Ok(())
    }

    /// Tear down the call. Stops mic capture on every peer, closes
    /// every PeerConnection (which aborts the receive pipelines via
    /// `WebRtcMediaPeer::close`), marks state Closed, and emits Bye
    /// to every remote so they can do the same.
    pub async fn leave(&mut self) -> Result<(), VoiceError> {
        for (pid, peer) in self.peers.iter_mut() {
            let _ = self
                .signaling_outbound
                .send((*pid, SignalingMessage::Bye { request_id: 0 }))
                .await;
            peer.stop_audio_capture().await;
            let _ = peer.close().await;
        }
        self.peers.clear();
        self.state = CallState::Closed;
        Ok(())
    }

    /// Snapshot per-peer connection state for the status command.
    pub async fn snapshot_status(&self) -> Vec<(PeerId, PeerCallState)> {
        let mut out = Vec::with_capacity(self.peers.len());
        for (pid, peer) in self.peers.iter() {
            out.push((*pid, peer.current_state().await));
        }
        out
    }

    async fn send_outbound(
        &self,
        peer_id: PeerId,
        message: SignalingMessage,
    ) -> Result<(), VoiceError> {
        self.signaling_outbound
            .send((peer_id, message))
            .await
            .map_err(|e| VoiceError::ChannelClosed(format!("signaling outbound: {e}")))
    }
}

/// Tauri-managed state — maps `room_id` to a live [`VoiceCall`].
///
/// `Arc<Mutex<…>>` because:
///   * the Tauri command handlers + the `VoiceCallSinkImpl` both need
///     read+write access,
///   * the lock is held across `.await` points (webrtc-rs operations
///     are async), so it must be `tokio::sync::Mutex`.
#[derive(Default)]
pub struct VoiceCallRegistry {
    calls: Mutex<HashMap<String, VoiceCall>>,
}

impl VoiceCallRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new call. Returns an error if a call with the same
    /// `room_id` already exists — the frontend should call
    /// `voice_mesh_leave` before re-joining.
    pub async fn insert(&self, call: VoiceCall) -> Result<(), VoiceError> {
        let mut map = self.calls.lock().await;
        if map.contains_key(&call.room_id) {
            return Err(VoiceError::CallNotFound(format!(
                "voice call already active for {}",
                call.room_id
            )));
        }
        map.insert(call.room_id.clone(), call);
        Ok(())
    }

    /// Remove and tear down the call for `room_id`.
    pub async fn remove(&self, room_id: &str) -> Result<(), VoiceError> {
        let mut map = self.calls.lock().await;
        let mut call = map
            .remove(room_id)
            .ok_or_else(|| VoiceError::CallNotFound(room_id.to_string()))?;
        call.leave().await?;
        Ok(())
    }

    /// Whether a call exists for `room_id` (used by health probes /
    /// tests).
    pub async fn contains(&self, room_id: &str) -> bool {
        self.calls.lock().await.contains_key(room_id)
    }

    /// Snapshot the per-room status for the Tauri `voice_mesh_status`
    /// command. Returns an aggregate view — call state + per-peer
    /// state — so the command can serialize without re-locking the
    /// registry per peer.
    pub async fn snapshot_status(
        &self,
        room_id: &str,
    ) -> Result<RegistryCallSnapshot, VoiceError> {
        let map = self.calls.lock().await;
        let call = map
            .get(room_id)
            .ok_or_else(|| VoiceError::CallNotFound(room_id.to_string()))?;
        let state = match call.state {
            CallState::Active => "active".to_string(),
            CallState::Closed => "closed".to_string(),
        };
        let peers = call.snapshot_status().await;
        Ok(RegistryCallSnapshot { state, peers })
    }

    /// Drive an initiator-side add-peer through the call entry for
    /// `room_id`. Pushes an Offer onto the outbound channel.
    pub async fn add_peer_as_initiator(
        &self,
        room_id: &str,
        peer_id: PeerId,
    ) -> Result<(), VoiceError> {
        let mut map = self.calls.lock().await;
        let call = map
            .get_mut(room_id)
            .ok_or_else(|| VoiceError::CallNotFound(room_id.to_string()))?;
        call.add_peer_as_initiator(peer_id).await
    }

    /// Manually drive a tick on the call orchestrator. Production
    /// wiring spawns a periodic task that calls this every 200ms; the
    /// tests drive it explicitly.
    pub async fn tick(&self, room_id: &str) -> Result<(), VoiceError> {
        let mut map = self.calls.lock().await;
        let call = map
            .get_mut(room_id)
            .ok_or_else(|| VoiceError::CallNotFound(room_id.to_string()))?;
        call.tick().await
    }

    /// Iterate over every active call and dispatch the inbound
    /// envelope to whichever one knows about `from`. Used by the
    /// [`VoiceCallSink`] impl when the dispatcher doesn't know which
    /// room the envelope belongs to (the wire format doesn't carry
    /// room id; the mapping is "the call whose peers contain `from`").
    pub async fn deliver_signaling(&self, from: PeerId, message: SignalingMessage) {
        let mut map = self.calls.lock().await;
        let mut target_room: Option<String> = None;
        for (room, call) in map.iter() {
            if call.peers.contains_key(&from) {
                target_room = Some(room.clone());
                break;
            }
        }
        // No mapping yet — this might be an Offer from a peer the
        // local side hasn't added explicitly. Route it to whichever
        // call is active (best-effort; in production the caller is
        // expected to add the peer first via `voice_mesh_join`).
        let target_room = target_room.or_else(|| map.keys().next().cloned());
        let Some(room) = target_room else {
            log::debug!(
                target: "concord::servitude::voice",
                "voice signaling envelope from {from} with no active call; dropping"
            );
            return;
        };
        if let Some(call) = map.get_mut(&room) {
            if let Err(e) = call.on_signaling_in(from, message).await {
                log::warn!(
                    target: "concord::servitude::voice",
                    "voice signaling dispatch error (room={room}, from={from}): {e}"
                );
            }
        }
    }
}

/// [`VoiceCallSink`] implementation backed by a [`VoiceCallRegistry`].
/// Registered as the signaling handler's sink in `LibP2pRuntime::start`.
pub struct VoiceCallSinkImpl {
    pub registry: Arc<VoiceCallRegistry>,
}

impl VoiceCallSinkImpl {
    pub fn new(registry: Arc<VoiceCallRegistry>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl VoiceCallSink for VoiceCallSinkImpl {
    async fn deliver(&self, from: PeerId, message: SignalingMessage) {
        self.registry.deliver_signaling(from, message).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn registry_insert_and_remove() {
        let registry = VoiceCallRegistry::new();
        let (tx, _rx) = mpsc::channel(8);
        let call = VoiceCall::new(
            "!room:test.org".to_string(),
            PeerId::random(),
            tx,
            vec![],
        )
        .expect("call new");
        registry.insert(call).await.expect("insert");
        assert!(registry.contains("!room:test.org").await);
        registry.remove("!room:test.org").await.expect("remove");
        assert!(!registry.contains("!room:test.org").await);
    }

    #[tokio::test]
    async fn registry_insert_duplicate_room_errors() {
        let registry = VoiceCallRegistry::new();
        let (tx, _rx) = mpsc::channel(8);
        let call = VoiceCall::new("!r".into(), PeerId::random(), tx.clone(), vec![])
            .expect("call new");
        registry.insert(call).await.expect("first insert");
        let dup = VoiceCall::new("!r".into(), PeerId::random(), tx, vec![]).expect("dup");
        assert!(registry.insert(dup).await.is_err());
    }
}
