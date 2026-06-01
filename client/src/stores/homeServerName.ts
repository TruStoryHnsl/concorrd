/**
 * Zustand surface for the home-server vanity name.
 *
 * Sibling of {@link useInstanceNameStore}. The local source on a fresh
 * install has TWO names the user cares about:
 *
 *   1. The source-rail label (what peers see when they reach this
 *      device) — `useInstanceNameStore`, default "local".
 *   2. The home server's name (the persistent default server inside
 *      the local source) — THIS store, default "home".
 *
 * `name === ""` means the user has not picked a name yet — UI
 * components should render their default ("home") in that case rather
 * than treating the empty string as the intended label.
 *
 * Implementation note: the backing Tauri command ships with F1b-IMPL.
 * Until that lands the `set()` call still updates the in-memory store
 * so the rest of the session sees the new name immediately; persistence
 * starts working the moment F1b's command registers. See
 * `client/src/api/homeServerName.ts` for the no-op-on-missing-command
 * detail.
 */

import { create } from "zustand";
import {
  getHomeServerName,
  setHomeServerName as setRemote,
} from "../api/homeServerName";
import { isTauri } from "../api/servitude";

interface HomeServerNameState {
  /** Current home-server vanity name. Empty means "not picked". */
  name: string;
  /** True while the initial hydration / a save is in flight. */
  loading: boolean;
  /** Last error from a load/save round-trip, or `null`. */
  error: string | null;
  /** Refresh from the persisted Tauri store. No-op on web builds. */
  load: () => Promise<void>;
  /** Persist a new name. Whitespace is trimmed; empty clears the value. */
  set: (name: string) => Promise<void>;
}

export const useHomeServerNameStore = create<HomeServerNameState>((set) => ({
  name: "",
  loading: false,
  error: null,
  load: async () => {
    if (!isTauri()) {
      // Web builds: the docker stack picks the label at compose time;
      // the client never reads or writes it.
      return;
    }
    set({ loading: true, error: null });
    try {
      const value = await getHomeServerName();
      set({ name: value, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
  set: async (name: string) => {
    if (!isTauri()) {
      throw new Error(
        "useHomeServerNameStore.set: web builds cannot change the home-server name",
      );
    }
    const trimmed = name.trim();
    set({ loading: true, error: null });
    try {
      await setRemote(trimmed);
      set({ name: trimmed, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },
}));
