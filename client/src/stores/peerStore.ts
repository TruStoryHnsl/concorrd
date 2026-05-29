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
  removePeer,
  type KnownPeer,
  type PeerCard,
  type PeerSource,
} from "../api/peerStore";
import { isTauri } from "../api/servitude";

/** Sentinel for the no-Tauri (browser/web) case — matches `identity.ts`. */
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
      set({
        isLoading: false,
        error: PEER_STORE_ERROR_NATIVE_ONLY,
        knownPeers: [],
      });
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
      set({ error: PEER_STORE_ERROR_NATIVE_ONLY });
      return null;
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

  remove: async (peerId) => {
    if (!isTauri()) {
      set({ error: PEER_STORE_ERROR_NATIVE_ONLY });
      return false;
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
