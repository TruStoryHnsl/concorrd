import { getApiBase } from "./serverUrl";

function getBase() { return getApiBase(); }

export interface Channel {
  id: number;
  name: string;
  channel_type: string;
  matrix_room_id: string;
  position: number;
}

export interface Server {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  visibility: string;
  abbreviation: string | null;
  media_uploads_enabled: boolean;
  rules_text?: string | null;
  channels: Channel[];
  /**
   * Client-only marker: true when this server is a synthetic wrapper
   * around a joined federated Matrix room that is NOT part of any
   * Concord-managed server. Populated by
   * `useServerStore.hydrateFederatedRooms` after the Matrix client
   * surfaces the join. The backend API never sets this field — it is
   * stripped on the wire and exists only so the sidebar can render
   * non-local rooms with a distinct color.
   */
  federated?: boolean;
  /**
   * Client-only marker for bridge-created servers. Set during
   * `hydrateFederatedRooms` when the synthetic server wraps rooms
   * created by a bridge (e.g., Discord guilds via mautrix-discord).
   */
  bridgeType?: "discord";
  /**
   * Client-only Discord guild identifier for bridge-created synthetic
   * servers. Used to merge voice-room overlays into the guild tile.
   */
  discordGuildId?: string;
}

export interface Invite {
  id: number;
  token: string;
  server_id: string;
  server_name: string;
  max_uses: number;
  use_count: number;
  expires_at: string;
  permanent: boolean;
  is_valid: boolean;
}

export interface ServerMember {
  user_id: string;
  role: string;
  display_name: string | null;
  joined_at: string;
  can_kick: boolean;
  can_ban: boolean;
}

export interface ServerDiscoverResult {
  id: string;
  name: string;
  icon_url: string | null;
  abbreviation: string | null;
  member_count: number;
}

export interface ServerBan {
  id: number;
  user_id: string;
  banned_by: string;
  created_at: string;
}

export interface ServerWhitelistEntry {
  id: number;
  user_id: string;
  added_by: string;
  created_at: string;
}

export interface RedeemResult {
  status: string;
  server_id: string;
  server_name: string;
}

export interface InviteValidation {
  valid: boolean;
  server_name: string | null;
  server_id: string | null;
}

export interface RegisterResult {
  access_token: string;
  user_id: string;
  device_id: string;
  server_id: string | null;
  server_name: string | null;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const resp = await fetch(`${getBase()}${path}`, {
    ...options,
    headers,
  });

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({ detail: resp.statusText }));
    let message = "API error";
    if (typeof error.detail === "string") {
      message = error.detail;
    } else if (Array.isArray(error.detail)) {
      // Pydantic validation errors: [{msg, loc, type}, ...]
      message = error.detail
        .map((e: { msg?: string; loc?: string[] }) => {
          const field = e.loc?.filter((s) => s !== "body").join(".") || "";
          return field ? `${field}: ${e.msg}` : (e.msg || "Validation error");
        })
        .join("; ");
    } else if (error.error) {
      message = error.error;
    }
    throw new Error(message);
  }

  return resp.json();
}

export interface ServerExtension {
  id: string;
  name: string;
  url: string;
  icon: string;
  description: string;
}

export async function listExtensions(accessToken: string): Promise<ServerExtension[]> {
  return apiFetch("/extensions", {}, accessToken);
}

export async function listServers(accessToken: string): Promise<Server[]> {
  return apiFetch("/servers", {}, accessToken);
}

export async function createServer(
  name: string,
  accessToken: string,
  options?: { visibility?: string; abbreviation?: string },
): Promise<Server> {
  return apiFetch(
    "/servers",
    { method: "POST", body: JSON.stringify({ name, ...options }) },
    accessToken,
  );
}

export async function createChannel(
  serverId: string,
  name: string,
  channelType: string,
  accessToken: string,
): Promise<Channel> {
  return apiFetch(
    `/servers/${serverId}/channels`,
    { method: "POST", body: JSON.stringify({ name, channel_type: channelType }) },
    accessToken,
  );
}

export async function createInvite(
  serverId: string,
  accessToken: string,
  options?: { passphrase?: string; permanent?: boolean; expires_in_hours?: number; max_uses?: number },
): Promise<Invite> {
  return apiFetch(
    "/invites",
    {
      method: "POST",
      body: JSON.stringify({
        server_id: serverId,
        ...options,
      }),
    },
    accessToken,
  );
}

export async function getAuthCode(
  serverId: string,
  accessToken: string,
): Promise<{ code: string; ttl_seconds: number; server_id: string }> {
  return apiFetch(`/invites/auth-code/${serverId}`, {}, accessToken);
}

export async function listInvites(
  serverId: string,
  accessToken: string,
): Promise<Invite[]> {
  return apiFetch(`/invites/${serverId}`, {}, accessToken);
}

export async function validateInvite(token: string): Promise<InviteValidation> {
  return apiFetch(`/invites/validate/${token}`);
}

export async function revokeInvite(
  inviteId: number,
  accessToken: string,
): Promise<void> {
  await apiFetch(`/invites/${inviteId}`, { method: "DELETE" }, accessToken);
}

export async function updateInvite(
  inviteId: number,
  accessToken: string,
  options: { permanent?: boolean; expires_in_hours?: number; max_uses?: number },
): Promise<Invite> {
  return apiFetch(
    `/invites/${inviteId}`,
    {
      method: "PATCH",
      body: JSON.stringify(options),
    },
    accessToken,
  );
}

export async function deleteServer(
  serverId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(`/servers/${serverId}`, { method: "DELETE" }, accessToken);
}

export async function deleteChannel(
  serverId: string,
  channelId: number,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/channels/${channelId}`,
    { method: "DELETE" },
    accessToken,
  );
}

export async function renameChannel(
  serverId: string,
  channelId: number,
  name: string,
  accessToken: string,
): Promise<Channel> {
  return apiFetch(
    `/servers/${serverId}/channels/${channelId}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
    accessToken,
  );
}

export async function reorderChannels(
  serverId: string,
  channelIds: number[],
  accessToken: string,
): Promise<{ status: string }> {
  return apiFetch(
    `/servers/${serverId}/channels/reorder`,
    { method: "PATCH", body: JSON.stringify({ order: channelIds }) },
    accessToken,
  );
}

export async function leaveServer(
  serverId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/members/me`,
    { method: "DELETE" },
    accessToken,
  );
}

export async function registerUser(
  username: string,
  password: string,
  inviteToken?: string,
): Promise<RegisterResult> {
  return apiFetch("/register", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      ...(inviteToken && { invite_token: inviteToken }),
    }),
  });
}

// Voice participants

export interface VoiceRoomParticipant {
  identity: string;
  name: string;
  source?: "matrix" | "discord";
  bot?: boolean;
}

export async function getVoiceParticipants(
  roomIds: string[],
  accessToken: string,
): Promise<Record<string, VoiceRoomParticipant[]>> {
  if (roomIds.length === 0) return {};
  return apiFetch(
    `/voice/participants?rooms=${encodeURIComponent(roomIds.join(","))}`,
    {},
    accessToken,
  );
}

// Soundboard

export interface SoundboardClip {
  id: number;
  name: string;
  server_id: string;
  uploaded_by: string;
  duration: number | null;
  keybind: string | null;
  url: string;
}

export async function listSoundboardClips(
  serverId: string,
  accessToken: string,
): Promise<SoundboardClip[]> {
  return apiFetch(`/soundboard/${serverId}`, {}, accessToken);
}

export async function uploadSoundboardClip(
  serverId: string,
  name: string,
  file: File,
  accessToken: string,
): Promise<SoundboardClip> {
  const formData = new FormData();
  formData.append("name", name);
  formData.append("file", file);

  const resp = await fetch(`${getBase()}/soundboard/${serverId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(error.detail || "Upload failed");
  }

  return resp.json();
}

export async function updateSoundboardClip(
  clipId: number,
  updates: { name?: string; keybind?: string },
  accessToken: string,
): Promise<{ status: string; name: string; keybind: string | null }> {
  return apiFetch(
    `/soundboard/${clipId}`,
    { method: "PATCH", body: JSON.stringify(updates) },
    accessToken,
  );
}

export async function deleteSoundboardClip(
  clipId: number,
  accessToken: string,
): Promise<void> {
  await apiFetch(`/soundboard/${clipId}`, { method: "DELETE" }, accessToken);
}

// Soundboard library (Freesound)

export interface LibrarySound {
  id: number;
  name: string;
  duration: number;
  preview_url: string;
}

export type LibrarySortOption = "relevance" | "popular" | "rating" | "newest" | "shortest" | "longest";

export async function searchSoundLibrary(
  query: string,
  accessToken: string,
  page = 1,
  sort: LibrarySortOption = "relevance",
): Promise<LibrarySound[]> {
  return apiFetch(
    `/soundboard/library/search?q=${encodeURIComponent(query)}&page=${page}&sort=${sort}`,
    {},
    accessToken,
  );
}

export async function importLibrarySound(
  serverId: string,
  freesoundId: number,
  name: string,
  previewUrl: string,
  accessToken: string,
): Promise<SoundboardClip> {
  return apiFetch(
    `/soundboard/library/import/${serverId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freesound_id: freesoundId,
        name,
        preview_url: previewUrl,
      }),
    },
    accessToken,
  );
}

// --- Discovery ---

export async function discoverServers(
  query: string,
  accessToken: string,
): Promise<ServerDiscoverResult[]> {
  const q = query ? `?q=${encodeURIComponent(query)}` : "";
  return apiFetch(`/servers/discover${q}`, {}, accessToken);
}

export async function getDefaultServer(
  accessToken: string,
): Promise<{ server_id: string | null; server_name?: string; is_member?: boolean }> {
  return apiFetch("/servers/default", {}, accessToken);
}

export async function joinServer(
  serverId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(`/servers/${serverId}/join`, { method: "POST" }, accessToken);
}

export async function rejoinServerRooms(
  serverId: string,
  accessToken: string,
): Promise<{ status: string; rooms_joined: number }> {
  return apiFetch(`/servers/${serverId}/rejoin`, { method: "POST" }, accessToken);
}

// --- Server Settings ---

export async function getServerSettings(
  serverId: string,
  accessToken: string,
): Promise<{ id: string; name: string; visibility: string; abbreviation: string | null; icon_url: string | null; owner_id: string }> {
  return apiFetch(`/servers/${serverId}/settings`, {}, accessToken);
}

export async function updateServerSettings(
  serverId: string,
  settings: { name?: string; visibility?: string; abbreviation?: string | null; media_uploads_enabled?: boolean; rules_text?: string | null },
  accessToken: string,
): Promise<{ id: string; name: string; visibility: string; abbreviation: string | null; media_uploads_enabled: boolean; rules_text: string | null }> {
  return apiFetch(
    `/servers/${serverId}/settings`,
    { method: "PATCH", body: JSON.stringify(settings) },
    accessToken,
  );
}

export async function getServerRules(
  serverId: string,
  accessToken: string,
): Promise<{ rules_text: string | null }> {
  return apiFetch(`/servers/${serverId}/rules`, {}, accessToken);
}

// --- Members ---

export async function listMembers(
  serverId: string,
  accessToken: string,
): Promise<ServerMember[]> {
  return apiFetch(`/servers/${serverId}/members`, {}, accessToken);
}

export async function updateMemberRole(
  serverId: string,
  userId: string,
  role: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/members/${encodeURIComponent(userId)}/role`,
    { method: "PATCH", body: JSON.stringify({ role }) },
    accessToken,
  );
}

export async function updateDisplayName(
  serverId: string,
  userId: string,
  displayName: string | null,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/members/${encodeURIComponent(userId)}/display-name`,
    { method: "PATCH", body: JSON.stringify({ display_name: displayName }) },
    accessToken,
  );
}

export async function kickMember(
  serverId: string,
  userId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
    accessToken,
  );
}

// --- Bans ---

export async function listBans(
  serverId: string,
  accessToken: string,
): Promise<ServerBan[]> {
  return apiFetch(`/servers/${serverId}/bans`, {}, accessToken);
}

export async function banUser(
  serverId: string,
  userId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/bans`,
    { method: "POST", body: JSON.stringify({ user_id: userId }) },
    accessToken,
  );
}

export async function unbanUser(
  serverId: string,
  userId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/bans/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
    accessToken,
  );
}

// --- Whitelist ---

export async function listWhitelist(
  serverId: string,
  accessToken: string,
): Promise<ServerWhitelistEntry[]> {
  return apiFetch(`/servers/${serverId}/whitelist`, {}, accessToken);
}

export async function addToWhitelist(
  serverId: string,
  userId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/whitelist`,
    { method: "POST", body: JSON.stringify({ user_id: userId }) },
    accessToken,
  );
}

export async function removeFromWhitelist(
  serverId: string,
  userId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/whitelist/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
    accessToken,
  );
}

// --- Webhooks ---

export interface Webhook {
  id: string;
  server_id: string;
  channel_id: number;
  channel_name: string;
  name: string;
  created_by: string;
  enabled: boolean;
  created_at: string;
}

export interface WebhookInfo {
  id: string;
  name: string;
  channel_name: string;
  server_name: string;
  enabled: boolean;
}

export async function listWebhooks(
  serverId: string,
  accessToken: string,
): Promise<Webhook[]> {
  return apiFetch(`/servers/${serverId}/webhooks`, {}, accessToken);
}

export async function createWebhook(
  serverId: string,
  channelId: number,
  name: string,
  accessToken: string,
): Promise<Webhook> {
  return apiFetch(
    `/servers/${serverId}/webhooks`,
    { method: "POST", body: JSON.stringify({ channel_id: channelId, name }) },
    accessToken,
  );
}

export async function deleteWebhook(
  serverId: string,
  webhookId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(
    `/servers/${serverId}/webhooks/${webhookId}`,
    { method: "DELETE" },
    accessToken,
  );
}

export async function toggleWebhook(
  serverId: string,
  webhookId: string,
  accessToken: string,
): Promise<{ id: string; enabled: boolean }> {
  return apiFetch(
    `/servers/${serverId}/webhooks/${webhookId}`,
    { method: "PATCH" },
    accessToken,
  );
}

export async function getWebhookInfo(webhookId: string): Promise<WebhookInfo> {
  return apiFetch(`/hooks/${webhookId}`);
}

export async function submitWebhookMessage(
  webhookId: string,
  content: string,
  username?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/hooks/${webhookId}`, {
    method: "POST",
    body: JSON.stringify({ content, username: username || "Anonymous" }),
  });
}

// --- Email Invites ---

export async function checkEmailAvailable(): Promise<{ available: boolean }> {
  return apiFetch("/invites/email-available");
}

export async function sendEmailInvite(
  serverId: string,
  email: string,
  accessToken: string,
): Promise<{ status: string; email: string }> {
  return apiFetch(
    "/invites/email",
    {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, email }),
    },
    accessToken,
  );
}

// --- Invite Redeem ---

export async function redeemInvite(
  token: string,
  accessToken: string,
): Promise<RedeemResult> {
  return apiFetch(
    `/invites/${token}/redeem`,
    { method: "POST" },
    accessToken,
  );
}

// --- Invite List ---

export async function listServerInvites(
  serverId: string,
  accessToken: string,
): Promise<Invite[]> {
  return apiFetch(`/invites/${serverId}`, {}, accessToken);
}

// --- Password Change ---

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  accessToken: string,
): Promise<{ status: string }> {
  return apiFetch(
    "/user/change-password",
    {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    },
    accessToken,
  );
}

// --- Bug Reports ---

export async function submitBugReport(
  title: string,
  description: string,
  systemInfo: Record<string, unknown>,
  accessToken: string,
): Promise<{ status: string; id: number }> {
  return apiFetch(
    "/reports",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        description,
        system_info: JSON.stringify(systemInfo),
      }),
    },
    accessToken,
  );
}

// --- Direct Invites ---

export interface UserSearchResult {
  user_id: string;
  display_name: string | null;
}

export interface DirectInvite {
  id: number;
  server_id: string;
  server_name: string;
  inviter_id: string;
  created_at: string;
}

export async function searchUsers(
  q: string,
  accessToken: string,
): Promise<UserSearchResult[]> {
  return apiFetch(`/users/search?q=${encodeURIComponent(q)}`, {}, accessToken);
}

export async function sendDirectInvite(
  serverId: string,
  inviteeId: string,
  accessToken: string,
): Promise<{ status: string; id: number }> {
  return apiFetch(
    "/direct-invites",
    {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, invitee_id: inviteeId }),
    },
    accessToken,
  );
}

export async function getPendingDirectInvites(
  accessToken: string,
): Promise<DirectInvite[]> {
  return apiFetch("/direct-invites/pending", {}, accessToken);
}

export async function respondToDirectInvite(
  inviteId: number,
  action: "accept" | "decline",
  accessToken: string,
): Promise<{ status: string; server_id?: string; server_name?: string }> {
  return apiFetch(
    `/direct-invites/${inviteId}/respond`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
    },
    accessToken,
  );
}

// --- Stats ---

export interface StatsDay {
  day: string;
  voice_seconds: number;
  messages: number;
}

export interface UserStats {
  total_voice_seconds: number;
  total_messages: number;
  active_since: string | null;
  daily: StatsDay[];
}

export async function startVoiceSession(
  channelId: string,
  serverId: string,
  accessToken: string,
): Promise<{ session_id: number }> {
  return apiFetch(
    "/stats/voice/start",
    { method: "POST", body: JSON.stringify({ channel_id: channelId, server_id: serverId }) },
    accessToken,
  );
}

export async function endVoiceSession(
  sessionId: number,
  accessToken: string,
): Promise<{ status: string; duration_seconds?: number }> {
  return apiFetch(
    "/stats/voice/end",
    { method: "POST", body: JSON.stringify({ session_id: sessionId }) },
    accessToken,
  );
}

export async function incrementMessageCount(
  channelId: string,
  serverId: string,
  accessToken: string,
): Promise<void> {
  apiFetch(
    "/stats/messages/increment",
    { method: "POST", body: JSON.stringify({ channel_id: channelId, server_id: serverId }) },
    accessToken,
  ).catch(() => {}); // fire-and-forget
}

export async function getMyStats(
  accessToken: string,
  days = 30,
): Promise<UserStats> {
  return apiFetch(`/stats/me?days=${days}`, {}, accessToken);
}

// --- TOTP ---

export interface TOTPSetupResult {
  secret: string;
  qr_code: string;
  provisioning_uri: string;
}

export async function getTOTPStatus(accessToken: string): Promise<{ enabled: boolean }> {
  return apiFetch("/user/totp/status", {}, accessToken);
}

export async function setupTOTP(accessToken: string): Promise<TOTPSetupResult> {
  return apiFetch("/user/totp/setup", { method: "POST" }, accessToken);
}

export async function verifyTOTP(code: string, accessToken: string): Promise<{ status: string }> {
  return apiFetch("/user/totp/verify", { method: "POST", body: JSON.stringify({ code }) }, accessToken);
}

export async function disableTOTP(code: string, accessToken: string): Promise<{ status: string }> {
  return apiFetch("/user/totp/disable", { method: "POST", body: JSON.stringify({ code }) }, accessToken);
}

export async function loginVerifyTOTP(code: string, accessToken: string): Promise<{ status: string }> {
  return apiFetch("/user/totp/login-verify", { method: "POST", body: JSON.stringify({ code }) }, accessToken);
}

export async function getUsersWithTOTP(accessToken: string): Promise<{ user_ids: string[] }> {
  return apiFetch("/user/totp/users-with-totp", {}, accessToken);
}

// --- Channel Locks ---

export async function lockChannel(channelId: number, pin: string, accessToken: string): Promise<{ status: string }> {
  return apiFetch(`/channels/${channelId}/lock`, { method: "POST", body: JSON.stringify({ pin }) }, accessToken);
}

export async function unlockChannel(channelId: number, pin: string, accessToken: string): Promise<{ status: string }> {
  return apiFetch(`/channels/${channelId}/unlock`, { method: "POST", body: JSON.stringify({ pin }) }, accessToken);
}

export async function verifyChannelPin(channelId: number, pin: string, accessToken: string): Promise<{ status: string }> {
  return apiFetch(`/channels/${channelId}/verify-pin`, { method: "POST", body: JSON.stringify({ pin }) }, accessToken);
}

export async function getChannelLockStatus(channelId: number, accessToken: string): Promise<{ locked: boolean; locked_by: string | null; is_owner: boolean }> {
  return apiFetch(`/channels/${channelId}/lock-status`, {}, accessToken);
}

// --- Vote Kick ---

export async function startVoteKick(serverId: string, channelId: string, targetUserId: string, totalEligible: number, accessToken: string): Promise<{ vote_id: number; status: string }> {
  return apiFetch(`/servers/${serverId}/vote-kick`, { method: "POST", body: JSON.stringify({ channel_id: channelId, target_user_id: targetUserId, total_eligible: totalEligible }) }, accessToken);
}

export async function castVoteKick(voteId: number, vote: boolean, accessToken: string): Promise<{ status: string; yes_count: number; no_count: number }> {
  return apiFetch(`/vote-kicks/${voteId}/vote`, { method: "POST", body: JSON.stringify({ vote }) }, accessToken);
}

export async function getActiveVoteKicks(serverId: string, accessToken: string): Promise<{ id: number; channel_id: string; target_user_id: string; initiated_by: string; yes_count: number; no_count: number; total_eligible: number }[]> {
  return apiFetch(`/servers/${serverId}/vote-kicks/active`, {}, accessToken);
}

export async function executeVoteKick(voteId: number, accessToken: string): Promise<{ status: string; kick_count: number; kick_limit?: number; ban_mode?: string; show_harsh_message?: boolean }> {
  return apiFetch(`/vote-kicks/${voteId}/execute`, { method: "POST" }, accessToken);
}

// --- Ban Settings ---

export interface BanSettings {
  kick_limit: number;
  kick_window_minutes: number;
  ban_mode: string;
}

export async function getBanSettings(serverId: string, accessToken: string): Promise<BanSettings> {
  return apiFetch(`/servers/${serverId}/ban-settings`, {}, accessToken);
}

export async function updateBanSettings(serverId: string, settings: Partial<BanSettings>, accessToken: string): Promise<BanSettings> {
  return apiFetch(`/servers/${serverId}/ban-settings`, { method: "PATCH", body: JSON.stringify(settings) }, accessToken);
}

export async function getMyKickCount(serverId: string, accessToken: string): Promise<{ kick_count: number; kick_limit: number; kick_window_minutes: number; ban_mode: string }> {
  return apiFetch(`/servers/${serverId}/my-kicks`, {}, accessToken);
}

// --- Member Permissions ---

export async function updateMemberPermissions(
  serverId: string,
  userId: string,
  permissions: { can_kick?: boolean; can_ban?: boolean },
  accessToken: string,
): Promise<{ status: string }> {
  return apiFetch(
    `/servers/${serverId}/members/${encodeURIComponent(userId)}/permissions`,
    { method: "PATCH", body: JSON.stringify(permissions) },
    accessToken,
  );
}

// --- Instance ---

export interface InstanceInfo {
  name: string;
  require_totp: boolean;
  /** True when OPEN_REGISTRATION env var is enabled on the server. */
  open_registration: boolean;
  /** True on first boot before the admin account has been created. */
  first_boot: boolean;
  /** Domain of this instance, from CONCORD_DOMAIN or CONDUWUIT_SERVER_NAME env. */
  instance_domain?: string;
}

export async function getInstanceInfo(): Promise<InstanceInfo> {
  return apiFetch("/instance");
}

export async function updateInstanceSettings(
  settings: { name?: string; require_totp?: boolean },
  accessToken: string,
): Promise<InstanceInfo> {
  return apiFetch(
    "/admin/instance",
    { method: "PATCH", body: JSON.stringify(settings) },
    accessToken,
  );
}

// --- Admin ---

export async function checkAdmin(
  accessToken: string,
): Promise<{ is_admin: boolean }> {
  return apiFetch("/admin/check", {}, accessToken);
}

export interface AdminStats {
  total_servers: number;
  total_channels: number;
  total_users: number;
  total_invites: number;
  total_soundboard_clips: number;
  total_webhooks: number;
  open_reports: number;
  total_reports: number;
}

export async function getAdminStats(
  accessToken: string,
): Promise<AdminStats> {
  return apiFetch("/admin/stats", {}, accessToken);
}

export interface AdminServer {
  id: string;
  name: string;
  owner_id: string;
  visibility: string;
  created_at: string | null;
  member_count: number;
}

export async function getAdminServers(
  accessToken: string,
): Promise<AdminServer[]> {
  return apiFetch("/admin/servers", {}, accessToken);
}

export interface AdminUser {
  user_id: string;
  server_count: number;
  first_seen: string | null;
  is_admin: boolean;
  has_owner_role: boolean;
}

export async function getAdminUsers(
  accessToken: string,
): Promise<AdminUser[]> {
  return apiFetch("/admin/users", {}, accessToken);
}

export interface AdminBugReport {
  id: number;
  reported_by: string;
  title: string;
  description: string;
  system_info: Record<string, unknown> | null;
  status: string;
  admin_notes: string | null;
  // INS-028: GitHub issue number when the bug report was mirrored.
  // NULL when the server's GITHUB_BUG_REPORT_TOKEN is unset, when
  // the GitHub API call failed (graceful-degradation path), or
  // when the report predates INS-028. The admin UI renders a
  // "View on GitHub" link when this is a number.
  github_issue_number: number | null;
  created_at: string;
  updated_at: string;
}

export async function getAdminReports(
  accessToken: string,
): Promise<AdminBugReport[]> {
  return apiFetch("/admin/reports", {}, accessToken);
}

export async function updateAdminReport(
  reportId: number,
  update: { status?: string; admin_notes?: string },
  accessToken: string,
): Promise<{ status: string }> {
  return apiFetch(
    `/admin/reports/${reportId}`,
    { method: "PATCH", body: JSON.stringify(update) },
    accessToken,
  );
}

// --- Direct Messages ---

export interface DMConversation {
  id: number;
  other_user_id: string;
  matrix_room_id: string;
  created_at: string | null;
}

export interface RoomDiagnosticStep {
  step: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

export interface RoomDiagnostics {
  room_id: string;
  user_id: string;
  binding:
    | {
        kind: "server_channel";
        server_id: string;
        server_name: string;
        channel_id: number;
        channel_name: string;
        channel_type: string;
      }
    | {
        kind: "dm";
        conversation_id: number;
        other_user_id: string;
      }
    | { kind: "unknown" };
  inference: string;
  summary: string;
  steps: RoomDiagnosticStep[];
}

export async function listDMs(
  accessToken: string,
): Promise<DMConversation[]> {
  return apiFetch("/dms", {}, accessToken);
}

export async function createDM(
  targetUserId: string,
  accessToken: string,
): Promise<{ id: number; target_user_id: string; matrix_room_id: string; created: boolean }> {
  return apiFetch(
    "/dms",
    { method: "POST", body: JSON.stringify({ target_user_id: targetUserId }) },
    accessToken,
  );
}

export async function getRoomDiagnostics(
  roomId: string,
  accessToken: string,
): Promise<RoomDiagnostics> {
  return apiFetch(`/rooms/${encodeURIComponent(roomId)}/diagnostics`, {}, accessToken);
}

// --- Federation ---

export interface FederationStatus {
  enabled: boolean;
  server_name: string;
  allowed_servers: string[];
  // Anchored regex patterns (^escaped$) as stored in tuwunel.toml.
  // Exposed so the admin UI can tell the difference between a plain
  // hostname entry and a hand-edited advanced pattern.
  raw_allowed_patterns: string[];
  raw_forbidden_patterns: string[];
  // True when tuwunel.toml has been edited since the last successful apply.
  // Derived from file mtime vs. federation_last_applied_at on the server.
  pending_apply: boolean;
}

export interface FederationUpdateResult {
  allowed_servers: string[];
  raw_allowed_patterns: string[];
  pending_apply: boolean;
  message: string;
}

export interface FederationApplyResult {
  applied: boolean;
  restarted_containers: string[];
  elapsed_seconds: number;
}

export async function getFederationStatus(
  accessToken: string,
): Promise<FederationStatus> {
  return apiFetch("/admin/federation", {}, accessToken);
}

export async function updateFederationAllowlist(
  allowedServers: string[],
  accessToken: string,
): Promise<FederationUpdateResult> {
  return apiFetch(
    "/admin/federation/allowlist",
    { method: "PUT", body: JSON.stringify({ allowed_servers: allowedServers }) },
    accessToken,
  );
}

/**
 * Trigger a restart of the Matrix (conduwuit) container so it picks up
 * the new federation allowlist from tuwunel.toml. Blocks for ~5-15s
 * while the container restarts. Call this only after the admin has
 * confirmed in a modal that downtime is acceptable.
 */
export async function applyFederationChanges(
  accessToken: string,
): Promise<FederationApplyResult> {
  return apiFetch(
    "/admin/federation/apply",
    { method: "POST", body: "{}" },
    accessToken,
  );
}

// --- Service node configuration (INS-023) ---

/**
 * Structural role this Concord instance plays in the mesh. Mirrors the
 * `NodeRole` literal union in `server/services/service_node_config.py`
 * — keep the two in sync or the admin UI will silently drop new
 * roles.
 */
export type ServiceNodeRole = "frontend-only" | "hybrid" | "anchor";

/**
 * Admin-only service-node config response. Contains the full set of
 * resource-contribution knobs — CPU%, bandwidth cap, storage cap —
 * plus the structural role flags. Never fetched without auth; never
 * exposed via the unauthenticated well-known document.
 */
export interface ServiceNodeConfig {
  max_cpu_percent: number;
  max_bandwidth_mbps: number;
  max_storage_gb: number;
  tunnel_anchor_enabled: boolean;
  node_role: ServiceNodeRole;
  /**
   * Hard-coded server-side maxima for sliders / numeric inputs. The
   * server exposes them inline so the admin UI doesn't have to ship
   * its own copy of the module-level constants and fall out of sync.
   */
  limits: {
    max_cpu_percent: number;
    max_bandwidth_mbps: number;
    max_storage_gb: number;
    allowed_roles: ServiceNodeRole[];
  };
}

/**
 * Write-side payload — identical shape minus the server-controlled
 * `limits` block. The server validates every field via Pydantic
 * constraints that mirror the `ServiceNodeConfig.validate()`
 * dataclass on disk.
 */
export interface ServiceNodeConfigUpdate {
  max_cpu_percent: number;
  max_bandwidth_mbps: number;
  max_storage_gb: number;
  tunnel_anchor_enabled: boolean;
  node_role: ServiceNodeRole;
}

/** GET /api/admin/service-node — admin only. */
export async function getServiceNodeConfig(
  accessToken: string,
): Promise<ServiceNodeConfig> {
  return apiFetch("/admin/service-node", {}, accessToken);
}

/** PUT /api/admin/service-node — admin only, full-document replace. */
export async function updateServiceNodeConfig(
  body: ServiceNodeConfigUpdate,
  accessToken: string,
): Promise<ServiceNodeConfig> {
  return apiFetch(
    "/admin/service-node",
    { method: "PUT", body: JSON.stringify(body) },
    accessToken,
  );
}

// --- Explore (federated peers) ---

export interface ExploreServerEntry {
  domain: string;
  name: string;
  description: string | null;
}

/**
 * List the federated peers this instance knows about. Backed by
 * `GET /api/explore/servers`, which derives its list from the
 * federation allowlist. Requires a valid access token — the
 * backend enforces auth via `get_user_id`.
 *
 * Note: `getApiBase()` already returns `/api`, so the path below
 * is relative to that prefix.
 */
export async function listExploreServers(
  accessToken: string,
): Promise<ExploreServerEntry[]> {
  return apiFetch("/explore/servers", {}, accessToken);
}
