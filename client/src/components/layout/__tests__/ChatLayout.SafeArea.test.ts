// @ts-nocheck — test file uses Node.js fs/path APIs that the app tsconfig
// doesn't include. vitest has its own config that handles this.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import chatLayoutSource from "../ChatLayout.tsx?raw";

// CSS ?raw import doesn't work in vitest because the CSS preprocessor
// intercepts it. Read the file directly via fs instead.
const indexCssSource = readFileSync(
  resolve(__dirname, "../../../index.css"),
  "utf-8",
);

/**
 * Safe-area regression tests (INS-020).
 *
 * These tests validate the structural contract that keeps the mobile
 * layout correctly positioned on notch-equipped iPhones. If any of
 * these fail, the top bar content will be hidden behind the notch or
 * the layout will collapse on iOS.
 *
 * Uses raw string matching (not DOM mounting) because ChatLayout has
 * 20+ hook dependencies — same pattern as ChatLayout.iPad.test.ts.
 */
describe("ChatLayout safe-area mobile layout", () => {
  // ── Top bar structure ──
  // The safe-area inset must be on an OUTER wrapper div. The content
  // bar (h-12 = 48px) must be an INNER div. If both classes land on
  // the SAME div, the safe-area padding steals from the 48px content
  // height, cutting off the title + icons on notch-equipped iPhones.

  it("applies safe-top to the outer top-bar wrapper, NOT the content bar", () => {
    // Outer wrapper: has safe-top + bg-surface-container-low
    expect(chatLayoutSource).toMatch(
      /className="bg-surface-container-low safe-top flex-shrink-0"/
    );
  });

  it("applies h-12 to the inner content bar", () => {
    expect(chatLayoutSource).toMatch(
      /className="h-12 flex items-center px-3 gap-2"/
    );
  });

  it("safe-top and h-12 are NOT on the same element", () => {
    // This is the critical regression guard. If someone combines them
    // back onto one div, the notch eats the content bar.
    expect(chatLayoutSource).not.toMatch(
      /className="[^"]*safe-top[^"]*h-12/
    );
    expect(chatLayoutSource).not.toMatch(
      /className="[^"]*h-12[^"]*safe-top/
    );
  });

  it("outer wrapper renders before inner content bar (correct nesting)", () => {
    const outerIdx = chatLayoutSource.indexOf(
      'className="bg-surface-container-low safe-top flex-shrink-0"'
    );
    const innerIdx = chatLayoutSource.indexOf(
      'className="h-12 flex items-center px-3 gap-2"'
    );
    expect(outerIdx).toBeGreaterThan(-1);
    expect(innerIdx).toBeGreaterThan(-1);
    expect(innerIdx).toBeGreaterThan(outerIdx);
  });

  // ── Bottom pill bar ──

  it("pill bar wrapper has safe-bottom class", () => {
    expect(chatLayoutSource).toMatch(
      /concord-mobile-nav-wrap safe-bottom/
    );
  });

  // ── CSS infrastructure ──

  it("viewport-fit=cover is set in the CSS safe-area utilities", () => {
    // The actual meta tag is in index.html — these tests validate the
    // CSS utilities exist and are correctly defined.
    expect(indexCssSource).toMatch(/\.safe-top\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top/);
    expect(indexCssSource).toMatch(/\.safe-bottom\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom/);
  });

  it("html, body, #root have height:100% for full viewport chain", () => {
    expect(indexCssSource).toMatch(/html\s*\{[^}]*height:\s*100%/);
    expect(indexCssSource).toMatch(/body\s*\{[^}]*height:\s*100%/);
    expect(indexCssSource).toMatch(/#root\s*\{[^}]*height:\s*100%/);
  });

  it("App.tsx uses h-full not h-screen (100vh overflows WKWebView bounds on iOS)", () => {
    // 100vh includes the home indicator safe area but the WKWebView's
    // visible content area ends at the safe boundary — using h-screen
    // pushes the bottom pill bar below the visible area. h-full resolves
    // to the actual content bounds via the html/body/#root 100% chain.
    const appSource = readFileSync(
      resolve(__dirname, "../../../App.tsx"),
      "utf-8",
    );
    expect(appSource).not.toMatch(/h-screen/);
  });

  it("mobile touch-action allows horizontal panning for scroll-snap", () => {
    // touch-action: manipulation allows both horizontal and vertical
    // pan. The old pan-y restriction blocked scroll-snap.
    expect(indexCssSource).toMatch(/touch-action:\s*manipulation/);
    // Must NOT have the old restrictive pan-y that blocks scroll-snap
    expect(indexCssSource).not.toMatch(/touch-action:\s*pan-y\s+pinch-zoom/);
  });

  it("pill bar wrapper has dark background to cover iOS home indicator area", () => {
    expect(indexCssSource).toMatch(
      /\.concord-mobile-nav-wrap\s*\{[^}]*background:\s*#0c0e11/
    );
  });
});
