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
import { UserConnectionsTab } from "./UserConnectionsTab";
import { AboutTab } from "./AboutTab";
import { HostingTab } from "./HostingTab";
import { AdminTab } from "./AdminTab";
import { ServerSettingsContent } from "./ServerSettingsModal";

type TabDef = {
  key: string;
  label: string;
  icon: string;
  group: "user" | "server";
};

const EMPTY_MEMBERS: never[] = [];

// Pure helper — compute server settings tabs for a given server/member context
function buildServerTabs(
  server: { id: string; owner_id: string; federated?: boolean; visibility?: string },
  members: { user_id: string; role: string }[],
  userId: string | null,
): TabDef[] {
  if (server.federated) {
    return [{ key: "server-federation", label: "Federation", icon: "language", group: "server" }];
  }
  const myMember = members.find((m) => m.user_id === userId);
  const isOwner = server.owner_id === userId;
  const isAdmin = isOwner || myMember?.role === "admin";
  const tabs: TabDef[] = [
    { key: "server-general", label: "General", icon: "settings", group: "server" },
    { key: "server-members", label: "Members", icon: "group", group: "server" },
  ];
  if (isAdmin) tabs.push({ key: "server-invite", label: "Invite", icon: "person_add", group: "server" });
  tabs.push({ key: "server-bans", label: "Bans", icon: "block", group: "server" });
  if (server.visibility === "private") tabs.push({ key: "server-whitelist", label: "Whitelist", icon: "verified_user", group: "server" });
  tabs.push({ key: "server-webhooks", label: "Webhooks", icon: "webhook", group: "server" });
  if (isAdmin) tabs.push({ key: "server-moderation", label: "Moderation", icon: "gavel", group: "server" });
  return tabs;
}

/**
 * INS-012: Unified settings panel — a single navigable interface
 * that contains both User Settings and Server Settings as sibling
 * sections with clear visual separation.
 *
 * Admin servers are always surfaced in the sidebar regardless of which
 * tab is active, so admins can switch between user and server settings
 * without losing their server context.
 */
export function SettingsPanel() {
  const activeTab = useSettingsStore((s) => s.settingsTab);
  const setTab = useSettingsStore((s) => s.setSettingsTab);
  const close = useSettingsStore((s) => s.closeSettings);
  const serverSettingsId = useSettingsStore((s) => s.serverSettingsId);
  const setServerSettingsId = useSettingsStore((s) => s.setServerSettingsId);
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);
  const [isAdmin, setIsAdmin] = useState(false);
  const { isTauri, isMobile, isTV } = usePlatform();

  const tvFocusProps = isTV
    ? ({ "data-focusable": "true", "data-focus-group": "tv-main" } as const)
    : ({} as const);

  const servers = useServerStore((s) => s.servers);
  const membersByServer = useServerStore((s) => s.members);

  // Servers where user is owner or has the admin role
  const adminServers = useMemo(
    () =>
      servers.filter((s) => {
        if (s.owner_id === userId) return true;
        return membersByServer[s.id]?.some((m) => m.user_id === userId && m.role === "admin") ?? false;
      }),
    [servers, membersByServer, userId],
  );

  // Tab sets per admin server
  const adminServerTabs = useMemo(() => {
    const map = new Map<string, TabDef[]>();
    for (const server of adminServers) {
      map.set(server.id, buildServerTabs(server, membersByServer[server.id] ?? EMPTY_MEMBERS, userId));
    }
    return map;
  }, [adminServers, membersByServer, userId]);

  // If serverSettingsId points to a non-admin server (opened via context menu),
  // still show that server's section so the user doesn't lose context.
  const contextServer =
    serverSettingsId && !adminServerTabs.has(serverSettingsId)
      ? (servers.find((s) => s.id === serverSettingsId) ?? null)
      : null;
  const contextServerTabs = useMemo(
    () =>
      contextServer
        ? buildServerTabs(contextServer, membersByServer[contextServer.id] ?? EMPTY_MEMBERS, userId)
        : [],
    [contextServer, membersByServer, userId],
  );

  // Tabs for whichever server is currently active in the content pane
  const activeServerTabs = serverSettingsId
    ? (adminServerTabs.get(serverSettingsId) ?? contextServerTabs)
    : [];

  const userTabs = useMemo(() => {
    const tabs: TabDef[] = [
      { key: "audio", label: "Audio", icon: "headphones", group: "user" },
      { key: "voice", label: "Voice", icon: "graphic_eq", group: "user" },
      { key: "notifications", label: "Notifications", icon: "notifications", group: "user" },
      { key: "profile", label: "Profile", icon: "person", group: "user" },
      { key: "connections", label: "Connections", icon: "link", group: "user" },
      { key: "appearance", label: "Appearance", icon: "palette", group: "user" },
    ];
    if (isTauri) {
      // INS-022: Node tab is visible on mobile Tauri too — the embedded
      // servitude module runs on mobile (foreground-active; backgrounded
      // pauses are handled by the app-level lifecycle hook).
      tabs.push({ key: "node", label: "Node", icon: "dns", group: "user" });
    }
    tabs.push({ key: "hosting", label: "Hosting", icon: "dns", group: "user" });
    tabs.push({ key: "about", label: "About", icon: "info", group: "user" });
    return tabs;
  }, [isTauri, isMobile, isAdmin]);

  const adminTab: TabDef | null = useMemo(
    () => (isAdmin ? { key: "admin", label: "Admin", icon: "shield_person", group: "user" } : null),
    [isAdmin],
  );

  const userTabKeys = useMemo(
    () => new Set<string>([...userTabs.map((t) => t.key), ...(adminTab ? [adminTab.key] : [])]),
    [adminTab, userTabs],
  );

  // Auto-select first server tab when server context activates and active tab isn't valid
  useEffect(() => {
    if (!serverSettingsId || activeServerTabs.length === 0) return;
    if (activeServerTabs.some((t) => t.key === activeTab)) return;
    if (userTabKeys.has(activeTab)) return;
    setTab(activeServerTabs[0].key as typeof activeTab);
  }, [activeTab, serverSettingsId, activeServerTabs, setTab, userTabKeys]);

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

  const isServerTab = activeTab.startsWith("server-");
  const serverSubTab = isServerTab ? activeTab.replace("server-", "") : null;

  // User tab click — no longer clears server context so admin sections stay visible
  const handleSelectTab = (tab: typeof activeTab) => {
    setTab(tab);
  };

  // Server tab click — set which server's content to show and switch tab
  const handleSelectServerTab = (serverId: string, tab: typeof activeTab) => {
    setServerSettingsId(serverId);
    setTab(tab);
  };

  const tabBtnClass = (active: boolean) =>
    `btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm whitespace-nowrap transition-all font-label ${
      active
        ? "bg-surface-container-highest text-on-surface"
        : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
    }`;

  const filledIcon = { fontVariationSettings: '"FILL" 1, "wght" 500, "GRAD" 0, "opsz" 24' };

  // Render the single "Server settings" row: a server picker that
  // determines which server's tab strip expands below. Collapses N
  // Server-scoped sections down to one row, reducing the Settings tab
  // bar's vertical footprint regardless of how many servers the user
  // administers. Non-admin servers opened via "context menu → Server
  // settings" appear in the picker too, so the current-server context
  // isn't lost when the user lands in SettingsPanel from a gear click.
  const serverPickerOptions = useMemo(() => {
    const opts: { server: (typeof servers)[0]; tabs: TabDef[] }[] = [];
    for (const server of adminServers) {
      const tabs = adminServerTabs.get(server.id);
      if (tabs && tabs.length > 0) opts.push({ server, tabs });
    }
    if (
      contextServer &&
      contextServerTabs.length > 0 &&
      !opts.some((o) => o.server.id === contextServer.id)
    ) {
      opts.push({ server: contextServer, tabs: contextServerTabs });
    }
    return opts;
  }, [adminServers, adminServerTabs, contextServer, contextServerTabs]);

  const selectedServerOption =
    serverPickerOptions.find((o) => o.server.id === serverSettingsId) ?? null;

  const renderServerRow = () => {
    if (serverPickerOptions.length === 0) return null;
    return (
      <div>
        <div className="border-t border-outline-variant/10 mx-4" />
        <div className="px-4 pt-2 pb-1">
          <span className="text-xs font-label font-medium text-on-surface-variant/60 uppercase tracking-wider">
            Server Settings
          </span>
        </div>
        <div className="flex items-center gap-1 px-4 pb-2 overflow-x-auto">
          {/* Server picker — a native <select> so we get the OS dropdown
             for free (including mobile pickers and TV focus handling)
             without rebuilding a combobox. */}
          <label className="flex-shrink-0">
            <span className="sr-only">Select server</span>
            <select
              value={serverSettingsId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) {
                  setServerSettingsId(null);
                  return;
                }
                const opt = serverPickerOptions.find((o) => o.server.id === id);
                if (!opt) return;
                const firstServerTab = opt.tabs[0];
                const stayingOnSameKey = opt.tabs.some(
                  (t) => t.key === activeTab,
                );
                handleSelectServerTab(
                  id,
                  (stayingOnSameKey
                    ? activeTab
                    : firstServerTab.key) as typeof activeTab,
                );
              }}
              {...tvFocusProps}
              className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm whitespace-nowrap bg-surface-container-high text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/40"
            >
              <option value="">Select server…</option>
              {serverPickerOptions.map(({ server }) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </label>
          {/* Tabs for the selected server (if any). Collapsing N rows
             into one means the user only sees tabs relevant to their
             current selection, not every server they admin. */}
          {selectedServerOption?.tabs.map((tab) => {
            const active =
              activeTab === tab.key && serverSettingsId === selectedServerOption.server.id;
            return (
              <button
                key={tab.key}
                onClick={() =>
                  handleSelectServerTab(
                    selectedServerOption.server.id,
                    tab.key as typeof activeTab,
                  )
                }
                {...tvFocusProps}
                className={tabBtnClass(active)}
              >
                <span
                  className="material-symbols-outlined text-base"
                  style={active ? filledIcon : undefined}
                >
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

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
          {userTabs.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => handleSelectTab(tab.key as typeof activeTab)}
                {...tvFocusProps}
                className={tabBtnClass(active)}
              >
                <span
                  className="material-symbols-outlined text-base"
                  style={active ? filledIcon : undefined}
                >
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            );
          })}
          {adminTab && (
            <button
              onClick={() => handleSelectTab("admin")}
              {...tvFocusProps}
              className={tabBtnClass(activeTab === "admin")}
            >
              <span
                className="material-symbols-outlined text-base"
                style={activeTab === "admin" ? filledIcon : undefined}
              >
                {adminTab.icon}
              </span>
              {adminTab.label}
            </button>
          )}
        </div>

        {/* Single collapsed "Server Settings" row — the picker drives
           which server's tabs are visible below, rather than rendering
           one row per admin server. Reduces vertical clutter when the
           user admins multiple servers. */}
        {renderServerRow()}
      </div>

      {/* Tab content */}
      <div key={`${serverSettingsId ?? "user"}:${activeTab}`} className="flex-1 overflow-y-auto min-h-0 p-6">
        {/* User settings tabs */}
        {activeTab === "audio" && <AudioTab />}
        {activeTab === "voice" && <VoiceTab />}
        {activeTab === "notifications" && <NotificationsTab />}
        {activeTab === "profile" && <ProfileTab />}
        {activeTab === "connections" && <UserConnectionsTab />}
        {activeTab === "appearance" && <AppearanceTab />}
        {activeTab === "node" && <NodeHostingTab />}
        {activeTab === "hosting" && <HostingTab />}
        {activeTab === "about" && <AboutTab />}
        {activeTab === "admin" && isAdmin && <AdminTab />}

        {/* Server settings tabs — delegated to ServerSettingsContent */}
        {isServerTab && serverSettingsId && accessToken && (
          <ServerSettingsContent
            serverId={serverSettingsId}
            activeTab={serverSubTab!}
          />
        )}
      </div>
    </div>
  );
}
