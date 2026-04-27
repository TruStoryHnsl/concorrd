import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useServerStore } from "./server";
import {
  INPUT_NOISE_GATE_DB_DEFAULT,
  INPUT_NOISE_GATE_DB_MAX,
  INPUT_NOISE_GATE_DB_MIN,
} from "../voice/noiseGate";

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
  inputNoiseGateEnabled: boolean;
  inputNoiseGateThresholdDb: number;
  // Voice clarity: presence-band EQ (notch mains hum, lift 3 kHz vocal
  // presence, soften sibilance ~7 kHz) plus an upward compressor that
  // expands the perceived dynamic range of speech (loud parts stay loud,
  // quiet syllables become more audible). Per-user opt-in; default ON
  // for shipped clarity gain. `voiceClarityStrength` scales the EQ
  // boost/cut and compressor ratio jointly so a single slider controls
  // intensity. 0 ≈ flat passthrough, 1 ≈ aggressive broadcast voice.
  voiceClarityEnabled: boolean;
  voiceClarityStrength: number;

  // Notifications
  notificationsEnabled: boolean;
  defaultNotificationLevel: "all" | "mentions" | "nothing";
  serverNotifications: Record<string, "all" | "mentions" | "nothing">;
  channelNotifications: Record<string, "all" | "mentions" | "nothing">;
  notificationSound: boolean;

  // Appearance — chat body text size in absolute pixels. Applies only
  // to the message body prose (via the `--concord-chat-font-size` CSS
  // variable on .concord-message-body). UI chrome (sidebars, buttons,
  // headings, code blocks) intentionally does NOT scale — this lever is
  // for users who want large, readable chat text without a bloated
  // interface.
  chatFontSize: number;
  themePreset: ThemePreset;

  // UI (not persisted)
  settingsOpen: boolean;
  settingsTab: "audio" | "voice" | "notifications" | "profile" | "connections" | "appearance" | "node" | "hosting" | "about" | "admin" | "server-general" | "server-members" | "server-invite" | "server-bans" | "server-whitelist" | "server-webhooks" | "server-moderation" | "server-federation";
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
  setInputNoiseGateEnabled: (v: boolean) => void;
  setInputNoiseGateThresholdDb: (db: number) => void;
  setVoiceClarityEnabled: (v: boolean) => void;
  setVoiceClarityStrength: (strength: number) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setDefaultNotificationLevel: (level: "all" | "mentions" | "nothing") => void;
  setServerNotificationLevel: (serverId: string, level: "all" | "mentions" | "nothing" | "default") => void;
  setChannelNotificationLevel: (roomId: string, level: "all" | "mentions" | "nothing" | "default") => void;
  setNotificationSound: (v: boolean) => void;
  /**
   * Set the chat body text size in absolute pixels. Values are clamped
   * to [CHAT_FONT_SIZE_MIN, CHAT_FONT_SIZE_MAX] — callers can safely
   * forward raw slider input. Non-finite values (NaN, ±Infinity) are
   * dropped to keep persisted state well-formed.
   */
  setChatFontSize: (px: number) => void;
  setThemePreset: (preset: ThemePreset) => void;
  openSettings: (tab?: "audio" | "voice" | "notifications" | "profile" | "connections" | "appearance" | "node" | "hosting" | "about" | "admin" | "server-general" | "server-members" | "server-invite" | "server-bans" | "server-whitelist" | "server-webhooks" | "server-moderation" | "server-federation") => void;
  closeSettings: () => void;
  setSettingsTab: (tab: "audio" | "voice" | "notifications" | "profile" | "connections" | "appearance" | "node" | "hosting" | "about" | "admin" | "server-general" | "server-members" | "server-invite" | "server-bans" | "server-whitelist" | "server-webhooks" | "server-moderation" | "server-federation") => void;
  /**
   * Cross-component hand-off for the "Add Source" modal. Set the screen
   * to pre-open (e.g. "matrix", "concord"), and ChatLayout's effect hook
   * opens the modal at that screen. Cleared immediately after consumption.
   */
  pendingAddSourceScreen: string | null;
  requestAddSource: (screen?: string) => void;
  consumeAddSourceRequest: () => string | null;
  openServerSettings: (serverId: string) => void;
  closeServerSettings: () => void;
  setServerSettingsId: (id: string | null) => void;
  resetToDefaults: () => void;
}

/**
 * Chat-font-size bounds. Default 14px matches the legacy `text-sm`
 * that MessageContent used to apply on its body div before the CSS
 * variable indirection; this preserves zero-visual-change at the
 * default for existing users. The range is deliberately wide so
 * users with low vision can crank it well beyond comfortable
 * reading size.
 */
export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 32;
export const CHAT_FONT_SIZE_DEFAULT = 14;
export const THEME_PRESETS = [
  "bronze-teal",
  "kinetic-node",
  "verdant-signal",
  "ember-circuit",
  "arctic-current",
] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

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
  inputNoiseGateEnabled: true,
  inputNoiseGateThresholdDb: INPUT_NOISE_GATE_DB_DEFAULT,
  voiceClarityEnabled: true,
  voiceClarityStrength: 0.5,
  notificationsEnabled: true,
  defaultNotificationLevel: "all" as const,
  serverNotifications: {} as Record<string, "all" | "mentions" | "nothing">,
  channelNotifications: {} as Record<string, "all" | "mentions" | "nothing">,
  notificationSound: true,
  chatFontSize: CHAT_FONT_SIZE_DEFAULT,
  themePreset: "bronze-teal" as ThemePreset,
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
      pendingAddSourceScreen: null,

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
      setInputNoiseGateEnabled: (v) => set({ inputNoiseGateEnabled: v }),
      setInputNoiseGateThresholdDb: (db) => {
        if (!Number.isFinite(db)) return;
        const clamped = Math.max(
          INPUT_NOISE_GATE_DB_MIN,
          Math.min(INPUT_NOISE_GATE_DB_MAX, Math.round(db)),
        );
        set({ inputNoiseGateThresholdDb: clamped });
      },
      setVoiceClarityEnabled: (v) => set({ voiceClarityEnabled: v }),
      setVoiceClarityStrength: (strength) => {
        if (!Number.isFinite(strength)) return;
        set({ voiceClarityStrength: Math.max(0, Math.min(1, strength)) });
      },
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
      setChatFontSize: (px) => {
        // Reject non-finite inputs so persisted state never ends up
        // with NaN/Infinity. Clamp to bounds so external callers (e.g.
        // a future keyboard shortcut) can pass raw deltas without
        // their own guard.
        if (!Number.isFinite(px)) return;
        const clamped = Math.max(
          CHAT_FONT_SIZE_MIN,
          Math.min(CHAT_FONT_SIZE_MAX, Math.round(px)),
        );
        set({ chatFontSize: clamped });
      },
      setThemePreset: (preset) => set({ themePreset: preset }),
      openSettings: (tab) =>
        set({ settingsOpen: true, serverSettingsId: null, settingsTab: tab ?? "audio" }),
      closeSettings: () => set({ settingsOpen: false, serverSettingsId: null }),
      setSettingsTab: (tab) => set({ settingsTab: tab }),
      requestAddSource: (screen) => set({
        settingsOpen: false,
        serverSettingsId: null,
        pendingAddSourceScreen: screen ?? "pick",
      }),
      consumeAddSourceRequest: () => {
        // Read-and-clear. Functional update atomically captures the
        // current value and nulls it so the effect in ChatLayout fires
        // exactly once per request.
        let captured: string | null = null;
        set((state) => {
          captured = state.pendingAddSourceScreen;
          return { pendingAddSourceScreen: null };
        });
        return captured;
      },
      openServerSettings: (serverId) => {
        const server = useServerStore.getState().servers.find((entry) => entry.id === serverId);
        const settingsTab = server?.federated ? "server-federation" : "server-general";
        set({ serverSettingsId: serverId, settingsOpen: true, settingsTab });
      },
      closeServerSettings: () => set({ serverSettingsId: null }),
      setServerSettingsId: (id) => set({ serverSettingsId: id }),
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
