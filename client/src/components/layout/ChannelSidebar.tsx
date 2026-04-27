import { memo, useState, useMemo, type ReactNode } from "react";
import { useExtensionStore } from "../../stores/extension";
import { updateAppChannelAccess, type AppAccess } from "../../api/concord";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useServerStore } from "../../stores/server";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import { useSettingsStore } from "../../stores/settings";
import { Avatar } from "../ui/Avatar";
import { useUnreadCounts } from "../../hooks/useUnreadCounts";
import { useVoiceParticipants } from "../../hooks/useVoiceParticipants";
import { usePlatform } from "../../hooks/usePlatform";
import { InviteModal } from "../server/InviteModal";

interface ChannelSidebarProps {
  mobile?: boolean;
  onChannelSelect?: (roomId: string) => void;
  onServerTitleClick?: () => void;
}

const CHANNEL_ADMIN_TOGGLE_ICON = "edit";

export const ChannelSidebar = memo(function ChannelSidebar({ mobile: _mobile, onChannelSelect, onServerTitleClick }: ChannelSidebarProps) {
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const activeChannelId = useServerStore((s) => s.activeChannelId);
  const setActiveChannel = useServerStore((s) => s.setActiveChannel);
  const createChannelFn = useServerStore((s) => s.createChannel);
  const deleteChannelFn = useServerStore((s) => s.deleteChannel);
  const renameChannelFn = useServerStore((s) => s.renameChannel);
  const reorderChannelsFn = useServerStore((s) => s.reorderChannels);
  const startServerExtensionFn = useServerStore((s) => s.startServerExtension);
  const userId = useAuthStore((s) => s.userId);
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);

  // TV mode — a 10-foot rendering flag pulled from the platform hook.
  // When true, each channel row gets the `.tv-channel-item` class
  // (styled in `client/src/styles/tv.css`) plus DPAD focus attributes
  // so `useDpadNav({ group: "tv-main" })` can reach every row. The
  // non-TV path is untouched.
  const { isTV } = usePlatform();

  const unreadCounts = useUnreadCounts();

  const server = servers.find((s) => s.id === activeServerId);
  const voiceRoomIds = useMemo(
    () => (server?.channels ?? [])
      .filter((c) => c.channel_type === "voice")
      .map((c) => c.matrix_room_id),
    [server?.channels],
  );
  const voiceParticipants = useVoiceParticipants(voiceRoomIds);

  const extensionCatalog = useExtensionStore((s) => s.catalog);

  const [showNewChannel, setShowNewChannel] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice" | "app" | "place">("text");
  const [selectedExtensionId, setSelectedExtensionId] = useState<string>("");
  const [appAccess, setAppAccess] = useState<AppAccess>("all");
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [confirmDeleteChannelId, setConfirmDeleteChannelId] = useState<number | null>(null);
  // Tracks which launcher button is currently kicking off an app
  // channel — disables the button + shows a hourglass while the
  // POST /extensions/<id>/start round-trip is in flight.
  const [launchingExtensionId, setLaunchingExtensionId] = useState<string | null>(null);
  const [renamingChannelId, setRenamingChannelId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showAdminControls, setShowAdminControls] = useState(false);

  // dnd-kit sensors — PointerSensor with an activation distance so clicks
  // on the channel button still work for channel selection, rename, etc.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const openServerSettings = useSettingsStore((s) => s.openServerSettings);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const serverSettingsId = useSettingsStore((s) => s.serverSettingsId);
  const channelNotifications = useSettingsStore((s) => s.channelNotifications);
  const setChannelNotificationLevel = useSettingsStore((s) => s.setChannelNotificationLevel);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const closeServerSettings = useSettingsStore((s) => s.closeServerSettings);

  if (!server) {
    return (
      <div className="w-full flex flex-col min-h-0 bg-surface-container-low">
        <div className="flex-1 flex flex-col items-center justify-center px-4 gap-3">
          <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center">
            <span className="material-symbols-outlined text-on-surface-variant text-2xl">forum</span>
          </div>
          <p className="text-on-surface-variant text-sm text-center font-body">
            No server selected
          </p>
          <p className="text-on-surface-variant/50 text-xs text-center font-label">
            Use the <strong className="text-on-surface">+</strong> button to create or join a server
          </p>
        </div>
        {/* UserBar is now rendered by ChatLayout so it can span
            Sources + ServerSidebar + ChannelSidebar columns. Mobile
            still renders UserBar out of the account sheet / settings
            surface, not here — the drawer + tab-bar structure is a
            separate UX model. */}
      </div>
    );
  }

  const isOwner = server.owner_id === userId;
  // INS-053: non-admins can create channels when this flag is on
  const allowUserChannelCreation = server.allow_user_channel_creation ?? false;
  const canOpenSettings = true;
  const textChannels = server.channels.filter((c) => c.channel_type === "text");
  const voiceChannels = server.channels.filter((c) => c.channel_type === "voice");
  const appChannels = server.channels.filter((c) => c.channel_type === "app");
  const placeChannels = server.channels.filter((c) => c.channel_type === "place");

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelName.trim() || !accessToken) return;
    if (channelType === "app" && !selectedExtensionId) return;
    try {
      const extras = channelType === "app"
        ? { extension_id: selectedExtensionId, app_access: appAccess }
        : undefined;
      await createChannelFn(server.id, channelName.trim(), channelType, accessToken, extras);
      setChannelName("");
      setChannelType("text");
      setSelectedExtensionId("");
      setAppAccess("all");
      setShowNewChannel(false);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to create channel");
    }
  };

  // handleUpdateAppAccess was the toggle for "all" vs "admin_only"
  // on a manually-created app channel. v0.7.2 made app channels
  // ephemeral extension-lifecycle artifacts (no manual create, no
  // long-lived access policy) — the toggle has no surface left to
  // call it. The PATCH endpoint stays on the server for any future
  // re-introduction or external-API caller, but the UI bind is gone.
  void updateAppChannelAccess;

  const handleDeleteChannel = async (channelId: number) => {
    if (!accessToken) return;
    try {
      await deleteChannelFn(server.id, channelId, accessToken);
      addToast("Channel deleted", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to delete channel");
    }
    setConfirmDeleteChannelId(null);
  };

  /**
   * Click an Applications-launcher → POST /servers/<id>/extensions/<id>/start.
   * The server creates the app channel + Matrix room + invites every
   * member; we route the caller into the new room as soon as the
   * response lands so they see the extension immediately.
   *
   * Critical: we patch the new channel into the local server-store
   * BEFORE navigating. Without that the activeChannel lookup in
   * ChatLayout (``activeServer.channels.find(c => c.matrix_room_id ===
   * activeChannelId)``) returns undefined, the render falls into the
   * "bridged-room chat" branch instead of the app-channel branch, and
   * the user sees the chat view for an empty room — the "click attempts
   * to load and reverts" symptom from the live install. The reload
   * lets channelType propagate so isAppChannel === true on first paint.
   */
  const handleLaunchExtension = async (extensionId: string) => {
    if (!accessToken) return;
    setLaunchingExtensionId(extensionId);
    try {
      // The store action (startServerExtension) does the API call AND
      // the optimistic store patch in one step, so the next render
      // sees isAppChannel=true on the new channel.
      const channel = await startServerExtensionFn(server.id, extensionId, accessToken);
      handleChannelClick(channel.matrix_room_id);
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to start application",
        "error",
      );
    } finally {
      setLaunchingExtensionId(null);
    }
  };

  const startRenameChannel = (channelId: number, currentName: string) => {
    setRenamingChannelId(channelId);
    setRenameValue(currentName);
  };

  const cancelRenameChannel = () => {
    setRenamingChannelId(null);
    setRenameValue("");
  };

  const submitRenameChannel = async (channelId: number) => {
    if (!accessToken) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      cancelRenameChannel();
      return;
    }
    const original = server.channels.find((c) => c.id === channelId);
    if (!original || original.name === trimmed) {
      cancelRenameChannel();
      return;
    }
    try {
      await renameChannelFn(server.id, channelId, trimmed, accessToken);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to rename channel");
    }
    cancelRenameChannel();
  };

  const cycleNotificationLevel = (roomId: string) => {
    const current = channelNotifications[roomId];
    const next = !current ? "all" : current === "all" ? "mentions" : current === "mentions" ? "nothing" : "default";
    setChannelNotificationLevel(roomId, next);
  };

  const bellTitle = (roomId: string) => {
    const level = channelNotifications[roomId];
    if (!level) return "Notifications: Default (click to cycle)";
    return `Notifications: ${level === "all" ? "All" : level === "mentions" ? "Mentions" : "Muted"} (click to cycle)`;
  };

  const handleChannelClick = (roomId: string) => {
    closeSettings();
    closeServerSettings();
    if (onChannelSelect) {
      onChannelSelect(roomId);
    } else {
      setActiveChannel(roomId);
    }
  };

  const renderChannelItem = (
    ch: { id: number; name: string; matrix_room_id: string },
    isVoice: boolean,
    extras?: ReactNode,
  ) => {
    const unread = unreadCounts.get(ch.matrix_room_id) ?? 0;
    const isActive = activeChannelId === ch.matrix_room_id;
    const notifLevel = channelNotifications[ch.matrix_room_id];
    const isRenaming = renamingChannelId === ch.id;
    const roomParticipants = isVoice
      ? voiceParticipants.get(ch.matrix_room_id) ?? []
      : [];
    // Voice channels signal "something is happening in here" via
    // participant count, not Matrix unread count. Any participant
    // (including the current user) counts — leaving the channel and
    // seeing the dot reminds you that you're still connected in the
    // other room. For text channels, activity is just unread > 0.
    const voiceParticipantCount = isVoice
      ? roomParticipants.length
      : 0;
    const hasActivity = unread > 0 || voiceParticipantCount > 0;
    return (
      <SortableChannelRow
        key={ch.id}
        channel={ch}
        isVoice={isVoice}
        isActive={isActive}
        isRenaming={isRenaming}
        unread={unread}
        hasActivity={hasActivity}
        notifLevel={notifLevel}
        renameValue={renameValue}
        onRenameChange={setRenameValue}
        onRenameSubmit={() => submitRenameChannel(ch.id)}
        onRenameCancel={cancelRenameChannel}
        onStartRename={() => startRenameChannel(ch.id, ch.name)}
        onChannelClick={() => handleChannelClick(ch.matrix_room_id)}
        onCycleNotification={() => cycleNotificationLevel(ch.matrix_room_id)}
        bellTitle={bellTitle(ch.matrix_room_id)}
        isOwner={isOwner}
        showAdminControls={showAdminControls}
        confirmDelete={confirmDeleteChannelId === ch.id}
        onSetConfirmDelete={(v) => setConfirmDeleteChannelId(v ? ch.id : null)}
        onDelete={() => handleDeleteChannel(ch.id)}
        isTV={isTV}
      >
        {extras}
      </SortableChannelRow>
    );
  };

  // Drag-to-reorder handler. We pass the currently-visible list (text OR
  // voice channels, depending on which <SortableContext> fired the event)
  // so we can compute the new ordering just for that slice, then send the
  // full server-wide ordering to the backend. The store's reorderChannels
  // handles optimistic update + rollback on failure.
  const handleDragEnd = (event: DragEndEvent, visible: typeof textChannels) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!accessToken) return;

    const oldIndex = visible.findIndex((c) => c.id === active.id);
    const newIndex = visible.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reorderedVisible = arrayMove(visible, oldIndex, newIndex);

    // Build the full new channel order: the reordered slice in place,
    // keeping all other channels (e.g. the voice channels when dragging
    // text) untouched relative to each other.
    const visibleIds = new Set(visible.map((c) => c.id));
    const reorderedIter = reorderedVisible[Symbol.iterator]();
    const fullOrder: number[] = [];
    for (const ch of server.channels) {
      if (visibleIds.has(ch.id)) {
        const next = reorderedIter.next();
        if (!next.done) fullOrder.push(next.value.id);
      } else {
        fullOrder.push(ch.id);
      }
    }

    reorderChannelsFn(server.id, fullOrder, accessToken).catch(() => {
      // Error already surfaced via toast inside the store; swallow here.
    });
  };

  return (
    <div className="w-full flex flex-col min-h-0 bg-surface-container-low">
      {/* Server header */}
      <div className="p-3 flex items-center justify-between relative">
        <button
          type="button"
          className="min-w-0 text-left text-sm font-headline font-semibold text-on-surface truncate cursor-pointer hover:text-on-surface-variant transition-colors"
          onClick={() => onServerTitleClick?.()}
          title="Server stats"
        >
          {server.name}
        </button>
        <div className="flex items-center gap-1">
          {canOpenSettings && (
            <button
              onClick={() => {
                if (settingsOpen && serverSettingsId === server.id) {
                  closeServerSettings();
                  closeSettings();
                  return;
                }
                openServerSettings(server.id);
              }}
              title="Server Settings"
              className="text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined text-lg">settings</span>
            </button>
          )}
          <button
            onClick={() => setShowInviteModal(true)}
            title="Create Invite Link"
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-lg">person_add</span>
          </button>
        </div>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto p-2">
        {textChannels.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between px-2 mb-1">
              <h3 className="text-[10px] font-label font-medium text-on-surface-variant uppercase tracking-widest">
                Text Channels
              </h3>
              {(isOwner || allowUserChannelCreation) && (
                <button
                  onClick={() => setShowAdminControls((v) => !v)}
                  className={`text-on-surface-variant hover:text-on-surface transition-colors ${
                    showAdminControls ? "text-on-surface" : ""
                  }`}
                  title={showAdminControls ? "Hide admin controls" : "Show admin controls"}
                >
                  <span className="material-symbols-outlined text-sm">{CHANNEL_ADMIN_TOGGLE_ICON}</span>
                </button>
              )}
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => handleDragEnd(e, textChannels)}
            >
              <SortableContext
                items={textChannels.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                {textChannels.map((ch) => renderChannelItem(ch, false))}
              </SortableContext>
            </DndContext>
          </div>
        )}

        {voiceChannels.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between px-2 mb-1">
              <h3 className="text-[10px] font-label font-medium text-on-surface-variant uppercase tracking-widest">
                Voice Channels
              </h3>
              {(isOwner || allowUserChannelCreation) && textChannels.length === 0 && (
                <button
                  onClick={() => setShowAdminControls((v) => !v)}
                  className={`text-on-surface-variant hover:text-on-surface transition-colors ${
                    showAdminControls ? "text-on-surface" : ""
                  }`}
                  title={showAdminControls ? "Hide admin controls" : "Show admin controls"}
                >
                  <span className="material-symbols-outlined text-sm">{CHANNEL_ADMIN_TOGGLE_ICON}</span>
                </button>
              )}
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => handleDragEnd(e, voiceChannels)}
            >
              <SortableContext
                items={voiceChannels.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                {voiceChannels.map((ch) =>
                  renderChannelItem(ch, true,
                    (voiceParticipants.get(ch.matrix_room_id) ?? []).map((p) => (
                      <div key={p.identity} className="flex items-center gap-1.5 pl-8 py-0.5">
                        <Avatar userId={p.identity} size="sm" />
                        <span className="text-xs text-on-surface-variant truncate font-body">
                          {p.name || p.identity.split(":")[0].replace("@", "")}
                        </span>
                      </div>
                    )),
                  )
                )}
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* Places section */}
        {placeChannels.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between px-2 mb-1">
              <h3 className="text-[10px] font-label font-medium text-on-surface-variant uppercase tracking-widest">
                Places
              </h3>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => handleDragEnd(e, placeChannels)}
            >
              <SortableContext
                items={placeChannels.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                {placeChannels.map((ch) => renderChannelItem(ch, false))}
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* Applications section.
         *
         * Two layers:
         *   1. ACTIVE app channels — one row per running extension. Members
         *      can Stop (deletes the channel) without owner permission.
         *   2. LAUNCHERS — every installed extension. Click to start a
         *      fresh app channel; the server creates + Matrix-room-mints
         *      it via POST /servers/<id>/extensions/<id>/start. The user
         *      doesn't manage app channels manually anymore.
         *
         * Always renders (not gated on appChannels.length) when at least
         * one extension is installed — the launchers are the entry point.
         */}
        {(appChannels.length > 0 || extensionCatalog.length > 0) && (
          <div className="mb-3">
            <div className="flex items-center justify-between px-2 mb-1">
              <h3 className="text-[10px] font-label font-medium text-on-surface-variant uppercase tracking-widest">
                Applications
              </h3>
            </div>

            {/* Active app channels. Stop button here AND inside the
                extension panel; sidebar copy is for "stop while looking
                at a different channel" cases. */}
            {appChannels.map((ch) => {
              const ext = extensionCatalog.find((e) => e.id === ch.extension_id);
              const isActive = activeChannelId === ch.matrix_room_id;
              return (
                <div key={ch.id} className="group flex items-center gap-0.5">
                  <button
                    onClick={() => handleChannelClick(ch.matrix_room_id)}
                    className={`flex-1 min-w-0 text-left px-3 py-2 rounded-xl text-sm transition-all flex items-center gap-2 font-body ${
                      isActive
                        ? "bg-surface-container-highest text-on-surface"
                        : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                    }`}
                  >
                    <span className="material-symbols-outlined text-base flex-shrink-0">
                      {ext?.icon ?? "extension"}
                    </span>
                    <span className="min-w-0 truncate flex-1">{ch.name}</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" title="Running" />
                  </button>
                  {/* Stop deletes the app channel. No confirm dialog —
                     app channels are ephemeral by design and re-launch
                     is one click on the launcher below. */}
                  <button
                    onClick={() => handleDeleteChannel(ch.id)}
                    className="text-xs px-0.5 text-outline opacity-0 group-hover:opacity-100 transition-all hover:text-error flex-shrink-0"
                    title="Stop application"
                  >
                    <span className="material-symbols-outlined text-sm">stop_circle</span>
                  </button>
                </div>
              );
            })}

            {/* Launchers — one row per installed extension. Hidden if
                an active app channel for the same extension already
                exists, so we don't show a "Start" next to the running
                one and confuse the user. */}
            {extensionCatalog
              .filter((ext) => !appChannels.some((ch) => ch.extension_id === ext.id))
              .map((ext) => {
                const launching = launchingExtensionId === ext.id;
                return (
                  <button
                    key={`launcher-${ext.id}`}
                    onClick={() => void handleLaunchExtension(ext.id)}
                    disabled={launching}
                    className="w-full text-left px-3 py-2 rounded-xl text-sm transition-all flex items-center gap-2 font-body text-on-surface-variant/70 hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50"
                    title={`Start ${ext.name}`}
                  >
                    <span className="material-symbols-outlined text-base flex-shrink-0">
                      {ext.icon ?? "extension"}
                    </span>
                    <span className="min-w-0 truncate flex-1">{ext.name}</span>
                    <span className="material-symbols-outlined text-sm text-on-surface-variant/50 flex-shrink-0">
                      {launching ? "hourglass_empty" : "play_arrow"}
                    </span>
                  </button>
                );
              })}
          </div>
        )}

        {/* New channel (owner/admin, or any member if flag is on) behind admin toggle */}
        {(isOwner || allowUserChannelCreation) && showAdminControls && (
          showNewChannel ? (
            <form onSubmit={handleCreateChannel} className="px-1 space-y-1.5">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setChannelType("text")}
                  className={`flex-1 py-1 rounded-lg text-xs font-label font-medium transition-colors ${
                    channelType === "text"
                      ? "bg-surface-container-highest text-on-surface"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  # Text
                </button>
                <button
                  type="button"
                  onClick={() => setChannelType("voice")}
                  className={`flex-1 py-1 rounded-lg text-xs font-label font-medium transition-colors ${
                    channelType === "voice"
                      ? "bg-surface-container-highest text-on-surface"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  Voice
                </button>
                <button
                  type="button"
                  onClick={() => setChannelType("place")}
                  className={`flex-1 py-1 rounded-lg text-xs font-label font-medium transition-colors ${
                    channelType === "place"
                      ? "bg-surface-container-highest text-on-surface"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  ◈ Place
                </button>
                {/* The "App" channel-type button used to live here so
                   owners could mount an extension on a hand-made
                   channel. v0.7.2 removed it: app channels are now
                   strictly extension-lifecycle artifacts created via
                   the Applications-section launchers above (POST
                   /servers/<id>/extensions/<id>/start) and torn down
                   when the user clicks Stop. The user explicitly asked
                   "user should not be managing app channels — they
                   should manage themselves." */}
              </div>
              {channelType === "app" ? (
                <>
                  <select
                    value={selectedExtensionId}
                    onChange={(e) => {
                      setSelectedExtensionId(e.target.value);
                      if (!channelName.trim() && e.target.value) {
                        const ext = extensionCatalog.find((x) => x.id === e.target.value);
                        if (ext) setChannelName(ext.name);
                      }
                    }}
                    className="w-full px-3 py-1.5 bg-surface-container rounded-xl text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30 font-body"
                  >
                    <option value="">Select extension…</option>
                    {extensionCatalog.map((ext) => (
                      <option key={ext.id} value={ext.id}>{ext.name}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder="App channel name"
                    className="w-full px-3 py-1.5 bg-surface-container rounded-xl text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all font-body"
                  />
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setAppAccess("all")}
                      className={`flex-1 py-1 rounded-lg text-xs font-label font-medium transition-colors ${
                        appAccess === "all"
                          ? "bg-surface-container-highest text-on-surface"
                          : "text-on-surface-variant hover:text-on-surface"
                      }`}
                    >
                      All members
                    </button>
                    <button
                      type="button"
                      onClick={() => setAppAccess("admin_only")}
                      className={`flex-1 py-1 rounded-lg text-xs font-label font-medium transition-colors ${
                        appAccess === "admin_only"
                          ? "bg-surface-container-highest text-on-surface"
                          : "text-on-surface-variant hover:text-on-surface"
                      }`}
                    >
                      Admin only
                    </button>
                  </div>
                  <button
                    type="submit"
                    disabled={!selectedExtensionId || !channelName.trim()}
                    className="w-full py-1.5 rounded-xl text-xs font-label font-medium bg-primary text-on-primary disabled:opacity-40 transition-colors"
                  >
                    Install App
                  </button>
                </>
              ) : (
                <input
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  placeholder="channel-name"
                  autoFocus
                  onBlur={() => { if (!channelName.trim()) setShowNewChannel(false); }}
                  className="w-full px-3 py-1.5 bg-surface-container rounded-xl text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-surface-container-high transition-all font-body"
                />
              )}
            </form>
          ) : (
            <button
              onClick={() => setShowNewChannel(true)}
              className="w-full text-left px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high rounded-xl transition-colors font-body"
            >
              + Add Channel
            </button>
          )
        )}
      </div>

      {/* UserBar is rendered by ChatLayout so it can span the full
          width of Sources + ServerSidebar + ChannelSidebar. The
          inline mount that used to live here has been removed. */}

      {showInviteModal && (
        <InviteModal serverId={server.id} onClose={() => setShowInviteModal(false)} />
      )}
    </div>
  );
});

interface SortableChannelRowProps {
  channel: { id: number; name: string; matrix_room_id: string };
  isVoice: boolean;
  isActive: boolean;
  isRenaming: boolean;
  unread: number;
  // Drives the small green "something is happening" dot next to
  // the channel name. For text channels this is `unread > 0`; for
  // voice channels it's "someone is currently in the room". The
  // caller computes it so the row itself stays agnostic.
  hasActivity: boolean;
  notifLevel: string | undefined;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onStartRename: () => void;
  onChannelClick: () => void;
  onCycleNotification: () => void;
  bellTitle: string;
  isOwner: boolean;
  showAdminControls: boolean;
  confirmDelete: boolean;
  onSetConfirmDelete: (v: boolean) => void;
  onDelete: () => void;
  // TV mode (INS-023): apply the `.tv-channel-item` class + DPAD focus
  // attributes so the row is picked up by `useDpadNav({ group: "tv-main" })`
  // and styled by the 10-foot rules in `client/src/styles/tv.css`.
  isTV?: boolean;
  children?: ReactNode;
}

function SortableChannelRow({
  channel,
  isVoice,
  isActive,
  isRenaming,
  unread,
  hasActivity,
  notifLevel,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onStartRename,
  onChannelClick,
  onCycleNotification,
  bellTitle,
  isOwner,
  showAdminControls,
  confirmDelete,
  onSetConfirmDelete,
  onDelete,
  isTV = false,
  children,
}: SortableChannelRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: channel.id, disabled: isRenaming });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div className="group flex items-center gap-0.5">
      {/* Drag handle — only visible to owners in admin mode. Listeners
          are only attached here so the channel button itself stays
          clickable for selection. */}
      {isOwner && showAdminControls && !isRenaming && (
        <button
          {...attributes}
          {...listeners}
          className="text-outline hover:text-on-surface cursor-grab active:cursor-grabbing touch-none flex-shrink-0 px-0.5"
          title="Drag to reorder"
          aria-label="Drag to reorder channel"
        >
          <span className="material-symbols-outlined text-sm">drag_indicator</span>
        </button>
      )}

      {isRenaming ? (
        <form
          onSubmit={(e) => { e.preventDefault(); onRenameSubmit(); }}
          className="flex-1 min-w-0 flex items-center gap-1 px-3 py-1.5"
        >
          <span className="text-on-surface-variant text-sm flex-shrink-0">
            {isVoice ? "🔊" : "#"}
          </span>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
            }}
            autoFocus
            className="flex-1 min-w-0 px-2 py-0.5 bg-surface-container rounded-lg text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 font-body"
          />
        </form>
      ) : (
        <button
          onClick={onChannelClick}
          data-focusable={isTV ? "true" : undefined}
          data-focus-group={isTV ? "tv-main" : undefined}
          className={`flex-1 min-w-0 text-left px-3 py-2 rounded-xl text-sm transition-all flex items-center gap-2 font-body ${
            isTV ? "tv-channel-item " : ""
          }${
            isActive
              ? "bg-surface-container-highest text-on-surface"
              : unread > 0
                ? "text-on-surface hover:bg-surface-container-high"
                : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          }`}
        >
          {isVoice ? (
            <span className="material-symbols-outlined text-base flex-shrink-0">volume_up</span>
          ) : (
            <span className="text-on-surface-variant flex-shrink-0">#</span>
          )}
          {/* Activity dot: small green pip that indicates the channel
              has new activity. Migrated here from the server tile
              (which previously carried a "members online" green dot
              that was visually noisy on every row). Suppressed on the
              active channel so your current view doesn't flicker with
              its own dot every time a message arrives. Text channels
              light up on unread > 0, voice channels light up when
              anyone is currently in the room — caller resolves which
              and passes the unified `hasActivity` flag. */}
          {hasActivity && !isActive && (
            <span
              className="w-2 h-2 rounded-full bg-secondary flex-shrink-0 node-pulse"
              aria-label={isVoice ? "Users in voice channel" : "New activity"}
            />
          )}
          {/* Label lives in its own min-w-0 container so it can truncate
              without being pushed by the trailing action icons. Action
              icons sit in a sibling flex container outside this button. */}
          <span
            className="min-w-0 truncate flex-1"
            onDoubleClick={(e) => {
              if (!isOwner) return;
              e.stopPropagation();
              e.preventDefault();
              onStartRename();
            }}
          >
            {channel.name}
          </span>
          {/* Unread count badge — renders on active channel too; read
              receipts still clear it via the normal path. Paired with
              the green activity dot above: dot says "something
              happened", number says "how much". */}
          {unread > 0 && (
            <span className="primary-glow text-on-primary text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center font-label flex-shrink-0">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      )}

      {/* Action icons — sibling of the channel button so they don't
          steal label width. */}
      {!isRenaming && (
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={onCycleNotification}
            className={`text-xs px-0.5 transition-all ${
              notifLevel
                ? notifLevel === "nothing"
                  ? "text-error"
                  : notifLevel === "mentions"
                    ? "text-primary"
                    : "text-secondary"
                : "text-outline opacity-0 group-hover:opacity-100"
            }`}
            title={bellTitle}
          >
            <span className="material-symbols-outlined text-sm">
              {notifLevel === "nothing" ? "notifications_off" : "notifications"}
            </span>
          </button>
          {isOwner && showAdminControls && (
            confirmDelete ? (
              <button
                onClick={onDelete}
                onMouseLeave={() => onSetConfirmDelete(false)}
                className="text-error text-xs px-1 animate-pulse font-label"
                title="Click to confirm"
              >
                ?
              </button>
            ) : (
              <button
                onClick={() => onSetConfirmDelete(true)}
                className="text-outline hover:text-error text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete channel"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )
          )}
        </div>
      )}
      </div>
      {children}
    </div>
  );
}

/**
 * UserBar — the bottom strip showing avatar, display name, settings
 * gear, switch-server button, and logout.
 *
 * Historically this was rendered inline at the bottom of ChannelSidebar
 * and was therefore confined to the channel-column width. The current
 * contract (2026-04-10 user spec) puts it below the full "left stack"
 * of Sources + ServerSidebar + ChannelSidebar columns, spanning all
 * three horizontally and stopping at the left edge of the message
 * input pane. ChatLayout owns the placement now, so this function is
 * exported rather than kept local. The two inline mounts inside
 * ChannelSidebar's own render tree were removed — ChatLayout renders
 * UserBar exactly once in the desktop layout.
 */
export function UserBar({
  userId,
  logout,
}: {
  userId: string | null;
  logout: () => void;
}) {
  const openSettings = useSettingsStore((s) => s.openSettings);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const serverSettingsId = useSettingsStore((s) => s.serverSettingsId);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const closeServerSettings = useSettingsStore((s) => s.closeServerSettings);
  // `__TAURI_INTERNALS__` is the canonical Tauri v2 global; see the
  // comment in `client/src/api/serverUrl.ts` for the full history.
  const isNative =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  // "Switch server" — full disconnect from the current Concord instance.
  // Clears the INS-027 serverConfig store (which also bridges the
  // blank string through to Tauri's persisted `server_url`), then
  // logs the user out and reloads the webview.
  //
  // The reload is necessary because `App.tsx` computes
  // `serverConnected` once at mount via `computeInitialServerConnected`;
  // without a fresh mount the picker never re-appears and the user
  // would see the LoginForm pointed at the same host instead of
  // being able to choose a different one.
  //
  // Dynamic import of the serverConfig store keeps ChannelSidebar's
  // static dependency graph lean — this path only fires on explicit
  // user click, so paying the sync-import cost on every render would
  // be wasteful.
  //
  // Native-only: in the browser the origin IS the server — switching
  // would mean navigating to a different domain, which is outside
  // this app's responsibility.
  const handleSwitchServer = async () => {
    const { useServerConfigStore } = await import("../../stores/serverConfig");
    useServerConfigStore.getState().clearHomeserver();
    logout();
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  return (
    <div className="px-3 py-2 bg-surface-container flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        {userId && <Avatar userId={userId} size="md" showPresence />}
        <span className="text-sm text-on-surface truncate font-body">
          {userId?.split(":")[0].replace("@", "")}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => {
            if (settingsOpen || serverSettingsId) {
              closeServerSettings();
              closeSettings();
              return;
            }
            openSettings("profile");
          }}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          title="Profile & account"
          aria-label="Profile and account settings"
        >
          {/* `manage_accounts` = person glyph with a small gear at the
             shoulder — reads as "account management" specifically,
             whereas a plain `settings` gear conflates with app-wide
             settings (which live in the top-bar wrench menu). The user
             banner is personal, so the icon should be too. */}
          <span className="material-symbols-outlined text-lg">manage_accounts</span>
        </button>
        {isNative && (
          <button
            onClick={handleSwitchServer}
            title="Disconnect from this instance and return to the server picker"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg">swap_horiz</span>
          </button>
        )}
      </div>
    </div>
  );
}
