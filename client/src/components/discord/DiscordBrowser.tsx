/**
 * Full-screen overlay that lets the user browse their Discord guilds.
 *
 * Opened from Settings → Connections → "Browse your Discord servers"
 * when the OAuth session is connected. Four columns:
 *
 *   ┌────────┬────────────┬──────────────┬───────────────┐
 *   │ guilds │ channels   │ messages     │ composer      │
 *   └────────┴────────────┴──────────────┴───────────────┘
 *
 * (Channels + messages + composer are rendered by `DiscordPanel`.)
 *
 * The overlay also doubles as a persistence surface for the user's
 * last-active guild — stored in localStorage so re-opening the
 * browser lands on the guild you were last looking at.
 */
import { useEffect, useState } from "react";
import { useDiscordGuilds } from "../../hooks/useDiscord";
import type { DiscordGuild } from "../../api/concord";
import { DiscordPanel } from "./DiscordPanel";

const LAST_GUILD_KEY = "concord.discord.last_guild_id";

interface Props {
  onClose: () => void;
}

export function DiscordBrowser({ onClose }: Props) {
  const { guilds, loading, error, refresh } = useDiscordGuilds(true);
  const [activeGuild, setActiveGuild] = useState<DiscordGuild | null>(null);

  // Restore the last-used guild once guilds load, but only if it's
  // still in the current list (Discord memberships change over time).
  useEffect(() => {
    if (activeGuild || !guilds) return;
    try {
      const saved = localStorage.getItem(LAST_GUILD_KEY);
      const match = saved ? guilds.find((g) => g.id === saved) : null;
      setActiveGuild(match ?? guilds[0] ?? null);
    } catch {
      setActiveGuild(guilds[0] ?? null);
    }
  }, [guilds, activeGuild]);

  // Persist the guild id when it changes so the next open resumes here.
  useEffect(() => {
    if (!activeGuild) return;
    try {
      localStorage.setItem(LAST_GUILD_KEY, activeGuild.id);
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [activeGuild]);

  // Esc dismisses the overlay. Matches the lightbox pattern we use
  // elsewhere so the UX is consistent across modal surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/60 backdrop-blur-sm flex"
      role="dialog"
      aria-modal="true"
      aria-label="Discord browser"
    >
      {/* Guild rail */}
      <aside className="w-16 bg-surface-container-low border-r border-outline-variant/15 flex flex-col items-center py-3 gap-2 overflow-y-auto">
        <button
          onClick={onClose}
          className="w-12 h-12 rounded-2xl bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface flex items-center justify-center"
          aria-label="Close Discord browser"
          title="Close"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
        <div className="w-8 h-px bg-outline-variant/20" />
        {loading && !guilds && (
          <p className="text-[10px] text-on-surface-variant/60 rotate-90 whitespace-nowrap mt-10">
            loading…
          </p>
        )}
        {error && (
          <div className="px-2 text-[10px] text-error text-center">
            {error}
            <button
              onClick={() => void refresh()}
              className="block mt-1 underline"
            >
              Retry
            </button>
          </div>
        )}
        {guilds?.map((g) => {
          const isActive = activeGuild?.id === g.id;
          return (
            <button
              key={g.id}
              onClick={() => setActiveGuild(g)}
              title={g.name}
              className={`w-12 h-12 rounded-2xl overflow-hidden flex items-center justify-center transition-all ${
                isActive
                  ? "bg-[#5865F2] text-white rounded-xl shadow-[0_0_12px_rgba(88,101,242,0.45)]"
                  : "bg-surface-container-high text-on-surface-variant hover:rounded-xl hover:bg-surface-container-highest"
              }`}
            >
              {g.icon_url ? (
                <img src={g.icon_url} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-sm font-semibold">
                  {g.name.trim().slice(0, 1).toUpperCase()}
                </span>
              )}
            </button>
          );
        })}
      </aside>

      {/* Active guild pane */}
      <div className="flex-1 min-w-0 bg-surface">
        {activeGuild ? (
          <DiscordPanel guild={activeGuild} />
        ) : (
          <div className="h-full flex items-center justify-center text-on-surface-variant">
            {loading
              ? "Loading your Discord servers…"
              : guilds && guilds.length === 0
                ? "You aren't a member of any Discord servers."
                : "Pick a server on the left."}
          </div>
        )}
      </div>
    </div>
  );
}
