//! Project-run Kademlia bootstrap node list.
//!
//! These addresses are hardcoded — operators do NOT configure them. The
//! Concord project itself deploys a small fleet of long-lived libp2p
//! nodes (3–5, ~$5/mo each VPS) that participate in the Kad DHT with
//! stable Ed25519 PeerIds. The binary ships their multiaddrs here and
//! dials them silently at startup; the user never sees a setup wizard
//! or a "configure bootstrap nodes" UI.
//!
//! See `docs/architecture/p2p-bootstrap-deployment.md` for the
//! operational spec on how the project runs these nodes (VPS sizing,
//! key rotation, provisioning, monitoring).
//!
//! ## Why hardcoded
//!
//! Bootstrap addresses are a property of *the binary's release*, not of
//! *the install*. Rotating them means cutting a new Concord release; we
//! deliberately do NOT expose an env var or `--bootstrap-peers` CLI
//! flag, because (a) it would let a misconfigured client wedge itself
//! against unreachable nodes, and (b) it would invite social-engineering
//! attacks ("paste this multiaddr into Settings to join the cool new
//! shard"). One single project-controlled list, replaced in lockstep
//! with the binary that uses it.
//!
//! ## Placeholder PeerIds
//!
//! The current entries below contain placeholder PeerIds — they parse
//! as valid `Multiaddr` values but do not correspond to any real
//! deployed node. They exist so the wiring is testable end-to-end
//! before the actual bootstrap VPS fleet exists. Once the project
//! provisions the real nodes (see deployment doc), replace these in
//! lockstep with the release that depends on them.

use libp2p::Multiaddr;

/// Hardcoded list of Concord bootstrap nodes. Each entry is a libp2p
/// multiaddr that MUST include a `/p2p/<peer-id>` suffix so the Kad
/// behavior can pin the address to the right PeerId before any dial.
///
/// Replacement / rotation is by codebase update, NOT runtime config.
///
/// The PeerIds below are SYNTACTICALLY-VALID PLACEHOLDERS — they parse
/// as proper base58-multihash-encoded Ed25519 PeerIds (deterministically
/// derived from fixed dev seeds `b"CONCORDBS-1"`, `…-2`, `…-3`) so the
/// dial path is exercisable end-to-end before the real bootstrap VPS
/// fleet exists. Once the project provisions the real nodes (see
/// `docs/architecture/p2p-bootstrap-deployment.md`), regenerate this
/// list with each node's actual PeerId and DNS name, and cut a new
/// Concord release that ships the updated list.
pub const BOOTSTRAP_NODES: &[&str] = &[
    // bootstrap1.concordchat.net — placeholder, dev seed "CONCORDBS-1"
    "/dns4/bootstrap1.concordchat.net/udp/4001/quic-v1/p2p/12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W",
    // bootstrap2.concordchat.net — placeholder, dev seed "CONCORDBS-2"
    "/dns4/bootstrap2.concordchat.net/udp/4001/quic-v1/p2p/12D3KooWAPvtWRKcu3R6LknqqFvo8NcfYmHD3KARg44QruzR6mdn",
    // bootstrap3.concordchat.net — placeholder, dev seed "CONCORDBS-3"
    "/dns4/bootstrap3.concordchat.net/udp/4001/quic-v1/p2p/12D3KooWL4y2JJGGoQpfYcjhR52aH7FgLPSG5jPL9YvYo9EvNCby",
];

/// Parse the hardcoded list into a `Vec<Multiaddr>`.
///
/// Malformed entries are silently ignored (logged at `debug!`) so a bad
/// placeholder during development doesn't break bootstrap entirely. In
/// production every entry must parse — but the silent-skip behavior
/// keeps a broken release from panicking on startup, which is what
/// happens if we `.expect()` on a string parse here.
pub fn bootstrap_multiaddrs() -> Vec<Multiaddr> {
    BOOTSTRAP_NODES
        .iter()
        .filter_map(|s| match s.parse::<Multiaddr>() {
            Ok(addr) => Some(addr),
            Err(e) => {
                log::debug!(
                    target: "concord::servitude::bootstrap",
                    "skipping malformed bootstrap multiaddr {s:?}: {e}"
                );
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hardcoded list must be non-empty — a release with zero
    /// bootstrap nodes would mean fresh installs never find any peer.
    #[test]
    fn bootstrap_list_is_non_empty() {
        assert!(
            !BOOTSTRAP_NODES.is_empty(),
            "BOOTSTRAP_NODES must contain at least one entry"
        );
    }

    /// Placeholder strings must at least be syntactically valid
    /// multiaddrs even if the PeerIds aren't real. If a developer
    /// pastes a bad address here, this test surfaces it loudly rather
    /// than letting `bootstrap_multiaddrs()` silently drop it.
    #[test]
    fn every_hardcoded_entry_parses() {
        for s in BOOTSTRAP_NODES {
            let parsed: Result<Multiaddr, _> = s.parse();
            assert!(
                parsed.is_ok(),
                "bootstrap entry {s:?} must parse as a Multiaddr (got error: {:?})",
                parsed.err()
            );
        }
    }

    /// `bootstrap_multiaddrs()` returns one entry per parseable string
    /// when all entries are well-formed.
    #[test]
    fn bootstrap_multiaddrs_returns_all_parsed_entries() {
        let addrs = bootstrap_multiaddrs();
        assert_eq!(addrs.len(), BOOTSTRAP_NODES.len());
    }
}
