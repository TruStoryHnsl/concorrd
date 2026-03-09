import { useState, useEffect } from "react";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import {
  getAdminStats,
  getAdminServers,
  getAdminUsers,
  getAdminReports,
  updateAdminReport,
  getInstanceInfo,
  updateInstanceName,
  type AdminStats,
  type AdminServer,
  type AdminUser,
  type AdminBugReport,
} from "../../api/concorrd";

type Section = "overview" | "instance" | "servers" | "users" | "reports";

export function AdminTab() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [section, setSection] = useState<Section>("overview");

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-white">Admin Dashboard</h3>

      <div className="flex gap-1 border-b border-zinc-700 pb-2">
        {(["overview", "instance", "servers", "users", "reports"] as Section[]).map(
          (s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-3 py-1.5 text-sm rounded-t transition-colors ${
                section === s
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ),
        )}
      </div>

      {section === "overview" && <OverviewSection token={accessToken} />}
      {section === "instance" && <InstanceSection token={accessToken} />}
      {section === "servers" && <ServersSection token={accessToken} />}
      {section === "users" && <UsersSection token={accessToken} />}
      {section === "reports" && <ReportsSection token={accessToken} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewSection({ token }: { token: string | null }) {
  const [stats, setStats] = useState<AdminStats | null>(null);

  useEffect(() => {
    if (!token) return;
    getAdminStats(token).then(setStats).catch(() => {});
  }, [token]);

  if (!stats)
    return <p className="text-zinc-500 text-sm">Loading stats...</p>;

  const cards: { label: string; value: number; accent?: string }[] = [
    { label: "Servers", value: stats.total_servers },
    { label: "Users", value: stats.total_users },
    { label: "Channels", value: stats.total_channels },
    { label: "Invites", value: stats.total_invites },
    { label: "Soundboard Clips", value: stats.total_soundboard_clips },
    { label: "Webhooks", value: stats.total_webhooks },
    {
      label: "Open Reports",
      value: stats.open_reports,
      accent: stats.open_reports > 0 ? "text-amber-400" : undefined,
    },
    { label: "Total Reports", value: stats.total_reports },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-zinc-800 rounded-lg p-3 border border-zinc-700"
        >
          <p className="text-xs text-zinc-500">{c.label}</p>
          <p className={`text-2xl font-bold ${c.accent ?? "text-white"}`}>
            {c.value}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

function InstanceSection({ token }: { token: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getInstanceInfo().then((info) => setName(info.name)).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!token || !name.trim()) return;
    setSaving(true);
    try {
      const result = await updateInstanceName(name.trim(), token);
      setName(result.name);
      document.title = result.name;
      addToast("Instance name updated", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm text-zinc-400 block mb-1">Instance Name</label>
        <p className="text-xs text-zinc-500 mb-2">
          Displayed on the login page, browser tab, and emails. This is your instance's brand name.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
            placeholder="Concord"
          />
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded transition-colors"
          >
            {saving ? "..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

function ServersSection({ token }: { token: string | null }) {
  const [servers, setServers] = useState<AdminServer[] | null>(null);

  useEffect(() => {
    if (!token) return;
    getAdminServers(token).then(setServers).catch(() => {});
  }, [token]);

  if (!servers)
    return <p className="text-zinc-500 text-sm">Loading servers...</p>;

  if (servers.length === 0)
    return <p className="text-zinc-500 text-sm">No servers.</p>;

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-1 text-xs text-zinc-500 font-medium">
        <span>Name</span>
        <span>Visibility</span>
        <span>Members</span>
        <span>Created</span>
      </div>
      {servers.map((s) => (
        <div
          key={s.id}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-2 rounded bg-zinc-800/50 text-sm items-center"
        >
          <div>
            <span className="text-white">{s.name}</span>
            <span className="text-zinc-600 text-xs ml-2">{s.id}</span>
          </div>
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              s.visibility === "public"
                ? "bg-emerald-900/40 text-emerald-400"
                : "bg-zinc-700 text-zinc-400"
            }`}
          >
            {s.visibility}
          </span>
          <span className="text-zinc-300 text-center">{s.member_count}</span>
          <span className="text-zinc-500 text-xs">
            {s.created_at
              ? new Date(s.created_at).toLocaleDateString()
              : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function UsersSection({ token }: { token: string | null }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);

  useEffect(() => {
    if (!token) return;
    getAdminUsers(token).then(setUsers).catch(() => {});
  }, [token]);

  if (!users)
    return <p className="text-zinc-500 text-sm">Loading users...</p>;

  if (users.length === 0)
    return <p className="text-zinc-500 text-sm">No users.</p>;

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-1 text-xs text-zinc-500 font-medium">
        <span>User</span>
        <span>Servers</span>
        <span>Role</span>
        <span>First Seen</span>
      </div>
      {users.map((u) => (
        <div
          key={u.user_id}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-2 rounded bg-zinc-800/50 text-sm items-center"
        >
          <span className="text-white font-mono text-xs truncate">
            {u.user_id}
          </span>
          <span className="text-zinc-300 text-center">{u.server_count}</span>
          <div className="flex gap-1">
            {u.is_admin && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-400">
                admin
              </span>
            )}
            {u.has_owner_role && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400">
                owner
              </span>
            )}
            {!u.is_admin && !u.has_owner_role && (
              <span className="text-xs text-zinc-500">member</span>
            )}
          </div>
          <span className="text-zinc-500 text-xs">
            {u.first_seen
              ? new Date(u.first_seen).toLocaleDateString()
              : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  open: "bg-amber-900/40 text-amber-400",
  in_progress: "bg-blue-900/40 text-blue-400",
  resolved: "bg-emerald-900/40 text-emerald-400",
  closed: "bg-zinc-700 text-zinc-400",
};

const STATUS_OPTIONS = ["open", "in_progress", "resolved", "closed"];

function ReportsSection({ token }: { token: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [reports, setReports] = useState<AdminBugReport[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    getAdminReports(token).then(setReports).catch(() => {});
  }, [token]);

  const handleStatusChange = async (id: number, status: string) => {
    if (!token) return;
    try {
      await updateAdminReport(id, { status }, token);
      setReports(
        (prev) =>
          prev?.map((r) => (r.id === id ? { ...r, status } : r)) ?? null,
      );
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to update report",
      );
    }
  };

  const handleNotesUpdate = async (id: number, notes: string) => {
    if (!token) return;
    try {
      await updateAdminReport(id, { admin_notes: notes }, token);
      setReports(
        (prev) =>
          prev?.map((r) =>
            r.id === id ? { ...r, admin_notes: notes } : r,
          ) ?? null,
      );
      addToast("Notes saved", "success");
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to save notes",
      );
    }
  };

  if (!reports)
    return <p className="text-zinc-500 text-sm">Loading reports...</p>;

  if (reports.length === 0)
    return <p className="text-zinc-500 text-sm">No bug reports yet.</p>;

  return (
    <div className="space-y-2">
      {reports.map((r) => (
        <div
          key={r.id}
          className="bg-zinc-800/50 rounded border border-zinc-700"
        >
          <button
            onClick={() => setExpanded(expanded === r.id ? null : r.id)}
            className="w-full text-left px-3 py-2 flex items-center gap-3"
          >
            <span className="text-white text-sm flex-1 truncate">
              #{r.id} — {r.title}
            </span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[r.status] ?? STATUS_COLORS.open}`}
            >
              {r.status.replace("_", " ")}
            </span>
            <span className="text-zinc-500 text-xs">
              {new Date(r.created_at).toLocaleDateString()}
            </span>
          </button>

          {expanded === r.id && (
            <ReportDetail
              report={r}
              onStatusChange={handleStatusChange}
              onNotesUpdate={handleNotesUpdate}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ReportDetail({
  report,
  onStatusChange,
  onNotesUpdate,
}: {
  report: AdminBugReport;
  onStatusChange: (id: number, status: string) => void;
  onNotesUpdate: (id: number, notes: string) => void;
}) {
  const [notes, setNotes] = useState(report.admin_notes ?? "");

  return (
    <div className="px-3 pb-3 space-y-3 border-t border-zinc-700 pt-3">
      <div>
        <p className="text-xs text-zinc-500 mb-1">
          Reported by{" "}
          <span className="text-zinc-300 font-mono">{report.reported_by}</span>
          {" "}on{" "}
          {new Date(report.created_at).toLocaleString()}
        </p>
        <p className="text-sm text-zinc-200 whitespace-pre-wrap">
          {report.description}
        </p>
      </div>

      {/* System info */}
      {report.system_info && (
        <details className="text-xs">
          <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300">
            System Info
          </summary>
          <div className="mt-1 bg-zinc-900 rounded p-2 overflow-x-auto">
            <table className="text-zinc-400">
              <tbody>
                {Object.entries(report.system_info).map(([k, v]) => (
                  <tr key={k}>
                    <td className="pr-3 text-zinc-500 whitespace-nowrap align-top">
                      {k}
                    </td>
                    <td className="text-zinc-300">{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Status change */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">Status:</span>
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onStatusChange(report.id, s)}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              report.status === s
                ? STATUS_COLORS[s]
                : "text-zinc-500 hover:text-zinc-300 bg-zinc-800"
            }`}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Admin notes */}
      <div>
        <label className="text-xs text-zinc-500 block mb-1">Admin Notes</label>
        <div className="flex gap-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="flex-1 px-2 py-1.5 bg-zinc-900 border border-zinc-600 rounded text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 resize-none"
            placeholder="Internal notes..."
          />
          <button
            onClick={() => onNotesUpdate(report.id, notes)}
            className="px-3 self-end bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded py-1.5 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
