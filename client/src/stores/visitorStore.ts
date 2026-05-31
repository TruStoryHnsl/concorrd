/**
 * Visitor store — zustand state for "I'm visiting peer X's porch".
 *
 * Wraps the three visit commands in `client/src/api/porch.ts`. Unlike
 * the local `porchStore`, this store works on BOTH native and web —
 * web rides the browser libp2p stack lazily loaded the first time a
 * visit is attempted.
 *
 * Only one peer is "visited" at a time; switching peers clears the
 * channel + message state.
 */

import { create } from "zustand";
import {
  visitGetMessages,
  visitPeer,
  visitPostMessage,
  type ChannelMessage,
  type PorchChannel,
} from "../api/porch";

const MESSAGE_PAGE_SIZE = 200;

export interface VisitorStoreState {
  /** The peer the user is currently visiting, or null. */
  currentPeerId: string | null;
  /** Channels the host has surfaced to this visitor. */
  channels: PorchChannel[];
  /** Channel currently focused inside the visit view. */
  selectedChannelId: string | null;
  /** Messages for the selected channel. */
  messages: ChannelMessage[];
  /** True while a network/IPC request is in flight. */
  isLoading: boolean;
  /** Last error surface, if any. */
  error: string | null;

  /** Open a visit to `peerId`. Loads the channel list and selects
   *  the first channel. */
  openVisit: (peerId: string) => Promise<void>;
  /** Close the visit. Clears all visit state. */
  closeVisit: () => void;
  /** Select a channel and refresh its messages. */
  selectChannel: (channelId: string) => Promise<void>;
  /** Re-fetch messages for the selected channel. */
  refreshMessages: () => Promise<void>;
  /** Post a message to the selected channel on the visited peer. */
  sendMessage: (body: string) => Promise<void>;
}

export const useVisitorStore = create<VisitorStoreState>((set, get) => ({
  currentPeerId: null,
  channels: [],
  selectedChannelId: null,
  messages: [],
  isLoading: false,
  error: null,

  openVisit: async (peerId: string) => {
    set({
      currentPeerId: peerId,
      channels: [],
      selectedChannelId: null,
      messages: [],
      isLoading: true,
      error: null,
    });
    try {
      const channels = await visitPeer(peerId);
      const next = channels[0]?.id ?? null;
      set({
        channels,
        selectedChannelId: next,
        isLoading: false,
      });
      if (next) {
        await get().refreshMessages();
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        isLoading: false,
      });
    }
  },

  closeVisit: () => {
    set({
      currentPeerId: null,
      channels: [],
      selectedChannelId: null,
      messages: [],
      isLoading: false,
      error: null,
    });
  },

  selectChannel: async (channelId: string) => {
    set({ selectedChannelId: channelId, messages: [] });
    await get().refreshMessages();
  },

  refreshMessages: async () => {
    const peer = get().currentPeerId;
    const id = get().selectedChannelId;
    if (!peer || !id) return;
    set({ isLoading: true, error: null });
    try {
      const messages = await visitGetMessages(peer, id, null, MESSAGE_PAGE_SIZE);
      set({ messages, isLoading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        isLoading: false,
      });
    }
  },

  sendMessage: async (body: string) => {
    const peer = get().currentPeerId;
    const id = get().selectedChannelId;
    if (!peer || !id) {
      set({ error: "no_visit_target" });
      return;
    }
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      const message = await visitPostMessage(peer, id, trimmed);
      set((prev) => ({ messages: [...prev.messages, message] }));
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
