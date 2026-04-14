import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

vi.mock("../../../api/concord", async () => {
  const actual = await vi.importActual<typeof import("../../../api/concord")>(
    "../../../api/concord",
  );
  return {
    ...actual,
    checkAdmin: vi.fn().mockResolvedValue({ is_admin: false }),
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
vi.mock("../BridgesTab", () => ({ BridgesTab: () => <div>Bridges Tab</div> }));
vi.mock("../AboutTab", () => ({ AboutTab: () => <div>About Tab</div> }));
vi.mock("../AdminTab", () => ({ AdminTab: () => <div>Admin Tab</div> }));

describe("<SettingsPanel /> bridge server navigation", () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "token",
      userId: "@alice:concorrd.com",
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
              name: "General",
              channel_type: "text",
              matrix_room_id: "!general:concorrd.com",
              position: 0,
            },
            {
              id: 2,
              name: "Voice",
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

  it("renders the discord bridge server tab and returns to profile cleanly", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    expect(screen.getByText("Discord Bridge")).toBeInTheDocument();
    expect(screen.getAllByText("CTP Playtime").length).toBeGreaterThan(0);
    expect(screen.getByText("Text Rooms")).toBeInTheDocument();
    expect(screen.getByText("Voice Rooms")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Profile/i }));

    expect(screen.getByText("Profile Tab")).toBeInTheDocument();
    expect(useSettingsStore.getState().serverSettingsId).toBeNull();
    expect(useSettingsStore.getState().settingsTab).toBe("profile");
  });
});
