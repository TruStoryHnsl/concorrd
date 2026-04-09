/**
 * Persistent server-configuration store (INS-027).
 *
 * The source of truth for which Concord instance the current client is
 * talking to. When empty, `getApiBase()` falls back to origin-based
 * resolution (the existing web-deployment behavior). When populated —
 * typically via the first-launch server-picker flow in
 * `ServerPickerScreen.tsx` — `getApiBase()` reads `config.api_base` so
 * every `apiFetch` call site automatically targets the selected host
 * without touching any of the 50+ call sites.
 *
 * Persistence strategy:
 *
 * - **Web build**: localStorage via Zustand's `persist` middleware. Same
 *   shape as `settings.ts`, same storage semantics. A fresh tab picks
 *   up the persisted config on hydration, which is what we want for
 *   native apps packaged as Tauri webview sessions.
 *
 * - **Tauri build**: the existing `serverUrl.ts` helpers already bridge
 *   to the Tauri `get_server_url` / `set_server_url` commands. This
 *   store mirrors the persisted value in-process (via the same
 *   localStorage shim that Tauri's webview exposes), so both the new
 *   serverConfig slice AND the legacy `serverUrl.ts` functions stay in
 *   sync. The legacy helpers remain the official read path for other
 *   parts of the code that branch on `isDesktopMode()` — we intentionally
 *   do NOT delete them in this task, to keep the INS-027 refactor
 *   strictly additive.
 *
 * Detection of the Tauri branch follows the same convention as
 * `serverUrl.ts`: `typeof window !== "undefined" && "__TAURI__" in window`.
 * This is checked lazily at runtime rather than at module import so
 * tests (which run in jsdom) can stub it.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HomeserverConfig } from "../api/wellKnown";
// `serverUrl.ts` is safe to static-import in jsdom tests — it has its
// own `isTauri()` guard and only dynamic-imports `@tauri-apps/api/core`
// inside async functions. Using a static import here lets `vi.mock()`
// in tests intercept it cleanly; a dynamic `import()` would bypass
// the hoisted mock and give us the real function instead.
import { setServerUrl } from "../api/serverUrl";

/**
 * The Zustand state shape. `config` is the full HomeserverConfig
 * produced by `discoverHomeserver()`, or `null` when no server has
 * been picked yet (default for fresh native app launches and for the
 * web build where origin-based fallback takes over).
 */
export interface ServerConfigState {
  config: HomeserverConfig | null;
  setHomeserver: (config: HomeserverConfig) => void;
  clearHomeserver: () => void;
  /**
   * Convenience selector returning just the hostname (or null). Useful
   * for UI elements that want to display "connected to {host}" without
   * pulling the full config object into render state.
   */
  selectedHost: () => string | null;
}

/**
 * Storage key for both localStorage and the Tauri persistence bridge.
 * Keep in sync with any migration code that reads legacy keys — at
 * present there is no legacy slot to migrate from, this is a brand
 * new store.
 */
const STORAGE_KEY = "concord_server_config";

/**
 * Detect whether the current runtime is Tauri. Matches the convention
 * in `serverUrl.ts` (`typeof window !== "undefined" && "__TAURI__" in
 * window`). Pulled out as a function so tests can mock it via
 * `vi.stubGlobal` without having to rewrite the module import chain.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

export const useServerConfigStore = create<ServerConfigState>()(
  persist(
    (set, get) => ({
      config: null,

      setHomeserver: (config) => {
        set({ config });
        // Best-effort bridge to the Tauri-side store. The legacy
        // `setServerUrl` helper persists to Tauri's own store via
        // `invoke("set_server_url")`; we fire-and-forget so web builds
        // don't pay any cost. Persistence failures are non-fatal —
        // the in-memory store is still updated and the current
        // session continues. The user will need to re-pick on next
        // launch; surfacing this as a toast is UI-level concern.
        if (isTauriRuntime()) {
          // Use the homeserver URL as the Tauri-side server URL so
          // Matrix SDK code paths reading `getHomeserverUrl()`
          // continue to work. The Concord API base lives in this
          // store for the `getApiBase()` refactor to read.
          void setServerUrl(config.homeserver_url).catch(() => {
            /* non-fatal — see comment above */
          });
        }
      },

      clearHomeserver: () => {
        set({ config: null });
        if (isTauriRuntime()) {
          void setServerUrl("").catch(() => {
            /* non-fatal — see setHomeserver */
          });
        }
      },

      selectedHost: () => {
        const cfg = get().config;
        return cfg ? cfg.host : null;
      },
    }),
    {
      name: STORAGE_KEY,
      // `createJSONStorage` with an explicit getter lets the persist
      // middleware gracefully no-op when localStorage isn't available
      // (e.g. SSR or locked-down iframe contexts) rather than throwing
      // at module load time.
      storage: createJSONStorage(() =>
        typeof window !== "undefined" && window.localStorage
          ? window.localStorage
          : {
              // In-memory shim so the middleware stays happy when no
              // localStorage exists. Reset per page load — acceptable
              // for the degenerate case.
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            },
      ),
      // Only `config` is persisted — selectors and actions don't
      // belong in storage. This also future-proofs against adding
      // non-serializable fields later.
      partialize: (state) => ({ config: state.config }),
    },
  ),
);
