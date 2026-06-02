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
 *                 Used by post-auth boot transitions and anything
 *                 that fills the viewport while we wait.
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

  // Make the loop continuous ACROSS REMOUNTS. Each BringingUpSplash
  // instance gets a fresh <video> element from React, and that element's
  // playback starts at frame 0 — so as the user navigates through
  // loading states (boot → ChatLayout sync → empty-state → etc.) the
  // splash visibly snaps back to the beginning each time a new instance
  // mounts. That's what the user sees as "restarts halfway through."
  //
  // Fix: persist the video's currentTime to sessionStorage on every
  // tick, and restore it on mount. The visual effect is one
  // uninterrupted, looping animation regardless of how many times
  // React unmounts and recreates the element. The boot-splash video
  // in index.html (id="boot-splash-anim") seeds the first time so
  // the React handoff stays continuous too.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const STORAGE_KEY = "concord:splash:currentTime";
    // Seed from sessionStorage first; fall back to the boot-splash
    // video element if it's still in the DOM during early handoff.
    let seed = 0;
    try {
      const stored = window.sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const t = parseFloat(stored);
        if (!isNaN(t) && isFinite(t) && t > 0) seed = t;
      }
    } catch {
      // sessionStorage may be unavailable in some sandboxes
    }
    if (seed === 0) {
      const boot = document.getElementById("boot-splash-anim");
      if (boot && boot instanceof HTMLVideoElement && boot.currentTime > 0) {
        seed = boot.currentTime;
      }
    }
    if (seed > 0) {
      try {
        v.currentTime = seed;
      } catch {
        // setting currentTime can throw before the video has loaded
        // its metadata — fall through to autoPlay's default 0 start
      }
    }
    const persist = () => {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, String(v.currentTime));
      } catch {
        // ignore — best-effort
      }
    };
    const interval = window.setInterval(persist, 150);
    // jsdom returns `undefined` from `play()` (no Promise impl), so
    // guard against the missing Promise before calling .catch.
    const result = v.play();
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        // Autoplay policies may reject silently; the element falls
        // back to whatever the platform allows. Nothing to do.
      });
    }
    return () => {
      window.clearInterval(interval);
      persist();
    };
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
