//! Phase G — WireGuard-tunneled p2p hardening primitives.
//!
//! This module concentrates the network-shape concerns that gate the
//! libp2p swarm's inbound surface. The single user-visible promise:
//! *when tunnel-only mode is enforced, inbound connections from a
//! non-tunnel IP are rejected BEFORE the noise handshake completes.*
//!
//! Composition:
//!   * [`tunnel_detect::TunnelInterfaces`] — enumerates the running
//!     kernel's tunnel-shaped interfaces (WireGuard `wg*`, Tailscale
//!     `tailscale*` / `utun*` w/ CGNAT prefix, plus operator-supplied
//!     extra CIDRs) and answers the single question
//!     `is_tunnel_ip(ip) -> bool`.
//!   * [`tunnel_config::TunnelConfig`] — JSON-persisted operator
//!     preferences (the enforce toggle + the extra-CIDR list).
//!   * [`connection_gate`] — a tiny `NetworkBehaviour` impl that lives
//!     in the composed [`crate::servitude::p2p::Behaviour`] and
//!     returns `Err(ConnectionDenied)` from
//!     `handle_pending_inbound_connection` when an inbound source IP
//!     isn't on the allow-list.
//!
//! The detection layer is platform-conditional but DOES NOT pull in
//! platform-specific dependencies: Linux walks `/sys/class/net`, macOS
//! calls `getifaddrs(3)` through `libc` (already in our transitive
//! graph via tokio), and Windows iterates `GetAdaptersAddresses`
//! through the `windows-sys` family — but for Phase G the Windows
//! probe is a documented stub returning the loopback CIDR only. iOS
//! is an explicit no-op (returns the empty set + loopback) — the
//! permanent fix is a NetworkExtension that owns its own tunnel
//! interface, documented in `docs/architecture/porch-design.md`
//! Phase G section.

pub mod connection_gate;
pub mod tunnel_config;
pub mod tunnel_detect;
// F-WG (RFC #140 §"Transport — WireGuard exclusively for native p2p"
// + §"Architecture E — Hard-disconnect on app close") — per-peer
// userspace WireGuard tunnels wrapping all native libp2p egress.
// Tunnels collapse synchronously on `Drop` (no background daemon,
// no warm-resume, no kernel interface). See `wg_tunnel`'s module
// docs for the boringtun-vs-wireguard-control decision rationale.
pub mod wg_tunnel;

pub use connection_gate::{ConnectionGate, GateDecision};
pub use tunnel_config::{TunnelConfig, TunnelConfigError};
pub use tunnel_detect::{TunnelDetectionReport, TunnelInterfaces};
pub use wg_tunnel::{TunnelInfo, WgTunnel, WgTunnelError};
