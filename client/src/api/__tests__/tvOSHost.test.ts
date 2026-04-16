/**
 * Tests for the tvOS WKWebView JS bridge client module.
 *
 * Covers two scenarios:
 *   1. Bridge absent (non-tvOS) — all functions no-op gracefully.
 *   2. Bridge present (tvOS) — all functions dispatch to the correct
 *      message handler with the expected payload.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTvOSBridgeAvailable,
  setServerConfig,
  getServerConfig,
  focusChanged,
  openAuthURL,
} from "../tvOSHost";
import type { ServerConfig } from "../tvOSHost";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installBridge() {
  const handlers = {
    concordSetServerConfig: { postMessage: vi.fn() },
    concordGetServerConfig: { postMessage: vi.fn() },
    concordFocusChanged: { postMessage: vi.fn() },
    concordOpenAuthURL: { postMessage: vi.fn() },
  };
  (window as Record<string, unknown>).webkit = {
    messageHandlers: handlers,
  };
  return handlers;
}

function removeBridge() {
  delete (window as Record<string, unknown>).webkit;
}

afterEach(() => {
  removeBridge();
  // Clean up any lingering callback
  delete (window as Record<string, unknown>).__concordGetServerConfigCallback;
});

// ---------------------------------------------------------------------------
// Bridge detection
// ---------------------------------------------------------------------------

describe("isTvOSBridgeAvailable", () => {
  it("returns false when window.webkit is absent", () => {
    removeBridge();
    expect(isTvOSBridgeAvailable()).toBe(false);
  });

  it("returns true when the bridge handlers are installed", () => {
    installBridge();
    expect(isTvOSBridgeAvailable()).toBe(true);
  });

  it("returns false when webkit exists but handlers are missing", () => {
    (window as Record<string, unknown>).webkit = {};
    expect(isTvOSBridgeAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bridge absent (no-op behaviour)
// ---------------------------------------------------------------------------

describe("bridge absent (non-tvOS)", () => {
  it("setServerConfig no-ops without throwing", () => {
    removeBridge();
    expect(() =>
      setServerConfig({ homeserverUrl: "https://example.com" }),
    ).not.toThrow();
  });

  it("getServerConfig resolves to null", async () => {
    removeBridge();
    const result = await getServerConfig();
    expect(result).toBeNull();
  });

  it("focusChanged no-ops without throwing", () => {
    removeBridge();
    expect(() => focusChanged("some-element")).not.toThrow();
  });

  it("openAuthURL no-ops without throwing", () => {
    removeBridge();
    expect(() =>
      openAuthURL("https://auth.example.com/oauth"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bridge present (tvOS message dispatch)
// ---------------------------------------------------------------------------

describe("bridge present (tvOS)", () => {
  it("setServerConfig dispatches config to the native handler", () => {
    const handlers = installBridge();
    const config: ServerConfig = {
      homeserverUrl: "https://matrix.example.com",
      serverName: "My Server",
      accessToken: "syt_abc123",
    };

    setServerConfig(config);

    expect(handlers.concordSetServerConfig.postMessage).toHaveBeenCalledOnce();
    expect(handlers.concordSetServerConfig.postMessage).toHaveBeenCalledWith(config);
  });

  it("getServerConfig sends callback name and resolves with native response", async () => {
    const handlers = installBridge();
    const expectedConfig: ServerConfig = {
      homeserverUrl: "https://matrix.example.com",
      serverName: "Restored Server",
    };

    // Simulate the native side calling the callback after postMessage
    handlers.concordGetServerConfig.postMessage.mockImplementation(
      (body: { callbackName: string }) => {
        const cb = (window as Record<string, (c: ServerConfig) => void>)[body.callbackName];
        cb(expectedConfig);
      },
    );

    const result = await getServerConfig();

    expect(handlers.concordGetServerConfig.postMessage).toHaveBeenCalledOnce();
    expect(result).toEqual(expectedConfig);
    // Callback should be cleaned up
    expect(
      (window as unknown as Record<string, unknown>).__concordGetServerConfigCallback,
    ).toBeUndefined();
  });

  it("getServerConfig resolves with null when native returns null", async () => {
    const handlers = installBridge();

    handlers.concordGetServerConfig.postMessage.mockImplementation(
      (body: { callbackName: string }) => {
        const cb = (window as unknown as Record<string, (c: null) => void>)[body.callbackName];
        cb(null);
      },
    );

    const result = await getServerConfig();
    expect(result).toBeNull();
  });

  it("focusChanged dispatches element ID to the native handler", () => {
    const handlers = installBridge();

    focusChanged("channel-list-item-3");

    expect(handlers.concordFocusChanged.postMessage).toHaveBeenCalledOnce();
    expect(handlers.concordFocusChanged.postMessage).toHaveBeenCalledWith({
      elementId: "channel-list-item-3",
    });
  });

  it("openAuthURL dispatches URL to the native handler", () => {
    const handlers = installBridge();
    const url = "https://auth.example.com/oauth?state=xyz";

    openAuthURL(url);

    expect(handlers.concordOpenAuthURL.postMessage).toHaveBeenCalledOnce();
    expect(handlers.concordOpenAuthURL.postMessage).toHaveBeenCalledWith({ url });
  });
});
