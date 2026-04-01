/**
 * Server URL management for web and desktop (Tauri) modes.
 *
 * Web mode: uses relative URLs (same origin, proxied by Caddy)
 * Desktop mode: uses a configured remote server URL stored via Tauri plugin-store
 *
 * The server URL is the base for both the Concord API (/api/*) and
 * the Matrix homeserver (/_matrix/*) since Caddy proxies both.
 */

// Detect Tauri environment
const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

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
 * Web: "/api", Desktop: "https://server.example.com/api"
 */
export function getApiBase(): string {
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
