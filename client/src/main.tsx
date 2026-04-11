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
  // INS-020: On native first launch, auto-populate the Sources store
  // from the active session (serverConfig + federated instances).
  // Runs once — if sources are already populated, this is a no-op.
  // Must run AFTER initServerUrl (which hydrates the legacy server URL)
  // and AFTER zustand persist middleware has hydrated from localStorage.
  if (isNative) {
    // Small delay to ensure zustand persist hydration is complete
    setTimeout(() => useSourcesStore.getState().migrateFromSession(), 0);
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
