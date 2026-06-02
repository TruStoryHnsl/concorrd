/**
 * LAN-discovered peers (post-2026-05-29 architecture redirect).
 *
 * The native swarm uses mDNS for LAN-local peer discovery. The Rust
 * side emits a Tauri event named `peer_lan_discovered` whenever the
 * mDNS subsystem announces a peer; this module subscribes to that
 * event and maintains an in-memory list deduplicated by peer_id.
 *
 * No persistence by design — the LAN-peer list resets each session.
 * If the user wants to remember a LAN-discovered peer across launches,
 * they promote it into the persistent Phase-5 peer store via the
 * "Pair this peer" action in `ProfileTab → Peers on your LAN`.
 *
 * Web build: the browser libp2p stack can't speak mDNS in any portable
 * way, so this surface is no-op on web. `subscribe()` resolves to a
 * teardown that does nothing and `getLanPeers()` always returns an
 * empty array. Consumers should guard with `isTauri()` themselves;
 * the API stays callable so call sites don't need conditional imports.
 */

import { isTauri } from "./servitude";

/**
 * A peer the native swarm discovered on the local network via mDNS.
 * Lightweight on purpose — peer_id and multiaddrs are all the UI
 * needs to render the row + offer a "Pair this peer" action.
 */
export interface LanPeer {
  /** libp2p PeerId in base58 form, as the Rust side stringifies it. */
  peerId: string;
  /** Every multiaddr the mDNS announcement burst reported, stringified. */
  multiaddrs: string[];
  /** ISO 8601 timestamp set client-side when the event was first seen. */
  discoveredAt: string;
}

/**
 * Raw event payload emitted by the Rust side under
 * `peer_lan_discovered`. Fields are snake_case on the wire.
 */
interface PeerLanDiscoveredPayload {
  peer_id: string;
  multiaddrs: string[];
}

/**
 * Module-scoped LAN-peer cache. Keyed by peer_id so each peer has at
 * most one entry even when mDNS re-announces it within a session.
 * Resets to empty on a full page reload.
 */
const lanPeers = new Map<string, LanPeer>();

/**
 * Snapshot listeners for the in-memory cache. Each call to
 * [`subscribeToLanPeers`] adds one entry; teardown removes it.
 */
type SnapshotListener = (peers: LanPeer[]) => void;
const snapshotListeners = new Set<SnapshotListener>();

function snapshot(): LanPeer[] {
  return Array.from(lanPeers.values());
}

function notify(): void {
  const snap = snapshot();
  for (const listener of snapshotListeners) {
    try {
      listener(snap);
    } catch (err) {
      // A bad listener must not poison the rest of the fanout.
      console.warn("[lanPeers] listener threw:", err);
    }
  }
}

/**
 * Idempotently insert (or refresh) a LAN-discovered peer in the
 * in-memory cache. Multiaddrs from a repeat announcement are unioned
 * with the existing list so the UI never loses a known multiaddr
 * just because the latest burst was smaller.
 */
function upsertLanPeer(payload: PeerLanDiscoveredPayload): void {
  const existing = lanPeers.get(payload.peer_id);
  if (existing) {
    const merged = new Set<string>(existing.multiaddrs);
    for (const addr of payload.multiaddrs) {
      merged.add(addr);
    }
    lanPeers.set(payload.peer_id, {
      peerId: existing.peerId,
      multiaddrs: Array.from(merged),
      discoveredAt: existing.discoveredAt,
    });
  } else {
    lanPeers.set(payload.peer_id, {
      peerId: payload.peer_id,
      multiaddrs: [...payload.multiaddrs],
      discoveredAt: new Date().toISOString(),
    });
  }
  notify();
}

/**
 * Test-only escape hatch — exposed so the test suite can drop the
 * cache between cases. Not part of the consumer API.
 */
export function __resetLanPeersForTests(): void {
  lanPeers.clear();
  snapshotListeners.clear();
  // Drop any active Tauri listener so the next subscribe call
  // re-installs a fresh one.
  if (eventTeardown) {
    try {
      eventTeardown();
    } catch {
      // Ignore.
    }
    eventTeardown = null;
  }
  attachInFlight = null;
}

/**
 * Module-scoped teardown for the Tauri event listener. We attach
 * lazily the first time a consumer calls `subscribeToLanPeers` so the
 * cost of importing `@tauri-apps/api/event` is paid only when
 * actually needed.
 */
let eventTeardown: (() => void) | null = null;
let attachInFlight: Promise<void> | null = null;

/**
 * Attach the `peer_lan_discovered` event listener. Dynamic import so
 * the web bundle doesn't pay for the Tauri-only module up front.
 * Idempotent: only the first call actually wires anything.
 */
async function ensureEventSubscription(): Promise<void> {
  if (eventTeardown !== null) return;
  if (attachInFlight !== null) return attachInFlight;

  attachInFlight = (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<PeerLanDiscoveredPayload>(
        "peer_lan_discovered",
        (event) => {
          if (event?.payload) {
            upsertLanPeer(event.payload);
          }
        },
      );
      eventTeardown = unlisten;
    } catch (err) {
      // Web build path: `listen` fails without `__TAURI_INTERNALS__`.
      // Don't crash; just log for diagnostics. The cache stays empty,
      // which is exactly the right behaviour on web — the browser
      // can't observe LAN peers anyway.
      // eslint-disable-next-line no-console
      console.warn(
        "[lanPeers] failed to attach Tauri event listener:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      attachInFlight = null;
    }
  })();

  return attachInFlight;
}

/**
 * Subscribe to LAN-peer snapshot changes. The listener is called once
 * synchronously with the current snapshot, then again every time a
 * new mDNS discovery (or refresh) lands.
 *
 * Returns a teardown function that removes the listener. Consumers
 * MUST call it on unmount; the snapshot fanout is module-scoped and
 * leaked listeners would accumulate across React re-renders.
 *
 * Native-only by design — the web path resolves the listener with an
 * empty snapshot once and never fires again.
 */
export function subscribeToLanPeers(listener: SnapshotListener): () => void {
  snapshotListeners.add(listener);
  // Hand the consumer an immediate snapshot so first render has data
  // (or an empty array, on a cold cache).
  try {
    listener(snapshot());
  } catch (err) {
    console.warn("[lanPeers] initial snapshot listener threw:", err);
  }

  if (isTauri()) {
    void ensureEventSubscription();
  }

  return () => {
    snapshotListeners.delete(listener);
  };
}

/**
 * Snapshot accessor for callers that just want a one-shot read of the
 * current LAN-peer list (e.g. tests, or surfaces that don't want a
 * subscription). Returns a fresh array each call.
 */
export function getLanPeers(): LanPeer[] {
  return snapshot();
}
