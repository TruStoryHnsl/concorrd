/**
 * Empirical lock-in test for the post-HostOnboarding native first-launch
 * contract: a fresh-install Tauri-v2 native client drops straight into
 * ChatLayout. No Welcome screen, no Host CTA, no owner-registration
 * wizard.
 *
 * Background: the architecture removed account creation from first
 * launch entirely. The local porch is implicit, materialized by the
 * libp2p swarm; the user's only first-run knob is the vanity instance
 * name in Settings → Hosting. Matrix-account / login flows happen
 * per-source when the user adds an external auth-required source.
 *
 * What this test verifies on a Tauri build with empty stores:
 *   1. ChatLayout is the first interactive surface (no Welcome).
 *   2. Welcome is NOT rendered.
 *   3. ServerPickerScreen is NOT rendered.
 *   4. LoginForm is NOT rendered.
 *
 * "WRITTEN IN BLOOD" rule: assert from a user-oriented perspective. The
 * user opens a fresh native install and lands in the chat shell — that's
 * what we assert on, not internal component identity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Mock Tauri APIs that App.tsx pulls in.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

// Mock the Tauri-side persistence bridge so the serverConfig store's
// dynamic import doesn't hit the real Tauri runtime.
vi.mock("../api/serverUrl", () => ({
  setServerUrl: vi.fn(() => Promise.resolve()),
  getHomeserverUrl: vi.fn(() => ""),
  isDesktopMode: vi.fn(() => true),
}));

// `getInstanceInfo` is fetched on web/Docker boot; we want App.tsx to
// short-circuit out of that branch immediately on the Tauri path.
vi.mock("../api/concord", async () => {
  const actual = await vi.importActual<object>("../api/concord");
  return {
    ...actual,
    getInstanceInfo: vi.fn(() =>
      Promise.resolve({ first_boot: false, instance_domain: "" }),
    ),
    redeemInvite: vi.fn(() => Promise.reject(new Error("no invite"))),
  };
});

// `getVoiceToken` is awaited in some App effects; mock to a no-op.
vi.mock("../api/livekit", () => ({
  getVoiceToken: vi.fn(() => Promise.resolve(null)),
}));

// Replace ChatLayout with a sentinel — this test asserts WHICH screen
// App renders on a native fresh install, not ChatLayout's internals.
vi.mock("../components/layout/ChatLayout", () => ({
  ChatLayout: () => <div data-testid="chat-layout">ChatLayout sentinel</div>,
}));

// Welcome should NOT render on native. If it ever does, surface it.
vi.mock("../components/Welcome", () => ({
  Welcome: () => <div data-testid="welcome-screen">Welcome sentinel</div>,
}));

// LoginForm and ServerPickerScreen are web-only first-launch surfaces.
vi.mock("../components/auth/LoginForm", () => ({
  LoginForm: () => <div data-testid="login-form">LoginForm sentinel</div>,
}));

vi.mock("../components/auth/ServerPickerScreen", () => ({
  ServerPickerScreen: () => (
    <div data-testid="server-picker-screen">ServerPickerScreen sentinel</div>
  ),
}));

describe("native first launch — drops straight into ChatLayout", () => {
  beforeEach(() => {
    // Stub the v2 Tauri global on the real window.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};
    // Fresh storage — no persisted sources, no persisted serverConfig.
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.clear();
    }
  });

  afterEach(() => {
    cleanup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it("renders ChatLayout immediately — no Welcome, no LoginForm, no picker", async () => {
    // Lazy-import App AFTER the Tauri global is stubbed so module-
    // level initialization (e.g. computeInitialServerConnected) sees
    // the right environment.
    const { default: App } = await import("../App");
    render(<App />);

    // The chat shell is the first interactive surface on native.
    expect(
      await screen.findByTestId("chat-layout", {}, { timeout: 3000 }),
    ).toBeInTheDocument();

    // None of the pre-W2-removed first-launch gates render.
    expect(screen.queryByTestId("welcome-screen")).not.toBeInTheDocument();
    expect(screen.queryByTestId("server-picker-screen")).not.toBeInTheDocument();
    expect(screen.queryByTestId("login-form")).not.toBeInTheDocument();
    // No password field anywhere on native first launch.
    expect(
      document.querySelectorAll('input[type="password"]').length,
    ).toBe(0);
  });
});
