import { useEffect } from "react";
import { create } from "zustand";
import {
  isTauri,
  servitudeStart,
  servitudeStatus,
  servitudeStop,
} from "../api/servitude";

/**
 * INS-022: Foreground/background lifecycle glue for the embedded
 * servitude module.
 *
 * iOS (and Android, to a lesser extent) aggressively suspend background
 * apps, which means inbound sockets opened by the embedded servitude
 * die silently the moment Concord moves off-screen. Rather than ship a
 * server that looks "running" in the UI while it's actually unreachable
 * to every peer, we explicitly tear down the lifecycle on `tauri://blur`
 * and restart it on `tauri://focus`.
 *
 * Design choices:
 *
 *   1. The decision to pause/resume is driven by a *lifecycle-owned*
 *      flag (`pausedByLifecycle` in the store below), not by user
 *      intent. The user-intent flag is whether they tapped the toggle
 *      in Settings → Node to start hosting in the first place. When
 *      they didn't, we never touch the lifecycle. This prevents the
 *      surprising "my phone started hosting after I came back from
 *      Safari" failure mode.
 *
 *   2. We ALWAYS query `servitudeStatus` on blur before deciding to
 *      stop. If the user manually stopped hosting between starting it
 *      and backgrounding the app, we want to leave that state alone
 *      on return to foreground. The flag is only set when we observe
 *      `running` at blur time AND successfully drive it to stopped.
 *
 *   3. The hook is a no-op outside Tauri. In the browser there is no
 *      `tauri://blur` event, so `listen()` would return a stub that
 *      never fires — but we check `isTauri()` first to avoid the
 *      async import cost and the console noise from Tauri's IPC layer
 *      failing silently in a non-Tauri environment.
 *
 *   4. The module-level store below is intentionally tiny and separate
 *      from the main app settings store. The state is in-memory only
 *      (it does not persist across app launches); a fresh launch that
 *      happens to start with the app in the background will read
 *      `pausedByLifecycle=false`, notice the servitude state machine
 *      is also stopped, and do nothing — which is the right answer.
 *
 * Tests drive the hook by emitting real `tauri://blur` / `tauri://focus`
 * events through `@tauri-apps/api/event` so the code path is the same
 * in prod and in unit tests. See `useServitudeLifecycle.test.ts`.
 */

/**
 * In-process state for the lifecycle hook. Exposed as a Zustand store
 * so the UI can show a "paused while backgrounded" banner if we want
 * one later without re-plumbing the state.
 */
export interface ServitudeLifecycleState {
  /** True while we have paused servitude on behalf of a blur event. */
  pausedByLifecycle: boolean;
  /** Test/debug hook to reset the flag; do not call in prod code. */
  _reset: () => void;
  /** Used by the hook itself; exposed for direct mutation in tests. */
  _setPaused: (v: boolean) => void;
}

export const useServitudeLifecycleStore = create<ServitudeLifecycleState>((set) => ({
  pausedByLifecycle: false,
  _reset: () => set({ pausedByLifecycle: false }),
  _setPaused: (v) => set({ pausedByLifecycle: v }),
}));

/**
 * Wire the lifecycle handlers. Call from the top of `App.tsx` exactly
 * once — repeated mounts will add duplicate listeners.
 */
export function useServitudeLifecycle(): void {
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenBlur: (() => void) | null = null;
    let unlistenFocus: (() => void) | null = null;
    let cancelled = false;

    const handleBlur = async () => {
      try {
        const status = await servitudeStatus();
        if (status.state !== "running") return;
        await servitudeStop();
        useServitudeLifecycleStore.getState()._setPaused(true);
      } catch (err) {
        console.warn("[servitude-lifecycle] blur handler failed:", err);
      }
    };

    const handleFocus = async () => {
      const { pausedByLifecycle } = useServitudeLifecycleStore.getState();
      if (!pausedByLifecycle) return;
      try {
        await servitudeStart();
      } catch (err) {
        console.warn("[servitude-lifecycle] focus handler failed:", err);
      } finally {
        // Clear the flag whether the restart succeeded or not — otherwise
        // a one-time failure would wedge us into "always try to restart
        // on focus" forever. A failed restart surfaces in the NodeHosting
        // tab status poll just like any other stop event.
        useServitudeLifecycleStore.getState()._setPaused(false);
      }
    };

    // Dynamic import so the bundle doesn't pay for `@tauri-apps/api/event`
    // when the app runs in the browser.
    (async () => {
      try {
        const { listen, TauriEvent } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlistenBlur = await listen(TauriEvent.WINDOW_BLUR, handleBlur);
        if (cancelled) {
          unlistenBlur?.();
          unlistenBlur = null;
          return;
        }
        unlistenFocus = await listen(TauriEvent.WINDOW_FOCUS, handleFocus);
        if (cancelled) {
          unlistenFocus?.();
          unlistenFocus = null;
        }
      } catch (err) {
        console.warn("[servitude-lifecycle] failed to attach listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlistenBlur?.();
      unlistenFocus?.();
    };
  }, []);
}
