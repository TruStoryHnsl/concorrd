import { Avatar } from "../ui/Avatar";
import { FederationBadge } from "../ui/FederationBadge";
import { useDisplayName } from "../../hooks/useDisplayName";
import { useLocalServerName } from "../../hooks/useFederation";
import { useUnreadCounts } from "../../hooks/useUnreadCounts";

interface Props {
  otherUserId: string;
  matrixRoomId: string;
  isActive: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClick: () => void;
}

export function DMListItem({
  otherUserId,
  matrixRoomId,
  isActive,
  pinned = false,
  onTogglePin,
  onClick,
}: Props) {
  const displayName = useDisplayName(otherUserId);
  const localServer = useLocalServerName();
  const unreadCounts = useUnreadCounts();
  const unread = unreadCounts.get(matrixRoomId) ?? 0;

  return (
    <button
      onClick={onClick}
      className={`btn-press w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
        isActive
          ? "bg-primary/10 text-primary"
          : "text-on-surface hover:bg-surface-container-high"
      }`}
    >
      <Avatar userId={otherUserId} size="md" showPresence />
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <span className="truncate font-body text-sm font-medium text-left">
          {displayName}
        </span>
        <FederationBadge userId={otherUserId} localServer={localServer} compact />
      </div>
      {onTogglePin && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
          className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
            pinned
              ? "text-rose-400 hover:bg-rose-500/15"
              : "text-on-surface-variant/60 hover:text-rose-400 hover:bg-surface-container-high"
          }`}
          title={pinned ? "Unpin conversation" : "Pin conversation"}
          aria-label={pinned ? "Unpin conversation" : "Pin conversation"}
        >
          <span
            className="material-symbols-outlined text-base"
            style={pinned ? { fontVariationSettings: '"FILL" 1, "wght" 500, "GRAD" 0, "opsz" 24' } : undefined}
          >
            keep
          </span>
        </button>
      )}
      {unread > 0 && !isActive && (
        <span className="min-w-5 h-5 px-1.5 rounded-full bg-primary text-on-primary text-xs font-bold flex items-center justify-center node-pulse">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
