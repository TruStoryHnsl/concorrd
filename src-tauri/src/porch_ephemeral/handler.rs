//! Inbound libp2p handler for the ephemeral porch's
//! `/concord/porch-ephemeral/1.0.0` protocol.
//!
//! ## Stream lifecycle
//!
//! ```text
//!   Dialer                                  Handler
//!   ------                                  -------
//!   |  PorchCredentials  --------------->  |  verify(dialer, claimed)
//!   |  <---------------  PorchAuthResult   |
//!   |                                      |
//!   |  EphemeralRequest --------------->   |  dispatch()
//!   |  <---------------  EphemeralResponse |
//!   |                                      |
//!   |  EphemeralRequest --------------->   |  dispatch()
//!   |  <---------------  EphemeralResponse |
//!   |                ...                   |
//!   |  EOF             --------------->    |  return Ok(())
//! ```
//!
//! Each frame is 4-byte big-endian length-prefixed JSON. The handler
//! reads the gate frame first; on failure it writes the structured
//! `Err` result back and closes the stream. On success it loops on
//! request/response pairs until the dialer cleanly EOFs.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream};
use serde::{Deserialize, Serialize};

use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

use super::{
    EphemeralChannel, EphemeralMessage, EphemeralPorch, PorchAuthError, PorchAuthResult,
    PorchCredentials, EPHEMERAL_PORCH_PROTOCOL_ID, MAX_ENVELOPE_BYTES,
};

/// Request envelope sent by the dialer after the gate frame is
/// accepted. Tagged `{"method":"...", "params":{...}}` for JSON-RPC-ish
/// parity with the persistent porch's wire shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum EphemeralRequest {
    /// List every channel on the porch.
    ListChannels,
    /// Read all messages in a channel. F1a does not paginate — the
    /// porch is bounded at `MAX_MESSAGES_PER_CHANNEL`.
    GetMessages { channel_id: String },
    /// Append a message to a channel. `author_peer_id` is stamped by
    /// the handler with the validated dialer's peer-id — the dialer
    /// cannot spoof their own author.
    SendMessage { channel_id: String, body: String },
}

/// Response envelope. Exactly one of `result` / `error` is populated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EphemeralResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PorchAuthError>,
}

impl EphemeralResponse {
    fn from_value(value: serde_json::Value) -> Self {
        Self {
            ok: true,
            result: Some(value),
            error: None,
        }
    }

    fn from_error(error: PorchAuthError) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/// libp2p `/concord/porch-ephemeral/1.0.0` handler. Holds an
/// `Arc<EphemeralPorch>` so multiple inbound streams can dispatch
/// against the same in-process state concurrently.
pub struct EphemeralPorchHandler {
    porch: Arc<EphemeralPorch>,
}

impl EphemeralPorchHandler {
    pub fn new(porch: Arc<EphemeralPorch>) -> Self {
        Self { porch }
    }

    /// Read one length-prefixed JSON frame off the stream, bounded by
    /// `MAX_ENVELOPE_BYTES`.
    async fn read_frame<R: AsyncReadExt + Unpin>(
        stream: &mut R,
    ) -> Result<Vec<u8>, PorchAuthError> {
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > MAX_ENVELOPE_BYTES {
            return Err(PorchAuthError::EnvelopeTooLarge(format!(
                "{len} > {MAX_ENVELOPE_BYTES}"
            )));
        }
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).await?;
        Ok(buf)
    }

    /// Write one length-prefixed JSON frame to the stream.
    async fn write_frame<W: AsyncWriteExt + Unpin, T: Serialize>(
        stream: &mut W,
        payload: &T,
    ) -> Result<(), PorchAuthError> {
        let bytes = serde_json::to_vec(payload)?;
        let len_be = (bytes.len() as u32).to_be_bytes();
        stream.write_all(&len_be).await?;
        stream.write_all(&bytes).await?;
        stream.flush().await?;
        Ok(())
    }

    /// Dispatch a single decoded request against the porch. Public so
    /// tests can drive the request/response path without standing up
    /// a libp2p swarm.
    pub async fn dispatch(
        &self,
        dialer: PeerId,
        request: EphemeralRequest,
    ) -> EphemeralResponse {
        match self.dispatch_inner(dialer, request).await {
            Ok(value) => EphemeralResponse::from_value(value),
            Err(e) => EphemeralResponse::from_error(e),
        }
    }

    async fn dispatch_inner(
        &self,
        dialer: PeerId,
        request: EphemeralRequest,
    ) -> Result<serde_json::Value, PorchAuthError> {
        match request {
            EphemeralRequest::ListChannels => {
                let channels: Vec<EphemeralChannel> = self.porch.list_channels().await;
                Ok(serde_json::to_value(channels)?)
            }
            EphemeralRequest::GetMessages { channel_id } => {
                let messages: Vec<EphemeralMessage> =
                    self.porch.get_messages(&channel_id).await;
                Ok(serde_json::to_value(messages)?)
            }
            EphemeralRequest::SendMessage { channel_id, body } => {
                // Author stamped by the handler — dialer cannot spoof
                // their own author.
                let author = dialer.to_base58();
                let message = self
                    .porch
                    .send_message(&channel_id, &author, &body)
                    .await?;
                Ok(serde_json::to_value(message)?)
            }
        }
    }
}

impl FederationProtocol for EphemeralPorchHandler {
    const PROTOCOL_ID: &'static str = EPHEMERAL_PORCH_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for EphemeralPorchHandler {
    fn protocol_id(&self) -> &'static str {
        EPHEMERAL_PORCH_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Other("porch-ephemeral")
    }

    async fn handle_inbound(
        &self,
        peer_id: PeerId,
        mut stream: Stream,
    ) -> Result<(), FederationError> {
        // --- Gate ----------------------------------------------------
        let gate_bytes = match Self::read_frame(&mut stream).await {
            Ok(bytes) => bytes,
            Err(PorchAuthError::StreamClosed) => return Ok(()),
            Err(PorchAuthError::Io(e)) => {
                return Err(FederationError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e,
                )));
            }
            Err(e) => {
                // Best-effort: write the error back; ignore write
                // failures because the dialer may have already gone.
                let _ = Self::write_frame(
                    &mut stream,
                    &PorchAuthResult::Err { error: e.clone() },
                )
                .await;
                return Err(FederationError::MalformedEnvelope(e.to_string()));
            }
        };

        let credentials: PorchCredentials = match serde_json::from_slice(&gate_bytes) {
            Ok(c) => c,
            Err(e) => {
                let err = PorchAuthError::MalformedEnvelope(e.to_string());
                let _ =
                    Self::write_frame(&mut stream, &PorchAuthResult::Err { error: err })
                        .await;
                return Err(FederationError::Serde(e));
            }
        };

        if let Err(e) = self.porch.verify(peer_id, &credentials).await {
            let _ =
                Self::write_frame(&mut stream, &PorchAuthResult::Err { error: e.clone() })
                    .await;
            // The dialer asked for access and was rejected — this is
            // not a transport-level fault, just a denied request. Log
            // it via the handler return so the runtime sees the
            // rejection but don't bubble up an Io error.
            log::debug!(
                target: "concord::porch_ephemeral",
                "gate rejected for {}: {}",
                peer_id, e
            );
            return Ok(());
        }
        Self::write_frame(&mut stream, &PorchAuthResult::Ok {})
            .await
            .map_err(|e| {
                FederationError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?;

        // --- Request loop --------------------------------------------
        loop {
            let bytes = match Self::read_frame(&mut stream).await {
                Ok(bytes) => bytes,
                Err(PorchAuthError::StreamClosed) => return Ok(()),
                Err(PorchAuthError::Io(e)) => {
                    return Err(FederationError::Io(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        e,
                    )));
                }
                Err(e) => {
                    return Err(FederationError::MalformedEnvelope(e.to_string()));
                }
            };
            let request: EphemeralRequest = match serde_json::from_slice(&bytes) {
                Ok(r) => r,
                Err(e) => return Err(FederationError::Serde(e)),
            };
            let response = self.dispatch(peer_id, request).await;
            if let Err(e) = Self::write_frame(&mut stream, &response).await {
                return Err(FederationError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch_ephemeral::WELCOME_CHANNEL_ID;
    use libp2p::identity::Keypair;

    fn fresh_peer_id() -> PeerId {
        PeerId::from(Keypair::generate_ed25519().public())
    }

    #[tokio::test]
    async fn dispatch_list_channels_returns_welcome() {
        let host = fresh_peer_id();
        let porch = Arc::new(EphemeralPorch::new(host));
        let handler = EphemeralPorchHandler::new(porch);
        let visitor = fresh_peer_id();
        let response = handler
            .dispatch(visitor, EphemeralRequest::ListChannels)
            .await;
        assert!(response.ok);
        let channels: Vec<EphemeralChannel> =
            serde_json::from_value(response.result.unwrap()).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].id, WELCOME_CHANNEL_ID);
    }

    /// `SendMessage` must stamp the author with the dialer's peer-id —
    /// the dialer cannot supply their own.
    #[tokio::test]
    async fn dispatch_send_message_stamps_dialer_as_author() {
        let porch = Arc::new(EphemeralPorch::new(fresh_peer_id()));
        let handler = EphemeralPorchHandler::new(porch.clone());
        let visitor = fresh_peer_id();
        let response = handler
            .dispatch(
                visitor,
                EphemeralRequest::SendMessage {
                    channel_id: WELCOME_CHANNEL_ID.to_string(),
                    body: "guest hello".to_string(),
                },
            )
            .await;
        assert!(response.ok, "send must succeed");
        let message: EphemeralMessage =
            serde_json::from_value(response.result.unwrap()).unwrap();
        assert_eq!(message.body, "guest hello");
        assert_eq!(
            message.author_peer_id,
            visitor.to_base58(),
            "author must be the validated dialer, not anything the request claimed"
        );
        // And the porch sees it.
        let messages = porch.get_messages(WELCOME_CHANNEL_ID).await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, message.id);
    }

    /// `SendMessage` against an unknown channel surfaces a typed
    /// `Dispatch` error in the response body.
    #[tokio::test]
    async fn dispatch_send_to_unknown_channel_returns_typed_error() {
        let porch = Arc::new(EphemeralPorch::new(fresh_peer_id()));
        let handler = EphemeralPorchHandler::new(porch);
        let response = handler
            .dispatch(
                fresh_peer_id(),
                EphemeralRequest::SendMessage {
                    channel_id: "ghost".to_string(),
                    body: "hi".to_string(),
                },
            )
            .await;
        assert!(!response.ok);
        match response.error.unwrap() {
            PorchAuthError::Dispatch(msg) => {
                assert!(msg.contains("channel not found"));
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    /// JSON round-trip for `PorchAuthResult::Ok` — the dialer side
    /// will deserialize this; lock the wire shape.
    #[test]
    fn auth_result_ok_wire_shape() {
        let payload = PorchAuthResult::Ok {};
        let s = serde_json::to_string(&payload).unwrap();
        assert_eq!(s, "{\"ok\":{}}");
        let back: PorchAuthResult = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, PorchAuthResult::Ok {}));
    }

    /// JSON round-trip for `PorchAuthResult::Err` carrying an
    /// `InvalidCredentials` payload.
    #[test]
    fn auth_result_err_wire_shape() {
        let payload = PorchAuthResult::Err {
            error: PorchAuthError::InvalidCredentials("bad token".to_string()),
        };
        let s = serde_json::to_string(&payload).unwrap();
        // Both the outer tag and the inner tag must serialize the way
        // the dialer expects to pattern-match on them.
        assert!(s.contains("\"err\""), "wire shape changed: {s}");
        assert!(s.contains("\"InvalidCredentials\""), "wire shape changed: {s}");
        let back: PorchAuthResult = serde_json::from_str(&s).unwrap();
        match back {
            PorchAuthResult::Err {
                error: PorchAuthError::InvalidCredentials(reason),
            } => {
                assert_eq!(reason, "bad token");
            }
            other => panic!("variant changed under round-trip: {other:?}"),
        }
    }
}
