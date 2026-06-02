import { useEffect, useState } from "react";
import { Avatar } from "../ui/Avatar";
import { getMyStats, type UserStats } from "../../api/concord";
import { useAuthStore } from "../../stores/auth";

function formatVoiceSummary(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/** Desktop dropdown opened from the avatar in the top bar. Shows recent
 *  message + voice stats and quick links to settings / full stats. */
export function UserStatsPopover({
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

/** Avatar + name button in the desktop top bar that toggles the
 *  UserStatsPopover. Renders nothing when no user is signed in. */
export function DesktopAccountButton({
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

/** Mobile account sheet (T003). Bottom-sheet on mobile, centered modal on
 *  desktop. Action: log out. */
export function AccountSheet({
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
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-panel w-full max-w-sm rounded-t-2xl md:rounded-2xl p-5 m-0 md:m-4 animate-[fadeSlideUp_0.25s_ease-out] safe-bottom">
        <div className="flex items-center gap-3 mb-4 min-w-0">
          <div className="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant">person</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-on-surface-variant font-label">Signed in as</p>
            <p className="text-sm font-headline font-semibold text-on-surface break-all min-w-0">
              {username}
            </p>
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
