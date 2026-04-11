/**
 * tvOS WKWebView JS bridge client module.
 *
 * When running inside the Concord tvOS app (src-tvos/, Path C SwiftUI
 * shell), the native side injects message handlers into
 * `window.webkit.messageHandlers`. This module provides typed
 * TypeScript wrappers around the 4-function bridge API:
 *
 *   1. setServerConfig(config)  — persist server config to UserDefaults
 *   2. getServerConfig()        — load server config from UserDefaults
 *   3. focusChanged(elementId)  — notify native layer of DOM focus changes
 *   4. openAuthURL(url)         — delegate to ASWebAuthenticationSession
 *
 * All functions **no-op gracefully** when the bridge is not available
 * (every non-tvOS platform). This means any call site can unconditionally
 * invoke these without platform guards — they are safe on web, desktop,
 * Android, and iOS.
 *
 * The bridge detection is lazy: we check for the handler at call time
 * rather than import time, so hot-reload and test environments where
 * the bridge is injected late still work.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** The homeserver base URL (e.g. "https://matrix.example.com"). */
  homeserverUrl: string;
  /** Optional display name for the server. */
  serverName?: string;
  /** Optional access token if the user is already authenticated. */
  accessToken?: string;
}

/**
 * Shape of the WKWebView message handler bridge that the tvOS native
 * shell injects. Each handler has a `postMessage(body)` method.
 */
interface WebKitMessageHandler {
  postMessage(body: unknown): void;
}

interface WebKitMessageHandlers {
  concordSetServerConfig?: WebKitMessageHandler;
  concordGetServerConfig?: WebKitMessageHandler;
  concordFocusChanged?: WebKitMessageHandler;
  concordOpenAuthURL?: WebKitMessageHandler;
}

// Extend the Window type so TypeScript knows about the webkit bridge.
declare global {
  interface Window {
    webkit?: {
      messageHandlers?: WebKitMessageHandlers;
    };
  }
}

// ---------------------------------------------------------------------------
// Bridge detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the tvOS JS bridge is available in the current
 * runtime. Safe to call in any environment (web, Node, jsdom).
 */
export function isTvOSBridgeAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.webkit?.messageHandlers?.concordSetServerConfig?.postMessage === "function"
  );
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getHandler(name: keyof WebKitMessageHandlers): WebKitMessageHandler | null {
  if (typeof window === "undefined") return null;
  return window.webkit?.messageHandlers?.[name] ?? null;
}

// ---------------------------------------------------------------------------
// Bridge functions
// ---------------------------------------------------------------------------

/**
 * Persist server configuration to the native tvOS UserDefaults store.
 * No-ops on non-tvOS platforms.
 */
export function setServerConfig(config: ServerConfig): void {
  const handler = getHandler("concordSetServerConfig");
  if (!handler) return;
  handler.postMessage(config);
}

/**
 * Request the native tvOS layer to return the stored server config.
 *
 * The native bridge responds asynchronously by calling a JS callback
 * registered on `window`. This function sets up the one-shot callback
 * and returns a promise that resolves with the config (or null if
 * none was stored).
 *
 * On non-tvOS platforms, resolves immediately with null.
 */
export function getServerConfig(): Promise<ServerConfig | null> {
  const handler = getHandler("concordGetServerConfig");
  if (!handler) return Promise.resolve(null);

  return new Promise<ServerConfig | null>((resolve) => {
    // The native side calls window.__concordGetServerConfigCallback
    // with the JSON payload or null.
    const callbackName = "__concordGetServerConfigCallback";
    (window as unknown as Record<string, unknown>)[callbackName] = (config: ServerConfig | null) => {
      delete (window as unknown as Record<string, unknown>)[callbackName];
      resolve(config ?? null);
    };
    handler.postMessage({ callbackName });
  });
}

/**
 * Notify the native tvOS UIFocus system that DOM focus has changed.
 * The native layer uses this to keep its focus ring in sync with the
 * web bundle's roving tabindex managed by `useDpadNav`.
 *
 * No-ops on non-tvOS platforms.
 */
export function focusChanged(elementId: string): void {
  const handler = getHandler("concordFocusChanged");
  if (!handler) return;
  handler.postMessage({ elementId });
}

/**
 * Ask the native tvOS layer to open an authentication URL via
 * `ASWebAuthenticationSession`. This is used for OAuth flows where
 * the webview cannot handle the redirect itself.
 *
 * No-ops on non-tvOS platforms.
 */
export function openAuthURL(url: string): void {
  const handler = getHandler("concordOpenAuthURL");
  if (!handler) return;
  handler.postMessage({ url });
}
