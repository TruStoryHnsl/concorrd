/**
 * DiscordSourceBrowser — browse and link Discord channels via the bot bridge.
 *
 * Screens:
 *   browse          — list of already-bridged rooms, grouped by guild space
 *   invite-bot      — open Discord OAuth2 invite URL so bot joins a server
 *   link-channel-id — enter a Discord channel ID to bridge
 *   link-test-msg   — optionally send a test message after bridging
 *   linking         — spinner while DM-ing the bridge bot and waiting for portal
 *   done            — success, optionally navigate to the new room
 *   error           — failure with back button
 *
 * Linking mechanism:
 *   - Text channels are bridged by DM-ing "bridge <channel_id>" to
 *     @discordbot and waiting for the mautrix portal room.
 *   - Voice/stage channels are mapped to a Concord voice channel and
 *     relayed by the Discord voice sidecar.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useAuthStore } from "../../stores/auth";
import { useServerStore } from "../../stores/server";
import { useDMStore } from "../../stores/dm";
import {
  discordBridgeHttpGetChannel,
  discordBridgeHttpGetInviteUrl,
  discordBridgeHttpLoginRelay,
  discordBridgeHttpListGuilds,
  discordVoiceBridgeHttpListRooms,
  discordVoiceBridgeHttpStart,
  discordVoiceBridgeHttpUpsertRoom,
} from "../../api/bridges";

// ── Alias parser ────────────────────────────────────────────────────────────

interface DiscordAliasInfo {
  guildId: string;
  channelId: string;
}

/** Parse a mautrix-discord canonical alias into guild/channel snowflakes. */
function parseDiscordAlias(alias: string): DiscordAliasInfo | null {
  // Format: #_discord_<guildId>_<channelId>:<server>
  const m = alias.match(/^#_discord_(\d+)_(\d+):/);
  if (!m) return null;
  return { guildId: m[1], channelId: m[2] };
}

interface DiscordBridgeInfo extends DiscordAliasInfo {
  networkName?: string;
}

/**
 * Detect Discord bridge info from room state events.
 * Reads guild/channel IDs from the state key and the guild name from
 * the `network.displayname` field in the event content.
 */
function detectDiscordBridge(room: { currentState?: { getStateEvents?(type: string): unknown[] } }): DiscordBridgeInfo | null {
  try {
    const events = room.currentState?.getStateEvents?.("m.bridge") as
      | { getStateKey?(): string; getContent?(): Record<string, unknown> }[]
      | undefined;
    if (!events?.length) return null;
    for (const ev of events) {
      const sk = ev.getStateKey?.() ?? "";
      const m = sk.match(/fi\.mau\.discord:\/\/discord\/(\d+)\/(\d+)/);
      if (m) {
        const content = ev.getContent?.() ?? {};
        const network = content.network as { displayname?: string } | undefined;
        return { guildId: m[1], channelId: m[2], networkName: network?.displayname };
      }
    }
  } catch { /* ignore SDK access errors */ }
  return null;
}

function safeConcordChannelName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_\- ]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 100);
}

// ── Wait for bridge portal ───────────────────────────────────────────────────

async function waitForPortal(
  client: ReturnType<typeof useAuthStore.getState>["client"],
  channelId: string,
  timeoutMs = 20000,
): Promise<{ roomId: string; name: string } | null> {
  if (!client) return null;
  const re = new RegExp(`_discord_\\d+_${channelId}:`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const room = client.getRooms().find(
      (r) =>
        r.getMyMembership() === "join" &&
        re.test(r.getCanonicalAlias() ?? ""),
    );
    if (room) return { roomId: room.roomId, name: room.name ?? room.roomId };
    await new Promise((res) => setTimeout(res, 600));
  }
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface BridgedChannel {
  roomId: string;
  name: string;
  guildId: string;
  channelId: string;
}

interface GuildGroup {
  guildId: string;
  guildName: string;
  channels: BridgedChannel[];
}

interface LinkStep {
  key: string;
  label: string;
  status: "pending" | "ok" | "failed";
  detail?: string;
  elapsedMs?: number;
}

type Screen =
  | "browse"
  | "invite-bot"
  | "link-channel-id"
  | "link-test-msg"
  | "linking"
  | "done"
  | "error"
  | "login-account"
  | "bridge-guild";

// ── Header ───────────────────────────────────────────────────────────────────

function Header({
  title,
  onBack,
  onClose,
}: {
  title: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-3 mb-6">
      {onBack && (
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
        </button>
      )}
      {/* Discord blurple accent dot */}
      <div className="w-2 h-2 rounded-full bg-[#5865F2] flex-shrink-0" />
      <h2 className="flex-1 text-lg font-headline font-semibold text-on-surface">
        {title}
      </h2>
      <button
        onClick={onClose}
        className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high transition-colors"
      >
        <span className="material-symbols-outlined text-lg">close</span>
      </button>
    </div>
  );
}

function LinkStepList({ steps }: { steps: LinkStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-high/60 p-3 text-left">
      <p className="text-xs font-medium text-on-surface mb-2">Connection trace</p>
      <div className="space-y-2">
        {steps.map((step) => (
          <div key={step.key} className="flex gap-2 text-xs">
            <span
              className={`mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[10px] ${
                step.status === "ok"
                  ? "bg-green-500/15 text-green-500"
                  : step.status === "failed"
                    ? "bg-error/15 text-error"
                    : "bg-[#5865F2]/15 text-[#5865F2]"
              }`}
            >
              {step.status === "ok" ? "✓" : step.status === "failed" ? "!" : "..."}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-on-surface">{step.label}</span>
                {step.elapsedMs !== undefined && (
                  <span className="text-on-surface-variant/60">{step.elapsedMs}ms</span>
                )}
              </div>
              {step.detail && (
                <p className="mt-0.5 break-words font-mono text-[11px] text-on-surface-variant">
                  {step.detail}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function DiscordSourceBrowser({ onClose }: { onClose: () => void }) {
  const client = useAuthStore((s) => s.client);
  const userId = useAuthStore((s) => s.userId);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const activeChannelId = useServerStore((s) => s.activeChannelId);
  const setActiveChannel = useServerStore((s) => s.setActiveChannel);
  const ensureDiscordGuild = useServerStore((s) => s.ensureDiscordGuild);
  const setDMActive = useDMStore((s) => s.setDMActive);

  const accessToken = useAuthStore((s) => s.accessToken);

  const [screen, setScreen] = useState<Screen>("browse");
  const [channelId, setChannelId] = useState("");
  const [sendTestMsg, setSendTestMsg] = useState(true);
  const [testMsg, setTestMsg] = useState("✓ Concord bridge is working!");
  const [linkedRoom, setLinkedRoom] = useState<{ roomId: string; name: string } | null>(null);
  const [linkedKind, setLinkedKind] = useState<"text" | "voice">("text");
  const [error, setError] = useState("");
  const [linkSteps, setLinkSteps] = useState<LinkStep[]>([]);
  const voiceOverlayLoadedForToken = useRef<string | null>(null);

  // Invite URL — fetched lazily when the invite-bot screen is opened.
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteUrlLoading, setInviteUrlLoading] = useState(false);

  // Discord guilds — fetched when bridge-guild screen opens
  const [discordGuilds, setDiscordGuilds] = useState<{ id: string; name: string; icon: string | null }[]>([]);
  const [guildsLoading, setGuildsLoading] = useState(false);
  const [bridgingGuildId, setBridgingGuildId] = useState<string | null>(null);

  const openInviteScreen = useCallback(async () => {
    setScreen("invite-bot");
    if (inviteUrl) return; // already fetched
    setInviteUrlLoading(true);
    try {
      if (!accessToken) throw new Error("Not logged in");
      const result = await discordBridgeHttpGetInviteUrl(accessToken);
      setInviteUrl(result.invite_url);
    } catch {
      // Non-fatal — show a manual fallback link
      setInviteUrl(null);
    } finally {
      setInviteUrlLoading(false);
    }
  }, [accessToken, inviteUrl]);

  // ── Build bridged-room list ────────────────────────────────────────────────

  // Resolved guild names fetched from Discord API for fallback "Guild <id>" labels.
  const [resolvedGuildNames, setResolvedGuildNames] = useState<Map<string, string>>(new Map());

  const guildGroups: GuildGroup[] = useMemo(() => {
    if (!client) return [];

    const bridgedRooms: (BridgedChannel & { networkName?: string; lastActiveTs: number })[] = [];
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== "join") continue;
      // Only trust rooms with a proper mautrix-discord canonical alias
      // (#_discord_<guildId>_<channelId>:<server>). mautrix always sets this
      // on real portal rooms. Rooms detected only via m.bridge state events
      // (no alias) are management DMs or accidentally-bridged rooms — skip them.
      const alias = room.getCanonicalAlias() ?? "";
      const parsed = parseDiscordAlias(alias);
      if (!parsed) continue;
      const info: DiscordBridgeInfo = {
        ...parsed,
        networkName: detectDiscordBridge(room)?.networkName,
      };
      bridgedRooms.push({
        roomId: room.roomId,
        name: room.name ?? `#${info.channelId}`,
        guildId: info.guildId,
        channelId: info.channelId,
        networkName: info.networkName,
        lastActiveTs: room.getLastActiveTimestamp?.() ?? 0,
      });
    }
    // Most-recently-active first so deduplication by channelId keeps the
    // live portal, not a stale accidentally-bridged room.
    bridgedRooms.sort((a, b) => b.lastActiveTs - a.lastActiveTs);

    // Group by guild. Derive name from m.bridge network.displayname,
    // space room, or fall back to guild ID.
    const guildMap = new Map<string, GuildGroup>();
    for (const ch of bridgedRooms) {
      if (!guildMap.has(ch.guildId)) {
        // Prefer network name from bridge state event
        let guildName = ch.networkName;
        if (!guildName) {
          // Fall back to space room name
          const spaceRoom = client.getRooms().find((r) => {
            const alias = r.getCanonicalAlias() ?? "";
            return (
              r.getType?.() === "m.space" &&
              alias.match(new RegExp(`^#_discord_${ch.guildId}:`))
            );
          });
          guildName = spaceRoom?.name;
        }
        guildMap.set(ch.guildId, {
          guildId: ch.guildId,
          guildName: guildName ?? `Guild ${ch.guildId}`,
          channels: [],
        });
      }
      // Deduplicate by channelId within the guild — if two Matrix rooms share
      // the same Discord channelId (e.g. the accidentally-bridged management DM
      // and the fresh portal created afterward), only keep the first one seen.
      const group = guildMap.get(ch.guildId)!;
      if (!group.channels.some((c) => c.channelId === ch.channelId)) {
        group.channels.push(ch);
      }
    }

    return Array.from(guildMap.values()).sort((a, b) =>
      a.guildName.localeCompare(b.guildName),
    );
  }, [client]);

  // Eagerly resolve any guild still showing "Guild <id>" fallback names.
  useEffect(() => {
    const fallback = guildGroups.filter(
      (g) => g.guildName.startsWith("Guild ") && !resolvedGuildNames.has(g.guildId),
    );
    if (!fallback.length || !accessToken) return;
    discordBridgeHttpListGuilds(accessToken)
      .then((guilds) => {
        setResolvedGuildNames((prev) => {
          const next = new Map(prev);
          for (const g of fallback) {
            const match = guilds.find((dg) => dg.id === g.guildId);
            if (match) next.set(g.guildId, match.name);
          }
          return next;
        });
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildGroups, accessToken]);

  // Apply resolved names on top of computed groups.
  const resolvedGroups = useMemo(
    () =>
      guildGroups.map((g) =>
        resolvedGuildNames.has(g.guildId)
          ? { ...g, guildName: resolvedGuildNames.get(g.guildId)! }
          : g,
      ),
    [guildGroups, resolvedGuildNames],
  );

  useEffect(() => {
    if (!accessToken || servers.length === 0) return;
    if (voiceOverlayLoadedForToken.current === accessToken) return;
    voiceOverlayLoadedForToken.current = accessToken;

    let cancelled = false;
    (async () => {
      try {
        const [rooms, guilds] = await Promise.all([
          discordVoiceBridgeHttpListRooms(accessToken),
          discordBridgeHttpListGuilds(accessToken).catch(() => []),
        ]);
        if (cancelled) return;

        const latestServers = useServerStore.getState().servers;
        for (const room of rooms) {
          if (!room.enabled) continue;
          const alreadyProjected = latestServers.some(
            (server) =>
              server.bridgeType === "discord" &&
              server.discordGuildId === room.discord_guild_id &&
              server.channels.some((channel) => channel.matrix_room_id === room.matrix_room_id),
          );
          if (alreadyProjected) continue;

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
              resolvedGuildNames.get(room.discord_guild_id) ??
              guilds.find((guild) => guild.id === room.discord_guild_id)?.name ??
              `Guild ${room.discord_guild_id}`,
            channel: {
              id: localChannel.id,
              roomId: room.matrix_room_id,
              name: localChannel.name,
              channelType: "voice",
            },
            preferBridgeServer: true,
          });
        }
      } catch {
        voiceOverlayLoadedForToken.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, ensureDiscordGuild, resolvedGuildNames, servers.length]);

  // ── Navigate to a bridged room ─────────────────────────────────────────────

  const navigateTo = useCallback(
    async (roomId: string) => {
      setDMActive(false);

      const channel = resolvedGroups
        .flatMap((g) => g.channels.map((ch) => ({ ...ch, guildName: g.guildName })))
        .find((ch) => ch.roomId === roomId);

      if (channel) {
        let guildName = channel.guildName;

        // If guild name is a fallback like "Guild 123...", fetch the real name
        if (guildName.startsWith("Guild ") && accessToken) {
          try {
            const guilds = await discordBridgeHttpListGuilds(accessToken);
            const match = guilds.find((g) => g.id === channel.guildId);
            if (match) guildName = match.name;
          } catch { /* keep fallback */ }
        }

        ensureDiscordGuild({
          guildId: channel.guildId,
          guildName,
          channel: { roomId: channel.roomId, name: channel.name },
        });
      } else {
        setActiveChannel(roomId);
      }

      onClose();
    },
    [setDMActive, setActiveChannel, ensureDiscordGuild, resolvedGroups, accessToken, onClose],
  );

  // ── Link flow ─────────────────────────────────────────────────────────────

  const handleLink = useCallback(async () => {
    const steps: LinkStep[] = [];
    const stepStartedAt = new Map<string, number>();
    const syncSteps = () => setLinkSteps([...steps]);
    const startStep = (key: string, label: string, detail?: string) => {
      const existing = steps.find((step) => step.key === key);
      stepStartedAt.set(key, performance.now());
      if (existing) {
        existing.label = label;
        existing.detail = detail;
        existing.status = "pending";
        delete existing.elapsedMs;
      } else {
        steps.push({ key, label, status: "pending", detail });
      }
      syncSteps();
    };
    const finishStep = (key: string, status: "ok" | "failed", detail?: string) => {
      const existing = steps.find((step) => step.key === key);
      if (!existing) return;
      existing.status = status;
      existing.detail = detail ?? existing.detail;
      const started = stepStartedAt.get(key);
      if (started !== undefined) existing.elapsedMs = Math.round(performance.now() - started);
      syncSteps();
    };
    const failCurrentStep = (key: string, error: unknown): never => {
      const message = error instanceof Error ? error.message : String(error);
      finishStep(key, "failed", message);
      throw error;
    };

    setLinkSteps([]);
    if (!client || !userId) {
      setError("Not connected to Matrix.");
      setScreen("error");
      return;
    }

    const trimmedId = channelId.trim();
    if (!/^\d{17,20}$/.test(trimmedId)) {
      setError("Channel ID must be 17–20 digits. Enable Developer Mode in Discord, then right-click a channel → Copy Channel ID.");
      setScreen("error");
      return;
    }

    setScreen("linking");

    try {
      if (accessToken) {
        startStep("inspect-discord-channel", "Inspect Discord channel", `channel_id=${trimmedId}`);
        const info = await discordBridgeHttpGetChannel(accessToken, trimmedId)
          .catch((err) => failCurrentStep("inspect-discord-channel", err));
        finishStep(
          "inspect-discord-channel",
          "ok",
          `kind=${info.kind}; type=${info.type}; guild=${info.guild_id ?? "none"}; name=${info.name}`,
        );
        if (info.kind === "voice") {
          startStep("select-concord-voice", "Select Concord voice channel");
          const activeServer = servers.find((server) => server.id === activeServerId);
          if (!activeServer || activeServer.bridgeType || activeServer.federated) {
            const err = new Error(
              "Select one of your Concord servers before linking a Discord voice channel. " +
              "Voice channels need a Concord voice room to join.",
            );
            finishStep("select-concord-voice", "failed", err.message);
            throw err;
          }
          if (!info.guild_id) {
            const err = new Error("Discord did not return a server ID for that voice channel.");
            finishStep("select-concord-voice", "failed", err.message);
            throw err;
          }
          const discordGuildId = info.guild_id;

          const fallbackName = `discord voice ${trimmedId.slice(-4)}`;
          const voiceName = safeConcordChannelName(info.name, fallbackName);
          const activeVoiceChannel = activeServer.channels.find(
            (channel) =>
              channel.channel_type === "voice" &&
              channel.matrix_room_id === activeChannelId,
          );
          const matchingVoiceChannel = activeServer.channels.find(
            (channel) => channel.channel_type === "voice" && channel.name === voiceName,
          );
          const firstVoiceChannel = activeServer.channels.find(
            (channel) => channel.channel_type === "voice",
          );
          const voiceChannel = activeVoiceChannel ?? matchingVoiceChannel ?? firstVoiceChannel;
          if (!voiceChannel) {
            const err = new Error(
              "This Concord server has no voice channels yet. Create a Concord voice channel first, then link the Discord voice channel again.",
            );
            finishStep("select-concord-voice", "failed", err.message);
            throw err;
          }
          finishStep(
            "select-concord-voice",
            "ok",
            `server=${activeServer.name}; channel=${voiceChannel.name}; matrix_room=${voiceChannel.matrix_room_id}`,
          );

          startStep("write-voice-mapping", "Write Discord voice mapping");
          await discordVoiceBridgeHttpUpsertRoom(accessToken, {
            channel_id: voiceChannel.id,
            discord_guild_id: discordGuildId,
            discord_channel_id: info.id,
            enabled: true,
          }).catch((err) => failCurrentStep("write-voice-mapping", err));
          finishStep("write-voice-mapping", "ok", `discord_channel=${info.id}`);

          startStep("start-voice-sidecar", "Start Discord voice sidecar");
          const startResult = await discordVoiceBridgeHttpStart(accessToken)
            .catch((err) => failCurrentStep("start-voice-sidecar", err));
          finishStep("start-voice-sidecar", "ok", startResult.message);

          setDMActive(false);
          const guildName =
            resolvedGuildNames.get(discordGuildId) ??
            discordGuilds.find((guild) => guild.id === discordGuildId)?.name ??
            `Guild ${discordGuildId}`;
          ensureDiscordGuild({
            guildId: discordGuildId,
            guildName,
            channel: {
              id: voiceChannel.id,
              roomId: voiceChannel.matrix_room_id,
              name: voiceChannel.name,
              channelType: "voice",
            },
            preferBridgeServer: true,
          });
          setLinkedKind("voice");
          setLinkedRoom({ roomId: voiceChannel.matrix_room_id, name: voiceChannel.name });
          setScreen("done");
          return;
        }
        if (info.kind === "unsupported") {
          failCurrentStep("inspect-discord-channel", new Error("That Discord channel type is not supported by the bridge."));
        }
      }

      // Derive bot user ID from our own Matrix user ID
      const serverDomain = userId.includes(":") ? userId.split(":")[1] : "";
      const botUserId = `@discordbot:${serverDomain}`;

      startStep("create-bridge-room", "Create Matrix room for bridge command", `invite=${botUserId}`);
      // Create a FRESH room for this bridge command. mautrix-discord's
      // `bridge` command turns the CURRENT room into the portal for the
      // specified channel. We must NOT send it in the management DM or
      // any existing portal — each channel needs its own dedicated room.
      const bridgeRoom = await client.createRoom({
        invite: [botUserId],
        // @ts-expect-error — matrix-js-sdk accepts string literal
        preset: "trusted_private_chat",
      }).catch((err) => failCurrentStep("create-bridge-room", err));
      const bridgeRoomId = bridgeRoom.room_id;
      finishStep("create-bridge-room", "ok", `room=${bridgeRoomId}`);
      // Wait for the bot to accept the invite
      startStep("wait-for-discordbot", "Wait for discordbot invite handling", "fixed 2s grace period");
      await new Promise((r) => setTimeout(r, 2000));
      finishStep("wait-for-discordbot", "ok");

      // Ensure the bridge bot is logged into Discord.
      if (accessToken) {
        startStep("login-relay", "Send login relay to bridge bot");
        try {
          await discordBridgeHttpLoginRelay(accessToken);
          await new Promise((r) => setTimeout(r, 4000));
          finishStep("login-relay", "ok", "relay accepted; waited 4s for Discord handshake");
        } catch {
          // Non-fatal — bridge may already be logged in from a previous session.
          finishStep("login-relay", "ok", "skipped or already logged in");
        }
      }

      // Send the bridge command in the dedicated room
      startStep("send-bridge-command", "Send bridge command", `room=${bridgeRoomId}; command=bridge ${trimmedId}`);
      await client.sendTextMessage(bridgeRoomId, `bridge ${trimmedId}`)
        .catch((err) => failCurrentStep("send-bridge-command", err));
      finishStep("send-bridge-command", "ok");

      // Wait for the portal room to be created
      startStep("wait-for-portal", "Wait for Matrix portal room", "timeout=20s");
      const portal = await waitForPortal(client, trimmedId);

      if (!portal) {
        finishStep("wait-for-portal", "failed", "No joined portal room with matching Discord channel alias after 20s.");
        setError(
          "Bridge command sent, but the portal room wasn't created within 20 seconds. " +
          "The most common cause is that the bot is not a member of that Discord server — " +
          "use 'Add bot to Discord server' on the previous screen to invite it first.",
        );
        setScreen("error");
        return;
      }
      finishStep("wait-for-portal", "ok", `room=${portal.roomId}; name=${portal.name}`);

      // Optionally send test message
      if (sendTestMsg && testMsg.trim()) {
        startStep("send-test-message", "Send test message", `room=${portal.roomId}`);
        await client.sendTextMessage(portal.roomId, testMsg.trim())
          .catch((err) => failCurrentStep("send-test-message", err));
        finishStep("send-test-message", "ok");
      }

      setLinkedRoom(portal);
      setLinkedKind("text");
      setScreen("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setScreen("error");
    }
  }, [
    accessToken,
    activeChannelId,
    activeServerId,
    channelId,
    client,
    discordGuilds,
    ensureDiscordGuild,
    resolvedGuildNames,
    sendTestMsg,
    servers,
    setActiveChannel,
    setDMActive,
    testMsg,
    userId,
  ]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-surface-container rounded-2xl border border-outline-variant/20 shadow-2xl p-6 max-h-[85vh] flex flex-col">

        {/* ── Browse ── */}
        {screen === "browse" && (
          <>
            <Header title="Discord Bridge" onClose={onClose} />
            <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
              {resolvedGroups.length === 0 ? (
                /* Empty state: guide the user through the prerequisite steps */
                <div className="space-y-3 py-2">
                  <div className="rounded-xl border border-[#5865F2]/30 bg-[#5865F2]/5 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#5865F2] text-white text-xs font-bold flex-shrink-0">1</span>
                      <p className="text-sm font-medium text-on-surface">Add the bot to a Discord server</p>
                    </div>
                    <p className="text-xs text-on-surface-variant pl-7">
                      The bridge bot must be a member of the Discord server before it can relay messages.
                    </p>
                    <button
                      onClick={openInviteScreen}
                      className="ml-7 flex items-center gap-1.5 text-xs font-medium text-[#5865F2] hover:text-[#4752c4] transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">open_in_new</span>
                      Invite bot to Discord server
                    </button>
                  </div>
                  <div className="rounded-xl border border-outline-variant/20 bg-surface-container-high p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-outline-variant text-on-surface-variant text-xs font-bold flex-shrink-0">2</span>
                      <p className="text-sm font-medium text-on-surface">Link a Discord channel</p>
                    </div>
                    <p className="text-xs text-on-surface-variant pl-7">
                      Once the bot is in your server, link individual channels to create bridged rooms here in Concord.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {resolvedGroups.map((guild) => (
                    <div key={guild.guildId}>
                      <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5 px-1">
                        {guild.guildName}
                      </p>
                      <div className="space-y-0.5">
                        {guild.channels.map((ch) => (
                          <button
                            key={ch.roomId}
                            onClick={() => navigateTo(ch.roomId)}
                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[#5865F2]/10 text-left group transition-colors"
                          >
                            <span className="text-on-surface-variant/60 text-sm group-hover:text-[#5865F2]">#</span>
                            <span className="text-sm text-on-surface group-hover:text-[#5865F2] transition-colors">
                              {ch.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4 pt-4 border-t border-outline-variant/10 flex-shrink-0 space-y-2">
              <button
                onClick={async () => {
                  setScreen("bridge-guild");
                  if (accessToken) {
                    setGuildsLoading(true);
                    try {
                      const guilds = await discordBridgeHttpListGuilds(accessToken);
                      setDiscordGuilds(guilds);
                    } catch (err) {
                      console.error("Failed to load guilds:", err);
                    }
                    setGuildsLoading(false);
                  }
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#5865F2] hover:bg-[#4752c4] text-white text-sm font-medium transition-colors"
              >
                <span className="material-symbols-outlined text-base">dns</span>
                Bridge Discord Server
              </button>
              {/* "Add bot to another server" — secondary action, always visible */}
              <button
                onClick={openInviteScreen}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface text-xs transition-colors"
              >
                <span className="material-symbols-outlined text-sm">smart_toy</span>
                Add bot to {resolvedGroups.length > 0 ? "another" : "a"} Discord server
              </button>
              {/* Connect personal Discord account */}
              <button
                onClick={() => setScreen("login-account" as Screen)}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface text-xs transition-colors"
              >
                <span className="material-symbols-outlined text-sm">person</span>
                Connect your Discord account
              </button>
            </div>
          </>
        )}

        {/* ── Invite bot ── */}
        {screen === "invite-bot" && (
          <>
            <Header
              title="Add Bot to Discord Server"
              onBack={() => setScreen("browse")}
              onClose={onClose}
            />
            <div className="space-y-4">
              <p className="text-sm text-on-surface-variant">
                The bridge bot must be a member of the Discord server containing the channels you want to link.
              </p>
              <ol className="space-y-3 text-sm">
                <li className="flex gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#5865F2] text-white text-xs font-bold flex-shrink-0 mt-0.5">1</span>
                  <span className="text-on-surface-variant">
                    Click <strong className="text-on-surface">Open Discord Invite</strong> below — Discord will open in a new tab.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#5865F2] text-white text-xs font-bold flex-shrink-0 mt-0.5">2</span>
                  <span className="text-on-surface-variant">
                    Choose which Discord server to add the bot to, then click <strong className="text-on-surface">Authorize</strong>.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#5865F2] text-white text-xs font-bold flex-shrink-0 mt-0.5">3</span>
                  <span className="text-on-surface-variant">
                    Come back here and click <strong className="text-on-surface">Bot is in my server</strong>.
                  </span>
                </li>
              </ol>
              <button
                onClick={() => {
                  if (inviteUrl) {
                    window.open(inviteUrl, "_blank", "noopener,noreferrer");
                  }
                }}
                disabled={inviteUrlLoading || !inviteUrl}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#5865F2] hover:bg-[#4752c4] text-white text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {inviteUrlLoading ? (
                  <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                ) : (
                  <span className="material-symbols-outlined text-base">open_in_new</span>
                )}
                Open Discord Invite
              </button>
              <button
                onClick={() => setScreen("link-channel-id")}
                className="w-full py-2.5 rounded-xl border border-outline-variant/30 hover:bg-surface-container-high text-on-surface text-sm font-medium transition-colors"
              >
                Bot is in my server →
              </button>
            </div>
          </>
        )}

        {/* ── Connect personal Discord account ── */}
        {screen === "login-account" && (
          <>
            <Header
              title="Connect Your Account"
              onBack={() => setScreen("browse")}
              onClose={onClose}
            />
            <div className="space-y-4">
              <div className="rounded-xl border border-[#5865F2]/20 bg-[#5865F2]/5 p-4">
                <p className="text-sm text-on-surface mb-3">
                  Connect your personal Discord account so your messages appear
                  under your own name instead of through the bot relay.
                </p>
                <p className="text-xs text-on-surface-variant mb-1 font-medium">
                  Both run in parallel — the bot relay handles everyone else.
                </p>
              </div>
              <ol className="text-sm text-on-surface-variant list-decimal list-inside space-y-2.5 px-1">
                <li>
                  Open a DM with{" "}
                  <code className="bg-surface-container-highest px-1.5 py-0.5 rounded text-on-surface text-xs">
                    @discordbot
                  </code>
                </li>
                <li>
                  Send the message <strong className="text-on-surface">login</strong>
                </li>
                <li>The bot replies with a QR code</li>
                <li>
                  Discord mobile → <strong className="text-on-surface">Settings → Scan QR Code</strong>
                </li>
              </ol>
              <div className="pt-2">
                <button
                  onClick={() => {
                    // Navigate to DM with discordbot
                    if (client && userId) {
                      const serverDomain = userId.split(":")[1] ?? "";
                      const botUserId = `@discordbot:${serverDomain}`;
                      const dmRoom = client.getRooms().find((r) => {
                        if (r.getMyMembership() !== "join") return false;
                        const alias = r.getCanonicalAlias() ?? "";
                        if (alias.includes("_discord_")) return false;
                        return r.getJoinedMembers().some((m) => m.userId === botUserId);
                      });
                      if (dmRoom) {
                        setDMActive(true);
                        const { setActiveDM } = useDMStore.getState();
                        setActiveDM(dmRoom.roomId);
                        onClose();
                        return;
                      }
                    }
                    onClose();
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#5865F2] hover:bg-[#4752c4] text-white text-sm font-medium transition-colors"
                >
                  <span className="material-symbols-outlined text-base">chat</span>
                  Open DM with @discordbot
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Bridge entire guild ── */}
        {screen === "bridge-guild" && (
          <>
            <Header title="Bridge Discord Server" onBack={() => setScreen("browse")} onClose={onClose} />
            <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
              {guildsLoading ? (
                <div className="flex items-center justify-center py-8 gap-2 text-on-surface-variant">
                  <span className="inline-block w-4 h-4 border-2 border-[#5865F2] border-t-transparent rounded-full animate-spin" />
                  Loading servers...
                </div>
              ) : discordGuilds.length === 0 ? (
                <p className="text-sm text-on-surface-variant text-center py-8">
                  No Discord servers found. Make sure the bot is invited to at least one server.
                </p>
              ) : (
                <div className="space-y-1">
                  {discordGuilds.map((guild) => {
                    const alreadyBridged = resolvedGroups.some((g) => g.guildId === guild.id);
                    const isBridging = bridgingGuildId === guild.id;
                    return (
                      <div
                        key={guild.id}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[#5865F2]/10 transition-colors"
                      >
                        <div className="w-9 h-9 rounded-lg bg-[#5865F2]/20 flex items-center justify-center text-[#5865F2] text-sm font-bold flex-shrink-0">
                          {guild.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-on-surface font-medium truncate">{guild.name}</p>
                          <p className="text-xs text-on-surface-variant">{guild.id}</p>
                        </div>
                        {alreadyBridged ? (
                          <span className="text-xs text-green-500 font-medium">Bridged</span>
                        ) : (
                          <button
                            disabled={isBridging}
                            onClick={async () => {
                              if (!client || !userId) return;
                              setBridgingGuildId(guild.id);
                              try {
                                // Find or create DM with discordbot for management commands
                                const serverDomain = userId.split(":")[1] ?? "";
                                const botUserId = `@discordbot:${serverDomain}`;
                                let mgmtRoom: string | null = null;
                                for (const room of client.getRooms()) {
                                  if (room.getMyMembership() !== "join") continue;
                                  if (room.getCanonicalAlias()?.includes("_discord_")) continue;
                                  const members = room.getJoinedMembers();
                                  if (members.length <= 2 && members.some((m) => m.userId === botUserId)) {
                                    mgmtRoom = room.roomId;
                                    break;
                                  }
                                }
                                if (!mgmtRoom) {
                                  const created = await client.createRoom({
                                    is_direct: true,
                                    invite: [botUserId],
                                    // @ts-expect-error — matrix-js-sdk accepts string literal
                                    preset: "trusted_private_chat",
                                  });
                                  mgmtRoom = created.room_id;
                                  await new Promise((r) => setTimeout(r, 2000));
                                }
                                // Send guilds bridge command
                                await client.sendTextMessage(mgmtRoom, `guilds bridge ${guild.id}`);
                                // Wait for rooms to appear
                                await new Promise((r) => setTimeout(r, 5000));
                                // Refresh guild groups by closing and reopening
                                setScreen("browse");
                              } catch (err) {
                                setError(err instanceof Error ? err.message : "Failed to bridge guild");
                                setScreen("error");
                              } finally {
                                setBridgingGuildId(null);
                              }
                            }}
                            className="px-3 py-1.5 bg-[#5865F2] hover:bg-[#4752c4] text-white text-xs rounded-lg transition-colors disabled:opacity-50"
                          >
                            {isBridging ? "Bridging..." : "Bridge"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Enter channel ID ── */}
        {screen === "link-channel-id" && (
          <>
            <Header
              title="Link Discord Channel"
              onBack={() => setScreen("invite-bot")}
              onClose={onClose}
            />
            <div className="space-y-4">
              <div className="rounded-lg bg-surface-container-high px-4 py-3 text-xs text-on-surface-variant space-y-1.5">
                <p className="font-medium text-on-surface">How to get a channel ID:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Open Discord → User Settings → Advanced → enable <strong>Developer Mode</strong></li>
                  <li>Right-click any channel → <strong>Copy Channel ID</strong></li>
                </ol>
              </div>
              <div>
                <label className="text-xs font-label text-on-surface-variant mb-1.5 block">
                  Discord Channel ID
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value.replace(/\D/g, ""))}
                  placeholder="1234567890123456789"
                  className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm font-mono text-on-surface border border-outline-variant/20 focus:border-[#5865F2]/50 focus:outline-none"
                />
              </div>
              <button
                onClick={() => {
                  if (channelId.trim().length >= 17) setScreen("link-test-msg");
                }}
                disabled={channelId.trim().length < 17}
                className="w-full py-2.5 bg-[#5865F2] hover:bg-[#4752c4] text-white rounded-lg text-sm font-medium disabled:opacity-40 transition-colors"
              >
                Next
              </button>
            </div>
          </>
        )}

        {/* ── Test message ── */}
        {screen === "link-test-msg" && (
          <>
            <Header
              title="Test Message"
              onBack={() => setScreen("link-channel-id")}
              onClose={onClose}
            />
            <div className="space-y-4">
              <p className="text-sm text-on-surface-variant">
                After the bridge connects, optionally send a message to the Discord channel so you can confirm the bot is posting correctly.
              </p>
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => setSendTestMsg((v) => !v)}
                  className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${
                    sendTestMsg ? "bg-[#5865F2]" : "bg-outline-variant"
                  }`}
                >
                  <span
                    className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                      sendTestMsg ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </div>
                <span className="text-sm text-on-surface">Send a test message</span>
              </label>
              {sendTestMsg && (
                <div>
                  <label className="text-xs font-label text-on-surface-variant mb-1.5 block">
                    Message text
                  </label>
                  <input
                    type="text"
                    value={testMsg}
                    onChange={(e) => setTestMsg(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-container-highest rounded-lg text-sm text-on-surface border border-outline-variant/20 focus:border-[#5865F2]/50 focus:outline-none"
                  />
                </div>
              )}
              <button
                onClick={handleLink}
                className="w-full py-2.5 bg-[#5865F2] hover:bg-[#4752c4] text-white rounded-lg text-sm font-medium transition-colors"
              >
                Link Channel
              </button>
            </div>
          </>
        )}

        {/* ── Linking spinner ── */}
        {screen === "linking" && (
          <div className="flex flex-col items-center gap-4 py-10">
            <span className="inline-block w-8 h-8 border-2 border-outline-variant border-t-[#5865F2] rounded-full animate-spin" />
            <p className="text-sm text-on-surface-variant text-center">
              Connecting Discord channel...
              <br />
              <span className="text-xs">Text channels create portal rooms. Voice channels connect through LiveKit.</span>
            </p>
            <LinkStepList steps={linkSteps} />
          </div>
        )}

        {/* ── Done ── */}
        {screen === "done" && (
          <>
            <Header title="Channel Linked!" onClose={onClose} />
            <div className="space-y-4">
              <div className="rounded-lg bg-[#5865F2]/10 border border-[#5865F2]/20 px-4 py-3 flex items-start gap-3">
                <span className="material-symbols-outlined text-[#5865F2] text-xl flex-shrink-0 mt-0.5">check_circle</span>
                <div className="text-sm">
                  <p className="font-medium text-on-surface">
                    {linkedRoom?.name ?? (linkedKind === "voice" ? "Voice channel connected" : "Portal room created")}
                  </p>
                  {linkedKind === "voice" ? (
                    <p className="text-xs text-on-surface-variant mt-0.5">
                      Join this Concord voice channel to participate in the Discord voice room.
                    </p>
                  ) : sendTestMsg && (
                    <p className="text-xs text-on-surface-variant mt-0.5">
                      Test message sent — check Discord to confirm the bot posted it.
                    </p>
                  )}
                </div>
              </div>
              <p className="text-xs text-on-surface-variant">
                {linkedKind === "voice"
                  ? "The Discord voice channel is mapped to a Concord voice channel. The sidecar will keep the audio bridge synced."
                  : "The channel is now bridged. Messages will sync between Discord and Concord in both directions."}
              </p>
              <LinkStepList steps={linkSteps} />
              {linkedRoom && (
                <button
                  onClick={() => navigateTo(linkedRoom.roomId)}
                  className="w-full py-2.5 bg-[#5865F2] hover:bg-[#4752c4] text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Open Channel
                </button>
              )}
              <button
                onClick={() => {
                  setScreen("browse");
                  setChannelId("");
                  setLinkedRoom(null);
                  setLinkedKind("text");
                }}
                className="w-full py-2 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm transition-colors"
              >
                Link Another
              </button>
            </div>
          </>
        )}

        {/* ── Error ── */}
        {screen === "error" && (
          <>
            <Header title="Link Failed" onClose={onClose} />
            <div className="space-y-3">
              <div className="rounded-lg bg-error/10 border border-error/20 px-4 py-3">
                <p className="text-sm text-error">{error}</p>
              </div>
              <LinkStepList steps={linkSteps} />
              {/* If error looks like a bot-membership issue, offer a direct shortcut */}
              {error.includes("not a member") && (
                <button
                  onClick={openInviteScreen}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#5865F2] hover:bg-[#4752c4] text-white rounded-lg text-sm font-medium transition-colors"
                >
                  <span className="material-symbols-outlined text-base">person_add</span>
                  Add bot to Discord server
                </button>
              )}
              <button
                onClick={() => setScreen("browse")}
                className="w-full py-2.5 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg text-sm font-medium transition-colors"
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
