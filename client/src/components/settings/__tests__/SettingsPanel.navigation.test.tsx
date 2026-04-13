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
vi.mock("../ServerSettingsModal", () => ({
  ServerSettingsContent: ({ activeTab }: { activeTab: string }) => (
    <div>Server Tab: {activeTab}</div>
  ),
}));

describe("<SettingsPanel /> navigation", () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "token",
      userId: "@alice:concorrd.com",
    });
    useServerStore.setState({
      servers: [
        {
          id: "discord-1",
          name: "Discord Guild",
          icon_url: null,
          owner_id: "@alice:concorrd.com",
          visibility: "private",
          abbreviation: "DG",
          media_uploads_enabled: true,
          channels: [],
          bridgeType: "discord",
        },
      ],
      members: {
        "discord-1": [],
      },
    });
    useSettingsStore.setState({
      settingsOpen: true,
      settingsTab: "server-bridge",
      serverSettingsId: "discord-1",
    });
  });

  it("keeps user tabs navigable while server settings are open", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    expect(screen.getByText("Server Tab: bridge")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Profile/i }));

    expect(screen.getByText("Profile Tab")).toBeInTheDocument();
    expect(useSettingsStore.getState().settingsTab).toBe("profile");
  });

  it("clears server context when settings are closed", () => {
    useSettingsStore.getState().closeSettings();

    expect(useSettingsStore.getState().settingsOpen).toBe(false);
    expect(useSettingsStore.getState().serverSettingsId).toBeNull();
  });
});
