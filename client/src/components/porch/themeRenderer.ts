/**
 * Porch Phase C — theme renderer.
 *
 * Translates a {@link ChannelTheme} into a CSS-properties object the
 * caller spreads onto the outermost `PorchView` element. The renderer
 * emits CSS custom properties (`--porch-*`) so child components
 * (channel rail, message list, composer) can pick them up via
 * `var(--porch-surface)` etc. without overriding the global Tailwind
 * theme.
 *
 * Image backgrounds are NOT handled here — the renderer just records
 * the asset id; the caller is responsible for fetching the bytes via
 * `porchVisitGetAssetBytes`, turning them into a blob URL, and
 * passing the URL through `imageBackgroundUrl`.
 */

import type { Background, ChannelTheme, FontFamily } from "../../api/porch";

/**
 * Map a {@link FontFamily} variant to a concrete CSS `font-family`
 * stack. Stacks lean on safe system defaults so the theme degrades
 * gracefully when the user doesn't have the curated font installed.
 */
export function fontFamilyCss(family: FontFamily): string {
  switch (family) {
    case "serif":
      return '"Lora", "Georgia", "Times New Roman", serif';
    case "mono":
      return '"JetBrains Mono", "Fira Code", "Menlo", monospace';
    case "display":
      return '"Bricolage Grotesque", "Inter Display", "Inter", system-ui, sans-serif';
    case "system":
    default:
      return 'system-ui, -apple-system, "Segoe UI", "Inter", sans-serif';
  }
}

/**
 * Compute the inline style props for a porch view rendered against
 * `theme`. The caller spreads the result onto the outermost view
 * element.
 *
 * Pass `imageBackgroundUrl` only when the theme references an Image
 * background AND the caller has resolved the asset to a blob URL.
 * Otherwise omit it — Image themes fall back to the solid surface
 * color until the image arrives.
 */
export function applyTheme(
  theme: ChannelTheme | null,
  options: { imageBackgroundUrl?: string } = {},
): React.CSSProperties {
  if (!theme) {
    return {};
  }
  const fontStack = fontFamilyCss(theme.font_family);
  // CSS custom properties so descendants can opt in by name.
  // React's CSSProperties supports the indexer for `--*` vars.
  const cssVars: Record<string, string> = {
    "--porch-primary": theme.primary_color,
    "--porch-surface": theme.surface_color,
    "--porch-on-surface": theme.on_surface_color,
    "--porch-accent": theme.accent_color,
    "--porch-font": fontStack,
  };
  const style: React.CSSProperties & Record<string, string> = {
    ...cssVars,
    backgroundColor: theme.surface_color,
    color: theme.on_surface_color,
    fontFamily: fontStack,
  };
  applyBackgroundStyles(style, theme.background, options.imageBackgroundUrl);
  return style;
}

function applyBackgroundStyles(
  style: React.CSSProperties & Record<string, string>,
  bg: Background,
  imageUrl?: string,
): void {
  switch (bg.kind) {
    case "none":
      // surface_color is already the background; nothing else needed.
      break;
    case "solid":
      style.backgroundColor = bg.value;
      break;
    case "gradient":
      // `background` (the shorthand) wins over backgroundColor — the
      // gradient *is* the surface.
      style.background = bg.value;
      break;
    case "image":
      if (imageUrl) {
        style.background = `center / cover no-repeat url("${imageUrl}")`;
      }
      // No imageUrl yet: fall back to the solid surface color (already
      // set above).
      break;
  }
}

/**
 * Minimal WCAG-ish contrast sanity check.
 *
 * Returns the contrast ratio between two hex colors. Used to surface a
 * soft warning when the user picks an `on_surface_color` that's hard
 * to read against the background. Not a full WCAG implementation —
 * just enough to catch obvious "white on white" mistakes.
 *
 * Ratio = (L1 + 0.05) / (L2 + 0.05) where L1 is the lighter
 * luminance. A ratio under 3:1 is "barely readable"; 4.5:1 is the
 * canonical AA threshold for normal text; 7:1 is AAA.
 */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const lFg = relativeLuminance(parseHex(fgHex));
  const lBg = relativeLuminance(parseHex(bgHex));
  const [light, dark] = lFg > lBg ? [lFg, lBg] : [lBg, lFg];
  return (light + 0.05) / (dark + 0.05);
}

function parseHex(hex: string): [number, number, number] {
  // Defensive: defaults to mid-gray for malformed input rather than
  // throwing — contrast warnings should never crash the renderer.
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return [128, 128, 128];
  }
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const norm = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * norm(r) + 0.7152 * norm(g) + 0.0722 * norm(b);
}

/**
 * Whether the theme's `on_surface_color` clears the soft-warning
 * threshold against the effective surface. Returns true for an
 * acceptable combination, false if the editor should surface a
 * legibility warning.
 */
export function passesContrastFloor(theme: ChannelTheme): boolean {
  // Use surface_color as the effective background — for gradient /
  // image backgrounds we'd need to render to a canvas to compute the
  // real contrast; the surface anchor is a reasonable proxy.
  return contrastRatio(theme.on_surface_color, theme.surface_color) >= 3;
}
