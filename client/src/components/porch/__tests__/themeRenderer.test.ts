import { describe, expect, it } from "vitest";
import type { ChannelTheme } from "../../../api/porch";
import {
  applyTheme,
  contrastRatio,
  fontFamilyCss,
  passesContrastFloor,
} from "../themeRenderer";

const baseTheme: ChannelTheme = {
  channel_id: "porch-default",
  primary_color: "#ff00aa",
  surface_color: "#101010",
  on_surface_color: "#f0f0f0",
  accent_color: "#00ffcc",
  font_family: "serif",
  background: { kind: "none" },
  updated_at: 0,
};

describe("applyTheme", () => {
  it("emits the expected CSS custom properties + surface color", () => {
    const style = applyTheme(baseTheme) as Record<string, string>;
    expect(style["--porch-primary"]).toBe("#ff00aa");
    expect(style["--porch-surface"]).toBe("#101010");
    expect(style["--porch-on-surface"]).toBe("#f0f0f0");
    expect(style["--porch-accent"]).toBe("#00ffcc");
    expect(style.backgroundColor).toBe("#101010");
    expect(style.color).toBe("#f0f0f0");
    // Serif theme: font stack must lead with a serif family.
    expect(style.fontFamily).toMatch(/Lora|Georgia|serif/);
  });

  it("renders an empty object for null theme (no overrides)", () => {
    const style = applyTheme(null);
    expect(style).toEqual({});
  });
});

describe("Background gradient", () => {
  it("produces a valid CSS linear-gradient string and applies it", () => {
    const theme: ChannelTheme = {
      ...baseTheme,
      background: {
        kind: "gradient",
        value: "linear-gradient(135deg, #101010, #202020)",
      },
    };
    const style = applyTheme(theme) as Record<string, string>;
    // gradient takes the `background` shorthand
    expect(style.background).toBe("linear-gradient(135deg, #101010, #202020)");
  });
});

describe("Image background", () => {
  it("uses the provided blob URL when available", () => {
    const theme: ChannelTheme = {
      ...baseTheme,
      background: { kind: "image", value: { asset_id: "01ABC" } },
    };
    const style = applyTheme(theme, {
      imageBackgroundUrl: "blob:foo",
    }) as Record<string, string>;
    expect(style.background).toMatch(/url\("blob:foo"\)/);
  });
  it("falls back to solid surface when no blob URL is available", () => {
    const theme: ChannelTheme = {
      ...baseTheme,
      background: { kind: "image", value: { asset_id: "01ABC" } },
    };
    const style = applyTheme(theme) as Record<string, string>;
    expect(style.backgroundColor).toBe(theme.surface_color);
  });
});

describe("fontFamilyCss", () => {
  it("returns distinct stacks per font family", () => {
    const stacks = new Set([
      fontFamilyCss("system"),
      fontFamilyCss("serif"),
      fontFamilyCss("mono"),
      fontFamilyCss("display"),
    ]);
    expect(stacks.size).toBe(4);
  });
});

describe("contrastRatio + passesContrastFloor", () => {
  it("white-on-black is high contrast", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeGreaterThan(20);
  });
  it("white-on-white is low contrast and fails the floor", () => {
    const theme: ChannelTheme = {
      ...baseTheme,
      surface_color: "#ffffff",
      on_surface_color: "#ffffff",
    };
    expect(passesContrastFloor(theme)).toBe(false);
  });
  it("the base theme passes the floor", () => {
    expect(passesContrastFloor(baseTheme)).toBe(true);
  });
});
