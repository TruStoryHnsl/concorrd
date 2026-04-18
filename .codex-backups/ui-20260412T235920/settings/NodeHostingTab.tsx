import { useCallback, useEffect, useRef, useState } from "react";
import {
  isTauri,
  servitudeStart,
  servitudeStatus,
  servitudeStop,
  type ServitudeState,
} from "../../api/servitude";

/**
 * Settings tab exposing the embedded servitude (service node hosting) toggle.
 *
 * The Rust side of servitude lives in `src-tauri/src/servitude/` and is
 * wired into Tauri via `servitude_start` / `servitude_stop` /
 * `servitude_status` commands in `src-tauri/src/lib.rs`. This component is
 * the user-facing switch for that pipeline — part of INS-022 (mobile
 * phone-as-relay), scope also applies to desktop Tauri builds.
 *
 * Browser mode (plain web client, no Tauri shell):
 *   The tab renders an informational banner explaining that node hosting
 *   is only available in the native Concord app. The toggle button is
 *   still shown but disabled, so the UI structure is consistent across
 *   environments (useful for screenshots and onboarding flows).
 *
 * Tauri mode:
 *   The tab polls `servitude_status` every `POLL_INTERVAL_MS` milliseconds
 *   while mounted, and drives the lifecycle via the two action buttons.
 *   Transitional states (`starting`, `stopping`) disable the button to
 *   keep users from double-clicking into a wedged state.
 *
 * Note — v0.1 reality check: the embedded servitude lifecycle is wired
 * end-to-end but the layered transports are `TODO(transport)` stubs in
 * `src-tauri/src/servitude/mod.rs`. "Running" means the state machine
 * reports Running, NOT that a single byte of traffic has crossed a
 * network boundary. The UI intentionally does not lie about this — the
 * status text reads "Hosting enabled (transports pending)" until the
 * first real transport lands in Wave 2.
 */

const POLL_INTERVAL_MS = 3000;

type UiStatus =
  | { kind: "loading" }
  | { kind: "ready"; state: ServitudeState; degraded: Record<string, string> }
  | { kind: "error"; message: string };

export function NodeHostingTab() {
  const [status, setStatus] = useState<UiStatus>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const native = isTauri();

  const refresh = useCallback(async () => {
    try {
      const response = await servitudeStatus();
      if (!mountedRef.current) return;
      setStatus({
        kind: "ready",
        state: response.state,
        degraded: response.degraded_transports,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    // Only poll in native mode — in the browser the status is fixed.
    if (!native) return () => {
      mountedRef.current = false;
    };
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [native, refresh]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    try {
      await servitudeStart();
      await refresh();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await servitudeStop();
      await refresh();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // What the big status line reads.
  const statusLabel = (() => {
    if (status.kind === "loading") return "Checking…";
    if (status.kind === "error") return "Unavailable";
    switch (status.state) {
      case "stopped":
        return "Stopped";
      case "starting":
        return "Starting…";
      case "running":
        return "Hosting enabled (transports pending)";
      case "stopping":
        return "Stopping…";
    }
  })();

  const statusColor = (() => {
    if (status.kind !== "ready") return "text-on-surface-variant";
    switch (status.state) {
      case "running":
        return "text-primary";
      case "starting":
      case "stopping":
        return "text-secondary";
      case "stopped":
        return "text-on-surface-variant";
    }
  })();

  const currentState: ServitudeState | null =
    status.kind === "ready" ? status.state : null;

  const canStart =
    native && !busy && (currentState === "stopped" || currentState === null);
  const canStop = native && !busy && currentState === "running";

  return (
    <div className="space-y-6" data-testid="node-hosting-tab">
      <div>
        <h3 className="text-xl font-semibold text-on-surface">Node Hosting</h3>
        <p className="text-sm text-on-surface-variant mt-1">
          Turn this device into a Concord service node. Other users on your
          mesh can route calls and chat through it while hosting is enabled.
        </p>
      </div>

      {!native && (
        <div
          className="rounded-md border border-outline-variant/30 bg-surface-container-high/40 px-4 py-3"
          data-testid="node-hosting-browser-banner"
        >
          <p className="text-sm text-on-surface">
            Node hosting is only available in the native Concord app.
          </p>
          <p className="text-xs text-on-surface-variant mt-1">
            Install the desktop or mobile build and reopen this settings tab
            to enable the toggle. The web client remains a full-featured
            client; it just can't act as a host itself.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 rounded-md bg-surface-container-low/60 px-4 py-3">
        <div className="flex flex-col min-w-0">
          <span className="text-xs uppercase tracking-wide text-on-surface-variant">
            Status
          </span>
          <span
            className={`text-base font-medium ${statusColor}`}
            data-testid="node-hosting-status"
          >
            {statusLabel}
          </span>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={handleStart}
            disabled={!canStart}
            data-testid="node-hosting-start"
            className="px-4 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-sm rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
          >
            Start hosting
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={!canStop}
            data-testid="node-hosting-stop"
            className="px-4 py-2 bg-error/10 hover:bg-error/15 text-error text-sm rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
          >
            Stop hosting
          </button>
        </div>
      </div>

      {/* Degraded transports (INS-024 Wave 4) */}
      {status.kind === "ready" &&
        Object.keys(status.degraded).length > 0 && (
          <div
            className="rounded-md border border-warning/30 bg-warning/10 px-4 py-3 space-y-1"
            data-testid="node-hosting-degraded"
          >
            <p className="text-sm text-warning font-medium">
              Degraded transports
            </p>
            {Object.entries(status.degraded).map(([name, reason]) => (
              <div key={name} className="flex items-start gap-2">
                <span className="text-xs text-on-surface font-medium shrink-0">
                  {name}:
                </span>
                <span className="text-xs text-on-surface-variant break-all">
                  {reason}
                </span>
              </div>
            ))}
          </div>
        )}

      {status.kind === "error" && (
        <div
          className="rounded-md border border-error/30 bg-error/10 px-4 py-3"
          data-testid="node-hosting-error"
        >
          <p className="text-sm text-error font-medium">
            Servitude error
          </p>
          <p className="text-xs text-on-surface-variant mt-1 break-all">
            {status.message}
          </p>
          <button
            type="button"
            onClick={refresh}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      <div className="border-t border-outline-variant/15 pt-6 space-y-2">
        <h4 className="text-sm font-medium text-on-surface">
          What hosting does
        </h4>
        <ul className="text-xs text-on-surface-variant space-y-1.5 list-disc list-inside">
          <li>
            Runs an in-process service node while the app is open. On mobile
            this is foreground-active; on desktop it stays up as long as the
            app is running.
          </li>
          <li>
            Layered transports (WireGuard, local mesh, HTTP tunnels, Matrix
            federation) are declared in the config. Their runtime wiring is
            in progress — Wave 2 lights up the first real transport.
          </li>
          <li>
            Hosting is always an opt-in toggle. Turning it off immediately
            tears down the lifecycle without affecting your regular client
            session.
          </li>
        </ul>
      </div>
    </div>
  );
}
