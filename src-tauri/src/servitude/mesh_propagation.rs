//! Feature F3 — mesh propagation of porch address (one-hop) +
//! supporting helpers for multi-hop read-only history (see
//! [`crate::porch::history_protocol`] for the multi-hop side).
//!
//! ## What this module does
//!
//! When a Concord install's libp2p multiaddrs change — a network move,
//! NAT rebind, a new listener coming up — every install that has paired
//! with us needs to learn the new address or our porch becomes
//! unreachable to them. Static "remember the address you saw at QR-scan
//! time" wears out fast: a phone that moves between LAN / cellular / a
//! coffee-shop wifi rotates its observable multiaddrs every few hours.
//!
//! The fix in F3 is **one-hop address auto-resolution** over libp2p's
//! gossipsub:
//!
//!   1. Each install owns a gossipsub topic named after its stable
//!      base58 PeerId — [`rotation_topic_for_peer`]. Topic name is
//!      `concord/porch-addr/<base58-peer-id>/v1`.
//!   2. Whenever our local set of multiaddrs changes, we publish a
//!      signed [`AddressRotation`] payload on our own topic
//!      ([`publish_address_rotation`]).
//!   3. Paired peers subscribe to the rotation topic of every peer
//!      they've paired with — [`subscribe_to_paired_peers`] takes the
//!      paired-peer list and subscribes to one topic per entry.
//!   4. On receipt the listener updates its `KnownPeer.multiaddrs`
//!      cache via the existing [`crate::servitude::peer_store::add`]
//!      union-merge path, so the next dial attempt uses the fresh
//!      address. Stale addresses are kept too (insertion order
//!      preserves history) — the dial logic walks them in order.
//!
//! ## Why gossipsub (and not a request-response broadcast)
//!
//! Three properties matter:
//!
//!   * **Bounded subscription**. A single install only subscribes to
//!     the rotation topics of peers it has *paired* with — typically a
//!     handful per install, not the network's full peer count. This is
//!     enforced by callers passing only the paired-peer list to
//!     [`subscribe_to_paired_peers`]; the module does no implicit
//!     discovery.
//!   * **Authenticated origin**. The swarm is built with
//!     [`libp2p::gossipsub::MessageAuthenticity::Signed`] (see
//!     `servitude/p2p.rs`), so receivers can verify a rotation message
//!     was signed by the libp2p key whose PeerId names the topic.
//!     Receivers MUST cross-check the message's libp2p source against
//!     the topic-owner's PeerId before applying the update — that
//!     check lives in [`AddressRotation::matches_topic_owner`].
//!   * **Mesh propagation**. gossipsub's mesh overlay carries the
//!     announcement to subscribers even if the publisher isn't
//!     directly connected to them, as long as some path through the
//!     mesh exists.
//!
//! ## What this module does NOT do
//!
//! No multi-hop logic lives here — that's
//! [`crate::porch::history_protocol`]. The two features share a
//! conceptual umbrella ("mesh propagation of porch addresses and
//! history") but a `KnownPeer.multiaddrs` update is a strictly
//! one-hop event: only paired peers learn the new address. A
//! friend-of-a-friend doesn't get an automatic address update; they
//! get *read-only history access* via the porch-history protocol
//! instead.
//!
//! ## Wire format
//!
//! Rotation payload is JSON (matches the rest of the porch protocol
//! stack) — easy to debug, easy to evolve additively. A future field
//! addition uses serde defaults; a breaking change bumps the `/v1`
//! suffix in [`rotation_topic_for_peer`].
//!
//! ```json
//! {
//!   "version": 1,
//!   "peer_id": "12D3KooW...",
//!   "multiaddrs": ["/ip4/.../udp/1234/quic-v1", "..."],
//!   "ts_unix_ms": 1735000000000
//! }
//! ```
//!
//! `peer_id` is the publisher's base58 PeerId; receivers verify it
//! against the gossipsub topic owner. `ts_unix_ms` lets receivers
//! discard out-of-order replays from in-flight retransmissions.

use libp2p::gossipsub::{IdentTopic, PublishError, SubscriptionError};
use libp2p::{Multiaddr, PeerId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::servitude::p2p::Behaviour;

/// Topic-name prefix for porch-address rotation announcements. The full
/// topic per install is `concord/porch-addr/<base58-peer-id>/v1`. The
/// `/v1` suffix is a wire-version marker — bump it if the
/// [`AddressRotation`] shape ever changes in a non-additive way.
pub const ROTATION_TOPIC_PREFIX: &str = "concord/porch-addr/";

/// Topic-version suffix appended after the peer id.
pub const ROTATION_TOPIC_VERSION: &str = "/v1";

/// Current wire-format version of [`AddressRotation`]. Bumped on a
/// non-additive change.
pub const ROTATION_PAYLOAD_VERSION: u32 = 1;

/// Maximum number of multiaddrs a single rotation payload is allowed
/// to carry. A reasonable install advertises maybe a dozen addresses
/// (LAN + tailscale + relay'd circuit + ipv6 + ...). Receivers reject
/// payloads beyond this cap as malformed so an attacker can't burn a
/// receiver's peer-store with a megabyte of garbage addresses.
pub const MAX_ROTATION_ADDRS: usize = 64;

/// Build the gossipsub topic name for a peer's porch-address rotation
/// channel. Each install is the sole publisher on its own topic and
/// listens to one topic per peer it has paired with.
///
/// Format: `concord/porch-addr/<base58-peer-id>/v1`.
pub fn rotation_topic_for_peer(peer_id: &PeerId) -> IdentTopic {
    let name = format!(
        "{}{}{}",
        ROTATION_TOPIC_PREFIX,
        peer_id.to_base58(),
        ROTATION_TOPIC_VERSION
    );
    IdentTopic::new(name)
}

/// Extract the base58 PeerId encoded inside a rotation topic string.
/// Returns `None` if the input does not look like a Concord rotation
/// topic (wrong prefix, wrong suffix, or empty peer-id section). Used
/// by receivers to discover which peer a topic announcement came from
/// without having to keep a side-table of `topic_hash -> peer_id`.
pub fn parse_rotation_topic(topic_str: &str) -> Option<&str> {
    let rest = topic_str.strip_prefix(ROTATION_TOPIC_PREFIX)?;
    let peer_str = rest.strip_suffix(ROTATION_TOPIC_VERSION)?;
    if peer_str.is_empty() {
        return None;
    }
    Some(peer_str)
}

/// Signed-by-the-libp2p-keypair payload broadcast on a peer's rotation
/// topic. The gossipsub layer wraps this in a signed envelope (see
/// `MessageAuthenticity::Signed` in `servitude/p2p.rs::new_with_gate`),
/// so receivers can cryptographically attribute the payload to a
/// specific PeerId without trusting the topic name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AddressRotation {
    /// Wire-format version. Receivers reject payloads with a version
    /// higher than [`ROTATION_PAYLOAD_VERSION`] so a forward-compat
    /// crash never bubbles up to the user.
    pub version: u32,
    /// Publisher's base58 libp2p PeerId. Receivers verify this matches
    /// the topic-owner (see [`Self::matches_topic_owner`]) AND the
    /// gossipsub message `source` (which the libp2p layer derives from
    /// the signature).
    pub peer_id: String,
    /// Publisher's current libp2p multiaddrs. Strings (not parsed
    /// `Multiaddr` values) so the JSON wire form is stable across libp2p
    /// version bumps. Receivers re-parse on apply.
    pub multiaddrs: Vec<String>,
    /// Unix-milliseconds timestamp. Used by receivers as a tiebreaker
    /// against in-flight retransmissions of an older rotation — keep
    /// the highest `ts_unix_ms` seen per peer.
    pub ts_unix_ms: i64,
}

impl AddressRotation {
    /// Build a rotation payload for the local install. Filters out
    /// loopback / unspecified addresses so receivers never learn an
    /// address they can't dial. Sorts the result for determinism so
    /// two consecutive calls with the same input produce byte-identical
    /// payloads (useful for de-dup at the publish layer).
    pub fn from_local(peer_id: PeerId, addrs: &[Multiaddr]) -> Self {
        let mut filtered: Vec<String> = addrs
            .iter()
            .filter(|a| !addr_is_unspecified_or_loopback(a))
            .map(|a| a.to_string())
            .collect();
        filtered.sort();
        filtered.dedup();
        if filtered.len() > MAX_ROTATION_ADDRS {
            filtered.truncate(MAX_ROTATION_ADDRS);
        }
        Self {
            version: ROTATION_PAYLOAD_VERSION,
            peer_id: peer_id.to_base58(),
            multiaddrs: filtered,
            ts_unix_ms: now_unix_millis(),
        }
    }

    /// Decode a rotation payload from JSON bytes. Returns
    /// [`MeshError::Malformed`] on parse failure or version mismatch.
    pub fn decode(bytes: &[u8]) -> Result<Self, MeshError> {
        let payload: Self = serde_json::from_slice(bytes)
            .map_err(|e| MeshError::Malformed(format!("json: {e}")))?;
        if payload.version > ROTATION_PAYLOAD_VERSION {
            return Err(MeshError::Malformed(format!(
                "rotation payload version {} > supported {}",
                payload.version, ROTATION_PAYLOAD_VERSION
            )));
        }
        if payload.multiaddrs.len() > MAX_ROTATION_ADDRS {
            return Err(MeshError::Malformed(format!(
                "rotation payload carries {} multiaddrs > cap {}",
                payload.multiaddrs.len(),
                MAX_ROTATION_ADDRS
            )));
        }
        Ok(payload)
    }

    /// Encode the payload as JSON bytes for gossipsub publish.
    pub fn encode(&self) -> Vec<u8> {
        // serde_json::to_vec is infallible for our shape (no maps with
        // non-string keys, no NaN floats); unwrap is safe.
        serde_json::to_vec(self).expect("AddressRotation has no non-encodable fields")
    }

    /// Receivers MUST call this after decoding to confirm the payload's
    /// `peer_id` string matches the PeerId encoded in the gossipsub topic
    /// the message arrived on. Without this check, a peer that joined
    /// the mesh could publish on another peer's topic and overwrite
    /// their cached multiaddrs.
    pub fn matches_topic_owner(&self, topic_owner: &PeerId) -> bool {
        self.peer_id == topic_owner.to_base58()
    }

    /// Receivers cross-check the payload's claimed peer against the
    /// gossipsub-layer attributed `source` (the libp2p PeerId derived
    /// from the message's signature). Returns true iff the source
    /// matches the payload's claimed publisher.
    pub fn matches_source(&self, source: &PeerId) -> bool {
        self.peer_id == source.to_base58()
    }

    /// Parse a multiaddr string into [`Multiaddr`]. Returns
    /// [`MeshError::InvalidMultiaddr`] on parse failure — callers
    /// should silently skip malformed addresses rather than rejecting
    /// the whole payload (one bad address shouldn't poison the rest).
    pub fn parse_multiaddr(s: &str) -> Result<Multiaddr, MeshError> {
        s.parse::<Multiaddr>()
            .map_err(|e| MeshError::InvalidMultiaddr(format!("{s:?}: {e}")))
    }
}

/// Subscribe the swarm's gossipsub behaviour to the rotation topic of
/// each peer in `paired_peer_ids`. Idempotent — subscribing to an
/// already-subscribed topic is a no-op at the gossipsub layer. Returns
/// the number of *new* subscriptions actually added.
///
/// Caller invariant: the input set MUST be the operator's paired peers
/// (the set stored in `peer_store::list`). Subscribing to non-paired
/// topics is wasteful (subscriptions cost mesh-overlay slots) and
/// defeats the "bounded subscription" property the design relies on.
pub fn subscribe_to_paired_peers(
    swarm: &mut libp2p::Swarm<Behaviour>,
    paired_peer_ids: &[PeerId],
) -> Result<usize, MeshError> {
    let mut added = 0usize;
    for peer_id in paired_peer_ids {
        let topic = rotation_topic_for_peer(peer_id);
        match swarm.behaviour_mut().gossipsub.subscribe(&topic) {
            Ok(true) => added += 1,
            Ok(false) => {
                // Already subscribed — quietly no-op.
            }
            Err(e) => {
                return Err(MeshError::Subscribe(format!(
                    "subscribe to {}: {e}",
                    topic.hash()
                )));
            }
        }
    }
    Ok(added)
}

/// Unsubscribe from the rotation topic of `peer_id`. Used by callers
/// when a previously-paired peer is removed from the peer-store, so
/// the gossipsub overlay doesn't keep carrying their announcements.
pub fn unsubscribe_from_peer(
    swarm: &mut libp2p::Swarm<Behaviour>,
    peer_id: &PeerId,
) -> Result<bool, MeshError> {
    let topic = rotation_topic_for_peer(peer_id);
    Ok(swarm.behaviour_mut().gossipsub.unsubscribe(&topic))
}

/// Publish an [`AddressRotation`] on the local install's own topic.
/// Builds the payload from the supplied multiaddrs (typically the set
/// returned by `swarm.listeners()` filtered to non-loopback), then
/// publishes it on the rotation topic whose name encodes `local_peer_id`.
///
/// Returns [`MeshError::Publish`] when gossipsub refuses the publish —
/// this is normal on a freshly-started swarm with no mesh peers yet
/// (`InsufficientPeers`), and callers should retry the publish next
/// time a mesh peer connects.
pub fn publish_address_rotation(
    swarm: &mut libp2p::Swarm<Behaviour>,
    local_peer_id: PeerId,
    addrs: &[Multiaddr],
) -> Result<AddressRotation, MeshError> {
    let payload = AddressRotation::from_local(local_peer_id, addrs);
    let topic = rotation_topic_for_peer(&local_peer_id);
    // We MUST be subscribed to our own topic before publishing so the
    // gossipsub mesh can route our payload — subscribing is idempotent.
    let _ = swarm.behaviour_mut().gossipsub.subscribe(&topic);
    let bytes = payload.encode();
    swarm
        .behaviour_mut()
        .gossipsub
        .publish(topic.clone(), bytes)
        .map_err(|e| MeshError::Publish(format!("{e}")))?;
    Ok(payload)
}

/// Errors raised by the mesh-propagation surface.
#[derive(Debug, Error)]
pub enum MeshError {
    #[error("gossipsub subscribe failed: {0}")]
    Subscribe(String),
    #[error("gossipsub publish failed: {0}")]
    Publish(String),
    #[error("rotation payload malformed: {0}")]
    Malformed(String),
    #[error("rotation payload carries invalid multiaddr: {0}")]
    InvalidMultiaddr(String),
}

impl From<SubscriptionError> for MeshError {
    fn from(e: SubscriptionError) -> Self {
        MeshError::Subscribe(format!("{e}"))
    }
}

impl From<PublishError> for MeshError {
    fn from(e: PublishError) -> Self {
        MeshError::Publish(format!("{e}"))
    }
}

/// `Multiaddr` is considered unsuitable for advertising when it is
/// loopback (`127.0.0.0/8`, `::1`) or unspecified (`0.0.0.0`, `::`).
/// Receivers can't dial these and would only pollute their address
/// cache.
fn addr_is_unspecified_or_loopback(addr: &Multiaddr) -> bool {
    use libp2p::multiaddr::Protocol;
    for proto in addr.iter() {
        match proto {
            Protocol::Ip4(ip) => {
                if ip.is_loopback() || ip.is_unspecified() {
                    return true;
                }
            }
            Protocol::Ip6(ip) => {
                if ip.is_loopback() || ip.is_unspecified() {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn now_unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn fake_peer_id() -> PeerId {
        PeerId::from(Keypair::generate_ed25519().public())
    }

    #[test]
    fn rotation_topic_round_trips() {
        let peer = fake_peer_id();
        let topic = rotation_topic_for_peer(&peer);
        let topic_str = topic.to_string();
        let extracted =
            parse_rotation_topic(&topic_str).expect("topic must parse back");
        assert_eq!(extracted, peer.to_base58());
    }

    #[test]
    fn parse_rotation_topic_rejects_foreign_topics() {
        assert!(parse_rotation_topic("concord/something-else/foo/v1").is_none());
        assert!(parse_rotation_topic("concord/porch-addr/").is_none());
        assert!(parse_rotation_topic("concord/porch-addr/abc").is_none());
        assert!(parse_rotation_topic("").is_none());
    }

    #[test]
    fn from_local_filters_loopback_and_unspecified() {
        let peer = fake_peer_id();
        let addrs: Vec<Multiaddr> = vec![
            "/ip4/0.0.0.0/udp/9999/quic-v1".parse().unwrap(),
            "/ip4/127.0.0.1/tcp/4001".parse().unwrap(),
            "/ip4/192.168.1.10/udp/9999/quic-v1".parse().unwrap(),
            "/ip6/::1/tcp/4001".parse().unwrap(),
            "/ip6/2001:db8::1/tcp/4001".parse().unwrap(),
        ];
        let r = AddressRotation::from_local(peer, &addrs);
        // Only the two non-loopback non-unspecified ones survive.
        assert_eq!(r.multiaddrs.len(), 2);
        assert!(r
            .multiaddrs
            .iter()
            .any(|a| a.contains("192.168.1.10")));
        assert!(r
            .multiaddrs
            .iter()
            .any(|a| a.contains("2001:db8::1")));
    }

    #[test]
    fn from_local_dedupes_and_caps_addrs() {
        let peer = fake_peer_id();
        let mut addrs: Vec<Multiaddr> = Vec::new();
        for _ in 0..10 {
            addrs.push("/ip4/192.168.1.10/udp/9999/quic-v1".parse().unwrap());
        }
        let r = AddressRotation::from_local(peer, &addrs);
        assert_eq!(r.multiaddrs.len(), 1, "duplicates must collapse");

        // Cap enforcement.
        let mut huge: Vec<Multiaddr> = Vec::new();
        for i in 0..(MAX_ROTATION_ADDRS + 16) {
            huge.push(
                format!("/ip4/192.168.1.10/udp/{}/quic-v1", 10000 + i)
                    .parse()
                    .unwrap(),
            );
        }
        let r = AddressRotation::from_local(peer, &huge);
        assert_eq!(r.multiaddrs.len(), MAX_ROTATION_ADDRS);
    }

    #[test]
    fn encode_decode_round_trip() {
        let peer = fake_peer_id();
        let addrs: Vec<Multiaddr> =
            vec!["/ip4/192.168.1.10/udp/9999/quic-v1".parse().unwrap()];
        let original = AddressRotation::from_local(peer, &addrs);
        let encoded = original.encode();
        let decoded = AddressRotation::decode(&encoded).expect("decode round-trip");
        assert_eq!(decoded.peer_id, original.peer_id);
        assert_eq!(decoded.multiaddrs, original.multiaddrs);
        assert_eq!(decoded.version, ROTATION_PAYLOAD_VERSION);
    }

    #[test]
    fn decode_rejects_future_version() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": ROTATION_PAYLOAD_VERSION + 1,
            "peer_id": "x",
            "multiaddrs": [],
            "ts_unix_ms": 0,
        }))
        .unwrap();
        let err = AddressRotation::decode(&bytes).unwrap_err();
        match err {
            MeshError::Malformed(_) => {}
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn decode_rejects_oversized_address_list() {
        let mut addrs = Vec::new();
        for i in 0..(MAX_ROTATION_ADDRS + 1) {
            addrs.push(format!("/ip4/192.168.1.10/udp/{i}/quic-v1"));
        }
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": ROTATION_PAYLOAD_VERSION,
            "peer_id": "x",
            "multiaddrs": addrs,
            "ts_unix_ms": 0,
        }))
        .unwrap();
        assert!(matches!(
            AddressRotation::decode(&bytes),
            Err(MeshError::Malformed(_))
        ));
    }

    #[test]
    fn matches_topic_owner_rejects_mismatched_peer() {
        let peer_a = fake_peer_id();
        let peer_b = fake_peer_id();
        let r = AddressRotation::from_local(peer_a, &[]);
        assert!(r.matches_topic_owner(&peer_a));
        assert!(!r.matches_topic_owner(&peer_b));
        assert!(r.matches_source(&peer_a));
        assert!(!r.matches_source(&peer_b));
    }

    #[test]
    fn parse_multiaddr_rejects_garbage() {
        assert!(AddressRotation::parse_multiaddr("not-a-multiaddr").is_err());
        assert!(
            AddressRotation::parse_multiaddr("/ip4/1.2.3.4/udp/4001/quic-v1").is_ok()
        );
    }
}
