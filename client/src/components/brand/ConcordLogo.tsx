/**
 * Concord brand mark — mask-tinted raster halves.
 *
 * The mark ships as TWO grayscale-alpha PNGs:
 *
 *     /logo-upper.png  → upper-right ring + node (primary colour)
 *     /logo-lower.png  → lower-left  ring + node (secondary colour)
 *
 * Each half is 1024×1024 with binary alpha (255 where the ring/node
 * lives, 0 everywhere else). The luminance is solid white — the file
 * is a *mask*, not coloured artwork. We render each half as a `<div>`
 * with `mask-image` set to the PNG and `background-color` set to a
 * theme-driven CSS variable. Switching theme retints the mark without
 * touching the PNG bytes.
 *
 *   --color-logo-primary   → upper-half tint (defaults to the active
 *                            theme's `--color-primary`)
 *   --color-logo-secondary → lower-half tint (defaults to the active
 *                            theme's `--color-secondary`)
 *
 * Both variables are defined in `client/src/index.css` and follow the
 * active theme automatically. Callers can override per-instance via
 * the `primaryColor` / `secondaryColor` props — useful on theme
 * preview swatches that want to show the mark in a colour other than
 * the currently-active theme.
 *
 * Size semantics match the previous SVG implementation: the `size`
 * prop is the rendered side length in pixels. The mask PNG already
 * contains the design's intended padding — no further inset is
 * applied at the React layer.
 */
import type { CSSProperties } from "react";

export interface ConcordLogoProps {
  /**
   * Rendered size in pixels. Square. Defaults to 64.
   * Use CSS for more nuanced sizing; this is a shorthand for the
   * common "drop a 64px mark in the corner" case.
   */
  size?: number | string;
  /**
   * Override the primary fill (upper half). If omitted, reads from
   * the CSS variable `--color-logo-primary` on the closest ancestor.
   * Accepts any valid CSS colour (hex, rgb, oklch, var(...)).
   */
  primaryColor?: string;
  /**
   * Override the secondary fill (lower half). Reads from
   * `--color-logo-secondary` when omitted.
   */
  secondaryColor?: string;
  /** Accessible label. Omitted / empty marks the mark as decorative. */
  title?: string;
  /** Passthrough className for Tailwind / layout. */
  className?: string;
  /** Additional inline styles (merged with size). */
  style?: CSSProperties;
  /**
   * Retained for API compatibility with the previous SVG version.
   * The new asset is a single composited mark per half — there is no
   * separate "node dot" layer to suppress, so this prop is currently
   * ignored. Kept in the signature so existing call sites compile.
   */
  showNodes?: boolean;
}

/**
 * Asset URLs — resolved by Vite's static asset pipeline at build time.
 * Lives in `client/public/` so the path is stable across dev + build
 * and does NOT get content-hashed (the splash in `index.html` and the
 * favicon generator both reference the same paths).
 */
const UPPER_SRC = "/logo-upper.png";
const LOWER_SRC = "/logo-lower.png";

function maskStyle(src: string, color: string): CSSProperties {
  // mask-image vs -webkit-mask-image: Safari + iOS WebKit still need
  // the prefixed property; Chromium and Firefox accept the unprefixed
  // form. Setting both is harmless on every engine and required on
  // some. The mask-size:contain + mask-position:center trick keeps
  // the mark centred when the container's aspect ratio differs
  // slightly from 1:1 (rare; defensive).
  return {
    position: "absolute",
    inset: 0,
    backgroundColor: color,
    WebkitMaskImage: `url("${src}")`,
    maskImage: `url("${src}")`,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
    pointerEvents: "none",
  };
}

export function ConcordLogo({
  size = 64,
  primaryColor,
  secondaryColor,
  title,
  className,
  style,
}: ConcordLogoProps) {
  // CSS custom property fallback chain. When the caller passes an
  // explicit colour we use it; otherwise we resolve through the
  // `--color-logo-*` vars which the theme defines. The `currentColor`
  // tail is a last-ditch fallback so the mark never renders invisible
  // if both the var and the prop are absent.
  const primary =
    primaryColor ?? "var(--color-logo-primary, var(--color-primary, currentColor))";
  const secondary =
    secondaryColor ?? "var(--color-logo-secondary, var(--color-secondary, currentColor))";

  const wrapperStyle: CSSProperties = {
    position: "relative",
    width: size,
    height: size,
    display: "inline-block",
    flexShrink: 0,
    ...style,
  };

  return (
    <span
      className={className}
      style={wrapperStyle}
      role={title ? "img" : "presentation"}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      {/* Lower half painted first so the upper half visually crosses
          over it at the top of the chain weave — matches the master
          render's z-order. */}
      <span aria-hidden="true" style={maskStyle(LOWER_SRC, secondary)} />
      <span aria-hidden="true" style={maskStyle(UPPER_SRC, primary)} />
    </span>
  );
}
