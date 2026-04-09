import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Standalone vitest config so we don't have to teach the production
// vite.config.ts about test-only plugins. Intentionally minimal: JSDOM
// environment, global test APIs, and the testing-library jest-dom
// matchers loaded via setupFiles.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
