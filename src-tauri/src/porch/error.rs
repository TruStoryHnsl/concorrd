//! Porch error surface. Everything fallible in the porch module returns
//! a [`PorchError`]. SQLite, JSON, IO, ACL-denied, and protocol errors
//! all funnel through here so callers (Tauri commands, the libp2p
//! handler, tests) get a single type to pattern-match against.

use thiserror::Error;

/// Errors surfaced by the porch module.
#[derive(Debug, Error)]
pub enum PorchError {
    /// Underlying SQLite failure — schema migration, query, etc.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// JSON serialization or deserialization failure (envelope decode,
    /// `PorchRequest` parse, etc.).
    #[error("serde_json: {0}")]
    Serde(#[from] serde_json::Error),

    /// Plain IO error — usually a libp2p stream read/write that failed.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// Visitor tried to read or write a channel they don't have ACL
    /// access to. Mapped onto a 403 in the wire protocol's
    /// [`crate::porch::PorchResponse::error`] body.
    #[error("access denied for channel {channel_id}")]
    AccessDenied { channel_id: String },

    /// Caller referenced a channel that doesn't exist in the local
    /// porch DB. Mapped onto a 404 in the wire protocol.
    #[error("channel not found: {channel_id}")]
    ChannelNotFound { channel_id: String },

    /// Wire envelope was malformed — typically length-prefix oversize
    /// or non-UTF-8 body. Distinct from `Serde` because the framing
    /// check fires before deserialization.
    #[error("malformed envelope: {0}")]
    MalformedEnvelope(String),

    /// Inbound stream closed before a complete envelope arrived.
    #[error("stream closed unexpectedly")]
    StreamClosed,

    /// Body validation failed (empty post, too large, etc.).
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

impl PorchError {
    /// HTTP-ish status code for this error, used by the wire protocol
    /// to fill out [`crate::porch::PorchErrorBody::code`].
    pub fn status_code(&self) -> i32 {
        match self {
            PorchError::AccessDenied { .. } => 403,
            PorchError::ChannelNotFound { .. } => 404,
            PorchError::InvalidInput(_) => 400,
            PorchError::MalformedEnvelope(_) => 400,
            PorchError::Sqlite(_) => 500,
            PorchError::Serde(_) => 400,
            PorchError::Io(_) => 500,
            PorchError::StreamClosed => 499,
        }
    }
}
