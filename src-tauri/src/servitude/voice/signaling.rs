//! Phase 8 (INS-019b) — voice signaling over a libp2p stream protocol.
//!
//! Reuses the Phase 6 [`crate::servitude::federation::FederationHandler`]
//! trait. Voice signaling is just another payload type — protocol-agnostic
//! transport doesn't care that the envelope is offer/answer/ice rather
//! than a Matrix federation request. New protocol ID, new handler, same
//! plumbing.
//!
//! Wire format: 4-byte big-endian length prefix + JSON envelope. 1 MiB
//! cap — signaling messages are small (SDP blocks measured in KB, ICE
//! candidates in hundreds of bytes). Anything bigger is treated as a
//! framing desync.
//!
//! ## Inbound dispatch
//!
//! The Phase 6 trait was refactored as part of Phase 8 so
//! [`FederationHandler::handle_inbound`] receives the remote peer's
//! `PeerId` alongside the stream. Voice signaling NEEDS the peer ID —
//! an inbound Offer has to be attributed to a `WebRtcPeer` somewhere,
//! and the signaling layer is the only place that knows.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

/// libp2p stream protocol ID for voice signaling. Distinct namespace
/// from the Matrix federation protocol so the dispatcher routes them
/// to different handlers.
pub const SIGNALING_PROTOCOL_ID: &str = "/concord/voice-signaling/1.0.0";

/// Maximum size of a single framed envelope. 1 MiB is generous for
/// signaling — a long SDP blob is ~10 KB, an ICE candidate is a few
/// hundred bytes. Anything over the cap is a framing desync.
const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;

/// Wire-level signaling message. Carries the four primitives WebRTC
/// signaling needs: Offer (initiator → callee), Answer (callee →
/// initiator), IceCandidate (either direction, repeated), and Bye
/// (clean call teardown).
///
/// `request_id` correlates an Offer with its matching Answer; both
/// sides may have multiple calls in flight simultaneously.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalingMessage {
    Offer { sdp: String, request_id: u64 },
    Answer { sdp: String, request_id: u64 },
    IceCandidate { candidate: String, request_id: u64 },
    Bye { request_id: u64 },
}

/// Sink the inbound dispatcher hands decoded envelopes to. The
/// higher-level voice subsystem (the orchestration layer in `lib.rs`)
/// implements this; tests wire a mock that records every delivery.
///
/// Kept as a trait object so the handler doesn't own a tokio channel
/// directly — the call layer can swap its dispatch mechanism without
/// touching the signaling handler.
#[async_trait]
pub trait VoiceCallSink: Send + Sync {
    /// Called for every well-formed inbound envelope. `from` is the
    /// remote peer's libp2p `PeerId`, threaded through by the
    /// dispatcher via the Phase 8 trait refactor.
    async fn deliver(&self, from: PeerId, message: SignalingMessage);
}

/// Concrete signaling handler. Holds an `Arc<dyn VoiceCallSink>` so
/// production and test wiring can substitute different backends
/// without changing the handler.
pub struct VoiceSignalingHandler {
    sink: Arc<dyn VoiceCallSink>,
}

impl VoiceSignalingHandler {
    pub fn new(sink: Arc<dyn VoiceCallSink>) -> Self {
        Self { sink }
    }
}

impl FederationProtocol for VoiceSignalingHandler {
    const PROTOCOL_ID: &'static str = SIGNALING_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for VoiceSignalingHandler {
    fn protocol_id(&self) -> &'static str {
        SIGNALING_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("voice-signaling")
    }

    async fn handle_inbound(
        &self,
        peer_id: PeerId,
        mut stream: Stream,
    ) -> Result<(), FederationError> {
        // Loop reading framed envelopes until the peer cleanly closes the
        // stream (EOF on the length-prefix read). Each envelope is
        // attributed to `peer_id` (the remote's libp2p PeerId, threaded
        // through by the Phase 8 trait refactor) and handed to the sink.
        loop {
            let mut len_buf = [0u8; 4];
            match stream.read_exact(&mut len_buf).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    // Clean EOF — peer is done. Normal exit path.
                    return Ok(());
                }
                Err(e) => return Err(FederationError::Io(e)),
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len > MAX_ENVELOPE_BYTES {
                return Err(FederationError::MalformedEnvelope(format!(
                    "voice envelope too large: {len} > {MAX_ENVELOPE_BYTES}"
                )));
            }
            let mut buf = vec![0u8; len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;
            let message: SignalingMessage =
                serde_json::from_slice(&buf).map_err(FederationError::Serde)?;
            self.sink.deliver(peer_id, message).await;
        }
    }
}

/// Outbound helper: open a signaling stream to `peer_id`, send one
/// framed envelope, close cleanly. Used by the call orchestration
/// layer when it needs to push an Offer / Answer / IceCandidate / Bye
/// to a remote peer.
///
/// One envelope per stream is fine for signaling — each message is
/// independent and the dispatcher dispatches each inbound stream to
/// its own handler invocation, so per-message stream reuse buys
/// nothing.
pub async fn send_signaling(
    control: &mut Control,
    peer_id: PeerId,
    message: SignalingMessage,
) -> Result<(), FederationError> {
    let proto = StreamProtocol::new(SIGNALING_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| FederationError::Upstream(format!("open_stream: {e:?}")))?;
    let bytes = serde_json::to_vec(&message).map_err(FederationError::Serde)?;
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(FederationError::MalformedEnvelope(format!(
            "outbound voice envelope too large: {} > {MAX_ENVELOPE_BYTES}",
            bytes.len()
        )));
    }
    let len = (bytes.len() as u32).to_be_bytes();
    stream
        .write_all(&len)
        .await
        .map_err(FederationError::Io)?;
    stream
        .write_all(&bytes)
        .await
        .map_err(FederationError::Io)?;
    stream.flush().await.map_err(FederationError::Io)?;
    // Best-effort close — the peer may already be reading EOF and
    // close, which would error here. The envelope has already been
    // committed to the wire.
    let _ = stream.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SignalingMessage round-trips through JSON. The serde tag form
    /// must match the documented wire shape (`type` + payload fields)
    /// — this is the contract the browser side will eventually have
    /// to match in Phase 9.
    #[test]
    fn signaling_message_round_trips_through_json() {
        let offer = SignalingMessage::Offer {
            sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n".into(),
            request_id: 42,
        };
        let bytes = serde_json::to_vec(&offer).expect("offer must serialize");
        let parsed: SignalingMessage =
            serde_json::from_slice(&bytes).expect("offer must deserialize");
        assert_eq!(offer, parsed);
    }

    /// The wire form uses `snake_case` tag values. Pins the contract
    /// so a refactor that flips serde renaming gets caught here, not
    /// at the browser↔native boundary.
    #[test]
    fn signaling_message_uses_snake_case_tag() {
        let bye = SignalingMessage::Bye { request_id: 7 };
        let v: serde_json::Value =
            serde_json::from_slice(&serde_json::to_vec(&bye).unwrap()).unwrap();
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("bye"));
        assert_eq!(v.get("request_id").and_then(|r| r.as_u64()), Some(7));
    }
}
