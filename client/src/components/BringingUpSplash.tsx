/**
 * BringingUpSplash — THE loading animation for Concord.
 *
 * There is exactly ONE loading visual in this app: the hand-rendered
 * Blender boot-splash mp4 at `client/public/boot-splash.mp4`. Every
 * "we're waiting on something" UI surface — Connecting, Bringing up
 * your Concord, voice join, Matrix login round-trip, server picker
 * spinner, anything — uses this component.
 *
 * **Do NOT** introduce Tailwind `animate-spin`, CSS border-spinners,
 * SVG rings, or any other custom loading visual. If a loading state
 * doesn't fit one of the existing size variants, add a new size
 * variant here — do NOT invent a new visual.
 *
 * Size variants:
 *
 *   - `full`    — Full-screen splash (192px video + brand + status).
 *                 Used by HostOnboarding's bring-up screen, post-auth
 *                 boot transitions, and anything that fills the
 *                 viewport while we wait.
 *   - `compact` — Page-section splash (64px video + optional status).
 *                 Used by ChatLayout's "loading servers" / "loading
 *                 messages" interstitials, modal loading panels,
 *                 voice-join overlays.
 *   - `inline`  — In-text glyph (16px video, no surrounding text).
 *                 Drop-in replacement for the per-button / per-row
 *                 status pips that used to be border-spin rings.
 *
 * The video loops continuously — the splash is a cyclical animation
 * and should keep playing as long as a loading state is on screen
 * (matches the index.html boot splash markup). The
 * `playsInline` + `muted` + `autoPlay` + `loop` combo lets it run
 * inside webview autoplay policies without a user gesture.
 *
 * Stability note: a ref-based imperative `play()` after mount keeps
 * the video rolling across React StrictMode's intentional
 * mount→unmount→remount cycle in dev. Without it the video reset to
 * frame 0 partway through (user saw "the splash restarts halfway
 * through") every time StrictMode poked the lifecycle.
 */

import { useEffect, useRef } from "react";

export type BringingUpSplashSize = "full" | "compact" | "inline";

interface BringingUpSplashProps {
  /** Headline shown under the animation. Defaults to "Concord". `full` only. */
  brand?: string;
  /** Sub-line shown below the headline. Optional. `full` / `compact` only. */
  status?: string;
  /** Size variant — see component docs for use cases. Default: `full`. */
  size?: BringingUpSplashSize;
  /** data-testid passthrough. */
  testId?: string;
  /** Optional className appended to the outer container. */
  className?: string;
}

interface SizeSpec {
  containerSize: number;
  videoSize: number;
  brandSize: string;
  statusSize: string;
  dropShadow: string;
  showBrand: boolean;
  showStatus: boolean;
  outerLayout: string;
}

const SIZES: Record<BringingUpSplashSize, SizeSpec> = {
  full: {
    containerSize: 204,
    videoSize: 192,
    brandSize: "1.25rem",
    statusSize: "0.8125rem",
    dropShadow: "drop-shadow(0 20px 42px rgba(0, 0, 0, 0.35))",
    showBrand: true,
    showStatus: true,
    outerLayout:
      "h-full w-full flex flex-col items-center justify-center gap-6",
  },
  compact: {
    containerSize: 72,
    videoSize: 64,
    brandSize: "0.9375rem",
    statusSize: "0.75rem",
    dropShadow: "drop-shadow(0 8px 18px rgba(0, 0, 0, 0.25))",
    showBrand: false,
    showStatus: true,
    outerLayout: "flex flex-col items-center justify-center gap-3 py-4",
  },
  inline: {
    containerSize: 20,
    videoSize: 16,
    brandSize: "0",
    statusSize: "0",
    dropShadow: "none",
    showBrand: false,
    showStatus: false,
    outerLayout: "inline-flex items-center justify-center align-middle",
  },
};

export function BringingUpSplash({
  brand = "Concord",
  status,
  size = "full",
  testId,
  className,
}: BringingUpSplashProps) {
  const spec = SIZES[size];
  const outerClass = className
    ? `${spec.outerLayout} ${className}`
    : spec.outerLayout;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Resume playback after StrictMode's dev-only remount cycle. The
  // video element's autoPlay attribute fires only once per element
  // creation; if StrictMode tears the component down and brings it
  // back (or a parent re-render swaps the node), the new element
  // starts at frame 0 — exactly the "restarts halfway through"
  // symptom users see in dev. Calling play() here is idempotent and
  // safe to run on every mount.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.play().catch(() => {
      // Autoplay policies may reject silently; the element will
      // fall back to whatever the platform allows. Nothing to do.
    });
  }, []);
  return (
    <span
      data-testid={testId}
      className={outerClass}
      style={size === "inline" ? undefined : { width: "100%" }}
    >
      <span
        className="relative flex items-center justify-center"
        style={{
          width: spec.containerSize,
          height: spec.containerSize,
          filter: spec.dropShadow,
        }}
      >
        <video
          ref={videoRef}
          src="/boot-splash.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          style={{
            width: spec.videoSize,
            height: spec.videoSize,
            display: "block",
            willChange: "transform",
            transform: "translateZ(0)",
            backfaceVisibility: "hidden",
          }}
        />
      </span>
      {spec.showBrand || spec.showStatus ? (
        <span className="flex flex-col items-center gap-1">
          {spec.showBrand ? (
            <span
              className="text-text-primary"
              style={{
                fontFamily:
                  "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: spec.brandSize,
                fontWeight: 600,
                letterSpacing: "0.02em",
                lineHeight: 1.3,
              }}
            >
              {brand}
            </span>
          ) : null}
          {spec.showStatus && status ? (
            <span
              data-testid={testId ? `${testId}-status` : undefined}
              className="text-text-secondary"
              style={{
                fontFamily:
                  "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: spec.statusSize,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                lineHeight: 1.3,
              }}
            >
              {status}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
