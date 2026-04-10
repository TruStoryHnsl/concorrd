/**
 * Pure helper for deciding whether the first-launch server picker
 * should be shown on mount.
 *
 * This was previously an inline ternary inside `App.tsx`. It moved
 * into its own file so INS-020 (native mobile) and INS-027 (server
 * picker flow) have a single testable decision point instead of
 * drifting copies of the same gate logic across the client.
 *
 * The rule in plain English:
 *
 *   Show the picker (return `false` for "connected") when the app is
 *   running on a platform that has no implicit server association —
 *   i.e. a Tauri desktop/native build OR a mobile browser — AND no
 *   homeserver config has been resolved yet (neither the modern
 *   `serverConfig` store nor the legacy Tauri `_serverUrl` value).
 *
 *   Skip the picker (return `true`) when:
 *     - The build is desktop web (not Tauri, not mobile). Caddy on the
 *       same origin proxies /api/*, so `getApiBase()` falls back to
 *       `/api` without any user action needed.
 *     - A HomeserverConfig is already in the persisted store.
 *     - The legacy `_serverUrl` slot is populated (grandfathered Tauri
 *       installs that configured a server before INS-027 shipped).
 *
 * Keeping this as a pure function means the test suite can cover all
 * eight boolean combinations cheaply without having to mount the
 * whole App tree.
 */

export interface GateInputs {
  /** True when running inside a Tauri webview (desktop OR mobile). */
  isDesktop: boolean;
  /** True when the viewport / UA indicates a mobile device. */
  isMobile: boolean;
  /** True when running on a TV device (Apple TV, Google TV, etc.). */
  isTV?: boolean;
  /** True when the INS-027 serverConfig store has a HomeserverConfig. */
  hasNewConfig: boolean;
  /**
   * True when the legacy `_serverUrl` module-var from serverUrl.ts is
   * populated (Tauri-side plugin-store). Pre-INS-027 Tauri installs
   * used this as the sole persistence slot.
   */
  hasLegacyUrl: boolean;
}

/**
 * Return `true` when the app can proceed straight to the normal shell
 * (meaning: treat the server as "connected"); return `false` when the
 * picker should be shown first.
 */
export function computeInitialServerConnected(inputs: GateInputs): boolean {
  const { isDesktop, isMobile, isTV = false, hasNewConfig, hasLegacyUrl } = inputs;

  // Short-circuit: any existing homeserver configuration means the
  // picker is not needed, regardless of platform.
  if (hasNewConfig || hasLegacyUrl) return true;

  // Platforms that have an implicit origin-based server association
  // (desktop web via Caddy) can boot straight into the shell.
  if (!isDesktop && !isMobile && !isTV) return true;

  // Tauri desktop, Tauri mobile, mobile web, or TV with no config —
  // show the picker.
  return false;
}
