//! F-VIS — per-server mesh-hop visibility property + filter helpers.
//!
//! This module is the cross-cutting glue between three pre-existing
//! subsystems:
//!
//!   1. [`crate::porch::db`] — the `visibility_meta` SQLite table (schema
//!      v9) where each server's `max_hops` setting persists across
//!      launches. Owns the CRUD; this module just bridges it.
//!   2. [`crate::servitude::mesh_propagation`] — the gossipsub topic
//!      already shipped in F3 for address-rotation announcements. A
//!      visibility change rides the SAME topic with a distinct payload
//!      tag so receivers within the operator's mesh radius pick it up
//!      without us spinning up another topic per install.
//!   3. The Tauri command surface in `lib.rs` — exposes
//!      `visibility_get_server` / `visibility_set_server` to the
//!      renderer.
//!
//! ## Architecture B context
//!
//! The 2026-06-01 RFC-resolution filing in `instructions_inbox.md`
//! ("RFC #140 open-question resolutions + new architecture") split
//! peer-access from peer-visibility:
//!
//!   * **Visibility** — does this peer/server appear in the user's
//!     explore menu? Governed by `visibility_meta.max_hops` per server
//!     + the receiver's current mesh distance to the advertiser.
//!   * **Access** — can this peer actually dial in once visible?
//!     Governed by the peer-store's `access_granted` flag (see
//!     [`crate::servitude::peer_store`]).
//!
//! A peer that's been permanently access-revoked (e.g. timed out)
//! remains VISIBLE in the user's list — they still know that peer
//! exists — but is no longer in the access set until the host
//! re-affirms. This module covers the visibility half; the peer-store
//! covers the access half.
//!
//! ## Wire format — `VisibilityUpdate`
//!
//! Payload tagged with `"visibility_update"` (vs F3's untagged address
//! rotation). Receivers route via the `kind` field so both message
//! types can flow on the same topic without ambiguity.
//!
//! ```json
//! {
//!   "kind": "visibility_update",
//!   "version": 1,
//!   "publisher_peer_id": "12D3KooW...",
//!   "server_id": "porch",
//!   "max_hops": 2,
//!   "last_changed_at": 1735000000000
//! }
//! ```
//!
//! The receiver's filter logic ([`explore_filter::is_server_visible`])
//! is intentionally a pure function on the inputs (advertiser distance,
//! advertised max_hops) so it's trivially testable and the same code
//! runs on host-side (when rendering the operator's own explore-menu
//! preview) and visitor-side.

use serde::{Deserialize, Serialize};

use super::db::VisibilityRow;

/// Wire-format version of [`VisibilityUpdate`]. Bumped on a
/// non-additive change.
pub const VISIBILITY_PAYLOAD_VERSION: u32 = 1;

/// Tag string that identifies a visibility-update payload on the shared
/// gossipsub topic. Receivers route between this and F3's address
/// rotation on `kind`.
pub const VISIBILITY_PAYLOAD_KIND: &str = "visibility_update";

/// Maximum length of a `server_id` accepted on the wire. Defended-in-depth
/// against a malicious peer planting a megabyte-long string in the
/// receiver's `visibility_meta` table.
pub const MAX_SERVER_ID_LEN: usize = 128;

/// Cross-mesh propagation payload. Authored by the server's owner,
/// signed by the gossipsub layer (same `MessageAuthenticity::Signed`
/// that F3 relies on), broadcast on the publisher's existing rotation
/// topic.
///
/// Receivers cross-check the `publisher_peer_id` field against the
/// gossipsub-layer attributed `source` and against the topic owner —
/// same defense F3 uses for address rotation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisibilityUpdate {
    /// Discriminator tag — always equal to [`VISIBILITY_PAYLOAD_KIND`].
    /// Receivers MUST verify this before deserializing the rest of the
    /// payload as a visibility update.
    pub kind: String,
    /// Wire-format version. Future-compat — receivers reject payloads
    /// with `version > VISIBILITY_PAYLOAD_VERSION` so a downgrade fails
    /// loudly instead of silently mis-parsing.
    pub version: u32,
    /// Publisher's base58 libp2p PeerId — must match the topic owner
    /// and the gossipsub-layer source. Receivers reject mismatches.
    pub publisher_peer_id: String,
    /// Stable server identifier ("porch", "home", or a user-created
    /// server's UUID).
    pub server_id: String,
    /// The new mesh-hop visibility ceiling.
    pub max_hops: u8,
    /// Publisher's `last_changed_at` for this row. Receivers apply LWW
    /// (strictly-greater wins) when merging into local
    /// `visibility_meta`.
    pub last_changed_at: i64,
}

impl VisibilityUpdate {
    /// Construct a payload from a local [`VisibilityRow`] for broadcast.
    pub fn from_row(publisher_peer_id: String, row: &VisibilityRow) -> Self {
        Self {
            kind: VISIBILITY_PAYLOAD_KIND.to_string(),
            version: VISIBILITY_PAYLOAD_VERSION,
            publisher_peer_id,
            server_id: row.server_id.clone(),
            max_hops: row.max_hops,
            last_changed_at: row.last_changed_at,
        }
    }

    /// Encode as JSON bytes for gossipsub publish. Infallible for our
    /// shape (no NaN floats, no map-with-non-string-keys).
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self)
            .expect("VisibilityUpdate has no non-encodable fields")
    }

    /// Decode JSON bytes. Returns `Err` on parse failure, mismatched
    /// `kind`, future `version`, or an oversize `server_id`. Receivers
    /// call this on every gossipsub message body and silently drop
    /// errors — a bad payload from one peer never poisons others.
    pub fn decode(bytes: &[u8]) -> Result<Self, VisibilityWireError> {
        let payload: Self = serde_json::from_slice(bytes)
            .map_err(|e| VisibilityWireError::Malformed(format!("json: {e}")))?;
        if payload.kind != VISIBILITY_PAYLOAD_KIND {
            return Err(VisibilityWireError::WrongKind(payload.kind));
        }
        if payload.version > VISIBILITY_PAYLOAD_VERSION {
            return Err(VisibilityWireError::Malformed(format!(
                "version {} > supported {}",
                payload.version, VISIBILITY_PAYLOAD_VERSION
            )));
        }
        if payload.server_id.is_empty() {
            return Err(VisibilityWireError::Malformed(
                "server_id is empty".to_string(),
            ));
        }
        if payload.server_id.len() > MAX_SERVER_ID_LEN {
            return Err(VisibilityWireError::Malformed(format!(
                "server_id length {} > cap {}",
                payload.server_id.len(),
                MAX_SERVER_ID_LEN
            )));
        }
        Ok(payload)
    }

    /// Convert the (validated) payload back into a [`VisibilityRow`]
    /// for local persistence via
    /// [`crate::porch::db::Porch::apply_visibility_if_newer`].
    pub fn to_row(&self) -> VisibilityRow {
        VisibilityRow {
            server_id: self.server_id.clone(),
            max_hops: self.max_hops,
            last_changed_at: self.last_changed_at,
        }
    }
}

/// Failure modes that drop a single inbound gossipsub message without
/// crashing the swarm.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VisibilityWireError {
    #[error("payload `kind` was {0:?}, expected `visibility_update`")]
    WrongKind(String),
    #[error("visibility payload malformed: {0}")]
    Malformed(String),
}

// ---------------------------------------------------------------------------
// Explore-menu filter — pure function on (advertiser hop distance,
// advertised max_hops). Same code runs both for the local-host preview
// and for the visitor-side filter.
// ---------------------------------------------------------------------------

pub mod explore_filter {
    //! Visitor-side filter applied to each candidate server before it
    //! shows up in the renderer's "discover servers" surface.
    //!
    //! The filter is a pure function so it's trivially testable + the
    //! exact same logic can run on the host side when previewing
    //! "what does my server look like to a 3-hops-away visitor?"

    /// `true` iff a server advertising `server_max_hops` is visible to
    /// a receiver whose mesh-hop distance to the advertiser is
    /// `receiver_distance`.
    ///
    /// Rules:
    ///   * Distance 0 = the advertiser IS the receiver. They always
    ///     see their own servers (otherwise the operator UI would
    ///     mysteriously fail to render).
    ///   * `server_max_hops == 0` means "owner only" — only the
    ///     advertiser (distance 0) sees it.
    ///   * Otherwise visible iff `receiver_distance <= server_max_hops`.
    ///
    /// `receiver_distance` is `u32` to leave headroom for the F3 history
    /// protocol's hop-chain length (capped at
    /// [`crate::porch::history_protocol::MAX_HOP_CHAIN_LEN`] today), but
    /// the comparison against the `u8` ceiling is well-defined for any
    /// realistic mesh diameter.
    pub fn is_server_visible(receiver_distance: u32, server_max_hops: u8) -> bool {
        if receiver_distance == 0 {
            // Owner always sees their own server, regardless of
            // max_hops.
            return true;
        }
        if server_max_hops == 0 {
            // Owner-only — nobody but the owner.
            return false;
        }
        receiver_distance <= server_max_hops as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row() -> VisibilityRow {
        VisibilityRow {
            server_id: "porch".to_string(),
            max_hops: 2,
            last_changed_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn encode_decode_round_trip() {
        let row = sample_row();
        let update = VisibilityUpdate::from_row("12D3KooWfoo".to_string(), &row);
        let bytes = update.encode();
        let decoded = VisibilityUpdate::decode(&bytes).expect("decode ok");
        assert_eq!(decoded, update);
        assert_eq!(decoded.to_row(), row);
    }

    #[test]
    fn decode_rejects_wrong_kind() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "kind": "address_rotation",
            "version": 1,
            "publisher_peer_id": "x",
            "server_id": "porch",
            "max_hops": 1,
            "last_changed_at": 0,
        }))
        .unwrap();
        let err = VisibilityUpdate::decode(&bytes).expect_err("must reject");
        assert!(matches!(err, VisibilityWireError::WrongKind(_)));
    }

    #[test]
    fn decode_rejects_future_version() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "kind": VISIBILITY_PAYLOAD_KIND,
            "version": VISIBILITY_PAYLOAD_VERSION + 1,
            "publisher_peer_id": "x",
            "server_id": "porch",
            "max_hops": 1,
            "last_changed_at": 0,
        }))
        .unwrap();
        let err = VisibilityUpdate::decode(&bytes).expect_err("must reject");
        assert!(matches!(err, VisibilityWireError::Malformed(_)));
    }

    #[test]
    fn decode_rejects_empty_or_oversize_server_id() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "kind": VISIBILITY_PAYLOAD_KIND,
            "version": 1,
            "publisher_peer_id": "x",
            "server_id": "",
            "max_hops": 1,
            "last_changed_at": 0,
        }))
        .unwrap();
        assert!(matches!(
            VisibilityUpdate::decode(&bytes),
            Err(VisibilityWireError::Malformed(_))
        ));

        let oversized = "a".repeat(MAX_SERVER_ID_LEN + 1);
        let bytes = serde_json::to_vec(&serde_json::json!({
            "kind": VISIBILITY_PAYLOAD_KIND,
            "version": 1,
            "publisher_peer_id": "x",
            "server_id": oversized,
            "max_hops": 1,
            "last_changed_at": 0,
        }))
        .unwrap();
        assert!(matches!(
            VisibilityUpdate::decode(&bytes),
            Err(VisibilityWireError::Malformed(_))
        ));
    }

    #[test]
    fn explore_filter_owner_always_sees_their_own() {
        // Distance 0 (self) always visible, even when max_hops == 0
        // (owner-only).
        assert!(explore_filter::is_server_visible(0, 0));
        assert!(explore_filter::is_server_visible(0, 1));
        assert!(explore_filter::is_server_visible(0, 255));
    }

    #[test]
    fn explore_filter_owner_only_hides_from_everyone_else() {
        for d in 1..10u32 {
            assert!(
                !explore_filter::is_server_visible(d, 0),
                "max_hops=0 must hide from distance {d}"
            );
        }
    }

    #[test]
    fn explore_filter_hop_radius_inclusive() {
        // max_hops=1 → direct paired (distance 1) sees, distance 2+ doesn't.
        assert!(explore_filter::is_server_visible(1, 1));
        assert!(!explore_filter::is_server_visible(2, 1));

        // max_hops=2 → distance 1 + 2 see, distance 3+ doesn't.
        assert!(explore_filter::is_server_visible(1, 2));
        assert!(explore_filter::is_server_visible(2, 2));
        assert!(!explore_filter::is_server_visible(3, 2));

        // max_hops=5 → distance 1..=5 see, distance 6 doesn't.
        for d in 1..=5u32 {
            assert!(explore_filter::is_server_visible(d, 5), "distance {d}");
        }
        assert!(!explore_filter::is_server_visible(6, 5));
    }
}
