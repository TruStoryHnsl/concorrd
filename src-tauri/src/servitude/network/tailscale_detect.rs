//! F-C — Tailscale connectivity detection for hero-sync gating.
//!
//! Architecture C (`docs/architecture/tailscale-gated-hero-sync-scope.md`)
//! gates hero-mediated sync on a two-gate precondition: (i) the peer
//! shares the local install's hero account, AND (ii) the peer is
//! reachable through Tailscale (or an equivalent mesh-VPN). This module
//! implements gate (ii).
//!
//! The check is two-sided. A connection is "on the tailnet" iff:
//!
//!   1. At least one of the peer's advertised libp2p multiaddrs carries
//!      an IP inside Tailscale's CGNAT range (`100.64.0.0/10`). The CGNAT
//!      range is reserved by RFC 6598 and IS NOT routed on the public
//!      internet, so an IP there is strong evidence the peer is reachable
//!      via a Tailscale daemon (or an equivalent CGNAT-aware mesh).
//!   2. AND the local install also has a Tailscale-shaped interface
//!      bound to an address inside that CGNAT range. Without a local
//!      tailnet binding, the local install cannot reach a tailnet peer
//!      even if the peer advertises a tailnet address — so we refuse to
//!      classify the connection as "tailscale-verified."
//!
//! ## Why the dual-sided check
//!
//! A single-sided check ("the peer advertises a CGNAT IP") would let a
//! malicious peer spoof tailnet reachability by advertising a
//! `100.x.x.x` multiaddr that's actually unreachable. By requiring BOTH
//! sides to carry CGNAT bindings, we guarantee the routing path is
//! plausible. The actual libp2p connection establishment then provides
//! the cryptographic guarantee that the peer at the CGNAT IP is the one
//! we expect (libp2p PeerId authentication, separate concern).
//!
//! ## Relationship to `tunnel_detect`
//!
//! `tunnel_detect.rs` enumerates ALL tunnel-shaped interfaces (WireGuard,
//! Tailscale, generic `tun*`/`tap*`) and is used by the Phase G inbound
//! gate. This module is narrower: it answers ONLY "is this peer reachable
//! over Tailscale," using the CGNAT range as the load-bearing signal.
//! The two modules deliberately overlap on the interface-probe step
//! (both call `getifaddrs` on Linux/macOS) but answer different
//! questions. `tunnel_detect` says "is this IP on a trusted tunnel";
//! this module says "is this peer on the tailnet specifically."
//!
//! ## Platform support
//!
//! Linux + macOS: real interface probe via `libc::getifaddrs`. Identical
//! mechanism to `tunnel_detect`'s probe but filters strictly to CGNAT
//! IPs.
//!
//! Windows + iOS + fallback: returns the empty set. The gate is
//! permissive on those targets — Architecture C is documented as
//! desktop-first (Linux/macOS hosts the docker anchor and the daily
//! drivers); Windows is a follow-up once `windows-sys::GetAdaptersAddresses`
//! is wired (same TODO as `tunnel_detect`). iOS is structurally blocked
//! by the sandbox (see `tunnel_detect.rs` module docs).

use std::net::Ipv4Addr;

use ipnet::{IpNet, Ipv4Net};
use libp2p::Multiaddr;

/// Tailscale's CGNAT range. Reserved by RFC 6598 ("Carrier-Grade NAT
/// IP space") and NOT routable on the public internet. Tailscale picks
/// every tailnet IP from this range; mesh-VPN forks that target
/// Tailscale compatibility (Headscale, etc.) honor the same allocation.
pub const TAILSCALE_CGNAT_V4: &str = "100.64.0.0/10";

/// Heuristic interface-name prefixes that look like Tailscale.
///
/// - `tailscale*` — Linux's standard name when Tailscale's daemon is
///   running directly (e.g. `tailscale0`).
/// - `utun*` — macOS uses `utun<N>` for every userspace tunnel; the CGNAT
///   address binding is the load-bearing signal there (any `utun` could
///   in principle be a WireGuard or VPN, not Tailscale).
///
/// We do NOT match `wg*` here: a WireGuard tunnel that doesn't carry a
/// CGNAT-range address is not part of the tailnet. The CGNAT-address
/// test is the strict authority; the name match is only a hint for
/// inspection paths that walk per-interface lists.
pub const TAILSCALE_NAME_PREFIXES: &[&str] = &["tailscale", "utun"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// `true` iff (i) at least one of the supplied peer multiaddrs carries a
/// CGNAT-range IP AND (ii) the local install also has a tailnet address.
///
/// This is the **gate (ii)** check from Architecture C. Pair with the
/// hero-match gate (see [`super::super::hero_binding`]) to gate
/// `/concord/hero-sync/1.0.0` rounds.
pub fn is_tailscale_peer(peer_multiaddrs: &[Multiaddr]) -> bool {
    if !any_multiaddr_in_cgnat(peer_multiaddrs) {
        return false;
    }
    if !local_install_has_tailscale_binding() {
        return false;
    }
    true
}

/// Local install's Tailscale-bound multiaddrs.
///
/// Returns every CGNAT-range IPv4 address bound to a local interface,
/// rendered as bare `/ip4/<addr>` multiaddrs (no port — callers append
/// the relevant transport leg). This is used by paths that need to know
/// "what addresses can I advertise to a tailnet peer so they can dial me
/// back" — e.g. the peer-store reciprocal-pairing hint that prefers
/// tailnet over public IPs.
///
/// Empty on platforms where the interface probe is a no-op (Windows,
/// iOS) — these targets are documented as Architecture C follow-ups.
pub fn local_tailscale_addrs() -> Vec<Multiaddr> {
    let mut out = Vec::new();
    for ip in local_tailscale_ips() {
        // libp2p::Multiaddr's display format is the canonical way to
        // build one from a typed IP — no allocation of an intermediate
        // string buffer.
        let addr: Multiaddr = format!("/ip4/{}", ip)
            .parse()
            .expect("/ip4/<ipv4> is a valid multiaddr");
        out.push(addr);
    }
    out
}

/// Every CGNAT-range IP currently bound to a local interface. Pulled
/// out as a stand-alone function so the two-gate evaluator and the
/// address-list path share the same enumeration.
pub fn local_tailscale_ips() -> Vec<Ipv4Addr> {
    let cgnat = cgnat_net();
    let mut out = Vec::new();
    for ip in probe_local_ipv4_addrs() {
        if cgnat.contains(&ip) && !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

/// `true` iff the local install has at least one Tailscale-shaped
/// binding. Exposed so callers that already know the peer multiaddrs
/// don't need to re-walk the interface table.
pub fn local_install_has_tailscale_binding() -> bool {
    !local_tailscale_ips().is_empty()
}

/// `true` iff any of the supplied multiaddrs carries a CGNAT-range IP.
/// This is the peer-side half of the two-gate check.
pub fn any_multiaddr_in_cgnat(addrs: &[Multiaddr]) -> bool {
    let cgnat = cgnat_net();
    for addr in addrs {
        if let Some(ip) = extract_ipv4(addr) {
            if cgnat.contains(&ip) {
                return true;
            }
        }
    }
    false
}

/// Snapshot of the two-gate state. The fields are independently
/// addressable so the React side can render a precise gate-failure
/// diagnostic (e.g. "peer is on tailnet but you're not" vs "you're on
/// tailnet but the peer isn't"). Used by the test harness too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailscaleGateSnapshot {
    /// At least one peer multiaddr advertised a CGNAT-range IP.
    pub peer_in_cgnat: bool,
    /// The local install has at least one CGNAT-range IP bound.
    pub local_in_cgnat: bool,
}

impl TailscaleGateSnapshot {
    /// `true` iff BOTH halves of the gate passed.
    pub fn passes(&self) -> bool {
        self.peer_in_cgnat && self.local_in_cgnat
    }

    /// Evaluate the gate for a given peer's advertised multiaddrs.
    /// Probes the local interface table once.
    pub fn evaluate(peer_multiaddrs: &[Multiaddr]) -> Self {
        Self {
            peer_in_cgnat: any_multiaddr_in_cgnat(peer_multiaddrs),
            local_in_cgnat: local_install_has_tailscale_binding(),
        }
    }
}

// ---------------------------------------------------------------------------
// Internals — CGNAT helpers + multiaddr parsing.
// ---------------------------------------------------------------------------

fn cgnat_net() -> Ipv4Net {
    // 100.64.0.0/10 is the canonical CGNAT range. parse() can't fail on a
    // literal; using ::new() lets us avoid the `unwrap` on a typo path.
    Ipv4Net::new(Ipv4Addr::new(100, 64, 0, 0), 10)
        .expect("100.64.0.0/10 is a valid Ipv4Net")
}

/// Walk a libp2p multiaddr and return the first `/ip4/...` component,
/// if any. The CGNAT range is IPv4-only — we deliberately don't probe
/// IPv6 multiaddrs here. (Tailscale assigns IPv6 too, but a peer that
/// only advertises an IPv6 multiaddr is being routed through a different
/// gate; this check is conservative.)
fn extract_ipv4(addr: &Multiaddr) -> Option<Ipv4Addr> {
    use libp2p::core::multiaddr::Protocol;
    for proto in addr.iter() {
        if let Protocol::Ip4(ip) = proto {
            return Some(ip);
        }
    }
    None
}

/// Re-export of the CGNAT range as a generic `IpNet`, for callers that
/// want to compose it with other reachability rules.
pub fn tailscale_cgnat_cidr() -> IpNet {
    IpNet::V4(cgnat_net())
}

// ---------------------------------------------------------------------------
// Platform-specific interface probe.
//
// The probe is intentionally separate from `tunnel_detect.rs`'s probe
// so the two answer different questions:
//
//   * `tunnel_detect` — "is this IP inside ANY tunnel-shaped interface
//     I trust" (broad allow-list, includes operator extras).
//   * here          — "is this IP specifically inside the Tailscale
//     CGNAT range" (narrow, hard-coded prefix).
//
// We share the syscall on Linux/macOS via the same `libc::getifaddrs`
// dance but filter strictly. The fn is overridable by tests via
// `PROBE_OVERRIDE` so the harness can simulate "no Tailscale here"
// without unmounting the host's actual tailnet.
// ---------------------------------------------------------------------------

thread_local! {
    /// Test-only override. When set, [`probe_local_ipv4_addrs`] returns
    /// this slice instead of probing the kernel. Cleared on drop.
    /// Crate-visible (NOT `#[cfg(test)]`) so the sibling integration
    /// test harness (`tests/hero_sync_test.rs`) can install one too:
    /// `cfg(test)` only applies to the crate-under-test's own unit
    /// tests, not to integration tests in `tests/` which build as a
    /// separate crate and see only `cfg(test)` on themselves.
    ///
    /// Production code does NOT touch this thread-local — the default
    /// is `None`, the production path falls straight through to the
    /// platform probe.
    #[doc(hidden)]
    pub static PROBE_OVERRIDE: std::cell::RefCell<Option<Vec<Ipv4Addr>>> =
        const { std::cell::RefCell::new(None) };
}

fn probe_local_ipv4_addrs() -> Vec<Ipv4Addr> {
    let override_taken = PROBE_OVERRIDE.with(|cell| cell.borrow().clone());
    if let Some(addrs) = override_taken {
        return addrs;
    }
    platform_probe_local_ipv4_addrs()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn platform_probe_local_ipv4_addrs() -> Vec<Ipv4Addr> {
    use std::ffi::CStr;
    use std::os::raw::c_int;

    let mut out: Vec<Ipv4Addr> = Vec::new();
    // SAFETY: getifaddrs is the canonical libc API for enumerating
    // interface addresses. We walk the linked list, copy the IPv4
    // bytes, and call freeifaddrs at the end. The dance mirrors
    // `tunnel_detect::getifaddrs_for_iface` but filters by address
    // family + CGNAT containment (not by interface name).
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        let rc: c_int = libc::getifaddrs(&mut head);
        if rc != 0 || head.is_null() {
            return out;
        }
        let mut cur = head;
        while !cur.is_null() {
            let ifa = &*cur;
            if !ifa.ifa_addr.is_null() {
                let family = (*ifa.ifa_addr).sa_family as c_int;
                if family == libc::AF_INET {
                    let sa = ifa.ifa_addr as *const libc::sockaddr_in;
                    let raw = u32::from_be((*sa).sin_addr.s_addr);
                    let ip = Ipv4Addr::from(raw);
                    // Capture the iface name for an optional hint —
                    // not load-bearing for the gate (CGNAT containment
                    // is the authority), but useful for diagnostics.
                    let _name = if !ifa.ifa_name.is_null() {
                        CStr::from_ptr(ifa.ifa_name)
                            .to_str()
                            .unwrap_or("")
                            .to_string()
                    } else {
                        String::new()
                    };
                    if !out.contains(&ip) {
                        out.push(ip);
                    }
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_probe_local_ipv4_addrs() -> Vec<Ipv4Addr> {
    // Windows / iOS / fallback — Architecture C follow-up. The two-gate
    // evaluator returns "no tailnet" on these targets, which means the
    // hero-sync trigger never fires from them. That matches the
    // documented constraint that the docker anchor + daily drivers are
    // Linux/macOS for now.
    Vec::new()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    /// Helper: install a probe override for the duration of `body`.
    /// Ensures the thread-local is cleared even on panic.
    fn with_probe_override<R>(addrs: Vec<Ipv4Addr>, body: impl FnOnce() -> R) -> R {
        PROBE_OVERRIDE.with(|cell| *cell.borrow_mut() = Some(addrs));
        let r = body();
        PROBE_OVERRIDE.with(|cell| *cell.borrow_mut() = None);
        r
    }

    fn ma(s: &str) -> Multiaddr {
        s.parse().expect("multiaddr parse")
    }

    #[test]
    fn cgnat_range_pins_to_100_64_slash_10() {
        let net: IpNet = TAILSCALE_CGNAT_V4.parse().expect("cidr");
        assert!(net.contains(&IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(net.contains(&IpAddr::V4(Ipv4Addr::new(100, 127, 255, 254))));
        // Just outside the range — public internet.
        assert!(!net.contains(&IpAddr::V4(Ipv4Addr::new(100, 128, 0, 0))));
        // The /16 RFC1918 private range — distinct from CGNAT.
        assert!(!net.contains(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
    }

    #[test]
    fn peer_multiaddr_in_cgnat_is_detected() {
        let addrs = vec![
            ma("/ip4/100.78.87.5/tcp/4001"),
            ma("/ip4/192.168.1.123/tcp/4001"),
        ];
        assert!(any_multiaddr_in_cgnat(&addrs));
    }

    #[test]
    fn peer_multiaddr_outside_cgnat_is_rejected() {
        let addrs = vec![
            ma("/ip4/192.168.1.123/tcp/4001"),
            ma("/ip4/8.8.8.8/tcp/4001"),
        ];
        assert!(!any_multiaddr_in_cgnat(&addrs));
    }

    #[test]
    fn peer_no_multiaddrs_is_rejected() {
        assert!(!any_multiaddr_in_cgnat(&[]));
    }

    #[test]
    fn local_tailscale_ips_filter_strictly_to_cgnat() {
        // Simulate an install with one tailnet IP + one LAN IP.
        with_probe_override(
            vec![
                Ipv4Addr::new(100, 78, 87, 5),   // CGNAT — keep
                Ipv4Addr::new(192, 168, 1, 152), // LAN  — drop
                Ipv4Addr::new(127, 0, 0, 1),     // lo   — drop
            ],
            || {
                let local = local_tailscale_ips();
                assert_eq!(local, vec![Ipv4Addr::new(100, 78, 87, 5)]);
            },
        );
    }

    #[test]
    fn local_tailscale_ips_empty_when_no_cgnat_binding() {
        with_probe_override(
            vec![
                Ipv4Addr::new(192, 168, 1, 152),
                Ipv4Addr::new(127, 0, 0, 1),
            ],
            || {
                assert!(local_tailscale_ips().is_empty());
                assert!(!local_install_has_tailscale_binding());
            },
        );
    }

    #[test]
    fn local_tailscale_addrs_render_multiaddr_strings() {
        with_probe_override(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
            let addrs = local_tailscale_addrs();
            assert_eq!(addrs.len(), 1);
            assert_eq!(addrs[0].to_string(), "/ip4/100.78.87.5");
        });
    }

    #[test]
    fn two_gate_both_pass_when_both_sides_on_tailnet() {
        let peer = vec![ma("/ip4/100.78.87.6/tcp/4001")];
        with_probe_override(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
            let snap = TailscaleGateSnapshot::evaluate(&peer);
            assert!(snap.peer_in_cgnat);
            assert!(snap.local_in_cgnat);
            assert!(snap.passes());
            assert!(is_tailscale_peer(&peer));
        });
    }

    #[test]
    fn two_gate_fails_when_only_peer_on_tailnet() {
        let peer = vec![ma("/ip4/100.78.87.6/tcp/4001")];
        with_probe_override(vec![Ipv4Addr::new(192, 168, 1, 152)], || {
            let snap = TailscaleGateSnapshot::evaluate(&peer);
            assert!(snap.peer_in_cgnat);
            assert!(!snap.local_in_cgnat);
            assert!(!snap.passes());
            assert!(!is_tailscale_peer(&peer));
        });
    }

    #[test]
    fn two_gate_fails_when_only_local_on_tailnet() {
        let peer = vec![ma("/ip4/192.168.1.123/tcp/4001")];
        with_probe_override(vec![Ipv4Addr::new(100, 78, 87, 5)], || {
            let snap = TailscaleGateSnapshot::evaluate(&peer);
            assert!(!snap.peer_in_cgnat);
            assert!(snap.local_in_cgnat);
            assert!(!snap.passes());
            assert!(!is_tailscale_peer(&peer));
        });
    }

    #[test]
    fn two_gate_fails_when_neither_side_on_tailnet() {
        let peer = vec![ma("/ip4/192.168.1.123/tcp/4001")];
        with_probe_override(vec![Ipv4Addr::new(192, 168, 1, 152)], || {
            let snap = TailscaleGateSnapshot::evaluate(&peer);
            assert!(!snap.peer_in_cgnat);
            assert!(!snap.local_in_cgnat);
            assert!(!snap.passes());
            assert!(!is_tailscale_peer(&peer));
        });
    }

    #[test]
    fn extract_ipv4_handles_dnsaddr_multiaddr() {
        // /dnsaddr/... multiaddrs do NOT carry a /ip4/ component until
        // resolved; we must report None instead of guessing.
        let addr = ma("/dnsaddr/concord.example/tcp/4001");
        assert!(extract_ipv4(&addr).is_none());
    }

    #[test]
    fn extract_ipv4_picks_first_when_multiple() {
        // Synthesize a multiaddr with an IPv4 followed by something
        // else — confirm the first one wins. (libp2p multiaddrs can
        // chain protocols; the first ip4 is canonical.)
        let addr = ma("/ip4/100.64.1.2/tcp/4001/p2p/12D3KooWBhV9YJG3qZ8e3Q8Z2N8X8KQzL5fkD5Q5sEgUbZxQv5sM");
        assert_eq!(extract_ipv4(&addr), Some(Ipv4Addr::new(100, 64, 1, 2)));
    }
}
