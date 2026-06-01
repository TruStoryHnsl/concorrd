/**
 * VanityNameBanner — user-visible behaviour tests.
 *
 * These are not author-belief tests. Each assertion goes through the
 * rendered DOM the way the real porch view would (testid lookups, real
 * button clicks via fireEvent, real sessionStorage round-trips).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { VanityNameBanner, isVanityBannerSkipped } from "../VanityNameBanner";
import { useInstanceNameStore } from "../../../stores/instanceName";

describe("<VanityNameBanner />", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    // Reset the store so each test starts with no persisted name and no
    // residual save handler from a prior test. `set` is replaced per-test
    // to control whether it resolves or throws.
    useInstanceNameStore.setState({
      name: "",
      loading: false,
      error: null,
      load: async () => {},
      set: async (name: string) => {
        useInstanceNameStore.setState({ name: name.trim() });
      },
    });
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders the heading and the placeholder copy peers see", () => {
    render(<VanityNameBanner />);
    expect(screen.getByText("Name your instance")).toBeInTheDocument();
    const input = screen.getByTestId(
      "vanity-name-banner-input",
    ) as HTMLInputElement;
    expect(input.placeholder).toBe("Name your instance (peers see this)");
  });

  it("Save is disabled while the input is empty or whitespace", () => {
    render(<VanityNameBanner />);
    const save = screen.getByTestId(
      "vanity-name-banner-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const input = screen.getByTestId(
      "vanity-name-banner-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "patio" } });
    expect(save.disabled).toBe(false);
  });

  it("clicking Save calls the store and dismisses the banner", async () => {
    const setSpy = vi.fn(async (name: string) => {
      useInstanceNameStore.setState({ name: name.trim() });
    });
    useInstanceNameStore.setState({ set: setSpy });

    const onDismiss = vi.fn();
    render(<VanityNameBanner onDismiss={onDismiss} />);

    fireEvent.change(screen.getByTestId("vanity-name-banner-input"), {
      target: { value: "patio" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("vanity-name-banner-save"));
    });

    expect(setSpy).toHaveBeenCalledWith("patio");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("clicking Skip sets the sessionStorage flag and dismisses", () => {
    const onDismiss = vi.fn();
    render(<VanityNameBanner onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("vanity-name-banner-skip"));
    expect(onDismiss).toHaveBeenCalled();
    expect(isVanityBannerSkipped()).toBe(true);
  });

  it("dismisses itself if the store gains a name from elsewhere", () => {
    const onDismiss = vi.fn();
    render(<VanityNameBanner onDismiss={onDismiss} />);
    // Simulate a Settings → Hosting save while the banner is mounted.
    act(() => {
      useInstanceNameStore.setState({ name: "patio" });
    });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("surfaces the store error when a save fails", async () => {
    const setSpy = vi.fn(async () => {
      useInstanceNameStore.setState({ error: "porch is offline" });
      throw new Error("porch is offline");
    });
    useInstanceNameStore.setState({ set: setSpy });

    render(<VanityNameBanner />);
    fireEvent.change(screen.getByTestId("vanity-name-banner-input"), {
      target: { value: "patio" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("vanity-name-banner-save"));
    });
    expect(
      screen.getByTestId("vanity-name-banner-error").textContent,
    ).toContain("porch is offline");
  });

  it("Enter on the input triggers save when the draft is non-empty", async () => {
    const setSpy = vi.fn(async (name: string) => {
      useInstanceNameStore.setState({ name: name.trim() });
    });
    useInstanceNameStore.setState({ set: setSpy });
    render(<VanityNameBanner />);
    const input = screen.getByTestId("vanity-name-banner-input");
    fireEvent.change(input, { target: { value: "patio" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(setSpy).toHaveBeenCalledWith("patio");
  });
});

describe("isVanityBannerSkipped()", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns false when no flag is set", () => {
    expect(isVanityBannerSkipped()).toBe(false);
  });

  it("returns true after the flag is written", () => {
    window.sessionStorage.setItem("concord:vanity-banner:skipped", "1");
    expect(isVanityBannerSkipped()).toBe(true);
  });
});
