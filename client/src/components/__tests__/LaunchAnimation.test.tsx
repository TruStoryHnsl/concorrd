/**
 * Unit tests for the Concord launch splash (INS-023).
 *
 * The component is small but has four interesting behaviors:
 *   1. It renders a visible splash with the Concord wordmark on mount.
 *   2. It sits in the "showing" phase until the minimum-display time
 *      has elapsed AND `isLoading` is false.
 *   3. It transitions to "fading" for 420ms after both conditions
 *      are met, fires `onDone` exactly once, then renders null.
 *   4. It never flashes back to "showing" — once dismissed, it
 *      stays dismissed for the lifetime of the mount.
 *
 * Uses vitest's fake timers so the 400ms + 420ms staircase runs in
 * near-zero wall time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LaunchAnimation } from "../LaunchAnimation";

describe("<LaunchAnimation />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders the splash in 'showing' phase on mount", () => {
    render(<LaunchAnimation isLoading={true} />);
    const splash = screen.getByTestId("launch-animation");
    expect(splash).toBeInTheDocument();
    expect(splash.getAttribute("data-phase")).toBe("showing");
    // Concord wordmark must be visible in the splash body.
    expect(screen.getAllByText(/^Concord$/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Waiting for /)).toBeInTheDocument();
  });

  it("hands off the hard-refresh boot splash after mount", () => {
    const bootSplash = document.createElement("div");
    bootSplash.id = "boot-splash";
    bootSplash.setAttribute("data-state", "visible");
    document.body.appendChild(bootSplash);

    render(<LaunchAnimation isLoading={true} />);
    expect(bootSplash.getAttribute("data-state")).toBe("handoff");
  });

  it("stays in 'showing' while isLoading is true, even after min duration", () => {
    render(
      <LaunchAnimation isLoading={true} minimumDurationMs={400} />,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const splash = screen.getByTestId("launch-animation");
    expect(splash.getAttribute("data-phase")).toBe("showing");
  });

  it("stays in 'showing' before the minimum duration elapses even if isLoading flips false", () => {
    const { rerender } = render(
      <LaunchAnimation isLoading={true} minimumDurationMs={400} />,
    );
    // Flip isLoading false immediately but before the min timer fires.
    rerender(<LaunchAnimation isLoading={false} minimumDurationMs={400} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const splash = screen.getByTestId("launch-animation");
    // Still showing — the floor is 400ms and we're at 100.
    expect(splash.getAttribute("data-phase")).toBe("showing");
  });

  it("transitions showing -> fading -> done and calls onDone exactly once", async () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <LaunchAnimation
        isLoading={false}
        minimumDurationMs={400}
        onDone={onDone}
      />,
    );
    // Still showing pre-min-duration.
    expect(
      screen.getByTestId("launch-animation").getAttribute("data-phase"),
    ).toBe("showing");

    // Cross the min-duration threshold — should flip to fading.
    // `advanceTimersByTimeAsync` pumps microtasks between timer
    // callbacks so React state updates commit before we re-query
    // the DOM.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(
      screen.getByTestId("launch-animation").getAttribute("data-phase"),
    ).toBe("fading");
    expect(onDone).not.toHaveBeenCalled();

    // Cross the fade duration — should unmount and fire onDone once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(screen.queryByTestId("launch-animation")).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);

    // Subsequent re-renders must NOT un-dismiss or fire onDone again.
    rerender(
      <LaunchAnimation
        isLoading={true}
        minimumDurationMs={400}
        onDone={onDone}
      />,
    );
    expect(screen.queryByTestId("launch-animation")).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("dismisses even when the caller leaves isLoading at its default value (true->false)", async () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <LaunchAnimation
        isLoading={true}
        minimumDurationMs={200}
        onDone={onDone}
      />,
    );
    // Wait past the min duration while still loading — stays showing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(
      screen.getByTestId("launch-animation").getAttribute("data-phase"),
    ).toBe("showing");

    // Flip to not loading — the fade effect runs on the next commit.
    rerender(
      <LaunchAnimation
        isLoading={false}
        minimumDurationMs={200}
        onDone={onDone}
      />,
    );
    expect(
      screen.getByTestId("launch-animation").getAttribute("data-phase"),
    ).toBe("fading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("marks itself aria-hidden so assistive tech ignores the decorative layer", () => {
    render(<LaunchAnimation isLoading={true} />);
    const splash = screen.getByTestId("launch-animation");
    expect(splash.getAttribute("aria-hidden")).toBe("true");
  });
});
