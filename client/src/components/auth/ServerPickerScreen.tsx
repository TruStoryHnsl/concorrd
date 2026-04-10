import { useCallback, useState } from "react";
import {
  discoverHomeserver,
  DnsResolutionError,
  HttpServerError,
  InvalidUrlError,
  JsonParseError,
  type HomeserverConfig,
} from "../../api/wellKnown";
import { useServerConfigStore } from "../../stores/serverConfig";
import { usePlatform } from "../../hooks/usePlatform";

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
}

type UiState =
  | { phase: "input" }
  | { phase: "connecting" }
  | { phase: "success"; discovered: HomeserverConfig; apiBaseOverride: string }
  | { phase: "error"; message: string; recoverable: boolean };

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

export function ServerPickerScreen({ onConnected }: Props) {
  const [host, setHost] = useState("");
  const [state, setState] = useState<UiState>({ phase: "input" });
  const [pasteBlob, setPasteBlob] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const setHomeserver = useServerConfigStore((s) => s.setHomeserver);
  const { isTV } = usePlatform();

  const handleConnect = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = host.trim();
      if (trimmed.length === 0) return;

      setState({ phase: "connecting" });
      try {
        const discovered = await discoverHomeserver(trimmed);
        setState({
          phase: "success",
          discovered,
          apiBaseOverride: discovered.api_base,
        });
      } catch (err) {
        const { message, recoverable } = formatDiscoveryError(err);
        setState({ phase: "error", message, recoverable });
      }
    },
    [host],
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
    onConnected();
  }, [state, setHomeserver, onConnected]);

  const handleReset = useCallback(() => {
    setState({ phase: "input" });
  }, []);

  const handlePasteBlob = useCallback(() => {
    const raw = pasteBlob.trim();
    if (raw.length === 0) return;
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
        });
        return;
      }
      setState({
        phase: "success",
        discovered: cfg,
        apiBaseOverride: cfg.api_base,
      });
    } catch (err) {
      setState({
        phase: "error",
        message:
          err instanceof Error
            ? `Paste couldn't be parsed: ${err.message}`
            : "Paste couldn't be parsed.",
        recoverable: true,
      });
    }
  }, [pasteBlob]);

  return (
    <div className={`h-screen bg-surface flex items-center justify-center mesh-background${isTV ? " tv-picker-layout" : ""}`} data-testid="server-picker-screen" data-tv-mode={isTV || undefined}>
      <div className={`relative z-10 w-full px-6 ${isTV ? "max-w-xl" : "max-w-md"}`}>
        <div className="text-center mb-8">
          <h1 className="text-3xl font-headline font-bold text-on-surface mb-2">
            Concord
          </h1>
          <p className="text-on-surface-variant text-sm font-body">
            Connect to a Concord server
          </p>
        </div>

        {state.phase === "input" && (
          <form onSubmit={handleConnect} className="space-y-4" data-testid="server-picker-input-form">
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5">
                Hostname
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="concorrd.com"
                autoFocus
                required
                data-testid="server-picker-hostname-input"
                className="w-full px-4 py-3 bg-surface-container border border-outline-variant rounded-lg text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono text-sm"
              />
              <p className="text-xs text-on-surface-variant mt-1.5">
                Enter a hostname with no scheme — we'll discover the Concord API endpoints automatically.
              </p>
            </div>

            <button
              type="submit"
              disabled={host.trim().length === 0}
              data-testid="server-picker-connect-button"
              className="w-full py-3 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface font-medium rounded-lg transition-all text-sm"
            >
              Connect
            </button>

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
              <p className="text-sm text-error font-medium">Discovery failed</p>
              <p className="text-sm text-on-surface-variant mt-1 break-words">
                {state.message}
              </p>
            </div>
            <button
              type="button"
              onClick={handleReset}
              data-testid="server-picker-retry-button"
              className="w-full py-3 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm font-medium"
            >
              Try again
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
                onClick={handleReset}
                data-testid="server-picker-change-button"
                className="flex-1 py-3 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm font-medium"
              >
                Change
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                data-testid="server-picker-confirm-button"
                className="flex-1 py-3 primary-glow hover:brightness-110 text-on-surface font-medium rounded-lg text-sm"
              >
                Confirm
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
