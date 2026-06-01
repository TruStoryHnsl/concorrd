/**
 * Zustand surface for the persistent HOME server's user-set name.
 *
 * The home server is the user's persistent local data layer (see the
 * 2026-06-01 CONSOLIDATED ARCHITECTURE filing in
 * `instructions_inbox.md`). Its default name is `"home"`; the user
 * can rename it via the Tauri command `home_set_server_name`.
 *
 * Storage backs onto the new `home_meta` table inside the existing
 * `porch.sqlite` (schema version 8). The module + file rename from
 * `porch` → `home` is a follow-up PR; this store deliberately uses
 * the new "home" vocabulary so the renderer doesn't grow porch-isms.
 *
 * Web behavior: `name` stays at the default `"home"` forever and
 * `set()` rejects. The web build has no persistent SQLite layer to
 * write to.
 *
 * Hydration: `load()` is idempotent and safe to call multiple times.
 * `LocalServerSidebar` calls it on mount so the home tile renders the
 * persisted name from first paint.
 */

import { create } from "zustand";
import {
  getHomeServerName,
  setHomeServerName as setRemote,
} from "../api/homeServer";
import { isTauri } from "../api/servitude";

interface HomeServerNameState {
  /** Current user-set name for the home server. Defaults to `"home"`. */
  name: string;
  /** True while the initial hydration / a save is in flight. */
  loading: boolean;
  /** Last error from a load/save round-trip, or `null`. */
  error: string | null;
  /** Refresh from the persisted home_meta row. No-op on web. */
  load: () => Promise<void>;
  /** Persist a new name. Trims, validates non-empty + ≤64 chars. */
  set: (name: string) => Promise<void>;
}

export const useHomeServerNameStore = create<HomeServerNameState>((set) => ({
  name: "home",
  loading: false,
  error: null,
  load: async () => {
    if (!isTauri()) {
      // Web builds: no persistent home server. Keep the default and
      // skip the IPC round-trip.
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
        "useHomeServerNameStore.set: web builds cannot rename the home server",
      );
    }
    set({ loading: true, error: null });
    try {
      await setRemote(name);
      set({ name: name.trim(), loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },
}));
