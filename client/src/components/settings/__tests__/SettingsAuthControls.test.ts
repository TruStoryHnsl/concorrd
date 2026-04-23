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

  it("wires logout into the bottom user banner's switch-server flow", () => {
    // Bridge-bootstrap PR4/5 retired the standalone "Logout" button on
    // the user banner; logout now happens implicitly as part of
    // handleSwitchServer (clear homeserver → logout → reload). The
    // logout function is still imported and called from this file.
    expect(channelSidebarSource).toContain("logout()");
    expect(channelSidebarSource).toMatch(/logout:\s*\(\)/);
  });
});
