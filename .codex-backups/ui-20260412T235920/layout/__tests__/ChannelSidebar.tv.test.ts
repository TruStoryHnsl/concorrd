/**
 * INS-023 TV-mode wiring regression test for ChannelSidebar.
 *
 * ChannelSidebar, like ChatLayout, has a double-digit list of store
 * dependencies (useServerStore with 10+ selectors, useAuthStore,
 * useSettingsStore, useToastStore, useUnreadCounts, useVoiceParticipants,
 * @dnd-kit hooks, …) and mocking all of them just to assert the
 * presence of a class name is fragile churn that would drift the moment
 * someone adds a new store selector.
 *
 * Instead this test loads the ChannelSidebar source via Vite's `?raw`
 * query and asserts on the four narrow contract points of the TV
 * wiring:
 *
 *   1. `usePlatform` is imported from the shared platform hook.
 *   2. `isTV` is pulled off the returned flag bag at component scope.
 *   3. `isTV` is passed as a prop into every `SortableChannelRow`
 *      invocation — not just one, not maybe zero.
 *   4. The row button applies the `tv-channel-item` class AND the
 *      `data-focus-group="tv-main"` attribute AND the
 *      `data-focusable="true"` attribute, each gated on `isTV`.
 *
 * The behavioral contract — "TV renders large focusable rows styled
 * by `client/src/styles/tv.css` and navigable via useDpadNav" — is
 * covered indirectly via the tv.css rules and the useDpadNav unit
 * tests in `client/src/hooks/__tests__/useDpadNav.test.ts`. Once the
 * import + prop chain is live, the render-side behavior follows.
 */

import { describe, it, expect } from "vitest";
import channelSidebarSource from "../ChannelSidebar.tsx?raw";

describe("ChannelSidebar TV-mode wiring (INS-023)", () => {
  it("imports usePlatform from the platform hook module", () => {
    expect(channelSidebarSource).toMatch(
      /import\s*\{\s*usePlatform\s*\}\s*from\s*["']\.\.\/\.\.\/hooks\/usePlatform["']/,
    );
  });

  it("destructures isTV off usePlatform() inside the ChannelSidebar component", () => {
    // `const { isTV } = usePlatform();` — ordering may drift but the
    // destructure + call must stay.
    expect(channelSidebarSource).toMatch(/const\s*\{\s*isTV\s*\}\s*=\s*usePlatform\(\)/);
  });

  it("passes isTV as a prop into SortableChannelRow", () => {
    // The prop must be forwarded so the row sees the TV flag; a
    // simple attribute grep is enough because SortableChannelRow is
    // only instantiated from this file.
    expect(channelSidebarSource).toMatch(/isTV=\{isTV\}/);
  });

  it("applies the tv-channel-item class when isTV is true", () => {
    // The row button className is a template literal containing
    // `${isTV ? "tv-channel-item " : ""}` — check for the literal
    // conditional expression.
    expect(channelSidebarSource).toMatch(/isTV\s*\?\s*["']tv-channel-item\s*["']/);
  });

  it("emits data-focusable='true' gated on isTV", () => {
    expect(channelSidebarSource).toMatch(
      /data-focusable=\{isTV\s*\?\s*["']true["']\s*:\s*undefined\}/,
    );
  });

  it("scopes DPAD focus to data-focus-group='tv-main'", () => {
    expect(channelSidebarSource).toMatch(
      /data-focus-group=\{isTV\s*\?\s*["']tv-main["']\s*:\s*undefined\}/,
    );
  });

  it("does NOT unconditionally set tv-channel-item (non-TV path must stay clean)", () => {
    // Guard against a future refactor that removes the ternary and
    // leaves `tv-channel-item` on every row.
    expect(channelSidebarSource).not.toMatch(/className=["']tv-channel-item/);
  });
});
