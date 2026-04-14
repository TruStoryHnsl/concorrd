import { describe, expect, it } from "vitest";
import channelSidebarSource from "../../layout/ChannelSidebar.tsx?raw";
import profileTabSource from "../ProfileTab.tsx?raw";
import settingsModalSource from "../SettingsModal.tsx?raw";

describe("settings auth controls", () => {
  it("keeps the logout control out of the shared settings shell", () => {
    expect(settingsModalSource).not.toContain("Logout button");
    expect(settingsModalSource).not.toContain("useAuthStore.getState().logout()");
  });

  it("keeps the logout control on the profile tab", () => {
    expect(profileTabSource).toContain("const logout = useAuthStore((s) => s.logout);");
    expect(profileTabSource).toMatch(/>\s*Logout\s*</);
  });

  it("keeps the logout control on the bottom user banner", () => {
    expect(channelSidebarSource).toContain("title=\"Logout\"");
    expect(channelSidebarSource).toContain("aria-label=\"Logout\"");
  });
});
