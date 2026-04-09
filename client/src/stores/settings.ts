import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  // Output
  masterOutputVolume: number;
  preferredOutputDeviceId: string | null;

  // Normalization
  normalizationEnabled: boolean;
  compressorThreshold: number;
  compressorKnee: number;
  compressorRatio: number;
  compressorAttack: number;
  compressorRelease: number;
  makeupGain: number;

  // Soundboard
  soundboardVolume: number;

  // Per-user
  userVolumes: Record<string, number>;
  userMuted: Record<string, boolean>;

  // Input
  masterInputVolume: number;
  preferredInputDeviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;

  // Notifications
  notificationsEnabled: boolean;
  defaultNotificationLevel: "all" | "mentions" | "nothing";
  serverNotifications: Record<string, "all" | "mentions" | "nothing">;
  channelNotifications: Record<string, "all" | "mentions" | "nothing">;
  notificationSound: boolean;

  // UI (not persisted)
  settingsOpen: boolean;
  settingsTab: "audio" | "voice" | "notifications" | "profile" | "node" | "about" | "admin";
  serverSettingsId: string | null;

  // Actions
  setMasterOutputVolume: (v: number) => void;
  setPreferredOutputDeviceId: (id: string | null) => void;
  setNormalizationEnabled: (v: boolean) => void;
  setCompressorParam: (
    key:
      | "compressorThreshold"
      | "compressorKnee"
      | "compressorRatio"
      | "compressorAttack"
      | "compressorRelease"
      | "makeupGain",
    value: number,
  ) => void;
  setSoundboardVolume: (v: number) => void;
  setUserVolume: (identity: string, volume: number) => void;
  toggleUserMuted: (identity: string) => void;
  setMasterInputVolume: (v: number) => void;
  setPreferredInputDeviceId: (id: string | null) => void;
  setEchoCancellation: (v: boolean) => void;
  setNoiseSuppression: (v: boolean) => void;
  setAutoGainControl: (v: boolean) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setDefaultNotificationLevel: (level: "all" | "mentions" | "nothing") => void;
  setServerNotificationLevel: (serverId: string, level: "all" | "mentions" | "nothing" | "default") => void;
  setChannelNotificationLevel: (roomId: string, level: "all" | "mentions" | "nothing" | "default") => void;
  setNotificationSound: (v: boolean) => void;
  openSettings: (tab?: "audio" | "voice" | "notifications" | "profile" | "node" | "about" | "admin") => void;
  closeSettings: () => void;
  setSettingsTab: (tab: "audio" | "voice" | "notifications" | "profile" | "node" | "about" | "admin") => void;
  openServerSettings: (serverId: string) => void;
  closeServerSettings: () => void;
  resetToDefaults: () => void;
}

const defaults = {
  masterOutputVolume: 1.0,
  preferredOutputDeviceId: null,
  normalizationEnabled: true,
  compressorThreshold: -30,
  compressorKnee: 20,
  compressorRatio: 12,
  compressorAttack: 0.003,
  compressorRelease: 0.25,
  makeupGain: 1.5,
  soundboardVolume: 0.5,
  userVolumes: {} as Record<string, number>,
  userMuted: {} as Record<string, boolean>,
  masterInputVolume: 1.0,
  preferredInputDeviceId: null,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  notificationsEnabled: true,
  defaultNotificationLevel: "all" as const,
  serverNotifications: {} as Record<string, "all" | "mentions" | "nothing">,
  channelNotifications: {} as Record<string, "all" | "mentions" | "nothing">,
  notificationSound: true,
} as const;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      userVolumes: {},
      userMuted: {},
      serverNotifications: {},
      channelNotifications: {},

      // UI state (excluded from persistence via partialize)
      settingsOpen: false,
      settingsTab: "audio" as const,
      serverSettingsId: null,

      setMasterOutputVolume: (v) => set({ masterOutputVolume: v }),
      setPreferredOutputDeviceId: (id) =>
        set({ preferredOutputDeviceId: id }),
      setNormalizationEnabled: (v) => set({ normalizationEnabled: v }),
      setCompressorParam: (key, value) => set({ [key]: value }),
      setSoundboardVolume: (v) => set({ soundboardVolume: v }),
      setUserVolume: (identity, volume) =>
        set((s) => ({
          userVolumes: { ...s.userVolumes, [identity]: volume },
        })),
      toggleUserMuted: (identity) =>
        set((s) => ({
          userMuted: { ...s.userMuted, [identity]: !s.userMuted[identity] },
        })),
      setMasterInputVolume: (v) => set({ masterInputVolume: v }),
      setPreferredInputDeviceId: (id) =>
        set({ preferredInputDeviceId: id }),
      setEchoCancellation: (v) => set({ echoCancellation: v }),
      setNoiseSuppression: (v) => set({ noiseSuppression: v }),
      setAutoGainControl: (v) => set({ autoGainControl: v }),
      setNotificationsEnabled: (v) => set({ notificationsEnabled: v }),
      setDefaultNotificationLevel: (level) => set({ defaultNotificationLevel: level }),
      setServerNotificationLevel: (serverId, level) =>
        set((s) => {
          const next = { ...s.serverNotifications };
          if (level === "default") {
            delete next[serverId];
          } else {
            next[serverId] = level;
          }
          return { serverNotifications: next };
        }),
      setChannelNotificationLevel: (roomId, level) =>
        set((s) => {
          const next = { ...s.channelNotifications };
          if (level === "default") {
            delete next[roomId];
          } else {
            next[roomId] = level;
          }
          return { channelNotifications: next };
        }),
      setNotificationSound: (v) => set({ notificationSound: v }),
      openSettings: (tab) =>
        set({ settingsOpen: true, serverSettingsId: null, settingsTab: tab ?? "audio" }),
      closeSettings: () => set({ settingsOpen: false }),
      setSettingsTab: (tab) => set({ settingsTab: tab }),
      openServerSettings: (serverId) =>
        set({ serverSettingsId: serverId, settingsOpen: false }),
      closeServerSettings: () => set({ serverSettingsId: null }),
      resetToDefaults: () => set({ ...defaults, userVolumes: {}, userMuted: {}, serverNotifications: {}, channelNotifications: {} }),
    }),
    {
      name: "concord_settings",
      partialize: ({ settingsOpen: _, settingsTab: __, serverSettingsId: ___, ...persisted }) => {
        return persisted;
      },
    },
  ),
);
