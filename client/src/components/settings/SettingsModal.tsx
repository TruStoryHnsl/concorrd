import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useAuthStore } from "../../stores/auth";
import { checkAdmin } from "../../api/concord";
import { AudioTab } from "./AudioTab";
import { VoiceTab } from "./VoiceTab";
import { NotificationsTab } from "./NotificationsTab";
import { ProfileTab } from "./ProfileTab";
import { AppearanceTab } from "./AppearanceTab";
import { NodeHostingTab } from "./NodeHostingTab";
import { AboutTab } from "./AboutTab";
import { AdminTab } from "./AdminTab";

const baseTabs = [
  { key: "audio" as const, label: "Audio", icon: "headphones" },
  { key: "voice" as const, label: "Voice", icon: "graphic_eq" },
  { key: "notifications" as const, label: "Notifications", icon: "notifications" },
  { key: "profile" as const, label: "Profile", icon: "person" },
  { key: "appearance" as const, label: "Appearance", icon: "palette" },
  { key: "node" as const, label: "Node", icon: "dns" },
  { key: "about" as const, label: "About", icon: "info" },
];

/**
 * Inline settings panel — renders inside the main content pane
 * (no overlay, no modal). ChatLayout shows this when settingsOpen is true.
 */
export function SettingsPanel() {
  const activeTab = useSettingsStore((s) => s.settingsTab);
  const setTab = useSettingsStore((s) => s.setSettingsTab);
  const close = useSettingsStore((s) => s.closeSettings);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [isAdmin, setIsAdmin] = useState(false);

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

  const tabs = isAdmin
    ? [...baseTabs, { key: "admin" as const, label: "Admin", icon: "shield_person" }]
    : baseTabs;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 bg-surface-container-low overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
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

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-6 max-w-2xl">
        {activeTab === "audio" && <AudioTab />}
        {activeTab === "voice" && <VoiceTab />}
        {activeTab === "notifications" && <NotificationsTab />}
        {activeTab === "profile" && <ProfileTab />}
        {activeTab === "appearance" && <AppearanceTab />}
        {activeTab === "node" && <NodeHostingTab />}
        {activeTab === "about" && <AboutTab />}
        {activeTab === "admin" && isAdmin && <AdminTab />}

        {/* T003: Logout (secondary fallback path, available on every tab) */}
        <div className="mt-8 pt-6 border-t border-outline-variant/15 flex justify-start">
          <button
            onClick={() => useAuthStore.getState().logout()}
            className="text-error border border-error/30 rounded px-4 py-2 hover:bg-error/10 transition-colors text-sm font-label font-medium min-h-[44px]"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
