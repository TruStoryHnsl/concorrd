//! Phase G — tunnel-only inbound hardening: detector + config tests.
//!
//! Pure-logic tests for the network::tunnel_* modules. The connection
//! gate is exercised separately in `tunnel_gate_test.rs` (two-swarm
//! harness). Both files map 1:1 to design-doc acceptance criteria.
//!
//! Cold-reader perspective: every assertion is what an outside
//! observer can verify against the public surface — config persists
//! and reloads bit-for-bit, IP-in-CIDR is a pure-function check,
//! loopback is unconditionally trusted (the load-bearing test that
//! keeps the existing p2p_test harness green).

use std::net::{IpAddr, Ipv4Addr};

use app_lib::servitude::network::{TunnelConfig, TunnelInterfaces};
use ipnet::IpNet;
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// (1) tunnel_config_round_trip_to_disk
//     Save a non-default config, reload it, assert byte-for-byte
//     equality.
// ---------------------------------------------------------------------------

#[test]
fn tunnel_config_round_trip_to_disk() {
    let dir = tempdir().expect("tmp");
    let original = TunnelConfig {
        enforce: true,
        extra_cidrs: vec![
            "10.42.0.0/16".to_string(),
            "192.168.7.0/24".to_string(),
            "fd00::/8".to_string(),
        ],
    };
    original.save(dir.path()).expect("save");
    let reloaded = TunnelConfig::load(dir.path()).expect("load");
    assert_eq!(reloaded, original, "tunnel_config round-trip mismatch");

    // The file lives at the documented path so external tools (the
    // user's editor, a backup pipeline) can locate it predictably.
    let path = TunnelConfig::path_in(dir.path());
    assert!(path.exists(), "tunnel_config.json should be at the documented sibling path");
    assert!(
        path.to_string_lossy().ends_with("tunnel_config.json"),
        "expected path to end in tunnel_config.json, got {path:?}"
    );
}

// ---------------------------------------------------------------------------
// (2) is_tunnel_ip_matches_extra_cidr
//     TunnelInterfaces seeded ONLY with `extra_cidrs = [10.42.0.0/16]`
//     matches every IP inside that block AND rejects a public IP.
// ---------------------------------------------------------------------------

#[test]
fn is_tunnel_ip_matches_extra_cidr() {
    let extra: IpNet = "10.42.0.0/16".parse().expect("cidr");
    let ti = TunnelInterfaces::detect(&[extra]);

    assert!(ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(10, 42, 1, 1))));
    assert!(ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(10, 42, 255, 255))));
    assert!(ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(10, 42, 0, 0))));
    // Just outside the block.
    assert!(!ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(10, 43, 0, 1))));
    // Famously a non-tunnel IP.
    assert!(!ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
}

// ---------------------------------------------------------------------------
// (3) is_tunnel_ip_with_no_extras_still_trusts_loopback
//     The detector trusts loopback unconditionally. This is
//     load-bearing for the existing p2p_test two-swarm harness, which
//     dials loopback — if loopback weren't trusted, turning on
//     enforce in tests would deadlock the harness.
// ---------------------------------------------------------------------------

#[test]
fn is_tunnel_ip_with_no_extras_still_trusts_loopback() {
    let ti = TunnelInterfaces::detect(&[]);
    assert!(
        ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        "loopback must be trusted with no extras — required so existing \
         two-swarm tests keep working under enforce=true"
    );
    // A public IP is NOT trusted by default — operator must supply
    // it explicitly via the extras list.
    assert!(!ti.is_tunnel_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
}

// ---------------------------------------------------------------------------
// (4) auto_detect_includes_loopback_in_report
//     Detector → report() partition: loopback shows up in the
//     auto-detected list (it's not an operator extra) and the
//     effective list contains it too.
// ---------------------------------------------------------------------------

#[test]
fn auto_detect_includes_loopback_in_report() {
    let extra: IpNet = "10.42.0.0/16".parse().expect("cidr");
    let ti = TunnelInterfaces::detect(&[extra]);
    let report = ti.report(true, &[extra]);

    // Loopback is auto-detected.
    assert!(
        report.auto_detected_cidrs.iter().any(|s| s == "127.0.0.0/8"),
        "expected 127.0.0.0/8 in auto_detected_cidrs, got: {:?}",
        report.auto_detected_cidrs
    );
    // The operator extra is in effective but NOT in auto.
    assert!(report.effective_cidrs.iter().any(|s| s == "10.42.0.0/16"));
    assert!(!report
        .auto_detected_cidrs
        .iter()
        .any(|s| s == "10.42.0.0/16"));
    assert!(report.enforce_active);
}

// ---------------------------------------------------------------------------
// (5) tunnel_config_default_is_off
//     First-boot posture is `enforce = false` so an upgrading user
//     doesn't suddenly lose connectivity. The Settings UI is what
//     flips the bit.
// ---------------------------------------------------------------------------

#[test]
fn tunnel_config_default_is_off() {
    let dir = tempdir().expect("tmp");
    let cfg = TunnelConfig::load(dir.path()).expect("load");
    assert!(
        !cfg.enforce,
        "first-boot default MUST be enforce=off — upgrading users shouldn't \
         lose connectivity on Phase G upgrade"
    );
    assert!(cfg.extra_cidrs.is_empty());
}
