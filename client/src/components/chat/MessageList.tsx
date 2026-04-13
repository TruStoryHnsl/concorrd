import { memo, useEffect, useRef, useCallback, useState, type ReactNode } from "react";
import type { ChatMessage } from "../../hooks/useMatrix";
import { Avatar } from "../ui/Avatar";
import { FederationBadge } from "../ui/FederationBadge";
import { MessageContent } from "./MessageContent";
import { ReactionPills, QuickReactBar } from "./ReactionBar";
import { useDisplayName } from "../../hooks/useDisplayName";
import { useLocalServerName } from "../../hooks/useFederation";

interface MessageListProps {
  messages: ChatMessage[];
  isPaginating: boolean;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  currentUserId: string | null;
  isServerOwner: boolean;
  onDelete: (eventId: string) => Promise<void>;
  onStartEdit: (message: ChatMessage) => void;
  onReact: (eventId: string, emoji: string) => Promise<void>;
  onRemoveReaction: (reactionEventId: string) => Promise<void>;
  emptyState?: ReactNode;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDate.getTime() === today.getTime()) return "Today";
  if (msgDate.getTime() === yesterday.getTime()) return "Yesterday";
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function SenderName({ userId }: { userId: string }) {
  const name = useDisplayName(userId);
  return <>{name}</>;
}

function isSameDay(ts1: number, ts2: number): boolean {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

export const MessageList = memo(function MessageList({
  messages,
  isPaginating,
  hasMore,
  onLoadMore,
  currentUserId,
  isServerOwner,
  onDelete,
  onStartEdit,
  onReact,
  onRemoveReaction,
  emptyState,
}: MessageListProps) {
  const localServer = useLocalServerName();
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const prevLastMsgIdRef = useRef<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [reactingId, setReactingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Track whether user is at/near bottom
  const bottomObserverCallback = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      isAtBottomRef.current = entries[0]?.isIntersecting ?? false;
    },
    [],
  );

  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(bottomObserverCallback, {
      threshold: 0,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [bottomObserverCallback]);

  // Single scroll effect: pagination-restore takes priority, then auto-scroll-to-bottom.
  // Locally-authored sends always force scroll, even if the user was scrolled up.
  useEffect(() => {
    const container = containerRef.current;
    const lastMsg = messages[messages.length - 1];
    const lastMsgId = lastMsg?.id ?? null;
    const lastMsgIsNew =
      lastMsgId !== null && lastMsgId !== prevLastMsgIdRef.current;
    const localSend =
      lastMsgIsNew &&
      currentUserId !== null &&
      lastMsg?.sender === currentUserId;

    if (prevScrollHeightRef.current !== 0 && container) {
      const diff = container.scrollHeight - prevScrollHeightRef.current;
      if (diff > 0) container.scrollTop += diff;
      prevScrollHeightRef.current = 0;
    } else if (localSend) {
      // INS-013: the user just sent a message — always surface it, even if
      // they were scrolled up reading history.
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      isAtBottomRef.current = true;
    } else if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }

    prevLastMsgIdRef.current = lastMsgId;
  }, [messages, currentUserId]);

  // Top sentinel — triggers scrollback pagination
  useEffect(() => {
    const el = topRef.current;
    const container = containerRef.current;
    if (!el || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isPaginating) {
          prevScrollHeightRef.current = container.scrollHeight;
          onLoadMore();
        }
      },
      { root: container, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isPaginating, onLoadMore]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant font-body">
        {emptyState ?? "No messages yet. Say something!"}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-4 space-y-1 selectable">
      {/* Top sentinel for scrollback */}
      <div ref={topRef} className="h-1" />
      {isPaginating && (
        <div className="flex justify-center py-2">
          <span className="inline-block w-4 h-4 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
        </div>
      )}

      {messages.map((msg, i) => {
        const prevMsg = messages[i - 1];
        const showHeader =
          !prevMsg ||
          prevMsg.sender !== msg.sender ||
          msg.timestamp - prevMsg.timestamp > 5 * 60 * 1000;

        const showDateSeparator =
          !prevMsg || !isSameDay(prevMsg.timestamp, msg.timestamp);

        const isHovered = hoveredId === msg.id;
        const isReacting = reactingId === msg.id;
        const canEdit =
          msg.sender === currentUserId && !msg.redacted && msg.msgtype === "m.text";
        const canDelete =
          !msg.redacted &&
          (msg.sender === currentUserId || isServerOwner);
        const showActions = (isHovered || isReacting) && !msg.redacted;

        return (
          <div
            key={msg.id}
            className="group relative"
            onMouseEnter={() => setHoveredId(msg.id)}
            onMouseLeave={() => {
              setHoveredId(null);
              if (confirmDeleteId === msg.id) setConfirmDeleteId(null);
            }}
          >
            {showDateSeparator && (
              <div className="flex items-center gap-3 py-2 mt-2">
                <div className="flex-1 h-px bg-outline-variant/15" />
                <span className="text-[10px] text-on-surface-variant font-label font-medium tracking-wider uppercase">
                  {formatDate(msg.timestamp)}
                </span>
                <div className="flex-1 h-px bg-outline-variant/15" />
              </div>
            )}

            {/* Hover action bar */}
            {showActions && (
              <div className="absolute -top-3 right-2 z-10 flex gap-0.5 glass-panel rounded-xl p-0.5">
                <button
                  onClick={() => setReactingId(reactingId === msg.id ? null : msg.id)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface"
                  title="React"
                >
                  <span className="material-symbols-outlined text-base">add_reaction</span>
                </button>

                {canEdit && (
                  <button
                    onClick={() => onStartEdit(msg)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface"
                    title="Edit"
                  >
                    <span className="material-symbols-outlined text-base">edit</span>
                  </button>
                )}

                {canDelete && (
                  confirmDeleteId === msg.id ? (
                    <button
                      onClick={() => { onDelete(msg.id); setConfirmDeleteId(null); }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg bg-error/20 text-error animate-pulse text-xs font-bold"
                      title="Click to confirm"
                    >
                      ?
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(msg.id)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-error"
                      title="Delete"
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  )
                )}
              </div>
            )}

            {/* Quick react popover */}
            {isReacting && (
              <div className="absolute -top-10 right-2 z-20">
                <QuickReactBar
                  onReact={(emoji) => {
                    onReact(msg.id, emoji);
                    setReactingId(null);
                  }}
                  onClose={() => setReactingId(null)}
                />
              </div>
            )}

            <div className={showHeader && !showDateSeparator ? "pt-3" : ""}>
              {showHeader ? (
                <div className="flex gap-2">
                  <Avatar userId={msg.sender} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-headline font-semibold text-primary">
                        <SenderName userId={msg.sender} />
                      </span>
                      <FederationBadge userId={msg.sender} localServer={localServer} />
                      <span className="text-[10px] text-on-surface-variant font-label">
                        {formatTime(msg.timestamp)}
                      </span>
                      {msg.edited && (
                        <span className="text-[10px] text-on-surface-variant/50 font-label">(edited)</span>
                      )}
                    </div>
                    <MessageContent message={msg} />
                    <ReactionPills
                      reactions={msg.reactions}
                      currentUserId={currentUserId}
                      onReact={(emoji) => onReact(msg.id, emoji)}
                      onRemoveReaction={onRemoveReaction}
                    />
                  </div>
                </div>
              ) : (
                <div className="pl-10">
                  <MessageContent message={msg} />
                  {msg.edited && (
                    <span className="text-[10px] text-on-surface-variant/50 font-label ml-1">(edited)</span>
                  )}
                  <ReactionPills
                    reactions={msg.reactions}
                    currentUserId={currentUserId}
                    onReact={(emoji) => onReact(msg.id, emoji)}
                    onRemoveReaction={onRemoveReaction}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
});
