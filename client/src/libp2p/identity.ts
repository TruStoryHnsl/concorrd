/**
 * Phase 9 — browser libp2p identity.
 *
 * Per-tab ephemeral Ed25519 keypair. NOT persisted across tabs or
 * reloads, by design: the native build's stronghold-backed Phase 2
 * identity is the durable seam; browser sessions only need an
 * identity that lasts as long as the tab does so they can complete
 * libp2p Noise handshakes and surface a stable PeerId to the rest of
 * the swarm for the lifetime of the page.
 *
 * Spec pointer: `docs/architecture/p2p-design.md` § Phase 9 —
 * "Browser sessions create their own ephemeral libp2p identity
 * (per-tab keypair)."
 *
 * If a future iteration needs the browser identity to survive reloads
 * (e.g. so peers in the same paired room see a stable PeerId for the
 * same user across a refresh), the natural extension is to persist
 * the private-key bytes under `indexedDB` keyed off the Matrix user
 * id and rehydrate on import. Out of scope for Phase 9 — the spec
 * explicitly calls the per-tab keypair the intended behavior.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import type { Ed25519PrivateKey } from "@libp2p/interface";

/**
 * Public surface of the per-tab browser identity. The raw private-key
 * object is held opaquely (`unknown` at the type seam) so consumers
 * outside of `node.ts` cannot accidentally serialize or leak it; only
 * `startBrowserNode` passes it back into libp2p's `createLibp2p`
 * config.
 */
export interface BrowserPeerIdentity {
  /** Base58 PeerId string, identical to the wire form used by Phase 5 peer-store. */
  peerId: string;
  /** Hex-encoded raw Ed25519 public key (32 bytes → 64 hex chars). */
  publicKeyHex: string;
  /** libp2p-managed `PrivateKey` object. Opaque to callers; do not serialize. */
  privateKey: Ed25519PrivateKey;
}

let cached: BrowserPeerIdentity | null = null;

/**
 * Lazily generate and return the per-tab Concord browser identity.
 *
 * The first call generates a fresh Ed25519 keypair via libp2p's
 * crypto module; subsequent calls return the same in-memory record
 * for the lifetime of the tab. A page reload starts a brand-new
 * identity — that's by design (see module doc).
 */
export async function getBrowserIdentity(): Promise<BrowserPeerIdentity> {
  if (cached) return cached;
  const privateKey = await generateKeyPair("Ed25519");
  const peerId = peerIdFromPrivateKey(privateKey);
  cached = {
    peerId: peerId.toString(),
    publicKeyHex: uint8ArrayToString(privateKey.publicKey.raw, "hex"),
    privateKey,
  };
  return cached;
}

/**
 * Drop the cached identity. The next `getBrowserIdentity()` call
 * generates a fresh keypair. Used by tests to assert that ephemeral
 * regeneration produces a different PeerId; safe to call from
 * application code (e.g. on explicit logout) but not currently wired
 * into any UI flow.
 */
export function resetBrowserIdentity(): void {
  cached = null;
}
