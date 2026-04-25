/**
 * Concord launch animation / boot buffer (INS-023).
 *
 * Timing coordinator — *renders nothing*. The visible splash is the
 * #boot-splash block in client/index.html, which is already painted
 * by the time React even evaluates this module. Rendering a second
 * visual layer here caused two regressions:
 *
 *   1. A fresh <img src="/boot-splash.webp"> in React's tree starts
 *      the animated WebP decode from frame 0, so when the HTML
 *      splash faded and React's splash faded in, the motion visibly
 *      restarted.
 *   2. Two stacked overlays with independent fade schedules made
 *      the splash flicker during the handoff window.
 *
 * This component holds the *timing* state machine: it waits until
 * BOTH dismissal gates are satisfied, then triggers
 * `handoffBootSplash()` which `display:none`s the boot splash and
 * fires `onDone` after the fade completes so the caller can unmount
 * us.
 *
 * Dismissal gates (handoff fires when ALL true):
 *   1. `isLoading` (auth restore in flight) is false.
 *   2. `isAppReady` (a terminal screen has mounted and painted) is
 *      true. This is the signal that the splash should ACTUALLY
 *      hand off to a usable UI, not just to a half-loaded blank.
 *
 * The animation itself is decoration — the splash dismisses as
 * soon as the app is interactable, even if the animation hasn't
 * finished playing. If the app is fast (cached refresh, etc.) the
 * splash may dismiss within a few hundred ms; if it's slow the
 * animation loops via the ping-pong markup in index.html.
 *
 * Safety ceiling: if the gates never settle within `maxDurationMs`
 * (default 30s) the splash dismisses anyway so a hung app doesn't
 * strand the user looking at the loading screen forever.
 *
 * Empirical proof of the bug this replaces: see
 * `client/e2e/splash-video-trace.mjs`. The previous implementation
 * dismissed at ~1.6s — auth restore had finished but the actual UI
 * hadn't mounted yet, so the splash hid into a brief blank gap
 * before the login/chat screen painted. The `isAppReady` gate
 * (flipped by `<MarkReady />` from each terminal screen on first
 * paint) closes that window.
 */
import { useEffect, useRef, useState } from "react";
import { handoffBootSplash } from "../bootSplash";
import { useBootReadyStore } from "../stores/bootReady";

export interface LaunchAnimationProps {
  /** Splash stays up while true. */
  isLoading: boolean;
  /** Fires exactly once, after the splash fade completes. */
  onDone?: () => void;
  /**
   * Hard ceiling on splash visibility. If something hangs and the
   * other gates never settle, the splash dismisses anyway after
   * this long. Default 30000ms.
   */
  maxDurationMs?: number;
  /**
   * Minimum splash visibility floor. Even when both readiness gates
   * pass immediately (warm cache, fast local sync, returning user
   * with everything pre-warm), the splash must paint for at least
   * this long before handoff so the user actually perceives it
   * instead of seeing a sub-100ms flash followed by an empty-dark
   * gap before the chat shell paints. Default 1500ms — long enough
   * to clear perceptual masking for a sudden visual change, short
   * enough that a fast app still feels fast. Set to 0 in tests
   * that want to assert the readiness-only gate.
   */
  minDurationMs?: number;
  /** Test seam for fake timers. */
  setTimeoutFn?: typeof window.setTimeout;
}

type Phase = "showing" | "fading" | "done";
const FADE_DURATION_MS = 420;

export function LaunchAnimation({
  isLoading,
  onDone,
  maxDurationMs = 30_000,
  minDurationMs = 1500,
  setTimeoutFn,
}: LaunchAnimationProps) {
  const isAppReady = useBootReadyStore((s) => s.isAppReady);
  const [phase, setPhase] = useState<Phase>("showing");
  const [maxElapsed, setMaxElapsed] = useState(false);
  const [minElapsed, setMinElapsed] = useState(minDurationMs <= 0);
  const fadeTimerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const minTimerRef = useRef<number | null>(null);

  // Mirror onDone into a ref so the gate effect's deps stay stable
  // across re-renders. Inline arrow functions in the parent
  // (`onDone={() => setLaunchDone(true)}`) would otherwise flip the
  // dep on every parent render and re-invoke the effect — even
  // though the effect's guards short-circuit, an unstable dep is the
  // textbook trigger for "Maximum update depth exceeded" if ANY
  // setState in this component or its descendants ever lands during
  // the same tick the parent re-rendered.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
      if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current);
      if (minTimerRef.current !== null) window.clearTimeout(minTimerRef.current);
    };
  }, []);

  // Start the safety ceiling AND the minimum-display floor on mount.
  // Both run from the same t=0 so the floor is bounded by the ceiling
  // — readiness can never block dismissal past `maxDurationMs`.
  useEffect(() => {
    const scheduler = setTimeoutFn ?? window.setTimeout;
    maxTimerRef.current = scheduler(
      () => setMaxElapsed(true),
      maxDurationMs,
    ) as unknown as number;
    if (minDurationMs > 0) {
      minTimerRef.current = scheduler(
        () => setMinElapsed(true),
        minDurationMs,
      ) as unknown as number;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handoff trigger — fires once, when readiness has settled AND the
  // minimum display floor has elapsed (or the safety ceiling fires).
  // The floor exists because on cached/warm-sync paths the readiness
  // gates can both pass within a frame or two of mount — splash
  // would dismiss before the user perceives it, leaving an
  // empty-dark gap before ChatLayout's first paint. The ceiling still
  // wins over the floor: a hung app dismisses at maxDurationMs no
  // matter what.
  useEffect(() => {
    if (phase !== "showing") return;
    if (fadeTimerRef.current !== null) return;

    const readinessGatesPassed = !isLoading && isAppReady;
    const ceilingHit = maxElapsed;
    const floorCleared = minElapsed;
    const shouldHandoff = ceilingHit || (readinessGatesPassed && floorCleared);
    if (!shouldHandoff) return;

    setPhase("fading");
    handoffBootSplash();

    const scheduler = setTimeoutFn ?? window.setTimeout;
    fadeTimerRef.current = scheduler(() => {
      fadeTimerRef.current = null;
      setPhase("done");
      onDoneRef.current?.();
    }, FADE_DURATION_MS) as unknown as number;
    // setTimeoutFn intentionally omitted from deps — it's a test
    // seam, only read at the moment the gate fires and never
    // changes in production. Including it would re-invoke this
    // effect on every parent render via the same unstable-ref
    // problem the onDoneRef pattern above is meant to solve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isAppReady, maxElapsed, minElapsed, phase]);

  return null;
}
