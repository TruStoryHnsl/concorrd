/**
 * Peer identity store (Phase 2 — Ed25519 device identity).
 *
 * Holds the public-only peer identity surface returned by the Tauri
 * `peer_identity` command. The private key never enters TS-land — see
 * `../api/peerIdentity.ts` for the wire-contract guard.
 *
 * Design notes:
 *   - No localStorage: the identity is canonical from Stronghold on every
 *     launch. Caching it in localStorage would create a second source of
 *     truth and risk drift if the snapshot is ever rotated or migrated.
 *   - `load()` is safe to call from a web build — it sets `error: 'native-only'`
 *     and returns without throwing, so consumers can render a graceful
 *     placeholder rather than crash the Profile tab.
 *   - The store mirrors the pattern in `auth.ts` (zustand + `create<T>()`)
 *     but is intentionally simpler: no persistence, no session lifecycle.
 */

import { create } from "zustand";
import { fetchPeerIdentity } from "../api/peerIdentity";
import { fetchPeerSwarmStatus } from "../api/peerSwarm";
import { isTauri } from "../api/servitude";

/** Sentinel string for the no-Tauri (browser/web) case. UI components can
 *  compare against this constant to switch into the native-only placeholder
 *  rendering path. */
export const IDENTITY_ERROR_NATIVE_ONLY = "native-only";

/**
 * Combined identity + swarm store. Phase 2 fields (fingerprint /
 * publicKeyHex / isLoading / error / load) ARE NOT changed in shape —
 * the swarm fields are additive only. The Profile tab consumes both
 * subsections without re-rendering each on the other's updates because
 * zustand's selector hooks subscribe per-field.
 */
export interface IdentityState {
  // ── Phase 2 — Ed25519 device identity ────────────────────────────
  fingerprint: string | null;
  publicKeyHex: string | null;
  isLoading: boolean;
  error: string | null;
  load: () => Promise<void>;

  // ── Phase 3 — libp2p swarm status (additive) ─────────────────────
  /** Local libp2p `PeerId` once the swarm is up; null until then. */
  swarmPeerId: string | null;
  /** Multiaddrs the swarm is currently listening on. */
  swarmMultiaddrs: string[];
  /** Connected peer count (updated live via the `peer_swarm_event`
   *  Tauri event bus when the native listener is wired). */
  swarmPeerCount: number;
  /** Human-readable label for the last observed swarm event. */
  swarmLastEvent: string | null;
  swarmLoading: boolean;
  swarmError: string | null;
  /** Fetch swarm status from the Tauri backend. Safe to call from a
   *  web build — sets `swarmError: 'native-only'` and returns without
   *  throwing. */
  loadSwarm: () => Promise<void>;
}

export const useIdentityStore = create<IdentityState>((set) => ({
  fingerprint: null,
  publicKeyHex: null,
  isLoading: false,
  error: null,

  swarmPeerId: null,
  swarmMultiaddrs: [],
  swarmPeerCount: 0,
  swarmLastEvent: null,
  swarmLoading: false,
  swarmError: null,

  load: async () => {
    if (!isTauri()) {
      // Not a failure — the web build simply has no peer identity to load.
      // Setting `isLoading=false` here is important so consumers don't get
      // stuck on a spinner when they call load() from a web context.
      set({
        isLoading: false,
        error: IDENTITY_ERROR_NATIVE_ONLY,
        fingerprint: null,
        publicKeyHex: null,
      });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const identity = await fetchPeerIdentity();
      set({
        fingerprint: identity.fingerprint,
        publicKeyHex: identity.publicKeyHex,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({
        isLoading: false,
        error: message,
        // Preserve any previously-loaded values? No — a failed reload should
        // not silently mask the failure. Null them out so the UI can detect
        // the un-loaded state and render the error surface.
        fingerprint: null,
        publicKeyHex: null,
      });
    }
  },

  loadSwarm: async () => {
    if (!isTauri()) {
      // Web build — same convention as `load()` above: surface the
      // native-only sentinel and clear the spinner without throwing.
      set({
        swarmLoading: false,
        swarmError: IDENTITY_ERROR_NATIVE_ONLY,
        swarmPeerId: null,
        swarmMultiaddrs: [],
        swarmPeerCount: 0,
        swarmLastEvent: null,
      });
      return;
    }

    set({ swarmLoading: true, swarmError: null });
    try {
      const status = await fetchPeerSwarmStatus();
      set({
        swarmPeerId: status.ourPeerId || null,
        swarmMultiaddrs: status.ourMultiaddrs,
        swarmPeerCount: status.peerCount,
        swarmLastEvent: status.lastEvent,
        swarmLoading: false,
        swarmError: null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      set({
        swarmLoading: false,
        swarmError: message,
        swarmPeerId: null,
        swarmMultiaddrs: [],
        swarmPeerCount: 0,
        swarmLastEvent: null,
      });
    }
  },
}));
