/**
 * Peer identity API wrapper (Phase 2 — Ed25519 device identity).
 *
 * Thin wrapper around the `peer_identity` Tauri command exposed by
 * `src-tauri/src/lib.rs`. The Rust side keeps the Ed25519 private key inside
 * a Stronghold snapshot and only ever returns the public surface:
 * `{ public_key_hex, fingerprint }`. This module mirrors that contract on
 * the TypeScript side and converts snake_case → camelCase for the consumer
 * API.
 *
 * Defence-in-depth: the conversion below copies fields **explicitly** rather
 * than spreading the backend payload. If a future bug ever leaked a
 * `private_key_hex` / `seed` / `sk` field into the response, it would be
 * silently dropped here instead of propagating into UI state, console logs,
 * or persisted state.
 */

/**
 * Public-only peer identity shape consumed by TS-land. There is NO
 * private-key field and there must never be one — that key lives in
 * Stronghold and is signed against via `Ed25519Sign` procedures only.
 */
export interface PeerIdentityPublic {
  publicKeyHex: string;
  fingerprint: string;
}

/**
 * Raw wire shape returned by the Rust `peer_identity` command. The Rust
 * struct uses snake_case (serde default with `#[derive(Serialize)]`), so
 * the wrapper below transcribes it field-by-field into camelCase.
 */
interface RawPeerIdentityPublic {
  public_key_hex: string;
  fingerprint: string;
}

/**
 * Fetch the current install's peer identity from the Tauri backend.
 *
 * Rejects with the underlying invoke error when called from a web build
 * (no `@tauri-apps/api/core` runtime, or the command is unregistered).
 * Callers should guard with `isTauri()` and surface a graceful native-only
 * placeholder instead of treating the rejection as a hard failure.
 */
export async function fetchPeerIdentity(): Promise<PeerIdentityPublic> {
  // Dynamic import keeps this module safe to evaluate in a plain browser
  // build — `@tauri-apps/api/core` itself is fine to import, but matching
  // the pattern used by `servitude.ts` keeps both wrappers consistent.
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<RawPeerIdentityPublic>("peer_identity");
  // Explicit field-by-field copy (NOT a spread) so any extra fields the
  // backend might accidentally include — present or future — are dropped
  // rather than leaked into TS-land.
  return {
    publicKeyHex: raw.public_key_hex,
    fingerprint: raw.fingerprint,
  };
}
