/**
 * Tests for the tvOS WKWebView host bridge module.
 *
 * Validates that:
 *   1. All exports no-op gracefully when window.concordTVHost is absent.
 *   2. When the bridge is present, calls are delegated correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The module evaluates `isAppleTV` at import time, so we need to
// manipulate `window.concordTVHost` BEFORE importing. Vitest's
// `vi.resetModules()` + dynamic import handles this.

describe("tvOSHost — no bridge (non-tvOS)", () => {
  it("isAppleTV is false when concordTVHost is absent", async () => {
    delete (window as Record<string, unknown>).concordTVHost;
    vi.resetModules();
    const mod = await import("../tvOSHost");
    expect(mod.isAppleTV).toBe(false);
  });

  it("setServerConfig is a no-op", async () => {
    delete (window as Record<string, unknown>).concordTVHost;
    vi.resetModules();
    const mod = await import("../tvOSHost");
    // Should not throw
    mod.setServerConfig({ api_base: "https://x.com/api", homeserver_url: "https://x.com", server_name: "x" });
  });

  it("getServerConfig returns null", async () => {
    delete (window as Record<string, unknown>).concordTVHost;
    vi.resetModules();
    const mod = await import("../tvOSHost");
    expect(mod.getServerConfig()).toBeNull();
  });

  it("onFocusChanged returns a no-op unsubscribe", async () => {
    delete (window as Record<string, unknown>).concordTVHost;
    vi.resetModules();
    const mod = await import("../tvOSHost");
    const unsub = mod.onFocusChanged(() => {});
    expect(typeof unsub).toBe("function");
    unsub(); // should not throw
  });

  it("openAuthURL falls back to window.open", async () => {
    delete (window as Record<string, unknown>).concordTVHost;
    vi.resetModules();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const mod = await import("../tvOSHost");
    mod.openAuthURL("https://example.com/auth");
    expect(openSpy).toHaveBeenCalledWith("https://example.com/auth", "_blank");
    openSpy.mockRestore();
  });
});

describe("tvOSHost — bridge present (tvOS)", () => {
  const mockHost = {
    setServerConfig: vi.fn(),
    getServerConfig: vi.fn(),
    focusChanged: vi.fn(),
    openAuthURL: vi.fn(),
    _focusCallbacks: [] as Array<(id: string) => void>,
  };

  beforeEach(() => {
    (window as Record<string, unknown>).concordTVHost = mockHost;
    mockHost.setServerConfig.mockReset();
    mockHost.getServerConfig.mockReset();
    mockHost.focusChanged.mockReset();
    mockHost.openAuthURL.mockReset();
    mockHost._focusCallbacks = [];
  });

  afterEach(() => {
    delete (window as Record<string, unknown>).concordTVHost;
  });

  it("isAppleTV is true when concordTVHost is present", async () => {
    vi.resetModules();
    const mod = await import("../tvOSHost");
    expect(mod.isAppleTV).toBe(true);
  });

  it("setServerConfig delegates to the bridge", async () => {
    vi.resetModules();
    const mod = await import("../tvOSHost");
    const cfg = { api_base: "https://s.com/api", homeserver_url: "https://s.com", server_name: "s" };
    mod.setServerConfig(cfg);
    expect(mockHost.setServerConfig).toHaveBeenCalledWith(JSON.stringify(cfg));
  });

  it("getServerConfig returns parsed config from bridge", async () => {
    const cfg = { api_base: "https://s.com/api", homeserver_url: "https://s.com", server_name: "s" };
    mockHost.getServerConfig.mockReturnValue(JSON.stringify(cfg));
    vi.resetModules();
    const mod = await import("../tvOSHost");
    expect(mod.getServerConfig()).toEqual(cfg);
  });

  it("getServerConfig returns null when bridge returns null", async () => {
    mockHost.getServerConfig.mockReturnValue(null);
    vi.resetModules();
    const mod = await import("../tvOSHost");
    expect(mod.getServerConfig()).toBeNull();
  });

  it("onFocusChanged registers and unregisters callbacks", async () => {
    vi.resetModules();
    const mod = await import("../tvOSHost");
    const cb = vi.fn();
    const unsub = mod.onFocusChanged(cb);
    expect(mockHost._focusCallbacks).toContain(cb);
    unsub();
    expect(mockHost._focusCallbacks).not.toContain(cb);
  });

  it("openAuthURL delegates to the bridge", async () => {
    vi.resetModules();
    const mod = await import("../tvOSHost");
    mod.openAuthURL("https://example.com/oauth");
    expect(mockHost.openAuthURL).toHaveBeenCalledWith("https://example.com/oauth");
  });
});
