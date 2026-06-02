import { memo, useState, useEffect } from "react";
import { useDMStore } from "../../stores/dm";
import { useAuthStore } from "../../stores/auth";
import { DMListItem } from "./DMListItem";
import { NewDMModal } from "./NewDMModal";

interface DMSidebarProps {
  mobile?: boolean;
  onDMSelect?: (roomId: string) => void;
}

export const DMSidebar = memo(function DMSidebar({ mobile, onDMSelect }: DMSidebarProps) {
  const conversations = useDMStore((s) => s.conversations);
  const activeDMRoomId = useDMStore((s) => s.activeDMRoomId);
  const setActiveDM = useDMStore((s) => s.setActiveDM);
  const loadConversations = useDMStore((s) => s.loadConversations);
  const pinnedRoomIds = useDMStore((s) => s.pinnedRoomIds);
  const togglePinnedRoom = useDMStore((s) => s.togglePinnedRoom);
  const accessToken = useAuthStore((s) => s.accessToken);

  const [showNewDM, setShowNewDM] = useState(false);

  useEffect(() => {
    if (accessToken) {
      loadConversations(accessToken);
    }
  }, [accessToken, loadConversations]);

  const handleSelect = (roomId: string) => {
    setActiveDM(roomId);
    onDMSelect?.(roomId);
  };

  return (
    <div className="w-full h-full flex flex-col min-h-0 bg-surface-container-low">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
        <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest">
          Direct Messages
        </h3>
        <button
          onClick={() => setShowNewDM(true)}
          className="w-6 h-6 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          title="New Message"
        >
          <span className="material-symbols-outlined text-lg">edit_square</span>
        </button>
      </div>

      {/* Conversation list */}
      <div className={`flex-1 overflow-y-auto ${mobile ? "p-3" : "p-2"}`}>
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 gap-2">
            <span className="material-symbols-outlined text-3xl text-on-surface-variant/40">
              chat_bubble
            </span>
            <p className="text-on-surface-variant text-sm text-center font-body">
              No conversations yet
            </p>
            <button
              onClick={() => setShowNewDM(true)}
              className="text-xs text-primary hover:text-primary/80 font-label transition-colors"
            >
              Start a conversation
            </button>
          </div>
        ) : (
          <div className="space-y-0.5">
            {conversations.map((dm) => (
              <DMListItem
                key={dm.id}
                otherUserId={dm.other_user_id}
                matrixRoomId={dm.matrix_room_id}
                isActive={activeDMRoomId === dm.matrix_room_id}
                pinned={pinnedRoomIds.includes(dm.matrix_room_id)}
                onTogglePin={() => togglePinnedRoom(dm.matrix_room_id)}
                onClick={() => handleSelect(dm.matrix_room_id)}
              />
            ))}
          </div>
        )}
      </div>

      {showNewDM && <NewDMModal onClose={() => setShowNewDM(false)} />}
    </div>
  );
});
