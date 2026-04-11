/**
 * Tests for `usePlatform()` / `getPlatformFlags()`.
 *
 * Covers the three detection branches that are load-bearing for the
 * mobile + TV native build story:
 *
 *   1. iPhone / older iPad via UA substring
 *   2. Modern iPad that reports as desktop Safari (UA=Macintosh +
 *      touchpoints>1)
 *   3. Google TV / Android TV via pointer: none + large viewport
 */

import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { getPlatformFlags, usePlatform } from "../usePlatform";

interface MockedNavigator {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

type MediaQueryMap = Partial<Record<string, boolean>>;

/**
 * Remember the real navigator properties so we can restore them
 * between tests. `vi.stubGlobal("navigator", ...)` would replace the
 * whole navigator object, which zustand's persist middleware and
 * other modules captured at import time — that would break every
 * test that follows this one in the same run.
 */
const ORIGINAL_NAVIGATOR = {
  userAgent: navigator.userAgent,
  platform: (navigator as { platform?: string }).platform ?? "",
  maxTouchPoints: navigator.maxTouchPoints ?? 0,
};

function stubNavigator(n: MockedNavigator) {
  Object.defineProperty(navigator, "userAgent", {
    value: n.userAgent,
    configurable: true,
  });
  Object.defineProperty(navigator, "platform", {
    value: n.platform,
    configurable: true,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    value: n.maxTouchPoints,
    configurable: true,
  });
}

function restoreNavigator() {
  Object.defineProperty(navigator, "userAgent", {
    value: ORIGINAL_NAVIGATOR.userAgent,
    configurable: true,
  });
  Object.defineProperty(navigator, "platform", {
    value: ORIGINAL_NAVIGATOR.platform,
    configurable: true,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    value: ORIGINAL_NAVIGATOR.maxTouchPoints,
    configurable: true,
  });
}

function stubWindow(opts: {
  innerWidth?: number;
  innerHeight?: number;
  matchMedia?: MediaQueryMap;
  tauri?: boolean;
}) {
  const mql = (query: string) => ({
    matches: (opts.matchMedia && opts.matchMedia[query]) === true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });

  // Only override the specific properties we care about on the real
  // jsdom window, rather than replacing the entire object. Using
  // `vi.stubGlobal("window", …)` would clobber window.localStorage
  // and other properties that zustand's persist middleware captures
  // at module import time — breaking every other test file that
  // imports the serverConfig store.
  const realWindow = window as unknown as Record<string, unknown>;
  realWindow.innerWidth = opts.innerWidth ?? 1024;
  realWindow.innerHeight = opts.innerHeight ?? 768;
  realWindow.matchMedia = mql;
  if (opts.tauri) {
    // Match the real Tauri v2 global — `@tauri-apps/api` itself reads
    // from `__TAURI_INTERNALS__`, and the production detection code in
    // `usePlatform.ts` / `serverUrl.ts` / `serverConfig.ts` / etc. all
    // check this key. Using the v1 `__TAURI__` name here was how the
    // original INS-020 regression hid behind green tests — the real
    // native build never saw that key, so `isTauri` was always false.
    realWindow.__TAURI_INTERNALS__ = { invoke: () => {} };
  } else {
    delete realWindow.__TAURI_INTERNALS__;
  }
}

// Remember the real matchMedia / innerWidth / innerHeight so we can
// put them back after each test.
const ORIGINAL_WINDOW = {
  matchMedia: window.matchMedia,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
};

afterEach(() => {
  restoreNavigator();
  const realWindow = window as unknown as Record<string, unknown>;
  realWindow.matchMedia = ORIGINAL_WINDOW.matchMedia;
  realWindow.innerWidth = ORIGINAL_WINDOW.innerWidth;
  realWindow.innerHeight = ORIGINAL_WINDOW.innerHeight;
  delete realWindow.__TAURI_INTERNALS__;
});

describe("getPlatformFlags", () => {
  it("detects a modern iPad that reports as Macintosh UA", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    stubWindow({
      innerWidth: 1024,
      innerHeight: 768,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": true,
        "(pointer: none)": false,
      },
    });

    const flags = getPlatformFlags();

    expect(flags.isIOS).toBe(true);
    expect(flags.isIPad).toBe(true);
    expect(flags.isMobile).toBe(true);
    expect(flags.isTV).toBe(false);
    expect(flags.hasPointer).toBe(false);
    expect(flags.hasTouchOnly).toBe(true);
  });

  it("detects a classic iPhone UA", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    stubWindow({
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": true,
        "(pointer: none)": false,
      },
    });

    const flags = getPlatformFlags();

    expect(flags.isIOS).toBe(true);
    expect(flags.isIPad).toBe(false);
    expect(flags.isMobile).toBe(true);
    expect(flags.isTV).toBe(false);
  });

  it("detects an Android phone", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    stubWindow({
      innerWidth: 412,
      innerHeight: 915,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": true,
        "(pointer: none)": false,
      },
    });

    const flags = getPlatformFlags();

    expect(flags.isAndroid).toBe(true);
    expect(flags.isIOS).toBe(false);
    expect(flags.isMobile).toBe(true);
    expect(flags.isTV).toBe(false);
  });

  it("detects Google TV via pointer:none + large viewport", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K UR2 Build/PTT1.220523.001.S246) AppleWebKit/537.36 Chrome/108.0.0.0 Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 0,
    });
    stubWindow({
      innerWidth: 1920,
      innerHeight: 1080,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": false,
        "(pointer: none)": true,
      },
    });

    const flags = getPlatformFlags();

    expect(flags.isTV).toBe(true);
    expect(flags.isAndroidTV).toBe(true);
    expect(flags.isAppleTV).toBe(false);
    // TVs are explicitly NOT mobile even though they run Android.
    expect(flags.isMobile).toBe(false);
  });

  it("detects Android TV via UA substring and sets isAndroidTV", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Linux; Android 12; Chromecast HD Build/STTE.240507.002) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36 Android TV",
      platform: "Linux armv8l",
      maxTouchPoints: 0,
    });
    stubWindow({
      innerWidth: 1920,
      innerHeight: 1080,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": false,
        "(pointer: none)": true,
      },
    });

    const flags = getPlatformFlags();

    expect(flags.isTV).toBe(true);
    expect(flags.isAndroidTV).toBe(true);
    expect(flags.isAppleTV).toBe(false);
    expect(flags.isMobile).toBe(false);
  });

  it("detects Apple TV via AppleTV UA string", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (AppleTV; U; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      platform: "AppleTV",
      maxTouchPoints: 0,
    });
    stubWindow({
      innerWidth: 1920,
      innerHeight: 1080,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": false,
        "(pointer: none)": true,
      },
    });

    const flags = getPlatformFlags();

    expect(flags.isTV).toBe(true);
    expect(flags.isAppleTV).toBe(true);
    expect(flags.isAndroidTV).toBe(false);
    expect(flags.isMobile).toBe(false);
  });

  it("does not set isAndroidTV or isAppleTV for a regular phone", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    stubWindow({
      innerWidth: 412,
      innerHeight: 915,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": true,
        "(pointer: none)": false,
      },
    });

    const flags = getPlatformFlags();

    expect(flags.isAndroidTV).toBe(false);
    expect(flags.isAppleTV).toBe(false);
    expect(flags.isTV).toBe(false);
  });

  it("detects TV via UA substring when matchMedia is inconclusive", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Linux; Tizen 6.5) AppleWebKit/537.36 SmartTV Safari/537.36",
      platform: "Linux",
      maxTouchPoints: 0,
    });
    stubWindow({
      innerWidth: 1280,
      innerHeight: 720,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": false,
        "(pointer: none)": false,
      },
    });

    expect(getPlatformFlags().isTV).toBe(true);
  });

  it("recognises the Tauri runtime", () => {
    stubNavigator({
      userAgent: "Mozilla/5.0 desktop",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    stubWindow({
      tauri: true,
      matchMedia: {
        "(pointer: fine)": true,
      },
    });

    expect(getPlatformFlags().isTauri).toBe(true);
  });
});

describe("usePlatform hook", () => {
  it("returns the same shape as getPlatformFlags and re-evaluates on mount", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    stubWindow({
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: {
        "(pointer: fine)": false,
        "(pointer: coarse)": true,
      },
    });

    const { result } = renderHook(() => usePlatform());

    expect(result.current.isIOS).toBe(true);
    expect(result.current.isMobile).toBe(true);
    expect(result.current.hasPointer).toBe(false);
  });
});
