import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPanel } from "../SettingsModal";
import { useAuthStore } from "../../../stores/auth";
import { useServerStore } from "../../../stores/server";
import { useSettingsStore } from "../../../stores/settings";

vi.mock("../../../hooks/usePlatform", () => ({
  usePlatform: () => ({
    isTauri: false,
    isMobile: false,
    isTV: false,
    isIPad: false,
  }),
}));

vi.mock("../../../api/servitude", () => ({
  isTauri: () => false,
}));

vi.mock("../../../api/concord", async () => {
  const actual = await vi.importActual<typeof import("../../../api/concord")>(
    "../../../api/concord",
  );
  return {
    ...actual,
    checkAdmin: vi.fn().mockResolvedValue({ is_admin: true }),
  };
});

vi.mock("../../../api/bridges", async () => {
  const actual = await vi.importActual<typeof import("../../../api/bridges")>(
    "../../../api/bridges",
  );
  return {
    ...actual,
    discordBridgeHttpStatus: vi.fn().mockResolvedValue({
      enabled: true,
      bot_token_configured: true,
      appservice_id: "concord_discord",
      sender_mxid_localpart: "_discord_bot",
      user_namespace_regex: "@_discord_.*",
      alias_namespace_regex: "#_discord_.*",
      registration_file_path: "/tmp/registration.yaml",
    }),
    discordBridgeHttpGetBotProfile: vi.fn().mockResolvedValue({
      id: "bot-1",
      username: "corr-bridge",
      global_name: null,
      avatar: null,
    }),
    discordVoiceBridgeHttpListRooms: vi.fn().mockResolvedValue([]),
    discordBridgeHttpEnable: vi.fn(),
    discordBridgeHttpDisable: vi.fn(),
    discordBridgeHttpRotate: vi.fn(),
    discordBridgeHttpSaveBotToken: vi.fn(),
    discordBridgeHttpUpdateBotProfile: vi.fn(),
    discordVoiceBridgeHttpRestart: vi.fn(),
    discordVoiceBridgeHttpStop: vi.fn(),
    discordVoiceBridgeHttpStart: vi.fn(),
    discordVoiceBridgeHttpUpsertRoom: vi.fn(),
    discordVoiceBridgeHttpDeleteRoom: vi.fn(),
    discordBridgeStatus: vi.fn(),
    discordBridgeEnableAndStart: vi.fn(),
    discordBridgeDisable: vi.fn(),
    discordBridgeSetBotToken: vi.fn(),
  };
});

vi.mock("../AudioTab", () => ({ AudioTab: () => <div>Audio Tab</div> }));
vi.mock("../VoiceTab", () => ({ VoiceTab: () => <div>Voice Tab</div> }));
vi.mock("../NotificationsTab", () => ({
  NotificationsTab: () => <div>Notifications Tab</div>,
}));
vi.mock("../ProfileTab", () => ({ ProfileTab: () => <div>Profile Tab</div> }));
vi.mock("../AppearanceTab", () => ({
  AppearanceTab: () => <div>Appearance Tab</div>,
}));
vi.mock("../NodeHostingTab", () => ({
  NodeHostingTab: () => <div>Node Hosting Tab</div>,
}));
vi.mock("../AboutTab", () => ({ AboutTab: () => <div>About Tab</div> }));
vi.mock("../AdminTab", () => ({ AdminTab: () => <div>Admin Tab</div> }));

describe("<SettingsPanel /> real bridges navigation", () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "token",
      userId: "@alice:concorrd.com",
      isLoggedIn: true,
      isLoading: false,
      syncing: true,
      client: null,
    });
    useServerStore.setState({
      servers: [
        {
          id: "discord-guild-1",
          name: "CTP Playtime",
          icon_url: null,
          owner_id: "@alice:concorrd.com",
          visibility: "private",
          abbreviation: "CTP",
          media_uploads_enabled: true,
          bridgeType: "discord",
          discordGuildId: "123",
          channels: [
            {
              id: 1,
              name: "general",
              channel_type: "text",
              matrix_room_id: "!general:concorrd.com",
              position: 0,
            },
            {
              id: 2,
              name: "voice",
              channel_type: "voice",
              matrix_room_id: "!voice:concorrd.com",
              position: 1,
            },
          ],
        },
      ],
      members: {
        "discord-guild-1": [],
      },
    });
    useSettingsStore.setState({
      settingsOpen: true,
      settingsTab: "server-bridge",
      serverSettingsId: "discord-guild-1",
    });
  });

  it("moves from discord server settings into the real bridges tab and back to profile without runtime errors", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<SettingsPanel />);

    expect(screen.getByText("Discord Bridge")).toBeInTheDocument();
    expect(screen.getAllByText("CTP Playtime").length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Bridges/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Bridges/i }));

    await waitFor(() => {
      expect(screen.getByTestId("docker-bridge-section")).toBeInTheDocument();
    });
    expect(useSettingsStore.getState().serverSettingsId).toBeNull();

    await user.click(screen.getByRole("button", { name: /Profile/i }));

    expect(screen.getByText("Profile Tab")).toBeInTheDocument();
    expect(useSettingsStore.getState().settingsTab).toBe("profile");
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
