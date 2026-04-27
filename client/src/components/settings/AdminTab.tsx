import { useState, useEffect } from "react";
import { useAuthStore } from "../../stores/auth";
import { useExtensionStore } from "../../stores/extension";
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
  applyFederationChanges,
  getServiceNodeConfig,
  updateServiceNodeConfig,
  getAdminBans,
  adminUnbanUser,
  adminBanUser,
  adminListInvites,
  adminCreateInvite,
  adminRevokeInvite,
  adminGetExtensionCatalog,
  adminInstallExtension,
  adminUninstallExtension,
  type AdminStats,
  type AdminServer,
  type AdminUser,
  type AdminBugReport,
  type AdminBan,
  type AdminInvite,
  type ExtensionCatalogResponse,
  type FederationStatus,
  type ServiceNodeConfig,
  type ServiceNodeRole,
} from "../../api/concord";

type Section =
  | "overview"
  | "instance"
  | "invites"
  | "extensions"
  | "federation"
  | "service-node"
  | "servers"
  | "users"
  | "bans"
  | "reports";

export function AdminTab() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [section, setSection] = useState<Section>("overview");

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-on-surface">Admin Dashboard</h3>

      <div className="flex gap-1 border-b border-outline-variant/15 pb-2 flex-wrap">
        {(
          [
            "overview",
            "instance",
            "invites",
            "extensions",
            "federation",
            "service-node",
            "servers",
            "users",
            "bans",
            "reports",
          ] as Section[]
        ).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`px-3 py-1.5 text-sm rounded-t transition-colors ${
              section === s
                ? "bg-surface-container-highest text-on-surface"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {/* `service-node` prints as "Service Node" — every other
                label reuses the identity capitalisation pattern. */}
            {s === "service-node"
              ? "Service Node"
              : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {section === "overview" && <OverviewSection token={accessToken} />}
      {section === "instance" && <InstanceSection token={accessToken} />}
      {section === "invites" && <InvitesSection token={accessToken} />}
      {section === "extensions" && <ExtensionsSection token={accessToken} />}
      {section === "federation" && <FederationSection token={accessToken} />}
      {section === "service-node" && <ServiceNodeSection token={accessToken} />}
      {section === "servers" && <ServersSection token={accessToken} />}
      {section === "users" && <UsersSection token={accessToken} />}
      {section === "bans" && <BansSection token={accessToken} />}
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
  const [openRegistration, setOpenRegistration] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getInstanceInfo().then((info) => {
      setName(info.name);
      setRequireTOTP(info.require_totp);
      setOpenRegistration(info.open_registration);
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

  const handleToggleOpenRegistration = async () => {
    if (!token) return;
    try {
      const result = await updateInstanceSettings(
        { open_registration: !openRegistration },
        token,
      );
      setOpenRegistration(result.open_registration);
      addToast(
        result.open_registration
          ? "Open registration enabled — anyone can sign up"
          : "Open registration disabled — invite tokens required",
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

      <div className="border-t border-outline-variant/15 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm text-on-surface-variant block">Open Registration</label>
            <p className="text-xs text-on-surface-variant mt-0.5">
              When enabled, anyone who can reach this instance can sign up without an invite token.
              Off by default — leave disabled unless you explicitly want an open sign-up page.
            </p>
          </div>
          <button
            onClick={handleToggleOpenRegistration}
            className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
              openRegistration ? "bg-primary" : "bg-surface-container-highest"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                openRegistration ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invites — instance-admin view of account-creation tokens across all servers
// ---------------------------------------------------------------------------

function InvitesSection({ token }: { token: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [maxUses, setMaxUses] = useState(10);
  const [expiresInHours, setExpiresInHours] = useState(168);
  const [permanent, setPermanent] = useState(false);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    if (!token) return;
    try {
      const list = await adminListInvites(token);
      setInvites(list);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load invites", "error");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleCreate = async () => {
    if (!token) return;
    setCreating(true);
    try {
      // server_id is intentionally omitted — the backend falls back to
      // the instance's default lobby. This is the whole point of the
      // instance-admin invite flow: generate a token that lets someone
      // create an account without having to pick a server first.
      await adminCreateInvite(
        permanent
          ? { max_uses: maxUses, permanent: true }
          : { max_uses: maxUses, expires_in_hours: expiresInHours, permanent: false },
        token,
      );
      addToast("Invite created", "success");
      await refresh();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to create invite", "error");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: number) => {
    if (!token) return;
    try {
      await adminRevokeInvite(id, token);
      addToast("Invite revoked", "success");
      await refresh();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to revoke invite", "error");
    }
  };

  const copyToken = async (tok: string) => {
    try {
      await navigator.clipboard.writeText(tok);
      addToast("Invite token copied", "success");
    } catch {
      addToast("Couldn't copy to clipboard", "error");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-semibold text-on-surface mb-1">Create Invite</h4>
        <p className="text-xs text-on-surface-variant mb-3">
          Generates a token that lets a new user register an account on this instance and land in the default lobby.
          Revoke from the list below at any time.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
          <label className="text-xs text-on-surface-variant">
            Max uses
            <input
              type="number"
              min={1}
              max={10000}
              value={maxUses}
              onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
              className="block w-full mt-1 px-2 py-1.5 bg-surface-container border border-outline-variant rounded text-sm text-on-surface"
            />
          </label>
          <label className="text-xs text-on-surface-variant">
            Expires in (hours)
            <input
              type="number"
              min={1}
              max={87600}
              value={expiresInHours}
              onChange={(e) => setExpiresInHours(Math.max(1, Number(e.target.value) || 1))}
              disabled={permanent}
              className="block w-full mt-1 px-2 py-1.5 bg-surface-container border border-outline-variant rounded text-sm text-on-surface disabled:opacity-40"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-on-surface-variant select-none pb-1">
            <input
              type="checkbox"
              checked={permanent}
              onChange={(e) => setPermanent(e.target.checked)}
            />
            Permanent (never expires)
          </label>
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="mt-3 px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
        >
          {creating ? "Creating…" : "Create Invite"}
        </button>
      </div>

      <div className="border-t border-outline-variant/15 pt-4">
        <h4 className="text-sm font-semibold text-on-surface mb-2">Active Invites</h4>
        {invites === null ? (
          <p className="text-sm text-on-surface-variant">Loading…</p>
        ) : invites.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No invites on this instance yet.</p>
        ) : (
          <ul className="space-y-2">
            {invites.map((inv) => (
              <li
                key={inv.id}
                className="bg-surface-container rounded-lg p-3 border border-outline-variant/15 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-xs font-mono text-on-surface bg-surface-container-highest px-1.5 py-0.5 rounded truncate">
                      {inv.token}
                    </code>
                    {!inv.is_valid && (
                      <span className="text-[10px] uppercase tracking-wider text-error">expired / used up</span>
                    )}
                    {inv.permanent && (
                      <span className="text-[10px] uppercase tracking-wider text-on-surface-variant">permanent</span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-variant mt-1">
                    {inv.server_name ?? inv.server_id} · {inv.use_count}/{inv.max_uses} used
                    {inv.expires_at && !inv.permanent
                      ? ` · expires ${new Date(inv.expires_at).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <button
                  onClick={() => void copyToken(inv.token)}
                  className="px-2 py-1 text-xs rounded bg-surface-container-high hover:bg-surface-container-highest text-on-surface transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={() => void handleRevoke(inv.id)}
                  className="px-2 py-1 text-xs rounded bg-error/20 hover:bg-error/30 text-error transition-colors"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extensions — install/uninstall from the remote concord-extensions catalog
// ---------------------------------------------------------------------------

function ExtensionsSection({ token }: { token: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [catalog, setCatalog] = useState<ExtensionCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetExtensionCatalog(token);
      setCatalog(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleInstall = async (id: string) => {
    if (!token) return;
    setBusyId(id);
    try {
      await adminInstallExtension(id, token);
      addToast(`Installed ${id}`, "success");
      // Refresh THIS panel + the global extension store so the
      // Applications sidebar surfaces the new extension without a
      // page reload. The store has a `catalogLoaded` short-circuit on
      // its lazy loader, so we have to call the explicit reload here.
      await Promise.all([
        refresh(),
        useExtensionStore.getState().reloadCatalog(token),
      ]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Install failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  // Update path: install endpoint already wipes + re-extracts the
  // bundle directory on every call (admin_extensions.py overwrites
  // dest), so a "Update" button just hits the same install endpoint
  // — no separate API needed. We keep a distinct toast message and
  // busyId animation so the user knows their click did something
  // meaningfully different from a no-op.
  const handleUpdate = async (id: string, fromVersion: string, toVersion: string) => {
    if (!token) return;
    setBusyId(id);
    try {
      await adminInstallExtension(id, token);
      addToast(
        fromVersion
          ? `Updated ${id} ${fromVersion} → ${toVersion}`
          : `Updated ${id} to v${toVersion}`,
        "success",
      );
      await Promise.all([
        refresh(),
        useExtensionStore.getState().reloadCatalog(token),
      ]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstall = async (id: string) => {
    if (!token) return;
    setBusyId(id);
    try {
      await adminUninstallExtension(id, token);
      addToast(`Uninstalled ${id}`, "success");
      await Promise.all([
        refresh(),
        useExtensionStore.getState().reloadCatalog(token),
      ]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Uninstall failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-on-surface mb-1">Extension Catalog</h4>
        <p className="text-xs text-on-surface-variant">
          Extensions published in the concord-extensions library. Installing extracts the
          bundle into this instance's data volume and makes it available to every user via the
          Extensions menu.
        </p>
        {catalog && (
          <p className="text-[11px] text-on-surface-variant/60 mt-1 font-mono break-all">
            source: {catalog.catalog_url}
          </p>
        )}
      </div>

      {loading && <p className="text-sm text-on-surface-variant">Loading catalog…</p>}
      {error && (
        <div className="p-3 rounded border border-error/40 bg-error/10 text-sm text-error">
          {error}
          <button
            onClick={() => void refresh()}
            className="ml-3 underline"
          >
            Retry
          </button>
        </div>
      )}

      {catalog && catalog.catalog.extensions.length === 0 && (
        <p className="text-sm text-on-surface-variant">Catalog is empty.</p>
      )}

      {catalog && catalog.catalog.extensions.length > 0 && (
        <ul className="space-y-2">
          {catalog.catalog.extensions.map((ext) => {
            const isInstalled = catalog.installed_ids.includes(ext.id);
            // Installed version comparison. `installed_versions` is
            // optional for back-compat — if the server didn't ship the
            // field, we fall back to "no update UI". An empty string
            // means a legacy install predating the version field — we
            // treat that as "unknown, offer update" so the user has a
            // path forward without uninstall/reinstall.
            const installedVersion = catalog.installed_versions?.[ext.id];
            const updateAvailable =
              isInstalled &&
              installedVersion !== undefined &&
              installedVersion !== ext.version;
            const isBusy = busyId === ext.id;
            return (
              <li
                key={ext.id}
                className="bg-surface-container rounded-lg p-3 border border-outline-variant/15"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-on-surface-variant">extension</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-on-surface">{ext.name}</p>
                      <span className="text-[10px] uppercase tracking-wider text-on-surface-variant font-label">
                        v{ext.version}
                      </span>
                      {isInstalled && !updateAvailable && (
                        <span className="text-[10px] uppercase tracking-wider text-primary font-label">
                          installed
                        </span>
                      )}
                      {updateAvailable && (
                        <span className="text-[10px] uppercase tracking-wider text-tertiary font-label">
                          {installedVersion
                            ? `update: v${installedVersion} → v${ext.version}`
                            : `update available`}
                        </span>
                      )}
                      {ext.pricing && ext.pricing !== "free" && (
                        <span className="text-[10px] uppercase tracking-wider text-on-surface-variant/80 font-label">
                          {ext.pricing.replace("_", " ")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-on-surface-variant mt-1 break-words">
                      {ext.description}
                    </p>
                    <p className="text-[11px] text-on-surface-variant/60 mt-1 font-mono">{ext.id}</p>
                  </div>
                  <div className="flex-shrink-0 flex flex-col gap-1.5 items-end">
                    {!isInstalled && (
                      <button
                        onClick={() => void handleInstall(ext.id)}
                        disabled={isBusy}
                        className="px-3 py-1.5 text-xs rounded primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface transition-colors"
                      >
                        {isBusy ? "…" : "Install"}
                      </button>
                    )}
                    {updateAvailable && (
                      <button
                        onClick={() =>
                          void handleUpdate(ext.id, installedVersion ?? "", ext.version)
                        }
                        disabled={isBusy}
                        className="px-3 py-1.5 text-xs rounded bg-tertiary/25 hover:bg-tertiary/35 disabled:opacity-40 text-tertiary transition-colors"
                      >
                        {isBusy ? "…" : "Update"}
                      </button>
                    )}
                    {isInstalled && (
                      <button
                        onClick={() => void handleUninstall(ext.id)}
                        disabled={isBusy}
                        className="px-2.5 py-1 text-[11px] rounded bg-error/15 hover:bg-error/25 disabled:opacity-40 text-error transition-colors"
                      >
                        {isBusy ? "…" : "Uninstall"}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
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
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refreshStatus = async () => {
    if (!token) return;
    try {
      const s = await getFederationStatus(token);
      setStatus(s);
    } catch {
      /* ignore transient errors during restart polling */
    }
  };

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setStatus((s) =>
        s
          ? {
              ...s,
              allowed_servers: result.allowed_servers,
              raw_allowed_patterns: result.raw_allowed_patterns,
              pending_apply: true,
            }
          : s,
      );
      setNewServer("");
      addToast(`Added ${name} — click Apply to activate`, "success");
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
      setStatus((s) =>
        s
          ? {
              ...s,
              allowed_servers: result.allowed_servers,
              raw_allowed_patterns: result.raw_allowed_patterns,
              pending_apply: true,
            }
          : s,
      );
      addToast(`Removed ${name} — click Apply to activate`, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async () => {
    if (!token) return;
    setConfirmOpen(false);
    setApplying(true);
    try {
      const result = await applyFederationChanges(token);
      addToast(
        `Federation active — restart took ${result.elapsed_seconds.toFixed(1)}s`,
        "success",
      );
      await refreshStatus();
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Apply failed — check server logs",
      );
    } finally {
      setApplying(false);
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
            Federation is disabled. Set <code className="text-on-surface bg-surface-container-highest px-1 rounded text-xs">allow_federation = true</code> in <code className="text-on-surface bg-surface-container-highest px-1 rounded text-xs">config/tuwunel.toml</code> and apply changes to enable.
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
                disabled={saving || applying}
                className="flex-1 px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono disabled:opacity-40"
              />
              <button
                onClick={handleAdd}
                disabled={saving || applying || !newServer.trim()}
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
                      disabled={saving || applying}
                      className="text-on-surface-variant hover:text-primary text-xs transition-colors disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Apply-changes card: replaces the old "restart required" notice.
              Appears dimmed when no changes are pending, glows when they are,
              and shows a spinner while a restart is in progress. */}
          <div
            className={`rounded-lg p-3 border transition-colors ${
              status.pending_apply
                ? "bg-tertiary/10 border-tertiary/40"
                : "bg-surface-container border-outline-variant/15"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                className={`material-symbols-outlined text-base mt-0.5 ${
                  status.pending_apply ? "text-tertiary" : "text-on-surface-variant"
                }`}
              >
                {status.pending_apply ? "sync_problem" : "check_circle"}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-on-surface font-medium">
                  {applying
                    ? "Restarting Matrix server..."
                    : status.pending_apply
                      ? "Unapplied changes"
                      : "All changes applied"}
                </p>
                <p className="text-xs text-on-surface-variant leading-relaxed mt-0.5">
                  {applying
                    ? "Please wait — the Matrix server is restarting. Users may see a brief disconnect."
                    : status.pending_apply
                      ? "Your allowlist edits are saved but not yet active. Clicking Apply will briefly restart the Matrix server (~10–15s)."
                      : "The running server matches your saved allowlist."}
                </p>
              </div>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={applying || !status.pending_apply}
                className="shrink-0 px-4 py-1.5 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
              >
                {applying ? "Applying..." : "Apply Changes"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Confirmation modal — enforces the "admin confirms before downtime"
          rule. Matches the bg-black/60 + bg-surface-container pattern used
          by NewServerModal and BugReportModal for consistency. */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="bg-surface-container rounded-lg p-6 max-w-md w-full space-y-4 border border-outline-variant/15 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-tertiary text-2xl mt-0.5">
                warning
              </span>
              <div className="flex-1">
                <h4 className="text-base font-semibold text-on-surface">
                  Restart the Matrix server?
                </h4>
                <p className="text-sm text-on-surface-variant mt-2 leading-relaxed">
                  Applying federation changes requires restarting the Tuwunel homeserver container.
                  All connected users will see a brief disconnect — typically 10–15 seconds.
                  Clients will auto-reconnect.
                </p>
                <p className="text-xs text-on-surface-variant mt-2">
                  Consider applying during a quiet period.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                className="px-4 py-2 primary-glow hover:brightness-110 text-on-surface text-sm rounded transition-colors"
              >
                Restart Now
              </button>
            </div>
          </div>
        </div>
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
        {/* INS-028: GitHub issue mirror status. When the server-side
            submit_bug_report handler successfully called the GitHub
            API, `github_issue_number` is populated and we render a
            deep-link; otherwise we show a muted indicator so admins
            know the mirror didn't run (either because the token is
            unset or because the API call failed — the DB row always
            exists regardless). */}
        <div className="mt-2 text-xs">
          {report.github_issue_number !== null ? (
            <a
              href={`https://github.com/TruStoryHnsl/concord/issues/${report.github_issue_number}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              data-testid={`github-link-${report.id}`}
            >
              <span className="material-symbols-outlined text-sm">open_in_new</span>
              View on GitHub (issue #{report.github_issue_number})
            </a>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-on-surface-variant italic"
              data-testid={`github-unavailable-${report.id}`}
            >
              GitHub mirror unavailable
            </span>
          )}
        </div>
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

// ---------------------------------------------------------------------------
// Service Node (INS-023)
// ---------------------------------------------------------------------------
//
// Admin surface for the resource + role contribution knobs that live
// in `server/services/service_node_config.py`. Operators use this
// screen to tell the embedded servitude how much of the box it is
// allowed to spend on peer traffic, and whether the node advertises
// itself as a persistent tunnel anchor.
//
// Only admins see this tab — the route is gated server-side via
// `require_admin`, and the UI is rendered under the existing
// `isAdmin` check in SettingsModal's tab bar.
//
// The `limits` block comes from the server response so a future
// maxima bump doesn't require a coordinated client release.

export function ServiceNodeSection({ token }: { token: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [cfg, setCfg] = useState<ServiceNodeConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Local draft state — we don't write back to `cfg` until a
  // successful save, so the Reset button can restore the last
  // persisted values without a round-trip.
  const [cpu, setCpu] = useState(80);
  const [bandwidth, setBandwidth] = useState(0);
  const [storage, setStorage] = useState(0);
  const [anchor, setAnchor] = useState(false);
  const [role, setRole] = useState<ServiceNodeRole>("hybrid");
  // INS-049: domain + transport state
  const [customDomain, setCustomDomain] = useState("");
  const [transports, setTransports] = useState({ federation: true, wireguard: false, turn: false });

  useEffect(() => {
    if (!token) return;
    getServiceNodeConfig(token)
      .then((data) => {
        setCfg(data);
        setCpu(data.max_cpu_percent);
        setBandwidth(data.max_bandwidth_mbps);
        setStorage(data.max_storage_gb);
        setAnchor(data.tunnel_anchor_enabled);
        setRole(data.node_role);
        setCustomDomain(data.custom_domain ?? "");
        setTransports(data.transports ?? { federation: true, wireguard: false, turn: false });
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e));
      });
  }, [token]);

  const handleSave = async () => {
    if (!token || !cfg) return;
    setSaving(true);
    try {
      const result = await updateServiceNodeConfig(
        {
          max_cpu_percent: cpu,
          max_bandwidth_mbps: bandwidth,
          max_storage_gb: storage,
          tunnel_anchor_enabled: anchor,
          node_role: role,
          custom_domain: customDomain || null,
          transports,
        },
        token,
      );
      setCfg(result);
      addToast("Service node config saved", "success");
    } catch (e) {
      addToast(
        e instanceof Error ? e.message : "Failed to save service node config",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!cfg) return;
    setCpu(cfg.max_cpu_percent);
    setBandwidth(cfg.max_bandwidth_mbps);
    setStorage(cfg.max_storage_gb);
    setAnchor(cfg.tunnel_anchor_enabled);
    setRole(cfg.node_role);
    setCustomDomain(cfg.custom_domain ?? "");
    setTransports(cfg.transports ?? { federation: true, wireguard: false, turn: false });
  };

  if (err) {
    return (
      <div className="rounded border border-error/30 bg-error/10 px-4 py-3 space-y-1">
        <p className="text-sm text-error font-medium">Failed to load service node config</p>
        <p className="text-xs text-on-surface-variant break-all">{err}</p>
      </div>
    );
  }

  if (!cfg) {
    return (
      <p className="text-on-surface-variant text-sm" data-testid="service-node-loading">
        Loading service node config…
      </p>
    );
  }

  const cfgTransports = cfg.transports ?? { federation: true, wireguard: false, turn: false };
  const hasChanges =
    cpu !== cfg.max_cpu_percent ||
    bandwidth !== cfg.max_bandwidth_mbps ||
    storage !== cfg.max_storage_gb ||
    anchor !== cfg.tunnel_anchor_enabled ||
    role !== cfg.node_role ||
    customDomain !== (cfg.custom_domain ?? "") ||
    transports.federation !== cfgTransports.federation ||
    transports.wireguard !== cfgTransports.wireguard ||
    transports.turn !== cfgTransports.turn;

  return (
    <div className="space-y-6" data-testid="service-node-section">
      <div>
        <h4 className="text-sm font-medium text-on-surface mb-1">Service node contribution</h4>
        <p className="text-xs text-on-surface-variant">
          Tell the embedded servitude how much of this box it is allowed to
          spend on Concord peer traffic, and pick the structural role this
          instance advertises to the mesh. Raw caps are never shared publicly
          — only the role flag and tunnel-anchor toggle reach the well-known
          document.
        </p>
      </div>

      {/* CPU ceiling */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <label className="text-sm text-on-surface">CPU ceiling</label>
          <span className="text-xs text-on-surface-variant font-mono">{cpu}%</span>
        </div>
        <input
          type="range"
          min={1}
          max={cfg.limits.max_cpu_percent}
          step={1}
          value={cpu}
          onChange={(e) => setCpu(Number(e.target.value))}
          className="w-full"
          data-testid="service-node-cpu-input"
        />
        <p className="text-xs text-on-surface-variant">
          Max CPU the servitude runtime will consume once the scheduler lands.
          Leave some headroom for the OS and admin tasks.
        </p>
      </div>

      {/* Bandwidth cap */}
      <div className="space-y-1">
        <label className="text-sm text-on-surface block">Bandwidth cap (Mbps)</label>
        <input
          type="number"
          min={0}
          max={cfg.limits.max_bandwidth_mbps}
          step={1}
          value={bandwidth}
          onChange={(e) => setBandwidth(Number(e.target.value))}
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
          data-testid="service-node-bandwidth-input"
        />
        <p className="text-xs text-on-surface-variant">
          Outbound bandwidth ceiling in megabits per second. <code>0</code>{" "}
          means unlimited. Max {cfg.limits.max_bandwidth_mbps}.
        </p>
      </div>

      {/* Storage cap */}
      <div className="space-y-1">
        <label className="text-sm text-on-surface block">Storage cap (GB)</label>
        <input
          type="number"
          min={0}
          max={cfg.limits.max_storage_gb}
          step={1}
          value={storage}
          onChange={(e) => setStorage(Number(e.target.value))}
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
          data-testid="service-node-storage-input"
        />
        <p className="text-xs text-on-surface-variant">
          On-disk cache ceiling in gigabytes. <code>0</code> means unlimited.
          Max {cfg.limits.max_storage_gb}.
        </p>
      </div>

      {/* Node role */}
      <div className="space-y-1">
        <label className="text-sm text-on-surface block">Node role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as ServiceNodeRole)}
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
          data-testid="service-node-role-select"
        >
          {cfg.limits.allowed_roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <p className="text-xs text-on-surface-variant">
          <code>frontend-only</code> — UI only, no hosting. <code>hybrid</code>{" "}
          — UI plus opportunistic hosting (default). <code>anchor</code> —
          always-on infrastructure node; pair with the Tunnel anchor toggle
          when you commit to uptime.
        </p>
      </div>

      {/* Tunnel anchor toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm text-on-surface block">Tunnel anchor</label>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Advertise this node as a persistent mesh tunnel anchor other
            peers can dial into.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAnchor((v) => !v)}
          data-testid="service-node-anchor-toggle"
          className={`relative w-11 h-6 rounded-full transition-colors ${
            anchor ? "bg-primary" : "bg-surface-container-highest"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
              anchor ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      {/* INS-049: Domain config */}
      <div className="space-y-1 border-t border-outline-variant/15 pt-4">
        <h4 className="text-sm font-medium text-on-surface mb-1">Domain</h4>
        <label className="text-sm text-on-surface block">Custom domain</label>
        <input
          type="text"
          value={customDomain}
          onChange={(e) => setCustomDomain(e.target.value)}
          placeholder="e.g. concord.example.com"
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
          data-testid="service-node-domain-input"
        />
        <p className="text-xs text-on-surface-variant">
          Effective domain:{" "}
          <code className="font-mono">{customDomain || "<slug>.concordchat.net"}</code>
        </p>
      </div>

      {/* INS-049: Transport toggles */}
      <div className="space-y-2 border-t border-outline-variant/15 pt-4">
        <h4 className="text-sm font-medium text-on-surface">Transports</h4>
        {(["federation", "wireguard", "turn"] as const).map((t) => (
          <div key={t} className="flex items-center justify-between">
            <label className="text-sm text-on-surface">
              {t === "turn" ? "TURN relay" : t === "wireguard" ? "WireGuard" : "Matrix federation"}
            </label>
            <button
              type="button"
              onClick={() => setTransports((prev) => ({ ...prev, [t]: !prev[t] }))}
              data-testid={`service-node-transport-${t}`}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                transports[t] ? "bg-primary" : "bg-surface-container-highest"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  transports[t] ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
        ))}
      </div>

      {/* INS-049: Status dashboard */}
      <div className="space-y-2 border-t border-outline-variant/15 pt-4">
        <h4 className="text-sm font-medium text-on-surface">Status</h4>
        <div className="rounded-lg bg-surface-container px-4 py-3 space-y-1 text-xs font-mono text-on-surface-variant">
          <div>role: <span className="text-on-surface">{cfg.node_role}</span></div>
          <div>
            tunnel_anchor:{" "}
            <span className="text-on-surface">
              {cfg.tunnel_anchor_enabled ? "enabled" : "disabled"}
            </span>
          </div>
          <div>cpu_ceil: <span className="text-on-surface">{cfg.max_cpu_percent}%</span></div>
          <div>
            bandwidth_cap:{" "}
            <span className="text-on-surface">
              {cfg.max_bandwidth_mbps === 0 ? "unlimited" : `${cfg.max_bandwidth_mbps} Mbps`}
            </span>
          </div>
          <div>
            domain:{" "}
            <span className="text-on-surface">
              {customDomain || "<slug>.concordchat.net"}
            </span>
          </div>
        </div>
      </div>

      {/* Action row */}
      <div className="flex items-center justify-end gap-2 border-t border-outline-variant/15 pt-4">
        <button
          type="button"
          onClick={handleReset}
          disabled={!hasChanges || saving}
          className="px-3 py-2 bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges || saving}
          data-testid="service-node-save-button"
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bans — instance-wide ban list with unban + manual ban controls
// ---------------------------------------------------------------------------

function BansSection({ token }: { token: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [bans, setBans] = useState<AdminBan[]>([]);
  const [loading, setLoading] = useState(false);
  const [banUserId, setBanUserId] = useState("");
  const [banning, setBanning] = useState(false);
  const [unbanning, setUnbanning] = useState<string | null>(null);

  const refresh = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await getAdminBans(token);
      setBans(result);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load bans", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleUnban = async (userId: string) => {
    if (!token) return;
    setUnbanning(userId);
    try {
      await adminUnbanUser(userId, token);
      setBans((prev) => prev.filter((b) => b.user_id !== userId));
      addToast(`Unbanned ${userId}`, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to unban", "error");
    } finally {
      setUnbanning(null);
    }
  };

  const handleBan = async () => {
    if (!token || !banUserId.trim()) return;
    setBanning(true);
    try {
      await adminBanUser(banUserId.trim(), token);
      addToast(`Banned ${banUserId.trim()}`, "success");
      setBanUserId("");
      await refresh();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to ban user", "error");
    } finally {
      setBanning(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="bans-section">
      {/* Manual ban */}
      <div>
        <h4 className="text-sm font-medium text-on-surface mb-2">Ban a user</h4>
        <p className="text-xs text-on-surface-variant mb-3">
          Enter a Matrix user ID (e.g. <code>@user:example.com</code>) to add an
          instance-wide ban. The user will be blocked from all servers on this instance.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={banUserId}
            onChange={(e) => setBanUserId(e.target.value)}
            placeholder="@user:example.com"
            className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            data-testid="ban-user-input"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleBan();
            }}
          />
          <button
            type="button"
            onClick={handleBan}
            disabled={banning || !banUserId.trim()}
            className="px-4 py-2 bg-error/10 hover:bg-error/15 text-error text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="ban-user-button"
          >
            {banning ? "Banning…" : "Ban"}
          </button>
        </div>
      </div>

      {/* Ban list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-on-surface">
            Banned users ({bans.length})
          </h4>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="text-xs text-primary hover:underline disabled:opacity-40"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {bans.length === 0 && !loading && (
          <p className="text-sm text-on-surface-variant">No bans on record.</p>
        )}

        {bans.length > 0 && (
          <div className="space-y-2">
            {bans.map((ban) => (
              <div
                key={ban.user_id}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/15"
                data-testid={`ban-row-${ban.user_id}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-on-surface font-medium truncate">
                    {ban.user_id}
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Banned by {ban.banned_by} ·{" "}
                    {new Date(ban.created_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleUnban(ban.user_id)}
                  disabled={unbanning === ban.user_id}
                  className="shrink-0 px-3 py-1.5 text-xs bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40 rounded transition-colors"
                  data-testid={`unban-button-${ban.user_id}`}
                >
                  {unbanning === ban.user_id ? "…" : "Unban"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
