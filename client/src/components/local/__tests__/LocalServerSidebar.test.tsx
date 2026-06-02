/**
 * LocalServerSidebar — F1b-IMPL two-tile layout.
 *
 * Pins the 2026-06-01 CONSOLIDATED ARCHITECTURE filing's directive that
 * the local source's server-rail renders TWO intrinsic tiles — porch
 * (ephemeral, gray, not renamable) + home (persistent, primary glow,
 * default label "home" via `useHomeServerNameStore`).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { LocalServerSidebar } from "../LocalServerSidebar";
import { useHomeServerNameStore } from "../../../stores/homeServerName";
import { useLocalServerSelectionStore } from "../../../stores/localServerSelection";

// `useHomeServerNameStore.load()` calls into the api wrapper which
// reaches for `@tauri-apps/api/core`. We don't need any of that in
// jsdom — stub the load to a no-op so the component renders against
// the store's default.
vi.mock("../../../api/homeServer", () => ({
  getHomeServerName: vi.fn().mockResolvedValue("home"),
  setHomeServerName: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  useHomeServerNameStore.setState({
    name: "home",
    loading: false,
    error: null,
  });
  useLocalServerSelectionStore.setState({ active: "home" });
});

describe("LocalServerSidebar — F1b-IMPL two intrinsic tiles", () => {
  it("renders BOTH porch and home tiles on desktop", () => {
    render(<LocalServerSidebar />);
    const porch = screen.getByTestId("local-server-tile-porch");
    const home = screen.getByTestId("local-server-tile-home");
    expect(porch).toBeTruthy();
    expect(home).toBeTruthy();
    // Tile abbreviations come from the first char of the label.
    expect(porch.textContent).toContain("P");
    expect(home.textContent).toContain("H");
  });

  it("renders BOTH tiles on mobile", () => {
    render(<LocalServerSidebar mobile />);
    expect(screen.getByTestId("local-server-tile-porch")).toBeTruthy();
    expect(screen.getByTestId("local-server-tile-home")).toBeTruthy();
  });

  it("reflects the user-set home-server name on the home tile", () => {
    useHomeServerNameStore.setState({
      name: "studio",
      loading: false,
      error: null,
    });
    render(<LocalServerSidebar />);
    const home = screen.getByTestId("local-server-tile-home");
    // "studio" → first-letter abbreviation "S".
    expect(home.textContent).toContain("S");
    // The title attribute carries the full label.
    expect(home.getAttribute("title")).toBe("studio");
  });

  it("porch tile is NEVER renamable — label always 'porch'", () => {
    // Even if the home name is set, the porch tile sits at its
    // hard-coded literal label.
    useHomeServerNameStore.setState({
      name: "studio",
      loading: false,
      error: null,
    });
    render(<LocalServerSidebar />);
    const porch = screen.getByTestId("local-server-tile-porch");
    expect(porch.getAttribute("title")).toBe("porch");
  });

  it("clicking a tile updates the selection store and fires the callback", () => {
    const onServerSelect = vi.fn();
    render(<LocalServerSidebar onServerSelect={onServerSelect} />);

    fireEvent.click(screen.getByTestId("local-server-tile-porch"));
    expect(useLocalServerSelectionStore.getState().active).toBe("porch");
    expect(onServerSelect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("local-server-tile-home"));
    expect(useLocalServerSelectionStore.getState().active).toBe("home");
    expect(onServerSelect).toHaveBeenCalledTimes(2);
  });

  it("home tile is the default active selection on a fresh store", () => {
    render(<LocalServerSidebar />);
    const home = screen.getByTestId("local-server-tile-home");
    expect(home.getAttribute("data-active")).toBe("true");
  });
});
