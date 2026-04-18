/**
 * INS-023 TV-mode wiring regression test for SettingsPanel.
 *
 * SettingsPanel hangs off every store in the app (settings, auth,
 * server, toast, platform, plus 4 per-tab child components). Rendering
 * it through vitest requires mocking the entire store graph, which is
 * fragile churn.
 *
 * We follow the same approach as `ChatLayout.iPad.test.ts` and
 * `ChannelSidebar.tv.test.ts`: load the source via Vite's `?raw`
 * suffix and assert on the narrow contract points of the TV focus
 * attribute wiring. The runtime behavior — "DPAD remote can traverse
 * the settings tab bar" — is covered indirectly via the `useDpadNav`
 * unit tests once the data attributes are live.
 *
 * Contract points covered:
 *   1. `isTV` is pulled off the usePlatform flag bag.
 *   2. A shared `tvFocusProps` helper exists so all three button
 *      groups (user tabs, admin tab, server tabs) and the Logout
 *      button stay consistent.
 *   3. Every tab button and the Logout button spread `tvFocusProps`.
 *      The count of spreads matches the three button groups + Logout
 *      (minimum 4, more is fine if future additions show up).
 *   4. The helper contains both `data-focusable` and `data-focus-group="tv-main"`.
 */

import { describe, it, expect } from "vitest";
import settingsModalSource from "../SettingsModal.tsx?raw";

describe("SettingsPanel TV-mode wiring (INS-023)", () => {
  it("destructures isTV off usePlatform()", () => {
    // Tolerate other destructured fields before or after isTV.
    expect(settingsModalSource).toMatch(
      /const\s*\{\s*[^}]*\bisTV\b[^}]*\}\s*=\s*usePlatform\(\)/,
    );
  });

  it("defines a tvFocusProps helper gated on isTV", () => {
    expect(settingsModalSource).toMatch(/const\s+tvFocusProps\s*=\s*isTV/);
  });

  it("tvFocusProps contains a data-focusable true attribute", () => {
    expect(settingsModalSource).toMatch(
      /"data-focusable"\s*:\s*"true"/,
    );
  });

  it("tvFocusProps scopes focus to the tv-main group", () => {
    expect(settingsModalSource).toMatch(
      /"data-focus-group"\s*:\s*"tv-main"/,
    );
  });

  it("spreads tvFocusProps on every tab button group and on Logout (>=4 spreads)", () => {
    const matches = settingsModalSource.match(/\{\.\.\.tvFocusProps\}/g) ?? [];
    // 3 tab buttons (user, admin, server) + 1 Logout = 4 minimum.
    // Using >= so future additions (e.g. overflow menu) don't break
    // the assertion while still catching accidental removals.
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it("does NOT apply data-focusable unconditionally (non-TV must stay attribute-free)", () => {
    // A future refactor that hard-codes the attributes onto the
    // button JSX would break non-TV focus ordering on desktop. This
    // guard catches that regression.
    expect(settingsModalSource).not.toMatch(/<button[^>]*data-focusable="true"/);
  });
});
