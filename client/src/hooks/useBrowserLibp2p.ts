/**
 * Phase 9 — React hook that starts the browser libp2p node on mount
 * and stops it on unmount. Native (Tauri) builds are a no-op: the
 * Rust swarm in `src-tauri/src/servitude/p2p.rs` IS the libp2p layer
 * on native, so spinning up a parallel browser node would be
 * duplicative.
 *
 * Surfaces a coarse status ("idle" → "starting" → "running" / "error")
 * so a future Settings → Profile badge can render it without
 * re-introspecting libp2p internals. Phase 9 does not wire the UI;
 * that lands in a follow-up.
 */
import { useEffect, useState } from "react";
import { startBrowserNode, stopBrowserNode } from "../libp2p/node";
import { BOOTSTRAP_MULTIADDRS } from "../libp2p/bootstrap";

export type BrowserLibp2pStatus = "idle" | "starting" | "running" | "error";

export interface UseBrowserLibp2pResult {
  status: BrowserLibp2pStatus;
  /** Populated only when status === "error". */
  error?: string;
}

/**
 * Detect Tauri using the v2 internals key (`__TAURI_INTERNALS__`).
 * This is identical to `isTauri()` in `client/src/api/servitude.ts`
 * but inlined to keep the hook a leaf module — importing the
 * servitude API would create a dependency cycle if a future
 * refactor wants servitude to depend on this hook.
 */
function detectTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useBrowserLibp2p(): UseBrowserLibp2pResult {
  const [status, setStatus] = useState<BrowserLibp2pStatus>("idle");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // Native build: the Rust swarm is the libp2p layer. Skip.
    if (detectTauri()) return;
    let cancelled = false;
    setStatus("starting");
    startBrowserNode(BOOTSTRAP_MULTIADDRS)
      .then(() => {
        if (!cancelled) setStatus("running");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      // Best-effort teardown. We don't await — React's cleanup is
      // synchronous and a slow stop would block unmount.
      stopBrowserNode().catch((err: unknown) => {
        console.debug("[libp2p] stop on unmount failed (ignored)", err);
      });
    };
  }, []);

  return { status, error };
}
