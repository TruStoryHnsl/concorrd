import { useEffect } from "react";
import { useBootReadyStore } from "../stores/bootReady";

/**
 * Renders nothing. Calls `markAppReady()` after the first paint of
 * its parent terminal screen so the boot splash knows the UI is
 * genuinely up. Safe to drop into any screen that the user will
 * actually interact with — duplicate mounts and re-mounts are
 * idempotent in the store.
 */
export function MarkReady(): null {
  const markAppReady = useBootReadyStore((s) => s.markAppReady);
  useEffect(() => {
    // requestAnimationFrame defers the flag flip to AFTER the first
    // paint commits, not just after React's commit phase. Without
    // this, the splash could dismiss in the same tick the terminal
    // screen mounts and before it has had a chance to paint — a
    // brief flash of nothing between splash and screen.
    const id = requestAnimationFrame(() => {
      markAppReady();
    });
    return () => cancelAnimationFrame(id);
  }, [markAppReady]);
  return null;
}
