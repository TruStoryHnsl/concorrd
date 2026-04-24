import { create } from "zustand";

/**
 * Boot-splash readiness signal.
 *
 * The pre-React `#boot-splash` element in `index.html` paints
 * immediately on hard refresh. The React `<LaunchAnimation/>`
 * timing coordinator decides when to hand it off (see
 * `bootSplash.ts#handoffBootSplash`). The handoff used to fire as
 * soon as `useAuthStore.isLoading` flipped false — but auth restore
 * resolves long before the actual UI screens have mounted, so the
 * splash dismissed mid-animation while the user was still staring
 * at a blank screen waiting for the first paint.
 *
 * This store carries the "we have actually rendered something the
 * user can interact with" signal. Terminal screens (ChatLayout,
 * LoginForm, ServerPickerScreen, DockerFirstBootScreen, SubmitPage)
 * call `markAppReady()` from a useEffect on mount, after the first
 * paint commits. LaunchAnimation watches `isAppReady` as part of
 * its handoff gate — splash doesn't dismiss until the underlying
 * UI is genuinely up.
 *
 * `markAppReady` is idempotent. StrictMode double-mounts and
 * subsequent screen transitions are no-ops once the flag has flipped
 * true (the splash is already gone by then).
 */

interface BootReadyState {
  isAppReady: boolean;
  markAppReady: () => void;
}

export const useBootReadyStore = create<BootReadyState>((set, get) => ({
  isAppReady: false,
  markAppReady: () => {
    if (get().isAppReady) return;
    set({ isAppReady: true });
  },
}));
