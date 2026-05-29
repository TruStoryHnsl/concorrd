/**
 * Phase 9 — browser-side Kademlia bootstrap multiaddrs.
 *
 * Hand-mirrored from `src-tauri/src/servitude/bootstrap.rs`. The native
 * (Rust) build is the source of truth — these strings MUST match the
 * `BOOTSTRAP_NODES` constant in that file in lockstep. If the native
 * list rotates without this file rotating, browser tabs lose the DHT
 * and start logging best-effort dial failures forever.
 *
 * No build step codegens this; a hand-mirrored constant is the lightest
 * touch for Phase 9. If/when the list grows beyond ~5 entries OR rotates
 * frequently enough that drift becomes a real risk, fold in a tiny
 * codegen pass driven by `cargo run --bin emit-bootstrap-json` or
 * equivalent.
 *
 * The multiaddrs below are SYNTACTICALLY-VALID PLACEHOLDERS — the
 * PeerIds parse but do not correspond to any real deployed node. They
 * exist so the dial path is exercisable end-to-end before the bootstrap
 * VPS fleet is provisioned.
 */

/**
 * Hardcoded list of Concord bootstrap nodes for the browser libp2p
 * node. MUST match `src-tauri/src/servitude/bootstrap.rs::BOOTSTRAP_NODES`.
 *
 * Each entry is a libp2p multiaddr with a `/p2p/<peer-id>` suffix so
 * the Kad behavior can pin the address to the right PeerId before any
 * dial.
 *
 * Note: the browser libp2p stack does not speak QUIC. The native
 * bootstrap multiaddrs advertise `/quic-v1` which the browser will
 * silently fail to dial — that's fine for Phase 9. The DHT seed path
 * still tries (best-effort, identical to the native `seed_kad_bootstrap`
 * pattern), and once bootstrap nodes advertise a `/wss` or
 * `/webrtc-direct` multiaddr alongside the QUIC one, the browser dials
 * succeed without any code change.
 */
export const BOOTSTRAP_MULTIADDRS: readonly string[] = [
  // bootstrap1.concordchat.net — placeholder, dev seed "CONCORDBS-1"
  "/dns4/bootstrap1.concordchat.net/udp/4001/quic-v1/p2p/12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W",
  // bootstrap2.concordchat.net — placeholder, dev seed "CONCORDBS-2"
  "/dns4/bootstrap2.concordchat.net/udp/4001/quic-v1/p2p/12D3KooWAPvtWRKcu3R6LknqqFvo8NcfYmHD3KARg44QruzR6mdn",
  // bootstrap3.concordchat.net — placeholder, dev seed "CONCORDBS-3"
  "/dns4/bootstrap3.concordchat.net/udp/4001/quic-v1/p2p/12D3KooWL4y2JJGGoQpfYcjhR52aH7FgLPSG5jPL9YvYo9EvNCby",
];
