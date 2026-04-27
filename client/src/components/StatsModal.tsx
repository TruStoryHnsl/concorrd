import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/auth";
import { useServerStore } from "../stores/server";
import { getMyStats, type UserStats, type StatsDay } from "../api/concord";

const EMPTY_SERVER_MEMBERS: { user_id: string; role: string; display_name?: string | null }[] = [];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDurationLong(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

type Tab = "voice" | "messages";

function BarChart({
  data,
  valueKey,
  formatValue,
  color,
  emptyLabel,
}: {
  data: StatsDay[];
  valueKey: "voice_seconds" | "messages";
  formatValue: (v: number) => string;
  color: string;
  emptyLabel: string;
}) {
  const values = data.map((d) => d[valueKey]);
  const max = Math.max(...values, 1);

  // Show last 14 days for readability
  const recent = data.slice(-14);

  if (values.every((v) => v === 0)) {
    return (
      <p className="text-on-surface-variant text-sm text-center py-8">{emptyLabel}</p>
    );
  }

  return (
    <div className="flex items-end gap-1 h-32">
      {recent.map((d) => {
        const val = d[valueKey];
        const pct = max > 0 ? (val / max) * 100 : 0;
        const date = new Date(d.day + "T00:00:00");
        const label = date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        return (
          <div
            key={d.day}
            className="flex-1 flex flex-col items-center gap-1 min-w-0"
          >
            <div className="w-full flex flex-col items-center justify-end h-24">
              {val > 0 && (
                <span className="text-[10px] text-on-surface-variant mb-0.5 truncate">
                  {formatValue(val)}
                </span>
              )}
              <div
                className="w-full rounded-t transition-all"
                style={{
                  height: `${Math.max(pct, val > 0 ? 4 : 0)}%`,
                  backgroundColor: color,
                  minHeight: val > 0 ? 2 : 0,
                }}
              />
            </div>
            <span className="text-[9px] text-on-surface-variant/50 truncate w-full text-center">
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function StatsModal({ onClose, serverId }: { onClose: () => void; serverId?: string }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);
  const server = useServerStore((s) =>
    serverId ? s.servers.find((entry) => entry.id === serverId) ?? null : null,
  );
  const membersByServer = useServerStore((s) => s.members);
  const members = serverId ? membersByServer[serverId] ?? EMPTY_SERVER_MEMBERS : EMPTY_SERVER_MEMBERS;
  const [stats, setStats] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("voice");
  const [days, setDays] = useState(30);

  useEffect(() => {
    if (serverId) {
      setLoading(false);
      return;
    }
    if (!accessToken) return;
    setLoading(true);
    getMyStats(accessToken, days)
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accessToken, days, serverId]);

  if (serverId && server) {
    const textChannels = server.channels.filter((channel) => channel.channel_type === "text").length;
    const voiceChannels = server.channels.filter((channel) => channel.channel_type === "voice").length;
    const memberCount = members.length;
    const role =
      server.owner_id === userId
        ? "Owner"
        : members.find((member) => member.user_id === userId)?.role ?? "Member";
    const serverKind = server.federated ? "Federated" : "Concord";

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="bg-surface border border-outline-variant/15 rounded-lg shadow-xl w-full max-w-lg mx-4">
          <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/15">
            <h2 className="text-lg font-semibold text-on-surface">{server.name} Stats</h2>
            <button
              onClick={onClose}
              className="text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
                <p className="text-xs text-on-surface-variant">Channels</p>
                <p className="text-xl font-bold text-primary">{server.channels.length}</p>
              </div>
              <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
                <p className="text-xs text-on-surface-variant">Members Loaded</p>
                <p className="text-xl font-bold text-secondary">{memberCount}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
                <p className="text-xs text-on-surface-variant">Text Channels</p>
                <p className="text-lg font-semibold text-on-surface">{textChannels}</p>
              </div>
              <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
                <p className="text-xs text-on-surface-variant">Voice Channels</p>
                <p className="text-lg font-semibold text-on-surface">{voiceChannels}</p>
              </div>
            </div>

            <div className="bg-surface-container rounded-lg p-4 border border-outline-variant/15 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-on-surface-variant">Server Type</span>
                <span className="text-sm text-on-surface font-medium">{serverKind}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-on-surface-variant">Your Role</span>
                <span className="text-sm text-on-surface font-medium">{role}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-on-surface-variant">Visibility</span>
                <span className="text-sm text-on-surface font-medium capitalize">{server.visibility}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-on-surface-variant">Media Uploads</span>
                <span className="text-sm text-on-surface font-medium">{server.media_uploads_enabled ? "Enabled" : "Disabled"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-outline-variant/15 rounded-lg shadow-xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/15">
          <h2 className="text-lg font-semibold text-on-surface">Your Stats</h2>
          <button
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {loading ? (
            <p className="text-on-surface-variant text-sm text-center py-8">
              Loading stats...
            </p>
          ) : !stats ? (
            <p className="text-on-surface-variant text-sm text-center py-8">
              Failed to load stats
            </p>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
                  <p className="text-xs text-on-surface-variant">Total Voice Time</p>
                  <p className="text-xl font-bold text-primary">
                    {formatDurationLong(stats.total_voice_seconds)}
                  </p>
                </div>
                <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
                  <p className="text-xs text-on-surface-variant">Messages Sent</p>
                  <p className="text-xl font-bold text-secondary">
                    {stats.total_messages.toLocaleString()}
                  </p>
                </div>
              </div>

              {stats.active_since && (
                <div className="bg-primary/10 border border-primary/30 rounded-lg px-3 py-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-sm text-primary">
                    Currently in voice
                  </span>
                </div>
              )}

              {/* Tabs */}
              <div className="flex gap-1 border-b border-outline-variant/15">
                <button
                  onClick={() => setTab("voice")}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    tab === "voice"
                      ? "text-primary border-b-2 border-primary"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  Voice
                </button>
                <button
                  onClick={() => setTab("messages")}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    tab === "messages"
                      ? "text-secondary border-b-2 border-secondary"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  Messages
                </button>
                <div className="flex-1" />
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="bg-surface-container border border-outline-variant/15 text-on-surface text-xs rounded px-2 py-1 mb-1"
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>

              {/* Charts */}
              <div className="pt-2">
                {tab === "voice" && (
                  <BarChart
                    data={stats.daily}
                    valueKey="voice_seconds"
                    formatValue={formatDuration}
                    color="#6366f1"
                    emptyLabel="No voice activity in this period"
                  />
                )}
                {tab === "messages" && (
                  <BarChart
                    data={stats.daily}
                    valueKey="messages"
                    formatValue={(v) => String(v)}
                    color="#10b981"
                    emptyLabel="No messages in this period"
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
