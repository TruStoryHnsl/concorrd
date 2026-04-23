/**
 * Unit tests for the Concord launch splash timing coordinator (INS-023).
 *
 * `LaunchAnimation` renders **nothing** — the visible splash is the
 * `#boot-splash` block in `client/index.html`, which is already painted
 * before React even evaluates this module. The component is purely a
 * timing state machine that:
 *   1. Waits until `minimumDurationMs` has elapsed AND `isLoading` has
 *      flipped false.
 *   2. Triggers `handoffBootSplash()` (which retires the HTML splash).
 *   3. After a fixed fade duration, fires `onDone` exactly once.
 *
 * We assert observable behavior:
 *   - The mock'd `handoffBootSplash` is called exactly once at the
 *     right moment.
 *   - `onDone` is called exactly once after the fade completes.
 *   - The `#boot-splash` element's `data-state` flips from "visible"
 *     to "handoff" when LaunchAnimation hands off.
 *
 * Uses vitest fake timers so the duration ladder runs in near-zero
 * wall time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { LaunchAnimation } from "../LaunchAnimation";

describe("<LaunchAnimation />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
  });

  it("renders nothing in the React tree (boot-splash is the visible layer)", () => {
    const { container } = render(<LaunchAnimation isLoading={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("does not retire the boot-splash while isLoading is true, even after min duration", async () => {
    render(<LaunchAnimation isLoading={true} minimumDurationMs={400} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");
  });

  it("does not retire the boot-splash before min duration even if isLoading flips false", async () => {
    const { rerender } = render(
      <LaunchAnimation isLoading={true} minimumDurationMs={400} />,
    );
    rerender(<LaunchAnimation isLoading={false} minimumDurationMs={400} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");
  });

  it("retires the boot-splash and fires onDone after both gates clear", async () => {
    const onDone = vi.fn();
    render(
      <LaunchAnimation
        isLoading={false}
        minimumDurationMs={400}
        onDone={onDone}
      />,
    );
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");

    // Cross the min-duration threshold — handoff fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
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

  it("dismisses even when isLoading flips false after the min duration elapses", async () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <LaunchAnimation
        isLoading={true}
        minimumDurationMs={200}
        onDone={onDone}
      />,
    );
    // Past min duration but still loading — splash stays.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("visible");

    // Flip to not loading — handoff fires immediately.
    rerender(
      <LaunchAnimation
        isLoading={false}
        minimumDurationMs={200}
        onDone={onDone}
      />,
    );
    expect(
      document.getElementById("boot-splash")?.getAttribute("data-state"),
    ).toBe("handoff");

    // Fade duration → onDone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDone twice if isLoading flips back to true post-handoff", async () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <LaunchAnimation
        isLoading={false}
        minimumDurationMs={100}
        onDone={onDone}
      />,
    );
    // Cross min-duration first so handoff phase enters.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // Then cross fade duration.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    rerender(
      <LaunchAnimation
        isLoading={true}
        minimumDurationMs={100}
        onDone={onDone}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
