/**
 * Discord user surface.
 *
 * Renders when a Discord guild is the active context (selected from
 * the Sources sidebar or a future mobile route). Three-pane layout:
 *
 *   ┌────────────┬──────────────────────────────────────┐
 *   │ guild tile │ channels list │ messages + composer  │
 *   └────────────┴──────────────────────────────────────┘
 *
 * Phase-3 captured-session proxy is best-effort — when the bridge
 * session isn't wired, the channel / message endpoints return
 * ``limited_by_discord: true`` and we render a clear explainer card
 * rather than an empty pane.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "../../stores/auth";
import {
  useDiscordChannels,
  useDiscordMessages,
  sendDiscordMessage,
  type DiscordChannelEntry,
} from "../../hooks/useDiscord";
import type { DiscordGuild } from "../../api/concord";

function iconInitial(name: string): string {
  const first = name.trim()[0];
  return first ? first.toUpperCase() : "?";
}

function formatTimestamp(raw: string): string {
  try {
    const d = new Date(raw);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return raw;
  }
}

interface Props {
  guild: DiscordGuild;
  onClose?: () => void;
}

export function DiscordPanel({ guild, onClose }: Props) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const channelsState = useDiscordChannels(guild.id);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const messagesState = useDiscordMessages(activeChannelId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Auto-pick the first text channel once the list loads so the user
  // doesn't stare at a blank message pane.
  useEffect(() => {
    if (activeChannelId) return;
    const channels = channelsState.state?.channels;
    if (!channels) return;
    const firstText = channels.find((c) => c.type === 0);
    if (firstText) setActiveChannelId(firstText.id);
  }, [channelsState.state, activeChannelId]);

  // Scroll the message pane to the bottom whenever messages change so
  // the latest reply is always in view after a send / poll tick.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messagesState.state?.messages?.length]);

  const channelGroups = useMemo(() => {
    const list = channelsState.state?.channels ?? [];
    const categories: { id: string | null; name: string; children: DiscordChannelEntry[] }[] = [
      { id: null, name: "", children: [] },
    ];
    const byCat = new Map<string, DiscordChannelEntry[]>();
    for (const c of list) {
      if (c.type === 4) {
        categories.push({ id: c.id, name: c.name ?? "", children: [] });
        continue;
      }
      const key = c.parent_id ?? "__root__";
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push(c);
    }
    for (const g of categories) {
      const key = g.id ?? "__root__";
      g.children = byCat.get(key) ?? [];
    }
    // Drop empty root / empty categories.
    return categories.filter((g) => g.children.length > 0);
  }, [channelsState.state]);

  const limited = channelsState.state?.limited_by_discord ?? false;
  const activeChannel =
    channelsState.state?.channels.find((c) => c.id === activeChannelId) ?? null;

  const handleSend = async () => {
    if (!accessToken || !activeChannelId || !draft.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      await sendDiscordMessage(accessToken, activeChannelId, draft);
      setDraft("");
      void messagesState.refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-surface">
      {/* Channels column */}
      <aside className="w-56 flex-shrink-0 bg-surface-container-low border-r border-outline-variant/15 flex flex-col min-h-0">
        <header className="px-3 py-3 border-b border-outline-variant/10 flex items-center gap-2">
          {guild.icon_url ? (
            <img src={guild.icon_url} alt="" className="w-6 h-6 rounded-md" />
          ) : (
            <div className="w-6 h-6 rounded-md bg-[#5865F2]/25 text-[#5865F2] text-xs font-bold flex items-center justify-center">
              {iconInitial(guild.name)}
            </div>
          )}
          <span className="text-sm font-semibold text-on-surface truncate">
            {guild.name}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="ml-auto p-1 rounded hover:bg-surface-container-high text-on-surface-variant"
              aria-label="Close Discord view"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          )}
        </header>
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {channelsState.loading && !channelsState.state && (
            <p className="text-xs text-on-surface-variant px-2">Loading channels…</p>
          )}
          {channelsState.error && (
            <p className="text-xs text-error px-2">{channelsState.error}</p>
          )}
          {limited && (
            <div className="m-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-1">
              <p className="font-medium">Read-only fallback</p>
              <p className="text-amber-200/80">
                Discord's OAuth2 API doesn't include channel/message access.
                Enable the mautrix-discord bridge + QR-capture flow for full
                read/send here, or open the guild in Discord directly.
              </p>
              <a
                href={`https://discord.com/channels/${guild.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-1 text-amber-300 underline"
              >
                Open in Discord ↗
              </a>
            </div>
          )}
          {channelGroups.map((group) => (
            <div key={group.id ?? "__root__"}>
              {group.name && (
                <p className="px-2 text-[10px] uppercase tracking-wider text-on-surface-variant/60 font-label mb-1">
                  {group.name}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.children.map((c) => {
                  const isActive = c.id === activeChannelId;
                  const icon = c.type === 2 ? "volume_up" : c.type === 13 ? "podium" : "tag";
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => setActiveChannelId(c.id)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left ${
                          isActive
                            ? "bg-[#5865F2]/20 text-on-surface"
                            : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                        }`}
                      >
                        <span className="material-symbols-outlined text-sm text-on-surface-variant/70">
                          {icon}
                        </span>
                        <span className="truncate">{c.name ?? c.id}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      {/* Messages + composer */}
      <section className="flex-1 min-w-0 flex flex-col">
        <header className="px-4 py-3 border-b border-outline-variant/10 flex items-center gap-2">
          <span className="material-symbols-outlined text-on-surface-variant">tag</span>
          <h3 className="text-sm font-semibold text-on-surface truncate">
            {activeChannel?.name ?? "No channel selected"}
          </h3>
          {activeChannel?.topic && (
            <span className="text-xs text-on-surface-variant/60 truncate ml-2">
              · {activeChannel.topic}
            </span>
          )}
        </header>
        <div
          ref={scrollerRef}
          className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0"
        >
          {!activeChannelId && (
            <p className="text-sm text-on-surface-variant">
              Pick a channel on the left to see messages.
            </p>
          )}
          {activeChannelId && messagesState.loading && !messagesState.state && (
            <p className="text-sm text-on-surface-variant">Loading messages…</p>
          )}
          {messagesState.error && (
            <p className="text-sm text-error">{messagesState.error}</p>
          )}
          {messagesState.state?.limited_by_discord && (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
              Messages for this channel aren't available via OAuth alone. Set
              up the mautrix-discord bridge capture flow to enable read/send.
            </div>
          )}
          {messagesState.state?.messages.map((m) => (
            <article key={m.id} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center overflow-hidden flex-shrink-0">
                {m.author.avatar ? (
                  <img
                    src={`https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64`}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs font-semibold text-on-surface-variant">
                    {iconInitial(m.author.global_name || m.author.username)}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-on-surface">
                    {m.author.global_name || m.author.username}
                  </span>
                  <span className="text-[10px] text-on-surface-variant/60">
                    {formatTimestamp(m.timestamp)}
                  </span>
                </div>
                <p className="text-sm text-on-surface whitespace-pre-wrap break-words">
                  {m.content || <em className="text-on-surface-variant/70">[no text]</em>}
                </p>
              </div>
            </article>
          ))}
        </div>
        <footer className="border-t border-outline-variant/15 p-3">
          {sendError && (
            <p className="text-xs text-error mb-2">{sendError}</p>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={!activeChannelId || sending || messagesState.state?.limited_by_discord}
              placeholder={
                !activeChannelId
                  ? "Select a channel first"
                  : messagesState.state?.limited_by_discord
                    ? "Sending requires the bridge capture flow"
                    : `Message #${activeChannel?.name ?? "channel"}`
              }
              className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-[#5865F2]/40 disabled:opacity-50"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!activeChannelId || sending || !draft.trim() || messagesState.state?.limited_by_discord}
              className="px-4 py-2 bg-[#5865F2] hover:bg-[#5865F2]/90 disabled:opacity-40 text-white text-sm rounded transition-colors"
            >
              {sending ? "…" : "Send"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
