//! Phase G — libp2p connection gate.
//!
//! A purpose-built `NetworkBehaviour` impl that returns
//! `Err(ConnectionDenied)` from `handle_pending_inbound_connection`
//! when the connection's source IP is not on the trusted tunnel
//! allow-list AND the operator has flipped `enforce = true`.
//!
//! The behaviour carries NO state of its own beyond the snapshot it
//! was built with. Mutation is via [`ConnectionGate::update`], which
//! the Tauri layer calls whenever the config changes; the swarm task
//! owns the gate and updates it in-place. Hot-swap is safe — the
//! detector + the enforce flag are both replaced atomically.
//!
//! ## Why a dedicated behaviour
//!
//! libp2p's derive(`NetworkBehaviour`) macro composes every field's
//! `handle_pending_inbound_connection` with `?` — the first field to
//! return `Err` short-circuits the connection BEFORE the
//! noise/yamux upgrade. Adding the gate as a field on
//! [`crate::servitude::p2p::Behaviour`] gives us exactly that: any
//! inbound TCP/QUIC connection from a non-tunnel IP is rejected with
//! a typed error visible in the swarm's `OutgoingConnectionError`
//! stream on the dialing side.
//!
//! Note: dialing OUTBOUND remains unconstrained. The operator
//! explicitly chose to pair with that remote and may legitimately
//! want to dial a public peer through a relay (Phase 9). The gate
//! defends against unsolicited inbound traffic specifically.
//!
//! ## Pure decision function
//!
//! The IP-extraction + decision logic is exposed as the standalone
//! [`evaluate`] free function so the unit tests can drive it without
//! a real swarm. This is the load-bearing testability boundary —
//! the actual `NetworkBehaviour` impl is a thin glue layer.

use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};

use libp2p::core::{multiaddr::Protocol, transport::PortUse, Endpoint, Multiaddr};
use libp2p::swarm::{
    dummy, ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, THandler,
    THandlerInEvent, THandlerOutEvent, ToSwarm,
};
use libp2p::PeerId;
use thiserror::Error;

use super::tunnel_detect::TunnelInterfaces;

/// What the gate decided about a particular inbound source address.
/// Used by tests + diagnostics; the behaviour itself just maps
/// `Reject` to `Err(ConnectionDenied)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    /// Connection allowed — either enforce is off, or the source IP
    /// is on the trusted tunnel list.
    Allow,
    /// Connection blocked — enforce is on and the source IP is not
    /// trusted.
    Reject,
    /// Source address could not be parsed for an IP (e.g. a
    /// dnsaddr-only multiaddr with no `/ip4` or `/ip6` component).
    /// Defaults to `Reject` under enforce, `Allow` otherwise.
    Unknown,
}

/// Typed error placed inside `ConnectionDenied` when the gate
/// rejects. Down-casteable via `ConnectionDenied::downcast_ref` if a
/// caller wants to know specifically why the connection was dropped.
#[derive(Debug, Error)]
#[error("inbound connection from {ip:?} rejected by tunnel-only gate")]
pub struct TunnelGateRejection {
    /// The source IP that didn't match any trusted CIDR. `None` when
    /// the source multiaddr carried no `/ip4` or `/ip6` component.
    pub ip: Option<IpAddr>,
}

/// Shared, hot-swappable gate state. Cheap to clone (Arc-backed).
#[derive(Debug, Clone)]
pub struct GateState {
    inner: Arc<RwLock<InnerState>>,
}

#[derive(Debug)]
struct InnerState {
    enforce: bool,
    interfaces: TunnelInterfaces,
}

impl GateState {
    pub fn new(enforce: bool, interfaces: TunnelInterfaces) -> Self {
        Self {
            inner: Arc::new(RwLock::new(InnerState {
                enforce,
                interfaces,
            })),
        }
    }

    /// Atomic swap of both knobs. Used by the Tauri config command
    /// after the JSON file is persisted.
    pub fn update(&self, enforce: bool, interfaces: TunnelInterfaces) {
        let mut g = self.inner.write().expect("gate state poisoned");
        g.enforce = enforce;
        g.interfaces = interfaces;
    }

    /// Snapshot the enforce flag. Used by the report endpoint.
    pub fn enforce(&self) -> bool {
        self.inner
            .read()
            .expect("gate state poisoned")
            .enforce
    }

    /// Snapshot of the trusted interfaces. Returned as an owned value
    /// rather than a reference because the inner state is behind a
    /// lock.
    pub fn interfaces_snapshot(&self) -> TunnelInterfaces {
        self.inner
            .read()
            .expect("gate state poisoned")
            .interfaces
            .clone()
    }
}

/// Pure decision function — `evaluate(addr, &state)` answers
/// "should this inbound source address be accepted?" without a
/// running swarm. The tests pin this directly.
pub fn evaluate(remote_addr: &Multiaddr, state: &GateState) -> GateDecision {
    let ip = extract_ip(remote_addr);
    let inner = state.inner.read().expect("gate state poisoned");
    let enforce = inner.enforce;
    if !enforce {
        return GateDecision::Allow;
    }
    match ip {
        None => GateDecision::Unknown,
        Some(ip) => {
            if inner.interfaces.is_tunnel_ip(ip) {
                GateDecision::Allow
            } else {
                GateDecision::Reject
            }
        }
    }
}

/// Walk the multiaddr components looking for the FIRST `/ip4` or
/// `/ip6` — that's the source IP of the connection.
fn extract_ip(addr: &Multiaddr) -> Option<IpAddr> {
    for proto in addr.iter() {
        match proto {
            Protocol::Ip4(ip) => return Some(IpAddr::V4(ip)),
            Protocol::Ip6(ip) => return Some(IpAddr::V6(ip)),
            _ => continue,
        }
    }
    None
}

// ---------------------------------------------------------------------------
// NetworkBehaviour impl. Trivial — every callback is a no-op except
// `handle_pending_inbound_connection`, which returns Err on a rejected
// connection.
// ---------------------------------------------------------------------------

/// The behaviour itself. Wraps a [`GateState`] and registers as a
/// field on `Behaviour`. No connection handler, no events emitted —
/// the only useful side effect is short-circuiting inbound dials.
#[derive(Debug, Clone)]
pub struct ConnectionGate {
    state: GateState,
}

impl ConnectionGate {
    /// Build a gate around the given state. Cheap; no allocations.
    pub fn new(state: GateState) -> Self {
        Self { state }
    }

    /// Snapshot the inner state. Lets the swarm-owning task hold a
    /// clone so the Tauri command layer can `update(...)` without
    /// reaching through the behaviour itself.
    pub fn state(&self) -> GateState {
        self.state.clone()
    }
}

impl NetworkBehaviour for ConnectionGate {
    type ConnectionHandler = dummy::ConnectionHandler;
    type ToSwarm = Infallible;

    fn handle_pending_inbound_connection(
        &mut self,
        _connection_id: ConnectionId,
        _local_addr: &Multiaddr,
        remote_addr: &Multiaddr,
    ) -> Result<(), ConnectionDenied> {
        match evaluate(remote_addr, &self.state) {
            GateDecision::Allow => {
                log::debug!(
                    target: "concord::servitude::network::gate",
                    "inbound from {remote_addr} allowed"
                );
                Ok(())
            }
            GateDecision::Reject | GateDecision::Unknown => {
                let ip = extract_ip(remote_addr);
                log::warn!(
                    target: "concord::servitude::network::gate",
                    "rejecting inbound connection from {remote_addr} (tunnel-only mode enforced)"
                );
                Err(ConnectionDenied::new(TunnelGateRejection { ip }))
            }
        }
    }

    fn handle_established_inbound_connection(
        &mut self,
        _connection_id: ConnectionId,
        _peer: PeerId,
        _local_addr: &Multiaddr,
        _remote_addr: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(dummy::ConnectionHandler)
    }

    fn handle_pending_outbound_connection(
        &mut self,
        _connection_id: ConnectionId,
        _maybe_peer: Option<PeerId>,
        _addresses: &[Multiaddr],
        _effective_role: Endpoint,
    ) -> Result<Vec<Multiaddr>, ConnectionDenied> {
        // Outbound dials are NOT gated. The operator explicitly chose
        // to dial this peer.
        Ok(vec![])
    }

    fn handle_established_outbound_connection(
        &mut self,
        _connection_id: ConnectionId,
        _peer: PeerId,
        _addr: &Multiaddr,
        _role_override: Endpoint,
        _port_use: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(dummy::ConnectionHandler)
    }

    fn on_swarm_event(&mut self, _event: FromSwarm) {
        // Lifecycle events are ignored — the gate is stateless w.r.t.
        // established connections (the upper layers already track
        // peer membership).
    }

    fn on_connection_handler_event(
        &mut self,
        _peer_id: PeerId,
        _connection_id: ConnectionId,
        event: THandlerOutEvent<Self>,
    ) {
        // dummy::ConnectionHandler never emits events, but the trait
        // requires we name the type parameter. The `match` below
        // proves the variant is unreachable.
        match event {}
    }

    fn poll(
        &mut self,
        _cx: &mut Context<'_>,
    ) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn loopback_v4() -> Multiaddr {
        "/ip4/127.0.0.1/tcp/4001".parse().unwrap()
    }
    fn public_v4() -> Multiaddr {
        "/ip4/8.8.8.8/tcp/4001".parse().unwrap()
    }
    fn tunnel_extra() -> Multiaddr {
        "/ip4/10.42.1.1/tcp/4001".parse().unwrap()
    }
    fn dnsaddr_only() -> Multiaddr {
        "/dnsaddr/example.com/tcp/4001".parse().unwrap()
    }

    #[test]
    fn evaluate_passes_when_enforce_off() {
        let state = GateState::new(false, TunnelInterfaces::detect(&[]));
        assert_eq!(evaluate(&public_v4(), &state), GateDecision::Allow);
        assert_eq!(evaluate(&dnsaddr_only(), &state), GateDecision::Allow);
    }

    #[test]
    fn evaluate_loopback_always_allowed_under_enforce() {
        let state = GateState::new(true, TunnelInterfaces::detect(&[]));
        assert_eq!(evaluate(&loopback_v4(), &state), GateDecision::Allow);
    }

    #[test]
    fn evaluate_blocks_public_ip_when_enforce_on() {
        let state = GateState::new(true, TunnelInterfaces::detect(&[]));
        assert_eq!(evaluate(&public_v4(), &state), GateDecision::Reject);
    }

    #[test]
    fn evaluate_allows_extra_cidr_when_enforce_on() {
        let extra: ipnet::IpNet = "10.42.0.0/16".parse().unwrap();
        let state = GateState::new(true, TunnelInterfaces::detect(&[extra]));
        assert_eq!(evaluate(&tunnel_extra(), &state), GateDecision::Allow);
    }

    #[test]
    fn evaluate_unknown_when_no_ip_in_multiaddr_and_enforce_on() {
        let state = GateState::new(true, TunnelInterfaces::detect(&[]));
        assert_eq!(evaluate(&dnsaddr_only(), &state), GateDecision::Unknown);
    }

    #[test]
    fn extract_ip_finds_v4_and_v6() {
        assert_eq!(
            extract_ip(&loopback_v4()),
            Some(IpAddr::V4(Ipv4Addr::LOCALHOST))
        );
        let v6: Multiaddr = "/ip6/::1/tcp/4001".parse().unwrap();
        assert_eq!(extract_ip(&v6), Some(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert_eq!(extract_ip(&dnsaddr_only()), None);
    }

    #[test]
    fn hot_swap_takes_effect() {
        let state = GateState::new(true, TunnelInterfaces::detect(&[]));
        assert_eq!(evaluate(&tunnel_extra(), &state), GateDecision::Reject);
        let extra: ipnet::IpNet = "10.42.0.0/16".parse().unwrap();
        state.update(true, TunnelInterfaces::detect(&[extra]));
        assert_eq!(evaluate(&tunnel_extra(), &state), GateDecision::Allow);
    }
}
