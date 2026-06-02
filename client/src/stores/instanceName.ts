/**
 * Zustand surface for the vanity instance name.
 *
 * Lives separately from {@link useSourcesStore} because the local
 * source is not in that store — the local rail tile is rendered
 * intrinsically and only needs the vanity name to display its label.
 *
 * `name === ""` means the user has not picked a name yet — UI
 * components should render their default ("local") in that case
 * rather than treating the empty string as the intended label.
 *
 * Hydration: `load()` is idempotent and safe to call multiple times
 * (it just re-fetches from the persisted store). It's called once
 * on Tauri-build startup by `main.tsx` so the rail label is correct
 * from first paint.
 */

import { create } from "zustand";
import { getInstanceName, setInstanceName as setRemote } from "../api/instanceName";
import { isTauri } from "../api/servitude";

interface InstanceNameState {
  /** Current vanity instance name. Empty string means "not picked". */
  name: string;
  /** True while the initial hydration / a save is in flight. */
  loading: boolean;
  /** Last error from a load/save round-trip, or `null`. */
  error: string | null;
  /** Refresh from the persisted Tauri store. No-op on web builds. */
  load: () => Promise<void>;
  /** Persist a new name. Empty / whitespace clears the user-set value. */
  set: (name: string) => Promise<void>;
}

export const useInstanceNameStore = create<InstanceNameState>((set) => ({
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
      const value = await getInstanceName();
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
        "useInstanceNameStore.set: web builds cannot change the instance name",
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
