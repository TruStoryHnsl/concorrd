/**
 * Unit tests for the Concord launch splash timing coordinator (INS-023).
 *
 * `LaunchAnimation` renders **nothing** — the visible splash is the
 * `#boot-splash` block in `client/index.html`, which is already painted
 * before React even evaluates this module. The component is purely a
 * timing state machine that:
 *   1. Waits until BOTH `isLoading=false` AND `isAppReady=true`.
 *   2. Triggers `handoffBootSplash()` (which retires the HTML splash).
 *   3. After a fixed fade duration, fires `onDone` exactly once.
 *
 * Safety ceiling: `maxDurationMs` (default 30s) is the hard upper
 * bound. If gates never settle, splash dismisses anyway.
 *
 * We assert observable behavior:
 *   - The `#boot-splash` element's `data-state` flips from "visible"
 *     to "handoff" only when both gates are satisfied (or the
 *     ceiling fires).
 *   - `onDone` is called exactly once after the fade completes.
 *
 * Uses vitest fake timers so the duration ladder runs in near-zero
 * wall time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { LaunchAnimation } from "../LaunchAnimation";
import { useBootReadyStore } from "../../stores/bootReady";

describe("<LaunchAnimation />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset bootReady store between tests so isAppReady starts false.
    useBootReadyStore.setState({ isAppReady: false });
    // Re-create the boot-splash sentinel each test so handoff can flip
    // its data-state attribute.
    const existing = document.getElementById("boot-splash");
    if (existing) existing.remove();
    const splash = document.createElement("div");
    splash.id = "boot-splash";
    splash.setAttribute("data-state", "visible");
    document.body.appendChild(splash);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    const splash = document.getElementById("boot-splash");
    if (splash) splash.remove();
    useBootReadyStore.setState({ isAppReady: false });
  });

  it("renders nothing in the React tree (boot-splash is the visible layer)", () => {
    const { container } = render(<LaunchAnimation isLoading={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("does not retire the boot-splash while isLoading is true, even if app marks ready", async () => {
    render(<LaunchAnimation isLoading={true} />);
    act(() => {
      useBootReadyStore.getState().markAppReady();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");
  });

  it("does not retire the boot-splash while isAppReady is false, even after isLoading flips false", async () => {
    const { rerender } = render(<LaunchAnimation isLoading={true} />);
    rerender(<LaunchAnimation isLoading={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");
  });

  it("retires the boot-splash and fires onDone after both gates clear", async () => {
    const onDone = vi.fn();
    render(<LaunchAnimation isLoading={false} onDone={onDone} />);
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");

    // Mark ready — both gates now satisfied, handoff fires.
    act(() => {
      useBootReadyStore.getState().markAppReady();
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("handoff");
    expect(onDone).not.toHaveBeenCalled();

    // After the fade duration (420ms internal), onDone fires once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("dismisses immediately when isLoading flips false after isAppReady is already true", async () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <LaunchAnimation isLoading={true} onDone={onDone} />,
    );
    act(() => {
      useBootReadyStore.getState().markAppReady();
    });
    // App marked ready but auth still loading — splash stays.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");

    // Flip to not loading — handoff fires immediately.
    rerender(<LaunchAnimation isLoading={false} onDone={onDone} />);
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("handoff");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("safety ceiling dismisses the splash even if gates never settle", async () => {
    const onDone = vi.fn();
    render(
      <LaunchAnimation
        isLoading={true}
        onDone={onDone}
        maxDurationMs={500}
      />,
    );
    // Both gates blocked: isLoading=true and isAppReady=false.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");

    // Cross the ceiling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("handoff");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDone twice if isLoading flips back to true post-handoff", async () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <LaunchAnimation isLoading={false} onDone={onDone} />,
    );
    act(() => {
      useBootReadyStore.getState().markAppReady();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    rerender(<LaunchAnimation isLoading={true} onDone={onDone} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
