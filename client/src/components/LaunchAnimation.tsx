/**
 * Concord launch animation / boot buffer (INS-023).
 *
 * A full-viewport dark-theme splash that sits above the React tree
 * during the first ~400ms of a cold boot and whenever the app reports
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
 *   - Animation is CSS-only (keyframe pulse) so it survives the
 *     React hydration pass without re-mounting.
 *
 * INS-023 "Launch animation (display buffer on all boot/reload, all
 * platforms)" item under the Shared section of PLAN.md is satisfied
 * by this component + the `index.html` inline `<style>`.
 */
import { useEffect, useRef, useState } from "react";
import { ConcordLogo } from "./brand/ConcordLogo";

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
   * Minimum visible duration in milliseconds. Default 400ms — long
   * enough to register as intentional, short enough that fast
   * hydrations don't feel padded.
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

/**
 * Full-screen launch splash. Self-dismisses once the minimum display
 * time has elapsed AND `isLoading` is false. The component never
 * re-enters the "showing" phase after it reaches "done" — each cold
 * boot renders a fresh instance.
 */
export function LaunchAnimation({
  isLoading,
  onDone,
  minimumDurationMs = 400,
  setTimeoutFn,
}: LaunchAnimationProps) {
  const [phase, setPhase] = useState<Phase>("showing");
  const [minElapsed, setMinElapsed] = useState(false);
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
  // The fade phase lasts 250ms (a second setTimeout) and then fires
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
    }, 250) as unknown as number;
  }, [minElapsed, isLoading, phase, onDone, setTimeoutFn]);

  if (phase === "done") return null;

  return (
    <div
      data-testid="launch-animation"
      data-phase={phase}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.25rem",
        background: "#0c0e11",
        color: "#f4f4f7",
        // Pointer events off once fading so the app underneath can
        // receive clicks as soon as it's ready, even while the
        // opacity transition is still running.
        pointerEvents: phase === "fading" ? "none" : "auto",
        opacity: phase === "fading" ? 0 : 1,
        transition: "opacity 250ms ease-out",
      }}
    >
        <div
        style={{
          width: "96px",
          height: "96px",
          borderRadius: "24px",
          background:
            "radial-gradient(circle at 30% 30%, color-mix(in srgb, var(--color-logo-primary, #a4a5ff) 35%, transparent), rgba(12, 14, 17, 0) 70%)",
          border: "1px solid color-mix(in srgb, var(--color-logo-secondary, #afefdd) 40%, transparent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          animation: "concord-launch-pulse 1600ms ease-in-out infinite",
        }}
      >
        <ConcordLogo size={56} title="Concord" />
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
        }}
      >
        {isLoading ? "Loading…" : "Ready"}
      </div>
      {/* Inline keyframes so the splash animates even before
          `index.css` has finished loading. */}
      <style>
        {`@keyframes concord-launch-pulse {
          0%   { transform: scale(0.96); opacity: 0.85; }
          50%  { transform: scale(1.04); opacity: 1; }
          100% { transform: scale(0.96); opacity: 0.85; }
        }`}
      </style>
    </div>
  );
}
