import { describe, expect, it } from "vitest";
import chatLayoutSource from "../ChatLayout.tsx?raw";

/**
 * Regression test for Issue C observed 2026-04-18.
 *
 * The TopBarMoreMenu (a.k.a. "Tools dropdown") in the top bar had the inner
 * Settings row rendering with icon="handyman" — the same wrench glyph as
 * the outer button that opened the menu. The outer button correctly stays
 * on `handyman` (that IS the tools button), but the inner Settings row
 * should use the universal gear glyph `settings` so it doesn't look like
 * "tools inside tools".
 */
describe("top-bar Tools menu — inner Settings row uses the gear glyph", () => {
  it("renders the Settings menu item with icon='settings', not 'handyman'", () => {
    expect(chatLayoutSource).toContain(
      '<OverflowMenuItem icon="settings" label="Settings"',
    );
    // Sanity: the outer wrench button should still use `handyman`. Its line
    // lives inside TopBarMoreMenu above the menu open branch.
    expect(chatLayoutSource).toContain(
      '<span className="material-symbols-outlined text-xl">handyman</span>',
    );
    // Negative: no OverflowMenuItem labelled Settings should still carry
    // the handyman icon.
    expect(chatLayoutSource).not.toContain(
      '<OverflowMenuItem icon="handyman" label="Settings"',
    );
  });
});
