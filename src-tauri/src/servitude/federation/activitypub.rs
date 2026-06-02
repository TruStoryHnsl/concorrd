//! Phase 6 (INS-019b) follow-up — ActivityPub federation handler over a
//! libp2p stream protocol.
//!
//! Same shape as [`crate::servitude::federation::matrix`]: 4-byte big-endian
//! length prefix + JSON body envelope, 16 MiB cap. The trait abstraction
//! Phase 6 introduced is the whole point — adding ActivityPub is a new
//! handler module, NOT a transport change.
//!
//! ```json
//! { "activity_type": "Follow", "actor": "https://...", "object": {...}, "request_id": 42 }
//! { "request_id": 42, "accepted": true }
//! { "request_id": 42, "error": { "code": 501, "message": "not_implemented" } }
//! ```
//!
//! Real interop with Mastodon / Mozilla.social (the priority-2 target
//! called out in the design doc) is a follow-up. This module ships a
//! stub responder that proves the seam is plumbed end-to-end: a
//! `"Ping"` activity round-trips as `accepted: true`, every other
//! activity returns a 501 stub. That mirrors the Matrix Phase 6 shape
//! exactly — `federation.heartbeat` round-trips, everything else 501s.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt, StreamExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use super::{FederationError, FederationHandler, FederationProtocol, PayloadKind};

/// libp2p stream protocol ID for ActivityPub federation traffic. Distinct
/// namespace from the Matrix federation stream (`/concord/matrix-federation/1.0.0`)
/// and the Phase 8 voice-signaling stream (`/concord/voice-signaling/1.0.0`)
/// so the dispatcher routes by ID, never by payload sniffing.
pub const ACTIVITYPUB_PROTOCOL_ID: &str = "/concord/activitypub/1.0.0";

/// Maximum size of a single framed envelope (request OR response). 16 MiB,
/// matching the Matrix handler. Anything larger is treated as malformed —
/// the framing has almost certainly desynchronized.
const MAX_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;

/// ActivityPub-style request shape carried over the federation stream.
///
/// The wire envelope is intentionally JSON-RPC-ish rather than raw
/// ActivityStreams — the wrapping ID + activity-type discriminator lets
/// the handler dispatch without parsing the full `object` blob, and the
/// `request_id` field lets the caller correlate multiple in-flight
/// requests on the same stream.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityPubRequest {
    /// ActivityStreams `type` value (e.g. `"Follow"`, `"Like"`,
    /// `"Create"`, `"Announce"`, …). The Phase 6 follow-up stub only
    /// special-cases `"Ping"`; everything else 501s.
    pub activity_type: String,
    /// ActivityPub actor URI — the entity originating the activity
    /// (e.g. `"https://mastodon.example/@alice"`).
    pub actor: String,
    /// Free-form ActivityStreams `object` payload. Semantics depend on
    /// `activity_type`; the handler does NOT parse this in Phase 6 —
    /// it's passed through to the [`ActivityPubApi`] dispatcher.
    pub object: serde_json::Value,
    /// Caller-chosen identifier; the response echoes it so the caller
    /// can correlate multiple in-flight requests on the same stream.
    pub request_id: u64,
}

/// ActivityPub-style response shape carried over the federation stream.
/// Exactly one of `accepted` and `error` is present in a well-formed
/// response; both being `None` indicates a buggy handler.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityPubResponse {
    pub request_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ActivityPubErrorBody>,
}

/// Structured error body returned alongside an [`ActivityPubResponse`]
/// when the handler cannot produce a successful result.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityPubErrorBody {
    pub code: i32,
    pub message: String,
}

/// Abstraction over an ActivityPub backend (a Mastodon-compatible
/// inbox/outbox surface, a Mozilla.social peer, etc.). Production wires
/// [`StubActivityPubClient`] in Phase 6 follow-up; real interop is a
/// later sprint. Tests inject mocks so the handler logic can be
/// exercised without a real backend.
#[async_trait]
pub trait ActivityPubApi: Send + Sync {
    /// Dispatch one decoded request envelope to the underlying
    /// ActivityPub surface. Implementations must NEVER panic — any
    /// failure is reported via the `error` field on the returned
    /// [`ActivityPubResponse`].
    async fn dispatch(&self, request: ActivityPubRequest) -> ActivityPubResponse;
}

/// Production stub. Like Matrix's [`super::ConduwuitClient`], ships as
/// 501-for-everything except a documented heartbeat method
/// (`"Ping"`) so the seam is plumbed end-to-end. Real interop with
/// Mastodon / Mozilla.social is a follow-up — Phase 6's framing
/// applies; the surface here is intentionally light so the trait
/// abstraction can land independently.
pub struct StubActivityPubClient;

#[async_trait]
impl ActivityPubApi for StubActivityPubClient {
    async fn dispatch(&self, request: ActivityPubRequest) -> ActivityPubResponse {
        // Documented heartbeat activity — used by the integration tests
        // to prove the wire works without a real ActivityPub backend.
        // Returns `accepted: true`.
        if request.activity_type == "Ping" {
            return ActivityPubResponse {
                request_id: request.request_id,
                accepted: Some(true),
                error: None,
            };
        }
        // Every other activity is intentionally a 501 stub in the
        // Phase 6 follow-up. Wiring real ActivityPub inbox dispatch
        // (POST to `actor.inbox` with HTTP signatures, etc.) is a
        // later sprint.
        ActivityPubResponse {
            request_id: request.request_id,
            accepted: None,
            error: Some(ActivityPubErrorBody {
                code: 501,
                message: "not_implemented".into(),
            }),
        }
    }
}

/// Concrete ActivityPub federation handler. Holds an
/// `Arc<dyn ActivityPubApi>` so production and test wiring can substitute
/// different backends without changing the handler.
pub struct ActivityPubHandler {
    api: Arc<dyn ActivityPubApi>,
}

impl ActivityPubHandler {
    pub fn new(api: Arc<dyn ActivityPubApi>) -> Self {
        Self { api }
    }
}

impl FederationProtocol for ActivityPubHandler {
    const PROTOCOL_ID: &'static str = ACTIVITYPUB_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for ActivityPubHandler {
    fn protocol_id(&self) -> &'static str {
        ACTIVITYPUB_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        PayloadKind::ActivityPub
    }

    async fn handle_inbound(
        &self,
        _peer_id: PeerId,
        mut stream: Stream,
    ) -> Result<(), FederationError> {
        // Mirror MatrixFederationHandler::handle_inbound exactly — same
        // framing, same cap, same loop. The only delta is the typed
        // request/response shapes and which trait the API is.
        //
        // ActivityPub envelopes carry their own auth (HTTP signatures
        // on the request body) in the real world, so the handler doesn't
        // need `peer_id` for dispatch. The parameter is wired through
        // for trait uniformity (Phase 8 voice signaling needs it).
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
            let request: ActivityPubRequest =
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

/// Outbound helper: open an ActivityPub federation stream to `peer_id`
/// via the caller's `libp2p_stream::Control`, send a single request
/// envelope, receive one response envelope, close.
///
/// Used by callers that already know the concrete handler type
/// (i.e. they're not going through the dyn dispatcher). The Phase 6
/// follow-up doesn't yet have a production caller for this — the
/// integration tests exercise it to prove the wire works end-to-end.
pub async fn activitypub_request(
    control: &mut Control,
    peer_id: PeerId,
    request: ActivityPubRequest,
) -> Result<ActivityPubResponse, FederationError> {
    let proto = StreamProtocol::new(ACTIVITYPUB_PROTOCOL_ID);
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
// mirrors the same dead_code shim in matrix.rs so the import stays
// stable even when no test code path triggers its inferred use.
#[allow(dead_code)]
fn _force_use_stream_ext() {
    fn _t<S: StreamExt + Unpin>(_s: &mut S) {}
}
