import { useState, useEffect, useCallback } from "react";
import { useServerStore } from "../../stores/server";
import { useAuthStore } from "../../stores/auth";
import { useSettingsStore } from "../../stores/settings";
import { useToastStore } from "../../stores/toast";
import { FederationBadge } from "../ui/FederationBadge";
import { useLocalServerName } from "../../hooks/useFederation";
import {
  updateServerSettings,
  listMembers,
  updateMemberRole,
  kickMember,
  listBans,
  banUser,
  unbanUser,
  listWhitelist,
  addToWhitelist,
  removeFromWhitelist,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  toggleWebhook,
  searchUsers,
  sendDirectInvite,
  createInvite,
  listInvites,
  revokeInvite,
  getAuthCode,
  getBanSettings,
  updateBanSettings,
  updateMemberPermissions,
  updateInvite,
  updateChannelCreationSetting,
  type BanSettings,
  type Invite,
} from "../../api/concord";
import type { ServerMember, ServerBan, ServerWhitelistEntry, Webhook, UserSearchResult } from "../../api/concord";

type Tab = "general" | "members" | "invite" | "bans" | "whitelist" | "webhooks" | "moderation";
const EMPTY_SERVER_MEMBERS: ServerMember[] = [];

interface Props {
  serverId: string;
}

/**
 * Legacy standalone server settings panel — redirects to the unified
 * settings shell (INS-012). Kept as an export so any remaining direct
 * references still compile; ChatLayout now routes through the unified
 * SettingsPanel instead.
 */
export function ServerSettingsPanel({ serverId }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);
  const membersByServer = useServerStore((s) => s.members);
  const members = membersByServer[serverId] ?? EMPTY_SERVER_MEMBERS;

  if (!server || !accessToken) return null;

  const isOwner = server.owner_id === userId;
  const myMember = members.find((m) => m.user_id === userId);
  const isAdmin = isOwner || myMember?.role === "admin";
  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: "General" },
    { key: "members", label: "Members" },
    ...(isOwner || isAdmin
      ? [{ key: "invite" as Tab, label: "Invite User" }]
      : []),
    { key: "bans", label: "Bans" },
    ...(server.visibility === "private"
      ? [{ key: "whitelist" as Tab, label: "Whitelist" }]
      : []),
    { key: "webhooks" as Tab, label: "Webhooks" },
    ...(isOwner || isAdmin
      ? [{ key: "moderation" as Tab, label: "Moderation" }]
      : []),
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-outline-variant/15 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
              tab === t.key
                ? "bg-surface-container-highest text-on-surface"
                : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-6 max-w-2xl">
        <ServerSettingsContent serverId={serverId} activeTab={tab} />
      </div>
    </div>
  );
}

/**
 * INS-012: Server settings content renderer — used by the unified
 * SettingsPanel to render server-scope tab content without its own
 * tab bar. The parent (SettingsPanel) owns tab state via the store.
 */
export function ServerSettingsContent({
  serverId,
  activeTab,
}: {
  serverId: string;
  activeTab: string;
}) {
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);

  if (!server || !accessToken) return null;

  const isOwner = server.owner_id === userId;

  return (
    <>
      {activeTab === "bridge" && (
        <BridgeServerTab serverId={serverId} />
      )}
      {activeTab === "federation" && (
        <FederatedServerTab serverId={serverId} />
      )}
      {activeTab === "general" && (
        <GeneralTab serverId={serverId} accessToken={accessToken} />
      )}
      {activeTab === "members" && (
        <MembersTab serverId={serverId} accessToken={accessToken} isOwner={isOwner} />
      )}
      {activeTab === "invite" && (
        <InviteUserTab serverId={serverId} accessToken={accessToken} />
      )}
      {activeTab === "bans" && (
        <BansTab serverId={serverId} accessToken={accessToken} />
      )}
      {activeTab === "whitelist" && (
        <WhitelistTab serverId={serverId} accessToken={accessToken} />
      )}
      {activeTab === "webhooks" && (
        <WebhooksTab serverId={serverId} accessToken={accessToken} />
      )}
      {activeTab === "moderation" && (
        <ModerationTab serverId={serverId} accessToken={accessToken} />
      )}
    </>
  );
}

function BridgeServerTab({ serverId }: { serverId: string }) {
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  if (!server) return null;

  const voiceChannels = server.channels.filter((channel) => channel.channel_type === "voice");
  const textChannels = server.channels.filter((channel) => channel.channel_type !== "voice");

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-on-surface">Discord Bridge</h3>
        <p className="text-sm text-on-surface-variant mt-1">
          This server is a Discord-backed projection. Discord owns the room catalog and Concord reflects it here.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard label="Guild" value={server.name} />
        <InfoCard label="Guild ID" value={server.discordGuildId ?? "Unknown"} mono />
        <InfoCard label="Text Rooms" value={`${textChannels.length}`} />
        <InfoCard label="Voice Rooms" value={`${voiceChannels.length}`} />
      </div>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-on-surface">Behavior</h4>
        <ul className="space-y-1 text-sm text-on-surface-variant">
          <li>Messages, members, and channel structure come from the Discord bridge.</li>
          <li>Permissions and join failures usually have to be resolved in Discord, not here.</li>
          <li>Voice links attach Concord voice transport to the Discord voice room you mapped.</li>
        </ul>
      </section>
    </div>
  );
}

function FederatedServerTab({ serverId }: { serverId: string }) {
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  if (!server) return null;

  const homeserver = server.id.startsWith("federated:")
    ? server.id.slice("federated:".length)
    : server.name;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-on-surface">Federation</h3>
        <p className="text-sm text-on-surface-variant mt-1">
          This server is a Matrix federation wrapper, not a local Concord server. Room access is controlled by the remote homeserver.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard label="Homeserver" value={homeserver} mono />
        <InfoCard label="Visible Rooms" value={`${server.channels.length}`} />
      </div>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-on-surface">Behavior</h4>
        <ul className="space-y-1 text-sm text-on-surface-variant">
          <li>Joining depends on that homeserver's join rules, federation policy, and your Matrix account.</li>
          <li>Use Explore to browse public rooms and inspect join errors before assuming the bridge is broken.</li>
          <li>There is no local delete or membership management surface for federated wrappers.</li>
        </ul>
      </section>
    </div>
  );
}

function InfoCard({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg bg-surface-container-low border border-outline-variant/15 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-on-surface-variant/70">{label}</p>
      <p className={`mt-1 text-sm text-on-surface break-all ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function GeneralTab({ serverId, accessToken }: { serverId: string; accessToken: string }) {
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const updateServer = useServerStore((s) => s.updateServer);
  const deleteServer = useServerStore((s) => s.deleteServer);
  const addToast = useToastStore((s) => s.addToast);
  const userId = useAuthStore((s) => s.userId);
  const membersByServer = useServerStore((s) => s.members);
  const members = membersByServer[serverId] ?? EMPTY_SERVER_MEMBERS;
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const closeServerSettings = useSettingsStore((s) => s.closeServerSettings);

  const [name, setName] = useState(server?.name ?? "");
  const [abbreviation, setAbbreviation] = useState(server?.abbreviation ?? "");
  const [visibility, setVisibility] = useState(server?.visibility ?? "private");
  const [mediaUploads, setMediaUploads] = useState(server?.media_uploads_enabled ?? true);
  const [rulesText, setRulesText] = useState(server?.rules_text ?? "");
  // INS-053: per-server user channel creation toggle
  const [allowUserChannelCreation, setAllowUserChannelCreation] = useState(
    server?.allow_user_channel_creation ?? false
  );
  const [savingChannelCreation, setSavingChannelCreation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);

  const isOwner = server?.owner_id === userId;
  const isAdmin = isOwner || members.some((member) => member.user_id === userId && member.role === "admin");
  const canDelete = !!server && isAdmin;

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await updateServerSettings(
        serverId,
        {
          name: name || undefined,
          visibility,
          abbreviation: abbreviation || null,
          media_uploads_enabled: mediaUploads,
          rules_text: rulesText || null,
        },
        accessToken,
      );
      updateServer(serverId, {
        name: result.name,
        visibility: result.visibility,
        abbreviation: result.abbreviation,
        media_uploads_enabled: result.media_uploads_enabled,
        rules_text: result.rules_text,
      });
      addToast("Settings saved", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleChannelCreation = async (newValue: boolean) => {
    setAllowUserChannelCreation(newValue);
    setSavingChannelCreation(true);
    try {
      const result = await updateChannelCreationSetting(serverId, newValue, accessToken);
      updateServer(serverId, { allow_user_channel_creation: result.allow_user_channel_creation });
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update channel creation setting");
      setAllowUserChannelCreation(!newValue); // revert
    } finally {
      setSavingChannelCreation(false);
    }
  };

  const handleDelete = async () => {
    if (!server || !canDelete || deleteConfirmation !== server.name) return;
    setDeleting(true);
    try {
      await deleteServer(server.id, accessToken);
      closeServerSettings();
      closeSettings();
      addToast("Server deleted", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to delete server");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-on-surface">General</h3>

      <div>
        <label className="block text-sm font-medium text-on-surface mb-1">
          Server Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface mb-1">
          Abbreviation
          <span className="text-on-surface-variant font-normal ml-1">(3 chars max, shown on sidebar)</span>
        </label>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={abbreviation}
            onChange={(e) => setAbbreviation(e.target.value.slice(0, 3))}
            maxLength={3}
            placeholder={name.charAt(0).toUpperCase()}
            className="w-24 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface text-center focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          {/* Preview bubble */}
          <div className="w-12 h-12 rounded-2xl bg-surface-container flex items-center justify-center text-sm font-bold text-on-surface-variant">
            {abbreviation || name.charAt(0).toUpperCase()}
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface mb-1">
          Visibility
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => setVisibility("private")}
            className={`px-4 py-2 rounded text-sm transition-colors ${
              visibility === "private"
                ? "bg-surface-container-highest text-on-surface"
                : "bg-surface-container text-on-surface-variant hover:text-on-surface"
            }`}
          >
            Private
          </button>
          <button
            onClick={() => setVisibility("public")}
            className={`px-4 py-2 rounded text-sm transition-colors ${
              visibility === "public"
                ? "bg-surface-container-highest text-on-surface"
                : "bg-surface-container text-on-surface-variant hover:text-on-surface"
            }`}
          >
            Public
          </button>
        </div>
        <p className="text-xs text-on-surface-variant mt-1">
          {visibility === "private"
            ? "Only invited users can join"
            : "Anyone can find and join this server"}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface mb-2">
          Media Uploads
        </label>
        <button
          onClick={() => setMediaUploads(!mediaUploads)}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            mediaUploads ? "bg-primary" : "bg-surface-bright"
          }`}
          title={mediaUploads ? "Disable media uploads" : "Enable media uploads"}
        >
          <div
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              mediaUploads ? "translate-x-5" : ""
            }`}
          />
        </button>
        <p className="text-xs text-on-surface-variant mt-1">
          {mediaUploads
            ? "Members can upload images and videos in text channels"
            : "Image and video uploads are disabled in this server"}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface mb-1">
          Server Rules
        </label>
        <p className="text-xs text-on-surface-variant mb-2">
          New members see this text before they can post. Leave blank to disable the rules gate.
        </p>
        <textarea
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          maxLength={2000}
          rows={5}
          placeholder="Be respectful. No spam. Follow the community guidelines..."
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y"
        />
        <p className="text-xs text-on-surface-variant mt-1 text-right">
          {rulesText.length}/2000
        </p>
      </div>

      {/* INS-053: User channel creation toggle — only shown to admins */}
      {isAdmin && (
        <div className="flex items-center justify-between py-1">
          <div>
            <label className="block text-sm font-medium text-on-surface">
              Allow user channel creation
            </label>
            <p className="text-xs text-on-surface-variant mt-0.5">
              When enabled, any server member can create new channels.
            </p>
          </div>
          <button
            type="button"
            disabled={savingChannelCreation}
            onClick={() => handleToggleChannelCreation(!allowUserChannelCreation)}
            data-testid="allow-user-channel-creation-toggle"
            className={`relative w-11 h-6 rounded-full transition-colors disabled:opacity-60 ${
              allowUserChannelCreation ? "bg-primary" : "bg-surface-container-highest"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                allowUserChannelCreation ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm font-medium rounded transition-colors"
      >
        {saving ? "Saving..." : "Save Changes"}
      </button>

      {server && canDelete && (
        <section className="pt-6 border-t border-outline-variant/15 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-error">Delete Server</h4>
            <p className="text-xs text-on-surface-variant mt-1">
              Type <span className="text-on-surface font-medium">{server.name}</span> to confirm permanent deletion.
            </p>
          </div>
          <input
            type="text"
            value={deleteConfirmation}
            onChange={(e) => setDeleteConfirmation(e.target.value)}
            placeholder={server.name}
            className="w-full px-3 py-2 bg-surface-container border border-error/25 rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-error/30"
          />
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || deleteConfirmation !== server.name}
            className="px-4 py-2 rounded text-sm font-medium bg-error text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {deleting ? "Deleting..." : "Delete Server"}
          </button>
        </section>
      )}
    </div>
  );
}

function MembersTab({
  serverId,
  accessToken,
  isOwner,
}: {
  serverId: string;
  accessToken: string;
  isOwner: boolean;
}) {
  const localServer = useLocalServerName();
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  const load = useCallback(async () => {
    try {
      const data = await listMembers(serverId, accessToken);
      setMembers(data);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [serverId, accessToken, addToast]);

  useEffect(() => { load(); }, [load]);

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      await updateMemberRole(serverId, userId, role, accessToken);
      setMembers((prev) =>
        prev.map((m) => (m.user_id === userId ? { ...m, role } : m)),
      );
      addToast("Role updated", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  const handleKick = async (userId: string) => {
    try {
      await kickMember(serverId, userId, accessToken);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
      addToast("Member kicked", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to kick member");
    }
    setConfirmKick(null);
  };

  const roleBadge = (role: string) => {
    const colors: Record<string, string> = {
      owner: "bg-primary/10 text-primary",
      admin: "bg-primary/10 text-primary",
      member: "bg-surface-container-highest text-on-surface-variant",
    };
    return (
      <span className={`text-xs px-1.5 py-0.5 rounded ${colors[role] ?? colors.member}`}>
        {role}
      </span>
    );
  };

  if (loading) {
    return <p className="text-on-surface-variant text-sm">Loading members...</p>;
  }

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-on-surface">
        Members ({members.length})
      </h3>

      <div className="space-y-1">
        {members.map((m) => {
          const name = m.display_name || m.user_id.split(":")[0].replace("@", "");
          return (
            <div
              key={m.user_id}
              className="flex items-center justify-between px-3 py-2 rounded bg-surface-container group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-on-surface truncate">{name}</span>
                <FederationBadge userId={m.user_id} localServer={localServer} compact />
                <span className="text-xs text-on-surface-variant truncate">{m.user_id}</span>
                {roleBadge(m.role)}
              </div>
              <div className="flex items-center gap-1">
                {isOwner && m.role !== "owner" && (
                  <select
                    value={m.role}
                    onChange={(e) => handleRoleChange(m.user_id, e.target.value)}
                    className="text-xs bg-surface-container-highest text-on-surface rounded px-1.5 py-1 border-none focus:outline-none"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
                {m.role !== "owner" && (
                  confirmKick === m.user_id ? (
                    <button
                      onClick={() => handleKick(m.user_id)}
                      onMouseLeave={() => setConfirmKick(null)}
                      className="text-error text-xs px-1.5 py-1 animate-pulse"
                    >
                      Confirm?
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmKick(m.user_id)}
                      className="text-on-surface-variant/50 hover:text-error text-xs px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      Kick
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BansTab({ serverId, accessToken }: { serverId: string; accessToken: string }) {
  const [bans, setBans] = useState<ServerBan[]>([]);
  const [loading, setLoading] = useState(true);
  const [newBanId, setNewBanId] = useState("");
  const addToast = useToastStore((s) => s.addToast);

  const load = useCallback(async () => {
    try {
      const data = await listBans(serverId, accessToken);
      setBans(data);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load bans");
    } finally {
      setLoading(false);
    }
  }, [serverId, accessToken, addToast]);

  useEffect(() => { load(); }, [load]);

  const handleBan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBanId.trim()) return;
    try {
      await banUser(serverId, newBanId.trim(), accessToken);
      setNewBanId("");
      await load();
      addToast("User banned", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to ban user");
    }
  };

  const handleUnban = async (userId: string) => {
    try {
      await unbanUser(serverId, userId, accessToken);
      setBans((prev) => prev.filter((b) => b.user_id !== userId));
      addToast("User unbanned", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to unban");
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-on-surface">Bans</h3>

      <form onSubmit={handleBan} className="flex gap-2">
        <input
          type="text"
          value={newBanId}
          onChange={(e) => setNewBanId(e.target.value)}
          placeholder="@user:server.com"
          className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-error hover:bg-error-dim text-on-surface text-sm rounded transition-colors"
        >
          Ban
        </button>
      </form>

      {loading ? (
        <p className="text-on-surface-variant text-sm">Loading...</p>
      ) : bans.length === 0 ? (
        <p className="text-on-surface-variant text-sm">No banned users</p>
      ) : (
        <div className="space-y-1">
          {bans.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between px-3 py-2 rounded bg-surface-container"
            >
              <span className="text-sm text-on-surface">{b.user_id}</span>
              <button
                onClick={() => handleUnban(b.user_id)}
                className="text-xs text-on-surface-variant hover:text-secondary transition-colors"
              >
                Unban
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WhitelistTab({ serverId, accessToken }: { serverId: string; accessToken: string }) {
  const [entries, setEntries] = useState<ServerWhitelistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUserId, setNewUserId] = useState("");
  const addToast = useToastStore((s) => s.addToast);

  const load = useCallback(async () => {
    try {
      const data = await listWhitelist(serverId, accessToken);
      setEntries(data);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load whitelist");
    } finally {
      setLoading(false);
    }
  }, [serverId, accessToken, addToast]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserId.trim()) return;
    try {
      await addToWhitelist(serverId, newUserId.trim(), accessToken);
      setNewUserId("");
      await load();
      addToast("User whitelisted", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to add");
    }
  };

  const handleRemove = async (userId: string) => {
    try {
      await removeFromWhitelist(serverId, userId, accessToken);
      setEntries((prev) => prev.filter((e) => e.user_id !== userId));
      addToast("Removed from whitelist", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to remove");
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-on-surface">Whitelist</h3>
      <p className="text-xs text-on-surface-variant">
        Only whitelisted users can join this private server via invite.
      </p>

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          value={newUserId}
          onChange={(e) => setNewUserId(e.target.value)}
          placeholder="@user:server.com"
          className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <button
          type="submit"
          className="px-4 py-2 primary-glow hover:brightness-110 text-on-surface text-sm rounded transition-colors"
        >
          Add
        </button>
      </form>

      {loading ? (
        <p className="text-on-surface-variant text-sm">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-on-surface-variant text-sm">No whitelisted users</p>
      ) : (
        <div className="space-y-1">
          {entries.map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between px-3 py-2 rounded bg-surface-container"
            >
              <span className="text-sm text-on-surface">{e.user_id}</span>
              <button
                onClick={() => handleRemove(e.user_id)}
                className="text-xs text-on-surface-variant hover:text-error transition-colors"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WebhooksTab({ serverId, accessToken }: { serverId: string; accessToken: string }) {
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newChannelId, setNewChannelId] = useState<number | "">("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  const textChannels = server?.channels.filter((c) => c.channel_type === "text") ?? [];

  const load = useCallback(async () => {
    try {
      const data = await listWebhooks(serverId, accessToken);
      setWebhooks(data);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, [serverId, accessToken, addToast]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || newChannelId === "") return;
    try {
      await createWebhook(serverId, newChannelId as number, newName.trim(), accessToken);
      setNewName("");
      setNewChannelId("");
      await load();
      addToast("Webhook created", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to create webhook");
    }
  };

  const handleDelete = async (webhookId: string) => {
    try {
      await deleteWebhook(serverId, webhookId, accessToken);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
      addToast("Webhook deleted", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to delete webhook");
    }
    setConfirmDelete(null);
  };

  const handleToggle = async (webhookId: string) => {
    try {
      const result = await toggleWebhook(serverId, webhookId, accessToken);
      setWebhooks((prev) =>
        prev.map((w) => (w.id === result.id ? { ...w, enabled: result.enabled } : w)),
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to toggle webhook");
    }
  };

  const copyUrl = (webhookId: string, type: "form" | "api") => {
    const base = window.location.origin;
    const url = type === "form"
      ? `${base}/submit/${webhookId}`
      : `${base}/api/hooks/${webhookId}`;
    navigator.clipboard.writeText(url);
    addToast(`${type === "form" ? "Form" : "API"} URL copied`, "success");
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-on-surface">Webhooks</h3>
      <p className="text-xs text-on-surface-variant">
        Webhooks let external users or apps post messages to a channel via a public URL.
      </p>

      <form onSubmit={handleCreate} className="flex gap-2">
        <select
          value={newChannelId}
          onChange={(e) => setNewChannelId(e.target.value ? Number(e.target.value) : "")}
          className="px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
        >
          <option value="">Select channel</option>
          {textChannels.map((ch) => (
            <option key={ch.id} value={ch.id}>#{ch.name}</option>
          ))}
        </select>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Webhook name"
          maxLength={100}
          className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <button
          type="submit"
          disabled={!newName.trim() || newChannelId === ""}
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
        >
          Create
        </button>
      </form>

      {loading ? (
        <p className="text-on-surface-variant text-sm">Loading...</p>
      ) : webhooks.length === 0 ? (
        <p className="text-on-surface-variant text-sm">No webhooks configured</p>
      ) : (
        <div className="space-y-2">
          {webhooks.map((wh) => (
            <div
              key={wh.id}
              className="px-3 py-3 rounded bg-surface-container space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <span className="text-sm text-on-surface font-medium">{wh.name}</span>
                  <span className="text-xs text-on-surface-variant ml-2">#{wh.channel_name}</span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Enabled toggle */}
                  <button
                    onClick={() => handleToggle(wh.id)}
                    className={`relative w-8 h-4 rounded-full transition-colors ${
                      wh.enabled ? "bg-secondary-container" : "bg-surface-bright"
                    }`}
                    title={wh.enabled ? "Enabled" : "Disabled"}
                  >
                    <div
                      className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                        wh.enabled ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                  {/* Delete */}
                  {confirmDelete === wh.id ? (
                    <button
                      onClick={() => handleDelete(wh.id)}
                      onMouseLeave={() => setConfirmDelete(null)}
                      className="text-error text-xs px-1 animate-pulse"
                    >
                      Confirm?
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(wh.id)}
                      className="text-on-surface-variant/50 hover:text-error text-xs transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => copyUrl(wh.id, "form")}
                  className="text-xs text-primary hover:text-primary transition-colors"
                >
                  Copy Form URL
                </button>
                <span className="text-outline-variant">|</span>
                <button
                  onClick={() => copyUrl(wh.id, "api")}
                  className="text-xs text-primary hover:text-primary transition-colors"
                >
                  Copy API URL
                </button>
                <span className="text-xs text-on-surface-variant/50 ml-auto">
                  by {wh.created_by.split(":")[0].replace("@", "")}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModerationTab({ serverId, accessToken }: { serverId: string; accessToken: string }) {
  const [settings, setSettings] = useState<BanSettings | null>(null);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const addToast = useToastStore((s) => s.addToast);

  const [kickLimit, setKickLimit] = useState(3);
  const [kickWindow, setKickWindow] = useState(30);
  const [banMode, setBanMode] = useState("soft");

  const load = useCallback(async () => {
    try {
      const [banSettings, memberList] = await Promise.all([
        getBanSettings(serverId, accessToken),
        listMembers(serverId, accessToken),
      ]);
      setSettings(banSettings);
      setKickLimit(banSettings.kick_limit);
      setKickWindow(banSettings.kick_window_minutes);
      setBanMode(banSettings.ban_mode);
      setMembers(memberList);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load moderation settings");
    } finally {
      setLoading(false);
    }
  }, [serverId, accessToken, addToast]);

  useEffect(() => { load(); }, [load]);

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const updated = await updateBanSettings(serverId, {
        kick_limit: kickLimit,
        kick_window_minutes: kickWindow,
        ban_mode: banMode,
      }, accessToken);
      setSettings(updated);
      addToast("Moderation settings saved", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handlePermissionChange = async (userId: string, perm: "can_kick" | "can_ban", value: boolean) => {
    try {
      await updateMemberPermissions(serverId, userId, { [perm]: value }, accessToken);
      setMembers((prev) =>
        prev.map((m) => m.user_id === userId ? { ...m, [perm]: value } : m),
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update permissions");
    }
  };

  if (loading) return <p className="text-on-surface-variant text-sm">Loading...</p>;

  const nonOwnerMembers = members.filter((m) => m.role !== "owner");

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-on-surface">Moderation Settings</h3>
        <p className="text-xs text-on-surface-variant">
          Configure kick limits and ban behavior for this server.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">
              Kick Limit
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={kickLimit}
              onChange={(e) => setKickLimit(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <p className="text-xs text-on-surface-variant mt-1">
              Kicks before ban escalation
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface mb-1">
              Kick Window (minutes)
            </label>
            <input
              type="number"
              min={1}
              max={1440}
              value={kickWindow}
              onChange={(e) => setKickWindow(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <p className="text-xs text-on-surface-variant mt-1">
              Time window for counting kicks
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-on-surface mb-2">
            Ban Mode
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setBanMode("soft")}
              className={`px-4 py-2 rounded text-sm transition-colors ${
                banMode === "soft"
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "bg-surface-container text-on-surface-variant hover:text-on-surface"
              }`}
            >
              Soft Ban
            </button>
            <button
              onClick={() => setBanMode("harsh")}
              className={`px-4 py-2 rounded text-sm transition-colors ${
                banMode === "harsh"
                  ? "bg-error-container/30 text-on-error-container border border-red-600/50"
                  : "bg-surface-container text-on-surface-variant hover:text-on-surface"
              }`}
            >
              Harsh Ban
            </button>
          </div>
          <p className="text-xs text-on-surface-variant mt-1">
            {banMode === "soft"
              ? "Soft: Warns the user with escalation details after each kick."
              : "Harsh: Bans the user's IP address with a dramatic prank overlay."}
          </p>
        </div>

        <button
          onClick={handleSaveSettings}
          disabled={saving || (
            settings?.kick_limit === kickLimit &&
            settings?.kick_window_minutes === kickWindow &&
            settings?.ban_mode === banMode
          )}
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm font-medium rounded transition-colors"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      <div className="border-t border-outline-variant/15 pt-6 space-y-4">
        <h3 className="text-lg font-semibold text-on-surface">Member Permissions</h3>
        <p className="text-xs text-on-surface-variant">
          Grant kick/ban permissions to individual members. Admins and owners always have these permissions.
        </p>

        {nonOwnerMembers.length === 0 ? (
          <p className="text-on-surface-variant text-sm">No non-owner members</p>
        ) : (
          <div className="space-y-1">
            {nonOwnerMembers.map((m) => {
              const name = m.display_name || m.user_id.split(":")[0].replace("@", "");
              const isAdmin = m.role === "admin";
              return (
                <div
                  key={m.user_id}
                  className="flex items-center justify-between px-3 py-2 rounded bg-surface-container"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-on-surface truncate">{name}</span>
                    {isAdmin && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                        admin
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isAdmin || m.can_kick}
                        disabled={isAdmin}
                        onChange={(e) => handlePermissionChange(m.user_id, "can_kick", e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-outline-variant bg-surface-container-highest text-primary focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-xs text-on-surface-variant">Kick</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isAdmin || m.can_ban}
                        disabled={isAdmin}
                        onChange={(e) => handlePermissionChange(m.user_id, "can_ban", e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-outline-variant bg-surface-container-highest text-primary focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-xs text-on-surface-variant">Ban</span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function InviteUserTab({ serverId, accessToken }: { serverId: string; accessToken: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  // Load current members to filter them out
  useEffect(() => {
    listMembers(serverId, accessToken)
      .then(setMembers)
      .catch(() => {});
  }, [serverId, accessToken]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchUsers(query, accessToken);
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, accessToken]);

  const memberIds = new Set(members.map((m) => m.user_id));
  const filteredResults = results.filter((u) => !memberIds.has(u.user_id));

  const handleInvite = async (userId: string) => {
    setSending(userId);
    try {
      await sendDirectInvite(serverId, userId, accessToken);
      const name = userId.split(":")[0].replace("@", "");
      addToast(`Invite sent to ${name}`, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setSending(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Shareable Invite Link ── */}
      <InviteLinkSection serverId={serverId} accessToken={accessToken} />

      {/* ── Direct Invite (search existing users) ── */}
      <div>
        <h3 className="text-lg font-semibold text-on-surface mb-1">Direct Invite</h3>
        <p className="text-xs text-on-surface-variant mb-3">
          Search for registered users to invite directly to this server.
        </p>
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search users..."
        className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
      />

      {loading ? (
        <p className="text-on-surface-variant text-sm">Searching...</p>
      ) : filteredResults.length === 0 ? (
        <p className="text-on-surface-variant text-sm">
          {results.length > 0 && filteredResults.length === 0
            ? "All matching users are already members"
            : query
              ? "No users found"
              : "Start typing to search"}
        </p>
      ) : (
        <div className="space-y-1">
          {filteredResults.map((user) => {
            const name = user.display_name || user.user_id.split(":")[0].replace("@", "");
            return (
              <div
                key={user.user_id}
                className="flex items-center justify-between px-3 py-2 rounded bg-surface-container"
              >
                <div className="min-w-0">
                  <span className="text-sm text-on-surface">{name}</span>
                  {user.display_name && (
                    <span className="text-xs text-on-surface-variant ml-2">{user.user_id}</span>
                  )}
                </div>
                <button
                  onClick={() => handleInvite(user.user_id)}
                  disabled={sending === user.user_id}
                  className="text-xs px-3 py-1 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface rounded transition-colors"
                >
                  {sending === user.user_id ? "..." : "Invite"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Quick Invite Section (INS-020) ──
   Lets server members create a simple temporary passphrase that a
   friend can use to join. Pick a word, tell your friend, it expires
   in an hour. Simple and verbal-friendly. */
function InviteLinkSection({
  serverId,
  accessToken,
}: {
  serverId: string;
  accessToken: string;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [maxUses, setMaxUses] = useState(1);
  const [permanent, setPermanent] = useState(false);
  const [savingInviteId, setSavingInviteId] = useState<number | null>(null);
  const [inviteDrafts, setInviteDrafts] = useState<
    Record<number, { expiresInHours: number; maxUses: number; permanent: boolean }>
  >({});
  const [authCode, setAuthCode] = useState("");
  const [codeTtl, setCodeTtl] = useState(0);
  const addToast = useToastStore((s) => s.addToast);

  const buildInviteLink = useCallback((token: string) => `${window.location.origin}?invite=${token}`, []);
  const inviteHoursFromExpiresAt = useCallback((value: string) => {
    const diffMs = new Date(value).getTime() - Date.now();
    return Math.max(1, Math.round(diffMs / 3_600_000));
  }, []);

  const copyToClipboard = useCallback(async (text: string, label = "Invite link copied") => {
    try {
      await navigator.clipboard.writeText(text);
      addToast(label, "success");
    } catch {
      addToast("Failed to copy invite link");
    }
  }, [addToast]);

  // Fetch and auto-refresh the rolling auth code
  useEffect(() => {
    let mounted = true;
    const fetchCode = async () => {
      try {
        const result = await getAuthCode(serverId, accessToken);
        if (mounted) {
          setAuthCode(result.code);
          setCodeTtl(result.ttl_seconds);
        }
      } catch { /* non-fatal */ }
    };
    fetchCode();
    // Refresh every 30 seconds to keep the code + TTL fresh
    const interval = setInterval(fetchCode, 30_000);
    return () => { mounted = false; clearInterval(interval); };
  }, [serverId, accessToken]);

  // Countdown timer for the TTL display
  useEffect(() => {
    if (codeTtl <= 0) return;
    const timer = setInterval(() => setCodeTtl((t) => Math.max(0, t - 1)), 1000);
    return () => clearInterval(timer);
  }, [codeTtl > 0]);

  useEffect(() => {
    listInvites(serverId, accessToken)
      .then(setInvites)
      .catch(() => {});
  }, [serverId, accessToken]);

  useEffect(() => {
    setInviteDrafts((current) => {
      const next = { ...current };
      for (const invite of invites) {
        next[invite.id] ??= {
          expiresInHours: inviteHoursFromExpiresAt(invite.expires_at),
          maxUses: invite.max_uses,
          permanent: invite.permanent,
        };
      }
      return next;
    });
  }, [invites, inviteHoursFromExpiresAt]);

  const createLinkInvite = async (options?: { passphrase?: string }) => {
    const invite = await createInvite(serverId, accessToken, {
      passphrase: options?.passphrase,
      max_uses: maxUses,
      permanent,
      ...(permanent ? {} : { expires_in_hours: expiresInHours }),
    });
    setInvites((prev) => [invite, ...prev]);
    setInviteDrafts((prev) => ({
      ...prev,
      [invite.id]: {
        expiresInHours: inviteHoursFromExpiresAt(invite.expires_at),
        maxUses: invite.max_uses,
        permanent: invite.permanent,
      },
    }));
    const link = buildInviteLink(invite.token);
    setCreatedLink(link);
    await copyToClipboard(link);
    return invite;
  };

  const handleGenerate = async () => {
    setCreating(true);
    try {
      await createLinkInvite();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to generate token");
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async () => {
    const phrase = passphrase.trim();
    if (phrase.length < 3) {
      addToast("Passphrase must be at least 3 characters");
      return;
    }
    setCreating(true);
    try {
      await createLinkInvite({ passphrase: phrase });
      setPassphrase("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create invite";
      addToast(msg.includes("409") ? "That passphrase is already in use" : msg);
    } finally {
      setCreating(false);
    }
  };

  const handleSaveInvite = async (inviteId: number) => {
    const draft = inviteDrafts[inviteId];
    if (!draft) return;
    setSavingInviteId(inviteId);
    try {
      const updated = await updateInvite(inviteId, accessToken, {
        max_uses: draft.maxUses,
        permanent: draft.permanent,
        ...(draft.permanent ? {} : { expires_in_hours: draft.expiresInHours }),
      });
      setInvites((current) => current.map((invite) => (
        invite.id === inviteId ? updated : invite
      )));
      addToast("Invite updated", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update invite");
    } finally {
      setSavingInviteId(null);
    }
  };

  const handleRevokeInvite = async (inviteId: number) => {
    try {
      await revokeInvite(inviteId, accessToken);
      setInvites((current) => current.filter((invite) => invite.id !== inviteId));
      addToast("Invite revoked", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to revoke invite");
    }
  };

  const activeInvites = invites.filter((inv) => inv.is_valid !== false);

  return (
    <div>
      <h3 className="text-lg font-semibold text-on-surface mb-1">Quick Invite</h3>
      {/* Rolling auth code display */}
      {authCode && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-surface-container-high border border-outline-variant/20">
          <p className="text-xs text-on-surface-variant font-label uppercase tracking-wider mb-2">
            Server Auth Code
          </p>
          <div className="flex items-center justify-between">
            <span className="text-2xl font-mono font-bold text-on-surface tracking-[0.3em]">
              {authCode}
            </span>
            <span className="text-xs text-on-surface-variant font-mono">
              {Math.floor(codeTtl / 60)}:{String(codeTtl % 60).padStart(2, "0")}
            </span>
          </div>
          <p className="text-[10px] text-on-surface-variant mt-1">
            Share this code with your friend — they'll need it along with an invite token to join.
          </p>
        </div>
      )}

      <p className="text-xs text-on-surface-variant mb-3">
        Generate a copyable invite link or custom passphrase, then tune its lifetime and usage budget.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-on-surface-variant font-label">Hours</span>
          <input
            type="number"
            min={1}
            max={8760}
            value={expiresInHours}
            disabled={permanent}
            onChange={(event) => setExpiresInHours(Math.max(1, Number(event.target.value) || 1))}
            className="px-3 py-2 rounded-xl bg-surface-container border border-outline-variant/20 text-sm text-on-surface disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-on-surface-variant font-label">Max uses</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(event) => setMaxUses(Math.max(1, Number(event.target.value) || 1))}
            className="px-3 py-2 rounded-xl bg-surface-container border border-outline-variant/20 text-sm text-on-surface"
          />
        </label>
        <label className="flex items-center gap-2 rounded-xl bg-surface-container border border-outline-variant/20 px-3 py-2.5 mt-[18px]">
          <input
            type="checkbox"
            checked={permanent}
            onChange={(event) => setPermanent(event.target.checked)}
          />
          <span className="text-sm text-on-surface">Permanent</span>
        </label>
      </div>

      {/* One-tap generate button */}
      <button
        onClick={handleGenerate}
        disabled={creating}
        className="w-full py-2.5 rounded-xl primary-glow text-on-primary font-headline font-semibold hover:brightness-110 shadow-lg shadow-primary/20 transition-all disabled:opacity-40 active:scale-[0.98] mb-3"
      >
        {creating ? "..." : "Generate Invite Link"}
      </button>

      {/* Or custom passphrase */}
      <p className="text-xs text-on-surface-variant mb-1.5">Or choose a custom passphrase:</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={passphrase}
          onChange={(e) => { setPassphrase(e.target.value); setCreatedLink(null); }}
          placeholder="e.g. pizza123"
          className="flex-1 px-3 py-2.5 bg-surface-container border border-outline-variant/20 rounded-xl text-on-surface text-sm font-mono placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <button
          onClick={handleCreate}
          disabled={creating || passphrase.trim().length < 3}
          className="px-4 py-2.5 rounded-xl primary-glow text-on-primary font-headline font-semibold hover:brightness-110 shadow-lg shadow-primary/20 transition-all disabled:opacity-40 active:scale-[0.98] flex-shrink-0"
        >
          {creating ? "..." : "Create"}
        </button>
      </div>

      {createdLink && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
          <p className="text-xs text-green-300 font-label uppercase tracking-wider">Ready to paste</p>
          <div className="mt-1 flex items-center gap-2">
            <input
              readOnly
              value={createdLink}
              className="flex-1 min-w-0 bg-transparent text-sm text-green-100 font-mono focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void copyToClipboard(createdLink)}
              className="px-2 py-1 rounded-md bg-green-500/20 text-green-100 text-xs"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {activeInvites.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-on-surface-variant font-label uppercase tracking-wider mb-1">
            Active invites
          </p>
          {activeInvites.map((inv) => (
            <div
              key={inv.id}
              className="rounded-xl bg-surface-container border border-outline-variant/15 p-3 space-y-3"
            >
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={buildInviteLink(inv.token)}
                  className="flex-1 min-w-0 bg-transparent text-xs text-on-surface font-mono truncate focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void copyToClipboard(buildInviteLink(inv.token))}
                  className="px-2 py-1 rounded-md bg-surface-container-high text-on-surface text-xs"
                >
                  Copy
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-on-surface-variant font-label">Hours</span>
                  <input
                    type="number"
                    min={1}
                    max={8760}
                    value={inviteDrafts[inv.id]?.expiresInHours ?? 1}
                    disabled={inviteDrafts[inv.id]?.permanent}
                    onChange={(event) => {
                      const next = Math.max(1, Number(event.target.value) || 1);
                      setInviteDrafts((current) => ({
                        ...current,
                        [inv.id]: { ...current[inv.id], expiresInHours: next },
                      }));
                    }}
                    className="px-3 py-2 rounded-lg bg-surface-container-high border border-outline-variant/15 text-sm text-on-surface disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-on-surface-variant font-label">Max uses</span>
                  <input
                    type="number"
                    min={Math.max(1, inv.use_count)}
                    max={1000}
                    value={inviteDrafts[inv.id]?.maxUses ?? inv.max_uses}
                    onChange={(event) => {
                      const next = Math.max(inv.use_count || 1, Number(event.target.value) || 1);
                      setInviteDrafts((current) => ({
                        ...current,
                        [inv.id]: { ...current[inv.id], maxUses: next },
                      }));
                    }}
                    className="px-3 py-2 rounded-lg bg-surface-container-high border border-outline-variant/15 text-sm text-on-surface"
                  />
                </label>
                <label className="flex items-center gap-2 rounded-lg bg-surface-container-high border border-outline-variant/15 px-3 py-2 mt-[18px]">
                  <input
                    type="checkbox"
                    checked={inviteDrafts[inv.id]?.permanent ?? inv.permanent}
                    onChange={(event) => {
                      setInviteDrafts((current) => ({
                        ...current,
                        [inv.id]: { ...current[inv.id], permanent: event.target.checked },
                      }));
                    }}
                  />
                  <span className="text-sm text-on-surface">Permanent</span>
                </label>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-on-surface-variant">
                <span>
                  {inv.permanent ? "Never expires" : `Expires ${new Date(inv.expires_at).toLocaleString()}`}
                </span>
                <span>{inv.use_count}/{inv.max_uses} used</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSaveInvite(inv.id)}
                  disabled={savingInviteId === inv.id}
                  className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs font-medium disabled:opacity-50"
                >
                  {savingInviteId === inv.id ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRevokeInvite(inv.id)}
                  className="px-3 py-1.5 rounded-lg bg-error/10 text-error text-xs font-medium"
                >
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
