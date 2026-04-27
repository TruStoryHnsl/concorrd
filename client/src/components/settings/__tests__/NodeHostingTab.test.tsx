import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NodeHostingTab } from "../NodeHostingTab";
import * as servitudeApi from "../../../api/servitude";

/**
 * Partial-mock the servitude API. We keep the real `isServitudeState` and
 * `ServitudeState` type so type imports still resolve, but stub the three
 * side-effecting calls plus the `isTauri` detector so each test can pin
 * the environment explicitly.
 */
vi.mock("../../../api/servitude", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(),
    servitudeStart: vi.fn(),
    servitudeStop: vi.fn(),
    servitudeStatus: vi.fn(),
  };
});

const mockedIsTauri = vi.mocked(servitudeApi.isTauri);
const mockedStart = vi.mocked(servitudeApi.servitudeStart);
const mockedStop = vi.mocked(servitudeApi.servitudeStop);
const mockedStatus = vi.mocked(servitudeApi.servitudeStatus);

describe("<NodeHostingTab />", () => {
  beforeEach(() => {
    mockedIsTauri.mockReset();
    mockedStart.mockReset();
    mockedStop.mockReset();
    mockedStatus.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the browser banner and disables both buttons when Tauri is absent", async () => {
    mockedIsTauri.mockReturnValue(false);
    mockedStatus.mockResolvedValue({ state: "stopped", degraded_transports: {} });

    render(<NodeHostingTab />);

    // Banner is visible.
    expect(
      screen.getByTestId("node-hosting-browser-banner"),
    ).toBeInTheDocument();

    // Wait for the initial refresh() to resolve before asserting button
    // state — the buttons are disabled regardless in browser mode, but
    // awaiting keeps the test free of state-update warnings.
    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-status")).toHaveTextContent(
        "Stopped",
      );
    });

    expect(screen.getByTestId("node-hosting-start")).toBeDisabled();
    expect(screen.getByTestId("node-hosting-stop")).toBeDisabled();

    // Polling should NOT be active in browser mode — servitudeStatus is
    // called exactly once on mount.
    expect(mockedStatus).toHaveBeenCalledTimes(1);
  });

  it("in Tauri mode, surfaces the Stopped state and enables Start", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({ state: "stopped", degraded_transports: {} });

    render(<NodeHostingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-status")).toHaveTextContent(
        "Stopped",
      );
    });

    expect(
      screen.queryByTestId("node-hosting-browser-banner"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("node-hosting-start")).toBeEnabled();
    expect(screen.getByTestId("node-hosting-stop")).toBeDisabled();
  });

  it("clicking Start calls servitudeStart and transitions the UI to Running", async () => {
    mockedIsTauri.mockReturnValue(true);
    // First status() call (on mount) returns stopped. Second call
    // (post-Start refresh) returns running.
    mockedStatus
      .mockResolvedValueOnce({ state: "stopped", degraded_transports: {} })
      .mockResolvedValueOnce({ state: "running", degraded_transports: {} });
    mockedStart.mockResolvedValue();

    const user = userEvent.setup();
    render(<NodeHostingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-start")).toBeEnabled();
    });

    await user.click(screen.getByTestId("node-hosting-start"));

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-status")).toHaveTextContent(
        "Hosting enabled (transports pending)",
      );
    });

    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("node-hosting-stop")).toBeEnabled();
    expect(screen.getByTestId("node-hosting-start")).toBeDisabled();
  });

  it("clicking Stop calls servitudeStop and transitions the UI back to Stopped", async () => {
    mockedIsTauri.mockReturnValue(true);
    // Mount: running. After stop: stopped.
    mockedStatus
      .mockResolvedValueOnce({ state: "running", degraded_transports: {} })
      .mockResolvedValueOnce({ state: "stopped", degraded_transports: {} });
    mockedStop.mockResolvedValue();

    const user = userEvent.setup();
    render(<NodeHostingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-stop")).toBeEnabled();
    });

    await user.click(screen.getByTestId("node-hosting-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-status")).toHaveTextContent(
        "Stopped",
      );
    });

    expect(mockedStop).toHaveBeenCalledTimes(1);
  });

  it("shows degraded transports warning when present in status response", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({
      state: "running",
      degraded_transports: {
        reticulum: "rnsd not found on PATH",
      },
    });

    render(<NodeHostingTab />);

    await waitFor(() => {
      expect(
        screen.getByTestId("node-hosting-degraded"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/reticulum/)).toBeInTheDocument();
    expect(screen.getByText(/rnsd not found/)).toBeInTheDocument();

    // Status should still show Running because degraded transports
    // don't prevent the servitude from operating.
    expect(screen.getByTestId("node-hosting-status")).toHaveTextContent(
      "Hosting enabled (transports pending)",
    );
  });

  it("does not show degraded warning when degraded_transports is empty", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({
      state: "running",
      degraded_transports: {},
    });

    render(<NodeHostingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-status")).toHaveTextContent(
        "Hosting enabled (transports pending)",
      );
    });

    expect(
      screen.queryByTestId("node-hosting-degraded"),
    ).not.toBeInTheDocument();
  });

  it("shows an error banner when servitudeStart rejects, and the Retry button refetches status", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus
      // initial mount: Stopped (so Start is enabled)
      .mockResolvedValueOnce({ state: "stopped", degraded_transports: {} })
      // retry call after clicking Retry: Stopped again (recovery)
      .mockResolvedValueOnce({ state: "stopped", degraded_transports: {} });
    mockedStart.mockRejectedValueOnce(new Error("transport not available"));

    const user = userEvent.setup();
    render(<NodeHostingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-start")).toBeEnabled();
    });

    await user.click(screen.getByTestId("node-hosting-start"));

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-error")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/transport not available/i),
    ).toBeInTheDocument();

    // Retry resolves the error and goes back to the Stopped state
    // (note: Retry only refetches status — it does NOT re-invoke
    // servitudeStart. That is deliberate; the user must click Start
    // again to re-try the action.)
    await user.click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("node-hosting-error"),
      ).not.toBeInTheDocument();
    });

    // Start was only called once — Retry does not re-trigger it.
    expect(mockedStart).toHaveBeenCalledTimes(1);
  });
});
