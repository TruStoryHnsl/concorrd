import { useCallback, useEffect, useRef, useState } from "react";
import {
  discoverHomeserver,
  DnsResolutionError,
  HttpServerError,
  InvalidUrlError,
  JsonParseError,
  type HomeserverConfig,
} from "../../api/wellKnown";
import { useServerConfigStore } from "../../stores/serverConfig";
import { useSourcesStore } from "../../stores/sources";
import { usePlatform } from "../../hooks/usePlatform";
import { ConcordLogo } from "../brand/ConcordLogo";
import {
  isTauri as isTauriRuntime,
  servitudeStart,
  servitudeStatus,
  type ServitudeState,
} from "../../api/servitude";
import { GuestPairingScanner } from "../pairing/GuestPairingScanner";
import { createGuestSession } from "../../api/concord";

/**
 * First-launch server picker for native Concord builds (INS-027).
 *
 * Supersedes the legacy `ServerConnect.tsx`, which only accepted a
 * raw URL and hit `/api/health`. This component uses the new
 * well-known discovery helper to resolve the Concord API base, the
 * Matrix homeserver URL, the LiveKit signaling URL, and the
 * instance's human-readable name from a single user-entered hostname.
 *
 * Flow shape:
 *
 *   input → connecting → success → confirm → onConnected()
 *                     ↓
 *                   error → back to input
 *
 * Error handling surfaces distinct messages per failure mode so the
 * user can tell "I typed the wrong hostname" (DnsResolutionError)
 * apart from "the server I typed is broken" (HttpServerError) or
 * "that's a Matrix homeserver but not a Concord instance" (fallback
 * path with no Concord well-known).
 *
 * The "Advanced" affordance lets the user manually override the
 * discovered `api_base` for edge cases where the well-known is wrong
 * or missing and the Matrix-homeserver fallback points at the wrong
 * path. Shown inside the success state; collapsed by default.
 *
 * The "Paste config" affordance accepts a JSON blob containing a
 * HomeserverConfig shape — lets friends share connection details
 * without re-entering hostnames. Real QR code scanning is out of
 * scope here, but pasting a base64-encoded or plain JSON blob works.
 */

interface Props {
  onConnected: () => void;
  /**
   * Optional callback fired when the user chooses to skip the picker
   * entirely (the "Skip for now" link at the bottom of the menu).
   * App.tsx wires this to `closeAddSourceModal` so the user lands on
   * the hollow shell without committing to any source.
   */
  onSkip?: () => void;
  /**
   * Optional callback fired when the user successfully creates a guest
   * session. The caller is responsible for storing the session credentials
   * (access_token, user_id, device_id) and navigating away.
   */
  onGuestSession?: (session: { accessToken: string; userId: string; deviceId: string }) => void;
}

/**
 * Which path into the picker the user took. Threaded through every
 * phase so UI copy (placeholder text, helper hints, error guidance)
 * can adapt:
 *
 *   "join"   — the user wants to connect to an existing Concord
 *              instance run by someone else (friend, community,
 *              public directory). Hostname input flow that runs
 *              Concord well-known discovery.
 *   "matrix" — the user wants to connect to a vanilla Matrix
 *              homeserver as a first-class Source. Same hostname
 *              input flow as "join" but skips the Concord
 *              well-known probe and synthesises a minimal config
 *              directly from the typed hostname. Concord-specific
 *              features (server list, voice channels) won't light
 *              up; the rooms column populates from Matrix joins.
 *   "host"   — the user wants THIS device to be the server. The
 *              picker starts the embedded servitude (bundled
 *              tuwunel Matrix homeserver) as a child process and
 *              connects to `http://localhost:<port>` once it's up.
 *   "bridge" — escape hatch: connect to an externally-managed
 *              Docker Compose stack that the user has already
 *              started at `localhost:8080`. Full-fidelity Concord
 *              stack, but the user is responsible for starting it.
 */
type ServerOrigin = "join" | "matrix" | "host" | "bridge";

/**
 * UI state machine for the first-launch flow.
 *
 *   menu        → top-level "Join or Host" choice (desktop only;
 *                 mobile and browser builds skip straight to `input`
 *                 because hosting a full Concord stack requires a
 *                 machine that can run the bundled servitude).
 *   hosting     → embedded servitude startup: polls the Rust-side
 *                 `servitude_status` command and shows live progress
 *                 text as the lifecycle transitions stopped →
 *                 starting → running. On `running`, the picker
 *                 synthesises a local HomeserverConfig pointing at
 *                 `http://localhost:<port>` and confirms.
 *   input       → hostname text field + form. Used by join + bridge.
 *   connecting  → spinner while `discoverHomeserver()` runs.
 *   success     → discovered config preview + Confirm / Change.
 *   error       → failure message + retry. The copy adapts to origin.
 */
type UiState =
  | { phase: "menu" }
  | { phase: "hosting"; stage: "preparing" | "starting" | "waiting" | "running" | "failed"; message: string }
  | { phase: "input"; origin: ServerOrigin }
  | { phase: "connecting"; origin: ServerOrigin }
  | { phase: "success"; discovered: HomeserverConfig; apiBaseOverride: string; origin: ServerOrigin }
  | { phase: "error"; message: string; recoverable: boolean; origin: ServerOrigin };

/**
 * Map a thrown error from {@link discoverHomeserver} to a UI-friendly
 * message. Distinct per error class so the user knows whether to
 * retry, fix their input, or give up.
 */
function formatDiscoveryError(err: unknown): {
  message: string;
  recoverable: boolean;
} {
  if (err instanceof DnsResolutionError) {
    return {
      message:
        "Couldn't reach that host. Check the spelling and your internet connection, then try again.",
      recoverable: true,
    };
  }
  if (err instanceof InvalidUrlError) {
    return {
      message: `That doesn't look like a valid hostname: ${err.message}`,
      recoverable: true,
    };
  }
  if (err instanceof HttpServerError) {
    return {
      message: `The server is returning errors (${err.message}). Try again in a few minutes, or contact the instance operator.`,
      recoverable: true,
    };
  }
  if (err instanceof JsonParseError) {
    return {
      message:
        "That host responded, but its discovery document is malformed. This instance may be misconfigured.",
      recoverable: true,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, recoverable: true };
  }
  return { message: String(err), recoverable: true };
}

export function ServerPickerScreen({ onConnected, onSkip, onGuestSession }: Props) {
  const { isTauri, isMobile } = usePlatform();
  // Hosting is a desktop-only affordance, but the top-level menu is
  // available on every native shell so mobile users still land on the
  // same Host/Join decision point before they enter a domain.
  const canHost = isTauri && !isMobile;

  const [host, setHost] = useState("");
  // Native apps always start at the top-level menu. Browser-only paths
  // no longer use this screen on boot.
  const [state, setState] = useState<UiState>(() =>
    isTauri ? { phase: "menu" } : { phase: "input", origin: "join" },
  );
  const [pasteBlob, setPasteBlob] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  // INS-022: toggles the GuestPairingScanner modal.
  const [scannerOpen, setScannerOpen] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const setHomeserver = useServerConfigStore((s) => s.setHomeserver);
  const ensurePrimarySource = useSourcesStore((s) => s.ensurePrimarySource);

  const handleBrowseAsGuest = useCallback(async () => {
    setGuestLoading(true);
    setGuestError(null);
    try {
      const session = await createGuestSession();
      if (onGuestSession) {
        onGuestSession({
          accessToken: session.access_token,
          userId: session.user_id,
          deviceId: session.device_id,
        });
      }
    } catch (err) {
      setGuestError(err instanceof Error ? err.message : "Guest session failed");
    } finally {
      setGuestLoading(false);
    }
  }, [onGuestSession]);

  // Cancellation token for the hosting poll loop. React state reads
  // inside closures capture at spawn time, so we can't gate on
  // `state.phase` from inside the async poll. Instead we flip a
  // ref-held counter every time the user leaves the hosting phase;
  // the poll loop checks its captured generation against the current
  // generation on each iteration and bails out on mismatch.
  const hostingGenerationRef = useRef(0);

  // TV shell: a TV device picks up the wrapper class + focus-group
  // attributes below so DPAD navigation (useDpadNav) has a target
  // group to hand focus to, and tv.css can style the picker as a
  // 10-foot screen. Desktop / mobile flags are ignored here — this
  // branch is purely additive.
  const { isTV } = usePlatform();
  const hostInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!isTV || state.phase !== "input") return;
    // On TV the autofocus attribute alone isn't always honored by
    // WebKit-based TV shells; explicitly pull focus into the input
    // once the input phase mounts so the DPAD ring has somewhere to
    // land immediately.
    hostInputRef.current?.focus();
  }, [isTV, state.phase]);

  const handleConnect = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = host.trim();
      if (trimmed.length === 0) return;

      const origin: ServerOrigin =
        state.phase === "input" ? state.origin : "join";
      setState({ phase: "connecting", origin });

      // Matrix origin: skip the Concord well-known probe entirely.
      // A vanilla Matrix homeserver doesn't serve `/.well-known/concord/client`,
      // so `discoverHomeserver` would fail. Synthesize a minimal config from
      // the typed hostname so the user can land on the hollow shell with the
      // Matrix instance attached as a Source. Real `.well-known/matrix/client`
      // delegation discovery is a follow-up — for now we assume the typed
      // hostname IS the homeserver.
      if (origin === "matrix") {
        const matrixHost = trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
        const config: HomeserverConfig = {
          host: matrixHost,
          homeserver_url: `https://${matrixHost}`,
          api_base: `https://${matrixHost}`,
          instance_name: matrixHost,
          features: [],
        };
        setState({
          phase: "success",
          discovered: config,
          apiBaseOverride: config.api_base,
          origin,
        });
        return;
      }

      try {
        const discovered = await discoverHomeserver(trimmed);
        setState({
          phase: "success",
          discovered,
          apiBaseOverride: discovered.api_base,
          origin,
        });
      } catch (err) {
        const { message, recoverable } = formatDiscoveryError(err);
        setState({ phase: "error", message, recoverable, origin });
      }
    },
    [host, state],
  );

  const handleConfirm = useCallback(() => {
    if (state.phase !== "success") return;
    const finalConfig: HomeserverConfig = {
      ...state.discovered,
      // Apply the advanced-mode api_base override if the user changed
      // it. The override is free-text; client-side validation is
      // minimal (starts with https://), because power users sometimes
      // want to point at a local dev server and the strict `new URL()`
      // check already happened inside `discoverHomeserver`.
      api_base: state.apiBaseOverride.replace(/\/+$/, ""),
    };
    setHomeserver(finalConfig);
    // INS-020: mirror the connection into the Sources store so the
    // Sources column reflects the new primary connection immediately.
    // `ensurePrimarySource` is idempotent — if the same host already
    // has a primary source entry, it's updated in place; otherwise a
    // new one is added with `origin: "primary"` so the Sources column
    // can render the distinction from federated/extension-added
    // sources in a later phase.
    ensurePrimarySource({
      host: finalConfig.host,
      instance_name: finalConfig.instance_name ?? undefined,
      api_base: finalConfig.api_base,
      homeserver_url: finalConfig.homeserver_url,
    });
    onConnected();
  }, [state, setHomeserver, ensurePrimarySource, onConnected]);

  // "Back" from the input / error / hosting screens: on hosts that
  // can host, return to the top-level menu; on mobile-only builds,
  // clear state and stay in the input form (since the menu is
  // skipped there). Bumping the hosting generation cancels any
  // in-flight servitude poll loop so it doesn't race back into the
  // hosting phase after the user has already navigated away.
  const handleReset = useCallback(() => {
    hostingGenerationRef.current += 1;
    if (isTauri) {
      setState({ phase: "menu" });
      setHost("");
    } else {
      setState({ phase: "input", origin: "join" });
    }
  }, [isTauri]);

  // "Change" from the success screen: return to the hostname input,
  // preserving the origin so the user doesn't have to re-pick Join
  // vs Host every time they fix a typo.
  const handleEditHost = useCallback(() => {
    if (state.phase !== "success") return;
    setState({ phase: "input", origin: state.origin });
  }, [state]);

  const handleChooseJoin = useCallback(() => {
    setHost("");
    setState({ phase: "input", origin: "join" });
  }, []);

  // INS-022: QR pairing success — the scanner decoded a well-known-
  // shaped payload. Commit it to the store via `setHomeserver` and go
  // straight to the hollow shell through `onConnected`, mirroring the
  // typed-hostname success path.
  const handlePairingSuccess = useCallback(
    (discovered: HomeserverConfig) => {
      setScannerOpen(false);
      setHomeserver(discovered);
      ensurePrimarySource({
        host: discovered.host,
        instance_name: discovered.instance_name ?? undefined,
        api_base: discovered.api_base,
        homeserver_url: discovered.homeserver_url,
      });
      onConnected();
    },
    [setHomeserver, ensurePrimarySource, onConnected],
  );

  // "Join a Matrix instance" — same hostname-input UX as Concord join,
  // but `handleConnect` will skip the Concord well-known probe for the
  // matrix origin and synthesise a HomeserverConfig directly. The user
  // ends up with a Matrix homeserver attached as a first-class Source.
  const handleChooseMatrix = useCallback(() => {
    setHost("");
    setState({ phase: "input", origin: "matrix" });
  }, []);

  // "Host your own" → start the embedded servitude as a child
  // process and connect to it once it reports Running.
  //
  // Sequence:
  //   1. Transition the UI to the `hosting` phase with stage=preparing.
  //   2. Call `servitudeStart` — this spawns the bundled tuwunel
  //      Matrix homeserver as a subprocess of the Tauri shell.
  //   3. Poll `servitudeStatus` on a 500ms cadence; advance the
  //      stage label as the lifecycle transitions
  //      stopped → starting → running.
  //   4. On `running`, synthesise a local HomeserverConfig pointing
  //      at `http://127.0.0.1:8765` (the default embedded port) and
  //      call `setHomeserver` + `onConnected`.
  //   5. On any poll error or explicit "failed" state, fall through
  //      to the hosting-phase "failed" sub-state with a readable
  //      message — the user can cancel and pick another path.
  //
  // IMPORTANT: the bundled host is Matrix-only at the moment.
  // concord-api and LiveKit are NOT embedded yet, so Concord-specific
  // features (server list, voice channels, extensions, soundboard,
  // federation UI) will fail until those services are also bundled.
  // See PLAN.md §INS-030 for the follow-up.
  //
  // The fallback for users who want the full stack is the "Bridge
  // to docker-compose" path exposed as an Advanced affordance on
  // the menu — that route assumes the user is already running
  // `docker compose up -d` somewhere and just wants the picker to
  // point at `localhost:8080`.
  const handleChooseHost = useCallback(() => {
    if (!isTauriRuntime()) {
      setState({
        phase: "error",
        message:
          "Embedded hosting is only available in the native desktop app. Use a browser to connect to an existing instance instead.",
        recoverable: false,
        origin: "host",
      });
      return;
    }

    // Bump the generation so any already-running poll loop from a
    // previous Host click will bail out on its next iteration.
    hostingGenerationRef.current += 1;
    const generation = hostingGenerationRef.current;

    setState({
      phase: "hosting",
      stage: "preparing",
      message: "Preparing local instance…",
    });

    // Fire-and-forget the start call; the poll loop below is the
    // source of truth for lifecycle progress. If `servitudeStart`
    // itself rejects we surface that to the failed sub-state.
    void (async () => {
      try {
        await servitudeStart();
      } catch (err) {
        if (hostingGenerationRef.current !== generation) return;
        setState({
          phase: "hosting",
          stage: "failed",
          message:
            err instanceof Error
              ? `Couldn't start the embedded host: ${err.message}`
              : "Couldn't start the embedded host.",
        });
        return;
      }

      // Poll the Rust-side lifecycle until we see `running` or we
      // hit the 60s cap. Startup usually takes 2-5s on a warm
      // install (tuwunel boot + key generation), longer on cold.
      const POLL_MS = 500;
      const TIMEOUT_MS = 60_000;
      const startedAt = Date.now();

      const stageFor = (s: ServitudeState): {
        stage: "preparing" | "starting" | "waiting" | "running" | "failed";
        message: string;
      } => {
        switch (s) {
          case "stopped":
            return { stage: "preparing", message: "Preparing local instance…" };
          case "starting":
            return {
              stage: "starting",
              message: "Starting bundled Matrix homeserver…",
            };
          case "running":
            return { stage: "running", message: "Local instance ready." };
          case "stopping":
            return {
              stage: "failed",
              message: "Local instance stopped unexpectedly while starting.",
            };
        }
      };

      while (Date.now() - startedAt < TIMEOUT_MS) {
        // Honor cancellation (user clicked Cancel / Back).
        if (hostingGenerationRef.current !== generation) return;
        try {
          const s = await servitudeStatus();
          if (hostingGenerationRef.current !== generation) return;
          const next = stageFor(s.state);
          setState({ phase: "hosting", stage: next.stage, message: next.message });
          if (s.state === "running") {
            // Synthesise a local HomeserverConfig. The port is the
            // default 8765 — operators who changed it in Settings →
            // Node Hosting need to reconnect via that tab for now;
            // reading the configured port from here needs a new
            // Tauri command (TODO).
            const localPort = 8765;
            const localHost = `localhost:${localPort}`;
            const localConfig: HomeserverConfig = {
              host: localHost,
              homeserver_url: `http://${localHost}`,
              api_base: `http://${localHost}/api`,
              instance_name: "Local Concord Node",
              features: [],
            };
            setHomeserver(localConfig);
            // INS-020: mirror into Sources store so the leftmost
            // column reflects the new local host immediately.
            ensurePrimarySource({
              host: localConfig.host,
              instance_name: localConfig.instance_name ?? undefined,
              api_base: localConfig.api_base,
              homeserver_url: localConfig.homeserver_url,
            });
            onConnected();
            return;
          }
          if (s.state === "stopping") {
            return; // already reflected in state above
          }
        } catch (err) {
          if (hostingGenerationRef.current !== generation) return;
          setState({
            phase: "hosting",
            stage: "failed",
            message:
              err instanceof Error
                ? `Status poll failed: ${err.message}`
                : "Status poll failed.",
          });
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      if (hostingGenerationRef.current !== generation) return;
      setState({
        phase: "hosting",
        stage: "failed",
        message:
          `Local instance did not start within ${TIMEOUT_MS / 1000}s. Check the app logs and try again.`,
      });
    })();
  }, [setHomeserver, ensurePrimarySource, onConnected]);

  // Advanced: attach to an externally-managed docker-compose stack.
  // Used when the operator already has a full Concord stack running
  // at `localhost:8080` (via `docker compose up -d`) and just wants
  // the picker to point at it. Distinct from the embedded-host path
  // above because this one talks to a real concord-api + LiveKit,
  // which the embedded servitude doesn't bundle yet.
  const handleChooseBridge = useCallback(() => {
    setHost("localhost:8080");
    setState({ phase: "input", origin: "bridge" });
  }, []);

  const handlePasteBlob = useCallback(() => {
    const raw = pasteBlob.trim();
    if (raw.length === 0) return;
    const origin: ServerOrigin =
      state.phase === "input" ? state.origin : "join";
    try {
      // Accept either plain JSON or a `concord://` URL with a JSON fragment.
      let jsonText = raw;
      if (raw.startsWith("concord://")) {
        const rest = raw.slice("concord://".length);
        // Decode if base64-urlsafe, otherwise treat as plain JSON text.
        try {
          jsonText = atob(rest);
        } catch {
          jsonText = decodeURIComponent(rest);
        }
      }
      const parsed: unknown = JSON.parse(jsonText);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof (parsed as HomeserverConfig).api_base !== "string" ||
        typeof (parsed as HomeserverConfig).homeserver_url !== "string" ||
        typeof (parsed as HomeserverConfig).host !== "string"
      ) {
        setState({
          phase: "error",
          message: "Pasted config is missing required fields (host, homeserver_url, api_base).",
          recoverable: true,
          origin,
        });
        return;
      }
      // Validate HTTPS via the same check the discovery helper uses —
      // a bad blob can't sneak past the URL validator this way.
      const cfg = parsed as HomeserverConfig;
      if (!cfg.api_base.startsWith("https://") || !cfg.homeserver_url.startsWith("https://")) {
        setState({
          phase: "error",
          message: "Pasted config has non-HTTPS URLs. Only https:// is allowed.",
          recoverable: true,
          origin,
        });
        return;
      }
      setState({
        phase: "success",
        discovered: cfg,
        apiBaseOverride: cfg.api_base,
        origin,
      });
    } catch (err) {
      setState({
        phase: "error",
        message:
          err instanceof Error
            ? `Paste couldn't be parsed: ${err.message}`
            : "Paste couldn't be parsed.",
        recoverable: true,
        origin,
      });
    }
  }, [pasteBlob, state]);

  // Subtitle copy adapts to where the user is in the flow. The menu
  // reads as a top-level welcome; everything else frames the action.
  const subtitle = (() => {
    switch (state.phase) {
      case "menu":
        return "Join, bridge, or host — pick how you want to start.";
      case "hosting":
        return "Spinning up your local instance.";
      case "input":
        if (state.origin === "bridge") return "Connect to your local Docker Compose stack.";
        if (state.origin === "matrix") return "Connect to an existing Matrix homeserver.";
        return "Connect to an existing Concord server.";
      case "connecting":
        if (state.origin === "bridge") return "Looking for your local stack…";
        if (state.origin === "matrix") return "Building Matrix homeserver config…";
        return "Discovering endpoints…";
      case "success":
        return "Ready to connect.";
      case "error":
        if (state.origin === "bridge") return "Couldn't find a local stack.";
        return "Couldn't reach that server.";
    }
  })();

  // TV mode applies a second class to the outer wrapper so the
  // `.tv-server-picker` rules in `client/src/styles/tv.css` take
  // effect (large fonts, high-contrast inputs, vertical centering
  // scaled for 10-foot viewing). data-focus-group on the wrapper
  // scopes DPAD navigation to this screen only. The extra class is
  // additive — desktop / mobile viewports render identically to the
  // pre-TV layout.
  const rootClassName = isTV
    ? "h-screen bg-surface flex items-center justify-center mesh-background tv-server-picker"
    : "h-screen bg-surface flex items-center justify-center mesh-background";
  const tvFocusProps = isTV
    ? { "data-focusable": "true", "data-focus-group": "tv-server-picker" }
    : {};

  return (
    <div
      className={rootClassName}
      data-testid="server-picker-screen"
      data-tv-picker={isTV ? "true" : undefined}
    >
      <div className="relative z-10 w-full max-w-md px-6">
        <div className="text-center mb-8">
          <ConcordLogo size={72} className="mx-auto mb-4" />
          <h1 className="text-3xl font-headline font-bold text-on-surface mb-2">
            Concord
          </h1>
          <p className="text-on-surface-variant text-sm font-body">
            {subtitle}
          </p>
        </div>

        {state.phase === "menu" && (
          <div className="space-y-3" data-testid="server-picker-menu">
            <button
              type="button"
              onClick={handleChooseJoin}
              data-testid="server-picker-choose-join"
              className="w-full p-5 bg-surface-container hover:bg-surface-container-high border border-outline-variant/20 rounded-xl text-left transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-primary text-2xl shrink-0 mt-0.5">
                  login
                </span>
                <div>
                  <div className="text-base font-medium text-on-surface mb-0.5">
                    Join an existing instance
                  </div>
                  <div className="text-xs text-on-surface-variant">
                    Enter the hostname of a Concord server a friend or community runs.
                  </div>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={handleChooseMatrix}
              data-testid="server-picker-choose-matrix"
              className="w-full p-5 bg-surface-container hover:bg-surface-container-high border border-outline-variant/20 rounded-xl text-left transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-primary text-2xl shrink-0 mt-0.5">
                  hub
                </span>
                <div>
                  <div className="text-base font-medium text-on-surface mb-0.5">
                    Join a Matrix instance
                  </div>
                  <div className="text-xs text-on-surface-variant">
                    Attach a vanilla Matrix homeserver as a source. Concord-specific features won't light up, but rooms work.
                  </div>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={handleChooseHost}
              data-testid="server-picker-choose-host"
              className="w-full p-5 bg-surface-container hover:bg-surface-container-high border border-outline-variant/20 rounded-xl text-left transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-primary text-2xl shrink-0 mt-0.5">
                  dns
                </span>
                <div>
                  <div className="text-base font-medium text-on-surface mb-0.5">
                    Host your own
                  </div>
                  <div className="text-xs text-on-surface-variant">
                    Turn this device into a Concord node. Starts a bundled Matrix homeserver — no Docker required.
                  </div>
                  <div className="text-[11px] text-on-surface-variant/70 mt-1">
                    Experimental · Matrix-only · Full Concord features require an external stack
                  </div>
                </div>
              </div>
            </button>

            {onGuestSession && (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={handleBrowseAsGuest}
                  disabled={guestLoading}
                  data-testid="server-picker-guest"
                  className="w-full text-center text-xs text-primary/80 hover:text-primary pt-2 pb-0.5 transition-colors disabled:opacity-50"
                >
                  {guestLoading ? "Creating guest session…" : "Browse as guest — no account needed"}
                </button>
                {guestError && (
                  <p className="text-xs text-error text-center">{guestError}</p>
                )}
              </div>
            )}

            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                data-testid="server-picker-skip"
                className="w-full text-center text-xs text-on-surface-variant hover:text-on-surface pt-2 pb-1 transition-colors"
              >
                Skip for now — explore the empty shell
              </button>
            )}

            {/* INS-022: scan a pairing QR generated on another phone's
                Node tab to join the same instance without typing. */}
            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              data-testid="server-picker-pair-from-device"
              className="w-full p-5 bg-surface-container hover:bg-surface-container-high border border-outline-variant/20 rounded-xl text-left transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-primary text-2xl shrink-0 mt-0.5">
                  qr_code_scanner
                </span>
                <div>
                  <div className="text-base font-medium text-on-surface mb-0.5">
                    Pair from another device
                  </div>
                  <div className="text-xs text-on-surface-variant">
                    Scan a QR code shown on another phone's Concord app to
                    join the same instance.
                  </div>
                </div>
              </div>
            </button>

            <details className="pt-1">
              <summary className="cursor-pointer text-xs text-on-surface-variant hover:text-on-surface px-2">
                Advanced
              </summary>
              <button
                type="button"
                onClick={handleChooseBridge}
                data-testid="server-picker-choose-bridge"
                className="w-full mt-2 p-4 bg-surface-container-low hover:bg-surface-container border border-outline-variant/10 rounded-xl text-left transition-colors"
              >
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-on-surface-variant text-xl shrink-0 mt-0.5">
                    cable
                  </span>
                  <div>
                    <div className="text-sm font-medium text-on-surface mb-0.5">
                      Bridge to a local Docker stack
                    </div>
                    <div className="text-xs text-on-surface-variant">
                      For users already running <code>docker compose up -d</code> in the Concord repo. Connects to <code>localhost:8080</code> and gives the full Concord feature set.
                    </div>
                  </div>
                </div>
              </button>
            </details>
          </div>
        )}

        {state.phase === "hosting" && (
          <div className="space-y-4" data-testid="server-picker-hosting">
            {state.stage !== "failed" ? (
              <>
                <div className="flex flex-col items-center gap-3 py-6">
                  {state.stage === "running" ? (
                    <span className="material-symbols-outlined text-primary text-5xl">
                      check_circle
                    </span>
                  ) : (
                    <span className="inline-block w-8 h-8 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
                  )}
                  <p className="text-sm text-on-surface font-medium">
                    {state.message}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                    <span className={state.stage !== "preparing" ? "text-primary" : ""}>
                      prepare
                    </span>
                    <span>›</span>
                    <span className={state.stage === "starting" || state.stage === "waiting" || state.stage === "running" ? "text-primary" : ""}>
                      start
                    </span>
                    <span>›</span>
                    <span className={state.stage === "running" ? "text-primary" : ""}>
                      ready
                    </span>
                  </div>
                </div>

                {/* Scope note — be explicit about the Matrix-only
                    limitation so the user isn't surprised when
                    Concord-specific features don't light up. */}
                <div className="rounded-lg bg-surface-container-low/60 border border-outline-variant/15 px-4 py-3">
                  <p className="text-xs text-on-surface-variant leading-relaxed">
                    The bundled host runs a Matrix homeserver only.
                    Concord-specific features (server list, voice,
                    extensions, federation UI) aren't embedded yet
                    and will be unavailable until the full stack is
                    packaged. For a fully-featured host today, use
                    the "Bridge to a local Docker stack" option on
                    the menu.
                  </p>
                </div>
              </>
            ) : (
              <div className="px-4 py-3 rounded-lg bg-error-container/10 border border-error/20">
                <p className="text-sm text-error font-medium">
                  Couldn't start the local instance
                </p>
                <p className="text-sm text-on-surface-variant mt-1 break-words">
                  {state.message}
                </p>
                <p className="text-xs text-on-surface-variant mt-3">
                  Try restarting the app, or check
                  Settings → Node Hosting for more control over
                  the embedded servitude.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={handleReset}
              data-testid="server-picker-hosting-back-button"
              className="w-full py-3 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm font-medium"
            >
              {state.stage === "failed" ? "Back to menu" : "Cancel"}
            </button>
          </div>
        )}

        {state.phase === "input" && (
          <form onSubmit={handleConnect} className="space-y-4" data-testid="server-picker-input-form">
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5">
                {state.origin === "bridge"
                  ? "Local address"
                  : state.origin === "matrix"
                    ? "Matrix homeserver"
                    : "Hostname"}
              </label>
              <input
                type="text"
                ref={hostInputRef}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={
                  state.origin === "bridge"
                    ? "localhost:8080"
                    : state.origin === "matrix"
                      ? "matrix.org"
                      : "chat.example.com"
                }
                autoFocus
                required
                data-testid="server-picker-hostname-input"
                {...tvFocusProps}
                className="w-full px-4 py-3 bg-surface-container border border-outline-variant rounded-lg text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono text-sm"
              />
              <p className="text-xs text-on-surface-variant mt-1.5">
                {state.origin === "bridge"
                  ? "Default docker-compose deployments run on localhost:8080. Change if you set a custom port."
                  : state.origin === "matrix"
                    ? "Enter a Matrix homeserver hostname. We won't probe for Concord endpoints — Concord-specific features won't be available, but Matrix rooms will work."
                    : "Enter a hostname with no scheme — we'll discover the Concord API endpoints automatically."}
              </p>
            </div>

            <div className="flex gap-2">
              {canHost && (
                <button
                  type="button"
                  onClick={handleReset}
                  data-testid="server-picker-back-to-menu-button"
                  className="px-4 py-3 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm font-medium"
                >
                  Back
                </button>
              )}
              <button
                type="submit"
                disabled={host.trim().length === 0}
                data-testid="server-picker-connect-button"
                {...tvFocusProps}
                className="flex-1 py-3 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface font-medium rounded-lg transition-all text-sm"
              >
                Connect
              </button>
            </div>

            <div className="border-t border-outline-variant/20 pt-4">
              <details className="text-sm">
                <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
                  Paste shared config
                </summary>
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-on-surface-variant">
                    Paste a shared Concord config JSON or <code>concord://</code> URL. Use this to connect using details sent by a friend.
                  </p>
                  <textarea
                    value={pasteBlob}
                    onChange={(e) => setPasteBlob(e.target.value)}
                    placeholder='{"host":"...","homeserver_url":"...","api_base":"..."}'
                    data-testid="server-picker-paste-textarea"
                    className="w-full h-20 px-3 py-2 bg-surface-container border border-outline-variant rounded text-on-surface placeholder-on-surface-variant/40 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    type="button"
                    onClick={handlePasteBlob}
                    disabled={pasteBlob.trim().length === 0}
                    data-testid="server-picker-paste-button"
                    className="px-3 py-1.5 text-xs bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded disabled:opacity-40"
                  >
                    Use pasted config
                  </button>
                </div>
              </details>
            </div>
          </form>
        )}

        {state.phase === "connecting" && (
          <div className="flex flex-col items-center gap-3 py-8" data-testid="server-picker-connecting">
            <span className="inline-block w-6 h-6 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
            <p className="text-sm text-on-surface-variant">
              Discovering Concord endpoints on {host.trim()}…
            </p>
          </div>
        )}

        {state.phase === "error" && (
          <div className="space-y-4" data-testid="server-picker-error">
            <div className="px-4 py-3 rounded-lg bg-error-container/10 border border-error/20">
              <p className="text-sm text-error font-medium">
                {state.origin === "bridge"
                  ? "No local stack found"
                  : "Discovery failed"}
              </p>
              <p className="text-sm text-on-surface-variant mt-1 break-words">
                {state.message}
              </p>
              {state.origin === "bridge" && (
                <div className="mt-3 pt-3 border-t border-outline-variant/20">
                  <p className="text-xs text-on-surface-variant mb-2">
                    To bring up a local Docker stack, clone the Concord repo and run:
                  </p>
                  <pre className="text-xs bg-surface-container-high rounded px-2 py-1.5 font-mono text-on-surface overflow-x-auto">docker compose up -d</pre>
                  <p className="text-xs text-on-surface-variant mt-2">
                    Then retry this screen. The stack listens on port 8080 by default.
                  </p>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleReset}
              data-testid="server-picker-retry-button"
              {...tvFocusProps}
              className="w-full py-3 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm font-medium"
            >
              {canHost ? "Back to menu" : "Try again"}
            </button>
          </div>
        )}

        {state.phase === "success" && (
          <div className="space-y-4" data-testid="server-picker-success">
            <div className="rounded-lg bg-surface-container-low/60 border border-outline-variant/15 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-base">check_circle</span>
                <p className="text-base font-medium text-on-surface">
                  {state.discovered.instance_name ?? state.discovered.host}
                </p>
              </div>
              <dl className="text-xs text-on-surface-variant space-y-1">
                <div className="flex gap-2">
                  <dt className="shrink-0 w-20">Host:</dt>
                  <dd className="break-all font-mono" data-testid="server-picker-host">
                    {state.discovered.host}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 w-20">API:</dt>
                  <dd className="break-all font-mono" data-testid="server-picker-api-base">
                    {state.discovered.api_base}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 w-20">Homeserver:</dt>
                  <dd className="break-all font-mono">
                    {state.discovered.homeserver_url}
                  </dd>
                </div>
                {state.discovered.livekit_url && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 w-20">LiveKit:</dt>
                    <dd className="break-all font-mono">
                      {state.discovered.livekit_url}
                    </dd>
                  </div>
                )}
              </dl>
            </div>

            <details
              className="text-sm"
              open={showAdvanced}
              onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
              data-testid="server-picker-advanced"
            >
              <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
                Advanced: override API base
              </summary>
              <div className="mt-2 space-y-1">
                <input
                  type="text"
                  value={state.apiBaseOverride}
                  onChange={(e) =>
                    setState((prev) =>
                      prev.phase === "success"
                        ? { ...prev, apiBaseOverride: e.target.value }
                        : prev,
                    )
                  }
                  data-testid="server-picker-api-base-override-input"
                  className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-on-surface font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="text-xs text-on-surface-variant">
                  Only change this if the discovered value is wrong. Must start with <code>https://</code>.
                </p>
              </div>
            </details>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleEditHost}
                data-testid="server-picker-change-button"
                {...tvFocusProps}
                className="flex-1 py-3 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm font-medium"
              >
                Change
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                data-testid="server-picker-confirm-button"
                {...tvFocusProps}
                className="flex-1 py-3 primary-glow hover:brightness-110 text-on-surface font-medium rounded-lg text-sm"
              >
                Confirm
              </button>
            </div>
          </div>
        )}
      </div>

      {/* INS-022: Pairing scanner modal — mounted at the screen root so
          it overlays every phase. Unmounted entirely when closed so the
          camera permission prompt only fires when the user opts in. */}
      {scannerOpen && (
        <GuestPairingScanner
          onSuccess={handlePairingSuccess}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}
