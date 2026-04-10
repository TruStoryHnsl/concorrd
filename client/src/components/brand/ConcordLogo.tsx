/**
 * Concord brand mark — vector version.
 *
 * Two interlocking circles ("paired peers") rendered as an inline SVG
 * so the two colours are driven by CSS custom properties. This lets a
 * future theme picker recolour the logo to match the active palette
 * just by changing the two base colours — no PNG regeneration needed.
 *
 * The two fills default to:
 *
 *     --color-logo-primary   → the app's primary base colour
 *     --color-logo-secondary → the app's secondary base colour
 *
 * Both variables are defined in `client/src/index.css` and default to
 * the current Electric Indigo theme (primary = indigo, secondary = mint).
 * Consumers can also override per-instance via the `primaryColor` /
 * `secondaryColor` props — e.g. on a theme preview swatch.
 *
 * The geometry is hand-matched to the raster master at
 * `branding/logo.png`: two ring shapes that link together, each with a
 * small solid "node" dot offset toward the opposite side. The z-order
 * produces the classic chain-link weave where the primary ring crosses
 * over the secondary at top and under it at bottom.
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
   * Override the primary fill. If omitted, reads from the CSS variable
   * `--color-logo-primary` on the closest ancestor. Accepts any valid
   * CSS colour (hex, rgb, oklch, var(...)).
   */
  primaryColor?: string;
  /**
   * Override the secondary fill. Reads from `--color-logo-secondary`
   * when omitted.
   */
  secondaryColor?: string;
  /** Accessible label. Empty string marks the mark as decorative. */
  title?: string;
  /** Passthrough className for Tailwind / layout. */
  className?: string;
  /** Additional inline styles (merged with size). */
  style?: CSSProperties;
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
  const primary = primaryColor ?? "var(--color-logo-primary, var(--color-primary, currentColor))";
  const secondary = secondaryColor ?? "var(--color-logo-secondary, var(--color-secondary, currentColor))";

  // ViewBox chosen to give the two rings breathing room without
  // clipping the outermost stroke. 512×512 matches the raster master
  // dimensions so design tweaks can be cross-referenced pixel-for-pixel.
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : "presentation"}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      className={className}
      style={style}
    >
      {title ? <title>{title}</title> : null}

      {/*
        Primary ring — upper-right circle.
        Centre (320, 192), outer radius 144, stroke 48.
        Rendered as a path so we can mask out the region where the
        secondary ring should "cross over" to produce the chain-link
        weave. The mask clips a diagonal band where the secondary
        passes in front.
      */}
      <defs>
        <mask id="concord-primary-mask">
          {/* Full visibility by default */}
          <rect x="0" y="0" width="512" height="512" fill="white" />
          {/* Hide the region where secondary crosses over the primary.
              A wide diagonal band around the lower-left crossing point. */}
          <circle cx="192" cy="320" r="168" fill="black" />
          {/* Re-reveal the upper half of that hidden region so only the
              lower-left corner of the primary ring is occluded. */}
          <rect x="0" y="0" width="512" height="256" fill="white" />
        </mask>

        <mask id="concord-secondary-mask">
          <rect x="0" y="0" width="512" height="512" fill="white" />
          {/* Hide where primary crosses over secondary (upper-right). */}
          <circle cx="320" cy="192" r="168" fill="black" />
          <rect x="0" y="256" width="512" height="256" fill="white" />
        </mask>
      </defs>

      {/* Primary (upper-right) ring */}
      <g mask="url(#concord-primary-mask)">
        <circle
          cx="320"
          cy="192"
          r="120"
          fill="none"
          stroke={primary}
          strokeWidth="48"
        />
      </g>
      {/* Primary inner dot (small solid node offset toward upper-left). */}
      <circle cx="288" cy="172" r="28" fill={primary} />

      {/* Secondary (lower-left) ring */}
      <g mask="url(#concord-secondary-mask)">
        <circle
          cx="192"
          cy="320"
          r="120"
          fill="none"
          stroke={secondary}
          strokeWidth="48"
        />
      </g>
      {/* Secondary inner dot (offset toward lower-right). */}
      <circle cx="224" cy="340" r="28" fill={secondary} />
    </svg>
  );
}
