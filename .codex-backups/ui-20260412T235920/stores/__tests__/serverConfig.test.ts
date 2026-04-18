import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useServerConfigStore, isTauriRuntime } from "../serverConfig";
import type { HomeserverConfig } from "../../api/wellKnown";

// The Tauri-side persistence bridge `setServerUrl` is mocked out
// unconditionally — we don't want tests running Tauri `invoke` calls.
// Individual tests toggle `__TAURI_INTERNALS__` on globalThis to
// exercise both the web and native branches of `setHomeserver` /
// `clearHomeserver`. `__TAURI_INTERNALS__` is the real Tauri v2 global
// that `@tauri-apps/api` consults — the legacy `__TAURI__` key used in
// earlier tests was wrong and hid a production regression where the
// real native app was always treated as web mode (see the 2026-04-10
// root-cause writeup in serverUrl.ts for the full story).
// The real `setServerUrl` is async and the store chains `.catch()` on
// its return value, so the mock must return a real Promise (not the
// default `undefined` from a bare `vi.fn()`).
vi.mock("../../api/serverUrl", () => ({
  setServerUrl: vi.fn(() => Promise.resolve()),
}));

// Import AFTER vi.mock so the dynamically-imported store picks up the
// mocked module. `setServerUrl` here is the same `vi.fn()` the store
// dynamic-imports inside `setHomeserver`/`clearHomeserver`.
import { setServerUrl as setServerUrlMock } from "../../api/serverUrl";

/**
 * Build a concrete `HomeserverConfig` value for store assertions.
 * Matches the shape produced by `discoverHomeserver` on the happy
 * path so the tests exercise a realistic payload.
 */
function sampleConfig(overrides?: Partial<HomeserverConfig>): HomeserverConfig {
  return {
    host: "example.test",
    homeserver_url: "https://matrix.example.test",
    api_base: "https://example.test/api",
    livekit_url: "wss://livekit.example.test",
    instance_name: "Example Instance",
    features: ["chat", "voice"],
    ...overrides,
  };
}

describe("useServerConfigStore", () => {
  beforeEach(() => {
    // Fully reset the store AND the persisted localStorage slot so
    // every test starts from a blank slate. Zustand's persist
    // middleware writes on every `set()`, so a leftover entry from a
    // prior test would leak into the next hydration.
    useServerConfigStore.setState({ config: null });
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
    vi.mocked(setServerUrlMock).mockReset();
    // Ensure the Tauri sentinel is removed by default. Tests that
    // exercise the Tauri branch set it explicitly via vi.stubGlobal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null config + null host on a fresh store", () => {
    const { config, selectedHost } = useServerConfigStore.getState();
    expect(config).toBeNull();
    expect(selectedHost()).toBeNull();
  });

  it("persists the config across a fresh hydrate and round-trips via selectedHost()", () => {
    const cfg = sampleConfig();
    useServerConfigStore.getState().setHomeserver(cfg);

    // The slot the persist middleware writes is keyed on
    // `concord_server_config`. The hydrated store replays this on
    // load via `persist()` — we simulate that by reading the raw
    // storage value and asserting it contains the config.
    const raw = window.localStorage.getItem("concord_server_config");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.config).toEqual(cfg);

    // In-memory state is the same value.
    expect(useServerConfigStore.getState().config).toEqual(cfg);
    expect(useServerConfigStore.getState().selectedHost()).toBe(
      "example.test",
    );
  });

  it("clearHomeserver resets the config to null and clears selectedHost", () => {
    useServerConfigStore.getState().setHomeserver(sampleConfig());
    expect(useServerConfigStore.getState().config).not.toBeNull();

    useServerConfigStore.getState().clearHomeserver();
    expect(useServerConfigStore.getState().config).toBeNull();
    expect(useServerConfigStore.getState().selectedHost()).toBeNull();
  });

  it("does NOT call the Tauri bridge in web mode (no __TAURI_INTERNALS__ global)", async () => {
    expect(isTauriRuntime()).toBe(false);

    useServerConfigStore.getState().setHomeserver(sampleConfig());
    // The dynamic import in setHomeserver is async; give it a tick.
    await Promise.resolve();
    await Promise.resolve();

    expect(setServerUrlMock).not.toHaveBeenCalled();
  });

  it("calls the Tauri bridge in native mode", () => {
    // Simulate a Tauri runtime by setting the sentinel on the real
    // window (not a stub). We clean this up in beforeEach.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};
    expect(isTauriRuntime()).toBe(true);

    const cfg = sampleConfig();
    useServerConfigStore.getState().setHomeserver(cfg);

    // Static-import path: the bridge call is synchronous (returns a
    // Promise but the CALL happens before the first await), so the
    // mock is invoked before this line executes.
    expect(setServerUrlMock).toHaveBeenCalledWith(cfg.homeserver_url);
  });

  it("clearHomeserver in native mode bridges a blank string to Tauri", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};

    useServerConfigStore.getState().setHomeserver(sampleConfig());
    vi.mocked(setServerUrlMock).mockClear();

    useServerConfigStore.getState().clearHomeserver();

    expect(setServerUrlMock).toHaveBeenCalledWith("");
  });
});
