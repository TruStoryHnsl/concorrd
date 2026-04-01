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
  updateInstanceSettings,
  getFederationStatus,
  updateFederationAllowlist,
  type AdminStats,
  type AdminServer,
  type AdminUser,
  type AdminBugReport,
  type FederationStatus,
} from "../../api/concord";

type Section = "overview" | "instance" | "federation" | "servers" | "users" | "reports";

export function AdminTab() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [section, setSection] = useState<Section>("overview");

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-on-surface">Admin Dashboard</h3>

      <div className="flex gap-1 border-b border-outline-variant/15 pb-2 flex-wrap">
        {(["overview", "instance", "federation", "servers", "users", "reports"] as Section[]).map(
          (s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-3 py-1.5 text-sm rounded-t transition-colors ${
                section === s
                  ? "bg-surface-container-highest text-on-surface"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ),
        )}
      </div>

      {section === "overview" && <OverviewSection token={accessToken} />}
      {section === "instance" && <InstanceSection token={accessToken} />}
      {section === "federation" && <FederationSection token={accessToken} />}
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
    return <p className="text-on-surface-variant text-sm">Loading stats...</p>;

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
      accent: stats.open_reports > 0 ? "text-primary" : undefined,
    },
    { label: "Total Reports", value: stats.total_reports },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-surface-container rounded-lg p-3 border border-outline-variant/15"
        >
          <p className="text-xs text-on-surface-variant">{c.label}</p>
          <p className={`text-2xl font-bold ${c.accent ?? "text-on-surface"}`}>
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
  const [requireTOTP, setRequireTOTP] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getInstanceInfo().then((info) => {
      setName(info.name);
      setRequireTOTP(info.require_totp);
    }).catch(() => {});
  }, []);

  const handleSaveName = async () => {
    if (!token || !name.trim()) return;
    setSaving(true);
    try {
      const result = await updateInstanceSettings({ name: name.trim() }, token);
      setName(result.name);
      document.title = result.name;
      addToast("Instance name updated", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleTOTP = async () => {
    if (!token) return;
    try {
      const result = await updateInstanceSettings({ require_totp: !requireTOTP }, token);
      setRequireTOTP(result.require_totp);
      addToast(
        result.require_totp
          ? "Two-factor authentication is now required"
          : "Two-factor authentication requirement removed",
        "success",
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update", "error");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="text-sm text-on-surface-variant block mb-1">Instance Name</label>
        <p className="text-xs text-on-surface-variant mb-2">
          Displayed on the login page, browser tab, and emails. This is your instance's brand name.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            placeholder="Concord"
          />
          <button
            onClick={handleSaveName}
            disabled={saving || !name.trim()}
            className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
          >
            {saving ? "..." : "Save"}
          </button>
        </div>
      </div>

      <div className="border-t border-outline-variant/15 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm text-on-surface-variant block">Require Two-Factor Authentication</label>
            <p className="text-xs text-on-surface-variant mt-0.5">
              When enabled, all users must set up an authenticator app to log in.
            </p>
          </div>
          <button
            onClick={handleToggleTOTP}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              requireTOTP ? "bg-primary" : "bg-surface-container-highest"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                requireTOTP ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

function FederationSection({ token }: { token: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [status, setStatus] = useState<FederationStatus | null>(null);
  const [newServer, setNewServer] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;
    getFederationStatus(token).then(setStatus).catch(() => {});
  }, [token]);

  const handleAdd = async () => {
    if (!token || !newServer.trim() || !status) return;
    const name = newServer.trim().toLowerCase();
    if (status.allowed_servers.includes(name)) {
      addToast("Server already in allowlist", "info");
      return;
    }
    setSaving(true);
    try {
      const result = await updateFederationAllowlist(
        [...status.allowed_servers, name],
        token,
      );
      setStatus((s) => s ? { ...s, allowed_servers: result.allowed_servers } : s);
      setNewServer("");
      addToast(`Added ${name} — restart Conduwuit to apply`, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (name: string) => {
    if (!token || !status) return;
    setSaving(true);
    try {
      const result = await updateFederationAllowlist(
        status.allowed_servers.filter((s) => s !== name),
        token,
      );
      setStatus((s) => s ? { ...s, allowed_servers: result.allowed_servers } : s);
      addToast(`Removed ${name} — restart Conduwuit to apply`, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  if (!status)
    return <p className="text-on-surface-variant text-sm">Loading federation status...</p>;

  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="flex items-center gap-3">
        <div className={`w-3 h-3 rounded-full ${status.enabled ? "bg-secondary" : "bg-on-surface-variant/50"}`} />
        <div>
          <p className="text-sm text-on-surface font-medium">
            Federation {status.enabled ? "Enabled" : "Disabled"}
          </p>
          <p className="text-xs text-on-surface-variant">
            This instance: <span className="font-mono text-on-surface">{status.server_name}</span>
          </p>
        </div>
      </div>

      {!status.enabled && (
        <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
          <p className="text-sm text-on-surface-variant">
            Federation is disabled. Set <code className="text-on-surface bg-surface-container-highest px-1 rounded text-xs">CONDUWUIT_ALLOW_FEDERATION=true</code> in your <code className="text-on-surface bg-surface-container-highest px-1 rounded text-xs">.env</code> and restart to enable.
          </p>
        </div>
      )}

      {status.enabled && (
        <>
          {/* Allowlist explanation */}
          <div className="bg-surface-container rounded-lg p-3 border border-outline-variant/15">
            <p className="text-xs text-on-surface-variant leading-relaxed">
              <strong className="text-on-surface">Allowlist-only mode:</strong> All remote servers are blocked by default.
              Only instances listed below can exchange messages with this server.
              Both instances must add each other to federate.
            </p>
          </div>

          {/* Add server */}
          <div>
            <label className="text-sm text-on-surface-variant block mb-1">
              Add Concord Instance
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newServer}
                onChange={(e) => setNewServer(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
                placeholder="friend.example.com"
                className="flex-1 px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono"
              />
              <button
                onClick={handleAdd}
                disabled={saving || !newServer.trim()}
                className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
              >
                {saving ? "..." : "Add"}
              </button>
            </div>
          </div>

          {/* Current allowlist */}
          <div>
            <label className="text-sm text-on-surface-variant block mb-2">
              Allowed Instances ({status.allowed_servers.length})
            </label>
            {status.allowed_servers.length === 0 ? (
              <p className="text-on-surface-variant/50 text-sm">
                No instances allowed yet. Add one above to start federating.
              </p>
            ) : (
              <div className="space-y-1">
                {status.allowed_servers.map((server) => (
                  <div
                    key={server}
                    className="flex items-center justify-between px-3 py-2 rounded bg-surface-container"
                  >
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-secondary text-base">dns</span>
                      <span className="text-sm text-on-surface font-mono">{server}</span>
                    </div>
                    <button
                      onClick={() => handleRemove(server)}
                      disabled={saving}
                      className="text-on-surface-variant hover:text-primary text-xs transition-colors disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Restart notice */}
          <div className="bg-primary/5 rounded-lg p-3 border border-primary/20">
            <p className="text-xs text-on-surface-variant">
              <span className="material-symbols-outlined text-primary text-sm align-middle mr-1">info</span>
              Changes to the allowlist require a Conduwuit restart to take effect.
              Run <code className="text-on-surface bg-surface-container-highest px-1 rounded">docker compose restart conduwuit</code> after making changes.
            </p>
          </div>
        </>
      )}
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
    return <p className="text-on-surface-variant text-sm">Loading servers...</p>;

  if (servers.length === 0)
    return <p className="text-on-surface-variant text-sm">No servers.</p>;

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-1 text-xs text-on-surface-variant font-medium">
        <span>Name</span>
        <span>Visibility</span>
        <span>Members</span>
        <span>Created</span>
      </div>
      {servers.map((s) => (
        <div
          key={s.id}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-2 rounded bg-surface-container text-sm items-center"
        >
          <div>
            <span className="text-on-surface">{s.name}</span>
            <span className="text-on-surface-variant/50 text-xs ml-2">{s.id}</span>
          </div>
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              s.visibility === "public"
                ? "bg-secondary/10 text-secondary"
                : "bg-surface-container-highest text-on-surface-variant"
            }`}
          >
            {s.visibility}
          </span>
          <span className="text-on-surface text-center">{s.member_count}</span>
          <span className="text-on-surface-variant text-xs">
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
    return <p className="text-on-surface-variant text-sm">Loading users...</p>;

  if (users.length === 0)
    return <p className="text-on-surface-variant text-sm">No users.</p>;

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-1 text-xs text-on-surface-variant font-medium">
        <span>User</span>
        <span>Servers</span>
        <span>Role</span>
        <span>First Seen</span>
      </div>
      {users.map((u) => (
        <div
          key={u.user_id}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-2 rounded bg-surface-container text-sm items-center"
        >
          <span className="text-on-surface font-mono text-xs truncate">
            {u.user_id}
          </span>
          <span className="text-on-surface text-center">{u.server_count}</span>
          <div className="flex gap-1">
            {u.is_admin && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                admin
              </span>
            )}
            {u.has_owner_role && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                owner
              </span>
            )}
            {!u.is_admin && !u.has_owner_role && (
              <span className="text-xs text-on-surface-variant">member</span>
            )}
          </div>
          <span className="text-on-surface-variant text-xs">
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
  open: "bg-primary/10 text-primary",
  in_progress: "bg-blue-900/40 text-blue-400",
  resolved: "bg-secondary/10 text-secondary",
  closed: "bg-surface-container-highest text-on-surface-variant",
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
    return <p className="text-on-surface-variant text-sm">Loading reports...</p>;

  if (reports.length === 0)
    return <p className="text-on-surface-variant text-sm">No bug reports yet.</p>;

  return (
    <div className="space-y-2">
      {reports.map((r) => (
        <div
          key={r.id}
          className="bg-surface-container rounded border border-outline-variant/15"
        >
          <button
            onClick={() => setExpanded(expanded === r.id ? null : r.id)}
            className="w-full text-left px-3 py-2 flex items-center gap-3"
          >
            <span className="text-on-surface text-sm flex-1 truncate">
              #{r.id} — {r.title}
            </span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[r.status] ?? STATUS_COLORS.open}`}
            >
              {r.status.replace("_", " ")}
            </span>
            <span className="text-on-surface-variant text-xs">
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
    <div className="px-3 pb-3 space-y-3 border-t border-outline-variant/15 pt-3">
      <div>
        <p className="text-xs text-on-surface-variant mb-1">
          Reported by{" "}
          <span className="text-on-surface font-mono">{report.reported_by}</span>
          {" "}on{" "}
          {new Date(report.created_at).toLocaleString()}
        </p>
        <p className="text-sm text-on-surface whitespace-pre-wrap">
          {report.description}
        </p>
      </div>

      {/* System info */}
      {report.system_info && (
        <details className="text-xs">
          <summary className="text-on-surface-variant cursor-pointer hover:text-on-surface">
            System Info
          </summary>
          <div className="mt-1 bg-surface rounded p-2 overflow-x-auto">
            <table className="text-on-surface-variant">
              <tbody>
                {Object.entries(report.system_info).map(([k, v]) => (
                  <tr key={k}>
                    <td className="pr-3 text-on-surface-variant whitespace-nowrap align-top">
                      {k}
                    </td>
                    <td className="text-on-surface">{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Status change */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-on-surface-variant">Status:</span>
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onStatusChange(report.id, s)}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              report.status === s
                ? STATUS_COLORS[s]
                : "text-on-surface-variant hover:text-on-surface bg-surface-container"
            }`}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Admin notes */}
      <div>
        <label className="text-xs text-on-surface-variant block mb-1">Admin Notes</label>
        <div className="flex gap-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="flex-1 px-2 py-1.5 bg-surface border border-outline-variant rounded text-xs text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
            placeholder="Internal notes..."
          />
          <button
            onClick={() => onNotesUpdate(report.id, notes)}
            className="px-3 self-end bg-surface-container-highest hover:bg-surface-bright text-on-surface text-xs rounded py-1.5 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
