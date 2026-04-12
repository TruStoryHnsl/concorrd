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
import { useServerConfigStore } from "../../stores/serverConfig";
import { usePlatform } from "../../hooks/usePlatform";
import { useDpadNav } from "../../hooks/useDpadNav";
import { useSendReadReceipt } from "../../hooks/useUnreadCounts";
import { useNotifications } from "../../hooks/useNotifications";
import { useSettingsStore } from "../../stores/settings";
import { useVoiceStore } from "../../stores/voice";
import { SourcesPanel } from "./SourcesPanel";
import { useSourcesStore } from "../../stores/sources";
import { useDMStore } from "../../stores/dm";
import { useToastStore } from "../../stores/toast";
import { useDisplayName } from "../../hooks/useDisplayName";
import { useExtension } from "../../hooks/useExtension";
import { useExtensionStore } from "../../stores/extension";
import ExtensionEmbed from "../extension/ExtensionEmbed";
import ExtensionMenu from "../extension/ExtensionMenu";
import { ServerSidebar } from "./ServerSidebar";
import { ChannelSidebar, UserBar } from "./ChannelSidebar";
import { DMSidebar } from "../dm/DMSidebar";
import { ExploreModal } from "../server/ExploreModal";
import { MessageList } from "../chat/MessageList";
import { MessageInput } from "../chat/MessageInput";
import { TypingIndicator } from "../chat/TypingIndicator";
import { VoiceChannel } from "../voice/VoiceChannel";
import { SettingsPanel } from "../settings/SettingsModal";
// ServerSettingsPanel is now folded into the unified SettingsPanel (INS-012)
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

type MobileView = "sources" | "servers" | "channels" | "chat" | "actions" | "dms" | "settings";

/** True when running inside a Tauri native shell (iOS, Android, desktop).
 *  `__TAURI_INTERNALS__` is the canonical Tauri v2 global — see the
 *  comment in `client/src/api/serverUrl.ts` for the full history. */
const isNativeApp =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * ChatLayout — the top-level shell.
 *
 * `onAddSource` is the callback that fires when the user taps the `+` tile
 * on the SourcesPanel (empty state or add-another button). App.tsx holds
 * the modal state and passes this down; when clicked it opens the combined
 * "pick an instance + authenticate" wizard. Optional so the component still
 * renders in any test/story that doesn't supply it.
 */
export function ChatLayout({ onAddSource }: { onAddSource?: () => void } = {}) {
  const syncing = useMatrixSync();
  const voiceConnected = useVoiceStore((s) => s.connected);
  const client = useAuthStore((s) => s.client);
  const userId = useAuthStore((s) => s.userId);
  const accessToken = useAuthStore((s) => s.accessToken);
  const logout = useAuthStore((s) => s.logout);
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

  // INS-020 iPad layout — when running on an iPad (native Tauri iOS
  // build or web browser with iPad-class touch screen), force the
  // three-pane desktop layout regardless of the CSS `md:` breakpoint.
  // The existing Tailwind `hidden md:block` / `md:hidden` split already
  // handles web browsers correctly because iPad portrait is >=768px,
  // but native Tauri iOS reports a webview viewport that can drift
  // below the `md:` threshold during split view / slide over, which
  // would otherwise flip the shell to the phone layout mid-session.
  // Explicit `isIPad` + a prefersTabletLayout signal keeps the layout
  // stable regardless of transient viewport width changes.
  const platform = usePlatform();
  const prefersTabletLayout = platform.isIPad;
  const isTV = platform.isTV;

  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Mobile view state — replaces the old drawer system
  const [mobileView, setMobileView] = useState<MobileView>(
    isNativeApp ? "sources" : "chat",
  );
  // Mobile account sheet (T003)
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  // INS-016: Dashboard sheet state — setters are still called by desktop
  // quick-action handlers (they close the old sheet). The value isn't
  // read because mobile's ActionsPanel replaced the sheet overlay.
  const [, setDashboardSheetOpen] = useState(false);
  // INS-020: Add-source flow modal. The `onAddSource` prop is an
  // App.tsx escape hatch so the hollow-shell boot can open this
  // modal from outside; internally, tiles call `setAddSourceOpen`.
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const openAddSource = useCallback(() => {
    setAddSourceOpen(true);
    onAddSource?.();
  }, [onAddSource]);
  // Explore modal state. Hoisted from ServerSidebar to ChatLayout
  // so the SourcesPanel — which now owns the Explore tile per the
  // 2026-04-11 spec — can open the modal from inside the Sources
  // column. ServerSidebar's own Explore button is removed in the
  // desktop render path; mobile still owns its own button.
  const [exploreOpen, setExploreOpen] = useState(false);
  const openExplore = useCallback(() => setExploreOpen(true), []);
  const closeExplore = useCallback(() => setExploreOpen(false), []);

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

  // TV capability banner state — shown when a TV user selects a voice channel
  const [tvBannerDismissed, setTvBannerDismissed] = useState(false);

  // TASK T2: DPAD navigation for TV builds. When isTV is true, the hook
  // registers a keydown listener that takes over arrow keys for spatial
  // focus navigation across the three-pane layout. onBack navigates up
  // through the pane hierarchy (chat → channels → servers).
  const handleTvBack = useCallback(() => {
    if (mobileView === "chat") setMobileView("channels");
    else if (mobileView === "channels") setMobileView("servers");
    else if (mobileView === "settings") { closeSettings(); closeServerSettings(); setMobileView("chat"); }
    else if (mobileView === "dms") setMobileView("chat");
  }, [mobileView, closeSettings, closeServerSettings]);

  useDpadNav({
    enabled: isTV,
    group: "tv-main",
    onBack: handleTvBack,
  });

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

  // Extension system
  const { activeExtension, isHost: isExtensionHost, startExtension, stopExtension } = useExtension(activeRoomId);
  const extensionMenuOpen = useExtensionStore((s) => s.menuOpen);
  const setExtensionMenuOpen = useExtensionStore((s) => s.setMenuOpen);

  // Extension / chat vertical split resize (desktop)
  // extMediaPercent = percentage of container height used by the extension (top pane)
  const EXT_MEDIA_MIN = 20;   // minimum 20% for extension
  const EXT_MEDIA_MAX = 85;   // maximum 85% (leaves at least 15% for chat)
  const EXT_MEDIA_DEFAULT = 65;
  const [extMediaPercent, setExtMediaPercent] = useState(() => {
    try {
      const saved = localStorage.getItem("concord_extension_media_pct");
      if (saved) return Math.max(EXT_MEDIA_MIN, Math.min(EXT_MEDIA_MAX, Number(saved)));
    } catch {}
    return EXT_MEDIA_DEFAULT;
  });
  const isExtDragging = useRef(false);
  const extContainerRef = useRef<HTMLDivElement>(null);
  const extensionBtnRef = useRef<HTMLButtonElement>(null);

  // Sidebar collapse when extension is active
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleExtResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isExtDragging.current = true;
    const startY = e.clientY;
    const startPct = extMediaPercent;
    const container = extContainerRef.current;
    const containerH = container ? container.offsetHeight : window.innerHeight;

    const onMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - startY;
      const deltaPct = (deltaY / containerH) * 100;
      const newPct = Math.max(EXT_MEDIA_MIN, Math.min(EXT_MEDIA_MAX, startPct + deltaPct));
      setExtMediaPercent(newPct);
    };

    const onUp = () => {
      isExtDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [extMediaPercent]);

  useEffect(() => {
    try { localStorage.setItem("concord_extension_media_pct", String(extMediaPercent)); } catch {}
  }, [extMediaPercent]);

  // Auto-collapse sidebar when extension becomes active, restore when it stops
  const extensionIsActive = !!activeExtension;
  useEffect(() => {
    if (extensionIsActive && !dmActive) {
      setSidebarCollapsed(true);
    } else {
      setSidebarCollapsed(false);
    }
  }, [extensionIsActive, dmActive]);

  const loadMembers = useServerStore((s) => s.loadMembers);
  const [serversLoaded, setServersLoaded] = useState(false);

  const loadCatalog = useExtensionStore((s) => s.loadCatalog);

  useEffect(() => {
    if (accessToken && syncing && !serversLoaded) {
      loadServers(accessToken).then(() => setServersLoaded(true));
      loadConversations(accessToken);
      loadCatalog(accessToken);
    }
  }, [accessToken, syncing, serversLoaded, loadServers, loadConversations, loadCatalog]);

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

  // Desktop layout.
  //
  // Structure (2026-04-11 user spec):
  //
  //   ┌──────────────────────────────────────────┬─┬──────────────────────┐
  //   │ LEFT STACK (flex-col, flex-shrink-0)    │ │ MAIN CONTENT (flex-1)│
  //   │ ┌─────────┬───────┬───────┐             │ │                      │
  //   │ │ Sources │ Srvr  │ Chan. │             │ │ Chat pane /          │
  //   │ │ panel   │ rail  │ side- │             │ │ empty state          │
  //   │ │ (+ tile,│       │ bar   │             │ │                      │
  //   │ │ Explore │       │       │             │ │                      │
  //   │ │ at btm) │       │       │             │ │                      │
  //   │ ├─────────┴───────┴───────┤             │ │                      │
  //   │ │  UserBar (only if logged in)          │ │                      │
  //   │ └───────────────────────────────────────┘ │                      │
  //   └──────────────────────────────────────────┴─┴──────────────────────┘
  //                                              ^
  //                                              └ resize handle
  //
  // Rules baked into this layout:
  //
  //   1. ALWAYS render the full multi-pane shell, even with zero sources.
  //      The previous "if (hasNoSources) return <SourcesPanel/>" early
  //      return was a mobile-only behavior that leaked into desktop and
  //      hid every other panel — fixed.
  //   2. Sources column = full SourcesPanel component (NOT the narrow
  //      icon column). Has its own + tile and now also owns the Explore
  //      affordance via the `onExplore` callback.
  //   3. Explore moved out of ServerSidebar into the Sources column
  //      footer. ChatLayout owns the modal state.
  //   4. UserBar renders ONLY when `userId` is set (logged in). On a
  //      cold launch where the user hasn't authenticated yet, the
  //      bottom of the left stack is empty.
  //   5. UserBar is INSIDE the left stack, not outside it. Its width is
  //      automatically the sum of the three columns above it (plus the
  //      Sources column when native), so it stops cleanly at the resize
  //      handle / main pane boundary instead of spanning the whole
  //      window. Regression from the reintegration merge, restored.
  const renderDesktopLayout = () => {
    const extensionActive = !!activeExtension && !dmActive;
    const showSidebar = !extensionActive || !sidebarCollapsed;
    const sources = useSourcesStore((s) => s.sources);

    return (
      <div className="h-full flex overflow-hidden bg-surface text-on-surface">
        {/* LEFT STACK — columns on top, UserBar below.
            `flex-shrink-0` is load-bearing: without it a narrow viewport
            (split screen, small tablet) can compress the stack below the
            sum of its children's intrinsic widths and the UserBar ends
            up narrower than the columns above it. */}
        <div className="flex flex-col min-h-0 flex-shrink-0">
          <div className="flex flex-1 min-h-0">
            {/* Sources column — native desktop only. Narrow icon
                column with one tile per connected source, an
                `+ Add Source` tile, and an Explore tile at the
                bottom. The wider SourcesPanel component is used on
                MOBILE (and the picker overlay), not here. Hidden on
                web builds because the browser's origin IS the
                source and a picker column has no meaning. */}
            {isNativeApp && (
              <div className="w-14 flex-shrink-0 bg-surface-container-low border-r border-outline-variant/10 flex flex-col items-center py-2 gap-2 overflow-y-auto">
                {/* Source tiles — stack from the bottom upward via
                    flex-col-reverse so the most recently added
                    source sits closest to the footer. */}
                <div className="flex flex-col-reverse gap-2 w-full items-center flex-1">
                  {sources.map((source) => (
                    <button
                      key={source.id}
                      onClick={() => useSourcesStore.getState().toggleSource(source.id)}
                      title={`${source.instanceName || source.host}${source.enabled ? " (click to hide)" : " (click to show)"}`}
                      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150 flex-shrink-0 ${
                        source.enabled
                          ? "bg-surface-container-high hover:bg-surface-container-highest text-on-surface ring-1 ring-primary/30"
                          : "bg-surface-container-low text-on-surface-variant/30"
                      }`}
                    >
                      <span className="text-xs font-headline font-bold uppercase">
                        {(source.instanceName || source.host).slice(0, 2)}
                      </span>
                    </button>
                  ))}
                </div>
                {/* Footer: + Add Source, Explore. Always visible. */}
                <button
                  onClick={openAddSource}
                  title="Add source"
                  className="w-10 h-10 rounded-xl border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors flex-shrink-0"
                >
                  <span className="material-symbols-outlined text-lg">add</span>
                </button>
                <button
                  onClick={openExplore}
                  title="Explore federated servers"
                  aria-label="Explore"
                  className="w-10 h-10 rounded-xl bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors flex-shrink-0"
                >
                  <span className="material-symbols-outlined text-lg">explore</span>
                </button>
              </div>
            )}

            {/* Sidebar collapse toggle — visible when extension is active */}
            {extensionActive && (
              <button
                onClick={() => setSidebarCollapsed((c) => !c)}
                className="flex-shrink-0 w-6 flex items-center justify-center bg-surface-container-low/60 backdrop-blur-sm hover:bg-surface-container-high/80 transition-colors z-10 border-r border-outline-variant/10"
                aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              >
                <span
                  className="material-symbols-outlined text-sm text-on-surface-variant/70 transition-transform duration-200"
                  style={{ transform: sidebarCollapsed ? "rotate(0deg)" : "rotate(180deg)" }}
                >
                  chevron_right
                </span>
              </button>
            )}

            {/* Server sidebar */}
            {showSidebar && (
              <>
                <SilentBoundary>
                  <ServerSidebar />
                </SilentBoundary>

                {/* Channel / DM sidebar */}
                <div className="flex min-h-0" style={{ width: sidebarWidth, minWidth: SIDEBAR_MIN, maxWidth: SIDEBAR_MAX }}>
                  <SilentBoundary>
                    {dmActive ? <DMSidebar /> : <ChannelSidebar />}
                  </SilentBoundary>
                </div>
              </>
            )}
          </div>

          {/* User banner — only when logged in. Sits inside the left
              stack so its width matches the sum of the columns above
              and stops at the resize handle. */}
          {userId && (
            <div className="flex-shrink-0 border-t border-outline-variant/20">
              <UserBar userId={userId} logout={logout} />
            </div>
          )}
        </div>

        {/* Resize handle (only when sidebar visible) */}
        {showSidebar && (
          <div
            onMouseDown={handleResizeStart}
            className="w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0"
          />
        )}

        {/* Main content */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {renderMainContent()}
        </div>

        {/* Explore modal — opened from the Sources column's bottom
            tile (was previously opened from ServerSidebar; the state
            now lives at the ChatLayout level so SourcesPanel can
            trigger it). */}
        <ExploreModal isOpen={exploreOpen} onClose={closeExplore} />
      </div>
    );
  };

  // Mobile layout with bottom nav.
  //
  // INS-010 / INS-003 reflow chain (audited 2026-04-08 after INS-011/016/017
  // top-bar + pill rework):
  //
  //   root  flex-col min-h-0 overflow-hidden                      (this div)
  //     ├── top bar             flex-shrink-0                     (INS-011 icons)
  //     ├── middle content      flex-1 min-h-0 overflow-hidden    (view router)
  //     │     └── chat branch   flex flex-col min-h-0             (line 448)
  //     │           ├── MessageList    flex-1 overflow-y-auto
  //     │           └── MessageInput   form `flex-shrink-0`
  //     ├── MobilePillRow       flex-shrink-0  (INS-016 pills)
  //     └── MobileDashboardSheet  absolute-positioned overlay
  //
  // ── Scroll-snap page navigation (INS-020) ──
  // All three page-depth views are rendered as side-by-side panels in a
  // horizontal scroll-snap container. The browser handles swipe physics,
  // momentum, and snap-to-nearest. We sync `mobileView` state from the
  // scroll position so the top bar and pills reflect the visible panel.
  const scrollStripRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToPanel = useCallback((panelIndex: number) => {
    const strip = scrollStripRef.current;
    if (!strip) return;
    const panelWidth = strip.clientWidth;
    strip.scrollTo({ left: panelIndex * panelWidth, behavior: "smooth" });
  }, []);

  // Debounced scroll handler — updates mobileView when the user finishes
  // scrolling. Uses a 100ms debounce so we don't spam state updates during
  // the momentum phase.
  const handleScrollSnap = useCallback(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      const strip = scrollStripRef.current;
      if (!strip) return;
      const panelWidth = strip.clientWidth;
      if (panelWidth === 0) return;
      const panelIndex = Math.round(strip.scrollLeft / panelWidth);
      const clamped = Math.max(0, Math.min(panelIndex, PAGE_DEPTH.length - 1));
      const target = PAGE_DEPTH[clamped];
      if (target && target !== mobileView) {
        setMobileView(target);
        useDMStore.getState().setDMActive(false);
      }
    }, 100);
  }, [mobileView]);

  // Sync scroll position when mobileView changes from outside (e.g. pill tap).
  useEffect(() => {
    const depthIdx = PAGE_DEPTH.indexOf(mobileView);
    if (depthIdx >= 0) scrollToPanel(depthIdx);
  }, [mobileView, scrollToPanel]);

  // The chain MUST NOT be broken by any new ancestor introducing overflow:
  // visible or removing min-h-0 — that would let MessageInput's auto-grow
  // textarea push the MessageList out of view instead of reflowing it.
  // MessageInput's internal useLayoutEffect caps the textarea at
  // min(viewport*0.4, 8*22px) and switches to internal scroll above that.
  const renderMobileLayout = () => (
    <div className="h-full flex flex-col overflow-hidden bg-surface text-on-surface min-h-0">
      {/* Top bar — safe-top lives on the OUTER wrapper so the safe-area
          inset adds transparent padding ABOVE the 48px content bar instead
          of stealing from its interior (which was cutting off icons on
          notch-equipped iPhones). */}
      <div className="bg-surface-container-low safe-top flex-shrink-0">
      <div className="h-12 flex items-center px-3 gap-2">
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
            the row never wraps and every action stays ≤2 taps.
            The ConnectedHostLabel hides entirely below the `sm` breakpoint
            (640px) because mobile real estate is precious — it lives in the
            account sheet on very small screens instead. */}
        <div className="hidden min-[361px]:flex items-center gap-1 flex-shrink-0">
          <ConnectedHostLabel compact />
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
      </div>

      {/* Main content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {/* Page-depth views: horizontal scroll-snap strip.
            All three panels are always mounted (servers, channels, chat).
            CSS scroll-snap handles the swipe physics + snap-to-nearest.
            DMs and Settings are full-screen overlays ABOVE the strip. */}
        {(mobileView === "dms" || mobileView === "settings" || mobileView === "actions") ? (
          // Non-page views: full-screen, no scroll strip
          mobileView === "dms" ? (
            <SilentBoundary>
              <DMSidebar mobile onDMSelect={handleMobileDMSelect} />
            </SilentBoundary>
          ) : mobileView === "actions" ? (
            <ActionsPanel
              onReconnectLast={handleReconnectLastChannel}
              onHostExchange={handleHostExchange}
              onOpenProfile={handleOpenProfile}
              onOpenNodeSettings={handleOpenNodeSettings}
            />
          ) : (
            <div className="h-full flex flex-col min-h-0">
              <SettingsPanel />
            </div>
          )
        ) : (
          // Page-depth scroll strip. Native: sources ↔ servers ↔ channels ↔ chat.
          // Web: servers ↔ channels ↔ chat (no sources panel).
          <div
            ref={scrollStripRef}
            className="h-full flex overflow-x-auto overflow-y-hidden overscroll-x-auto"
            style={{
              scrollSnapType: "x mandatory",
              scrollBehavior: "smooth",
              WebkitOverflowScrolling: "touch",
            }}
            onScroll={handleScrollSnap}
          >
            {/* Panel: Sources (native only) */}
            {isNativeApp && (
              <div className="w-full h-full flex-shrink-0" style={{ scrollSnapAlign: "start" }}>
                <SourcesPanel
                  onAddSource={openAddSource}
                  onSourceSelect={() => scrollToPanel(1)}
                />
              </div>
            )}
            {/* Panels below only render when sources exist (native) or always (web).
                On native with no sources, only the Sources panel shows. */}
            {(!isNativeApp || useSourcesStore.getState().sources.length > 0) && (
              <>
                {/* Panel: Servers */}
                <div className="w-full h-full flex-shrink-0" style={{ scrollSnapAlign: "start" }}>
                  <SilentBoundary>
                    <ServerSidebar mobile onServerSelect={() => setMobileView("channels")} />
                  </SilentBoundary>
                </div>
                {/* Panel: Channels */}
                <div className="w-full h-full flex-shrink-0" style={{ scrollSnapAlign: "start" }}>
                  <SilentBoundary>
                    <ChannelSidebar mobile onChannelSelect={(chId) => { handleMobileChannelSelect(chId); setMobileView("chat"); }} />
                  </SilentBoundary>
                </div>
              </>
            )}
            {/* Panel: Chat — gated on sources same as servers/channels */}
            {(!isNativeApp || useSourcesStore.getState().sources.length > 0) && (
              <div className="w-full h-full flex-shrink-0" style={{ scrollSnapAlign: "start" }}>
                <div className="h-full flex flex-col min-h-0">
                  {renderChatContent()}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* INS-020: New 4-pill bottom bar with direct navigation. */}
      <MobilePillRow
        active={mobileView}
        pageDepth={PAGE_DEPTH.includes(mobileView) ? mobileView : "servers"}
        voiceActive={voiceConnected}
        voiceChannelName={useVoiceStore.getState().channelName ?? undefined}
        onVoiceReturn={() => setMobileView("chat")}
        onNavigate={(view) => {
          if (view === "dms") {
            useDMStore.getState().setDMActive(true);
          } else if (view === "servers" || view === "channels" || view === "chat") {
            useDMStore.getState().setDMActive(false);
          }
          if (view === "settings") openSettings();
          setMobileView(view);
        }}
      />

      {/* Mobile extension menu overlay */}
      {extensionMenuOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center md:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setExtensionMenuOpen(false)} />
          <div className="relative w-full mx-3 mb-3 rounded-2xl bg-surface-container border border-outline-variant/20 shadow-xl overflow-hidden safe-bottom">
            <div className="px-4 py-3 border-b border-outline-variant/20 flex items-center justify-between">
              <h3 className="text-sm font-headline font-semibold text-on-surface">Extensions</h3>
              <button onClick={() => setExtensionMenuOpen(false)} className="text-on-surface-variant">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            <div className="p-2 max-h-[50vh] overflow-y-auto">
              {useExtensionStore.getState().catalog.map((ext) => {
                const isActive = activeExtension?.extensionId === ext.id;
                return (
                  <div key={ext.id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-surface-container-high/60 transition-colors">
                    <span className="material-symbols-outlined text-xl text-on-surface-variant flex-shrink-0">{ext.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-label font-medium text-on-surface">{ext.name}</div>
                      <div className="text-xs text-on-surface-variant font-label">{isActive ? `Active — hosted by ${ext.name}` : ext.description}</div>
                    </div>
                    {isActive ? (
                      isExtensionHost && (
                        <button onClick={() => { stopExtension(); setExtensionMenuOpen(false); }} className="px-2 py-1 rounded-lg text-xs font-label text-error hover:bg-error/10 transition-colors">Stop</button>
                      )
                    ) : (
                      <button onClick={() => { startExtension(ext.id); setExtensionMenuOpen(false); }} className="px-2.5 py-1 rounded-lg text-xs font-label font-medium text-on-primary bg-primary hover:brightness-110 transition-all">Start</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* INS-020: Quick Actions sheet — search bar + action grid. */}
      {/* QuickActionsSheet removed — replaced by ActionsPanel (full-screen view) */}

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
              the same place on every viewport. The ConnectedHostLabel to
              their left shows which Concord instance this session is
              talking to — sourced from the INS-027 serverConfig store
              on native builds, falls back to window.location.hostname
              on the web. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <ConnectedHostLabel />
            <div className="flex items-center gap-0.5">
              {activeChannel && !isVoiceChannel && (
                <TopBarIconButton ref={extensionBtnRef} icon="extension" label="Extensions" onClick={() => setExtensionMenuOpen(!extensionMenuOpen)} />
              )}
              <TopBarIconButton icon="help" label="Help" onClick={() => setShowHelp(true)} />
              <TopBarIconButton icon="bar_chart" label="Your stats" onClick={() => setShowStats(true)} />
              <TopBarIconButton icon="bug_report" label="Report a bug" onClick={() => setShowBugReport(true)} />
            </div>
          </div>
        </div>

        {/* Extension vertical split (media top, chat bottom) or normal chat */}
        {activeExtension && !dmActive ? (
          <div ref={extContainerRef} className="flex-1 flex flex-col min-h-0 min-w-0">
            {/* Extension / media pane (top) */}
            <div className="min-h-0 overflow-hidden" style={{ height: `${extMediaPercent}%` }}>
              <ExtensionEmbed
                url={activeExtension.extensionUrl}
                extensionName={activeExtension.extensionName}
                hostUserId={activeExtension.hostUserId}
                isHost={isExtensionHost}
                onStop={stopExtension}
              />
            </div>
            {/* Horizontal resize handle (drag up/down) */}
            <div
              onMouseDown={handleExtResizeStart}
              className="h-1.5 cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0 flex items-center justify-center group"
            >
              <div className="w-12 h-0.5 rounded-full bg-outline-variant/40 group-hover:bg-primary/60 transition-colors" />
            </div>
            {/* Chat pane (bottom) */}
            <div className="flex-1 flex flex-col min-h-0">
              {renderChatContent()}
            </div>
          </div>
        ) : (
          renderChatContent()
        )}
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

  // TV layout — three-pane desktop layout with DPAD focus attributes.
  // Uses the same three-pane approach as desktop but adds data-focusable
  // and data-focus-group attributes for the DPAD nav hook, plus the TV
  // capability banner for voice channels.
  const renderTVLayout = () => (
    <div className="h-full flex overflow-hidden bg-surface text-on-surface tv-layout" data-concord-layout="tv">
      {/* Server sidebar — TV: icon-only rail with focus targets */}
      <SilentBoundary>
        <div data-focus-group="tv-main">
          <ServerSidebar />
        </div>
      </SilentBoundary>

      {/* Channel sidebar */}
      <div className="flex min-h-0 tv-channel-sidebar" style={{ width: 320, minWidth: 200 }}>
        <SilentBoundary>
          <div className="w-full" data-focus-group="tv-main">
            {dmActive ? <DMSidebar /> : <ChannelSidebar />}
          </div>
        </SilentBoundary>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 tv-content">
        {/* TV capability banner — voice/video unavailable */}
        {isTV && isVoiceChannel && !tvBannerDismissed && (
          <div className="tv-capability-banner" role="alert">
            <span className="material-symbols-outlined tv-capability-banner-icon">volume_off</span>
            <span>Voice and video channels are not available on TV devices. Text chat works normally.</span>
            <button
              className="tv-capability-banner-dismiss"
              onClick={() => setTvBannerDismissed(true)}
              aria-label="Dismiss"
              data-focusable="true"
              data-focus-group="tv-main"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        )}
        <div data-focus-group="tv-main">
          {renderMainContent()}
        </div>
      </div>
    </div>
  );

  // INS-020: iPad explicitly renders the desktop three-pane layout so
  // the native iOS Tauri build gets the tablet UX regardless of CSS
  // breakpoints. Non-iPad clients use the existing Tailwind `md:`
  // split that already handles desktop browsers and phones.
  return (
    <>
      {isTV ? (
        // TV — three-pane with DPAD navigation and capability banners.
        renderTVLayout()
      ) : prefersTabletLayout ? (
        // iPad native — always three-pane, regardless of viewport width.
        <div className="h-full" data-concord-layout="tablet">
          {renderDesktopLayout()}
        </div>
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden md:block h-full" data-concord-layout="desktop">
            {renderDesktopLayout()}
          </div>
          {/* Mobile */}
          <div className="md:hidden h-full" data-concord-layout="mobile">
            {renderMobileLayout()}
          </div>
        </>
      )}

      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} />}
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      <ExtensionMenu
        open={extensionMenuOpen}
        onClose={() => setExtensionMenuOpen(false)}
        activeExtension={activeExtension}
        onStart={startExtension}
        onStop={stopExtension}
        isHost={isExtensionHost}
        anchorRef={extensionBtnRef}
      />
      {accountSheetOpen && (
        <AccountSheet
          userId={userId}
          onClose={() => setAccountSheetOpen(false)}
        />
      )}
      {/* INS-020: Add Source modal — shared between mobile + desktop native */}
      {addSourceOpen && (
        <AddSourceModal
          onClose={() => setAddSourceOpen(false)}
          onSourceAdded={() => {
            setAddSourceOpen(false);
            if (scrollStripRef.current) scrollToPanel(1);
          }}
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
// Page-depth hierarchy for swipe navigation. Swiping left goes deeper,
// swiping right goes back (matching iOS back-gesture convention).
// Native apps have an extra "sources" panel at the shallowest depth.
const PAGE_DEPTH: MobileView[] = isNativeApp
  ? ["sources", "servers", "channels", "chat"]
  : ["servers", "channels", "chat"];

// Icon + label for the "Page" pill, contextual to the current depth.
const PAGE_PILL_META: Record<string, { icon: string; label: string }> = {
  sources: { icon: "hub", label: "Sources" },
  servers: { icon: "dns", label: "Servers" },
  channels: { icon: "tag", label: "Channels" },
  chat: { icon: "forum", label: "Chat" },
};

/* ── Mobile Pill Row (INS-016 → INS-020 redesign) ──
   Four pills: [📍 Page] [⚡ Actions] [💬 DMs] [⚙️ Settings].
   The Page pill icon changes based on current depth (servers/channels/chat).
   Tapping Page when on DMs/Settings returns to the last page depth.
   Tapping Actions opens the quick-actions sheet. DMs and Settings navigate
   directly. Voice persistence pills are inserted dynamically. */
function MobilePillRow({
  active,
  onNavigate,
  pageDepth,
  voiceActive,
  voiceChannelName,
  onVoiceReturn,
}: {
  active: MobileView;
  onNavigate: (view: MobileView) => void;
  pageDepth: MobileView;
  voiceActive?: boolean;
  voiceChannelName?: string;
  onVoiceReturn?: () => void;
}) {
  const pageMeta = PAGE_PILL_META[pageDepth] ?? PAGE_PILL_META.servers;
  const isOnPage = PAGE_DEPTH.includes(active);

  const pills: { key: string; icon: string; label: string; isActive: boolean; onClick: () => void }[] = [
    {
      key: "page",
      icon: pageMeta.icon,
      label: pageMeta.label,
      isActive: isOnPage,
      onClick: () => onNavigate(isOnPage ? "servers" : pageDepth),
    },
    // Voice persistence pill — only visible when in a voice call
    ...(voiceActive
      ? [{
          key: "voice",
          icon: "mic",
          label: voiceChannelName ?? "Voice",
          isActive: false,
          onClick: () => onVoiceReturn?.(),
        }]
      : []),
    {
      key: "actions",
      icon: "bolt",
      label: "Actions",
      isActive: active === "actions",
      onClick: () => onNavigate("actions"),
    },
    {
      key: "dms",
      icon: "chat_bubble",
      label: "DMs",
      isActive: active === "dms",
      onClick: () => onNavigate("dms"),
    },
    {
      key: "settings",
      icon: "settings",
      label: "Settings",
      isActive: active === "settings",
      onClick: () => onNavigate("settings"),
    },
  ];

  return (
    <div className="concord-mobile-nav-wrap safe-bottom flex-shrink-0">
      <nav
        className="concord-mobile-pill-row mx-3 mb-2 rounded-full relative flex items-center justify-between gap-1 px-2 py-1.5"
        aria-label="Mobile navigation"
      >
        {pills.map(({ key, icon, label, isActive, onClick }) => (
          <button
            key={key}
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            className={`concord-mobile-pill relative flex items-center justify-center min-h-[44px] min-w-[44px] h-9 flex-1 rounded-full active:scale-95 transition-all duration-150 ${
              isActive
                ? "concord-mobile-pill-active text-on-surface"
                : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high/40"
            }`}
          >
            <span
              className={`material-symbols-outlined text-lg transition-all duration-200`}
              style={
                isActive
                  ? { fontVariationSettings: '"FILL" 1, "wght" 600, "GRAD" 0, "opsz" 24' }
                  : undefined
              }
            >
              {icon}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ── Quick Actions Sheet (INS-020 redesign) ──
   Slide-up sheet with a search/command bar at the top and a grid of
   quick actions below. Opened by tapping the ⚡ Actions pill. The nav
   grid is gone — Page/DMs/Settings are handled directly by the pill
   row taps; depth navigation is via swipe or back arrows. */
/* ── Actions Panel (INS-020) ──
   Full-screen panel for quick actions. Replaces the old slide-up sheet.
   Renders as a standard mobile view, same as DMs or Settings. */
function ActionsPanel({
  onReconnectLast,
  onHostExchange,
  onOpenProfile,
  onOpenNodeSettings,
}: {
  onReconnectLast: () => void;
  onHostExchange: () => void;
  onOpenProfile: () => void;
  onOpenNodeSettings: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="h-full bg-surface-container-low overflow-y-auto overflow-x-hidden overscroll-y-auto p-4 flex flex-col">
      <h3 className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest px-1 mb-4">
        Quick Actions
      </h3>

      {/* Search / command bar */}
      <div className="relative mb-4">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">
          search
        </span>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search servers, channels, users..."
          className="w-full h-11 pl-10 pr-4 rounded-xl bg-surface-container-high border border-outline-variant/20 text-on-surface text-sm font-body placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
        />
      </div>

      {/* Action grid — Host exchange hidden on iOS (can't host) */}
      <div className="grid grid-cols-2 gap-3">
        <QuickActionButton icon="replay" label="Reconnect last" onClick={onReconnectLast} />
        {!isNativeApp && (
          <QuickActionButton icon="add_call" label="Host exchange" onClick={onHostExchange} />
        )}
        <QuickActionButton icon="person" label="Profile" onClick={onOpenProfile} />
        <QuickActionButton icon="tune" label="Node settings" onClick={onOpenNodeSettings} />
      </div>
    </div>
  );
}

// QuickActionsSheet removed — replaced by ActionsPanel (full-screen view).

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

/* ── Add Source Modal (INS-020) ──
   Full-screen modal for connecting to a new Concord instance.
   Step 1: Enter domain + invite token.
   Step 2: Validate token against the instance.
   Step 3: Show login/register form scoped to that instance.
   Step 4: On success, add the source and close. */
function AddSourceModal({
  onClose,
  onSourceAdded,
}: {
  onClose: () => void;
  onSourceAdded: () => void;
}) {
  const [step, setStep] = useState<"connect" | "validating" | "login" | "error">("connect");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [, setDiscoveredName] = useState("");
  const addSource = useSourcesStore((s) => s.addSource);

  const handleConnect = async () => {
    const trimmed = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!trimmed) { setError("Enter a hostname"); return; }
    if (!token.trim()) { setError("Enter an invite token"); return; }

    setStep("validating");
    setError("");

    try {
      // Step 1: Discover the instance via well-known
      const { discoverHomeserver } = await import("../../api/wellKnown");
      const config = await discoverHomeserver(trimmed);

      // Step 2: Validate the invite token against the instance
      const validateUrl = `${config.api_base}/invites/validate/${encodeURIComponent(token.trim())}`;
      const validateRes = await fetch(validateUrl, { credentials: "omit" });
      if (!validateRes.ok) throw new Error("Token validation request failed");
      const validation = await validateRes.json();

      if (!validation.valid) {
        setStep("error");
        setError("Invalid or expired invite token");
        return;
      }

      setDiscoveredName(config.instance_name || trimmed);

      // Step 3: Add the source in "connecting" state
      addSource({
        host: trimmed,
        instanceName: config.instance_name,
        inviteToken: token.trim(),
        apiBase: config.api_base,
        homeserverUrl: config.homeserver_url,
        status: "connected",
        enabled: true,
      });

      onSourceAdded();
    } catch (err) {
      setStep("error");
      setError(
        err instanceof Error ? err.message : "Couldn't reach that host",
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 bg-surface-container rounded-2xl border border-outline-variant/20 shadow-2xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-headline font-semibold text-on-surface">
            Add Source
          </h2>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {step === "validating" ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <span className="inline-block w-6 h-6 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
            <span className="text-sm text-on-surface-variant font-body">
              Connecting to {host}...
            </span>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest mb-1.5">
                Hostname
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => { setHost(e.target.value); setError(""); }}
                placeholder="concorrd.com"
                className="w-full px-4 py-3 bg-surface-container-high rounded-xl text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all font-body"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div>
              <label className="block text-xs font-label font-medium text-on-surface-variant uppercase tracking-widest mb-1.5">
                Invite Token
              </label>
              <input
                type="text"
                value={token}
                onChange={(e) => { setToken(e.target.value); setError(""); }}
                placeholder="Paste your invite token"
                className="w-full px-4 py-3 bg-surface-container-high rounded-xl text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all font-mono tracking-wider"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            {error && (
              <div className="px-3 py-2 rounded-lg bg-error/10 border border-error/20">
                <p className="text-sm text-error font-body">{error}</p>
              </div>
            )}

            <button
              onClick={handleConnect}
              disabled={!host.trim() || !token.trim()}
              className="w-full py-3 font-headline font-semibold rounded-xl primary-glow text-on-primary hover:brightness-110 shadow-lg shadow-primary/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              Connect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Small pill showing which Concord instance the client is currently
 * connected to (INS-027 follow-up). Resolution order:
 *
 *   1. `serverConfig.config` — set by the first-launch server-picker
 *      flow on native builds. Shows `instance_name` if present,
 *      falling back to `host`.
 *   2. `window.location.hostname` — the browser origin. This covers
 *      the web deploy where the picker is never shown.
 *
 * Rendered inline in the top bar, small and unobtrusive. On mobile
 * the label truncates at the first dot so "chat.example.com" becomes
 * "chat" to save horizontal space; tapping is NOT wired to
 * anything (purely informational for now).
 */
function ConnectedHostLabel({ compact = false }: { compact?: boolean }) {
  const config = useServerConfigStore((s) => s.config);

  const display = useMemo(() => {
    if (config) {
      return config.instance_name || config.host;
    }
    if (typeof window !== "undefined") {
      return window.location.hostname || "web";
    }
    return "web";
  }, [config]);

  // On compact mode (mobile ≤360px), trim to the first dot so long
  // domains don't crowd the top bar.
  const shown = compact ? display.split(".")[0] : display;

  return (
    <span
      className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-high/60 text-[10px] font-label font-medium text-on-surface-variant max-w-[140px] truncate"
      title={`Connected to ${display}`}
      aria-label={`Connected to ${display}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full bg-secondary flex-shrink-0"
        aria-hidden="true"
      />
      <span className="truncate">{shown}</span>
    </span>
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
  ref,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
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
