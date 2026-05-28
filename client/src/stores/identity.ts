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
import { isTauri } from "../api/servitude";

/** Sentinel string for the no-Tauri (browser/web) case. UI components can
 *  compare against this constant to switch into the native-only placeholder
 *  rendering path. */
export const IDENTITY_ERROR_NATIVE_ONLY = "native-only";

export interface IdentityState {
  fingerprint: string | null;
  publicKeyHex: string | null;
  isLoading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useIdentityStore = create<IdentityState>((set) => ({
  fingerprint: null,
  publicKeyHex: null,
  isLoading: false,
  error: null,

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
}));
