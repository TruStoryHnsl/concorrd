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
  porchVisitKnock,
  porchVisitKnockStatus,
  porchVisitWithdrawKnock,
  visitGetMessages,
  visitPeer,
  visitPostMessage,
  type ChannelMessage,
  type Knock,
  type PorchChannel,
  type PorchListChannelRow,
} from "../api/porch";

const MESSAGE_PAGE_SIZE = 200;

export interface VisitorStoreState {
  /** The peer the user is currently visiting, or null. */
  currentPeerId: string | null;
  /** Channels the host has surfaced to this visitor, flattened to
   *  `PorchChannel` shape for backward compatibility with the
   *  `PorchView` `CommonStore` interface. */
  channels: PorchChannel[];
  /** Phase B — full row data including per-channel visibility so the
   *  UI can render Knock affordances. Indexed by `channel.id`. */
  rows: PorchListChannelRow[];
  /** Channel currently focused inside the visit view. */
  selectedChannelId: string | null;
  /** Messages for the selected channel. */
  messages: ChannelMessage[];
  /** True while a network/IPC request is in flight. */
  isLoading: boolean;
  /** Last error surface, if any. */
  error: string | null;

  /** Open a visit to `peerId`. Loads the channel list and selects
   *  the first VISIBLE channel (gated channels can't be entered). */
  openVisit: (peerId: string) => Promise<void>;
  /** Close the visit. Clears all visit state. */
  closeVisit: () => void;
  /** Select a channel and refresh its messages. */
  selectChannel: (channelId: string) => Promise<void>;
  /** Re-fetch messages for the selected channel. */
  refreshMessages: () => Promise<void>;
  /** Post a message to the selected channel on the visited peer. */
  sendMessage: (body: string) => Promise<void>;

  // Phase B — knock-to-enter
  /** File a knock on a gated channel. Returns the resulting Knock. */
  knockOn: (channelId: string, message: string | null) => Promise<Knock | null>;
  /** Withdraw a previously-filed knock. */
  withdrawKnock: (knockId: string) => Promise<void>;
  /** Re-poll knock status for one row + update local state. */
  refreshKnockStatus: (channelId: string) => Promise<void>;
  /** Re-fetch the channel list (use after accept on the host side, or
   *  to refresh visibility after a knock). */
  refreshChannels: () => Promise<void>;
}

function rowToChannel(r: PorchListChannelRow): PorchChannel {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    acl_mode: r.acl_mode,
    created_at: r.created_at,
  };
}

export const useVisitorStore = create<VisitorStoreState>((set, get) => ({
  currentPeerId: null,
  channels: [],
  rows: [],
  selectedChannelId: null,
  messages: [],
  isLoading: false,
  error: null,

  openVisit: async (peerId: string) => {
    set({
      currentPeerId: peerId,
      channels: [],
      rows: [],
      selectedChannelId: null,
      messages: [],
      isLoading: true,
      error: null,
    });
    try {
      const rows = await visitPeer(peerId);
      const channels = rows.map(rowToChannel);
      // Default-select the first VISIBLE channel — gated channels
      // can't be entered, so picking the first row blindly would
      // leave the user staring at an "access denied" surface.
      const firstVisible = rows.find((r) => r.visibility.kind === "visible");
      const next = firstVisible?.id ?? null;
      set({
        channels,
        rows,
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
      rows: [],
      selectedChannelId: null,
      messages: [],
      isLoading: false,
      error: null,
    });
  },

  selectChannel: async (channelId: string) => {
    // Phase B: refuse to "enter" a gated channel from the channel
    // list — the UI is expected to render a Knock button instead.
    const row = get().rows.find((r) => r.id === channelId);
    if (row && row.visibility.kind !== "visible") {
      set({ error: "channel_gated" });
      return;
    }
    set({ selectedChannelId: channelId, messages: [], error: null });
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

  knockOn: async (channelId: string, message: string | null) => {
    const peer = get().currentPeerId;
    if (!peer) {
      set({ error: "no_visit_target" });
      return null;
    }
    try {
      const knock = await porchVisitKnock(peer, channelId, message);
      // Update the per-row visibility locally so the UI flips to
      // "Waiting on host" without needing a refresh round-trip.
      set((prev) => ({
        rows: prev.rows.map((r) =>
          r.id === channelId
            ? {
                ...r,
                visibility: {
                  kind: "needs_knock",
                  existing_knock: knock.status,
                },
              }
            : r,
        ),
      }));
      return knock;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  withdrawKnock: async (knockId: string) => {
    const peer = get().currentPeerId;
    if (!peer) {
      set({ error: "no_visit_target" });
      return;
    }
    try {
      const withdrawn = await porchVisitWithdrawKnock(peer, knockId);
      set((prev) => ({
        rows: prev.rows.map((r) =>
          r.id === withdrawn.channel_id
            ? {
                ...r,
                visibility: {
                  kind: "needs_knock",
                  existing_knock: withdrawn.status,
                },
              }
            : r,
        ),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshKnockStatus: async (channelId: string) => {
    const peer = get().currentPeerId;
    if (!peer) return;
    try {
      const status = await porchVisitKnockStatus(peer, channelId);
      set((prev) => ({
        rows: prev.rows.map((r) =>
          r.id === channelId
            ? {
                ...r,
                visibility: status?.status === "accepted"
                  ? { kind: "visible" }
                  : {
                      kind: "needs_knock",
                      existing_knock: status?.status ?? null,
                    },
              }
            : r,
        ),
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshChannels: async () => {
    const peer = get().currentPeerId;
    if (!peer) return;
    try {
      const rows = await visitPeer(peer);
      const channels = rows.map(rowToChannel);
      set({ rows, channels });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
