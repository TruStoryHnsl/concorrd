/**
 * Local porch store — zustand state for the host's OWN porch.
 *
 * Reads through the three native-only Tauri commands wrapped in
 * `client/src/api/porch.ts`:
 *
 *   - listMyChannels
 *   - getLocalMessages
 *   - postLocalMessage
 *
 * Browsers don't host a porch — all actions short-circuit and the
 * store stays in its initial empty state on web builds. The UI uses
 * `isLoaded === false` + `error === "native_only"` to render a
 * "this surface is desktop-only" placeholder rather than crashing.
 */

import { create } from "zustand";
import {
  getLocalMessages,
  listMyChannels,
  postLocalMessage,
  type ChannelMessage,
  type PorchChannel,
} from "../api/porch";
import { isTauri } from "../api/servitude";

export interface PorchStoreState {
  /** Channels on the host's own porch. */
  channels: PorchChannel[];
  /** Channel currently focused in the UI. */
  selectedChannelId: string | null;
  /** Messages for the selected channel, sorted asc by `created_at`. */
  messages: ChannelMessage[];
  /** True once the channel list has been fetched at least once. */
  isLoaded: boolean;
  /** True while a network/IPC request is in flight. */
  isLoading: boolean;
  /** Last error surface, if any. `"native_only"` is the
   *  conventional sentinel for the web build. */
  error: string | null;

  /** Fetch the channel list. Safe to call from the web build (returns
   *  early with `error: "native_only"`). */
  loadChannels: () => Promise<void>;
  /** Select a channel and refresh its messages. */
  selectChannel: (channelId: string) => Promise<void>;
  /** Re-fetch messages for the currently selected channel. */
  refreshMessages: () => Promise<void>;
  /** Post a message to the selected channel; appends to local state
   *  on success. */
  sendMessage: (body: string) => Promise<void>;
}

const MESSAGE_PAGE_SIZE = 200;

export const usePorchStore = create<PorchStoreState>((set, get) => ({
  channels: [],
  selectedChannelId: null,
  messages: [],
  isLoaded: false,
  isLoading: false,
  error: null,

  loadChannels: async () => {
    if (!isTauri()) {
      set({ error: "native_only", isLoaded: true });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const channels = await listMyChannels();
      // If no channel is selected yet, default to the first one (the
      // default `Porch` channel sits first by construction).
      const current = get().selectedChannelId;
      const next = current ?? channels[0]?.id ?? null;
      set({
        channels,
        selectedChannelId: next,
        isLoaded: true,
        isLoading: false,
      });
      if (next && next !== current) {
        await get().refreshMessages();
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        isLoading: false,
      });
    }
  },

  selectChannel: async (channelId: string) => {
    set({ selectedChannelId: channelId, messages: [] });
    await get().refreshMessages();
  },

  refreshMessages: async () => {
    if (!isTauri()) return;
    const id = get().selectedChannelId;
    if (!id) return;
    set({ isLoading: true, error: null });
    try {
      const messages = await getLocalMessages(id, null, MESSAGE_PAGE_SIZE);
      set({ messages, isLoading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        isLoading: false,
      });
    }
  },

  sendMessage: async (body: string) => {
    if (!isTauri()) {
      set({ error: "native_only" });
      return;
    }
    const id = get().selectedChannelId;
    if (!id) {
      set({ error: "no_channel_selected" });
      return;
    }
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      const message = await postLocalMessage(id, trimmed);
      // Append to local state — the backend returns the inserted row
      // so we don't need a follow-up refresh round-trip.
      set((prev) => ({ messages: [...prev.messages, message] }));
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
