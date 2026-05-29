/**
 * Phase 9 — `useBrowserLibp2p` hook tests.
 *
 * Covers the three branches the hook has to get right:
 *   - Web build → idle → starting → running.
 *   - Native build (Tauri) → never calls `startBrowserNode`.
 *   - Web build with a rejecting `startBrowserNode` → status = error.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Hoist the mocks so they're installed before the hook's module
// graph resolves.
const { startMock, stopMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock("../../libp2p/node", () => ({
  startBrowserNode: startMock,
  stopBrowserNode: stopMock,
}));

vi.mock("../../libp2p/bootstrap", () => ({
  BOOTSTRAP_MULTIADDRS: [
    "/dns4/bootstrap1.example/udp/4001/quic-v1/p2p/12D3KooWLySgoqv8qgxuAwcVaW3R8dyFYvHTAJT6dnZxcf9PYG9W",
  ],
}));

import { useBrowserLibp2p } from "../useBrowserLibp2p";

function setTauri(present: boolean): void {
  if (present) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

describe("useBrowserLibp2p", () => {
  beforeEach(() => {
    startMock.mockReset();
    stopMock.mockReset();
    stopMock.mockResolvedValue(undefined);
    setTauri(false);
  });

  afterEach(() => {
    setTauri(false);
  });

  it("on the web build, transitions idle → starting → running", async () => {
    // Hold the start until we want the test to observe `starting`.
    let resolveStart!: () => void;
    startMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const { result } = renderHook(() => useBrowserLibp2p());

    // After mount the hook synchronously sets status to "starting".
    await waitFor(() => {
      expect(result.current.status).toBe("starting");
    });

    await act(async () => {
      resolveStart();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("running");
    });
    expect(result.current.error).toBeUndefined();
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("on the native build, never calls startBrowserNode", async () => {
    setTauri(true);

    const { result } = renderHook(() => useBrowserLibp2p());

    // No swarm boot. Status stays idle.
    expect(result.current.status).toBe("idle");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("surfaces an error status when startBrowserNode rejects", async () => {
    startMock.mockRejectedValue(new Error("transport unavailable"));

    const { result } = renderHook(() => useBrowserLibp2p());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBe("transport unavailable");
  });
});
