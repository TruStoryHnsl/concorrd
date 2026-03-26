import { create } from "zustand";
import type {
  Message,
  ServerPayload,
  ChannelPayload,
  MemberPayload,
} from "@/api/tauri";
import {
  getServers,
  getChannels,
  getMessages,
  getServerMembers,
  subscribeChannel,
} from "@/api/tauri";

/** The channel ID for the global mesh chat. Used in send_message/get_messages. */
export const MESH_GENERAL_CHANNEL = "general";
/** The full GossipSub topic for subscribe calls. */
export const MESH_GENERAL_TOPIC = "concord/mesh/general";

interface ServersState {
  /* Server list */
  servers: ServerPayload[];
  activeServerId: string | null;
  activeChannelId: string | null;

  /* Channel & member data for active server */
  channels: ChannelPayload[];
  members: MemberPayload[];

  /* Messages for active channel */
  messages: Message[];

  /* Loading states */
  loadingServers: boolean;
  loadingChannels: boolean;
  loadingMessages: boolean;

  /* Actions — servers */
  loadServers: () => Promise<void>;
  selectServer: (id: string) => Promise<void>;
  selectChannel: (id: string) => Promise<void>;
  addServer: (server: ServerPayload) => void;
  removeServer: (id: string) => void;

  /* Actions — messages */
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;

  /* Actions — direct setters */
  setChannels: (channels: ChannelPayload[]) => void;
  setMembers: (members: MemberPayload[]) => void;
  clearActiveServer: () => void;
}

export const useServersStore = create<ServersState>((set, get) => ({
  servers: [],
  activeServerId: null,
  activeChannelId: null,
  channels: [],
  members: [],
  messages: [],
  loadingServers: false,
  loadingChannels: false,
  loadingMessages: false,

  /* ── Server list ──────────────────────────────────────── */

  loadServers: async () => {
    set({ loadingServers: true });
    try {
      const servers = await getServers();
      set({ servers, loadingServers: false });
    } catch (err) {
      console.warn("Failed to load servers:", err);
      set({ loadingServers: false });
    }
  },

  addServer: (server) =>
    set((state) => {
      const exists = state.servers.some((s) => s.id === server.id);
      if (exists) return state;
      return { servers: [...state.servers, server] };
    }),

  removeServer: (id) =>
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== id),
      ...(state.activeServerId === id
        ? {
            activeServerId: null,
            activeChannelId: null,
            channels: [],
            members: [],
            messages: [],
          }
        : {}),
    })),

  /* ── Select server → load channels + members ──────────── */

  selectServer: async (id) => {
    set({
      activeServerId: id,
      activeChannelId: null,
      channels: [],
      members: [],
      messages: [],
      loadingChannels: true,
    });

    try {
      const [channels, members] = await Promise.all([
        getChannels(id),
        getServerMembers(id),
      ]);
      set({ channels, members, loadingChannels: false });

      // Auto-select the first text channel
      const firstText = channels.find((c) => c.channelType === "text");
      if (firstText) {
        await get().selectChannel(firstText.id);
      }
    } catch (err) {
      console.warn("Failed to load server data:", err);
      set({ loadingChannels: false });
    }
  },

  /* ── Select channel → load messages + subscribe ─────── */

  selectChannel: async (id) => {
    set({ activeChannelId: id, messages: [], loadingMessages: true });
    try {
      const [msgs] = await Promise.all([
        getMessages(id, 50),
        subscribeChannel(id),
      ]);
      set({ messages: msgs, loadingMessages: false });
    } catch (err) {
      console.warn("Failed to load channel messages:", err);
      set({ loadingMessages: false });
    }
  },

  /* ── Messages ─────────────────────────────────────────── */

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((state) => {
      // Only add if it belongs to the active channel
      if (state.activeChannelId && message.channelId !== state.activeChannelId) {
        // Not the active channel — could show notification in the future
        return state;
      }
      // Avoid duplicates by id
      if (state.messages.some((m) => m.id === message.id)) {
        return state;
      }
      return { messages: [...state.messages, message] };
    }),

  /* ── Direct setters ───────────────────────────────────── */

  setChannels: (channels) => set({ channels }),
  setMembers: (members) => set({ members }),
  clearActiveServer: () =>
    set({
      activeServerId: null,
      activeChannelId: null,
      channels: [],
      members: [],
      messages: [],
    }),
}));
