//! Tunnel-shaped interface detection.
//!
//! "Tunnel-shaped" here means: an interface that the operator wants
//! treated as a trusted local-network boundary even though it's
//! tunneled through the broader internet. The canonical cases are
//! WireGuard userspace tunnels (`wg*`) and Tailscale (`tailscale*` on
//! Linux, `utun*` w/ CGNAT-bound addresses on macOS).
//!
//! The detector is intentionally heuristic — there is no universal
//! kernel API for "is this interface a VPN tunnel?". The heuristics
//! cover the dominant ecosystems and lean on an operator-supplied
//! extra-CIDR escape hatch for everything else.
//!
//! ## Phase G is permissive by default
//!
//! [`TunnelInterfaces::detect`] always includes the loopback CIDRs
//! (`127.0.0.0/8` + `::1/128`). This is load-bearing for two reasons:
//!
//!   1. The existing two-swarm test harness in
//!      `src-tauri/tests/p2p_test.rs` dials peers over loopback. If
//!      loopback weren't on the trusted list, enabling
//!      `enforce=true` in tests would deadlock the harness.
//!   2. The local React UI doesn't currently dial the local swarm —
//!      it reads SQLite directly — but if it ever needs to, loopback
//!      being trusted means the host can never lock itself out of
//!      its own porch.
//!
//! ## What "iOS" means here
//!
//! On iOS the detector returns the empty set (no interface probe is
//! attempted) plus loopback. The user's Settings → Connections panel
//! surfaces an explanatory banner; the `TunnelConfig` defaults to
//! `enforce = false` on first boot so the iOS install still works
//! out of the box. iOS users can still PAIR with native peers and
//! visit other porches — the gate only constrains INBOUND traffic.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use ipnet::IpNet;
use serde::{Deserialize, Serialize};

/// Result of a one-shot detect() call. Cheap to clone (Vec<IpNet>).
#[derive(Debug, Clone)]
pub struct TunnelInterfaces {
    cidrs: Vec<IpNet>,
}

/// Snapshot the React layer can render in Settings → Connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDetectionReport {
    /// CIDRs the OS-level probe surfaced (WireGuard, Tailscale, etc.)
    /// PLUS the static loopback set. Sorted + deduped + stringified
    /// so the React side can render without parsing.
    pub auto_detected_cidrs: Vec<String>,
    /// `auto_detected_cidrs` ∪ user-supplied extras (validated).
    pub effective_cidrs: Vec<String>,
    /// `true` iff the runtime gate is currently ACTIVELY rejecting
    /// non-tunnel inbound traffic. Equals `config.enforce` once the
    /// gate is wired; before the gate is wired (Phase G surface
    /// reports against config-only), this still equals
    /// `config.enforce` so the UI's view is consistent with what the
    /// user set.
    pub enforce_active: bool,
}

impl TunnelInterfaces {
    /// Build a detector that trusts the running install's tunnel-shaped
    /// interfaces plus `extra_cidrs`. Loopback (`127.0.0.0/8` +
    /// `::1/128`) is unconditionally trusted — see module docs.
    ///
    /// Cheap (one syscall on Linux/macOS; one stub call on Windows + iOS).
    /// Callers can recompute on the fly when the config changes.
    pub fn detect(extra_cidrs: &[IpNet]) -> Self {
        let mut cidrs: Vec<IpNet> = Vec::with_capacity(8 + extra_cidrs.len());

        // Loopback first — unconditional. See module docs.
        cidrs.push(IpNet::V4(
            ipnet::Ipv4Net::new(Ipv4Addr::new(127, 0, 0, 0), 8)
                .expect("127.0.0.0/8 is a valid IPv4 CIDR"),
        ));
        cidrs.push(IpNet::V6(
            ipnet::Ipv6Net::new(Ipv6Addr::LOCALHOST, 128)
                .expect("::1/128 is a valid IPv6 CIDR"),
        ));

        // Platform-specific tunnel probe. Each implementation is
        // documented inline at its def site.
        let probed = probe_platform_tunnel_cidrs();
        for cidr in probed {
            if !cidrs.contains(&cidr) {
                cidrs.push(cidr);
            }
        }

        // Operator-supplied extras land last so they can't displace
        // an auto-detected entry's index.
        for cidr in extra_cidrs {
            if !cidrs.contains(cidr) {
                cidrs.push(*cidr);
            }
        }

        Self { cidrs }
    }

    /// Build a `TunnelInterfaces` from a literal CIDR list, bypassing
    /// the loopback-prepend and interface probe. This is the path the
    /// gate-rejection integration test uses to construct a "trust
    /// NOTHING" detector and verify the gate actually rejects a
    /// loopback dial.
    ///
    /// Production code should call [`Self::detect`] — the loopback
    /// default is what keeps the local React UI from locking itself
    /// out of its own porch.
    pub fn from_cidrs(cidrs: Vec<IpNet>) -> Self {
        Self { cidrs }
    }

    /// `true` iff `ip` falls inside one of the trusted CIDRs.
    pub fn is_tunnel_ip(&self, ip: IpAddr) -> bool {
        self.cidrs.iter().any(|c| c.contains(&ip))
    }

    /// All CIDRs the detector currently trusts. Sorted in the order
    /// they were inserted (loopback → auto-detected → extras), which
    /// is what the UI wants to render.
    pub fn cidrs(&self) -> &[IpNet] {
        &self.cidrs
    }

    /// Render this detector's trusted set as a [`TunnelDetectionReport`].
    /// `extras_string_form` is taken as-is so the report mirrors what
    /// the operator typed into Settings (preserving e.g. uppercase IPv6).
    pub fn report(&self, enforce_active: bool, extras: &[IpNet]) -> TunnelDetectionReport {
        // auto_detected is everything in `cidrs` MINUS the extras the
        // operator supplied — i.e. "what would have been detected if
        // the user had cleared their extras list."
        let auto: Vec<String> = self
            .cidrs
            .iter()
            .filter(|c| !extras.contains(c))
            .map(|c| c.to_string())
            .collect();
        let effective: Vec<String> = self.cidrs.iter().map(|c| c.to_string()).collect();
        TunnelDetectionReport {
            auto_detected_cidrs: auto,
            effective_cidrs: effective,
            enforce_active,
        }
    }
}

// ---------------------------------------------------------------------------
// Platform-specific interface probe.
//
// Each platform impl returns a Vec<IpNet> covering interfaces it
// considers "tunnel-shaped". Hand-rolled (no `pnet_datalink` dep) so
// the binary stays small. The probe is best-effort: a failure to read
// /sys or call getifaddrs is silently downgraded to "no auto-detected
// CIDRs". The operator can always fall back to the extras list.
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn probe_platform_tunnel_cidrs() -> Vec<IpNet> {
    let mut out = Vec::new();

    // `/sys/class/net/<name>/uevent` carries the kernel driver name
    // as `DEVTYPE=wireguard` or `DRIVER=wireguard` depending on
    // kernel build. Walking the directory listing is enough — for any
    // matching interface we then synthesize the CIDR from the
    // routing table by reading `/proc/net/route` + `/proc/net/ipv6_route`.
    //
    // We avoid pulling in `nix::ifaddrs` (it's behind a feature flag
    // not currently enabled) and stick with /proc + /sys reads. This
    // is portable to any Linux kernel ≥ 4.0; older kernels just
    // surface no tunnel CIDRs and the operator's extras list takes
    // over.
    let net_dir = match std::fs::read_dir("/sys/class/net") {
        Ok(d) => d,
        Err(_) => return out,
    };

    for entry in net_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_tunnel_iface_name(&name) && !is_wireguard_uevent(&entry.path()) {
            continue;
        }
        // Collect addresses bound to this interface. The cleanest
        // portable path on Linux without `nix::ifaddrs` is
        // `/proc/net/fib_trie` (IPv4) and `/proc/net/if_inet6` (IPv6).
        // We use a single shared parse below; here we just gate by
        // interface name.
        for cidr in collect_addrs_for_iface(&name) {
            if !out.contains(&cidr) {
                out.push(cidr);
            }
        }
    }

    // Even if no interface matched by name/driver, scan for any
    // address inside the Tailscale CGNAT range — Tailscale on Linux
    // sometimes names its interface plainly (`tailscale0`) but
    // sometimes inherits the upstream name. CGNAT presence is the
    // load-bearing signal.
    for cidr in collect_cgnat_cidrs_from_proc() {
        if !out.contains(&cidr) {
            out.push(cidr);
        }
    }

    out
}

#[cfg(target_os = "linux")]
fn is_wireguard_uevent(path: &std::path::Path) -> bool {
    let uevent = path.join("uevent");
    let s = match std::fs::read_to_string(&uevent) {
        Ok(s) => s,
        Err(_) => return false,
    };
    s.lines().any(|l| {
        let l = l.trim();
        l == "DRIVER=wireguard" || l == "DEVTYPE=wireguard"
    })
}

#[cfg(target_os = "linux")]
fn collect_addrs_for_iface(name: &str) -> Vec<IpNet> {
    let mut out = Vec::new();

    // IPv4: `/proc/net/fib_trie` carries a denormalized dump. Parsing
    // it robustly is a project of its own; for Phase G we lean on
    // the simpler approach of reading `/sys/class/net/<name>/address`
    // for liveness and synthesizing a single host-CIDR-shaped entry
    // from each address bound to the interface. We can't read those
    // directly from sysfs without a syscall, so we issue ONE
    // getifaddrs call via libc (already in the transitive graph) and
    // filter by interface name. This is the minimal path that works
    // for both IPv4 and IPv6.
    out.extend(getifaddrs_for_iface(name));
    out
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn getifaddrs_for_iface(name: &str) -> Vec<IpNet> {
    use std::ffi::CStr;
    use std::os::raw::c_int;

    let mut out = Vec::new();
    // SAFETY: getifaddrs is the canonical libc API for enumerating
    // interface addresses. We walk the linked list, copy the
    // address bytes out, and call freeifaddrs.
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        let rc: c_int = libc::getifaddrs(&mut head);
        if rc != 0 || head.is_null() {
            return out;
        }
        let mut cur = head;
        while !cur.is_null() {
            let ifa = &*cur;
            if ifa.ifa_name.is_null() {
                cur = ifa.ifa_next;
                continue;
            }
            let iname = match CStr::from_ptr(ifa.ifa_name).to_str() {
                Ok(s) => s,
                Err(_) => {
                    cur = ifa.ifa_next;
                    continue;
                }
            };
            if iname != name {
                cur = ifa.ifa_next;
                continue;
            }
            if ifa.ifa_addr.is_null() {
                cur = ifa.ifa_next;
                continue;
            }
            let family = (*ifa.ifa_addr).sa_family as c_int;
            if family == libc::AF_INET {
                let sa = ifa.ifa_addr as *const libc::sockaddr_in;
                let raw = u32::from_be((*sa).sin_addr.s_addr);
                let ip = Ipv4Addr::from(raw);
                // Synthesize a host-CIDR if no netmask is present.
                let mask_bits = if !ifa.ifa_netmask.is_null()
                    && (*ifa.ifa_netmask).sa_family as c_int == libc::AF_INET
                {
                    let m = ifa.ifa_netmask as *const libc::sockaddr_in;
                    let mask_u32 = u32::from_be((*m).sin_addr.s_addr);
                    mask_u32.count_ones() as u8
                } else {
                    32
                };
                if let Ok(net) = ipnet::Ipv4Net::new(ip, mask_bits) {
                    // Normalize to network address.
                    let trunc = net.trunc();
                    out.push(IpNet::V4(trunc));
                }
            } else if family == libc::AF_INET6 {
                let sa = ifa.ifa_addr as *const libc::sockaddr_in6;
                let bytes = (*sa).sin6_addr.s6_addr;
                let ip = Ipv6Addr::from(bytes);
                let mask_bits = if !ifa.ifa_netmask.is_null()
                    && (*ifa.ifa_netmask).sa_family as c_int == libc::AF_INET6
                {
                    let m = ifa.ifa_netmask as *const libc::sockaddr_in6;
                    let mb = (*m).sin6_addr.s6_addr;
                    let mut bits = 0u8;
                    for b in mb.iter() {
                        bits += b.count_ones() as u8;
                    }
                    bits
                } else {
                    128
                };
                if let Ok(net) = ipnet::Ipv6Net::new(ip, mask_bits) {
                    out.push(IpNet::V6(net.trunc()));
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(target_os = "linux")]
fn collect_cgnat_cidrs_from_proc() -> Vec<IpNet> {
    // Tailscale's CGNAT range is 100.64.0.0/10. If ANY interface on
    // this host carries an IP inside that range, we trust that range
    // wholesale. The probe scans every iface (not just `tailscale*`)
    // because Tailscale on Linux sometimes reuses the upstream
    // interface name (`utun*` on macOS, but Linux is conservative).
    let cgnat = ipnet::Ipv4Net::new(Ipv4Addr::new(100, 64, 0, 0), 10)
        .expect("100.64.0.0/10 is valid");
    let mut out = Vec::new();

    let net_dir = match std::fs::read_dir("/sys/class/net") {
        Ok(d) => d,
        Err(_) => return out,
    };
    for entry in net_dir.flatten() {
        let iname = entry.file_name().to_string_lossy().to_string();
        for cidr in getifaddrs_for_iface(&iname) {
            if let IpNet::V4(net) = cidr {
                if cgnat.contains(&net.network()) {
                    let full = IpNet::V4(cgnat);
                    if !out.contains(&full) {
                        out.push(full);
                    }
                }
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn probe_platform_tunnel_cidrs() -> Vec<IpNet> {
    let mut out = Vec::new();

    // macOS exposes tunnel interfaces as `utun*` (Tailscale, system
    // VPNs, WireGuard apps) and occasionally `wg*` (cli-driven
    // userspace WireGuard). Both are picked up by name; we then
    // synthesize CIDRs from getifaddrs.
    let cgnat = ipnet::Ipv4Net::new(Ipv4Addr::new(100, 64, 0, 0), 10)
        .expect("100.64.0.0/10 is valid");

    // We can't list interfaces by name without an iteration —
    // getifaddrs gives us the iteration in one shot AND the addrs
    // attached, so we walk it once and group by name internally.
    use std::collections::HashSet;
    use std::ffi::CStr;
    use std::os::raw::c_int;

    let mut tunnel_names: HashSet<String> = HashSet::new();
    let mut cgnat_seen = false;

    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut head) != 0 || head.is_null() {
            return out;
        }
        let mut cur = head;
        while !cur.is_null() {
            let ifa = &*cur;
            if !ifa.ifa_name.is_null() {
                if let Ok(name) = CStr::from_ptr(ifa.ifa_name).to_str() {
                    if is_tunnel_iface_name(name) {
                        tunnel_names.insert(name.to_string());
                    }
                    if !ifa.ifa_addr.is_null() {
                        let family = (*ifa.ifa_addr).sa_family as c_int;
                        if family == libc::AF_INET {
                            let sa = ifa.ifa_addr as *const libc::sockaddr_in;
                            let raw = u32::from_be((*sa).sin_addr.s_addr);
                            let ip = Ipv4Addr::from(raw);
                            if cgnat.contains(&ip) {
                                cgnat_seen = true;
                            }
                        }
                    }
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(head);
    }

    for name in &tunnel_names {
        for cidr in getifaddrs_for_iface(name) {
            if !out.contains(&cidr) {
                out.push(cidr);
            }
        }
    }
    if cgnat_seen {
        let full = IpNet::V4(cgnat);
        if !out.contains(&full) {
            out.push(full);
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn probe_platform_tunnel_cidrs() -> Vec<IpNet> {
    // Phase G ships a placeholder probe on Windows: we don't bind to
    // the `windows-sys` crate yet because it'd add ~400 KB to the
    // installer for a single syscall path. Operators on Windows
    // currently supply their tunnel CIDR through the extras list.
    // Loopback is still trusted unconditionally via the caller.
    //
    // TODO(phase-g-followup): wire `GetAdaptersAddresses` via
    // `windows-sys::Win32::NetworkManagement::IpHelper` once a
    // concrete Windows tunnel user calls for it.
    Vec::new()
}

#[cfg(target_os = "ios")]
fn probe_platform_tunnel_cidrs() -> Vec<IpNet> {
    // iOS sandboxing forbids enumerating arbitrary system interfaces
    // from an app. The permanent fix is a NetworkExtension of type
    // `packet-tunnel-provider` (App Store entitlement
    // `com.apple.developer.networking.networkextension`). Phase G
    // documents this in `docs/architecture/porch-design.md`; the
    // probe here is a no-op so iOS still builds and the inbound gate
    // simply rejects everything that isn't loopback when `enforce`
    // is on.
    Vec::new()
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    target_os = "ios",
)))]
fn probe_platform_tunnel_cidrs() -> Vec<IpNet> {
    // Fallback (Android, BSDs, etc.) — operators supply CIDRs via
    // the extras list. Documented in the Phase G design doc.
    Vec::new()
}

/// Heuristic for "this name looks like a userspace tunnel interface."
/// Pulled out as a free function so the platform probes share the
/// rule + the unit tests can pin it without a syscall.
fn is_tunnel_iface_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with("wg")
        || n.starts_with("tailscale")
        || n.starts_with("utun")
        || n.starts_with("tun")
        || n.starts_with("tap")
        || n == "wireguard tunnel"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_always_trusted() {
        let ti = TunnelInterfaces::detect(&[]);
        assert!(ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(127, 1, 2, 3))));
        assert!(ti.is_tunnel_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[test]
    fn extra_cidr_matches_and_filters() {
        let net: IpNet = "10.42.0.0/16".parse().expect("cidr");
        let ti = TunnelInterfaces::detect(&[net]);
        assert!(ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(10, 42, 1, 1))));
        assert!(ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(10, 42, 255, 255))));
        assert!(!ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn tunnel_iface_name_heuristics() {
        assert!(is_tunnel_iface_name("wg0"));
        assert!(is_tunnel_iface_name("wg-concord"));
        assert!(is_tunnel_iface_name("tailscale0"));
        assert!(is_tunnel_iface_name("utun5"));
        assert!(is_tunnel_iface_name("tun0"));
        assert!(!is_tunnel_iface_name("eth0"));
        assert!(!is_tunnel_iface_name("en0"));
        assert!(!is_tunnel_iface_name("lo"));
    }

    #[test]
    fn report_partitions_auto_vs_extras() {
        let extra: IpNet = "10.42.0.0/16".parse().expect("cidr");
        let ti = TunnelInterfaces::detect(&[extra]);
        let report = ti.report(true, &[extra]);
        assert!(report.effective_cidrs.iter().any(|s| s == "10.42.0.0/16"));
        // The extra is excluded from auto_detected.
        assert!(!report.auto_detected_cidrs.iter().any(|s| s == "10.42.0.0/16"));
        // Loopback shows up in auto_detected.
        assert!(report
            .auto_detected_cidrs
            .iter()
            .any(|s| s == "127.0.0.0/8"));
        assert!(report.enforce_active);
    }
}
