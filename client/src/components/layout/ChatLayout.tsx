import { useEffect, useState, useMemo, useCallback, useRef, Component, type ReactNode } from "react";
import {
  useMatrixSync,
  useRoomMessages,
  useSendMessage,
  useDeleteMessage,
  useEditMessage,
  useSendFile,
  useSendReaction,
  useRemoveReaction,
} from "../../hooks/useMatrix";
import type { ChatMessage } from "../../hooks/useMatrix";
import { useTypingUsers, useSendTyping } from "../../hooks/useTyping";
import { useAuthStore } from "../../stores/auth";
import { useServerStore } from "../../stores/server";
import { useSendReadReceipt } from "../../hooks/useUnreadCounts";
import { useNotifications } from "../../hooks/useNotifications";
import { useSettingsStore } from "../../stores/settings";
import { useDMStore } from "../../stores/dm";
import { useDisplayName } from "../../hooks/useDisplayName";
import { ServerSidebar } from "./ServerSidebar";
import { ChannelSidebar } from "./ChannelSidebar";
import { DMSidebar } from "../dm/DMSidebar";
import { MessageList } from "../chat/MessageList";
import { MessageInput } from "../chat/MessageInput";
import { TypingIndicator } from "../chat/TypingIndicator";
import { VoiceChannel } from "../voice/VoiceChannel";
import { SettingsPanel } from "../settings/SettingsModal";
import { ServerSettingsPanel } from "../settings/ServerSettingsModal";
import { BugReportModal } from "../BugReportModal";
import { StatsModal } from "../StatsModal";

/** Lightweight error boundary that silently recovers instead of hiding content. */
class SilentBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { ok: boolean }> {
  state = { ok: true };
  static getDerivedStateFromError() { return { ok: false }; }
  componentDidCatch(err: Error) {
    console.warn("SilentBoundary caught:", err.message);
    setTimeout(() => this.setState({ ok: true }), 100);
  }
  render() {
    return this.state.ok ? this.props.children : (this.props.fallback ?? null);
  }
}

type MobileView = "servers" | "channels" | "chat" | "dms" | "settings";

export function ChatLayout() {
  const syncing = useMatrixSync();
  const client = useAuthStore((s) => s.client);
  const userId = useAuthStore((s) => s.userId);
  const accessToken = useAuthStore((s) => s.accessToken);
  const loadServers = useServerStore((s) => s.loadServers);
  const activeChannelId = useServerStore((s) => s.activeChannelId);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);

  // DM state
  const dmActive = useDMStore((s) => s.dmActive);
  const activeDMRoomId = useDMStore((s) => s.activeDMRoomId);
  const dmConversation = useDMStore((s) => s.activeConversation)();
  const loadConversations = useDMStore((s) => s.loadConversations);

  // The active room — either a server channel or a DM room
  const activeRoomId = dmActive ? activeDMRoomId : activeChannelId;

  const { messages, isPaginating, hasMore, loadMore } = useRoomMessages(activeRoomId);
  const sendMessage = useSendMessage(activeRoomId);
  const deleteMessage = useDeleteMessage(activeRoomId);
  const editMessage = useEditMessage(activeRoomId);
  const { sendFile, uploading } = useSendFile(activeRoomId);
  const sendReaction = useSendReaction(activeRoomId);
  const removeReaction = useRemoveReaction(activeRoomId);
  const typingUsers = useTypingUsers(activeRoomId);
  const { onKeystroke, onStopTyping } = useSendTyping(activeRoomId);
  useSendReadReceipt(activeRoomId);
  useNotifications();

  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Mobile view state — replaces the old drawer system
  const [mobileView, setMobileView] = useState<MobileView>("chat");
  // Mobile account sheet (T003)
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);

  // Resizable channel sidebar (desktop only)
  const SIDEBAR_MIN = 160;
  const SIDEBAR_MAX = 400;
  const SIDEBAR_DEFAULT = 224;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem("concord_sidebar_width");
      if (saved) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(saved)));
    } catch {}
    return SIDEBAR_DEFAULT;
  });
  const isDragging = useRef(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem("concord_sidebar_width", String(sidebarWidth)); } catch {}
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  useEffect(() => {
    try { localStorage.setItem("concord_sidebar_width", String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);

  useEffect(() => { setEditingMessage(null); }, [activeRoomId]);

  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId),
    [servers, activeServerId],
  );
  const activeChannel = useMemo(
    () => activeServer?.channels.find((c) => c.matrix_room_id === activeChannelId),
    [activeServer, activeChannelId],
  );
  const isVoiceChannel = activeChannel?.channel_type === "voice";
  const isOwner = activeServer?.owner_id === userId;
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const serverSettingsId = useSettingsStore((s) => s.serverSettingsId);
  const closeServerSettings = useSettingsStore((s) => s.closeServerSettings);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const memberCount = useMemo(() => {
    if (!client || !activeRoomId) return 0;
    const room = client.getRoom(activeRoomId);
    if (!room) return 0;
    return room.getJoinedMemberCount();
  }, [client, activeRoomId, syncing]);

  const loadMembers = useServerStore((s) => s.loadMembers);
  const [serversLoaded, setServersLoaded] = useState(false);

  useEffect(() => {
    if (accessToken && syncing && !serversLoaded) {
      loadServers(accessToken).then(() => setServersLoaded(true));
      loadConversations(accessToken);
    }
  }, [accessToken, syncing, serversLoaded, loadServers, loadConversations]);

  useEffect(() => {
    if (accessToken && activeServerId) {
      loadMembers(activeServerId, accessToken);
    }
  }, [accessToken, activeServerId, loadMembers]);

  // When selecting a channel on mobile, auto-switch to chat view
  const origSetActiveChannel = useServerStore((s) => s.setActiveChannel);
  const handleMobileChannelSelect = useCallback((roomId: string) => {
    origSetActiveChannel(roomId);
    setMobileView("chat");
  }, [origSetActiveChannel]);

  // When selecting a DM on mobile, switch to chat view
  const setActiveDM = useDMStore((s) => s.setActiveDM);
  const handleMobileDMSelect = useCallback((roomId: string) => {
    setActiveDM(roomId);
    setMobileView("chat");
  }, [setActiveDM]);

  // When app settings or server settings is opened, switch to the mobile
  // settings view. Without the serverSettingsId branch, tapping the gear
  // icon in ChannelSidebar's server header on mobile would silently update
  // the store but leave mobileView on "channels", so nothing visible would
  // happen and server owners on mobile had no path to manage their server.
  useEffect(() => {
    if (settingsOpen || serverSettingsId) setMobileView("settings");
  }, [settingsOpen, serverSettingsId]);

  // Desktop layout
  const renderDesktopLayout = () => (
    <div className="h-full flex overflow-hidden bg-surface text-on-surface">
      {/* Server sidebar */}
      <SilentBoundary>
        <ServerSidebar />
      </SilentBoundary>

      {/* Channel / DM sidebar */}
      <div className="flex min-h-0" style={{ width: sidebarWidth, minWidth: SIDEBAR_MIN, maxWidth: SIDEBAR_MAX }}>
        <SilentBoundary>
          {dmActive ? <DMSidebar /> : <ChannelSidebar />}
        </SilentBoundary>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0"
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {renderMainContent()}
      </div>
    </div>
  );

  // Mobile layout with bottom nav
  const renderMobileLayout = () => (
    <div className="h-full flex flex-col overflow-hidden bg-surface text-on-surface min-h-0">
      {/* Top bar */}
      <div className="h-12 flex items-center px-3 bg-surface-container-low safe-top flex-shrink-0 gap-2">
        <div className="flex-1 min-w-0 flex items-center">
        {mobileView === "chat" && dmActive && dmConversation ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => setMobileView("dms")}
              className="text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined text-xl">arrow_back</span>
            </button>
            <span className="material-symbols-outlined text-on-surface-variant text-base">chat_bubble</span>
            <DMHeaderName userId={dmConversation.other_user_id} />
          </div>
        ) : mobileView === "chat" && activeChannel ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => setMobileView("channels")}
              className="text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined text-xl">arrow_back</span>
            </button>
            <h2 className="font-headline font-semibold truncate text-on-surface">
              {isVoiceChannel ? (
                <span className="material-symbols-outlined text-base align-middle mr-1">volume_up</span>
              ) : (
                <span className="text-on-surface-variant mr-1">#</span>
              )}
              {activeChannel.name}
            </h2>
            {memberCount > 0 && (
              <span className="text-xs text-on-surface-variant font-label">
                {memberCount}
              </span>
            )}
          </div>
        ) : mobileView === "dms" ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h2 className="font-headline font-bold text-lg text-primary">Messages</h2>
          </div>
        ) : mobileView === "channels" && activeServer ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => setMobileView("servers")}
              className="text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined text-xl">arrow_back</span>
            </button>
            <h2 className="font-headline font-semibold truncate">{activeServer.name}</h2>
          </div>
        ) : mobileView === "settings" ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => { closeSettings(); closeServerSettings(); setMobileView("chat"); }}
              className="text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined text-xl">arrow_back</span>
            </button>
            <h2 className="font-headline font-semibold">Settings</h2>
          </div>
        ) : (
          <h2 className="font-headline font-bold text-lg text-primary">Concord</h2>
        )}
        </div>
        {/* T003: Account button — visible on every mobile view */}
        <button
          onClick={() => setAccountSheetOpen(true)}
          aria-label="Account"
          className="btn-press flex items-center justify-center w-11 h-11 -mr-2 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
          title="Account"
        >
          <span className="material-symbols-outlined text-xl">account_circle</span>
        </button>
      </div>

      {/* Main content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {mobileView === "servers" && (
          <SilentBoundary>
            <ServerSidebar mobile onServerSelect={() => setMobileView("channels")} />
          </SilentBoundary>
        )}
        {mobileView === "channels" && (
          <SilentBoundary>
            <ChannelSidebar mobile onChannelSelect={handleMobileChannelSelect} />
          </SilentBoundary>
        )}
        {mobileView === "dms" && (
          <SilentBoundary>
            <DMSidebar mobile onDMSelect={handleMobileDMSelect} />
          </SilentBoundary>
        )}
        {mobileView === "settings" && (
          // Both SettingsPanel and ServerSettingsPanel use `flex-1 flex flex-col min-h-0`
          // as their outer wrapper, which only behaves correctly inside a flex container.
          // The parent on line 300 is a block div, so we need an explicit flex shell here
          // (mirrors the chat branch a few lines below). Without this wrapper, the inner
          // tab-content `flex-1 overflow-y-auto` collapses to zero height and the panel
          // becomes unscrollable on mobile.
          <div className="h-full flex flex-col min-h-0">
            {settingsOpen ? (
              <SettingsPanel />
            ) : serverSettingsId ? (
              <ServerSettingsPanel serverId={serverSettingsId} />
            ) : (
              <SettingsPanel />
            )}
          </div>
        )}
        {mobileView === "chat" && (
          <div className="h-full flex flex-col min-h-0">
            {renderChatContent()}
          </div>
        )}
      </div>

      {/* Bottom navigation */}
      <BottomNav
        active={mobileView}
        onChange={(view) => {
          if (view === "dms") {
            useDMStore.getState().setDMActive(true);
          } else if (view === "servers" || view === "channels" || view === "chat") {
            useDMStore.getState().setDMActive(false);
          }
          setMobileView(view);
        }}
        onSettingsOpen={openSettings}
      />
    </div>
  );

  // Shared main content renderer (desktop)
  const renderMainContent = () => {
    if (settingsOpen) {
      return (
        <>
          <div className="h-12 flex items-center px-4 justify-between bg-surface-container-low flex-shrink-0">
            <h2 className="font-headline font-semibold">Settings</h2>
            <button
              onClick={closeSettings}
              className="text-sm text-on-surface-variant hover:text-on-surface transition-colors font-label"
            >
              Back
            </button>
          </div>
          <SettingsPanel />
        </>
      );
    }

    if (serverSettingsId) {
      return (
        <>
          <div className="h-12 flex items-center px-4 justify-between bg-surface-container-low flex-shrink-0">
            <h2 className="font-headline font-semibold">
              {servers.find((s) => s.id === serverSettingsId)?.name ?? "Server"} — Settings
            </h2>
            <button
              onClick={closeServerSettings}
              className="text-sm text-on-surface-variant hover:text-on-surface transition-colors font-label"
            >
              Back
            </button>
          </div>
          <ServerSettingsPanel serverId={serverSettingsId} />
        </>
      );
    }

    return (
      <>
        {/* Channel / DM header */}
        <div className="h-12 flex items-center px-4 bg-surface-container-low flex-shrink-0">
          {dmActive && dmConversation ? (
            <div className="flex items-center gap-3 min-w-0">
              <span className="material-symbols-outlined text-on-surface-variant text-base">chat_bubble</span>
              <DMHeaderName userId={dmConversation.other_user_id} />
            </div>
          ) : activeChannel ? (
            <div className="flex items-center gap-3 min-w-0">
              <h2 className="font-headline font-semibold truncate">
                {isVoiceChannel ? (
                  <span className="material-symbols-outlined text-base align-middle mr-1">volume_up</span>
                ) : (
                  <span className="text-on-surface-variant mr-1">#</span>
                )}
                {activeChannel.name}
              </h2>
              {memberCount > 0 && (
                <span className="text-xs text-on-surface-variant font-label">
                  {memberCount} {memberCount === 1 ? "member" : "members"}
                </span>
              )}
            </div>
          ) : (
            <span className="text-on-surface-variant font-body">
              {!syncing || !serversLoaded ? (
                <span className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-on-surface-variant border-t-primary rounded-full animate-spin" />
                  {!syncing ? "Connecting..." : "Loading servers..."}
                </span>
              ) : servers.length === 0 ? (
                "Welcome — join or create a server to get started"
              ) : (
                "Select a channel"
              )}
            </span>
          )}
        </div>

        {renderChatContent()}
      </>
    );
  };

  // Shared chat/voice content
  const renderChatContent = () => {
    // DM chat
    if (dmActive && activeDMRoomId && dmConversation) {
      return (
        <>
          <MessageList
            messages={messages}
            isPaginating={isPaginating}
            hasMore={hasMore}
            onLoadMore={loadMore}
            currentUserId={userId}
            isServerOwner={false}
            onDelete={deleteMessage}
            onStartEdit={setEditingMessage}
            onReact={sendReaction}
            onRemoveReaction={removeReaction}
          />
          <TypingIndicator typingUsers={typingUsers} />
          <FloatingButtons onStats={() => setShowStats(true)} onBug={() => setShowBugReport(true)} onHelp={() => setShowHelp(true)} />
          <MessageInput
            onSend={sendMessage}
            onSubmitEdit={editMessage}
            onSendFile={sendFile}
            uploading={uploading}
            editingMessage={editingMessage}
            onCancelEdit={() => setEditingMessage(null)}
            onKeystroke={onKeystroke}
            onStopTyping={onStopTyping}
            roomName={dmConversation.other_user_id.split(":")[0].replace("@", "")}
          />
        </>
      );
    }

    // Server channel chat
    if (activeChannelId && activeChannel) {
      if (isVoiceChannel) {
        return (
          <VoiceChannel
            roomId={activeChannelId}
            channelName={activeChannel.name}
            serverId={activeServerId!}
          />
        );
      }
      return (
        <>
          <MessageList
            messages={messages}
            isPaginating={isPaginating}
            hasMore={hasMore}
            onLoadMore={loadMore}
            currentUserId={userId}
            isServerOwner={isOwner}
            onDelete={deleteMessage}
            onStartEdit={setEditingMessage}
            onReact={sendReaction}
            onRemoveReaction={removeReaction}
          />
          <TypingIndicator typingUsers={typingUsers} />
          <FloatingButtons onStats={() => setShowStats(true)} onBug={() => setShowBugReport(true)} onHelp={() => setShowHelp(true)} />
          <MessageInput
            onSend={sendMessage}
            onSubmitEdit={editMessage}
            onSendFile={activeServer?.media_uploads_enabled !== false ? sendFile : undefined}
            uploading={uploading}
            editingMessage={editingMessage}
            onCancelEdit={() => setEditingMessage(null)}
            onKeystroke={onKeystroke}
            onStopTyping={onStopTyping}
            roomName={activeChannel.name}
          />
        </>
      );
    }

    return (
      <div className="flex-1 flex items-center justify-center p-8">
        {!syncing || !serversLoaded ? (
          <div className="flex flex-col items-center gap-3">
            <span className="inline-block w-6 h-6 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
            <p className="text-on-surface-variant text-sm font-body">
              {!syncing ? "Connecting..." : "Loading your servers..."}
            </p>
          </div>
        ) : servers.length === 0 ? (
          <OnboardingGuide />
        ) : (
          <div className="text-center space-y-2">
            <p className="text-on-surface-variant font-body">Select a channel to start chatting</p>
            <p className="text-on-surface-variant/50 text-sm font-label">
              Pick a text or voice channel from the sidebar
            </p>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Desktop */}
      <div className="hidden md:block h-full">
        {renderDesktopLayout()}
      </div>
      {/* Mobile */}
      <div className="md:hidden h-full">
        {renderMobileLayout()}
      </div>

      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} />}
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {accountSheetOpen && (
        <AccountSheet
          userId={userId}
          onClose={() => setAccountSheetOpen(false)}
        />
      )}
    </>
  );
}

/* ── Account Sheet (Mobile, T003) ── */
function AccountSheet({
  userId,
  onClose,
}: {
  userId: string | null;
  onClose: () => void;
}) {
  const handleLogout = () => {
    onClose();
    useAuthStore.getState().logout();
  };
  const username = userId?.split(":")[0].replace("@", "") ?? "Signed in";
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass-panel w-full max-w-sm rounded-t-2xl md:rounded-2xl p-5 m-0 md:m-4 animate-[fadeSlideUp_0.25s_ease-out] safe-bottom">
        <div className="flex items-center gap-3 mb-4 min-w-0">
          <div className="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant">person</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-on-surface-variant font-label">Signed in as</p>
            <p className="text-sm font-headline font-semibold text-on-surface break-all min-w-0">{username}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="btn-press w-9 h-9 flex items-center justify-center rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
          >
            <span className="material-symbols-outlined text-base">close</span>
          </button>
        </div>
        <button
          onClick={handleLogout}
          className="w-full px-4 py-3 rounded-xl text-error border border-error/30 hover:bg-error/10 transition-colors text-sm font-label font-medium min-h-[44px]"
        >
          Logout
        </button>
      </div>
    </div>
  );
}

/* ── Bottom Navigation (Mobile, T005) ── */
function BottomNav({
  active,
  onChange,
  onSettingsOpen,
}: {
  active: MobileView;
  onChange: (view: MobileView) => void;
  onSettingsOpen: () => void;
}) {
  const items: { key: MobileView; icon: string; label: string }[] = [
    { key: "servers", icon: "dns", label: "Servers" },
    { key: "channels", icon: "tag", label: "Channels" },
    { key: "chat", icon: "forum", label: "Chat" },
    { key: "dms", icon: "chat_bubble", label: "DMs" },
    { key: "settings", icon: "settings", label: "Settings" },
  ];

  const activeIndex = Math.max(0, items.findIndex((it) => it.key === active));
  // Each tab takes 1/5 of width; slide indicator to active.
  const indicatorStyle: React.CSSProperties = {
    transform: `translateX(${activeIndex * 100}%)`,
  };

  return (
    <div className="concord-mobile-nav-wrap safe-bottom flex-shrink-0">
      <nav
        className="concord-mobile-nav glass-panel mx-3 mb-2 rounded-2xl relative flex items-stretch"
        aria-label="Mobile navigation"
      >
        {/* Sliding active pill indicator */}
        <div
          className="concord-mobile-nav-indicator pointer-events-none absolute top-1.5 bottom-1.5 left-1.5"
          style={indicatorStyle}
          aria-hidden="true"
        />
        {items.map(({ key, icon, label }, i) => {
          const isActive = active === key;
          const isCenter = i === 2; // chat
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                if (key === "settings") onSettingsOpen();
                onChange(key);
              }}
              aria-label={label}
              aria-current={isActive ? "page" : undefined}
              className={`relative z-10 flex-1 flex flex-col items-center justify-center min-h-[56px] min-w-[44px] gap-0.5 active:scale-95 transition-transform duration-100 ${
                isActive ? "text-on-surface" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              <span
                className={`material-symbols-outlined text-xl transition-all duration-200 ${
                  isCenter && isActive ? "concord-mobile-nav-center-glow" : ""
                } ${isCenter ? "text-2xl" : ""}`}
                style={
                  isActive
                    ? { fontVariationSettings: '"FILL" 1, "wght" 600, "GRAD" 0, "opsz" 24' }
                    : undefined
                }
              >
                {icon}
              </span>
              <span
                className={`text-[10px] font-label font-medium tracking-wider transition-opacity duration-200 ${
                  isActive ? "opacity-100" : "opacity-70"
                }`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ── Floating Action Buttons ── */
function FloatingButtons({ onStats, onBug, onHelp }: { onStats: () => void; onBug: () => void; onHelp: () => void }) {
  return (
    <div className="flex-shrink-0 flex justify-end gap-2 px-4 py-1">
      <button
        onClick={onHelp}
        className="btn-press w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors"
        title="Help & Getting Started"
      >
        <span className="material-symbols-outlined text-base">help</span>
      </button>
      <button
        onClick={onStats}
        className="btn-press w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors"
        title="Your Stats"
      >
        <span className="material-symbols-outlined text-base">bar_chart</span>
      </button>
      <button
        onClick={onBug}
        className="btn-press w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors"
        title="Report a Bug"
      >
        <span className="material-symbols-outlined text-base">bug_report</span>
      </button>
    </div>
  );
}

/* ── Onboarding Guide ── */
function OnboardingGuide() {
  return (
    <div className="max-w-md w-full space-y-6 animate-[fadeSlideUp_0.5s_ease-out]">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-headline font-bold text-on-surface">Welcome to Concord</h2>
        <p className="text-on-surface-variant text-sm font-body" style={{ lineHeight: "1.6" }}>
          Get started by joining or creating a server.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-3 p-4 rounded-xl bg-surface-container">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-primary text-lg">add</span>
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface font-headline">Create or browse servers</p>
            <p className="text-xs text-on-surface-variant mt-0.5 font-body">
              Tap the <strong className="text-on-surface">+</strong> button to create your own server or browse public ones.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-xl bg-surface-container">
          <div className="w-8 h-8 rounded-full bg-secondary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-secondary text-lg">link</span>
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface font-headline">Got an invite link?</p>
            <p className="text-xs text-on-surface-variant mt-0.5 font-body">
              Paste the invite URL in your browser to automatically join a server.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-xl bg-surface-container">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-primary text-lg">tune</span>
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface font-headline">Customize your profile</p>
            <p className="text-xs text-on-surface-variant mt-0.5 font-body">
              Open settings to configure two-factor auth, passwords, and audio devices.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── DM Header Name (uses hook, must be a component) ── */
function DMHeaderName({ userId }: { userId: string }) {
  const name = useDisplayName(userId);
  return <h2 className="font-headline font-semibold truncate">{name}</h2>;
}

/* ── Help Modal ── */
function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative glass-panel rounded-2xl p-6 animate-[fadeSlideUp_0.3s_ease-out]">
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-colors z-10"
          title="Close"
        >
          <span className="material-symbols-outlined text-lg">close</span>
        </button>
        <OnboardingGuide />
      </div>
    </div>
  );
}
