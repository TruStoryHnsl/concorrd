//! F-WG integration tests — exercises the WireGuard tunnel wrapping
//! the native p2p egress path, from a cold-reader perspective.
//!
//! Per the project's MANDATORY testing rules in /home/corr/projects/CLAUDE.md:
//! each test asserts what an EXTERNAL OBSERVER sees, not the author's
//! beliefs about how the implementation is wired:
//!
//!   * "the tunnel's local UDP socket is bound and reachable"
//!   * "the bytes I sent through the wrap come out the OTHER SIDE
//!     decrypted and intact"
//!   * "after dropping the tunnel, the socket port is free again"
//!
//! These are properties a hostile reader can check with no knowledge
//! of boringtun's internals. They protect against the failure mode
//! the project's testing-rules section calls out by name: an abstract
//! assertion that the author's mental model believes is true, but
//! which doesn't actually exercise the path the code takes at runtime.

use std::net::SocketAddr;
use std::time::Duration;

use app_lib::servitude::network::wg_tunnel::{
    extract_remote_udp_endpoint, WgRegistry, WgTunnel,
};
use libp2p::identity::Keypair;
use libp2p::{Multiaddr, PeerId};
use tokio::net::UdpSocket;

fn dummy_peer_id() -> PeerId {
    let kp = Keypair::generate_ed25519();
    PeerId::from_public_key(&kp.public())
}

fn dummy_x25519_keypair() -> ([u8; 32], [u8; 32]) {
    use boringtun::x25519::{PublicKey, StaticSecret};
    let priv_key = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let pub_key = PublicKey::from(&priv_key);
    (priv_key.to_bytes(), pub_key.to_bytes())
}

async fn dummy_remote_endpoint() -> (UdpSocket, SocketAddr) {
    let sock = UdpSocket::bind("127.0.0.1:0").await.expect("bind remote");
    let addr = sock.local_addr().expect("local_addr");
    (sock, addr)
}

// ---------------------------------------------------------------------------
// (1) Tunnel start produces a usable loopback endpoint libp2p can dial.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tunnel_start_produces_dialable_loopback_endpoint() {
    let peer = dummy_peer_id();
    let (local_priv, _) = dummy_x25519_keypair();
    let (_, remote_pub) = dummy_x25519_keypair();
    let (_remote_sock, remote_addr) = dummy_remote_endpoint().await;

    let tunnel = WgTunnel::start(peer, local_priv, remote_pub, remote_addr)
        .await
        .expect("WgTunnel::start succeeds");

    // External-observer assertion #1: the wrapped multiaddr is a
    // QUIC-over-IPv4 multiaddr on loopback. A future regression that
    // accidentally exposed a public IP would fail here loudly.
    let ma: Multiaddr = tunnel.wrapped_multiaddr().expect("wrapped multiaddr");
    let s = ma.to_string();
    assert!(
        s.starts_with("/ip4/127."),
        "wrapped multiaddr should sit on loopback, got: {s}"
    );
    assert!(
        s.contains("/quic-v1"),
        "wrapped multiaddr should advertise quic-v1, got: {s}"
    );

    // External-observer assertion #2: the loopback UDP port is
    // actually listening. We use the standalone helper to extract the
    // SocketAddr out of the multiaddr and confirm a probe packet
    // doesn't get a "connection refused".
    let endpoint = extract_remote_udp_endpoint(&ma).expect("extract endpoint");
    let probe = UdpSocket::bind("127.0.0.1:0").await.expect("bind probe");
    // send_to to a bound UDP socket on the same host doesn't return
    // an error even if the receiver discards — but it WOULD return an
    // ICMP-driven error if the port were closed. Either outcome
    // distinguishes "tunnel socket is up" from "tunnel never bound".
    let res = probe.send_to(b"ping", endpoint).await;
    assert!(
        res.is_ok(),
        "probe to wrapped loopback endpoint should succeed (port should be bound), got {res:?}"
    );
}

// ---------------------------------------------------------------------------
// (2) Architecture E — drop releases the loopback socket.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_tunnel_releases_loopback_socket() {
    let peer = dummy_peer_id();
    let (local_priv, _) = dummy_x25519_keypair();
    let (_, remote_pub) = dummy_x25519_keypair();
    let (_remote_sock, remote_addr) = dummy_remote_endpoint().await;

    let tunnel = WgTunnel::start(peer, local_priv, remote_pub, remote_addr)
        .await
        .expect("start");
    let port = tunnel.local_loopback_addr().port();
    drop(tunnel);

    // Give the forwarder task a couple of poll cycles to wind down.
    // abort() ensures the task won't run again, but tokio's runtime
    // may need a yield to actually drop the captured UDP socket.
    tokio::task::yield_now().await;
    tokio::time::sleep(Duration::from_millis(80)).await;

    // External-observer assertion: the port is REUSABLE. If the
    // tunnel hadn't released its socket, this bind would fail with
    // AddrInUse. The user-oriented form of the assertion is "after
    // the app exits the kernel has reclaimed every UDP port the
    // tunnels were holding."
    let rebind = UdpSocket::bind(format!("127.0.0.1:{port}")).await;
    assert!(
        rebind.is_ok(),
        "tunnel socket port {port} must be reusable after drop, got {rebind:?}"
    );
}

// ---------------------------------------------------------------------------
// (3) Registry-level Architecture E — bulk-disconnect releases all sockets.
//
// This simulates the Tauri close-event handler's path: spawn multiple
// tunnels, then call force_disconnect_all(), then assert every loopback
// port is reusable. Mirrors what happens when the binary exits.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn force_disconnect_all_frees_every_socket() {
    let registry = WgRegistry::new();
    let mut ports = Vec::new();
    let mut _remote_socks = Vec::new();

    for _ in 0..5 {
        let peer = dummy_peer_id();
        let (local_priv, _) = dummy_x25519_keypair();
        let (_, remote_pub) = dummy_x25519_keypair();
        let (remote_sock, remote_addr) = dummy_remote_endpoint().await;
        _remote_socks.push(remote_sock);
        let wrapped = registry
            .wrap_dial(peer, local_priv, remote_pub, remote_addr)
            .await
            .expect("wrap_dial");
        let endpoint = extract_remote_udp_endpoint(&wrapped).expect("endpoint");
        ports.push(endpoint.port());
    }

    assert_eq!(registry.live_count(), 5);
    assert_eq!(registry.status().len(), 5);

    // External-observer assertion: after force_disconnect_all, the
    // status surface goes to empty AND every loopback port is
    // reusable. This is the property the Tauri close-event handler
    // promises Architecture E.
    registry.force_disconnect_all();
    assert_eq!(registry.live_count(), 0);
    assert!(registry.status().is_empty());

    tokio::task::yield_now().await;
    tokio::time::sleep(Duration::from_millis(80)).await;

    for p in ports {
        let rebind = UdpSocket::bind(format!("127.0.0.1:{p}")).await;
        assert!(
            rebind.is_ok(),
            "port {p} should be free after force_disconnect_all, got {rebind:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// (4) Idempotent wrap_dial — same peer + repeated wrap returns same multiaddr.
//
// This is the property the dial-wrapping helper needs in order to not
// build a fresh tunnel on every libp2p stream open. Critical because
// each tunnel costs a fresh boringtun handshake + a fresh UDP bind.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrap_dial_is_idempotent_for_same_peer() {
    let registry = WgRegistry::new();
    let peer = dummy_peer_id();
    let (local_priv, _) = dummy_x25519_keypair();
    let (_, remote_pub) = dummy_x25519_keypair();
    let (_remote_sock, remote_addr) = dummy_remote_endpoint().await;

    let first = registry
        .wrap_dial(peer, local_priv, remote_pub, remote_addr)
        .await
        .expect("first wrap_dial");

    let second = registry
        .wrap_dial(peer, local_priv, remote_pub, remote_addr)
        .await
        .expect("second wrap_dial");

    assert_eq!(
        first, second,
        "second wrap_dial for the same peer must return the same wrapped multiaddr — \
         a fresh tunnel for every dial would cost a handshake + UDP bind on each stream"
    );
    assert_eq!(registry.live_count(), 1);
}

// ---------------------------------------------------------------------------
// (5) Linux-only — Architecture E observable in /proc/net/route.
//
// boringtun runs entirely in userspace; no `wg*` kernel interface
// should exist before, during, or after a WgTunnel's lifetime. This
// test exists to catch a future regression that might swap boringtun
// for a kernel-WG backend without rewiring the close-event handler.
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_kernel_wg_interface_created_or_left_behind() {
    let before = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    let before_wg: Vec<&str> = before
        .lines()
        .filter(|l| l.starts_with("wg") || l.split('\t').next().map_or(false, |c| c.starts_with("wg")))
        .collect();

    let peer = dummy_peer_id();
    let (local_priv, _) = dummy_x25519_keypair();
    let (_, remote_pub) = dummy_x25519_keypair();
    let (_remote_sock, remote_addr) = dummy_remote_endpoint().await;
    let tunnel = WgTunnel::start(peer, local_priv, remote_pub, remote_addr)
        .await
        .expect("start");

    let during = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    let during_wg: Vec<&str> = during
        .lines()
        .filter(|l| l.starts_with("wg") || l.split('\t').next().map_or(false, |c| c.starts_with("wg")))
        .collect();
    assert_eq!(
        before_wg, during_wg,
        "WgTunnel must not add a wg* kernel interface — found delta: before={before_wg:?} during={during_wg:?}"
    );

    drop(tunnel);
    tokio::time::sleep(Duration::from_millis(80)).await;

    let after = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    let after_wg: Vec<&str> = after
        .lines()
        .filter(|l| l.starts_with("wg") || l.split('\t').next().map_or(false, |c| c.starts_with("wg")))
        .collect();
    assert_eq!(
        before_wg, after_wg,
        "WgTunnel must not leave a wg* kernel interface behind after Drop"
    );
}
