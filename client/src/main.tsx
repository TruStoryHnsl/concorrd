import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
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

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
