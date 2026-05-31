import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// Service worker was removed. The pre-React inline script in
// index.html already unregisters any leftover SW from a previous
// deploy at HTML-parse time, before anything else runs. Registering
// a new one here would defeat that — it would install the stub SW
// again, whose activate handler would then run its cleanup cycle on
// every page load. One-shot unregister + no registration = no SW.
import { initServerUrl } from "./api/serverUrl";
import { useSourcesStore } from "./stores/sources";

// `__TAURI_INTERNALS__` is the canonical Tauri v2 global — see the
// comment in `client/src/api/serverUrl.ts` for the full explanation of
// why the v1 `__TAURI__` key is wrong.
const isNative =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Tag <html> with .tauri class so CSS can branch on native vs. web.
// Must run before React mounts — CSS rules like `html:not(.tauri)`
// rely on this class being present immediately (e.g., dvh override
// that causes layout overflow on iOS WKWebView).
if (isNative) {
  document.documentElement.classList.add("tauri");
}

// INS-065 instrumentation. The Concord window opens on Windows native
// builds but neither the boot splash nor the Welcome screen paints —
// no console output reaches us because we can't run devtools on the
// bundled build. Wire the renderer's error/lifecycle markers into a
// Tauri command that appends them to a file we can scp back. Removable
// once INS-065 is closed.
if (isNative && typeof window !== "undefined") {
  type LogFn = (msg: string) => void;
  const log: LogFn = (msg) => {
    try {
      const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> } };
      void w.__TAURI_INTERNALS__?.invoke?.("log_diagnostic", { msg });
    } catch {
      // diagnostic must never throw
    }
  };
  log(`BOOT main.tsx parsed; ua=${navigator.userAgent.slice(0, 120)}`);
  window.addEventListener("error", (e) => {
    log(`ERROR ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e.reason && (e.reason.stack || String(e.reason))) || "unknown";
    log(`UNHANDLED_REJECTION ${String(reason).slice(0, 500)}`);
  });
  // Lift the diag function so App.tsx can mark mount lifecycle.
  (window as unknown as { __concordDiag?: LogFn }).__concordDiag = log;
}

// Initialize server URL before rendering (resolves immediately in web mode,
// loads from Tauri store in desktop mode)
initServerUrl().then(() => {
  // INS-020: Auto-populate the Sources store on startup.
  // Runs once — if sources are already populated, this is a no-op.
  // Must run AFTER initServerUrl and AFTER zustand persist hydration.
  setTimeout(() => {
    if (isNative) {
      // Native: populate from persisted serverConfig (picker-confirm writes it)
      useSourcesStore.getState().migrateFromSession();
    } else if (typeof window !== "undefined") {
      // Web: origin IS the source. Build config from page location so the
      // Sources panel shows the current Concord instance without a picker.
      const { hostname, origin } = window.location;
      if (hostname) {
        useSourcesStore.getState().ensurePrimarySource({
          host: hostname,
          api_base: `${origin}/api`,
          homeserver_url: origin,
          instance_name: undefined,
        });
        // Async: try to get instance_name from well-known, then update
        fetch("/.well-known/concord/client")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((body: { instance_name?: string } | null) => {
            if (body?.instance_name) {
              useSourcesStore.getState().ensurePrimarySource({
                host: hostname,
                api_base: `${origin}/api`,
                homeserver_url: origin,
                instance_name: body.instance_name,
              });
            }
          });
      }
    }
  }, 0);

  const diag = (window as unknown as { __concordDiag?: (m: string) => void }).__concordDiag;
  diag?.("BOOT initServerUrl resolved, calling createRoot");
  const rootEl = document.getElementById("root");
  if (!rootEl) {
    diag?.("ERROR #root element missing from DOM");
    throw new Error("#root missing");
  }
  diag?.(`BOOT #root present; rootEl.children=${rootEl.children.length}`);
  try {
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    diag?.("BOOT createRoot.render returned synchronously");
  } catch (e) {
    diag?.(`ERROR createRoot.render threw: ${(e as Error)?.message || e}`);
    throw e;
  }
});
