/**
 * LocalHostingControl — the "Start / Stop local hosting" entry that sits at
 * the TOP of the Add Source sheet on builds that can host (Tauri only).
 *
 * Why: on first launch the user picks "Connect to a Concord" or "Host a new
 * Concord" via the Welcome screen. If they pick Connect, the embedded
 * servitude module never boots and there's no path back to hosting without
 * reinstalling. This control closes that loop — open the Sources `+` sheet
 * and the top entry can flip hosting on / off at any point in the session.
 *
 * State machine (mirrors `servitudeStatus().state`):
 *   stopped   → primary CTA "Start hosting" + subtitle
 *   starting  → spinner row "Bringing up local server…"
 *   running   → status row "Hosting on localhost:<port>" + secondary "Stop"
 *   stopping  → spinner row "Stopping local server…"
 *   error     → red status line + retry button
 *
 * The control is gated on `usePlatform().isTauri`. Web builds host via the
 * Docker compose stack outside the app, so this UI doesn't apply there.
 *
 * When the user clicks "Start hosting" and we're not already an owner of a
 * local source, the parent modal delegates to `HostOnboarding` for the full
 * owner-registration bootstrap. When a local source is already persisted
 * (the user has bootstrapped before and is just toggling the daemon) we
 * call `servitudeStart` directly and let the existing source record
 * reconnect.
 *
 * Implementation note on the source-record persistence path: we look for an
 * existing `SourceRecord` with `isOwner: true` in `useSourcesStore`. If one
 * exists, "Start hosting" is a pure servitude_start (no owner re-reg). If
 * not, we surface the `onRequestBootstrap` callback so the parent can swap
 * its body for the HostOnboarding wizard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlatform } from "../../hooks/usePlatform";
import {
  servitudeStatus,
  servitudeStop,
  type ServitudeState,
} from "../../api/servitude";
import { startHostingServitude } from "../../api/hostingProfile";
import { useSourcesStore } from "../../stores/sources";

const POLL_INTERVAL_MS = 1500;

type UiState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "stopping" }
  | { kind: "error"; message: string };

function mapServitudeToUi(s: ServitudeState): UiState {
  switch (s) {
    case "stopped":
      return { kind: "stopped" };
    case "starting":
      return { kind: "starting" };
    case "running":
      return { kind: "running" };
    case "stopping":
      return { kind: "stopping" };
  }
}

interface LocalHostingControlProps {
  /**
   * Invoked when "Start hosting" is clicked and we have NO local owner
   * source yet. The parent should swap its body to the HostOnboarding
   * wizard (the existing first-launch host flow). Once that wizard
   * completes it persists a `SourceRecord` with isOwner=true and the
   * control will pick up the running state on the next status poll.
   */
  onRequestBootstrap: () => void;
}

export function LocalHostingControl({
  onRequestBootstrap,
}: LocalHostingControlProps) {
  const platform = usePlatform();
  const sources = useSourcesStore((s) => s.sources);
  const hasLocalOwner = sources.some((src) => src.isOwner);
  const [ui, setUi] = useState<UiState>({ kind: "stopped" });
  const [busy, setBusy] = useState(false);
  const pollAbort = useRef(false);

  // Poll status while the modal is open. Stops on unmount via the
  // pollAbort ref — useEffect's cleanup returns ASAP so we don't keep
  // a stale polling loop running after the sheet closes.
  useEffect(() => {
    if (!platform.isTauri) return;
    pollAbort.current = false;
    let cancelled = false;
    const tick = async () => {
      while (!cancelled && !pollAbort.current) {
        try {
          const status = await servitudeStatus();
          if (cancelled) return;
          setUi(mapServitudeToUi(status.state));
        } catch (err) {
          if (cancelled) return;
          setUi({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    };
    void tick();
    return () => {
      cancelled = true;
      pollAbort.current = true;
    };
  }, [platform.isTauri]);

  const onStart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!hasLocalOwner) {
        // No local source yet — the full HostOnboarding wizard owns the
        // bootstrap (register owner, persist source record with isOwner).
        // We don't call servitudeStart here; the wizard does it as step 1.
        onRequestBootstrap();
        return;
      }
      // We already have an owner record from a previous session — just
      // restart the daemon. The existing source record will reconnect on
      // the next sync cycle. Use the host-capable start so the embedded
      // homeserver is materialized (the `web_first` profile) rather than
      // a bare libp2p-only node.
      setUi({ kind: "starting" });
      await startHostingServitude();
    } catch (err) {
      setUi({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, hasLocalOwner, onRequestBootstrap]);

  const onStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setUi({ kind: "stopping" });
      await servitudeStop();
    } catch (err) {
      setUi({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Non-Tauri builds (web) — hide entirely. Web builds host via Docker
  // outside the app; there's nothing to toggle from the UI here.
  if (!platform.isTauri) return null;

  const subtitleByKind: Record<UiState["kind"], string> = {
    stopped: "Run a Concord server on this device",
    starting: "Bringing up local server…",
    running: "Hosting locally — share an invite to bring people in",
    stopping: "Stopping local server…",
    error: "",
  };

  const isRunning = ui.kind === "running";
  const isTransitioning = ui.kind === "starting" || ui.kind === "stopping";

  return (
    <div
      data-testid="local-hosting-control"
      className={`w-full p-3 rounded-xl border ${
        isRunning
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-outline-variant/20"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
          <span
            className={`material-symbols-outlined ${
              isRunning ? "text-emerald-400" : "text-on-surface-variant"
            }`}
            aria-hidden
          >
            {isRunning ? "dns" : "rocket_launch"}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-on-surface">
            {isRunning ? "Stop local hosting" : "Start local hosting"}
          </p>
          <p className="text-xs text-on-surface-variant truncate">
            {ui.kind === "error"
              ? `Error: ${ui.message}`
              : subtitleByKind[ui.kind]}
          </p>
        </div>
        {ui.kind === "error" ? (
          <button
            type="button"
            onClick={() => void onStart()}
            disabled={busy}
            data-testid="local-hosting-retry"
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-error/10 text-error border border-error/30 hover:bg-error/20 disabled:opacity-50"
          >
            Retry
          </button>
        ) : isRunning || ui.kind === "stopping" ? (
          <button
            type="button"
            onClick={() => void onStop()}
            disabled={busy || isTransitioning}
            data-testid="local-hosting-stop"
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-surface-container-high text-on-surface border border-outline-variant/20 hover:bg-surface-container-highest disabled:opacity-50"
          >
            {ui.kind === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onStart()}
            disabled={busy || isTransitioning}
            data-testid="local-hosting-start"
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-on-primary hover:bg-primary/90 disabled:opacity-50"
          >
            {ui.kind === "starting" ? "Starting…" : "Start"}
          </button>
        )}
      </div>
    </div>
  );
}
