/**
 * Peer store API wrapper (Phase 5 — peer pairing).
 *
 * Thin wrapper around the `peer_store_list` / `peer_store_add` /
 * `peer_store_remove` Tauri commands exposed by `src-tauri/src/lib.rs`.
 * The Rust side persists pairings to an encrypted sibling file next to the
 * Stronghold snapshot (see `src-tauri/src/servitude/peer_store.rs`).
 *
 * Wire shape: per Wave 1, the backend's IPC shape is already camelCase
 * (`#[serde(rename_all = "camelCase")]` on `KnownPeerPublic`), so the
 * transcription work here is limited to the `source` enum, which Rust
 * serializes as PascalCase variants (`Qr` / `Deeplink` / `MatrixRoom` /
 * `Dht`) but accepts as lowercase snake_case strings on input
 * (`qr` / `deeplink` / `matrix_room` / `dht`). The TS-facing shape is
 * lowercase throughout to keep the consumer API consistent.
 *
 * Defence-in-depth: same pattern as `peerIdentity.ts` / `peerSwarm.ts` —
 * fields are copied **explicitly** rather than spread from the backend
 * payload. If a future bug ever leaked a `private_key` / `seed`-shaped
 * field, it would be silently dropped here rather than propagating into
 * UI state, console logs, or persisted state.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Where this pairing came from. Used downstream for UI hints (the source
 * badge in the paired-peers list) and for analytics if we ever add them.
 * Kept in sync with the Rust `PeerSource` enum in
 * `src-tauri/src/servitude/peer_store.rs`.
 */
export type PeerSource = "qr" | "deeplink" | "matrix_room" | "dht";

/**
 * A peer the user has paired with. Mirrors `KnownPeerPublic` on the Rust
 * side except that `source` is normalized to lowercase snake_case here.
 */
export interface KnownPeer {
  peerId: string;
  publicKeyHex: string;
  multiaddrs: string[];
  source: PeerSource;
  /** ISO 8601 string from the backend (chrono::Utc::now().to_rfc3339()). */
  firstSeen: string;
  /** ISO 8601 string; advanced by `peer_store_add` on idempotent re-add. */
  lastSeen: string;
}

/**
 * The transferable peer-card shape — just the identity bits needed for
 * another install to pair with this one. Encoded into the QR / deeplink
 * payload by `lib/peerCard.ts`.
 */
export interface PeerCard {
  peerId: string;
  publicKeyHex: string;
  multiaddrs: string[];
}

/**
 * Raw wire shape returned by `peer_store_list` / `peer_store_add`. The
 * `source` field is the Rust enum's PascalCase serialization.
 */
interface RawKnownPeer {
  peerId: string;
  publicKeyHex: string;
  multiaddrs: string[];
  source: "Qr" | "Deeplink" | "MatrixRoom" | "Dht";
  firstSeen: string;
  lastSeen: string;
}

/**
 * Normalize the backend's PascalCase source enum to the TS-facing
 * snake_case form. Defensive against unknown variants — if Wave 1 ever
 * adds a new variant we haven't taught the wrapper about, we fall back
 * to `'dht'` (the lowest-trust source) rather than fabricating a value
 * the consumer might rely on.
 */
function parseSource(raw: RawKnownPeer["source"]): PeerSource {
  switch (raw) {
    case "Qr":
      return "qr";
    case "Deeplink":
      return "deeplink";
    case "MatrixRoom":
      return "matrix_room";
    case "Dht":
      return "dht";
    default:
      // Unknown variant — treat as DHT (lowest trust). This branch is
      // also typed as `never` because the switch is exhaustive over the
      // declared union, but the runtime guard remains as belt-and-braces
      // against a backend-side enum extension that ships before this
      // wrapper is updated.
      return "dht";
  }
}

/**
 * Serialize the TS-facing source enum into the lowercase snake_case
 * string the `peer_store_add` command accepts on the input side.
 */
function serializeSource(source: PeerSource): string {
  // The values already match the Rust input contract — this helper exists
  // mainly to centralize the contract so a future rename (or stricter
  // validation) has one place to live.
  return source;
}

/**
 * Convert a raw backend payload into the TS-facing shape. Uses an
 * explicit field-by-field copy (NOT a spread) so any extra fields the
 * backend might accidentally include — present or future — are dropped
 * rather than leaked into TS-land. Same defence-in-depth pattern as
 * `peerIdentity.ts` / `peerSwarm.ts`.
 */
function fromRaw(raw: RawKnownPeer): KnownPeer {
  return {
    peerId: raw.peerId,
    publicKeyHex: raw.publicKeyHex,
    multiaddrs: [...raw.multiaddrs],
    source: parseSource(raw.source),
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
  };
}

/**
 * List every peer currently in the store.
 *
 * Rejects with the underlying invoke error when called from a web build
 * (no `@tauri-apps/api/core` runtime, or the command is unregistered).
 * Callers should guard with `isTauri()` and surface a graceful
 * native-only placeholder instead of treating the rejection as a hard
 * failure — same convention as `fetchPeerIdentity()`.
 */
export async function fetchKnownPeers(): Promise<KnownPeer[]> {
  const raw = await invoke<RawKnownPeer[]>("peer_store_list");
  return raw.map(fromRaw);
}

/**
 * Add (or refresh) a peer in the store. Wave 1 guarantees idempotency:
 * re-adding an existing peer-id unions the multiaddrs, preserves the
 * original `firstSeen` and `source`, and advances `lastSeen`.
 *
 * Returns the resulting `KnownPeer` after the backend has persisted it.
 */
export async function addPeer(
  card: PeerCard,
  source: PeerSource,
): Promise<KnownPeer> {
  const raw = await invoke<RawKnownPeer>("peer_store_add", {
    peerId: card.peerId,
    publicKeyHex: card.publicKeyHex,
    multiaddrs: card.multiaddrs,
    source: serializeSource(source),
  });
  return fromRaw(raw);
}

/**
 * Remove a peer by its peer-id. Returns `true` if a record was removed,
 * `false` if nothing matched (the call is otherwise a no-op — the store
 * does not error on missing IDs).
 */
export async function removePeer(peerId: string): Promise<boolean> {
  return await invoke<boolean>("peer_store_remove", { peerId });
}
