// client/src/stores/format.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface FormatOverride {
  alignment: "left" | "center" | "right" | "justify";
  fontSize: number;
  color: string;
  fontFamily: string;
}

const DEFAULT_FORMAT: FormatOverride = {
  alignment: "left",
  fontSize: 14,
  color: "",        // empty = theme default
  fontFamily: "system",
};

interface FormatState {
  // Viewer overrides (persisted to localStorage)
  messageFormats: Record<string, FormatOverride>;
  senderFormats: Record<string, FormatOverride>;
  setMessageFormat: (id: string, fmt: Partial<FormatOverride>) => void;
  setSenderFormat: (userId: string, fmt: Partial<FormatOverride>) => void;
  clearMessageFormat: (id: string) => void;
  clearSenderFormat: (userId: string) => void;

  // Pre-send draft (ephemeral — not persisted, resets on send)
  draftFormat: FormatOverride;
  formatPanelOpen: boolean;
  setDraftFormat: (fmt: Partial<FormatOverride>) => void;
  clearDraftFormat: () => void;
  setFormatPanelOpen: (open: boolean) => void;
}

export const useFormatStore = create<FormatState>()(
  persist(
    (set, get) => ({
      messageFormats: {},
      senderFormats: {},
      setMessageFormat: (id, fmt) =>
        set((s) => ({
          messageFormats: {
            ...s.messageFormats,
            [id]: { ...(s.messageFormats[id] ?? DEFAULT_FORMAT), ...fmt },
          },
        })),
      setSenderFormat: (userId, fmt) =>
        set((s) => ({
          senderFormats: {
            ...s.senderFormats,
            [userId]: { ...(s.senderFormats[userId] ?? DEFAULT_FORMAT), ...fmt },
          },
        })),
      clearMessageFormat: (id) =>
        set((s) => {
          const next = { ...s.messageFormats };
          delete next[id];
          return { messageFormats: next };
        }),
      clearSenderFormat: (userId) =>
        set((s) => {
          const next = { ...s.senderFormats };
          delete next[userId];
          return { senderFormats: next };
        }),

      draftFormat: { ...DEFAULT_FORMAT },
      formatPanelOpen: false,
      setDraftFormat: (fmt) =>
        set((s) => ({ draftFormat: { ...s.draftFormat, ...fmt } })),
      clearDraftFormat: () => set({ draftFormat: { ...DEFAULT_FORMAT } }),
      setFormatPanelOpen: (open) => set({ formatPanelOpen: open }),
    }),
    {
      name: "concord_format_overrides",
      // Only persist viewer overrides; draft state is ephemeral.
      partialize: (s) => ({
        messageFormats: s.messageFormats,
        senderFormats: s.senderFormats,
      }),
    },
  ),
);

export { DEFAULT_FORMAT };
