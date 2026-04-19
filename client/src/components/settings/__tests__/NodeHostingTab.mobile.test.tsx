import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "../SettingsModal";
import { NodeHostingTab } from "../NodeHostingTab";
import { useAuthStore } from "../../../stores/auth";
import { useServerStore } from "../../../stores/server";
import { useSettingsStore } from "../../../stores/settings";
import { useServerConfigStore } from "../../../stores/serverConfig";
import * as servitudeApi from "../../../api/servitude";

/**
 * INS-022 user-visible behavior:
 *
 *   - On a mobile Tauri app (`isTauri && isMobile`), the Settings panel
 *     DOES show a Node tab so the user can enable/disable phone-as-relay
 *     hosting. This was broken for the first five waves of development —
 *     the tab was gated behind `isTauri && !isMobile`.
 *
 *   - When hosting is Running, the NodeHostingTab surface shows the
 *     mobile-variant battery-impact disclosure banner and a pulsing
 *     indicator next to the status label so the user can't forget the
 *     phone is relaying.
 */

vi.mock("../../../api/concord", async () => {
  const actual = await vi.importActual<typeof import("../../../api/concord")>(
    "../../../api/concord",
  );
  return { ...actual, checkAdmin: vi.fn().mockResolvedValue({ is_admin: false }) };
});

// Default platform mock = mobile Tauri; test 2 overrides for desktop.
vi.mock("../../../hooks/usePlatform", () => ({
  usePlatform: () => ({
    isTauri: true,
    isMobile: true,
    isTV: false,
    isIPad: false,
    isIOS: true,
    isAndroid: false,
    isAndroidTV: false,
    isAppleTV: false,
    hasPointer: false,
    hasTouchOnly: true,
  }),
}));

vi.mock("../../../api/servitude", async (orig) => {
  const actual = await orig<typeof import("../../../api/servitude")>();
  return {
    ...actual,
    isTauri: vi.fn().mockReturnValue(true),
    servitudeStart: vi.fn(),
    servitudeStop: vi.fn(),
    servitudeStatus: vi.fn(),
  };
});

const mockedStatus = vi.mocked(servitudeApi.servitudeStatus);

describe("SettingsPanel — Node tab visibility on mobile (INS-022)", () => {
  beforeEach(() => {
    mockedStatus.mockReset();
    useAuthStore.setState({ accessToken: "token", userId: "@a:example.net" });
    useServerStore.setState({ servers: [], members: {} });
    useSettingsStore.setState({
      settingsOpen: true,
      settingsTab: "audio",
      serverSettingsId: null,
    });
    useServerConfigStore.setState({ config: null });
  });

  it("renders a Node tab button when the platform flags report mobile Tauri", async () => {
    mockedStatus.mockResolvedValue({ state: "stopped", degraded_transports: {} });
    render(<SettingsPanel />);

    // Tab bar visibility — the Node tab is a real button the user can
    // tap. We look up by text, not test-id, because the user-facing
    // assertion is "the user SEES the word Node" in the settings bar.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Node/i })).toBeInTheDocument();
    });

    // On mobile the Bridges tab is explicitly suppressed to keep the
    // tab bar uncluttered on small screens — verify the inverse.
    expect(screen.queryByRole("button", { name: /^Bridges$/i })).not.toBeInTheDocument();
  });
});

describe("NodeHostingTab — mobile battery disclosure + running pulse (INS-022)", () => {
  beforeEach(() => {
    mockedStatus.mockReset();
  });

  it("shows the battery-impact banner and a pulse indicator when hosting transitions to Running", async () => {
    mockedStatus.mockResolvedValue({ state: "running", degraded_transports: {} });
    render(<NodeHostingTab />);

    // Battery banner is the user-facing warning; the testid is a
    // stable handle for the assertion.
    await waitFor(() => {
      expect(
        screen.getByTestId("node-hosting-battery-disclosure"),
      ).toBeInTheDocument();
    });

    // Pulse indicator is rendered adjacent to the status label.
    expect(screen.getByTestId("node-hosting-running-pulse")).toBeInTheDocument();

    // Visible user-facing text signals the impact clearly.
    expect(screen.getByText(/Battery impact active/i)).toBeInTheDocument();
  });

  it("does NOT show the battery banner or pulse indicator when hosting is Stopped", async () => {
    mockedStatus.mockResolvedValue({ state: "stopped", degraded_transports: {} });
    render(<NodeHostingTab />);

    await waitFor(() => {
      expect(screen.getByTestId("node-hosting-status")).toHaveTextContent("Stopped");
    });

    expect(
      screen.queryByTestId("node-hosting-battery-disclosure"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("node-hosting-running-pulse"),
    ).not.toBeInTheDocument();
  });
});
