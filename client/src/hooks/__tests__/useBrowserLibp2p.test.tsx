/**
 * Phase 9 — `useBrowserLibp2p` hook tests.
 *
 * Post-bundle-split, the hook is opt-in. Covered branches:
 *   - `enabled: false` (default) → never calls `ensureBrowserNode`,
 *     status stays idle. This is the property that keeps the libp2p
 *     chunk out of cold-start sessions that never hit a voice room
 *     or paired-peers surface.
 *   - `enabled: true` → idle → starting → running.
 *   - `enabled: true` + native build (Tauri) → still no-op (the Rust
 *     swarm IS the libp2p layer on native).
 *   - `enabled: true` + a rejecting `ensureBrowserNode` → status = error.
 *   - Imperative `start()` works regardless of the `enabled` flag.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Hoist the mocks so they're installed before the hook's module
// graph resolves. We now mock the lazy seam (`lazyNode`) — that's
// the layer the hook depends on, and exercising it through the lazy
// seam confirms the wiring matches production.
const { ensureMock, stopMock } = vi.hoisted(() => ({
  ensureMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock("../../libp2p/lazyNode", () => ({
  ensureBrowserNode: ensureMock,
  stopBrowserNodeIfStarted: stopMock,
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
    ensureMock.mockReset();
    stopMock.mockReset();
    stopMock.mockResolvedValue(undefined);
    setTauri(false);
  });

  afterEach(() => {
    setTauri(false);
  });

  /**
   * The headline bundle-split property. Without `enabled: true`, the
   * hook must NEVER call `ensureBrowserNode` — that's the wiring
   * that keeps the lazy chunk dormant for sessions that never need
   * libp2p.
   */
  it("default (enabled: false) never calls ensureBrowserNode", async () => {
    const { result } = renderHook(() => useBrowserLibp2p());

    // Give the effect tick a chance to fire — it should still no-op.
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  /**
   * Opting in (the VoiceChannel / ProfileTab path) MUST flip the
   * status through starting → running. This is the legacy behavior
   * the call sites rely on.
   */
  it("enabled: true transitions idle → starting → running", async () => {
    // Hold the start until we want the test to observe `starting`.
    let resolveStart!: () => void;
    ensureMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const { result } = renderHook(() => useBrowserLibp2p({ enabled: true }));

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
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  /**
   * On Tauri, the Rust swarm IS the libp2p layer. The hook must NOT
   * call into the browser stack even when the caller opted in.
   * Defends against operators wiring `enabled: true` in
   * cross-platform surfaces without remembering the native branch.
   */
  it("on the native build, never calls ensureBrowserNode even when enabled", async () => {
    setTauri(true);

    const { result } = renderHook(() => useBrowserLibp2p({ enabled: true }));

    expect(result.current.status).toBe("idle");
    expect(ensureMock).not.toHaveBeenCalled();
  });

  /**
   * If the swarm fails to come up (transport error, identity load
   * failure, etc), the hook MUST surface it via status + error so a
   * future badge can render the failure mode without consumers
   * having to re-introspect libp2p internals.
   */
  it("surfaces an error status when ensureBrowserNode rejects", async () => {
    ensureMock.mockRejectedValue(new Error("transport unavailable"));

    const { result } = renderHook(() => useBrowserLibp2p({ enabled: true }));

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBe("transport unavailable");
  });

  /**
   * The imperative `start()` returned by the hook gives call sites
   * fine-grained control without forcing `enabled: true` and the
   * mount-time auto-start. Confirms the API surface works for the
   * "start on user click" pattern.
   */
  it("imperative start() triggers ensureBrowserNode even when enabled is false", async () => {
    ensureMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBrowserLibp2p());

    expect(ensureMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");

    await act(async () => {
      await result.current.start();
    });

    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("running");
  });
});
