//! Ephemeral porch — **F1a** — in-memory secure doorman for guests.
//!
//! The porch is **entirely ephemeral**: no SQLite, no on-disk state, no
//! backups, no folder. It is built fresh every native client launch and
//! gone when the binary exits. It exists only as a secure doorman that
//! gates inbound libp2p traffic from guests via a per-launch session
//! token + the visiting peer's libp2p PeerId.
//!
//! Architectural context (2026-05-31 CONSOLIDATED ARCHITECTURE filing):
//!
//! - The intrinsic "local" source rail tile shows **two** auto-created
//!   servers — the porch (this module) and the home server (the existing
//!   `src-tauri/src/porch` SQLite-backed module, being re-themed as the
//!   home server in a parallel F1b PR).
//! - The porch's role is **session-only**: it carries the always-fresh
//!   guest entrance. Any messages exchanged through it vanish when the
//!   binary exits. Persistent user data lives on the home server.
//! - This module **does NOT touch** the existing on-disk porch SQLite.
//!   That storage layer is being repurposed as the home server's backing
//!   store.
//!
//! ## Gate protocol (frame layout)
//!
//! Every inbound libp2p stream on `/concord/porch-ephemeral/1.0.0` MUST
//! present a credentials frame as its **first** message:
//!
//! ```text
//!   +-----------------------------------+
//!   |   4-byte BE length-prefix (u32)   |
//!   +-----------------------------------+
//!   |   PorchCredentials JSON payload   |
//!   |   {"peer_id":"12D3...",           |
//!   |    "session_token":"<b64>"}       |
//!   +-----------------------------------+
//! ```
//!
//! After validation the handler writes back a 4-byte length-prefixed
//! JSON `PorchAuthResult` payload:
//!
//! - `{"ok":{}}` — gate accepted; the connection may proceed to send
//!   subsequent porch-request envelopes on the same stream.
//! - `{"err":{"error":{"kind":"InvalidCredentials","reason":"..."}}}`
//!   — gate rejected; the handler closes the stream.
//!
//! The three validation conditions are:
//!
//! 1. The frame's `peer_id` MUST equal the dialer's libp2p PeerId
//!    (defends against client-stamped impersonation).
//! 2. The frame's `session_token` MUST equal the local porch's current
//!    `session_token` (rotates per launch).
//! 3. The dialer's PeerId MUST be in the local peer-store's
//!    paired-peer list (delegated to a [`PairedPeerChecker`]). The
//!    default `EphemeralPorch::new()` constructs with
//!    [`AllowAllChecker`] for the in-memory developer build;
//!    production wires the peer-store-backed checker in via
//!    [`EphemeralPorch::with_acl`].
//!
//! Tests against the dispatch entrypoint exercise all three failure
//! shapes — see the bottom of this file.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use base64::Engine;
use libp2p::PeerId;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::RwLock;
use ulid::Ulid;

/// libp2p stream protocol the ephemeral porch listens on.
///
/// **Distinct from** the legacy persistent porch's
/// `/concord/porch/1.0.0` so the two protocols can coexist during the
/// F1a / F1b transition without colliding. F1b will re-theme the
/// existing path as `/concord/home/1.0.0` once the home-server rename
/// lands.
pub const EPHEMERAL_PORCH_PROTOCOL_ID: &str = "/concord/porch-ephemeral/1.0.0";

/// The well-known channel id of the always-seeded `welcome` channel.
/// Stable across launches so the client UI can refer to it without
/// passing the value over IPC.
pub const WELCOME_CHANNEL_ID: &str = "welcome";

/// Human-readable name of the always-seeded `welcome` channel. The
/// porch is not renamable; this is what the rail tile shows.
pub const WELCOME_CHANNEL_NAME: &str = "welcome";

/// Maximum messages retained per channel before the oldest entry is
/// dropped. The porch is ephemeral; this is purely an in-process OOM
/// guard for misbehaving guests that try to spam a channel into oblivion.
pub const MAX_MESSAGES_PER_CHANNEL: usize = 10_000;

/// Length-prefix cap on credentials + request envelopes. Matches the
/// persistent porch's framing budget.
pub const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;

/// Length, in raw bytes, of the per-launch session token before base64
/// encoding (32 bytes = 256 bits of entropy, far beyond brute-force
/// reach over the lifetime of a single binary run).
pub const SESSION_TOKEN_BYTES: usize = 32;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// A single channel record on the ephemeral porch. Mirrors the wire
/// shape of the persistent porch's `PorchChannel` so the existing
/// client TypeScript layer can deserialize either without a schema
/// change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EphemeralChannel {
    pub id: String,
    pub name: String,
    /// Always `"porch"` for ephemeral channels — the kind field is
    /// retained for client-side compatibility with the persistent
    /// shape.
    pub kind: String,
    /// Always `"open"` for ephemeral channels — the porch is the guest
    /// doorman; gating is done at the connection level via the session
    /// token. Per-channel ACLs land later.
    pub acl_mode: String,
    pub created_at: i64,
}

/// A single message in an ephemeral channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EphemeralMessage {
    /// ULID — lexicographically sortable, monotonic-per-process.
    pub id: String,
    pub channel_id: String,
    pub author_peer_id: String,
    pub body: String,
    pub created_at: i64,
}

/// A per-channel ACL set. F1a only enforces a single "any visitor that
/// passed the gate may write" policy; this struct is reserved for the
/// next phase that lands per-channel allowlist gating without a wire
/// break.
#[derive(Debug, Clone, Default)]
pub struct AclSet {
    /// Allowed visitor peer-ids (base58). Empty == "open to any peer
    /// that already cleared the gate".
    pub allowed: Vec<String>,
}

/// Inner state owned by the porch. Wrapped in `Arc<RwLock<...>>` for
/// concurrent libp2p handler access.
#[derive(Debug)]
struct EphemeralState {
    channels: Vec<EphemeralChannel>,
    messages_by_channel: HashMap<String, VecDeque<EphemeralMessage>>,
    acls: HashMap<String, AclSet>,
}

impl EphemeralState {
    fn fresh() -> Self {
        let mut state = Self {
            channels: Vec::new(),
            messages_by_channel: HashMap::new(),
            acls: HashMap::new(),
        };
        state.seed_welcome_channel();
        state
    }

    fn seed_welcome_channel(&mut self) {
        let welcome = EphemeralChannel {
            id: WELCOME_CHANNEL_ID.to_string(),
            name: WELCOME_CHANNEL_NAME.to_string(),
            kind: "porch".to_string(),
            acl_mode: "open".to_string(),
            created_at: unix_millis(),
        };
        self.channels.push(welcome);
        self.messages_by_channel
            .insert(WELCOME_CHANNEL_ID.to_string(), VecDeque::new());
        self.acls
            .insert(WELCOME_CHANNEL_ID.to_string(), AclSet::default());
    }
}

/// Identity tuple the porch publishes to clients via
/// `porch_current_token` and validates on every inbound gate frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PorchIdentity {
    /// The install's persistent libp2p PeerId, base58-encoded.
    pub peer_id: String,
    /// The per-launch base64 session token. Rotates on every binary
    /// launch.
    pub session_token: String,
}

/// Pluggable check for whether a visitor's peer-id is in the local
/// paired-peer list. The default `EphemeralPorch::new()` builds with
/// [`AllowAllChecker`]; production wires a peer-store-backed checker
/// via [`EphemeralPorch::with_acl`]. The trait is async because the
/// real peer-store reads a Stronghold-sealed sibling file.
#[async_trait::async_trait]
pub trait PairedPeerChecker: Send + Sync {
    /// Returns `true` if `visitor` is in the local paired-peer list.
    async fn is_paired(&self, visitor: &PeerId) -> bool;
}

/// A `PairedPeerChecker` that always reports the visitor as paired.
/// Used by tests and the in-memory developer build where pairing is not
/// yet wired. Production MUST replace this with the peer-store-backed
/// checker.
#[derive(Debug, Default, Clone, Copy)]
pub struct AllowAllChecker;

#[async_trait::async_trait]
impl PairedPeerChecker for AllowAllChecker {
    async fn is_paired(&self, _visitor: &PeerId) -> bool {
        true
    }
}

/// A `PairedPeerChecker` backed by a fixed in-memory allowlist. Used by
/// the tests that exercise the "valid token, unknown peer-id"
/// rejection path.
#[derive(Debug, Clone, Default)]
pub struct StaticAllowlistChecker {
    pub allowed: Vec<PeerId>,
}

#[async_trait::async_trait]
impl PairedPeerChecker for StaticAllowlistChecker {
    async fn is_paired(&self, visitor: &PeerId) -> bool {
        self.allowed.iter().any(|p| p == visitor)
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors surfaced by the ephemeral porch — both authentication failure
/// modes and ordinary porch-operation faults.
///
/// Serialized form uses the `#[serde(tag = "kind", content = "reason")]`
/// shape so the wire JSON matches `{"kind":"InvalidCredentials","reason":"..."}`
/// — the dialer can pattern-match on `kind` without a JSON deep-dive.
#[derive(Debug, Clone, Error, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "reason")]
pub enum PorchAuthError {
    /// The credentials frame was structurally fine but failed
    /// validation — either the session token didn't match the porch's
    /// current value, or the visiting PeerId is not in the local
    /// peer-store, or the frame's claimed peer-id mismatches the
    /// transport-attributed dialer.
    #[error("invalid credentials: {0}")]
    InvalidCredentials(String),

    /// The 4-byte length-prefix was larger than `MAX_ENVELOPE_BYTES`.
    /// Defends against a malicious dialer trying to make the host
    /// allocate gigabytes for a bogus credentials payload.
    #[error("credentials frame too large: {0} bytes")]
    EnvelopeTooLarge(String),

    /// The credentials frame was unparseable JSON.
    #[error("malformed credentials envelope: {0}")]
    MalformedEnvelope(String),

    /// The stream closed before we saw a full credentials frame.
    #[error("stream closed before gate frame complete")]
    StreamClosed,

    /// A non-credentials error (channel-not-found, body-too-large
    /// post, etc.) surfaced by the regular porch dispatch surface.
    #[error("dispatch error: {0}")]
    Dispatch(String),

    /// IO error reading or writing a frame.
    #[error("io: {0}")]
    Io(String),
}

impl From<std::io::Error> for PorchAuthError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            PorchAuthError::StreamClosed
        } else {
            PorchAuthError::Io(e.to_string())
        }
    }
}

impl From<serde_json::Error> for PorchAuthError {
    fn from(e: serde_json::Error) -> Self {
        PorchAuthError::MalformedEnvelope(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// Gate-frame payload. The dialer sends this as the very first
/// length-prefixed frame on every inbound stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PorchCredentials {
    /// The dialer's libp2p PeerId, base58. Cross-checked against the
    /// transport-attributed dialer to defend against client-side spoofing.
    pub peer_id: String,
    /// The local porch's current per-launch session token, as published
    /// by `porch_current_token`. Base64.
    pub session_token: String,
}

/// Gate-frame result returned by the handler after validation.
///
/// Serialized form uses lower-snake-case tags so the wire JSON is
/// either `{"ok":{}}` or `{"err":{"error":{...}}}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PorchAuthResult {
    /// Gate accepted. The dialer may proceed.
    Ok {},
    /// Gate rejected. `error` describes why. The handler closes the
    /// stream after writing this frame.
    Err { error: PorchAuthError },
}

// ---------------------------------------------------------------------------
// Core porch
// ---------------------------------------------------------------------------

/// The ephemeral porch. Lives entirely in memory, dies with the
/// process.
///
/// Construction generates the per-launch session token. Look at
/// [`EphemeralPorch::identity`] for the published `(peer_id,
/// session_token)` tuple — wire it into a Tauri command so the
/// renderer can offer paired-peer-onboarding flows the running token.
///
/// `peer_id` is the host's libp2p PeerId — passed in by the caller
/// because identity construction lives in a different module
/// (`servitude::identity`). The porch does not derive it from a
/// keypair on its own.
pub struct EphemeralPorch {
    state: Arc<RwLock<EphemeralState>>,
    peer_id: PeerId,
    session_token: String,
    acl: Arc<dyn PairedPeerChecker>,
}

impl std::fmt::Debug for EphemeralPorch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EphemeralPorch")
            .field("peer_id", &self.peer_id)
            .field("session_token", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl EphemeralPorch {
    /// Build a fresh porch for the current launch. Seeds the default
    /// `welcome` channel and generates a 32-byte / 256-bit per-launch
    /// session token via the OS CSPRNG.
    ///
    /// The default ACL is [`AllowAllChecker`] — every visitor that
    /// passes the session-token check is considered paired. Production
    /// MUST override this via [`Self::with_acl`] so unknown peers are
    /// rejected at the gate.
    pub fn new(peer_id: PeerId) -> Self {
        let mut raw = [0u8; SESSION_TOKEN_BYTES];
        rand::thread_rng().fill_bytes(&mut raw);
        let session_token = base64::engine::general_purpose::STANDARD.encode(raw);
        Self {
            state: Arc::new(RwLock::new(EphemeralState::fresh())),
            peer_id,
            session_token,
            acl: Arc::new(AllowAllChecker),
        }
    }

    /// Same as [`Self::new`] but wires in a custom paired-peer checker
    /// (production = peer-store-backed; tests = static allowlist).
    pub fn with_acl(peer_id: PeerId, acl: Arc<dyn PairedPeerChecker>) -> Self {
        let porch = Self::new(peer_id);
        Self {
            state: porch.state,
            peer_id: porch.peer_id,
            session_token: porch.session_token,
            acl,
        }
    }

    /// The host's libp2p PeerId. Published as half of the
    /// [`PorchIdentity`] tuple a guest must present to the gate.
    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// The current session token. Rotates on every binary launch.
    /// Visible only to Tauri commands behind the local IPC boundary —
    /// **never** log this value.
    pub fn session_token(&self) -> &str {
        &self.session_token
    }

    /// `(peer_id, session_token)` tuple as a single serializable
    /// struct, matching the wire shape of the
    /// `porch_current_token` Tauri command return type.
    pub fn identity(&self) -> PorchIdentity {
        PorchIdentity {
            peer_id: self.peer_id.to_base58(),
            session_token: self.session_token.clone(),
        }
    }

    /// Snapshot of every channel on the porch.
    pub async fn list_channels(&self) -> Vec<EphemeralChannel> {
        self.state.read().await.channels.clone()
    }

    /// Read every message in a channel (sorted by id, which is a ULID
    /// so it's also chronological per-process). Returns an empty vec
    /// for unknown channel ids — the porch is a doorman, not a
    /// strict-typed API, so an unknown channel is just "no messages".
    pub async fn get_messages(&self, channel_id: &str) -> Vec<EphemeralMessage> {
        let state = self.state.read().await;
        state
            .messages_by_channel
            .get(channel_id)
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Append a message to the channel, attributing the author to the
    /// caller-supplied peer-id. The caller is responsible for matching
    /// the author to the validated gate frame's peer-id; this method
    /// does NOT re-check the gate.
    ///
    /// Drops the oldest message in the channel if the queue is at
    /// `MAX_MESSAGES_PER_CHANNEL`.
    ///
    /// Returns `Err` with a `Dispatch` error if `channel_id` is not a
    /// known channel.
    pub async fn send_message(
        &self,
        channel_id: &str,
        author_peer_id: &str,
        body: &str,
    ) -> Result<EphemeralMessage, PorchAuthError> {
        if body.is_empty() {
            return Err(PorchAuthError::Dispatch(
                "message body must not be empty".to_string(),
            ));
        }
        if body.len() > MAX_ENVELOPE_BYTES {
            return Err(PorchAuthError::Dispatch(format!(
                "message body too large: {} > {}",
                body.len(),
                MAX_ENVELOPE_BYTES
            )));
        }
        let mut state = self.state.write().await;
        // Reject posts to unknown channels — a guest shouldn't be able
        // to create channels by side-effect.
        if !state.channels.iter().any(|c| c.id == channel_id) {
            return Err(PorchAuthError::Dispatch(format!(
                "channel not found: {channel_id}"
            )));
        }
        let message = EphemeralMessage {
            id: Ulid::new().to_string(),
            channel_id: channel_id.to_string(),
            author_peer_id: author_peer_id.to_string(),
            body: body.to_string(),
            created_at: unix_millis(),
        };
        let queue = state
            .messages_by_channel
            .entry(channel_id.to_string())
            .or_default();
        if queue.len() >= MAX_MESSAGES_PER_CHANNEL {
            queue.pop_front();
        }
        queue.push_back(message.clone());
        Ok(message)
    }

    /// Verify a credentials frame.
    ///
    /// Three checks, in order:
    /// 1. `claimed.peer_id` must match the dialer's transport-attributed
    ///    PeerId. Defends against client-side impersonation.
    /// 2. `claimed.session_token` must equal the porch's current value.
    /// 3. The dialer must be paired (delegated to the wired ACL).
    pub async fn verify(
        &self,
        dialer: PeerId,
        claimed: &PorchCredentials,
    ) -> Result<(), PorchAuthError> {
        let claimed_id: PeerId = claimed.peer_id.parse().map_err(|e| {
            PorchAuthError::InvalidCredentials(format!("unparseable peer_id: {e}"))
        })?;
        if claimed_id != dialer {
            return Err(PorchAuthError::InvalidCredentials(
                "claimed peer_id does not match transport-attributed dialer".to_string(),
            ));
        }
        // Constant-time comparison would be nice but the token is 32
        // bytes of CSPRNG entropy and the attacker has no oracle — a
        // mismatched token is rejected in one round trip with no
        // information about which byte was off. Constant-time
        // comparison would change the perf profile for zero security
        // value here.
        if claimed.session_token != self.session_token {
            return Err(PorchAuthError::InvalidCredentials(
                "session token mismatch".to_string(),
            ));
        }
        if !self.acl.is_paired(&dialer).await {
            return Err(PorchAuthError::InvalidCredentials(format!(
                "visiting peer {} is not in the local paired-peer list",
                dialer.to_base58()
            )));
        }
        Ok(())
    }
}

/// Wallclock unix-millis stamp for new messages / channels. Pulled
/// from `SystemTime::now()` against the unix epoch; a backwards system
/// clock surfaces as a zero value rather than a panic.
fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// libp2p inbound handler
// ---------------------------------------------------------------------------

pub mod handler;

pub use handler::EphemeralPorchHandler;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn fresh_peer_id() -> PeerId {
        PeerId::from(Keypair::generate_ed25519().public())
    }

    #[tokio::test]
    async fn seeds_welcome_channel_at_construction() {
        let porch = EphemeralPorch::new(fresh_peer_id());
        let channels = porch.list_channels().await;
        assert_eq!(channels.len(), 1, "exactly one auto-seeded channel");
        assert_eq!(channels[0].id, WELCOME_CHANNEL_ID);
        assert_eq!(channels[0].name, WELCOME_CHANNEL_NAME);
        assert_eq!(channels[0].kind, "porch");
        assert_eq!(channels[0].acl_mode, "open");
    }

    #[tokio::test]
    async fn session_token_is_unique_per_porch_instance() {
        let peer = fresh_peer_id();
        let a = EphemeralPorch::new(peer);
        let b = EphemeralPorch::new(peer);
        assert_ne!(
            a.session_token(),
            b.session_token(),
            "two porches built back-to-back must mint different session tokens"
        );
        let len = base64::engine::general_purpose::STANDARD
            .decode(a.session_token())
            .expect("session token must decode as standard base64")
            .len();
        assert_eq!(len, SESSION_TOKEN_BYTES);
    }

    #[tokio::test]
    async fn identity_publishes_peer_id_and_token() {
        let peer = fresh_peer_id();
        let porch = EphemeralPorch::new(peer);
        let identity = porch.identity();
        assert_eq!(identity.peer_id, peer.to_base58());
        assert_eq!(identity.session_token, porch.session_token());
    }

    /// Boot the EphemeralPorch, send a message → present in
    /// `get_messages`. This is the F1a verification deliverable #1.
    #[tokio::test]
    async fn send_then_get_round_trip() {
        let porch = EphemeralPorch::new(fresh_peer_id());
        let msg = porch
            .send_message(WELCOME_CHANNEL_ID, "12D3SomeVisitor", "hello porch")
            .await
            .expect("send must succeed on the seeded welcome channel");
        let messages = porch.get_messages(WELCOME_CHANNEL_ID).await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].body, "hello porch");
        assert_eq!(messages[0].author_peer_id, "12D3SomeVisitor");
        assert_eq!(messages[0].id, msg.id);
    }

    /// Drop the EphemeralPorch (simulate binary exit), construct a new
    /// one → messages gone, default `welcome` channel re-seeded. F1a
    /// verification deliverable #2.
    #[tokio::test]
    async fn drop_loses_messages_and_reseeds_welcome() {
        let peer = fresh_peer_id();
        let porch_a = EphemeralPorch::new(peer);
        porch_a
            .send_message(WELCOME_CHANNEL_ID, "guest", "I was here")
            .await
            .expect("send ok");
        assert_eq!(porch_a.get_messages(WELCOME_CHANNEL_ID).await.len(), 1);

        // Simulate process exit: drop the porch, build a new one.
        drop(porch_a);
        let porch_b = EphemeralPorch::new(peer);

        let channels = porch_b.list_channels().await;
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].id, WELCOME_CHANNEL_ID);
        assert!(
            porch_b.get_messages(WELCOME_CHANNEL_ID).await.is_empty(),
            "fresh porch must start with no messages"
        );
    }

    /// Inbound handler with a bad token → `InvalidCredentials`. F1a
    /// verification deliverable #3.
    #[tokio::test]
    async fn verify_bad_token_returns_invalid_credentials() {
        let peer = fresh_peer_id();
        let porch = EphemeralPorch::new(peer);
        let visitor = fresh_peer_id();
        let creds = PorchCredentials {
            peer_id: visitor.to_base58(),
            session_token: "obviously-wrong-token".to_string(),
        };
        let err = porch
            .verify(visitor, &creds)
            .await
            .expect_err("bad token must reject");
        match err {
            PorchAuthError::InvalidCredentials(reason) => {
                assert!(
                    reason.contains("session token"),
                    "rejection reason must name the failed check: {reason}"
                );
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    /// Inbound handler with a valid token but unknown peer-id →
    /// `InvalidCredentials`. F1a verification deliverable #4.
    #[tokio::test]
    async fn verify_unknown_peer_returns_invalid_credentials() {
        let host = fresh_peer_id();
        // Only `paired` is allowed; `unknown_visitor` is not.
        let paired = fresh_peer_id();
        let porch = EphemeralPorch::with_acl(
            host,
            Arc::new(StaticAllowlistChecker {
                allowed: vec![paired],
            }),
        );
        let token = porch.session_token().to_string();
        let unknown_visitor = fresh_peer_id();
        let creds = PorchCredentials {
            peer_id: unknown_visitor.to_base58(),
            session_token: token,
        };
        let err = porch
            .verify(unknown_visitor, &creds)
            .await
            .expect_err("unpaired visitor must be rejected");
        match err {
            PorchAuthError::InvalidCredentials(reason) => {
                assert!(
                    reason.contains("paired-peer"),
                    "rejection reason must name the ACL check: {reason}"
                );
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    /// A credentials frame whose `peer_id` doesn't match the
    /// transport-attributed dialer must be rejected. Defends against a
    /// dialer that stole a token from somewhere trying to claim a
    /// different identity at the porch.
    #[tokio::test]
    async fn verify_peer_id_mismatch_returns_invalid_credentials() {
        let host = fresh_peer_id();
        let porch = EphemeralPorch::new(host);
        let real_dialer = fresh_peer_id();
        let claimed_other = fresh_peer_id();
        let creds = PorchCredentials {
            peer_id: claimed_other.to_base58(),
            session_token: porch.session_token().to_string(),
        };
        let err = porch
            .verify(real_dialer, &creds)
            .await
            .expect_err("mismatched peer-id claim must reject");
        match err {
            PorchAuthError::InvalidCredentials(reason) => {
                assert!(
                    reason.contains("does not match"),
                    "rejection reason must name the mismatch: {reason}"
                );
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_to_unknown_channel_returns_dispatch_error() {
        let porch = EphemeralPorch::new(fresh_peer_id());
        let err = porch
            .send_message("does-not-exist", "guest", "hi")
            .await
            .expect_err("unknown channel must reject");
        match err {
            PorchAuthError::Dispatch(reason) => {
                assert!(reason.contains("channel not found"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_with_empty_body_returns_dispatch_error() {
        let porch = EphemeralPorch::new(fresh_peer_id());
        let err = porch
            .send_message(WELCOME_CHANNEL_ID, "guest", "")
            .await
            .expect_err("empty body must reject");
        assert!(matches!(err, PorchAuthError::Dispatch(_)));
    }

    /// `VecDeque<EphemeralMessage>::front` returns the oldest — this
    /// pins the assumption that `send_message` pushes to the back.
    #[tokio::test]
    async fn messages_returned_oldest_first() {
        let porch = EphemeralPorch::new(fresh_peer_id());
        porch
            .send_message(WELCOME_CHANNEL_ID, "g", "first")
            .await
            .unwrap();
        porch
            .send_message(WELCOME_CHANNEL_ID, "g", "second")
            .await
            .unwrap();
        let messages = porch.get_messages(WELCOME_CHANNEL_ID).await;
        assert_eq!(messages[0].body, "first");
        assert_eq!(messages[1].body, "second");
    }

    /// Bounded-queue OOM guard — once a channel hits
    /// `MAX_MESSAGES_PER_CHANNEL`, the oldest entry is dropped on the
    /// next send. The pin uses the real cap (10_000); the test runs
    /// in well under a second on every dev box this has been run
    /// against.
    #[tokio::test]
    async fn bounded_queue_drops_oldest_when_full() {
        let porch = EphemeralPorch::new(fresh_peer_id());
        for i in 0..(MAX_MESSAGES_PER_CHANNEL + 5) {
            porch
                .send_message(WELCOME_CHANNEL_ID, "guest", &format!("msg-{i}"))
                .await
                .expect("send ok");
        }
        let messages = porch.get_messages(WELCOME_CHANNEL_ID).await;
        assert_eq!(
            messages.len(),
            MAX_MESSAGES_PER_CHANNEL,
            "queue must be capped at MAX_MESSAGES_PER_CHANNEL"
        );
        assert_eq!(messages.first().unwrap().body, "msg-5");
        assert_eq!(
            messages.last().unwrap().body,
            format!("msg-{}", MAX_MESSAGES_PER_CHANNEL + 4)
        );
    }
}
