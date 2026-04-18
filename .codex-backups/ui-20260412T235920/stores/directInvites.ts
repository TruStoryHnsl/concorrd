import { create } from "zustand";
import type { DirectInvite } from "../api/concord";
import { getPendingDirectInvites, respondToDirectInvite } from "../api/concord";
import { useServerStore } from "./server";
import { useToastStore } from "./toast";

interface DirectInviteState {
  pendingInvites: DirectInvite[];
  loadPending: (accessToken: string) => Promise<void>;
  respond: (
    id: number,
    action: "accept" | "decline",
    accessToken: string,
  ) => Promise<void>;
}

export const useDirectInviteStore = create<DirectInviteState>((set) => ({
  pendingInvites: [],

  loadPending: async (accessToken) => {
    try {
      const invites = await getPendingDirectInvites(accessToken);
      set({ pendingInvites: invites });
    } catch {
      // Silent fail — not critical
    }
  },

  respond: async (id, action, accessToken) => {
    try {
      const result = await respondToDirectInvite(id, action, accessToken);
      set((s) => ({
        pendingInvites: s.pendingInvites.filter((i) => i.id !== id),
      }));
      if (action === "accept" && result.server_id) {
        await useServerStore.getState().loadServers(accessToken);
        useServerStore.getState().setActiveServer(result.server_id);
        useToastStore
          .getState()
          .addToast(`Joined ${result.server_name}!`, "success");
      } else if (action === "decline") {
        useToastStore.getState().addToast("Invite declined", "info");
      }
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          err instanceof Error ? err.message : "Failed to respond to invite",
        );
    }
  },
}));
