/**
 * Server URL management for web and desktop (Tauri) modes.
 *
 * Web mode: uses relative URLs (same origin, proxied by Caddy)
 * Desktop mode: uses a configured remote server URL stored via Tauri plugin-store
 *
 * The server URL is the base for both the Concord API (/api/*) and
 * the Matrix homeserver (/_matrix/*) since Caddy proxies both.
 *
 * INS-027 note: this module now consults the `serverConfig` Zustand
 * store inside `getApiBase()`. The store is the source of truth for
 * the first-launch server-picker flow; the legacy `_serverUrl`
 * module-var path remains as a fallback for Tauri builds that haven't
 * been through the picker yet and for the web deployment.
 */

import { useServerConfigStore } from "../stores/serverConfig";

// Detect Tauri environment.
//
// Tauri v2 injects `window.__TAURI_INTERNALS__` — that's the canonical
// global the `@tauri-apps/api` package itself consults (`core.cjs` calls
// `window.__TAURI_INTERNALS__.invoke(...)`). The legacy `window.__TAURI__`
// from Tauri v1 is ONLY present when `app.withGlobalTauri: true` is
// explicitly opted into in `tauri.conf.json`, which this project does
// not set. Checking the v1 key here always returned `false` in the real
// native webview, causing `hasServerUrl()` to short-circuit `true` and
// bypass the first-launch server picker. Fixed per the INS-027 regression
// investigation on 2026-04-10.
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Cached server URL — set on app startup in desktop mode
let _serverUrl = "";

/**
 * Initialize the server URL. Call this on app startup before any API calls.
 * In web mode, this is a no-op (relative URLs work).
 * In desktop mode, reads the stored URL from Tauri settings.
 */
export async function initServerUrl(): Promise<void> {
  if (!isTauri) return; // web mode — relative URLs

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const url = await invoke<string>("get_server_url");
    if (url) {
      _serverUrl = url.replace(/\/$/, ""); // strip trailing slash
    }
  } catch (e) {
    console.warn("Failed to load server URL from Tauri store:", e);
  }
}

/**
 * Set the server URL (desktop mode only). Persists to Tauri store.
 */
export async function setServerUrl(url: string): Promise<void> {
  const cleaned = url.replace(/\/$/, "");
  _serverUrl = cleaned;

  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_server_url", { url: cleaned });
    } catch (e) {
      console.warn("Failed to save server URL to Tauri store:", e);
    }
  }
}

/**
 * Get the current server base URL.
 * Returns "" in web mode (use relative URLs).
 * Returns "https://server.example.com" in desktop mode.
 */
export function getServerUrl(): string {
  return _serverUrl;
}

/**
 * Get the API base URL for Concord API calls.
 *
 * Resolution order (INS-027):
 *   1. `serverConfig` Zustand store — source of truth for native
 *      apps that have been through the first-launch server picker.
 *      Returns the `api_base` discovered via `.well-known/concord/client`.
 *   2. Legacy `_serverUrl` module-var — set by `initServerUrl()` /
 *      `setServerUrl()` from the Tauri-side plugin-store. Still used
 *      by pre-INS-027 Tauri builds and by code paths that call
 *      `setServerUrl()` directly.
 *   3. Origin fallback — returns `/api` so the browser build keeps
 *      working without any config at all (Caddy on the same origin
 *      proxies `/api/*` to `concord-api`).
 *
 * The signature is synchronous and unchanged from its pre-INS-027
 * version. The ~50 `apiFetch` call sites across the client continue
 * to work without modification — the resolution is entirely internal.
 */
export function getApiBase(): string {
  // Read from the INS-027 store first. Dynamic state access (not a
  // subscription) keeps this function side-effect-free and callable
  // from non-React contexts.
  try {
    const cfg = useServerConfigStore.getState().config;
    if (cfg?.api_base) {
      return cfg.api_base;
    }
  } catch {
    // Store hasn't hydrated yet (unlikely in practice; persist
    // middleware hydrates synchronously from localStorage). Fall
    // through to the legacy path.
  }
  return _serverUrl ? `${_serverUrl}/api` : "/api";
}

/**
 * Get the homeserver URL for Matrix client.
 * Web: window.location.origin, Desktop: stored server URL
 */
export function getHomeserverUrl(): string {
  return _serverUrl || window.location.origin;
}

/**
 * Whether we're running in Tauri desktop mode.
 */
export function isDesktopMode(): boolean {
  return isTauri;
}

/**
 * Whether a server URL has been configured (always true in web mode).
 */
export function hasServerUrl(): boolean {
  return !isTauri || _serverUrl.length > 0;
}
