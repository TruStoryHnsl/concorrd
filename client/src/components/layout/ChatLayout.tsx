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
import { useToastStore } from "../../stores/toast";
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
  useNotifications();

  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Mobile view state — replaces the old drawer system
  const [mobileView, setMobileView] = useState<MobileView>("chat");
  // Mobile account sheet (T003)
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  // INS-016: Mobile dashboard sheet (collapses BottomNav into pills + expand)
  const [dashboardSheetOpen, setDashboardSheetOpen] = useState(false);

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

  // TASK 26: Track the most recently-active channel so the "Reconnect to
  // last channel" quick action can restore it after the user has navigated
  // away (DMs, settings, another server). Persisted in localStorage so it
  // survives reloads. Only server channels are tracked — DMs reconnect via
  // their own store already.
  useEffect(() => {
    if (!dmActive && activeServerId && activeChannelId) {
      try {
        localStorage.setItem(
          "concord_last_channel",
          JSON.stringify({ serverId: activeServerId, roomId: activeChannelId }),
        );
      } catch {}
    }
  }, [dmActive, activeServerId, activeChannelId]);

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

  // Gate read receipts on the user actually looking at chat. On desktop,
  // mobileView stays "chat" unless the user opens a settings view (which
  // swaps out the main content). On mobile, switching to channels/servers/
  // dms/settings hides the chat panel entirely. In all those cases the
  // user is not looking at new messages, so we must not mark them read.
  const chatVisible = mobileView === "chat" && !settingsOpen && !serverSettingsId;
  useSendReadReceipt(activeRoomId, chatVisible);

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

  const addToast = useToastStore((s) => s.addToast);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const setDMActive = useDMStore((s) => s.setDMActive);

  /* ── TASK 26: Mobile dashboard quick actions ── */

  // 1) Reconnect to last channel: read persisted last (server, channel) and
  //    restore it; falls back to the first text channel of the first server
  //    if nothing is persisted.
  const handleReconnectLastChannel = useCallback(() => {
    setDashboardSheetOpen(false);
    try {
      const raw = localStorage.getItem("concord_last_channel");
      if (raw) {
        const parsed = JSON.parse(raw) as { serverId?: string; roomId?: string };
        const server = servers.find((s) => s.id === parsed.serverId);
        const channel = server?.channels.find((c) => c.matrix_room_id === parsed.roomId);
        if (server && channel) {
          setDMActive(false);
          setActiveServer(server.id);
          origSetActiveChannel(channel.matrix_room_id);
          setMobileView("chat");
          return;
        }
      }
    } catch {}
    // Fallback: first text channel of first server
    const firstServer = servers[0];
    const firstText = firstServer?.channels.find((c) => c.channel_type === "text") ?? firstServer?.channels[0];
    if (firstServer && firstText) {
      setDMActive(false);
      setActiveServer(firstServer.id);
      origSetActiveChannel(firstText.matrix_room_id);
      setMobileView("chat");
    } else {
      addToast("No channel to reconnect to — join a server first");
    }
  }, [servers, origSetActiveChannel, setActiveServer, setDMActive, addToast]);

  // 2) Host text/voice/video exchange: there is no dedicated "host" handler
  //    yet — the existing affordance is ChannelSidebar's "+ Add Channel"
  //    form (owner-only). Route the user to the mobile channel list where
  //    that form lives; non-owners land on the channel browser which is
  //    still the closest analogue. The dedicated servitude host flow is
  //    downstream work per the 2026-04-08 embedded-module decision.
  const handleHostExchange = useCallback(() => {
    setDashboardSheetOpen(false);
    setDMActive(false);
    setMobileView("channels");
    if (!activeServerId) {
      addToast("Select a server first to host a channel");
    }
  }, [setDMActive, activeServerId, addToast]);

  // 3) Open profile customization: routes to settings on the profile tab.
  const handleOpenProfile = useCallback(() => {
    setDashboardSheetOpen(false);
    openSettings("profile");
    setMobileView("settings");
  }, [openSettings]);

  // 4) Node settings: generic app settings (audio tab is the default landing).
  const handleOpenNodeSettings = useCallback(() => {
    setDashboardSheetOpen(false);
    openSettings();
    setMobileView("settings");
  }, [openSettings]);

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
        {/* INS-011: Top-bar utility icons (help / stats / bug report).
            On ≥361px viewports we show all three inline plus the account icon.
            On ≤360px we collapse the three into a kebab overflow popover so
            the row never wraps and every action stays ≤2 taps. */}
        <div className="hidden min-[361px]:flex items-center gap-0.5 flex-shrink-0">
          <TopBarIconButton icon="help" label="Help" onClick={() => setShowHelp(true)} />
          <TopBarIconButton icon="bar_chart" label="Your stats" onClick={() => setShowStats(true)} />
          <TopBarIconButton icon="bug_report" label="Report a bug" onClick={() => setShowBugReport(true)} />
        </div>
        <div className="flex min-[361px]:hidden flex-shrink-0">
          <TopBarOverflowMenu
            onHelp={() => setShowHelp(true)}
            onStats={() => setShowStats(true)}
            onBug={() => setShowBugReport(true)}
          />
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

      {/* INS-016: Collapsed pill row (always visible on mobile).
          Tapping any pill opens the full dashboard sheet below. */}
      <MobilePillRow
        active={mobileView}
        onExpand={() => setDashboardSheetOpen(true)}
      />

      {/* INS-016 + TASK 26: Expanded mobile dashboard sheet with full nav and
          quick actions. Slides up over the pill row. */}
      <MobileDashboardSheet
        open={dashboardSheetOpen}
        active={mobileView}
        onClose={() => setDashboardSheetOpen(false)}
        onSelectView={(view) => {
          if (view === "dms") {
            useDMStore.getState().setDMActive(true);
          } else if (view === "servers" || view === "channels" || view === "chat") {
            useDMStore.getState().setDMActive(false);
          }
          if (view === "settings") openSettings();
          setMobileView(view);
          setDashboardSheetOpen(false);
        }}
        onReconnectLast={handleReconnectLastChannel}
        onHostExchange={handleHostExchange}
        onOpenProfile={handleOpenProfile}
        onOpenNodeSettings={handleOpenNodeSettings}
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
        <div className="h-12 flex items-center px-4 bg-surface-container-low flex-shrink-0 gap-2">
          <div className="flex-1 min-w-0 flex items-center">
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
          {/* INS-011: Top-bar utility icons (desktop). Mirrors the mobile
              top-bar icons so bug report / stats / help are reachable from
              the same place on every viewport. */}
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <TopBarIconButton icon="help" label="Help" onClick={() => setShowHelp(true)} />
            <TopBarIconButton icon="bar_chart" label="Your stats" onClick={() => setShowStats(true)} />
            <TopBarIconButton icon="bug_report" label="Report a bug" onClick={() => setShowBugReport(true)} />
          </div>
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

/* ── Mobile Nav Items (shared by pill row + full sheet) ── */
const MOBILE_NAV_ITEMS: { key: MobileView; icon: string; label: string }[] = [
  { key: "servers", icon: "dns", label: "Servers" },
  { key: "channels", icon: "tag", label: "Channels" },
  { key: "chat", icon: "forum", label: "Chat" },
  { key: "dms", icon: "chat_bubble", label: "DMs" },
  { key: "settings", icon: "settings", label: "Settings" },
];

/* ── Mobile Pill Row (INS-016) ──
   Replaces the always-expanded labelled BottomNav with a compact row of
   icon-only pills ("cucumbers") that fill the minimum floor-space. Each
   pill is ≥44×44 tap target (iOS HIG); visual capsule is ~36px tall.
   Tapping any pill opens the full dashboard sheet — users pick a view
   inside the sheet. The center "chat" pill retains the INS-001 glow. */
function MobilePillRow({
  active,
  onExpand,
}: {
  active: MobileView;
  onExpand: () => void;
}) {
  return (
    <div className="concord-mobile-nav-wrap safe-bottom flex-shrink-0">
      <nav
        className="concord-mobile-pill-row glass-panel mx-3 mb-2 rounded-full relative flex items-center justify-between gap-1 px-2 py-1.5"
        aria-label="Mobile navigation (collapsed)"
      >
        {MOBILE_NAV_ITEMS.map(({ key, icon, label }, i) => {
          const isActive = active === key;
          const isCenter = i === 2; // chat
          return (
            <button
              key={key}
              type="button"
              onClick={onExpand}
              aria-label={`${label} — open dashboard`}
              aria-current={isActive ? "page" : undefined}
              className={`concord-mobile-pill relative flex items-center justify-center min-h-[44px] min-w-[44px] h-9 flex-1 rounded-full active:scale-95 transition-all duration-150 ${
                isActive
                  ? "concord-mobile-pill-active text-on-surface"
                  : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high/40"
              }`}
            >
              <span
                className={`material-symbols-outlined transition-all duration-200 ${
                  isCenter && isActive ? "concord-mobile-nav-center-glow" : ""
                } ${isCenter ? "text-xl" : "text-lg"}`}
                style={
                  isActive
                    ? { fontVariationSettings: '"FILL" 1, "wght" 600, "GRAD" 0, "opsz" 24' }
                    : undefined
                }
              >
                {icon}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ── Mobile Dashboard Sheet (INS-016 + TASK 26) ──
   Slide-up sheet containing the full labelled navigation and the TASK 26
   quick actions (reconnect last channel, host exchange, profile, node
   settings). Each action is ≤2 taps from the pill row (1 tap to expand,
   1 tap to invoke). Uses the existing cubic-bezier(0.16, 1, 0.3, 1)
   easing via the `concord-sheet-*` classes below for smooth open/close. */
function MobileDashboardSheet({
  open,
  active,
  onClose,
  onSelectView,
  onReconnectLast,
  onHostExchange,
  onOpenProfile,
  onOpenNodeSettings,
}: {
  open: boolean;
  active: MobileView;
  onClose: () => void;
  onSelectView: (view: MobileView) => void;
  onReconnectLast: () => void;
  onHostExchange: () => void;
  onOpenProfile: () => void;
  onOpenNodeSettings: () => void;
}) {
  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Sheet is always mounted — we drive open/close with CSS classes so the
  // exit animation plays without needing a render-gate effect. The root
  // uses `concord-sheet-root` to delay visibility:hidden until after the
  // slide-out finishes, so the closed state never intercepts taps.
  return (
    <div
      className={`fixed inset-0 z-40 md:hidden concord-sheet-root ${
        open ? "concord-sheet-root-open pointer-events-auto" : "pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm concord-sheet-backdrop ${
          open ? "concord-sheet-backdrop-open" : ""
        }`}
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Dashboard"
        className={`absolute left-0 right-0 bottom-0 safe-bottom glass-panel rounded-t-3xl border-t border-outline-variant/20 concord-sheet-panel ${
          open ? "concord-sheet-panel-open" : ""
        }`}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-outline-variant/40" aria-hidden="true" />
        </div>

        <div className="px-4 pt-2 pb-4">
          {/* Full labelled navigation */}
          <div className="grid grid-cols-5 gap-1">
            {MOBILE_NAV_ITEMS.map(({ key, icon, label }, i) => {
              const isActive = active === key;
              const isCenter = i === 2;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelectView(key)}
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex flex-col items-center justify-center gap-1 min-h-[60px] py-2 rounded-xl active:scale-95 transition-all duration-150 ${
                    isActive
                      ? "bg-surface-container-high text-on-surface"
                      : "text-on-surface-variant hover:bg-surface-container-high/60 hover:text-on-surface"
                  }`}
                >
                  <span
                    className={`material-symbols-outlined ${
                      isCenter && isActive ? "concord-mobile-nav-center-glow" : ""
                    } ${isCenter ? "text-2xl" : "text-xl"}`}
                    style={
                      isActive
                        ? { fontVariationSettings: '"FILL" 1, "wght" 600, "GRAD" 0, "opsz" 24' }
                        : undefined
                    }
                  >
                    {icon}
                  </span>
                  <span className="text-[10px] font-label font-medium tracking-wider">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Quick actions divider */}
          <div className="mt-4 mb-3 flex items-center gap-2">
            <div className="flex-1 h-px bg-outline-variant/20" />
            <span className="text-[10px] font-label font-medium tracking-wider uppercase text-on-surface-variant">
              Quick Actions
            </span>
            <div className="flex-1 h-px bg-outline-variant/20" />
          </div>

          {/* TASK 26: Four quick actions — each reachable in 2 taps
              (pill row → quick-action button). */}
          <div className="grid grid-cols-2 gap-2">
            <QuickActionButton
              icon="replay"
              label="Reconnect last"
              onClick={onReconnectLast}
            />
            <QuickActionButton
              icon="add_call"
              label="Host exchange"
              onClick={onHostExchange}
            />
            <QuickActionButton
              icon="person"
              label="Profile"
              onClick={onOpenProfile}
            />
            <QuickActionButton
              icon="tune"
              label="Node settings"
              onClick={onOpenNodeSettings}
            />
          </div>

          {/* Dismiss chrome */}
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full min-h-[44px] rounded-xl border border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high/60 transition-colors text-sm font-label font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Quick Action Button (TASK 26) ── */
function QuickActionButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn-press flex items-center gap-3 min-h-[56px] px-4 py-3 rounded-xl bg-surface-container-high/60 hover:bg-surface-container-high text-on-surface transition-colors text-left"
    >
      <span className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
        <span className="material-symbols-outlined text-primary text-lg">{icon}</span>
      </span>
      <span className="text-sm font-label font-medium min-w-0 truncate">{label}</span>
    </button>
  );
}

/* ── Top Bar Icon Button (INS-011) ──
   Shared styling for the bug/stats/help buttons in the top bar. Matches the
   account-icon footprint (w-11 h-11) so the four icons form a balanced row.
   Also used on desktop's channel header, which gives us pixel-identical
   icon-button styling across viewports. */
function TopBarIconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="btn-press flex items-center justify-center w-11 h-11 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
    >
      <span className="material-symbols-outlined text-xl">{icon}</span>
    </button>
  );
}

/* ── Top Bar Overflow Menu (INS-017) ──
   Collapses bug/stats/help into a kebab popover on ≤360px viewports so the
   top row doesn't wrap when the four icons (help/stats/bug/account) would
   otherwise exceed available width. Each action stays ≤2 taps: kebab → item. */
function TopBarOverflowMenu({
  onHelp,
  onStats,
  onBug,
}: {
  onHelp: () => void;
  onStats: () => void;
  onBug: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handle = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        className="btn-press flex items-center justify-center w-11 h-11 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
      >
        <span className="material-symbols-outlined text-xl">more_vert</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-40 min-w-[180px] glass-panel rounded-xl py-1 animate-[fadeSlideUp_0.15s_ease-out] shadow-2xl"
        >
          <OverflowMenuItem icon="help" label="Help" onClick={handle(onHelp)} />
          <OverflowMenuItem icon="bar_chart" label="Your stats" onClick={handle(onStats)} />
          <OverflowMenuItem icon="bug_report" label="Report a bug" onClick={handle(onBug)} />
        </div>
      )}
    </div>
  );
}

function OverflowMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 min-h-[44px] text-sm font-label text-on-surface hover:bg-surface-container-high transition-colors text-left"
    >
      <span className="material-symbols-outlined text-lg text-on-surface-variant">{icon}</span>
      {label}
    </button>
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
