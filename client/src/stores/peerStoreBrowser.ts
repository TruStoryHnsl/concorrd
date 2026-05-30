/**
 * Phase 9 (browser P2P UI surface) — localStorage-backed peer store.
 *
 * Mirrors the native `peer_store_*` Tauri commands' wire model
 * (`KnownPeer` from `../api/peerStore.ts`) so the rest of the UI doesn't
 * have to branch on the platform. The native side persists pairings to
 * an encrypted Stronghold sibling file; the browser side persists to
 * `localStorage` under a single JSON-encoded key.
 *
 * Persistence key: `concord:browser:peer-store`. A bumped versioning
 * suffix (`v1`) is embedded inside the JSON envelope rather than the
 * key name so a future migration can rewrite the value in place without
 * having to read every key on the storage object.
 *
 * Quota handling: `setItem` throws `QuotaExceededError` in private-mode
 * tabs / locked-down enterprise installs. Every write path catches
 * synchronously and surfaces a typed result so the zustand store can
 * route the error into its `error` field without crashing the React
 * tree. Reads are also defensive — a malformed JSON value in storage
 * yields an empty list rather than a crash.
 */

import type {
  KnownPeer,
  PeerCard,
  PeerSource,
} from "../api/peerStore";

/** localStorage key for the persisted peer list. */
export const BROWSER_PEER_STORE_KEY = "concord:browser:peer-store";

/** Wire-format version embedded inside the JSON envelope. Bump on
 *  incompatible shape changes; until then we'll silently accept the
 *  legacy shape and migrate forward. */
const STORE_VERSION = 1;

/**
 * On-disk envelope shape. `peers` is the canonical list mirror; the
 * version field lets future migrations decide whether to rewrite the
 * value or treat it as already-current.
 */
interface StoredEnvelope {
  version: number;
  peers: KnownPeer[];
}

/**
 * Result type for write paths. `ok: false` carries a user-facing
 * `error` string the store routes into its `error` field. Discriminated
 * union so callers can switch on `result.ok` exhaustively.
 */
export type WriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Best-effort access to the `localStorage` global. Returns `null` if
 * the runtime doesn't expose one (server-render path, jsdom with the
 * storage proxy disabled, etc.). Callers MUST handle the null case;
 * the safe default is "behave like the store is empty + writes are
 * rejected with a friendly error" — same posture as the native build
 * when Stronghold is unavailable.
 */
function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    // Accessing `.localStorage` itself can throw on some Firefox
    // configurations (`SecurityError: The operation is insecure.`),
    // so the try/catch is around the property access, not just the
    // subsequent calls.
    const storage = window.localStorage;
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function"
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

/**
 * Read the persisted envelope from localStorage and return the peer
 * list. Defensive — any parse / shape error yields an empty list
 * rather than a thrown exception, matching the "fresh install" state.
 */
export function listBrowserPeers(): KnownPeer[] {
  const storage = getStorage();
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(BROWSER_PEER_STORE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted JSON in storage — treat as empty rather than crashing.
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const envelope = parsed as Partial<StoredEnvelope>;
  if (!Array.isArray(envelope.peers)) return [];
  // Defensive field-by-field reconstruction so a malformed entry can't
  // smuggle unexpected fields into the rest of the UI. Same defence-in-
  // depth pattern as `../api/peerStore.ts::fromRaw`.
  const out: KnownPeer[] = [];
  for (const entry of envelope.peers) {
    if (!entry || typeof entry !== "object") continue;
    // Cast through `unknown` because `KnownPeer` is a strict shape that
    // doesn't carry an index signature — TS rejects a direct cast even
    // though the runtime semantics are identical.
    const e = entry as unknown as Record<string, unknown>;
    if (
      typeof e.peerId !== "string" ||
      typeof e.publicKeyHex !== "string" ||
      !Array.isArray(e.multiaddrs) ||
      typeof e.source !== "string" ||
      typeof e.firstSeen !== "string" ||
      typeof e.lastSeen !== "string"
    ) {
      continue;
    }
    const source = e.source as PeerSource;
    if (
      source !== "qr" &&
      source !== "deeplink" &&
      source !== "matrix_room" &&
      source !== "dht"
    ) {
      continue;
    }
    const multiaddrs: string[] = [];
    for (const addr of e.multiaddrs) {
      if (typeof addr === "string" && addr.length > 0) {
        multiaddrs.push(addr);
      }
    }
    out.push({
      peerId: e.peerId,
      publicKeyHex: e.publicKeyHex,
      multiaddrs,
      source,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
    });
  }
  return out;
}

/**
 * Write the canonical envelope back to localStorage. Routes
 * `QuotaExceededError` into a typed failure so the zustand store can
 * surface it through its `error` field rather than crashing the React
 * tree (private-mode tabs and enterprise-locked installs frequently
 * deny storage writes).
 */
function persistBrowserPeers(peers: KnownPeer[]): WriteResult<undefined> {
  const storage = getStorage();
  if (!storage) {
    return {
      ok: false,
      error: "browser storage is unavailable in this environment",
    };
  }
  const envelope: StoredEnvelope = { version: STORE_VERSION, peers };
  try {
    storage.setItem(BROWSER_PEER_STORE_KEY, JSON.stringify(envelope));
    return { ok: true, value: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `couldn't persist peers to browser storage: ${message}`,
    };
  }
}

/**
 * Add (or refresh) a peer in the browser-side store.
 *
 * Idempotency contract matches the Rust `peer_store_add` command:
 *   - Re-adding an existing peer-id unions the new multiaddrs into the
 *     existing list (`Set`-style dedupe, insertion order preserved).
 *   - `firstSeen` and `source` are preserved from the original record.
 *   - `lastSeen` is advanced to "now" on every successful add.
 *
 * Validates the public-key hex length (64 chars) the same way the
 * native side does — see `src-tauri/src/servitude/peer_store.rs`.
 */
export function addBrowserPeerFromCard(
  card: PeerCard,
  source: PeerSource,
  now: () => Date = () => new Date(),
): WriteResult<KnownPeer> {
  // Mirror the native input validation so a malformed card from a
  // pasted deeplink surfaces the same error message on web as on
  // native rather than the persisted layer silently accepting it.
  if (typeof card.peerId !== "string" || card.peerId.length === 0) {
    return { ok: false, error: "peerId missing or empty" };
  }
  if (
    typeof card.publicKeyHex !== "string" ||
    card.publicKeyHex.length !== 64 ||
    !/^[0-9a-fA-F]+$/.test(card.publicKeyHex)
  ) {
    return {
      ok: false,
      error: "publicKeyHex must be 64 hex chars",
    };
  }
  if (!Array.isArray(card.multiaddrs) || card.multiaddrs.length === 0) {
    return { ok: false, error: "multiaddrs must be non-empty" };
  }

  const existing = listBrowserPeers();
  const nowIso = now().toISOString();
  const matchIdx = existing.findIndex((p) => p.peerId === card.peerId);
  let updated: KnownPeer;
  if (matchIdx >= 0) {
    const prior = existing[matchIdx];
    // Union the address sets, preserving first-seen order.
    const merged: string[] = [...prior.multiaddrs];
    for (const addr of card.multiaddrs) {
      if (!merged.includes(addr)) merged.push(addr);
    }
    updated = {
      peerId: prior.peerId,
      publicKeyHex: prior.publicKeyHex,
      multiaddrs: merged,
      source: prior.source,
      firstSeen: prior.firstSeen,
      lastSeen: nowIso,
    };
    existing[matchIdx] = updated;
  } else {
    updated = {
      peerId: card.peerId,
      publicKeyHex: card.publicKeyHex,
      multiaddrs: [...card.multiaddrs],
      source,
      firstSeen: nowIso,
      lastSeen: nowIso,
    };
    existing.push(updated);
  }
  const write = persistBrowserPeers(existing);
  if (!write.ok) return write;
  return { ok: true, value: updated };
}

/**
 * Remove a peer by id from the browser-side store. Returns `true` when
 * a record was actually removed, `false` when nothing matched — same
 * convention as the native `peer_store_remove` command.
 *
 * Quota-error short-circuit: removal can't exceed quota, but a
 * `SecurityError` on `localStorage.setItem` is still possible in some
 * browser configurations, so the write path is routed the same way.
 */
export function removeBrowserPeer(peerId: string): WriteResult<boolean> {
  const existing = listBrowserPeers();
  const remaining = existing.filter((p) => p.peerId !== peerId);
  if (remaining.length === existing.length) {
    return { ok: true, value: false };
  }
  const write = persistBrowserPeers(remaining);
  if (!write.ok) return write;
  return { ok: true, value: true };
}

/**
 * Test-only escape hatch — clears the persisted envelope. Production
 * code never calls this; the only consumer is the vitest suite, which
 * needs a clean slate between cases.
 */
export function __clearBrowserPeerStoreForTests(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(BROWSER_PEER_STORE_KEY);
  } catch {
    // Ignore — best-effort.
  }
}
