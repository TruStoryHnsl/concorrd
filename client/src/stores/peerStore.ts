/**
 * Paired-peers store (Phase 5 — peer pairing UX).
 *
 * Holds the list of `KnownPeer` records the user has explicitly paired
 * with (via QR scan, deeplink, or a peer-card posted to a Matrix room).
 * Wraps the `peer_store_*` Tauri commands from
 * `../api/peerStore.ts` and listens for `peer_paired` /
 * `peer_paired_error` events the backend emits when a `concord://peer/...`
 * deeplink is handled while the app is running.
 *
 * Design notes:
 *   - Same conventions as `./identity.ts`: zustand `create<T>()`, no
 *     localStorage, web-build calls flip `error: 'native-only'` and
 *     return without throwing so consumers can render a placeholder
 *     instead of crashing.
 *   - The `subscribe()` helper attaches the Tauri event listener once
 *     and is idempotent — calling it twice is a no-op (the second call
 *     returns the same teardown). This keeps both `load()` and any
 *     explicit subscribe-on-mount caller well-behaved.
 *   - On a `peer_paired` event we re-fetch the full list rather than
 *     append the payload directly. The cost is a single IPC round-trip
 *     and it keeps the store as a strict mirror of the on-disk source
 *     of truth, which sidesteps a class of double-add / dedup bugs the
 *     backend already handles internally.
 */

import { create } from "zustand";
import {
  addPeer,
  fetchKnownPeers,
  fetchVisiblePeers,
  grantPeerAccess,
  removePeer,
  revokePeerAccess,
  type KnownPeer,
  type PeerCard,
  type PeerSource,
} from "../api/peerStore";
import { isTauri } from "../api/servitude";
import {
  addBrowserPeerFromCard,
  grantBrowserPeerAccess,
  listBrowserPeers,
  removeBrowserPeer,
  revokeBrowserPeerAccess,
} from "./peerStoreBrowser";

/**
 * Sentinel for the no-Tauri case — preserved for backward compat with
 * any consumer that compared against it. Post Phase-9-UI-surface the
 * web build no longer flips this on, because the localStorage-backed
 * browser store actually services the calls. Native code-paths that
 * previously surfaced this constant continue to work; new browser
 * code-paths set `error: null` because the store IS available.
 */
export const PEER_STORE_ERROR_NATIVE_ONLY = "native-only";

export interface PeerStoreState {
  knownPeers: KnownPeer[];
  isLoading: boolean;
  error: string | null;

  /** Fetch the current list from the backend. Safe to call from a web
   *  build — sets `error: 'native-only'` and returns without throwing. */
  load: () => Promise<void>;

  /** Add (or refresh) a peer, given a card and a source. Returns the
   *  added peer on success, or `null` if the backend rejected the input
   *  (state is updated with `error` in that case). */
  addFromCard: (
    card: PeerCard,
    source: PeerSource,
  ) => Promise<KnownPeer | null>;

  /** Remove a peer by id. Returns the backend's boolean (true if a
   *  record was actually removed). */
  remove: (peerId: string) => Promise<boolean>;

  /** F-VIS — flip a peer from access-granted to visible-only. The peer
   *  stays in `knownPeers` (visible list) but `accessGranted` becomes
   *  false. */
  revokeAccess: (peerId: string) => Promise<KnownPeer | null>;

  /** F-VIS — re-affirm a revoked peer back into the access list. */
  grantAccess: (peerId: string) => Promise<KnownPeer | null>;

  /** F-VIS — convenience: refetch the FULL visible list (including
   *  access-revoked peers). The native command this binds to is
   *  `peers_list_visible`; on web it reads from the localStorage
   *  envelope, which always contained both states. */
  loadVisible: () => Promise<void>;
}

/**
 * Module-scoped teardown for the Tauri event listener. We attach lazily
 * the first time `load()` runs under Tauri so the listener cost is paid
 * only when the consumer actually needs the store; subsequent calls
 * re-use the existing subscription.
 */
let eventTeardown: (() => void) | null = null;
let attachInFlight: Promise<void> | null = null;

/**
 * Attach the `peer_paired` / `peer_paired_error` event listeners. The
 * Tauri event API is dynamically imported so the web bundle doesn't
 * pay for it. Idempotent: only the first call actually wires anything.
 */
async function ensureEventSubscription(): Promise<void> {
  if (eventTeardown !== null) return;
  if (attachInFlight !== null) return attachInFlight;

  attachInFlight = (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlistenPaired = await listen("peer_paired", () => {
        // A successful deeplink-driven add happened on the backend.
        // Re-fetch the full list so this store mirrors disk.
        void usePeerStore.getState().load();
      });
      const unlistenError = await listen<{ stage: string; message: string }>(
        "peer_paired_error",
        (event) => {
          const payload = event.payload;
          const stage = payload?.stage ?? "unknown";
          const message = payload?.message ?? "peer-paired error";
          usePeerStore.setState({ error: `${stage}: ${message}` });
        },
      );
      eventTeardown = () => {
        unlistenPaired();
        unlistenError();
      };
    } catch (err) {
      // The web build path: `@tauri-apps/api/event` may resolve but
      // `listen` will fail without `__TAURI_INTERNALS__`. We swallow
      // here — the store still works without push notifications, the
      // caller's `load()` will set `error: 'native-only'` via its own
      // `isTauri()` guard if we're outside the native shell.
      // Otherwise this is a real failure worth surfacing in the console
      // for diagnostics, but not a hard error for the store.
      // eslint-disable-next-line no-console
      console.warn(
        "[peerStore] failed to attach Tauri event listeners:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      attachInFlight = null;
    }
  })();

  return attachInFlight;
}

export const usePeerStore = create<PeerStoreState>((set, get) => ({
  knownPeers: [],
  isLoading: false,
  error: null,

  load: async () => {
    if (!isTauri()) {
      // Phase 9 (browser P2P UI surface): web build now reads from the
      // localStorage-backed browser peer store rather than no-op'ing.
      // Same KnownPeer shape as native so the rest of the UI doesn't
      // need to branch — see `./peerStoreBrowser.ts` for the wire model.
      try {
        const peers = listBrowserPeers();
        set({ knownPeers: peers, isLoading: false, error: null });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "unknown error");
        set({ isLoading: false, error: message });
      }
      return;
    }

    // Attach the event listener lazily, but don't block `load()` on it —
    // the listener is best-effort, and the initial fetch is the source
    // of truth for the consumer's first render.
    void ensureEventSubscription();

    set({ isLoading: true, error: null });
    try {
      const peers = await fetchKnownPeers();
      set({ knownPeers: peers, isLoading: false, error: null });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({
        isLoading: false,
        error: message,
        // Preserve the existing list rather than nulling it — a transient
        // failure shouldn't wipe out a working UI. Same trade-off the
        // identity store makes in the reverse direction (it does clear,
        // because there's only one identity to ever load).
      });
    }
  },

  addFromCard: async (card, source) => {
    if (!isTauri()) {
      // Phase 9: route through the localStorage backend. Same idempotency
      // contract as the native `peer_store_add` command (re-add unions
      // multiaddrs, preserves firstSeen/source, advances lastSeen).
      const result = addBrowserPeerFromCard(card, source);
      if (!result.ok) {
        set({ error: result.error });
        return null;
      }
      const peers = listBrowserPeers();
      set({ knownPeers: peers, error: null });
      return result.value;
    }
    try {
      const added = await addPeer(card, source);
      // Re-fetch rather than splicing into the local list — backend
      // dedup + last_seen advancement is canonical, and the cost is one
      // IPC round-trip. Cheaper to be boring than to write a parallel
      // merge here that drifts from the backend's semantics.
      await get().load();
      return added;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({ error: message });
      return null;
    }
  },

  revokeAccess: async (peerId) => {
    if (!isTauri()) {
      const result = revokeBrowserPeerAccess(peerId);
      if (!result.ok) {
        set({ error: result.error });
        return null;
      }
      if (result.value) {
        // Replace the matching row in the local mirror.
        set((s) => ({
          knownPeers: s.knownPeers.map((p) =>
            p.peerId === peerId ? result.value! : p,
          ),
          error: null,
        }));
      }
      return result.value;
    }
    try {
      const updated = await revokePeerAccess(peerId);
      if (updated) {
        set((s) => ({
          knownPeers: s.knownPeers.map((p) =>
            p.peerId === peerId ? updated : p,
          ),
          error: null,
        }));
      }
      return updated;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({ error: message });
      return null;
    }
  },

  grantAccess: async (peerId) => {
    if (!isTauri()) {
      const result = grantBrowserPeerAccess(peerId);
      if (!result.ok) {
        set({ error: result.error });
        return null;
      }
      if (result.value) {
        set((s) => ({
          knownPeers: s.knownPeers.map((p) =>
            p.peerId === peerId ? result.value! : p,
          ),
          error: null,
        }));
      }
      return result.value;
    }
    try {
      const updated = await grantPeerAccess(peerId);
      if (updated) {
        set((s) => ({
          knownPeers: s.knownPeers.map((p) =>
            p.peerId === peerId ? updated : p,
          ),
          error: null,
        }));
      }
      return updated;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({ error: message });
      return null;
    }
  },

  loadVisible: async () => {
    if (!isTauri()) {
      // Browser store always tracks both visible + access-revoked
      // peers under one list — same as native after F-VIS.
      try {
        const peers = listBrowserPeers();
        set({ knownPeers: peers, isLoading: false, error: null });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "unknown error");
        set({ isLoading: false, error: message });
      }
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const peers = await fetchVisiblePeers();
      set({ knownPeers: peers, isLoading: false, error: null });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({ isLoading: false, error: message });
    }
  },

  remove: async (peerId) => {
    if (!isTauri()) {
      const result = removeBrowserPeer(peerId);
      if (!result.ok) {
        set({ error: result.error });
        return false;
      }
      if (result.value) {
        set((s) => ({
          knownPeers: s.knownPeers.filter((p) => p.peerId !== peerId),
          error: null,
        }));
      }
      return result.value;
    }
    try {
      const removed = await removePeer(peerId);
      if (removed) {
        // Optimistic local prune — cheaper than a full re-fetch for the
        // common case, and consistent with what the backend will report
        // on the next list call.
        set((s) => ({
          knownPeers: s.knownPeers.filter((p) => p.peerId !== peerId),
        }));
      }
      return removed;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({ error: message });
      return false;
    }
  },
}));

/**
 * Test-only escape hatch — exposed so the test suite can tear down the
 * module-scoped event subscription between cases. Not part of the
 * consumer API; deliberately not re-exported anywhere else.
 */
export function __resetPeerStoreEventSubscriptionForTests(): void {
  if (eventTeardown) {
    try {
      eventTeardown();
    } catch {
      // Ignore — only called from tests.
    }
  }
  eventTeardown = null;
  attachInFlight = null;
}
