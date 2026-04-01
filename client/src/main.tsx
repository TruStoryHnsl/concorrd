import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initServerUrl } from "./api/serverUrl";

// Initialize server URL before rendering (resolves immediately in web mode,
// loads from Tauri store in desktop mode)
initServerUrl().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
