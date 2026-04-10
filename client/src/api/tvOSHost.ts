/**
 * tvOS WKWebView host bridge.
 *
 * The tvOS app (src-tvos/) is a standalone SwiftUI shell that loads the
 * same client/dist bundle inside a WKWebView. At document-start the
 * Swift side injects a script that creates `window.concordTVHost` with
 * four methods. This module provides typed TypeScript wrappers that
 * feature-detect the bridge and no-op gracefully on every other
 * platform.
 *
 * The bridge namespace shape injected by Swift:
 *
 *   window.concordTVHost = {
 *     setServerConfig(json: string): void
 *     getServerConfig(): string | null
 *     focusChanged(elementId: string): void
 *     openAuthURL(url: string): void
 *     _focusCallbacks: Array<(elementId: string) => void>
 *   }
 *
 * On non-tvOS platforms `window.concordTVHost` is undefined and every
 * export below is a safe no-op.
 */

// ---------------------------------------------------------------------------
// Type augmentation for the injected bridge
// ---------------------------------------------------------------------------

interface ConcordTVHost {
  setServerConfig(json: string): void;
  getServerConfig(): string | null;
  focusChanged(elementId: string): void;
  openAuthURL(url: string): void;
  _focusCallbacks: Array<(elementId: string) => void>;
}

declare global {
  interface Window {
    concordTVHost?: ConcordTVHost;
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * True when running inside the tvOS WKWebView shell. Evaluated once at
 * module load — the bridge is injected before any JS runs, so the
 * value is stable for the lifetime of the page.
 */
export const isAppleTV: boolean =
  typeof window !== "undefined" && typeof window.concordTVHost !== "undefined";

// ---------------------------------------------------------------------------
// Bridge wrappers
// ---------------------------------------------------------------------------

export interface ServerConfig {
  api_base: string;
  homeserver_url: string;
  server_name: string;
}

/**
 * Persist a server configuration to the tvOS host's UserDefaults.
 * No-ops on non-tvOS platforms.
 */
export function setServerConfig(config: ServerConfig): void {
  if (!isAppleTV) return;
  try {
    window.concordTVHost!.setServerConfig(JSON.stringify(config));
  } catch (err) {
    console.warn("[tvOSHost] setServerConfig failed:", err);
  }
}

/**
 * Load the persisted server configuration from UserDefaults.
 * Returns null on non-tvOS platforms or if nothing is stored.
 */
export function getServerConfig(): ServerConfig | null {
  if (!isAppleTV) return null;
  try {
    const raw = window.concordTVHost!.getServerConfig();
    if (!raw) return null;
    return JSON.parse(raw) as ServerConfig;
  } catch (err) {
    console.warn("[tvOSHost] getServerConfig failed:", err);
    return null;
  }
}

/**
 * Register a callback for tvOS UIFocus changes bridged from the Swift
 * side. The callback receives the `id` attribute of the DOM element
 * that the UIFocus engine is pointing at.
 *
 * Returns an unsubscribe function. No-ops on non-tvOS platforms.
 */
export function onFocusChanged(cb: (elementId: string) => void): () => void {
  if (!isAppleTV) return () => {};
  const host = window.concordTVHost!;
  if (!host._focusCallbacks) {
    host._focusCallbacks = [];
  }
  host._focusCallbacks.push(cb);
  return () => {
    const idx = host._focusCallbacks.indexOf(cb);
    if (idx !== -1) host._focusCallbacks.splice(idx, 1);
  };
}

/**
 * Open an authentication URL via the tvOS host's
 * ASWebAuthenticationSession. Falls back to window.open on non-tvOS
 * platforms.
 */
export function openAuthURL(url: string): void {
  if (!isAppleTV) {
    // Fallback for non-tvOS: open in a new tab/window.
    window.open(url, "_blank");
    return;
  }
  try {
    window.concordTVHost!.openAuthURL(url);
  } catch (err) {
    console.warn("[tvOSHost] openAuthURL failed:", err);
  }
}
