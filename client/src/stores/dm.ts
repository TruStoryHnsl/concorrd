import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DMConversation } from "../api/concord";
import { listDMs, createDM as apiCreateDM } from "../api/concord";
import { useToastStore } from "./toast";

interface DMState {
  conversations: DMConversation[];
  activeDMRoomId: string | null;
  dmActive: boolean; // true = DM context, false = server context
  pinnedRoomIds: string[];

  loadConversations: (accessToken: string) => Promise<void>;
  startDM: (targetUserId: string, accessToken: string) => Promise<string>; // returns roomId
  setActiveDM: (roomId: string | null) => void;
  setDMActive: (active: boolean) => void;
  togglePinnedRoom: (roomId: string) => void;

  activeConversation: () => DMConversation | undefined;
}

export const useDMStore = create<DMState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeDMRoomId: null,
      dmActive: false,
      pinnedRoomIds: [],

      loadConversations: async (accessToken) => {
        try {
          const conversations = await listDMs(accessToken);
          set((state) => ({
            conversations,
            pinnedRoomIds: state.pinnedRoomIds.filter((roomId) =>
              conversations.some((conversation) => conversation.matrix_room_id === roomId),
            ),
          }));
        } catch (err) {
          useToastStore.getState().addToast(
            err instanceof Error ? err.message : "Failed to load DMs",
          );
        }
      },

      startDM: async (targetUserId, accessToken) => {
        const result = await apiCreateDM(targetUserId, accessToken);

        if (result.created) {
          // Append to conversations list
          set((s) => ({
            conversations: [
              {
                id: result.id,
                other_user_id: result.target_user_id,
                matrix_room_id: result.matrix_room_id,
                created_at: new Date().toISOString(),
              },
              ...s.conversations,
            ],
          }));
        }

        set({
          activeDMRoomId: result.matrix_room_id,
          dmActive: true,
        });

        return result.matrix_room_id;
      },

      setActiveDM: (roomId) => {
        set({ activeDMRoomId: roomId });
      },

      setDMActive: (active) => {
        set({ dmActive: active });
        if (!active) {
          set({ activeDMRoomId: null });
        }
      },

      togglePinnedRoom: (roomId) => {
        set((state) => ({
          pinnedRoomIds: state.pinnedRoomIds.includes(roomId)
            ? state.pinnedRoomIds.filter((id) => id !== roomId)
            : [...state.pinnedRoomIds, roomId],
        }));
      },

      activeConversation: () => {
        const { conversations, activeDMRoomId } = get();
        return conversations.find((c) => c.matrix_room_id === activeDMRoomId);
      },
    }),
    {
      name: "concord_dm_state",
      partialize: (state) => ({
        pinnedRoomIds: state.pinnedRoomIds,
      }),
    },
  ),
);
