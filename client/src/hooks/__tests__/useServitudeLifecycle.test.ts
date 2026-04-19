import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useServitudeLifecycle,
  useServitudeLifecycleStore,
} from "../useServitudeLifecycle";
import * as servitudeApi from "../../api/servitude";

/**
 * User-visible behavior for INS-022 lifecycle glue:
 *
 *   1. When the Tauri window loses focus AND servitude is running,
 *      the embedded servitude is stopped — the phone stops advertising
 *      itself as a relay the moment the app is backgrounded.
 *
 *   2. When the window regains focus AND we were the ones who stopped
 *      it, the servitude is started again — the user sees hosting
 *      resume on return.
 *
 *   3. If servitude was NOT running when blur fired (because the user
 *      had already stopped it manually), we do NOT try to start it on
 *      focus. Surprising "my phone started hosting after I came back
 *      from Safari" behavior is explicitly prevented.
 *
 *   4. The hook is a no-op outside Tauri — no listeners are attached
 *      and no async imports fire. This means the lifecycle instrumentation
 *      can ship to the web client safely.
 */

// Mock the servitude API so tests can drive responses deterministically.
vi.mock("../../api/servitude", async (orig) => {
  const actual = await orig<typeof import("../../api/servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(),
    servitudeStart: vi.fn(),
    servitudeStop: vi.fn(),
    servitudeStatus: vi.fn(),
  };
});

// Mock @tauri-apps/api/event to capture the registered handlers and
// invoke them directly from tests — same code path as a real blur/
// focus event would take.
type EventHandler = () => void;
const capturedHandlers: { blur?: EventHandler; focus?: EventHandler } = {};
vi.mock("@tauri-apps/api/event", () => {
  return {
    listen: vi.fn(async (eventName: string, handler: EventHandler) => {
      if (eventName === "tauri://blur") capturedHandlers.blur = handler;
      if (eventName === "tauri://focus") capturedHandlers.focus = handler;
      // Return a stub unlistener.
      return () => {
        if (eventName === "tauri://blur") capturedHandlers.blur = undefined;
        if (eventName === "tauri://focus") capturedHandlers.focus = undefined;
      };
    }),
    TauriEvent: {
      WINDOW_BLUR: "tauri://blur",
      WINDOW_FOCUS: "tauri://focus",
    },
  };
});

const mockedIsTauri = vi.mocked(servitudeApi.isTauri);
const mockedStart = vi.mocked(servitudeApi.servitudeStart);
const mockedStop = vi.mocked(servitudeApi.servitudeStop);
const mockedStatus = vi.mocked(servitudeApi.servitudeStatus);

/** Wait until the listener registration IIFE inside the hook resolves. */
const waitForListeners = async (opts: { blur?: boolean; focus?: boolean } = { blur: true, focus: true }) => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const haveBlur = !opts.blur || typeof capturedHandlers.blur === "function";
    const haveFocus = !opts.focus || typeof capturedHandlers.focus === "function";
    if (haveBlur && haveFocus) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`listeners never registered: ${JSON.stringify({ blur: !!capturedHandlers.blur, focus: !!capturedHandlers.focus })}`);
};

/** Flush the microtask queue a few times for in-handler awaits. */
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("useServitudeLifecycle()", () => {
  beforeEach(() => {
    capturedHandlers.blur = undefined;
    capturedHandlers.focus = undefined;
    mockedIsTauri.mockReset();
    mockedStart.mockReset();
    mockedStop.mockReset();
    mockedStatus.mockReset();
    useServitudeLifecycleStore.getState()._reset();
  });

  afterEach(() => {
    useServitudeLifecycleStore.getState()._reset();
  });

  it("is a no-op outside Tauri — no listeners registered", async () => {
    mockedIsTauri.mockReturnValue(false);

    renderHook(() => useServitudeLifecycle());
    // Give any async work a generous settle window — nothing should
    // register listeners in this path.
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedHandlers.blur).toBeUndefined();
    expect(capturedHandlers.focus).toBeUndefined();
  });

  it("on Tauri blur with servitude running, calls servitudeStop and flags paused-by-lifecycle", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({ state: "running", degraded_transports: {} });
    mockedStop.mockResolvedValue();

    renderHook(() => useServitudeLifecycle());
    await waitForListeners();

    expect(capturedHandlers.blur).toBeDefined();
    await capturedHandlers.blur!();
    await flush();

    expect(mockedStop).toHaveBeenCalledTimes(1);
    expect(useServitudeLifecycleStore.getState().pausedByLifecycle).toBe(true);
  });

  it("on Tauri blur with servitude stopped, does NOT call servitudeStop", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({ state: "stopped", degraded_transports: {} });
    mockedStop.mockResolvedValue();

    renderHook(() => useServitudeLifecycle());
    await waitForListeners();
    await capturedHandlers.blur!();
    await flush();

    expect(mockedStop).not.toHaveBeenCalled();
    expect(useServitudeLifecycleStore.getState().pausedByLifecycle).toBe(false);
  });

  it("on focus after a lifecycle pause, calls servitudeStart and clears the flag", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({ state: "running", degraded_transports: {} });
    mockedStop.mockResolvedValue();
    mockedStart.mockResolvedValue();

    renderHook(() => useServitudeLifecycle());
    await waitForListeners();

    // Simulate blur → stopped by lifecycle.
    await capturedHandlers.blur!();
    await flush();
    expect(useServitudeLifecycleStore.getState().pausedByLifecycle).toBe(true);

    // Focus → restart.
    await capturedHandlers.focus!();
    await flush();

    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(useServitudeLifecycleStore.getState().pausedByLifecycle).toBe(false);
  });

  it("on focus WITHOUT a lifecycle pause, does NOT call servitudeStart", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({ state: "stopped", degraded_transports: {} });
    mockedStart.mockResolvedValue();

    renderHook(() => useServitudeLifecycle());
    await waitForListeners();

    // pausedByLifecycle is false at baseline; fire focus.
    await capturedHandlers.focus!();
    await flush();

    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("clears pausedByLifecycle even when the restart on focus fails, so a future focus event can try again", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({ state: "running", degraded_transports: {} });
    mockedStop.mockResolvedValue();
    mockedStart.mockRejectedValueOnce(new Error("transport unavailable"));

    renderHook(() => useServitudeLifecycle());
    await waitForListeners();

    await capturedHandlers.blur!();
    await flush();
    expect(useServitudeLifecycleStore.getState().pausedByLifecycle).toBe(true);

    await capturedHandlers.focus!();
    await flush();

    expect(mockedStart).toHaveBeenCalledTimes(1);
    // Flag MUST clear — otherwise we're wedged into always retrying on
    // focus forever even if the user meant to stay stopped.
    expect(useServitudeLifecycleStore.getState().pausedByLifecycle).toBe(false);
  });
});
