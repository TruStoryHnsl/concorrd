import { useEffect, useState, useMemo } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useAuthStore } from "../../stores/auth";
import { useServerStore } from "../../stores/server";
import { checkAdmin } from "../../api/concord";
import { usePlatform } from "../../hooks/usePlatform";
import { AudioTab } from "./AudioTab";
import { VoiceTab } from "./VoiceTab";
import { NotificationsTab } from "./NotificationsTab";
import { ProfileTab } from "./ProfileTab";
import { AppearanceTab } from "./AppearanceTab";
import { NodeHostingTab } from "./NodeHostingTab";
import { BridgesTab } from "./BridgesTab";
import { AboutTab } from "./AboutTab";
import { AdminTab } from "./AdminTab";
import { ServerSettingsContent } from "./ServerSettingsModal";

type TabDef = {
  key: string;
  label: string;
  icon: string;
  group: "user" | "server";
};

/**
 * INS-012: Unified settings panel — a single navigable interface
 * that contains both User Settings and Server Settings as sibling
 * sections with clear visual separation.
 *
 * When no server is selected, only user settings tabs appear.
 * When a server is active (via `serverSettingsId`), server-scope
 * tabs appear in a second group below user settings tabs.
 */
export function SettingsPanel() {
  const activeTab = useSettingsStore((s) => s.settingsTab);
  const setTab = useSettingsStore((s) => s.setSettingsTab);
  const close = useSettingsStore((s) => s.closeSettings);
  const serverSettingsId = useSettingsStore((s) => s.serverSettingsId);
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);
  const [isAdmin, setIsAdmin] = useState(false);
  const { isTauri, isMobile, isTV } = usePlatform();

  // TV mode (INS-023): every tab button + the Logout button get
  // DPAD focus attributes so the shared `useDpadNav({ group: "tv-main" })`
  // handler registered in ChatLayout can traverse the settings shell.
  // Helper stays local so the JSX stays compact.
  const tvFocusProps = isTV
    ? ({
        "data-focusable": "true",
        "data-focus-group": "tv-main",
      } as const)
    : ({} as const);

  // Server context for server settings group
  const servers = useServerStore((s) => s.servers);
  const activeServer = servers.find((s) => s.id === serverSettingsId);
  const members = useServerStore((s) =>
    serverSettingsId ? s.members[serverSettingsId] ?? [] : [],
  );
  const myMember = members.find((m) => m.user_id === userId);
  const isOwner = activeServer?.owner_id === userId;
  const isServerAdmin = isOwner || myMember?.role === "admin";

  // Bridges tab is desktop-only (bridge process requires Linux bwrap).
  // Node hosting is Tauri-only (no browser, no mobile).
  const userTabs = useMemo(() => {
    const tabs: TabDef[] = [
      { key: "audio", label: "Audio", icon: "headphones", group: "user" },
      { key: "voice", label: "Voice", icon: "graphic_eq", group: "user" },
      { key: "notifications", label: "Notifications", icon: "notifications", group: "user" },
      { key: "profile", label: "Profile", icon: "person", group: "user" },
      { key: "appearance", label: "Appearance", icon: "palette", group: "user" },
    ];
    if (isTauri && !isMobile) {
      tabs.push({ key: "node", label: "Node", icon: "dns", group: "user" });
      tabs.push({ key: "bridges", label: "Bridges", icon: "hub", group: "user" });
    }
    // Show bridges tab on web too when user is admin (docker bridge management)
    if (!isTauri && isAdmin) {
      tabs.push({ key: "bridges", label: "Bridges", icon: "hub", group: "user" });
    }
    tabs.push({ key: "about", label: "About", icon: "info", group: "user" });
    return tabs;
  }, [isTauri, isMobile, isAdmin]);

  // Server settings tabs — only for API-backed servers (not synthetic bridge/federated)
  const serverTabs = useMemo(() => {
    if (!activeServer) return [];
    if (activeServer.bridgeType || activeServer.federated) return [];
    const tabs: TabDef[] = [
      { key: "server-general", label: "General", icon: "settings", group: "server" },
      { key: "server-members", label: "Members", icon: "group", group: "server" },
    ];
    if (isOwner || isServerAdmin) {
      tabs.push({ key: "server-invite", label: "Invite", icon: "person_add", group: "server" });
    }
    tabs.push({ key: "server-bans", label: "Bans", icon: "block", group: "server" });
    if (activeServer.visibility === "private") {
      tabs.push({ key: "server-whitelist", label: "Whitelist", icon: "verified_user", group: "server" });
    }
    tabs.push({ key: "server-webhooks", label: "Webhooks", icon: "webhook", group: "server" });
    if (isOwner || isServerAdmin) {
      tabs.push({ key: "server-moderation", label: "Moderation", icon: "gavel", group: "server" });
    }
    return tabs;
  }, [activeServer, isOwner, isServerAdmin]);

  useEffect(() => {
    if (!accessToken) return;
    checkAdmin(accessToken).then((r) => setIsAdmin(r.is_admin)).catch(() => {});
  }, [accessToken]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);

  const adminTab: TabDef | null = isAdmin
    ? { key: "admin", label: "Admin", icon: "shield_person", group: "user" }
    : null;

  // Determine if the current tab is a server tab
  const isServerTab = activeTab.startsWith("server-");
  // Extract the server sub-tab (e.g., "server-general" -> "general")
  const serverSubTab = isServerTab ? activeTab.replace("server-", "") : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab bar with grouped sections */}
      <div className="flex flex-col bg-surface-container-low overflow-x-auto">
        {/* User Settings group */}
        <div className="px-4 pt-2 pb-1">
          <span className="text-xs font-label font-medium text-on-surface-variant/60 uppercase tracking-wider">
            User Settings
          </span>
        </div>
        <div className="flex items-center gap-1 px-4 pb-1 overflow-x-auto">
          {userTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setTab(tab.key as typeof activeTab)}
              {...tvFocusProps}
              className={`btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm whitespace-nowrap transition-all font-label ${
                activeTab === tab.key
                  ? "bg-surface-container-highest text-on-surface"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              }`}
            >
              <span
                className="material-symbols-outlined text-base"
                style={activeTab === tab.key ? { fontVariationSettings: '"FILL" 1, "wght" 500, "GRAD" 0, "opsz" 24' } : undefined}
              >
                {tab.icon}
              </span>
              {tab.label}
            </button>
          ))}
          {adminTab && (
            <button
              onClick={() => setTab("admin")}
              {...tvFocusProps}
              className={`btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm whitespace-nowrap transition-all font-label ${
                activeTab === "admin"
                  ? "bg-surface-container-highest text-on-surface"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              }`}
            >
              <span
                className="material-symbols-outlined text-base"
                style={activeTab === "admin" ? { fontVariationSettings: '"FILL" 1, "wght" 500, "GRAD" 0, "opsz" 24' } : undefined}
              >
                {adminTab.icon}
              </span>
              {adminTab.label}
            </button>
          )}
        </div>

        {/* Server Settings group — only when a server is selected */}
        {serverTabs.length > 0 && (
          <>
            <div className="border-t border-outline-variant/10 mx-4" />
            <div className="px-4 pt-2 pb-1 flex items-center gap-2">
              <span className="text-xs font-label font-medium text-on-surface-variant/60 uppercase tracking-wider">
                Server Settings
              </span>
              <span className="text-xs font-label text-on-surface-variant/40">
                {activeServer?.name}
              </span>
            </div>
            <div className="flex items-center gap-1 px-4 pb-2 overflow-x-auto">
              {serverTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setTab(tab.key as typeof activeTab)}
                  {...tvFocusProps}
                  className={`btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm whitespace-nowrap transition-all font-label ${
                    activeTab === tab.key
                      ? "bg-surface-container-highest text-on-surface"
                      : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                  }`}
                >
                  <span
                    className="material-symbols-outlined text-base"
                    style={activeTab === tab.key ? { fontVariationSettings: '"FILL" 1, "wght" 500, "GRAD" 0, "opsz" 24' } : undefined}
                  >
                    {tab.icon}
                  </span>
                  {tab.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-6 max-w-2xl">
        {/* User settings tabs */}
        {activeTab === "audio" && <AudioTab />}
        {activeTab === "voice" && <VoiceTab />}
        {activeTab === "notifications" && <NotificationsTab />}
        {activeTab === "profile" && <ProfileTab />}
        {activeTab === "appearance" && <AppearanceTab />}
        {activeTab === "node" && <NodeHostingTab />}
        {activeTab === "bridges" && <BridgesTab />}
        {activeTab === "about" && <AboutTab />}
        {activeTab === "admin" && isAdmin && <AdminTab />}

        {/* Server settings tabs — delegated to ServerSettingsContent */}
        {isServerTab && serverSettingsId && accessToken && (
          <ServerSettingsContent
            serverId={serverSettingsId}
            activeTab={serverSubTab!}
          />
        )}

        {/* Logout button — always visible at bottom */}
        <div className="mt-8 pt-6 border-t border-outline-variant/15 flex justify-start">
          <button
            onClick={() => useAuthStore.getState().logout()}
            {...tvFocusProps}
            className="text-error border border-error/30 rounded px-4 py-2 hover:bg-error/10 transition-colors text-sm font-label font-medium min-h-[44px]"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
