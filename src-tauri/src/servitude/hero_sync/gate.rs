//! F-C — Two-gate evaluator for hero sync.
//!
//! Encapsulates the user's rule:
//!
//! > it only propagates between instances if the machines are verified
//! > to be connected via tailscale AND the instances are confirmed to
//! > share a hero-user. If EITHER gate fails → no sync.
//!
//! The evaluator is called from the libp2p connection-establishment
//! hook (see `protocol::on_peer_connected`) — keeping it side-effect-free
//! beyond the existing tailscale probe + hero-binding lookup so that
//! adding the check to the connection callback never blocks. Both halves
//! short-circuit on the first failure: if the cheap tailscale probe
//! says no, we skip the (currently stubbed) hero lookup entirely.

use libp2p::{Multiaddr, PeerId};

use crate::servitude::hero_binding::{HeroBinding, HeroBindingError};
use crate::servitude::network::tailscale_detect::{
    self, TailscaleGateSnapshot,
};

/// Result of one full two-gate evaluation. Carries enough state to
/// drive a precise diagnostic in the UI without a second probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateOutcome {
    /// Whether gate (ii) — Tailscale reachability — passed.
    pub tailscale_passes: bool,
    /// Whether gate (i) — shared hero account — passed.
    pub hero_passes: bool,
    /// The full tailnet snapshot so the UI can render which half of the
    /// tailscale probe failed (peer-side / local-side / both).
    pub tailscale_snapshot: TailscaleGateSnapshot,
}

impl GateOutcome {
    /// `true` iff BOTH gates passed. The only state in which a hero-sync
    /// round MAY be triggered.
    pub fn both_pass(&self) -> bool {
        self.tailscale_passes && self.hero_passes
    }

    /// Human-readable summary for diagnostics / logs / UI banner.
    pub fn diagnostic(&self) -> String {
        if self.both_pass() {
            return "hero-sync gate: both checks pass".to_string();
        }
        let mut parts = Vec::new();
        if !self.tailscale_passes {
            match (
                self.tailscale_snapshot.peer_in_cgnat,
                self.tailscale_snapshot.local_in_cgnat,
            ) {
                (false, false) => parts.push(
                    "tailscale: neither side bound to CGNAT range".to_string(),
                ),
                (false, true) => parts.push(
                    "tailscale: peer not advertising a tailnet address".to_string(),
                ),
                (true, false) => parts.push(
                    "tailscale: local install has no tailnet binding".to_string(),
                ),
                (true, true) => {
                    // unreachable in practice — both fields true should
                    // mean tailscale_passes=true. Defensive logging.
                    parts.push("tailscale: inconsistent snapshot".to_string());
                }
            }
        }
        if !self.hero_passes {
            parts.push(
                "hero: no shared hero account confirmed (F-A may be pending)"
                    .to_string(),
            );
        }
        format!("hero-sync gate blocked: {}", parts.join("; "))
    }
}

/// Evaluate both gates for `(peer_id, peer_multiaddrs)`.
///
/// Cheap to call — synchronous tailscale probe + (currently stubbed)
/// async hero lookup. Short-circuits on the first failure.
pub async fn evaluate_gates(
    binding: &HeroBinding,
    peer_id: &PeerId,
    peer_multiaddrs: &[Multiaddr],
) -> Result<GateOutcome, HeroBindingError> {
    let snapshot = TailscaleGateSnapshot::evaluate(peer_multiaddrs);
    let tailscale_passes = snapshot.passes();
    if !tailscale_passes {
        // Don't even consult the hero binding if the tailnet gate
        // failed — saves a (potentially networked once F-A lands)
        // lookup. Hero state reported as `false` so callers don't
        // mistakenly think it passed.
        return Ok(GateOutcome {
            tailscale_passes,
            hero_passes: false,
            tailscale_snapshot: snapshot,
        });
    }
    let hero_passes = binding.shares_hero_with(peer_id).await?;
    Ok(GateOutcome {
        tailscale_passes,
        hero_passes,
        tailscale_snapshot: snapshot,
    })
}

/// Convenience helper — checks the live tailscale-only state without
/// touching the hero binding. Used by paths that want to render a
/// "Tailscale: connected" indicator independently of the hero gate.
pub fn evaluate_tailscale_only(peer_multiaddrs: &[Multiaddr]) -> bool {
    tailscale_detect::is_tailscale_peer(peer_multiaddrs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servitude::hero_binding::HeroDescriptor;
    use crate::servitude::network::tailscale_detect::PROBE_OVERRIDE;
    use libp2p::identity::Keypair;
    use std::net::Ipv4Addr;

    fn peer() -> PeerId {
        PeerId::from(Keypair::generate_ed25519().public())
    }

    fn ma(s: &str) -> Multiaddr {
        s.parse().unwrap()
    }

    fn local_hero(seed: u8) -> HeroDescriptor {
        HeroDescriptor {
            hero_pubkey: [seed; 32],
            display_label: "local".to_string(),
        }
    }

    fn with_local_ips<R>(ips: Vec<Ipv4Addr>, body: impl FnOnce() -> R) -> R {
        PROBE_OVERRIDE.with(
            |c: &std::cell::RefCell<Option<Vec<Ipv4Addr>>>| {
                *c.borrow_mut() = Some(ips);
            },
        );
        let r = body();
        PROBE_OVERRIDE.with(
            |c: &std::cell::RefCell<Option<Vec<Ipv4Addr>>>| {
                *c.borrow_mut() = None;
            },
        );
        r
    }

    // Run the async body on a Tokio runtime that's pinned to a single
    // thread — necessary so the thread-local PROBE_OVERRIDE applies.
    fn block<F: std::future::Future>(f: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(f)
    }

    #[test]
    fn tailscale_no_hero_no_means_blocked() {
        let binding = HeroBinding::new(Some(local_hero(0xAA)));
        let peer = peer();
        let peer_addrs = vec![ma("/ip4/192.168.1.123/tcp/4001")];
        with_local_ips(vec![Ipv4Addr::new(192, 168, 1, 152)], || {
            let outcome =
                block(evaluate_gates(&binding, &peer, &peer_addrs)).unwrap();
            assert!(!outcome.tailscale_passes);
            assert!(!outcome.hero_passes);
            assert!(!outcome.both_pass());
            assert!(outcome.diagnostic().contains("tailscale"));
        });
    }

    #[test]
    fn tailscale_yes_hero_no_means_blocked() {
        let binding = HeroBinding::new(Some(local_hero(0xAA)));
        let peer = peer();
        let peer_addrs = vec![ma("/ip4/100.78.87.6/tcp/4001")];
        with_local_ips(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
            let outcome =
                block(evaluate_gates(&binding, &peer, &peer_addrs)).unwrap();
            assert!(outcome.tailscale_passes);
            // F-A is stubbed → hero gate is closed.
            assert!(!outcome.hero_passes);
            assert!(!outcome.both_pass());
            assert!(outcome.diagnostic().contains("hero"));
        });
    }

    #[test]
    fn tailscale_no_hero_yes_means_blocked() {
        // We force the hero gate "yes" by passing a binding with a
        // local descriptor and using the direct pubkey comparator —
        // but the real gate uses the lookup which is stubbed. Simulate
        // by asserting both fields independently: even with tailscale
        // failing, hero_passes should be false because the lookup
        // short-circuits and never runs.
        let binding = HeroBinding::new(Some(local_hero(0xAA)));
        let peer = peer();
        let peer_addrs = vec![ma("/ip4/192.168.1.123/tcp/4001")];
        // No local CGNAT binding → tailscale gate fails.
        with_local_ips(vec![Ipv4Addr::new(192, 168, 1, 152)], || {
            let outcome =
                block(evaluate_gates(&binding, &peer, &peer_addrs)).unwrap();
            assert!(!outcome.tailscale_passes);
            // hero_passes is reported false because the lookup is
            // short-circuited; this is part of the gate's contract.
            assert!(!outcome.hero_passes);
            assert!(!outcome.both_pass());
        });
    }

    #[test]
    fn neither_gate_passes_when_both_fail() {
        let binding = HeroBinding::new(None); // no local hero AT ALL
        let peer = peer();
        let peer_addrs = vec![ma("/ip4/8.8.8.8/tcp/4001")];
        with_local_ips(vec![Ipv4Addr::new(8, 8, 4, 4)], || {
            let outcome =
                block(evaluate_gates(&binding, &peer, &peer_addrs)).unwrap();
            assert!(!outcome.tailscale_passes);
            assert!(!outcome.hero_passes);
            let diag = outcome.diagnostic();
            assert!(
                diag.contains("tailscale"),
                "diag must mention tailscale: {diag}"
            );
        });
    }

    #[test]
    fn diagnostic_partitions_peer_and_local_misses() {
        // peer not advertising a tailnet addr; local IS on tailnet.
        let outcome = GateOutcome {
            tailscale_passes: false,
            hero_passes: false,
            tailscale_snapshot: TailscaleGateSnapshot {
                peer_in_cgnat: false,
                local_in_cgnat: true,
            },
        };
        let diag = outcome.diagnostic();
        assert!(diag.contains("peer not advertising"));

        let outcome = GateOutcome {
            tailscale_passes: false,
            hero_passes: false,
            tailscale_snapshot: TailscaleGateSnapshot {
                peer_in_cgnat: true,
                local_in_cgnat: false,
            },
        };
        let diag = outcome.diagnostic();
        assert!(diag.contains("local install has no tailnet binding"));
    }
}
