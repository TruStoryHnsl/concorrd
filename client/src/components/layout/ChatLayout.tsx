import { useEffect, useState, useMemo, useCallback, useRef, Component, type ReactNode } from "react";
import type { IPublicRoomsChunkRoom } from "matrix-js-sdk";
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
import {
  sourceMatchesMatrixDomain,
  useSourcesStore,
  type ConcordSource,
} from "../../stores/sources";
import { useDMStore } from "../../stores/dm";
import { useToastStore } from "../../stores/toast";
import { useDisplayName } from "../../hooks/useDisplayName";
import { useExtension } from "../../hooks/useExtension";
import { useExtensionStore } from "../../stores/extension";
import ExtensionEmbed from "../extension/ExtensionEmbed";
import ExtensionMenu from "../extension/ExtensionMenu";
import { ServerSidebar } from "./ServerSidebar";
import { Avatar } from "../ui/Avatar";
import { ChannelSidebar, UserBar } from "./ChannelSidebar";
import { DMSidebar } from "../dm/DMSidebar";
import { ExploreModal } from "../server/ExploreModal";
import { DiscordSourceBrowser } from "../sources/DiscordSourceBrowser";
import { MessageList } from "../chat/MessageList";
import { MessageInput } from "../chat/MessageInput";
import { TypingIndicator } from "../chat/TypingIndicator";
import { VoiceChannel } from "../voice/VoiceChannel";
import { SettingsPanel } from "../settings/SettingsModal";
// ServerSettingsPanel is now folded into the unified SettingsPanel (INS-012)
import { BugReportModal } from "../BugReportModal";
import { StatsModal } from "../StatsModal";
import { SourceBrandIcon, inferSourceBrand } from "../sources/sourceBrand";
import {
  discordBridgeHttpListGuilds,
  discordVoiceBridgeHttpListRooms,
} from "../../api/bridges";
import {
  getMyStats,
  getRoomDiagnostics,
  type RoomDiagnostics,
  type UserStats,
} from "../../api/concord";
import {
  buildMatrixSourceDraft,
  clearPendingSourceSso,
  clearPendingSourceSsoQueryParams,
  hasPendingSourceSsoCallback,
  readPendingSourceSso,
  upsertMatrixSourceRecord,
  writePendingSourceSso,
  type MatrixSourceDraft,
} from "../sources/matrixSourceAuth";

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

function lastChannelStorageKey(userId: string | null): string {
  return userId ? `concord_last_channel:${userId}` : "concord_last_channel";
}

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
  const ensureDiscordGuild = useServerStore((s) => s.ensureDiscordGuild);
  const updateServer = useServerStore((s) => s.updateServer);

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
  const [roomDiagnostics, setRoomDiagnostics] = useState<RoomDiagnostics | null>(null);
  const [roomDiagnosticsLoading, setRoomDiagnosticsLoading] = useState(false);

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
  const [statsTarget, setStatsTarget] = useState<{ type: "user" } | { type: "server"; serverId: string } | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Mobile view state — replaces the old drawer system
  const [mobileView, setMobileView] = useState<MobileView>(
    isNativeApp ? "sources" : "chat",
  );
  // Mobile account sheet (T003)
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  const [desktopAccountPopoverOpen, setDesktopAccountPopoverOpen] = useState(false);
  const desktopAccountRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (hasPendingSourceSsoCallback()) {
      setAddSourceOpen(true);
    }
  }, []);
  // Explore modal state. Hoisted from ServerSidebar to ChatLayout
  // so the SourcesPanel — which now owns the Explore tile per the
  // 2026-04-11 spec — can open the modal from inside the Sources
  // column. ServerSidebar's own Explore button is removed in the
  // desktop render path; mobile still owns its own button.
  const [exploreOpen, setExploreOpen] = useState(false);
  const openExplore = useCallback(() => setExploreOpen(true), []);
  const closeExplore = useCallback(() => setExploreOpen(false), []);

  // Source browser — opened when the user clicks a source tile.
  const [sourceBrowserSourceId, setSourceBrowserSourceId] = useState<string | null>(null);
  const sources = useSourcesStore((s) => s.sources);
  const openSourceBrowser = useCallback(
    (sourceId: string) => {
      setSourceBrowserSourceId(sourceId);
    },
    [],
  );

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
          lastChannelStorageKey(userId),
          JSON.stringify({ serverId: activeServerId, roomId: activeChannelId }),
        );
      } catch {}
    }
  }, [dmActive, activeServerId, activeChannelId, userId]);

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
  const emptyState = useMemo(() => {
    if (!activeRoomId) return undefined;
    if (roomDiagnosticsLoading) {
      return (
        <div className="max-w-xl px-6 py-5 rounded-lg border border-outline-variant/20 bg-surface-container text-left">
          <p className="text-sm font-medium text-on-surface">No messages loaded yet</p>
          <p className="mt-2 text-xs text-on-surface-variant">
            Inspecting room binding and homeserver history access for {activeRoomId}.
          </p>
        </div>
      );
    }
    if (!roomDiagnostics) return undefined;
    return (
      <div className="max-w-2xl px-6 py-5 rounded-lg border border-outline-variant/20 bg-surface-container text-left">
        <p className="text-sm font-semibold text-on-surface">Room diagnostics</p>
        <p className="mt-2 text-xs text-on-surface-variant break-all">
          room: {roomDiagnostics.room_id}
        </p>
        <p className="mt-1 text-sm text-on-surface-variant">
          {roomDiagnostics.summary}
        </p>
        <p className="mt-2 text-xs text-on-surface-variant">
          inference: {roomDiagnostics.inference}
        </p>
        <div className="mt-3 space-y-2">
          {roomDiagnostics.steps.map((step) => (
            <div
              key={step.step}
              className="rounded-md border border-outline-variant/15 bg-surface px-3 py-2"
            >
              <div className="flex items-center gap-2 text-xs">
                <span className={step.ok ? "text-[#4ade80]" : "text-[#f87171]"}>
                  {step.ok ? "OK" : "FAIL"}
                </span>
                <span className="font-medium text-on-surface">{step.step}</span>
                <span className="text-on-surface-variant">
                  {step.status ?? "no-status"}
                </span>
              </div>
              {step.detail && (
                <p className="mt-1 text-[11px] text-on-surface-variant break-all">
                  {step.detail}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }, [activeRoomId, roomDiagnostics, roomDiagnosticsLoading]);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const serverSettingsId = useSettingsStore((s) => s.serverSettingsId);
  const closeServerSettings = useSettingsStore((s) => s.closeServerSettings);
  const openSettings = useSettingsStore((s) => s.openSettings);

  useEffect(() => {
    if (!desktopAccountPopoverOpen) return;
    const handleDocumentClick = (event: MouseEvent) => {
      if (
        desktopAccountRef.current &&
        !desktopAccountRef.current.contains(event.target as Node)
      ) {
        setDesktopAccountPopoverOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDesktopAccountPopoverOpen(false);
    };
    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [desktopAccountPopoverOpen]);

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
  const discordVoiceProjectionHandled = useRef<string | null>(null);
  const startupRestoreHandled = useRef<string | null>(null);
  const origSetActiveChannel = useServerStore((s) => s.setActiveChannel);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const setActiveDM = useDMStore((s) => s.setActiveDM);
  const addToast = useToastStore((s) => s.addToast);
  const setDMActive = useDMStore((s) => s.setDMActive);
  const hasDiscordBridgeServers = useMemo(
    () => servers.some((server) => server.bridgeType === "discord"),
    [servers],
  );

  const loadCatalog = useExtensionStore((s) => s.loadCatalog);

  useEffect(() => {
    if (!accessToken || serversLoaded) return;
    let cancelled = false;
    Promise.allSettled([
      loadServers(accessToken),
      loadConversations(accessToken),
      loadCatalog(accessToken),
    ]).finally(() => {
      if (!cancelled) setServersLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, serversLoaded, loadServers, loadConversations, loadCatalog]);

  useEffect(() => {
    if (!accessToken || !activeRoomId || messages.length > 0) {
      setRoomDiagnostics(null);
      setRoomDiagnosticsLoading(false);
      return;
    }

    let cancelled = false;
    setRoomDiagnosticsLoading(true);
    getRoomDiagnostics(activeRoomId, accessToken)
      .then((diag) => {
        if (!cancelled) setRoomDiagnostics(diag);
      })
      .catch((err) => {
        if (!cancelled) {
          setRoomDiagnostics({
            room_id: activeRoomId,
            user_id: userId ?? "",
            binding: { kind: "unknown" },
            inference: "diagnostic_request_failed",
            summary: err instanceof Error ? err.message : "Room diagnostics failed",
            steps: [],
          });
        }
      })
      .finally(() => {
        if (!cancelled) setRoomDiagnosticsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, activeRoomId, messages.length, userId]);

  useEffect(() => {
    if (!accessToken || !serversLoaded || !userId || !hasDiscordBridgeServers) return;
    if (discordVoiceProjectionHandled.current === userId) return;
    discordVoiceProjectionHandled.current = userId;

    let cancelled = false;
    (async () => {
      try {
        const [rooms, guilds] = await Promise.all([
          discordVoiceBridgeHttpListRooms(accessToken),
          discordBridgeHttpListGuilds(accessToken).catch(() => []),
        ]);
        if (cancelled) return;

        const latestServers = useServerStore.getState().servers;
        for (const guild of guilds) {
          const iconUrl = guild.icon
            ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
            : null;
          const server = latestServers.find(
            (entry) => entry.bridgeType === "discord" && entry.discordGuildId === guild.id,
          );
          if (!server) continue;
          if (iconUrl && server.icon_url !== iconUrl) {
            updateServer(server.id, { icon_url: iconUrl });
          }
          if (server.name.startsWith("Guild ") && guild.name) {
            updateServer(server.id, { name: guild.name });
          }
        }
        for (const room of rooms) {
          if (!room.enabled) continue;
          const localChannel = latestServers
            .flatMap((server) => server.channels)
            .find(
              (channel) =>
                channel.id === room.channel_id ||
                channel.matrix_room_id === room.matrix_room_id,
            );
          if (!localChannel) continue;
          ensureDiscordGuild({
            guildId: room.discord_guild_id,
            guildName:
              guilds.find((guild) => guild.id === room.discord_guild_id)?.name ??
              `Guild ${room.discord_guild_id}`,
            iconUrl: (() => {
              const guild = guilds.find((entry) => entry.id === room.discord_guild_id);
              return guild?.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
                : null;
            })(),
            channel: {
              id: localChannel.id,
              roomId: room.matrix_room_id,
              name: localChannel.name,
              channelType: "voice",
            },
            preferBridgeServer: true,
            activate: false,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message.toLowerCase() : "";
        if (!message.includes("forbidden") && !message.includes("403")) {
          discordVoiceProjectionHandled.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, ensureDiscordGuild, hasDiscordBridgeServers, serversLoaded, updateServer, userId]);

  useEffect(() => {
    if (!serversLoaded || !userId) return;
    if (startupRestoreHandled.current === userId) return;

    try {
      const raw = localStorage.getItem(lastChannelStorageKey(userId));
      if (!raw) {
        startupRestoreHandled.current = userId;
        return;
      }
      const parsed = JSON.parse(raw) as { serverId?: string; roomId?: string };
      const server = servers.find((s) => s.id === parsed.serverId);
      const channel = server?.channels.find((c) => c.matrix_room_id === parsed.roomId);
      if (!server || !channel) return;
      startupRestoreHandled.current = userId;
      setDMActive(false);
      setActiveServer(server.id);
      origSetActiveChannel(channel.matrix_room_id);
    } catch {
      startupRestoreHandled.current = userId;
    }
  }, [serversLoaded, userId, servers, setDMActive, setActiveServer, origSetActiveChannel]);

  useEffect(() => {
    if (accessToken && activeServerId) {
      loadMembers(activeServerId, accessToken);
    }
  }, [accessToken, activeServerId, loadMembers]);

  // When selecting a channel on mobile, auto-switch to chat view
  const handleMobileChannelSelect = useCallback((roomId: string) => {
    origSetActiveChannel(roomId);
    setMobileView("chat");
  }, [origSetActiveChannel]);

  // When selecting a DM on mobile, switch to chat view
  const handleMobileDMSelect = useCallback((roomId: string) => {
    setActiveDM(roomId);
    setMobileView("chat");
  }, [setActiveDM]);

  /* ── TASK 26: Mobile dashboard quick actions ── */

  // 1) Reconnect to last channel: read persisted last (server, channel) and
  //    restore it; falls back to the first text channel of the first server
  //    if nothing is persisted.
  const handleReconnectLastChannel = useCallback(() => {
    setDashboardSheetOpen(false);
    try {
      const raw = localStorage.getItem(lastChannelStorageKey(userId));
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
  }, [servers, origSetActiveChannel, setActiveServer, setDMActive, addToast, userId]);

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

  useEffect(() => {
    if (settingsOpen || serverSettingsId) {
      setDesktopAccountPopoverOpen(false);
    }
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
    const showSidebar = !sidebarCollapsed;

    return (
      <div className="h-full w-full min-h-0 min-w-0 flex overflow-hidden bg-surface text-on-surface">
        {/* LEFT STACK — sidebar columns. Collapses to zero width when hidden. */}
        {showSidebar && (
          <div className="flex h-full min-h-0 flex-shrink-0 bg-surface">
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface">
              <div className="flex min-h-0 flex-1">
                <div className="w-[41px] mr-[2px] flex-shrink-0">
                  <SilentBoundary>
                    <SourcesPanel
                      onAddSource={openAddSource}
                      onSourceOpen={openSourceBrowser}
                      onExplore={openExplore}
                    />
                  </SilentBoundary>
                </div>

                <SilentBoundary>
                  <ServerSidebar />
                </SilentBoundary>

                {/* Channel / DM sidebar */}
                <div className="flex min-h-0" style={{ width: sidebarWidth, minWidth: SIDEBAR_MIN, maxWidth: SIDEBAR_MAX }}>
                  <SilentBoundary>
                    {dmActive ? <DMSidebar /> : <ChannelSidebar onServerTitleClick={() => {
                      if (activeServerId) setStatsTarget({ type: "server", serverId: activeServerId });
                    }} />}
                  </SilentBoundary>
                </div>
              </div>

              {userId && (
                <SilentBoundary>
                  <UserBar userId={userId} logout={logout} />
                </SilentBoundary>
              )}
            </div>

            {/* Resize handle */}
            <div
              onMouseDown={handleResizeStart}
              className="w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0"
            />
          </div>
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
    <div className="h-full w-full min-h-0 min-w-0 flex flex-col overflow-hidden bg-surface text-on-surface">
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
          <TopBarIconButton icon="bar_chart" label="Your stats" onClick={() => setStatsTarget({ type: "user" })} />
          <TopBarIconButton icon="bug_report" label="Report a bug" onClick={() => setShowBugReport(true)} />
        </div>
        <div className="flex min-[361px]:hidden flex-shrink-0">
          <TopBarOverflowMenu
            onHelp={() => setShowHelp(true)}
            onStats={() => setStatsTarget({ type: "user" })}
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
                  onExplore={openExplore}
                  onSourceOpen={openSourceBrowser}
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
          if (view === "settings") {
            if (mobileView === "settings" || settingsOpen || serverSettingsId) {
              closeServerSettings();
              closeSettings();
              setMobileView("chat");
              return;
            }
            openSettings();
          }
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
    const showInlineAccountBanner = Boolean(userId && sidebarCollapsed);

    if (settingsOpen) {
      return (
        <>
          <div className="h-12 flex items-center px-4 justify-between bg-surface-container-low flex-shrink-0">
            <h2 className="font-headline font-semibold">Settings</h2>
            <button
              onClick={() => {
                closeServerSettings();
                closeSettings();
              }}
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
                {showInlineAccountBanner && (
                  <DesktopAccountButton
                    desktopAccountRef={desktopAccountRef}
                    open={desktopAccountPopoverOpen}
                    userId={userId}
                    accessToken={accessToken}
                    onToggle={() => setDesktopAccountPopoverOpen((open) => !open)}
                    onClose={() => setDesktopAccountPopoverOpen(false)}
                    onOpenSettings={() => {
                      setDesktopAccountPopoverOpen(false);
                      openSettings("profile");
                    }}
                    onOpenStats={() => {
                      setDesktopAccountPopoverOpen(false);
                      setStatsTarget({ type: "user" });
                    }}
                  />
                )}
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
                {showInlineAccountBanner && (
                  <DesktopAccountButton
                    desktopAccountRef={desktopAccountRef}
                    open={desktopAccountPopoverOpen}
                    userId={userId}
                    accessToken={accessToken}
                    onToggle={() => setDesktopAccountPopoverOpen((open) => !open)}
                    onClose={() => setDesktopAccountPopoverOpen(false)}
                    onOpenSettings={() => {
                      setDesktopAccountPopoverOpen(false);
                      openSettings("profile");
                    }}
                    onOpenStats={() => {
                      setDesktopAccountPopoverOpen(false);
                      setStatsTarget({ type: "user" });
                    }}
                  />
                )}
              </div>
            ) : activeChannelId ? (
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-[#5865F2] material-symbols-outlined text-base">hub</span>
                <h2 className="font-headline font-semibold truncate">
                  {client?.getRoom(activeChannelId)?.name ?? activeChannelId}
                </h2>
                {showInlineAccountBanner && (
                  <DesktopAccountButton
                    desktopAccountRef={desktopAccountRef}
                    open={desktopAccountPopoverOpen}
                    userId={userId}
                    accessToken={accessToken}
                    onToggle={() => setDesktopAccountPopoverOpen((open) => !open)}
                    onClose={() => setDesktopAccountPopoverOpen(false)}
                    onOpenSettings={() => {
                      setDesktopAccountPopoverOpen(false);
                      openSettings("profile");
                    }}
                    onOpenStats={() => {
                      setDesktopAccountPopoverOpen(false);
                      setStatsTarget({ type: "user" });
                    }}
                  />
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
            {!dmActive && !activeChannelId && showInlineAccountBanner && (
              <DesktopAccountButton
                desktopAccountRef={desktopAccountRef}
                open={desktopAccountPopoverOpen}
                userId={userId}
                accessToken={accessToken}
                onToggle={() => setDesktopAccountPopoverOpen((open) => !open)}
                onClose={() => setDesktopAccountPopoverOpen(false)}
                onOpenSettings={() => {
                  setDesktopAccountPopoverOpen(false);
                  openSettings("profile");
                }}
                onOpenStats={() => {
                  setDesktopAccountPopoverOpen(false);
                  setStatsTarget({ type: "user" });
                }}
              />
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
                  <TopBarIconButton icon="bar_chart" label="Your stats" onClick={() => setStatsTarget({ type: "user" })} />
              <TopBarIconButton icon="bug_report" label="Report a bug" onClick={() => setShowBugReport(true)} />
              {/* Sidebar toggle */}
              <TopBarIconButton
                icon={sidebarCollapsed ? "left_panel_open" : "left_panel_close"}
                label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                onClick={() => setSidebarCollapsed((c) => !c)}
              />
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
                surfaces={activeExtension.surfaces}
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
            emptyState={emptyState}
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

    // Bridged room (e.g. Discord portal) — active channel ID is set but
    // the room isn't part of any loaded server/space yet. Render full chat
    // so the user can see and send messages immediately after linking.
    if (activeChannelId && !activeChannel) {
      const room = client?.getRoom(activeChannelId);
      const roomName = room?.name ?? activeChannelId;
      const roomReady = !!room;
      return (
        <div className="flex-1 flex flex-col min-h-0">
          {!roomReady && (
            <div className="px-4 py-3 bg-[#5865F2]/10 border-b border-[#5865F2]/20 flex items-center gap-2 flex-shrink-0">
              <span className="inline-block w-3 h-3 border-2 border-[#5865F2] border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-on-surface-variant">Loading bridged room…</span>
            </div>
          )}
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
            emptyState={emptyState}
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
            roomName={roomName}
          />
        </div>
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
            emptyState={emptyState}
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
    <div className="h-full w-full min-h-0 min-w-0 flex overflow-hidden bg-surface text-on-surface tv-layout" data-concord-layout="tv">
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
        <div className="h-full w-full min-h-0 min-w-0" data-concord-layout="tablet">
          {renderDesktopLayout()}
        </div>
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden md:block h-full w-full min-h-0 min-w-0" data-concord-layout="desktop">
            {renderDesktopLayout()}
          </div>
          {/* Mobile */}
          <div className="md:hidden h-full w-full min-h-0 min-w-0" data-concord-layout="mobile">
            {renderMobileLayout()}
          </div>
        </>
      )}

      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} />}
      {statsTarget && (
        <StatsModal
          onClose={() => setStatsTarget(null)}
          serverId={statsTarget.type === "server" ? statsTarget.serverId : undefined}
        />
      )}
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
      {/* Source browser — opened by clicking a source tile */}
      {sourceBrowserSourceId && (() => {
        const source = sources.find((s) => s.id === sourceBrowserSourceId);
        const platform = source?.platform ?? "concord";
        if (platform === "discord-bot" || platform === "discord-account") {
          return (
            <DiscordSourceBrowser
              onClose={() => setSourceBrowserSourceId(null)}
            />
          );
        }
        // Generic source browser for Concord/Matrix sources
        return (
          <SourceServerBrowser
            source={source}
            onClose={() => setSourceBrowserSourceId(null)}
          />
        );
      })()}
    </>
  );
}

/* ── Source Server Browser (generic, non-Discord) ── */
function SourceServerBrowser({
  source,
  onClose,
}: {
  source?: ConcordSource;
  onClose: () => void;
}) {
  const servers = useServerStore((s) => s.servers);
  const loadServers = useServerStore((s) => s.loadServers);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const setDMActive = useDMStore((s) => s.setDMActive);
  const client = useAuthStore((s) => s.client);
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);
  const addToast = useToastStore((s) => s.addToast);
  const updateSource = useSourcesStore((s) => s.updateSource);
  const label = source?.instanceName ?? source?.host ?? "Source";
  const sourceBrand = inferSourceBrand({
    platform: source?.platform,
    host: source?.host,
    instanceName: source?.instanceName,
    serverName: source?.serverName,
  });
  const [publicRooms, setPublicRooms] = useState<IPublicRoomsChunkRoom[]>([]);
  const [publicRoomsLoading, setPublicRoomsLoading] = useState(false);
  const [publicRoomsError, setPublicRoomsError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);

  // Only show servers whose rooms belong to this source's host
  const sourceServers = useMemo(
    () =>
      servers.filter((server) => {
        if (server.bridgeType) return false;
        if (server.federated) return false;
        const roomId = server.channels?.[0]?.matrix_room_id ?? "";
        const roomHost = roomId.split(":")[1]?.toLowerCase() ?? "";
        return !!source && sourceMatchesMatrixDomain(source, roomHost);
      }),
    [servers, source],
  );

  useEffect(() => {
    if (!source || source.platform !== "matrix" || source.authFlows?.length) return;
    let cancelled = false;
    import("../../api/matrix")
      .then(({ fetchLoginFlows }) => fetchLoginFlows(source.homeserverUrl))
      .then((flows) => {
        if (!cancelled) updateSource(source.id, { authFlows: flows, authError: undefined });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, updateSource]);

  const loadSourceDirectory = useCallback(async () => {
    if (!source || source.platform !== "matrix") return;
    setPublicRoomsLoading(true);
    setPublicRoomsError(null);
    setAuthRequired(false);
    try {
      const sdk = await import("matrix-js-sdk");
      const browseClient =
        source.accessToken && source.userId && source.deviceId
          ? sdk.createClient({
              baseUrl: source.homeserverUrl,
              accessToken: source.accessToken,
              userId: source.userId,
              deviceId: source.deviceId,
            })
          : sdk.createClient({ baseUrl: source.homeserverUrl });
      const localDomain = userId?.split(":")[1]?.toLowerCase() ?? null;
      const useLocalDirectory =
        localDomain != null && sourceMatchesMatrixDomain(source, localDomain);
      const response = await browseClient.publicRooms(
        useLocalDirectory
          ? { limit: 50 }
          : {
              server: source.serverName ?? source.host,
              limit: 50,
            },
      );
      setPublicRooms(
        [...(response.chunk ?? [])].sort((a, b) =>
          (b.num_joined_members ?? 0) - (a.num_joined_members ?? 0),
        ),
      );
      updateSource(source.id, { authError: undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load public rooms";
      setPublicRoomsError(message);
      setAuthRequired(
        /M_FORBIDDEN|M_UNKNOWN_TOKEN|401|403|restricted|forbidden|unknown token/i.test(
          message,
        ),
      );
      updateSource(source.id, {
        authError: message,
        status: source.accessToken ? "error" : "disconnected",
      });
    } finally {
      setPublicRoomsLoading(false);
    }
  }, [source, updateSource, userId]);

  useEffect(() => {
    if (source?.platform !== "matrix") return;
    loadSourceDirectory();
  }, [source?.id, source?.platform, loadSourceDirectory]);

  const handlePasswordLogin = useCallback(async () => {
    if (!source || !authUsername.trim() || !authPassword) return;
    setAuthBusy(true);
    setPublicRoomsError(null);
    try {
      const { loginWithPasswordAtBaseUrl } = await import("../../api/matrix");
      const session = await loginWithPasswordAtBaseUrl(
        source.homeserverUrl,
        authUsername.trim(),
        authPassword,
      );
      updateSource(source.id, {
        accessToken: session.accessToken,
        userId: session.userId,
        deviceId: session.deviceId,
        authError: undefined,
        status: "connected",
      });
      setAuthPassword("");
      addToast(`Connected ${label}`, "success");
      await loadSourceDirectory();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sign in";
      setPublicRoomsError(message);
      updateSource(source.id, { authError: message, status: "error" });
    } finally {
      setAuthBusy(false);
    }
  }, [addToast, authPassword, authUsername, label, loadSourceDirectory, source, updateSource]);

  const handleSsoLogin = useCallback(async () => {
    if (!source) return;
    const { buildSsoRedirectUrl } = await import("../../api/matrix");
    const redirectUrl = new URL(window.location.href);
    redirectUrl.searchParams.delete("loginToken");
    redirectUrl.searchParams.set("source_sso", "1");
    writePendingSourceSso({
      sourceId: source.id,
      homeserverUrl: source.homeserverUrl,
    });
    window.location.assign(
      buildSsoRedirectUrl(source.homeserverUrl, redirectUrl.toString()),
    );
  }, [source]);

  const handleJoinRoom = useCallback(
    async (room: IPublicRoomsChunkRoom) => {
      if (!client || !source) return;
      const target = room.canonical_alias ?? room.room_id;
      const viaServer =
        room.canonical_alias?.split(":")[1] ??
        room.room_id.split(":")[1] ??
        source.serverName ??
        source.host;
      setJoiningRoomId(room.room_id);
      try {
        const localDomain = userId?.split(":")[1]?.toLowerCase() ?? null;
        const joinOptions =
          localDomain && viaServer.toLowerCase() === localDomain
            ? {}
            : { viaServers: [viaServer] };
        await client.joinRoom(target, joinOptions);
        if (accessToken) await loadServers(accessToken);
        addToast(`Connected ${room.name ?? target}`, "success");
        onClose();
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Failed to connect room", "error");
      } finally {
        setJoiningRoomId(null);
      }
    },
    [accessToken, addToast, client, loadServers, onClose, source, userId],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-surface-container rounded-2xl border border-outline-variant/20 shadow-2xl p-6 max-h-[85vh] flex flex-col">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
            <SourceBrandIcon
              brand={sourceBrand}
              size={20}
              className={
                sourceBrand === "discord"
                  ? "text-[#5865F2]"
                  : sourceBrand === "matrix"
                    ? "text-on-surface"
                    : undefined
              }
            />
          </div>
          <h2 className="flex-1 text-lg font-headline font-semibold text-on-surface">{label}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
          <div className="space-y-5">
            {source?.platform === "matrix" && (
              <div className="rounded-xl border border-outline-variant/20 bg-surface-container-high/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-on-surface">
                      {source.userId ? `Signed in as ${source.userId}` : "Source login"}
                    </p>
                    <p className="mt-1 text-xs text-on-surface-variant break-all">
                      {source.serverName ?? source.host} via {source.homeserverUrl}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={loadSourceDirectory}
                    disabled={publicRoomsLoading}
                    className="px-3 py-1.5 rounded-lg bg-surface text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest text-xs transition-colors disabled:opacity-40"
                  >
                    Refresh
                  </button>
                </div>

                {(authRequired || !source.accessToken) && (
                  <div className="mt-4 space-y-3">
                    <p className="text-xs text-on-surface-variant">
                      This source can browse more rooms after you sign in. Concord still joins rooms through your current Concord session.
                    </p>
                    {(source.authFlows ?? []).includes("password") && (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={authUsername}
                          onChange={(event) => setAuthUsername(event.target.value)}
                          placeholder="Matrix username"
                          className="w-full px-3 py-2 bg-surface rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
                        />
                        <input
                          type="password"
                          value={authPassword}
                          onChange={(event) => setAuthPassword(event.target.value)}
                          placeholder="Password"
                          className="w-full px-3 py-2 bg-surface rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={handlePasswordLogin}
                          disabled={authBusy || !authUsername.trim() || !authPassword}
                          className="w-full py-2 rounded-lg bg-primary text-on-primary text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
                        >
                          {authBusy ? "Signing in..." : "Sign in with password"}
                        </button>
                      </div>
                    )}
                    {(source.authFlows ?? []).includes("sso") && (
                      <button
                        type="button"
                        onClick={handleSsoLogin}
                        className="w-full py-2 rounded-lg bg-secondary/15 text-secondary text-sm font-medium hover:bg-secondary/20 transition-colors"
                      >
                        Continue with SSO
                      </button>
                    )}
                  </div>
                )}
                {publicRoomsError && (
                  <p className="mt-3 text-xs text-error">{publicRoomsError}</p>
                )}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                  Connected in Concord
                </p>
                <span className="text-xs text-on-surface-variant">
                  {sourceServers.length}
                </span>
              </div>
              {sourceServers.length === 0 ? (
                <p className="text-sm text-on-surface-variant text-center py-4">No connected rooms yet</p>
              ) : (
                <div className="space-y-0.5">
                  {sourceServers.map((srv) => (
                    <button
                      key={srv.id}
                      onClick={() => {
                        setDMActive(false);
                        setActiveServer(srv.id);
                        onClose();
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-primary/10 text-left group transition-colors"
                    >
                      <span className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary text-xs font-bold flex-shrink-0">
                        {srv.abbreviation || srv.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="text-sm text-on-surface group-hover:text-primary transition-colors">
                        {srv.name}
                      </span>
                      <span className="text-xs text-on-surface-variant ml-auto">{srv.channels.length} ch</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {source?.platform === "matrix" && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                    Public rooms
                  </p>
                  <span className="text-xs text-on-surface-variant">
                    {publicRoomsLoading ? "Loading..." : publicRooms.length}
                  </span>
                </div>
                {publicRoomsLoading ? (
                  <p className="text-sm text-on-surface-variant text-center py-6">Loading rooms…</p>
                ) : publicRooms.length === 0 ? (
                  <p className="text-sm text-on-surface-variant text-center py-6">
                    {publicRoomsError ? "Directory unavailable" : "No public rooms returned"}
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {publicRooms.map((room) => (
                      <button
                        key={room.room_id}
                        onClick={() => handleJoinRoom(room)}
                        disabled={joiningRoomId === room.room_id}
                        className="w-full flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-secondary/10 text-left group transition-colors disabled:opacity-50"
                      >
                        <div className="w-8 h-8 rounded-lg bg-secondary/12 ring-1 ring-secondary/20 flex items-center justify-center text-secondary text-xs font-bold flex-shrink-0">
                          {(room.name ?? "#").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="text-sm text-on-surface group-hover:text-secondary transition-colors block truncate">
                            {room.name ?? room.canonical_alias ?? room.room_id}
                          </span>
                          <span className="text-[11px] text-on-surface-variant block truncate">
                            {room.canonical_alias ?? room.room_id}
                          </span>
                        </div>
                        <span className="text-[11px] text-on-surface-variant flex-shrink-0">
                          {joiningRoomId === room.room_id
                            ? "Connecting..."
                            : `${room.num_joined_members ?? 0}`}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatVoiceSummary(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function UserStatsPopover({
  accessToken,
  userId,
  onClose,
  onOpenSettings,
  onOpenStats,
}: {
  accessToken: string | null;
  userId: string;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenStats: () => void;
}) {
  const [stats, setStats] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(() => Boolean(accessToken));

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    getMyStats(accessToken, 14)
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const username = userId.split(":")[0].replace("@", "");
  const activeSinceLabel = stats?.active_since
    ? new Date(stats.active_since).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "No activity yet";

  return (
    <div className="absolute right-0 top-full mt-2 z-40 w-72 glass-panel rounded-2xl border border-outline-variant/20 p-4 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-label uppercase tracking-widest text-on-surface-variant/70">
            Account
          </p>
          <p className="mt-1 text-sm font-headline font-semibold text-on-surface truncate">
            {username}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn-press w-8 h-8 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          aria-label="Close account panel"
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      </div>

      <div className="mt-4 rounded-xl bg-surface-container-high/60 border border-outline-variant/10 p-3">
        {loading ? (
          <p className="text-xs text-on-surface-variant">Loading your stats…</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-surface-container px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-on-surface-variant/70">
                  Messages
                </p>
                <p className="mt-1 text-lg font-semibold text-on-surface">
                  {stats?.total_messages ?? 0}
                </p>
              </div>
              <div className="rounded-lg bg-surface-container px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-on-surface-variant/70">
                  Voice
                </p>
                <p className="mt-1 text-lg font-semibold text-on-surface">
                  {formatVoiceSummary(stats?.total_voice_seconds ?? 0)}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-on-surface-variant">Active since</span>
              <span className="text-on-surface">{activeSinceLabel}</span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex-1 px-3 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Open settings
        </button>
        <button
          type="button"
          onClick={onOpenStats}
          className="px-3 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium hover:bg-surface-container-highest transition-colors"
        >
          Full stats
        </button>
      </div>
    </div>
  );
}

function DesktopAccountButton({
  desktopAccountRef,
  open,
  userId,
  accessToken,
  onToggle,
  onClose,
  onOpenSettings,
  onOpenStats,
}: {
  desktopAccountRef: { current: HTMLDivElement | null };
  open: boolean;
  userId: string | null;
  accessToken: string | null;
  onToggle: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenStats: () => void;
}) {
  if (!userId) return null;
  return (
    <div ref={desktopAccountRef} className="relative ml-2 flex-shrink-0">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 hover:bg-surface-container-high rounded-lg px-2 py-1 transition-colors"
        title="Account"
      >
        <Avatar userId={userId} size="sm" showPresence />
        <span className="text-xs text-on-surface-variant truncate max-w-[80px]">
          {userId.split(":")[0].replace("@", "")}
        </span>
        <span className="material-symbols-outlined text-sm text-on-surface-variant/70">
          expand_more
        </span>
      </button>
      {open && (
        <UserStatsPopover
          accessToken={accessToken}
          userId={userId}
          onClose={onClose}
          onOpenSettings={onOpenSettings}
          onOpenStats={onOpenStats}
        />
      )}
    </div>
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
  type Screen =
    | "pick"
    | "concord"
    | "matrix"
    | "matrix-auth"
    | "discord"
    | "discord-bot"
    | "discord-account"
    | "validating"
    | "error";

  const [screen, setScreen] = useState<Screen>("pick");
  const [error, setError] = useState("");

  // Concord form state
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");

  // Matrix form state
  const [matrixHost, setMatrixHost] = useState("");
  const [matrixUsername, setMatrixUsername] = useState("");
  const [matrixPassword, setMatrixPassword] = useState("");
  const [matrixDraft, setMatrixDraft] = useState<MatrixSourceDraft | null>(null);

  const addSource = useSourcesStore((s) => s.addSource);
  const updateSource = useSourcesStore((s) => s.updateSource);
  const sources = useSourcesStore((s) => s.sources);
  const accessToken = useAuthStore((s) => s.accessToken);
  const resumeHandled = useRef(false);

  useEffect(() => {
    if (resumeHandled.current) return;
    const pending = readPendingSourceSso();
    const loginToken = new URLSearchParams(window.location.search).get("loginToken");
    if (!pending || !loginToken) return;
    resumeHandled.current = true;
    setScreen("validating");
    import("../../api/matrix")
      .then(({ loginWithTokenAtBaseUrl }) =>
        loginWithTokenAtBaseUrl(pending.homeserverUrl, loginToken),
      )
      .then((session) => {
        updateSource(pending.sourceId, {
          accessToken: session.accessToken,
          userId: session.userId,
          deviceId: session.deviceId,
          authError: undefined,
          status: "connected",
        });
        clearPendingSourceSso();
        clearPendingSourceSsoQueryParams();
        onSourceAdded();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Source login failed";
        updateSource(pending.sourceId, { authError: message, status: "error" });
        clearPendingSourceSso();
        clearPendingSourceSsoQueryParams();
        setError(message);
        setScreen("error");
      });
  }, [onSourceAdded, updateSource]);

  const handleConnectConcord = async () => {
    const trimmed = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!trimmed) { setError("Enter a hostname"); setScreen("error"); return; }
    if (!token.trim()) { setError("Enter an invite token"); setScreen("error"); return; }
    setScreen("validating");
    try {
      const { discoverHomeserver } = await import("../../api/wellKnown");
      const config = await discoverHomeserver(trimmed);
      const validateUrl = `${config.api_base}/invites/validate/${encodeURIComponent(token.trim())}`;
      const validateRes = await fetch(validateUrl, { credentials: "omit" });
      if (!validateRes.ok) throw new Error("Token validation failed");
      const validation = await validateRes.json();
      if (!validation.valid) throw new Error("Invalid or expired invite token");
      addSource({
        host: trimmed,
        instanceName: config.instance_name,
        inviteToken: token.trim(),
        apiBase: config.api_base,
        homeserverUrl: config.homeserver_url,
        status: "connected",
        enabled: true,
        platform: "concord",
      });
      onSourceAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach that host");
      setScreen("error");
    }
  };

  const handleDiscoverMatrix = async () => {
    const trimmed = matrixHost.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!trimmed) {
      setError("Enter a Matrix homeserver");
      setScreen("error");
      return;
    }
    setScreen("validating");
    try {
      const [{ discoverHomeserver }, { fetchLoginFlows }] = await Promise.all([
        import("../../api/wellKnown"),
        import("../../api/matrix"),
      ]);
      const config = await discoverHomeserver(trimmed);
      const flows = await fetchLoginFlows(config.homeserver_url);
      setMatrixDraft(buildMatrixSourceDraft(trimmed, config, flows));
      setMatrixUsername("");
      setMatrixPassword("");
      setScreen("matrix-auth");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach that homeserver");
      setScreen("error");
    }
  };

  const handleDiscoverPresetMatrix = async (presetHost: string) => {
    setMatrixHost(presetHost);
    const trimmed = presetHost.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!trimmed) return;
    setScreen("validating");
    try {
      const [{ discoverHomeserver }, { fetchLoginFlows }] = await Promise.all([
        import("../../api/wellKnown"),
        import("../../api/matrix"),
      ]);
      const config = await discoverHomeserver(trimmed);
      const flows = await fetchLoginFlows(config.homeserver_url);
      setMatrixDraft(buildMatrixSourceDraft(trimmed, config, flows));
      setMatrixUsername("");
      setMatrixPassword("");
      setScreen("matrix-auth");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach that homeserver");
      setScreen("error");
    }
  };

  const handleMatrixPasswordLogin = async () => {
    if (!matrixDraft || !matrixUsername.trim() || !matrixPassword) return;
    setScreen("validating");
    try {
      const { loginWithPasswordAtBaseUrl } = await import("../../api/matrix");
      const session = await loginWithPasswordAtBaseUrl(
        matrixDraft.homeserverUrl,
        matrixUsername.trim(),
        matrixPassword,
      );
      upsertMatrixSourceRecord({
        sources,
        addSource,
        updateSource,
        draft: matrixDraft,
        session,
      });
      onSourceAdded();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Source login failed";
      setError(message);
      setScreen("error");
    }
  };

  const handleMatrixSsoLogin = async () => {
    if (!matrixDraft) return;
    try {
      const { buildSsoRedirectUrl } = await import("../../api/matrix");
      const sourceId = upsertMatrixSourceRecord({
        sources,
        addSource,
        updateSource,
        draft: matrixDraft,
      });
      writePendingSourceSso({
        sourceId,
        homeserverUrl: matrixDraft.homeserverUrl,
      });
      const redirectUrl = new URL(window.location.href);
      redirectUrl.searchParams.delete("loginToken");
      redirectUrl.searchParams.set("source_sso", "1");
      window.location.assign(
        buildSsoRedirectUrl(matrixDraft.homeserverUrl, redirectUrl.toString()),
      );
    } catch (err) {
      clearPendingSourceSso();
      setError(err instanceof Error ? err.message : "Unable to start SSO");
      setScreen("error");
    }
  };

  const handleCheckDiscordBridge = async () => {
    setScreen("validating");
    try {
      if (!accessToken) throw new Error("Not logged in");
      const { discordBridgeHttpStatus } = await import("../../api/bridges");
      const status = await discordBridgeHttpStatus(accessToken);
      if (!status.enabled) {
        setError(
          "The Discord bridge is not enabled. Go to Settings → Bridges to enable it first.",
        );
        setScreen("error");
        return;
      }
      // Bridge is running — add/update the discord-bot source
      const { useSourcesStore: sStore } = await import("../../stores/sources");
      const existing = sStore
        .getState()
        .sources.find((s) => s.platform === "discord-bot");
      if (!existing) {
        sStore.getState().addSource({
          host: "discord-bridge",
          instanceName: "Discord (Bot Bridge)",
          inviteToken: "",
          apiBase: "",
          homeserverUrl: "",
          status: "connected",
          enabled: true,
          platform: "discord-bot",
        });
      }
      onSourceAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check bridge status");
      setScreen("error");
    }
  };

  const back = () => setScreen("pick");

  // Shared close button header
  const Header = ({ title, onBack }: { title: string; onBack?: () => void }) => (
    <div className="flex items-center gap-3 mb-6">
      {onBack && (
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
        </button>
      )}
      <h2 className="flex-1 text-lg font-headline font-semibold text-on-surface">{title}</h2>
      <button
        onClick={onClose}
        className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high transition-colors"
      >
        <span className="material-symbols-outlined text-lg">close</span>
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 bg-surface-container rounded-2xl border border-outline-variant/20 shadow-2xl p-6">

        {/* ── Screen: pick ── */}
        {screen === "pick" && (
          <>
            <Header title="Explore Sources" />
            <div className="space-y-3">
              <button
                onClick={() => setScreen("concord")}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/20 hover:border-primary/40 hover:bg-surface-container-high transition-all text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                  <SourceBrandIcon brand="concord" size={24} />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Concord Instance</p>
                  <p className="text-xs text-on-surface-variant">Connect to another Concord domain with an invite token</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/40 ml-auto group-hover:text-on-surface-variant">chevron_right</span>
              </button>

              <button
                onClick={() => void handleDiscoverPresetMatrix("matrix.org")}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/20 hover:border-teal-500/40 hover:bg-surface-container-high transition-all text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                  <SourceBrandIcon brand="matrix" size={24} className="text-on-surface" />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">matrix.org</p>
                  <p className="text-xs text-on-surface-variant">Discover public rooms with Matrix login flows</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/40 ml-auto group-hover:text-on-surface-variant">chevron_right</span>
              </button>

              <button
                onClick={() => void handleDiscoverPresetMatrix("chat.mozilla.org")}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/20 hover:border-orange-500/40 hover:bg-surface-container-high transition-all text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                  <SourceBrandIcon brand="mozilla" size={24} />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Mozilla</p>
                  <p className="text-xs text-on-surface-variant">Use Mozilla&apos;s delegated Matrix login</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/40 ml-auto group-hover:text-on-surface-variant">chevron_right</span>
              </button>

              <button
                onClick={() => setScreen("matrix")}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/20 hover:border-teal-500/40 hover:bg-surface-container-high transition-all text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                  <SourceBrandIcon brand="matrix" size={24} className="text-on-surface" />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Custom Matrix Homeserver</p>
                  <p className="text-xs text-on-surface-variant">Enter any Matrix domain manually</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/40 ml-auto group-hover:text-on-surface-variant">chevron_right</span>
              </button>

              <button
                onClick={() => setScreen("discord")}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/20 hover:border-[#5865F2]/40 hover:bg-surface-container-high transition-all text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                  <SourceBrandIcon brand="discord" size={24} className="text-[#5865F2]" />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Discord</p>
                  <p className="text-xs text-on-surface-variant">Bridge guilds or connect your account</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/40 ml-auto group-hover:text-on-surface-variant">chevron_right</span>
              </button>

              <button
                type="button"
                disabled
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/10 bg-surface-container/40 text-left opacity-60 cursor-not-allowed"
              >
                <div className="w-10 h-10 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-on-surface-variant">forum</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-on-surface">Slack</p>
                  <p className="text-xs text-on-surface-variant">Preloaded release target</p>
                </div>
                <span className="text-[10px] uppercase tracking-wider text-on-surface-variant font-label">Soon</span>
              </button>

              <button
                type="button"
                disabled
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/10 bg-surface-container/40 text-left opacity-60 cursor-not-allowed"
              >
                <div className="w-10 h-10 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-on-surface-variant">sensors</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-on-surface">Reticulum</p>
                  <p className="text-xs text-on-surface-variant">Preloaded release target</p>
                </div>
                <span className="text-[10px] uppercase tracking-wider text-on-surface-variant font-label">Soon</span>
              </button>
            </div>
          </>
        )}

        {/* ── Screen: concord ── */}
        {screen === "concord" && (
          <>
            <Header title="Concord Instance" onBack={back} />
            <div className="space-y-4">
              <div>
                <label className="text-xs font-label text-on-surface-variant mb-1.5 block">Hostname</label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="chat.example.com"
                  className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-label text-on-surface-variant mb-1.5 block">Invite Token</label>
                <input
                  type="text"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="inv_..."
                  className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <button
                onClick={handleConnectConcord}
                disabled={!host.trim() || !token.trim()}
                className="w-full py-2.5 bg-primary text-on-primary rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors"
              >
                Connect
              </button>
            </div>
          </>
        )}

        {/* ── Screen: matrix ── */}
        {screen === "matrix" && (
          <>
            <Header title="Matrix Network" onBack={back} />
            <div className="space-y-4">
              <p className="text-xs text-on-surface-variant">
                Add a Matrix homeserver, discover its login methods, and use that account for remote room discovery.
              </p>
              <div>
                <label className="text-xs font-label text-on-surface-variant mb-1.5 block">Homeserver</label>
                <input
                  type="text"
                  value={matrixHost}
                  onChange={(e) => setMatrixHost(e.target.value)}
                  placeholder="matrix.org"
                  className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <button
                onClick={handleDiscoverMatrix}
                disabled={!matrixHost.trim()}
                className="w-full py-2.5 bg-teal-700 text-white rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-teal-600 transition-colors"
              >
                Continue
              </button>
            </div>
          </>
        )}

        {screen === "matrix-auth" && matrixDraft && (
          <>
            <Header title={inferSourceBrand({ host: matrixDraft.host, serverName: matrixDraft.serverName }) === "mozilla" ? "Mozilla Source" : "Matrix Source"} onBack={() => setScreen("matrix")} />
            <div className="space-y-4">
              <div className="rounded-xl border border-outline-variant/20 bg-surface-container-high/60 p-4 space-y-2">
                <p className="text-sm font-medium text-on-surface">{matrixDraft.instanceName}</p>
                <p className="text-xs text-on-surface-variant break-all">
                  {matrixDraft.serverName ?? matrixDraft.host} via {matrixDraft.homeserverUrl}
                </p>
                <p className="text-xs text-on-surface-variant">
                  Available login methods: {matrixDraft.authFlows.length > 0 ? matrixDraft.authFlows.join(", ") : "none advertised"}
                </p>
              </div>

              {matrixDraft.authFlows.includes("password") && (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={matrixUsername}
                    onChange={(event) => setMatrixUsername(event.target.value)}
                    placeholder="Matrix username"
                    className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
                  />
                  <input
                    type="password"
                    value={matrixPassword}
                    onChange={(event) => setMatrixPassword(event.target.value)}
                    placeholder="Password"
                    className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
                  />
                  <button
                    onClick={handleMatrixPasswordLogin}
                    disabled={!matrixUsername.trim() || !matrixPassword}
                    className="w-full py-2.5 bg-primary text-on-primary rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors"
                  >
                    Sign in with password
                  </button>
                </div>
              )}

              {matrixDraft.authFlows.includes("sso") && (
                <button
                  onClick={handleMatrixSsoLogin}
                  className="w-full py-2.5 bg-secondary/15 text-secondary rounded-lg text-sm font-medium hover:bg-secondary/20 transition-colors"
                >
                  Continue with SSO
                </button>
              )}

              {!matrixDraft.authFlows.some((flow) => flow === "password" || flow === "sso") && (
                <p className="text-xs text-on-surface-variant">
                  This homeserver did not advertise an interactive login flow that Concord can complete here yet.
                </p>
              )}
            </div>
          </>
        )}

        {/* ── Screen: discord (sub-picker) ── */}
        {screen === "discord" && (
          <>
            <Header title="Connect Discord" onBack={back} />
            <div className="space-y-3">
              {/* Bot bridge */}
              <button
                onClick={handleCheckDiscordBridge}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/20 hover:border-[#5865F2]/40 hover:bg-surface-container-high transition-all text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-[#5865F2]/15 flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-[#5865F2] text-xl">videogame_asset</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Bot Bridge</p>
                  <p className="text-xs text-on-surface-variant">Bridge Discord servers via the server-side bot</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/40 ml-auto group-hover:text-on-surface-variant">chevron_right</span>
              </button>

              {/* Account login */}
              <button
                onClick={() => setScreen("discord-account")}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-outline-variant/20 hover:border-[#5865F2]/40 hover:bg-surface-container-high transition-all text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-[#5865F2]/15 flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-[#5865F2] text-xl">person_play</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Account Login</p>
                  <p className="text-xs text-on-surface-variant">Connect your personal Discord account via QR</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/40 ml-auto group-hover:text-on-surface-variant">chevron_right</span>
              </button>
            </div>
          </>
        )}

        {/* ── Screen: discord-account ── */}
        {screen === "discord-account" && (
          <>
            <Header title="Discord Account Login" onBack={() => setScreen("discord")} />
            <div className="space-y-3 text-xs text-on-surface-variant">
              <p>Connect your personal Discord account through the bridge bot. Messages will appear under your name, not the bot's.</p>
              <ol className="list-decimal list-inside space-y-2">
                <li>Open any Concord room and send a DM to <code className="bg-surface-container-highest px-1 py-0.5 rounded text-on-surface">@discordbot</code> with the message <strong>login</strong></li>
                <li>The bot will reply with a QR code</li>
                <li>In Discord on your phone: Settings → Advanced → Scan Login QR Code</li>
                <li>Scan the code — you're connected</li>
              </ol>
              <p className="text-on-surface-variant/60 italic">Your Discord token flows directly to the bridge. Concord never stores it.</p>
            </div>
            <button
              onClick={onClose}
              className="w-full mt-6 py-2.5 bg-surface-container-high text-on-surface rounded-lg text-sm font-medium hover:bg-surface-container-highest transition-colors"
            >
              Got it
            </button>
          </>
        )}

        {/* ── Screen: validating ── */}
        {screen === "validating" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <span className="inline-block w-6 h-6 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
            <p className="text-sm text-on-surface-variant">Connecting…</p>
          </div>
        )}

        {/* ── Screen: error ── */}
        {screen === "error" && (
          <>
            <Header title="Connection Failed" />
            <div className="rounded-lg bg-error/10 border border-error/20 px-4 py-3 mb-4">
              <p className="text-sm text-error">{error}</p>
            </div>
            <button
              onClick={back}
              className="w-full py-2.5 bg-surface-container-high text-on-surface rounded-lg text-sm font-medium hover:bg-surface-container-highest transition-colors"
            >
              Back
            </button>
          </>
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
