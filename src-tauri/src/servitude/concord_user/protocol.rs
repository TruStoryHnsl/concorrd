//! F-A — libp2p stream protocol for exchanging ConcordUserDescriptors
//! between two paired peers.
//!
//! Wire framing matches the Matrix-federation handler's pattern
//! (`crate::servitude::federation::matrix`): 4-byte big-endian length prefix
//! followed by a JSON-encoded envelope. The request/response shapes are
//! deliberately small — this protocol is for "give me your view of my
//! profile" exchanges, not bulk data sync.
//!
//! Protocol ID: `/concord/user-profile/1.0.0`. Distinct from the Phase 6
//! `/concord/matrix-federation/1.0.0` namespace so the two cannot collide
//! at dispatch time.
//!
//! Trust gating happens OUTSIDE this protocol: the protocol itself only
//! moves the descriptor bytes; whether a received descriptor's contents
//! merge into local state is decided by the [`crate::servitude::concord_user::trust_store`]
//! at the application layer.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::{PeerId, Stream, StreamProtocol};
use libp2p_stream::Control;
use serde::{Deserialize, Serialize};

use crate::servitude::federation::{
    FederationError, FederationHandler, FederationProtocol, PayloadKind,
};

use super::ConcordUserDescriptor;

/// libp2p stream protocol ID for the Concord user-definition protocol.
/// Stable for the v1.0.0 wire format; bumping requires a new ID
/// (`/concord/user-profile/2.0.0`).
pub const CONCORD_USER_PROTOCOL_ID: &str = "/concord/user-profile/1.0.0";

/// Maximum envelope size per direction. A descriptor with hundreds of
/// per-server rows and trust edges is still well under 256 KiB; the cap
/// is generous so we don't have to bump it for normal use.
const MAX_ENVELOPE_BYTES: usize = 1 * 1024 * 1024;

/// Wire request — the asker either fetches the responder's view of the
/// local hero's descriptor ([`ConcordUserRequest::GetSelf`]) or asks the
/// responder to publish a descriptor for a known concord_uid
/// ([`ConcordUserRequest::GetByUid`]).
///
/// The `request_id` field is JSON-RPC-style — the response echoes it so a
/// caller can correlate multiple in-flight requests on the same stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum ConcordUserRequest {
    /// "Give me YOUR install's view of your hero." The responder returns
    /// its local install's descriptor.
    GetSelf { request_id: u64 },
    /// "Give me your view of the hero whose concord_uid is X."
    /// The responder either returns their cached descriptor for that
    /// hero, or a `NotFound` error.
    GetByUid {
        request_id: u64,
        concord_uid_hex: String,
    },
}

impl ConcordUserRequest {
    pub fn request_id(&self) -> u64 {
        match self {
            ConcordUserRequest::GetSelf { request_id } => *request_id,
            ConcordUserRequest::GetByUid { request_id, .. } => *request_id,
        }
    }
}

/// Wire response — exactly one of `descriptor` or `error` is set on a
/// well-formed response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConcordUserResponse {
    pub request_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ConcordUserDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ConcordUserErrorBody>,
}

/// Structured error body returned alongside a [`ConcordUserResponse`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConcordUserErrorBody {
    pub code: i32,
    pub message: String,
}

/// Trait the dispatcher calls into when handling an inbound request. Lets
/// production wire the real Stronghold-backed descriptor source while
/// tests substitute a stub.
#[async_trait]
pub trait ConcordUserApi: Send + Sync {
    /// Return THIS install's local descriptor — used for `GetSelf`.
    async fn get_self(&self) -> Result<ConcordUserDescriptor, ConcordUserErrorBody>;

    /// Look up a cached descriptor for an arbitrary `concord_uid`. The
    /// default implementation returns `NotFound`; installs that cache
    /// other heroes' descriptors override this.
    async fn get_by_uid(
        &self,
        concord_uid_hex: &str,
    ) -> Result<ConcordUserDescriptor, ConcordUserErrorBody> {
        let _ = concord_uid_hex;
        Err(ConcordUserErrorBody {
            code: 404,
            message: "not_found".to_string(),
        })
    }
}

/// Concrete handler. Holds an `Arc<dyn ConcordUserApi>` so the swarm
/// runtime can register it alongside the other federation handlers and
/// the test-suite can swap in a stub.
pub struct ConcordUserHandler {
    api: Arc<dyn ConcordUserApi>,
}

impl ConcordUserHandler {
    pub fn new(api: Arc<dyn ConcordUserApi>) -> Self {
        Self { api }
    }
}

impl FederationProtocol for ConcordUserHandler {
    const PROTOCOL_ID: &'static str = CONCORD_USER_PROTOCOL_ID;
}

#[async_trait]
impl FederationHandler for ConcordUserHandler {
    fn protocol_id(&self) -> &'static str {
        CONCORD_USER_PROTOCOL_ID
    }

    fn payload_kind(&self) -> PayloadKind {
        // Reuses the federation handler trait but is a distinct payload;
        // pick the `Other` variant with a stable diagnostic label.
        PayloadKind::Other("concord-user")
    }

    async fn handle_inbound(
        &self,
        _peer_id: PeerId,
        mut stream: Stream,
    ) -> Result<(), FederationError> {
        loop {
            let mut len_buf = [0u8; 4];
            match stream.read_exact(&mut len_buf).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(());
                }
                Err(e) => return Err(FederationError::Io(e)),
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len > MAX_ENVELOPE_BYTES {
                return Err(FederationError::MalformedEnvelope(format!(
                    "request envelope too large: {} > {}",
                    len, MAX_ENVELOPE_BYTES
                )));
            }
            let mut buf = vec![0u8; len];
            stream
                .read_exact(&mut buf)
                .await
                .map_err(FederationError::Io)?;

            let request: ConcordUserRequest = serde_json::from_slice(&buf)
                .map_err(FederationError::Serde)?;
            let request_id = request.request_id();

            let response = match request {
                ConcordUserRequest::GetSelf { .. } => match self.api.get_self().await {
                    Ok(descriptor) => ConcordUserResponse {
                        request_id,
                        descriptor: Some(descriptor),
                        error: None,
                    },
                    Err(err) => ConcordUserResponse {
                        request_id,
                        descriptor: None,
                        error: Some(err),
                    },
                },
                ConcordUserRequest::GetByUid {
                    concord_uid_hex, ..
                } => match self.api.get_by_uid(&concord_uid_hex).await {
                    Ok(descriptor) => ConcordUserResponse {
                        request_id,
                        descriptor: Some(descriptor),
                        error: None,
                    },
                    Err(err) => ConcordUserResponse {
                        request_id,
                        descriptor: None,
                        error: Some(err),
                    },
                },
            };

            let bytes = serde_json::to_vec(&response).map_err(FederationError::Serde)?;
            let len_be = (bytes.len() as u32).to_be_bytes();
            stream
                .write_all(&len_be)
                .await
                .map_err(FederationError::Io)?;
            stream
                .write_all(&bytes)
                .await
                .map_err(FederationError::Io)?;
            stream.flush().await.map_err(FederationError::Io)?;
        }
    }
}

/// Outbound helper: open a `/concord/user-profile/1.0.0` stream, send one
/// request, read one response, close.
///
/// Mirrors the `matrix_request` pattern from
/// `crate::servitude::federation::matrix`. The caller already has a
/// `libp2p_stream::Control` (cloned from `LibP2pTransport::stream_control`)
/// and the target peer's `PeerId`.
pub async fn open_descriptor_stream(
    control: &mut Control,
    peer_id: PeerId,
    request: ConcordUserRequest,
) -> Result<ConcordUserResponse, FederationError> {
    let proto = StreamProtocol::new(CONCORD_USER_PROTOCOL_ID);
    let mut stream = control
        .open_stream(peer_id, proto)
        .await
        .map_err(|e| FederationError::Upstream(format!("open_stream: {e:?}")))?;

    let bytes = serde_json::to_vec(&request).map_err(FederationError::Serde)?;
    let len_be = (bytes.len() as u32).to_be_bytes();
    stream
        .write_all(&len_be)
        .await
        .map_err(FederationError::Io)?;
    stream
        .write_all(&bytes)
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
            "response envelope too large: {} > {}",
            len, MAX_ENVELOPE_BYTES
        )));
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(FederationError::Io)?;
    let _ = stream.close().await;
    serde_json::from_slice(&buf).map_err(FederationError::Serde)
}

// ---------------------------------------------------------------------------
// Static descriptor source — wraps a precomputed descriptor.
// ---------------------------------------------------------------------------

/// A trivial [`ConcordUserApi`] implementation that just returns a
/// pre-built descriptor for every `GetSelf`. Useful for tests and for the
/// Tauri command surface to construct an on-the-fly responder backed by
/// the install's cached state.
pub struct StaticDescriptorApi {
    descriptor: ConcordUserDescriptor,
}

impl StaticDescriptorApi {
    pub fn new(descriptor: ConcordUserDescriptor) -> Self {
        Self { descriptor }
    }
}

#[async_trait]
impl ConcordUserApi for StaticDescriptorApi {
    async fn get_self(&self) -> Result<ConcordUserDescriptor, ConcordUserErrorBody> {
        Ok(self.descriptor.clone())
    }
}

// ---------------------------------------------------------------------------
// Stronghold-backed descriptor source — the PRODUCTION responder.
// ---------------------------------------------------------------------------

/// The production [`ConcordUserApi`]: builds THIS install's descriptor
/// on demand from the persisted Stronghold seed + trust log via
/// [`super::build_local_descriptor`]. Registered by the transport's
/// `start()` so an inbound `GetSelf` on `/concord/user-profile/1.0.0`
/// returns the real local hero descriptor — without which F-C's
/// `HeroBinding::lookup_peer_hero` against this peer would always get an
/// empty answer (closed gate).
///
/// The descriptor is rebuilt per request rather than cached so a freshly
/// added trust edge or a renamed install is reflected on the next peer
/// fetch with no swarm restart.
pub struct StrongholdDescriptorApi {
    stronghold: Arc<crate::servitude::identity::StrongholdHandle>,
    /// Operator vanity name (the transport's `instance_name`). `None`
    /// collapses to the `hero-<uid8>` placeholder inside the builder.
    display_name: Option<String>,
}

impl StrongholdDescriptorApi {
    pub fn new(
        stronghold: Arc<crate::servitude::identity::StrongholdHandle>,
        display_name: Option<String>,
    ) -> Self {
        Self {
            stronghold,
            display_name,
        }
    }
}

#[async_trait]
impl ConcordUserApi for StrongholdDescriptorApi {
    async fn get_self(&self) -> Result<ConcordUserDescriptor, ConcordUserErrorBody> {
        super::build_local_descriptor(&self.stronghold, self.display_name.as_deref())
            .await
            .map_err(|e| ConcordUserErrorBody {
                code: 500,
                message: format!("local descriptor build failed: {e}"),
            })
    }
}
