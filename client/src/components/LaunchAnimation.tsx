/**
 * Concord launch animation / boot buffer (INS-023).
 *
 * A full-viewport dark-theme splash that sits above the React tree
 * during the first ~1200ms of a cold boot and whenever the app reports
 * `isLoading`. It has three jobs:
 *
 *   1. Cover the first-paint gap between the raw HTML and the
 *      hydrated React tree so the user never sees a white flash or a
 *      half-rendered sidebar. The matching `<style>` in `index.html`
 *      paints the dark background before this component even mounts.
 *
 *   2. Provide a single deterministic "I am loading" affordance that
 *      every platform (desktop, mobile, TV) shares. Previously each
 *      surface printed its own one-off spinner — centralizing it
 *      means a TV remote user sees a 10-foot logo + status line
 *      instead of a tiny corner spinner.
 *
 *   3. Self-dismiss via a tiny state machine so the rest of the app
 *      can treat it as "mount once and forget". The caller passes
 *      `isLoading` plus an `onDone` callback; the component holds
 *      itself visible until **both** (a) the minimum display time
 *      has elapsed AND (b) `isLoading` has flipped false. The
 *      minimum-time floor prevents the splash from flashing in and
 *      out on fast hydrations, which looks worse than showing it
 *      for the same duration every time.
 *
 * Design constraints:
 *   - No external image assets. Keeps the launch path off the
 *     network and lets the splash work in edge cases where bundle
 *     assets haven't loaded yet.
 *   - No reliance on tailwind's custom color tokens — every color is
 *     inlined as a hex literal so the splash still renders if the
 *     stylesheet is still fetching.
 *   - Animation is CSS-only so it survives the
 *     React hydration pass without re-mounting.
 *
 * INS-023 "Launch animation (display buffer on all boot/reload, all
 * platforms)" item under the Shared section of PLAN.md is satisfied
 * by this component + the `index.html` inline `<style>`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getBootSplashWaitingLabel, handoffBootSplash } from "../bootSplash";

// Served from client/public/boot-splash.webp so both the pre-React
// index.html <img> and this React mirror hit the same preloaded URL —
// browser cache delivers the asset instantly for React's render.
const BOOT_SPLASH_SRC = "/boot-splash.webp";

export interface LaunchAnimationProps {
  /**
   * When true, the splash stays visible indefinitely (waiting on the
   * caller). When false, the splash starts its dismiss timer once the
   * minimum display time has elapsed.
   */
  isLoading: boolean;
  /**
   * Fired exactly once when the splash has fully dismissed. The
   * caller should use this to unmount the component — the internal
   * state stays dismissed once triggered.
   */
  onDone?: () => void;
  /**
   * Minimum visible duration in milliseconds. Default 1200ms — long
   * enough to feel intentional and let the boot splash read as a
   * real transition instead of a flash.
   */
  minimumDurationMs?: number;
  /**
   * Optional override for the `window.setTimeout` call. Exists so
   * tests can use `vi.useFakeTimers()` without monkey-patching the
   * global. Defaults to the real global setTimeout.
   */
  setTimeoutFn?: typeof window.setTimeout;
}

type Phase = "showing" | "fading" | "done";
const FADE_DURATION_MS = 420;

/**
 * Full-screen launch splash. Self-dismisses once the minimum display
 * time has elapsed AND `isLoading` is false. The component never
 * re-enters the "showing" phase after it reaches "done" — each cold
 * boot renders a fresh instance.
 */
export function LaunchAnimation({
  isLoading,
  onDone,
  minimumDurationMs = 1200,
  setTimeoutFn,
}: LaunchAnimationProps) {
  const [phase, setPhase] = useState<Phase>("showing");
  const [minElapsed, setMinElapsed] = useState(false);
  const waitingLabel = getBootSplashWaitingLabel();
  // Timers are tracked via refs so effect cleanup on phase change
  // (showing -> fading) does NOT cancel the in-flight fade timer.
  // Putting them in useRef makes the timer lifetime span the whole
  // component mount; we clear them explicitly on unmount only.
  const fadeTimerRef = useRef<number | null>(null);
  const minTimerRef = useRef<number | null>(null);

  // One-shot cleanup on unmount for any still-pending timers.
  useEffect(() => {
    return () => {
      if (minTimerRef.current !== null) {
        window.clearTimeout(minTimerRef.current);
        minTimerRef.current = null;
      }
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    };
  }, []);

  // useLayoutEffect (not useEffect) so the pre-React boot splash is
  // removed from the render tree BEFORE the browser paints this
  // component's first frame. If we used useEffect, React would paint
  // the LaunchAnimation layer while #boot-splash was still visible
  // for at least one frame — a double-mark window that Playwright
  // measured at ~300ms in the previous implementation. The layout
  // effect fires synchronously after DOM mutations and before paint,
  // so there is no frame where both layers are visible.
  useLayoutEffect(() => {
    handoffBootSplash();
  }, []);

  // Fire the minimum-time timer exactly once on mount.
  useEffect(() => {
    const scheduler = setTimeoutFn ?? window.setTimeout;
    const handle = scheduler(
      () => setMinElapsed(true),
      minimumDurationMs,
    ) as unknown as number;
    minTimerRef.current = handle;
    // minimumDurationMs is intentionally not in the dep list — the
    // timer is a one-shot. If the caller passes a different value
    // on re-render the instance has already committed to the
    // original floor. Splitting it out would cause the timer to
    // reset mid-animation which is the exact bug we're avoiding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kick off the fade whenever the dismiss conditions are both met.
  // The fade phase lasts FADE_DURATION_MS and then fires
  // `onDone` exactly once, regardless of subsequent isLoading flips.
  // We deliberately do NOT return a cleanup that clears the fade
  // timer — if we did, `setPhase("fading")` below would re-run this
  // effect, and the cleanup from the *previous* run would cancel
  // the timer we just scheduled. The ref + unmount cleanup above
  // handles the pending-timer case cleanly.
  useEffect(() => {
    if (phase !== "showing") return;
    if (!minElapsed || isLoading) return;
    if (fadeTimerRef.current !== null) return; // already scheduled

    setPhase("fading");
    const scheduler = setTimeoutFn ?? window.setTimeout;
    fadeTimerRef.current = scheduler(() => {
      fadeTimerRef.current = null;
      setPhase("done");
      onDone?.();
    }, FADE_DURATION_MS) as unknown as number;
  }, [minElapsed, isLoading, phase, onDone, setTimeoutFn]);

  if (phase === "done") return null;

  return (
    <div
      data-testid="launch-animation"
      data-phase={phase}
      aria-hidden="true"
      style={{
        // Transparent, non-reflowing overlay.
        //
        // Previously this rendered with `background: "#0c0e11"` — a
        // solid surface rectangle the full size of the viewport. That
        // (a) pushed surrounding UI out of the way while the splash
        // was up and (b) visually cropped the animation to whatever
        // the dark rectangle's bounds were. The app's dark theme is
        // already painted on html/body (see index.html) and any page
        // rendered underneath is a valid backdrop, so the splash
        // itself owns NO backdrop — it overlays transparently and
        // fades out without affecting layout.
        //
        // `pointerEvents` is disabled for the whole phase (not just
        // the fade) so the overlay never swallows clicks from the
        // hydrated app beneath it.
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.5rem",
        background: "transparent",
        color: "#f4f4f7",
        pointerEvents: "none",
        opacity: phase === "fading" ? 0 : 1,
        transition: `opacity ${FADE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "204px",
          height: "204px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          filter: "drop-shadow(0 20px 42px rgba(0, 0, 0, 0.35))",
        }}
      >
        <img
          src={BOOT_SPLASH_SRC}
          alt=""
          style={{
            width: "192px",
            height: "192px",
            display: "block",
          }}
        />
      </div>
      <div
        style={{
          fontFamily:
            '"Space Grotesk", "Manrope", system-ui, -apple-system, sans-serif',
          fontSize: "1.25rem",
          fontWeight: 600,
          letterSpacing: "0.02em",
          color: "#f4f4f7",
        }}
      >
        Concord
      </div>
      <div
        style={{
          fontFamily:
            '"Manrope", system-ui, -apple-system, sans-serif',
          fontSize: "0.8125rem",
          color: "#c4c5d0",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {isLoading ? waitingLabel : "Ready"}
      </div>
    </div>
  );
}
