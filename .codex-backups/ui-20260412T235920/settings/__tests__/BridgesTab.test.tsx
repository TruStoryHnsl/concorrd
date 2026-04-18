import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BridgesTab } from "../BridgesTab";
import * as servitudeApi from "../../../api/servitude";
import * as bridgesApi from "../../../api/bridges";

/**
 * INS-024 Wave 4: BridgesTab component tests.
 *
 * Tests cover:
 *   - Browser-mode banner rendering
 *   - Setup walkthrough step progression
 *   - Bot token input and save flow
 *   - Enable/disable bridge toggle
 *   - Degraded transport warning
 *   - Error banner rendering
 */

vi.mock("../../../api/servitude", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(),
  };
});

vi.mock("../../../api/bridges", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/bridges")>();
  return {
    ...actual,
    discordBridgeSetBotToken: vi.fn(),
    discordBridgeEnable: vi.fn(),
    discordBridgeDisable: vi.fn(),
    discordBridgeStatus: vi.fn(),
    discordBridgeEnableAndStart: vi.fn(),
  };
});

const mockedIsTauri = vi.mocked(servitudeApi.isTauri);
const mockedSetToken = vi.mocked(bridgesApi.discordBridgeSetBotToken);
const mockedEnable = vi.mocked(bridgesApi.discordBridgeEnable);
const mockedEnableAndStart = vi.mocked(bridgesApi.discordBridgeEnableAndStart);
const mockedDisable = vi.mocked(bridgesApi.discordBridgeDisable);
const mockedStatus = vi.mocked(bridgesApi.discordBridgeStatus);

const defaultStatus: bridgesApi.BridgeStatus = {
  has_bot_token: false,
  lifecycle: "stopped",
  degraded_transports: {},
  bridge_enabled: false,
  binary_available: true,
  bwrap_available: true,
};

describe("<BridgesTab />", () => {
  beforeEach(() => {
    mockedIsTauri.mockReset();
    mockedSetToken.mockReset();
    mockedEnable.mockReset();
    mockedEnableAndStart.mockReset();
    mockedDisable.mockReset();
    mockedStatus.mockReset();
    // Clear localStorage for ToS state.
    localStorage.clear();
  });

  it("renders the browser banner when Tauri is absent", async () => {
    mockedIsTauri.mockReturnValue(false);
    mockedStatus.mockResolvedValue(defaultStatus);

    render(<BridgesTab />);

    await waitFor(() => {
      expect(screen.getByTestId("bridges-browser-banner")).toBeInTheDocument();
    });
  });

  it("renders the setup walkthrough when not in browser mode", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue(defaultStatus);

    render(<BridgesTab />);

    await waitFor(() => {
      expect(screen.getByTestId("setup-step-1")).toBeInTheDocument();
    });

    expect(screen.getByTestId("setup-step-2")).toBeInTheDocument();
    expect(screen.getByTestId("setup-step-3")).toBeInTheDocument();
  });

  it("advances through setup steps on button clicks", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue(defaultStatus);

    const user = userEvent.setup();
    render(<BridgesTab />);

    await waitFor(() => {
      expect(screen.getByTestId("step-1-next")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("step-1-next"));
    expect(screen.getByTestId("step-2-next")).toBeInTheDocument();

    await user.click(screen.getByTestId("step-2-next"));
    expect(screen.getByTestId("bot-token-input")).toBeInTheDocument();
  });

  it("calls discordBridgeSetBotToken when saving a token", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue(defaultStatus);
    mockedSetToken.mockResolvedValue();

    const user = userEvent.setup();
    render(<BridgesTab />);

    // Navigate to step 3.
    await waitFor(() => {
      expect(screen.getByTestId("step-1-next")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("step-1-next"));
    await user.click(screen.getByTestId("step-2-next"));

    // Type a token and save.
    const input = screen.getByTestId("bot-token-input");
    await user.type(input, "MTIzNDU2Nzg5MDEyMzQ1Njc4.GA1234.abcdefghijklmnopqrstuv");

    // After typing, update the mock status to reflect token stored.
    mockedStatus.mockResolvedValue({
      ...defaultStatus,
      has_bot_token: true,
    });

    await user.click(screen.getByTestId("save-token-btn"));

    await waitFor(() => {
      expect(mockedSetToken).toHaveBeenCalledTimes(1);
    });

    // Token argument should be the pasted value.
    expect(mockedSetToken).toHaveBeenCalledWith(
      "MTIzNDU2Nzg5MDEyMzQ1Njc4.GA1234.abcdefghijklmnopqrstuv",
    );
  });

  it("enables the bridge when enable button is clicked", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({
      ...defaultStatus,
      has_bot_token: true,
    });
    mockedEnableAndStart.mockResolvedValue();

    const user = userEvent.setup();
    render(<BridgesTab />);

    await waitFor(() => {
      expect(screen.getByTestId("bridge-enable-btn")).toBeEnabled();
    });

    mockedStatus.mockResolvedValue({
      ...defaultStatus,
      has_bot_token: true,
      bridge_enabled: true,
      lifecycle: "running",
    });

    await user.click(screen.getByTestId("bridge-enable-btn"));

    await waitFor(() => {
      expect(mockedEnableAndStart).toHaveBeenCalledTimes(1);
    });
  });

  it("disables the bridge when disable button is clicked", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({
      ...defaultStatus,
      has_bot_token: true,
      bridge_enabled: true,
      lifecycle: "running",
    });
    mockedDisable.mockResolvedValue();

    const user = userEvent.setup();
    render(<BridgesTab />);

    await waitFor(() => {
      expect(screen.getByTestId("bridge-disable-btn")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("bridge-disable-btn"));

    await waitFor(() => {
      expect(mockedDisable).toHaveBeenCalledTimes(1);
    });
  });

  it("shows degraded banner when discord_bridge is in degraded map", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue({
      has_bot_token: true,
      lifecycle: "running",
      degraded_transports: { discord_bridge: "binary not found" },
      bridge_enabled: true,
      binary_available: true,
      bwrap_available: true,
    });

    render(<BridgesTab />);

    await waitFor(() => {
      expect(
        screen.getByTestId("bridge-degraded-banner"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/binary not found/)).toBeInTheDocument();
  });

  it("shows error banner when API call fails", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedStatus.mockResolvedValue(defaultStatus);
    mockedSetToken.mockRejectedValueOnce(new Error("token too short"));

    const user = userEvent.setup();
    render(<BridgesTab />);

    // Navigate to step 3.
    await waitFor(() => {
      expect(screen.getByTestId("step-1-next")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("step-1-next"));
    await user.click(screen.getByTestId("step-2-next"));

    await user.type(screen.getByTestId("bot-token-input"), "short");
    await user.click(screen.getByTestId("save-token-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("bridge-error")).toBeInTheDocument();
    });

    expect(screen.getByText(/token too short/)).toBeInTheDocument();
  });
});
