/**
 * Phase 9 — React hook that starts the browser libp2p node on demand
 * and exposes lifecycle controls to call sites.
 *
 * Original posture (pre-bundle-split): fired on App mount and started
 * the swarm immediately. That eagerly pulled the entire ~600 KB
 * libp2p tree into the cold-start bundle even on sessions that never
 * touched a voice room or the Paired Peers settings tab.
 *
 * New posture: opt-in. `enabled: false` (the default) leaves the
 * libp2p chunk unfetched and the swarm un-started. Callers that
 * actually need the swarm (VoiceChannel on a libp2p-mesh-eligible
 * join, ProfileTab when the paired-peers section mounts) pass
 * `enabled: true` and / or call `start()` directly. The lazy seam
 * in `../libp2p/lazyNode` ensures Vite emits the libp2p tree as its
 * own chunk so the cost only lands on sessions that hit one of
 * those surfaces.
 *
 * Native (Tauri) builds are a no-op: the Rust swarm in
 * `src-tauri/src/servitude/p2p.rs` IS the libp2p layer on native, so
 * spinning up a parallel browser node would be duplicative.
 *
 * Surfaces a coarse status ("idle" → "starting" → "running" / "error")
 * so a future Settings → Profile badge can render it without
 * re-introspecting libp2p internals.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ensureBrowserNode,
  stopBrowserNodeIfStarted,
} from "../libp2p/lazyNode";
import { BOOTSTRAP_MULTIADDRS } from "../libp2p/bootstrap";

export type BrowserLibp2pStatus = "idle" | "starting" | "running" | "error";

export interface UseBrowserLibp2pOptions {
  /**
   * When `true`, the hook starts the browser libp2p node automatically
   * on mount (the legacy behavior). When `false` (the default), the
   * hook is dormant until the caller invokes `start()` directly.
   *
   * Surfaces that ALWAYS need the swarm up (e.g. an admin-only
   * Settings page that watches DHT state continuously) should pass
   * `true`. Surfaces that need it conditionally should pass `false`
   * and gate the `start()` call on their own trigger.
   */
  enabled?: boolean;
}

export interface UseBrowserLibp2pResult {
  status: BrowserLibp2pStatus;
  /** Populated only when status === "error". */
  error?: string;
  /**
   * Imperatively start (or no-op if already starting/running) the
   * browser libp2p node. Returns a promise that resolves once the
   * node is up or rejects with the failure that flipped status to
   * `"error"`.
   */
  start(): Promise<void>;
  /**
   * Imperatively stop the browser libp2p node. Safe to call when
   * the node was never started — short-circuits without fetching
   * the libp2p chunk (see `stopBrowserNodeIfStarted`).
   */
  stop(): Promise<void>;
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

export function useBrowserLibp2p(
  opts: UseBrowserLibp2pOptions = {},
): UseBrowserLibp2pResult {
  const { enabled = false } = opts;
  const [status, setStatus] = useState<BrowserLibp2pStatus>("idle");
  const [error, setError] = useState<string | undefined>();

  const start = useCallback(async (): Promise<void> => {
    // Native build: the Rust swarm is the libp2p layer. Skip.
    if (detectTauri()) return;
    setStatus("starting");
    setError(undefined);
    try {
      await ensureBrowserNode(BOOTSTRAP_MULTIADDRS);
      setStatus("running");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    if (detectTauri()) return;
    try {
      await stopBrowserNodeIfStarted();
    } finally {
      setStatus("idle");
      setError(undefined);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (detectTauri()) return;
    let cancelled = false;
    setStatus("starting");
    setError(undefined);
    ensureBrowserNode(BOOTSTRAP_MULTIADDRS)
      .then(() => {
        if (!cancelled) setStatus("running");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    // Unmount: do NOT auto-stop. The node is a singleton shared
    // across every consumer (VoiceChannel, ProfileTab, etc.); a
    // single component unmounting must not yank the swarm out from
    // under sibling surfaces. Explicit `stop()` callers (e.g.
    // logout) are responsible for tearing it down.
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { status, error, start, stop };
}
