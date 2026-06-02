/**
 * Empirical tests for the F4 first-launch two-name banner.
 *
 * Asserts user-observable behaviour (per the WRITTEN-IN-BLOOD rule):
 *   1. Headline + porch sentence appear when both name stores are empty
 *      and the dismiss flag is unset.
 *   2. Save persists whichever fields the user filled in and hides the
 *      banner.
 *   3. Skip hides the banner without writing anything.
 *   4. If the device name is already set in `useInstanceNameStore`, the
 *      banner does not render.
 *   5. If the home name is already set in `useHomeServerNameStore`, the
 *      banner does not render.
 *   6. If the sessionStorage dismiss flag is "1" on mount, the banner
 *      does not render even with both names blank.
 *
 * The two stores are mocked to avoid any Tauri / network round-trip;
 * we verify that `set` was called with the right values when the user
 * clicks Save.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { FirstLaunchTwoNameBanner } from "../FirstLaunchTwoNameBanner";
import { useInstanceNameStore } from "../../../stores/instanceName";
import { useHomeServerNameStore } from "../../../stores/homeServerName";

const DISMISS_KEY = "concord:first-launch-banner-dismissed";

function resetStores(deviceName = "", homeName = "") {
  useInstanceNameStore.setState({
    name: deviceName,
    loading: false,
    error: null,
  });
  useHomeServerNameStore.setState({
    name: homeName,
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetStores();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FirstLaunchTwoNameBanner", () => {
  it("renders the welcome headline + porch sentence on a fresh install", () => {
    render(<FirstLaunchTwoNameBanner />);
    expect(
      screen.getByRole("heading", { name: /welcome.*name your space/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/porch.*always-fresh guest entrance.*automatic/i),
    ).toBeInTheDocument();
  });

  it("renders both inputs with the documented placeholders", () => {
    render(<FirstLaunchTwoNameBanner />);
    const device = screen.getByTestId(
      "first-launch-device-input",
    ) as HTMLInputElement;
    const home = screen.getByTestId(
      "first-launch-home-input",
    ) as HTMLInputElement;
    expect(device.placeholder).toBe("local");
    expect(home.placeholder).toBe("home");
  });

  it("persists both names and sets the dismiss flag on Save", async () => {
    const setInstance = vi.fn(() => Promise.resolve());
    const setHome = vi.fn(() => Promise.resolve());
    useInstanceNameStore.setState({ set: setInstance });
    useHomeServerNameStore.setState({ set: setHome });

    render(<FirstLaunchTwoNameBanner />);
    const user = userEvent.setup();

    await user.type(
      screen.getByTestId("first-launch-device-input"),
      "patio",
    );
    await user.type(
      screen.getByTestId("first-launch-home-input"),
      "kitchen",
    );
    await user.click(screen.getByTestId("first-launch-two-name-banner-save"));

    expect(setInstance).toHaveBeenCalledWith("patio");
    expect(setHome).toHaveBeenCalledWith("kitchen");
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe("1");
    expect(
      screen.queryByTestId("first-launch-two-name-banner"),
    ).not.toBeInTheDocument();
  });

  it("skips blank fields on Save", async () => {
    const setInstance = vi.fn(() => Promise.resolve());
    const setHome = vi.fn(() => Promise.resolve());
    useInstanceNameStore.setState({ set: setInstance });
    useHomeServerNameStore.setState({ set: setHome });

    render(<FirstLaunchTwoNameBanner />);
    const user = userEvent.setup();

    // Only fill the device input; leave home blank.
    await user.type(
      screen.getByTestId("first-launch-device-input"),
      "patio",
    );
    await user.click(screen.getByTestId("first-launch-two-name-banner-save"));

    expect(setInstance).toHaveBeenCalledWith("patio");
    expect(setHome).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("Skip hides the banner without writing either store", async () => {
    const setInstance = vi.fn(() => Promise.resolve());
    const setHome = vi.fn(() => Promise.resolve());
    useInstanceNameStore.setState({ set: setInstance });
    useHomeServerNameStore.setState({ set: setHome });

    render(<FirstLaunchTwoNameBanner />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("first-launch-two-name-banner-skip"));

    expect(setInstance).not.toHaveBeenCalled();
    expect(setHome).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe("1");
    expect(
      screen.queryByTestId("first-launch-two-name-banner"),
    ).not.toBeInTheDocument();
  });

  it("does not render if the device name is already set", () => {
    resetStores("patio", "");
    render(<FirstLaunchTwoNameBanner />);
    expect(
      screen.queryByTestId("first-launch-two-name-banner"),
    ).not.toBeInTheDocument();
  });

  it("does not render if the home server name is already set", () => {
    resetStores("", "kitchen");
    render(<FirstLaunchTwoNameBanner />);
    expect(
      screen.queryByTestId("first-launch-two-name-banner"),
    ).not.toBeInTheDocument();
  });

  it("does not render if the session dismiss flag is set", () => {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
    render(<FirstLaunchTwoNameBanner />);
    expect(
      screen.queryByTestId("first-launch-two-name-banner"),
    ).not.toBeInTheDocument();
  });
});
