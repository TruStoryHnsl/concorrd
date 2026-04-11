/**
 * Platform detection hook for mobile + TV native builds.
 *
 * Returns a flag set describing the current runtime so React code can
 * branch on "am I on an iPad?" or "am I on Google TV with a remote?"
 * without sprinkling user-agent regexes across dozens of components.
 *
 * Detection strategy (layered fallbacks — no build-time branching, so
 * the same bundle can ship to web + Tauri + mobile + TV):
 *
 *   1. `isTauri` — `__TAURI_INTERNALS__` key on `window` (the canonical
 *      Tauri v2 global, see `api/serverUrl.ts` for the explanation of
 *      why the v1 `__TAURI__` key is not used). Lazy at render time so
 *      jsdom tests can stub it.
 *
 *   2. `isIOS` / `isAndroid` — user-agent substring match. The Tauri v2
 *      iOS and Android webviews expose their real platform in the UA
 *      string, so this works identically for web and native.
 *
 *   3. `isIPad` — the tricky one. Modern iPads on iOS 13+ report their
 *      UA as desktop Safari to get the full-width web experience. The
 *      only reliable signal is: UA contains "Macintosh" AND the device
 *      has a touchscreen (navigator.maxTouchPoints > 1). iPhone/iPad on
 *      older iOS versions still report "iPad" in the UA, so we check
 *      that first.
 *
 *   4. `isTV` — heuristic union:
 *        a) UA contains "TV", "BRAVIA", "SmartTV", "AppleTV", "Tizen",
 *           "WebOS", "Hbbtv", or "Android TV"
 *        b) OR (matchMedia("(pointer: none)") AND screen >= 1920px)
 *      The second branch catches Google TV devices where Chrome reports
 *      a generic Android UA but matchMedia correctly knows there's no
 *      touch or mouse — only a remote.
 *
 *   5. `isMobile` — derived: iOS or Android, OR a phone-sized viewport
 *      with a touchscreen and no mouse.
 *
 *   6. `hasPointer` — `matchMedia("(pointer: fine)")` — true for mice,
 *      styluses, iPad Pencils; false for pure touch or remote-only.
 *
 *   7. `hasTouchOnly` — `matchMedia("(pointer: coarse)")` AND NOT
 *      `hasPointer` — true for phones and tablets in touch-first mode.
 *
 * Everything is evaluated lazily inside a `useMemo` keyed on
 * `window.innerWidth`, `window.innerHeight`, and a `resize` listener so
 * orientation changes / iPad split view re-layouts flip the flags
 * automatically.
 */

import { useEffect, useMemo, useState } from "react";

export interface PlatformFlags {
  /** Running inside a Tauri webview (desktop OR mobile). */
  isTauri: boolean;
  /** Any mobile device — phone or tablet, native or web. */
  isMobile: boolean;
  /** iOS device (iPhone or iPad). */
  isIOS: boolean;
  /** Android device (phone, tablet, or TV). */
  isAndroid: boolean;
  /** iPad specifically (either iPadOS or desktop-Safari-reported iPad). */
  isIPad: boolean;
  /** TV device (Google TV, Android TV, Fire TV, LG webOS, Samsung Tizen…). */
  isTV: boolean;
  /** Google TV or Android TV specifically (isAndroid && isTV). */
  isAndroidTV: boolean;
  /** Apple TV running tvOS (UA contains "AppleTV" or platform is tvOS). */
  isAppleTV: boolean;
  /** A precise pointing device is available (mouse, pencil, trackpad). */
  hasPointer: boolean;
  /** Only coarse pointers (fingers) — no mouse at all. */
  hasTouchOnly: boolean;
}

/**
 * Default flags returned in SSR-ish or jsdom contexts without a DOM.
 * The component tree boots with these as the first-render value; a
 * real evaluation runs immediately after mount.
 */
const DEFAULT_FLAGS: PlatformFlags = {
  isTauri: false,
  isMobile: false,
  isIOS: false,
  isAndroid: false,
  isIPad: false,
  isTV: false,
  isAndroidTV: false,
  isAppleTV: false,
  hasPointer: true,
  hasTouchOnly: false,
};

function detectPlatform(): PlatformFlags {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return DEFAULT_FLAGS;
  }

  const ua = navigator.userAgent || "";
  const platform = (navigator as { platform?: string }).platform || "";
  const maxTouchPoints = navigator.maxTouchPoints || 0;

  // `__TAURI_INTERNALS__` is the canonical Tauri v2 global — the v1
  // `__TAURI__` key is only injected when `app.withGlobalTauri: true` is
  // explicitly opted into (it isn't, in this project). See the detailed
  // comment in `serverUrl.ts`.
  const isTauri = "__TAURI_INTERNALS__" in window;

  const isIOSOld = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Macintosh. Use touchscreen presence to
  // disambiguate — no mac has >1 touchpoints at the DOM level.
  const isIPadDesktopUA = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const isIOS = isIOSOld || isIPadDesktopUA || platform === "iOS";
  // iPad must be explicitly identified either by a UA string that
  // contains "iPad" or by the "Macintosh with touch" signal. iPhones
  // also report maxTouchPoints > 1, so we cannot rely on that alone.
  const isIPad = /iPad/.test(ua) || isIPadDesktopUA;

  const isAndroid = /Android/i.test(ua);

  // TV detection — UA strings first, then matchMedia fallback.
  const tvUaSignals =
    /\b(TV|BRAVIA|SmartTV|Smart-TV|AppleTV|Tizen|WebOS|Hbbtv|GoogleTV|Android TV)\b/i;
  const isTVFromUA = tvUaSignals.test(ua);

  let hasPointer = true;
  let hasTouchOnly = false;
  let noPointer = false;
  let bigScreen = false;
  if (typeof window.matchMedia === "function") {
    try {
      hasPointer = window.matchMedia("(pointer: fine)").matches;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      noPointer = window.matchMedia("(pointer: none)").matches;
      hasTouchOnly = coarse && !hasPointer;
      bigScreen =
        (window.innerWidth || 0) >= 1920 || (window.innerHeight || 0) >= 1080;
    } catch {
      // matchMedia failed — fall back to defaults.
    }
  }
  const isTV = isTVFromUA || (noPointer && bigScreen);

  // Sub-TV platform detection — which TV family are we on?
  const isAndroidTV = isAndroid && isTV;
  const isAppleTV = /AppleTV/i.test(ua) || /tvOS/i.test(ua);

  // "Mobile" = handheld or tablet in touch-first mode. iPads count as
  // mobile for layout purposes; TVs do NOT count as mobile.
  const isMobile =
    !isTV && (isIOS || isAndroid || (hasTouchOnly && !hasPointer));

  return {
    isTauri,
    isMobile,
    isIOS,
    isAndroid,
    isIPad,
    isTV,
    isAndroidTV,
    isAppleTV,
    hasPointer,
    hasTouchOnly,
  };
}

/**
 * React hook — returns the current platform flags and re-evaluates on
 * window resize / orientation change. Mount triggers an immediate
 * detection pass so the first meaningful render already has real
 * values (the DEFAULT_FLAGS are only visible for the initial paint in
 * edge cases).
 */
export function usePlatform(): PlatformFlags {
  const [flags, setFlags] = useState<PlatformFlags>(() => detectPlatform());

  useEffect(() => {
    // Re-evaluate once on mount in case the first render was SSR or
    // before `__TAURI_INTERNALS__` injection completed.
    setFlags(detectPlatform());

    if (typeof window === "undefined") return;

    const handler = () => setFlags(detectPlatform());
    window.addEventListener("resize", handler);
    window.addEventListener("orientationchange", handler);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("orientationchange", handler);
    };
  }, []);

  // Memoize the returned object so consumers using it in
  // `useEffect` deps don't thrash.
  return useMemo(() => flags, [flags]);
}

/**
 * Non-hook variant — useful from non-React code paths (e.g. Zustand
 * actions, utility modules that need to branch on platform without
 * subscribing to resize events).
 */
export function getPlatformFlags(): PlatformFlags {
  return detectPlatform();
}
