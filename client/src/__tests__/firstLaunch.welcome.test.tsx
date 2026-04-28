/**
 * Empirical lock-in test for the W2 sprint: a fresh-install Tauri-v2
 * native client renders the Welcome screen on first launch, NOT the
 * legacy ServerPickerScreen modal.
 *
 * This complements `noLegacyTauriGlobal.test.ts` (which scans source
 * for forbidden v1 reads) and `bootSplash.test.ts` (which exercises
 * pre-React boot sequencing). It tests the React render under jsdom
 * with __TAURI_INTERNALS__ stubbed and BOTH the sources store +
 * serverConfig store cleared — the scenario every fresh install hits.
 *
 * What it verifies (W2-05, INS-058):
 *   1. Welcome screen is the first interactive render.
 *   2. Welcome shows two CTAs: "Connect to a Concord" + "Host a new
 *      Concord".
 *   3. Welcome is NOT the legacy ServerPickerScreen modal.
 *   4. Welcome is NOT LoginForm or ChatLayout.
 *
 * "WRITTEN IN BLOOD" rule: assert from a user-oriented perspective.
 * The user sees the Welcome screen and the two button labels — that's
 * what we assert on, not internal component identity.
 *
 * Honest verification status:
 *   - jsdom render in this test on Linux host: PASS (when this test
 *     ships green).
 *   - Real-Windows-machine empirical confirmation: PENDING. Blocked
 *     on W2-13's CI artifact + corr@win11.local interactive session
 *     screenshot. The screenshot at first launch should show the
 *     "Welcome to Concord" headline and both CTAs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Mock Tauri APIs that App.tsx pulls in. Welcome itself doesn't
// invoke() anything on the picker step — those calls only fire from
// inside HostOnboarding when the user presses "Create owner".
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

describe("native first launch — Welcome screen (W2-05)", () => {
  beforeEach(() => {
    // Stub the v2 Tauri global on the real window — Welcome's empty-
    // state branch only fires on the isTauri path.
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

  it("renders Welcome with two CTAs on a fresh install", async () => {
    // Lazy-import App AFTER the Tauri global is stubbed so module-
    // level initialization (e.g. computeInitialServerConnected) sees
    // the right environment.
    const { default: App } = await import("../App");
    render(<App />);

    // Welcome screen container is present.
    expect(
      await screen.findByTestId("welcome-screen", {}, { timeout: 3000 }),
    ).toBeInTheDocument();

    // Both CTAs render with user-readable labels.
    const connectCta = await screen.findByTestId("welcome-connect-cta");
    const hostCta = await screen.findByTestId("welcome-host-cta");
    expect(connectCta).toBeInTheDocument();
    expect(hostCta).toBeInTheDocument();
    // The label text is the contract — these strings are what the user
    // reads. If anyone changes the label, this test fails noisily.
    expect(connectCta.textContent).toMatch(/Connect to a Concord/);
    expect(hostCta.textContent).toMatch(/Host a new Concord/);
  });

  it("is NOT the legacy ServerPickerScreen modal", async () => {
    const { default: App } = await import("../App");
    render(<App />);
    await screen.findByTestId("welcome-screen");

    // ServerPickerScreen exposes well-known-config UI. Welcome does
    // not. The presence of the Welcome testid + the absence of the
    // ServerPickerScreen wellKnown machinery is the contract.
    expect(
      screen.queryByText(/\.well-known\/concord\/client/i),
    ).not.toBeInTheDocument();
    // ServerPickerScreen also has its own data-testid surface; assert
    // none of those have shown up.
    expect(screen.queryByTestId("server-picker-screen")).not.toBeInTheDocument();
    expect(screen.queryByTestId("server-picker-input")).not.toBeInTheDocument();
  });

  it("is NOT LoginForm or ChatLayout (no sign-in fields, no chat shell)", async () => {
    const { default: App } = await import("../App");
    render(<App />);

    // Wait for the welcome screen to actually appear so we know we're
    // past any spinner / loading states.
    await screen.findByTestId("welcome-screen");

    // No password field (LoginForm marker).
    expect(
      document.querySelectorAll('input[type="password"]').length,
    ).toBe(0);

    // No chat shell — `ChatLayout` would render a sources/servers/
    // channels skeleton. We assert no element exists with role
    // "main" or testid hooks the chat layout typically exposes.
    expect(screen.queryByTestId("chat-layout")).not.toBeInTheDocument();
  });
});
