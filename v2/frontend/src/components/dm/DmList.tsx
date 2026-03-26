import { Link } from "react-router-dom";
import GlassPanel from "@/components/ui/GlassPanel";
import TrustBadge from "@/components/ui/TrustBadge";
import { useDmStore } from "@/stores/dm";
import type { TrustLevel } from "@/api/tauri";
import { shortenPeerId, formatRelativeTime } from "@/utils/format";

interface DmListProps {
  /** Optional trust data lookup to display badges */
  trustLevels?: Record<string, TrustLevel>;
}

function DmList({ trustLevels }: DmListProps) {
  const conversations = useDmStore((s) => s.conversations);

  if (conversations.length === 0) {
    return (
      <GlassPanel className="p-6 flex flex-col items-center text-center space-y-3">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
          <span className="material-symbols-outlined text-2xl text-primary/40">
            chat_bubble_outline
          </span>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-label font-medium text-on-surface">
            No conversations yet
          </p>
          <p className="text-xs text-on-surface-variant font-body">
            Start a conversation from the Friends page.
          </p>
        </div>
      </GlassPanel>
    );
  }

  return (
    <div className="space-y-1">
      {conversations.map((conv) => {
        const displayName =
          conv.displayName ?? shortenPeerId(conv.peerId);
        const lastMsg = conv.lastMessage;
        const trustLevel = trustLevels?.[conv.peerId];

        return (
          <Link
            key={conv.peerId}
            to={`/dm/${conv.peerId}`}
            className="block"
          >
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-container-high/50 transition-colors">
              {/* Avatar */}
              <div className="relative shrink-0">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10">
                  <span className="material-symbols-outlined text-primary text-lg">
                    person
                  </span>
                </div>
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-label font-medium text-on-surface truncate">
                    {displayName}
                  </p>
                  {trustLevel && (
                    <TrustBadge
                      level={trustLevel}
                      size="sm"
                      showLabel={false}
                    />
                  )}
                </div>
                {lastMsg && (
                  <p className="text-[11px] text-on-surface-variant font-body truncate">
                    {lastMsg.content}
                  </p>
                )}
              </div>

              {/* Right side */}
              <div className="flex flex-col items-end gap-1 shrink-0">
                {lastMsg && (
                  <span className="text-[10px] text-on-surface-variant font-body">
                    {formatRelativeTime(lastMsg.timestamp)}
                  </span>
                )}
                {conv.unreadCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-on-primary text-[10px] font-label font-semibold">
                    {conv.unreadCount}
                  </span>
                )}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export default DmList;
