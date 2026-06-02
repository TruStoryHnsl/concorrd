//! Phase 6 (INS-019b) — Matrix federation handler over a libp2p stream
//! protocol.
//!
//! Wire framing: 4-byte big-endian length prefix + JSON body. Request and
//! response envelopes are JSON-RPC-like:
//!
//! ```json
//! { "method": "federation.send", "params": {...}, "request_id": 42 }
//! { "request_id": 42, "result": {...} }
//! { "request_id": 42, "error": { "code": 501, "message": "not_implemented" } }
//! ```
//!
//! The actual conduwuit dispatch wiring (translating `method` to a Matrix
//! federation HTTP route) is intentionally light in this phase — the trait
//! seam is what Phase 6 is about. A documented heartbeat method
//! (`"federation.heartbeat"`) is implemented end-to-end so the
//! integration tests can prove the handler wiring works without a real
//! homeserver in the loop.
//!
//! ## Matrix federation × ConcordUserDescriptor — the bridge is OPAQUE
//!
//! F-A (the Concord-native user-definition protocol, see
//! `crate::servitude::concord_user`) defines a transport-agnostic record
//! for "a Concord user." The Matrix bridge does NOT expose that record to
//! Matrix homeservers. From a Matrix homeserver's perspective, the bridge
//! is a normal Matrix user (an MXID, a Matrix displayname, a Matrix avatar
//! URL). Only the ONE `ServerProfile` row whose `server_id` matches the
//! homeserver this handler is talking to crosses the bridge — and it's
//! translated into the Matrix profile shape, not handed over wholesale.
//!
//! Concretely, if a hero has 5 per-server rows in their
//! `ConcordUserDescriptor` (rows for 2 Matrix homeservers and 3 Concord
//! porches), a Matrix homeserver federating in only ever sees the row
//! corresponding to its own ServerId. The other 4 rows do not cross the
//! bridge. This keeps the per-server identity isolation default that
//! `ConcordUserDescriptor::merge_view` enforces on the local side.
//!
//! The bridge does not federate the ConcordUid as a Matrix-side
//! property either: a remote Matrix homeserver has no way to discover
//! the hero's cross-transport identifier from the bridge alone. That
//! discovery happens via the `/concord/user-profile/1.0.0` protocol
//! between two trusted Concord installs, NOT over Matrix.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt, StreamExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use super::{FederationError, FederationHandler, FederationProtocol, PayloadKind};

/// libp2p stream protocol ID for Matrix federation traffic. Distinct
/// namespace from `/concord/req-resp/...` so the request-response codec
/// and the Phase 6 stream layer cannot collide.
pub const MATRIX_PROTOCOL_ID: &str = "/concord/matrix-federation/1.0.0";

/// Maximum size of a single framed envelope (request OR response). 16 MiB.
/// Anything larger is treated as a malformed envelope — the framing has
/// almost certainly desynchronized.
const MAX_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;

/// JSON-RPC-style request shape carried over the Matrix federation stream.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MatrixRequest {
    /// Matrix-federation operation. Examples: `"federation.send"`,
    /// `"federation.invite"`, `"federation.heartbeat"`. The exact set
    /// of supported methods is wired into [`ConduwuitClient::dispatch`].
    pub method: String,
    /// Free-form params blob. The semantics are method-specific.
    pub params: serde_json::Value,
    /// Caller-chosen identifier; the response echoes it so the caller can
    /// correlate multiple in-flight requests on the same stream.
    pub request_id: u64,
}

/// JSON-RPC-style response shape carried over the Matrix federation
/// stream. Exactly one of `result` and `error` is present in well-formed
/// responses; both being `None` indicates a buggy handler.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MatrixResponse {
    pub request_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<MatrixErrorBody>,
}

/// Structured error body returned alongside a `MatrixResponse` when the
/// handler cannot produce a successful result.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MatrixErrorBody {
    pub code: i32,
    pub message: String,
}

/// Abstraction over a conduwuit homeserver client. Production wires
/// [`ConduwuitClient`] (HTTP to localhost:6167). Tests inject a mock so
/// the handler logic can be exercised without a real homeserver.
#[async_trait]
pub trait MatrixFederationApi: Send + Sync {
    /// Dispatch one decoded request envelope to the underlying Matrix
    /// federation surface. Implementations must NEVER panic — any
    /// failure is reported via the `error` field on the returned
    /// `MatrixResponse`.
    async fn dispatch(&self, request: MatrixRequest) -> MatrixResponse;
}

/// Production conduwuit client. Phase 6 ships a deliberately light
/// dispatcher — only the heartbeat method round-trips end-to-end;
/// everything else returns a 501 stub. Wiring real conduwuit federation
/// routes (`/_matrix/federation/v1/send`, `/invite`, `/query`, etc.) is
/// a follow-up.
pub struct ConduwuitClient {
    base_url: String,
}

impl ConduwuitClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
        }
    }

    /// Read-only accessor for the configured base URL — exposed for
    /// logging / diagnostics so a future follow-up can extend
    /// dispatch() to actually POST to `{base_url}/_matrix/...`.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

#[async_trait]
impl MatrixFederationApi for ConduwuitClient {
    async fn dispatch(&self, request: MatrixRequest) -> MatrixResponse {
        // Documented heartbeat method — used by the integration tests to
        // prove the wire works without a real homeserver. Returns a
        // simple `{ alive: true }` payload.
        if request.method == "federation.heartbeat" {
            return MatrixResponse {
                request_id: request.request_id,
                result: Some(serde_json::json!({ "alive": true })),
                error: None,
            };
        }
        // Every other method is intentionally a 501 stub in Phase 6.
        // Wiring real conduwuit dispatch (HTTP POST to
        // `{base_url}/_matrix/federation/v1/...`) is a follow-up.
        MatrixResponse {
            request_id: request.request_id,
            result: None,
            error: Some(MatrixErrorBody {
                code: 501,
                message: "not_implemented".into(),
            }),
        }
    }
}

/// Concrete Matrix federation handler. Holds an `Arc<dyn
/// MatrixFederationApi>` so production and test wiring can substitute
/// different backends without changing the handler.
pub struct MatrixFederationHandler {
    api: Arc<dyn MatrixFederationApi>,
}

impl MatrixFederationHandler {
    pub fn new(api: Arc<dyn MatrixFederationApi>) -> Self {
        Self { api }
    }
}

impl FederationProtocol for MatrixFederationHandler {
    const PROTOCOL_ID: &'static str = MATRIX_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for MatrixFederationHandler {
    fn protocol_id(&self) -> &'static str {
        MATRIX_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::Matrix
    }

    async fn handle_inbound(
        &self,
        _peer_id: PeerId,
        mut stream: Stream,
    ) -> Result<(), FederationError> {
        // Loop reading framed envelopes until the peer cleanly closes the
        // stream (EOF on the length-prefix read). Each envelope is
        // dispatched to the underlying API and a framed response is
        // written back on the same stream.
        //
        // Matrix federation envelopes carry their own auth (X-Matrix
        // signature), so the handler doesn't need `peer_id` for
        // dispatch. The parameter is wired through for trait uniformity
        // (Phase 8 voice signaling needs it).
        loop {
            let mut len_buf = [0u8; 4];
            match stream.read_exact(&mut len_buf).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    // Clean EOF — the peer is done. Normal exit path.
                    return Ok(());
                }
                Err(e) => return Err(FederationError::Io(e)),
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len > MAX_ENVELOPE_BYTES {
                return Err(FederationError::MalformedEnvelope(format!(
                    "envelope too large: {} > {}",
                    len, MAX_ENVELOPE_BYTES
                )));
            }
            let mut buf = vec![0u8; len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;
            let request: MatrixRequest =
                serde_json::from_slice(&buf).map_err(FederationError::Serde)?;
            let response = self.api.dispatch(request).await;
            let response_bytes =
                serde_json::to_vec(&response).map_err(FederationError::Serde)?;
            let response_len = (response_bytes.len() as u32).to_be_bytes();
            stream
                .write_all(&response_len)
                .await
                .map_err(FederationError::Io)?;
            stream
                .write_all(&response_bytes)
                .await
                .map_err(FederationError::Io)?;
            stream.flush().await.map_err(FederationError::Io)?;
        }
    }
}

/// Outbound helper: open a Matrix federation stream to `peer_id` via the
/// caller's `libp2p_stream::Control`, send a single request envelope,
/// receive one response envelope, close.
///
/// Used by callers that already know the concrete handler type
/// (i.e. they're not going through the dyn dispatcher). Phase 6 doesn't
/// yet have a production caller for this — the integration tests exercise
/// it to prove the wire works end-to-end.
pub async fn matrix_request(
    control: &mut Control,
    peer_id: PeerId,
    request: MatrixRequest,
) -> Result<MatrixResponse, FederationError> {
    let proto = StreamProtocol::new(MATRIX_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| FederationError::Upstream(format!("open_stream: {e:?}")))?;
    let request_bytes = serde_json::to_vec(&request).map_err(FederationError::Serde)?;
    let len_be = (request_bytes.len() as u32).to_be_bytes();
    stream
        .write_all(&len_be)
        .await
        .map_err(FederationError::Io)?;
    stream
        .write_all(&request_bytes)
        .await
        .map_err(FederationError::Io)?;
    stream.flush().await.map_err(FederationError::Io)?;

    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(FederationError::Io)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_ENVELOPE_BYTES {
        return Err(FederationError::MalformedEnvelope(format!(
            "response too large: {} > {}",
            len, MAX_ENVELOPE_BYTES
        )));
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(FederationError::Io)?;
    // Best-effort close — the peer may have already closed, in which
    // case `close` returns an error we don't propagate. The response
    // has already been read in full.
    let _ = stream.close().await;
    serde_json::from_slice(&buf).map_err(FederationError::Serde)
}

// Force the StreamExt import to count as used in production builds —
// IncomingStreams is `futures::Stream` and the dispatcher in p2p.rs uses
// `.next()` from this trait via the libp2p-stream `Control::accept`
// receiver. Keeping the use site here keeps the public matrix.rs surface
// free of test-only imports.
#[allow(dead_code)]
fn _force_use_stream_ext() {
    fn _t<S: StreamExt + Unpin>(_s: &mut S) {}
}
