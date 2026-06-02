/**
 * Peer swarm API wrapper (Phase 3 — libp2p swarm status).
 *
 * Thin wrapper around the `peer_swarm_status` Tauri command exposed by
 * `src-tauri/src/lib.rs`. The Rust side runs a libp2p swarm whose
 * `PeerId` derives from the same Ed25519 seed backing the Phase 2
 * `peer_identity` fingerprint, and a background mirror task keeps a
 * snapshot of the swarm's broadcast-channel state (peer count, local
 * multiaddrs, the last observed event) in a shared cache. This wrapper
 * fetches that snapshot and transcribes the snake_case Rust shape into
 * camelCase for the React side.
 *
 * Defence-in-depth: the conversion below copies fields **explicitly**
 * rather than spreading the backend payload. If a future bug ever leaked
 * a `private_key`-shaped field, it would be silently dropped here rather
 * than propagating into UI state, console logs, or persisted state. Same
 * pattern as `peerIdentity.ts`.
 */

/**
 * Public-only swarm status shape consumed by TS-land. Mirrors the
 * `SwarmStatus` struct in `src-tauri/src/lib.rs`. There is NO
 * private-key / seed field and there must never be one — the libp2p
 * secret key never crosses the IPC boundary.
 */
export interface SwarmStatus {
  ourPeerId: string;
  ourMultiaddrs: string[];
  peerCount: number;
  lastEvent: string | null;
}

/**
 * Raw wire shape returned by the Rust `peer_swarm_status` command. The
 * Rust struct uses snake_case (serde default with `#[derive(Serialize)]`),
 * so the wrapper below transcribes it field-by-field into camelCase.
 */
interface RawSwarmStatus {
  our_peer_id: string;
  our_multiaddrs: string[];
  peer_count: number;
  last_event: string | null;
}

/**
 * Fetch the current install's libp2p swarm status from the Tauri
 * backend.
 *
 * Rejects with the underlying invoke error when called from a web build
 * (no `@tauri-apps/api/core` runtime, or the command is unregistered).
 * Callers should guard with `isTauri()` and surface a graceful
 * native-only placeholder instead of treating the rejection as a hard
 * failure — same convention as `fetchPeerIdentity()`.
 */
export async function fetchPeerSwarmStatus(): Promise<SwarmStatus> {
  // Dynamic import keeps this module safe to evaluate in a plain browser
  // build — matches the pattern used by `peerIdentity.ts` and
  // `servitude.ts`.
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<RawSwarmStatus>("peer_swarm_status");
  // Explicit field-by-field copy (NOT a spread) so any extra fields the
  // backend might accidentally include — present or future — are dropped
  // rather than leaked into TS-land. Defence-in-depth against an
  // accidental private-key leak through the wire contract.
  return {
    ourPeerId: raw.our_peer_id,
    ourMultiaddrs: raw.our_multiaddrs,
    peerCount: raw.peer_count,
    lastEvent: raw.last_event,
  };
}
