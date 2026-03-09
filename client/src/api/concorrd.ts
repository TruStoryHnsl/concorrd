const API_BASE = "/api";

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
  channels: Channel[];
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

  const resp = await fetch(`${API_BASE}${path}`, {
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
  options?: { permanent?: boolean; expires_in_hours?: number; max_uses?: number },
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

export async function validateInvite(token: string): Promise<InviteValidation> {
  return apiFetch(`/invites/validate/${token}`);
}

export async function revokeInvite(
  inviteId: number,
  accessToken: string,
): Promise<void> {
  await apiFetch(`/invites/${inviteId}`, { method: "DELETE" }, accessToken);
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

  const resp = await fetch(`${API_BASE}/soundboard/${serverId}`, {
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

export async function joinServer(
  serverId: string,
  accessToken: string,
): Promise<void> {
  await apiFetch(`/servers/${serverId}/join`, { method: "POST" }, accessToken);
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
  settings: { name?: string; visibility?: string; abbreviation?: string | null },
  accessToken: string,
): Promise<{ id: string; name: string; visibility: string; abbreviation: string | null }> {
  return apiFetch(
    `/servers/${serverId}/settings`,
    { method: "PATCH", body: JSON.stringify(settings) },
    accessToken,
  );
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

// --- Instance ---

export async function getInstanceInfo(): Promise<{ name: string }> {
  return apiFetch("/instance");
}

export async function updateInstanceName(
  name: string,
  accessToken: string,
): Promise<{ name: string }> {
  return apiFetch(
    "/admin/instance",
    { method: "PATCH", body: JSON.stringify({ name }) },
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
