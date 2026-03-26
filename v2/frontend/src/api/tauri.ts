/* ── Browser mock layer ──────────────────────────────────────
   When running in a browser (npm run dev) without the Tauri shell,
   __TAURI_INTERNALS__ doesn't exist. We provide mock implementations
   so the UI is fully navigable for design iteration.
   ──────────────────────────────────────────────────────────── */

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    console.warn(`[mock] invoke("${cmd}") — not in Tauri shell`);
    return (MOCK_RESPONSES[cmd]?.(args) as T) ?? ({} as T);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

type UnlistenFn = () => void;

async function safeListen<T>(
  event: string,
  callback: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri) {
    console.warn(`[mock] listen("${event}") — not in Tauri shell`);
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => callback(e.payload));
}

/* ── Mock data for browser preview ───────────────────────── */

const MOCK_PEER_ID = "12D3KooW" + "MockNode00000000000000000000000000";

const MOCK_RESPONSES: Record<string, (args?: Record<string, unknown>) => unknown> = {
  get_identity: () => ({ peerId: MOCK_PEER_ID, displayName: "Node-preview" }),
  get_node_status: () => ({ isOnline: true, connectedPeers: 3, peerId: MOCK_PEER_ID }),
  get_nearby_peers: () => [
    { peerId: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", addresses: ["/ip4/192.168.1.10/udp/4001"], displayName: "Alice" },
    { peerId: "12D3KooWPeer2BBBBxxxxxxxxxxxxxx", addresses: ["/ip4/192.168.1.11/udp/4001"], displayName: "Bob" },
    { peerId: "12D3KooWPeer3CCCCxxxxxxxxxxxxxx", addresses: ["/ip4/192.168.1.12/udp/4001"] },
  ],
  get_messages: () => [
    { id: "m1", channelId: "general", senderId: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", content: "hey everyone!", timestamp: Date.now() - 120000 },
    { id: "m2", channelId: "general", senderId: MOCK_PEER_ID, content: "welcome to the mesh", timestamp: Date.now() - 60000 },
    { id: "m3", channelId: "general", senderId: "12D3KooWPeer2BBBBxxxxxxxxxxxxxx", content: "this is pretty cool", timestamp: Date.now() - 30000 },
  ],
  send_message: (args) => ({
    id: "m-" + Date.now(),
    channelId: args?.channelId ?? "general",
    senderId: MOCK_PEER_ID,
    content: args?.content ?? "",
    timestamp: Date.now(),
  }),
  get_servers: () => [
    {
      id: "srv-demo-1", name: "Neural Nexus", ownerId: MOCK_PEER_ID,
      visibility: "public", memberCount: 12, inviteCode: "nexus-42",
      channels: [
        { id: "ch1", serverId: "srv-demo-1", name: "general", channelType: "text" },
        { id: "ch2", serverId: "srv-demo-1", name: "random", channelType: "text" },
        { id: "ch3", serverId: "srv-demo-1", name: "voice-lobby", channelType: "voice" },
      ],
    },
    {
      id: "srv-demo-2", name: "The Ether Vault", ownerId: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx",
      visibility: "private", memberCount: 5, channels: [
        { id: "ch4", serverId: "srv-demo-2", name: "general", channelType: "text" },
        { id: "ch5", serverId: "srv-demo-2", name: "trading", channelType: "text" },
      ],
    },
  ],
  get_server: (args) => ({
    id: args?.serverId ?? "srv-demo-1", name: "Neural Nexus", ownerId: MOCK_PEER_ID,
    visibility: "public", memberCount: 12, inviteCode: "nexus-42",
    channels: [
      { id: "ch1", serverId: args?.serverId ?? "srv-demo-1", name: "general", channelType: "text" },
      { id: "ch2", serverId: args?.serverId ?? "srv-demo-1", name: "random", channelType: "text" },
      { id: "ch3", serverId: args?.serverId ?? "srv-demo-1", name: "voice-lobby", channelType: "voice" },
    ],
  }),
  get_channels: (args) => [
    { id: "ch1", serverId: args?.serverId, name: "general", channelType: "text" },
    { id: "ch2", serverId: args?.serverId, name: "random", channelType: "text" },
    { id: "ch3", serverId: args?.serverId, name: "voice-lobby", channelType: "voice" },
  ],
  create_server: (args) => ({
    id: "srv-" + Date.now(), name: args?.name ?? "New Server", ownerId: MOCK_PEER_ID,
    visibility: args?.visibility ?? "private", memberCount: 1, inviteCode: "inv-" + Math.random().toString(36).slice(2, 10),
    channels: [
      { id: "ch-" + Date.now(), serverId: "srv-" + Date.now(), name: "general", channelType: "text" },
      { id: "ch-" + (Date.now() + 1), serverId: "srv-" + Date.now(), name: "voice-lobby", channelType: "voice" },
    ],
  }),
  join_server: () => ({
    id: "srv-joined", name: "Joined Server", ownerId: "someone",
    visibility: "private", memberCount: 8, channels: [
      { id: "chj1", serverId: "srv-joined", name: "general", channelType: "text" },
    ],
  }),
  create_invite: (args) => ({ code: Math.random().toString(36).slice(2, 10), serverId: args?.serverId }),
  get_server_members: () => [
    { peerId: MOCK_PEER_ID, role: "owner", joinedAt: Date.now() - 86400000 },
    { peerId: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", role: "member", joinedAt: Date.now() - 3600000 },
    { peerId: "12D3KooWPeer2BBBBxxxxxxxxxxxxxx", role: "member", joinedAt: Date.now() - 1800000 },
  ],
  get_tunnels: () => [
    { peerId: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", connectionType: "local", remoteAddress: "/ip4/192.168.1.10/udp/4001/quic-v1", establishedAt: Date.now() - 300000, rttMs: 2 },
    { peerId: "12D3KooWPeer2BBBBxxxxxxxxxxxxxx", connectionType: "direct", remoteAddress: "/ip4/73.42.18.201/udp/4001/quic-v1", establishedAt: Date.now() - 600000, rttMs: 24 },
    { peerId: "12D3KooWPeer3CCCCxxxxxxxxxxxxxx", connectionType: "relayed", remoteAddress: "/p2p-circuit/p2p/12D3KooWRelay.../p2p/...", establishedAt: Date.now() - 120000, rttMs: 85 },
    { peerId: "12D3KooWPeer4DDDDxxxxxxxxxxxxxx", connectionType: "direct", remoteAddress: "/ip4/45.33.32.156/udp/4001/quic-v1", establishedAt: Date.now() - 900000, rttMs: 42 },
  ],
  get_peer_trust: (args) => {
    const pid = (args?.peerId as string) ?? "";
    if (pid === MOCK_PEER_ID) return { peerId: pid, score: 85, attestationCount: 12, badge: "trusted", identityAgeDays: 180 };
    if (pid.includes("Peer1")) return { peerId: pid, score: 62, attestationCount: 5, badge: "established", identityAgeDays: 90 };
    if (pid.includes("Peer2")) return { peerId: pid, score: 35, attestationCount: 2, badge: "recognized", identityAgeDays: 30 };
    return { peerId: pid, score: 10, attestationCount: 0, badge: "unverified", identityAgeDays: 5 };
  },
  get_attestations: () => [
    { attesterId: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", subjectId: MOCK_PEER_ID, sinceTimestamp: Date.now() - 86400000 * 30 },
    { attesterId: "12D3KooWPeer2BBBBxxxxxxxxxxxxxx", subjectId: MOCK_PEER_ID, sinceTimestamp: Date.now() - 86400000 * 14 },
  ],
  attest_peer: () => undefined,
  get_dm_history: () => [
    { id: "dm1", fromPeer: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", toPeer: MOCK_PEER_ID, content: "Hey, are you online?", timestamp: Date.now() - 300000 },
    { id: "dm2", fromPeer: MOCK_PEER_ID, toPeer: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", content: "Yeah, just connected to the mesh!", timestamp: Date.now() - 240000 },
    { id: "dm3", fromPeer: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", toPeer: MOCK_PEER_ID, content: "Nice. Want to join the Neural Nexus server?", timestamp: Date.now() - 180000 },
    { id: "dm4", fromPeer: MOCK_PEER_ID, toPeer: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", content: "Sure, send me an invite!", timestamp: Date.now() - 120000 },
  ],
  send_dm: (args) => ({
    id: "dm-" + Date.now(),
    fromPeer: MOCK_PEER_ID,
    toPeer: args?.peerId ?? "",
    content: args?.content ?? "",
    timestamp: Date.now(),
  }),
  initiate_dm_session: () => undefined,
  setup_totp: () => ({ secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/Concord:Node-preview?secret=JBSWY3DPEHPK3PXP&issuer=Concord" }),
  verify_totp: () => true,
  enable_totp: () => undefined,
  disable_totp: () => undefined,
  is_totp_enabled: () => false,
  dial_peer: () => undefined,
  bootstrap_dht: () => undefined,
  subscribe_channel: () => undefined,
  leave_server: () => undefined,
  join_voice: (args) => ({
    isInVoice: true,
    channelId: args?.channelId ?? "voice-lobby",
    serverId: args?.serverId ?? "srv-demo-1",
    isMuted: false,
    isDeafened: false,
    participants: [
      { peerId: MOCK_PEER_ID, isMuted: false, isSpeaking: false },
      { peerId: "12D3KooWPeer1AAAAxxxxxxxxxxxxxx", isMuted: false, isSpeaking: true },
    ],
  }),
  leave_voice: () => undefined,
  toggle_mute: () => true,
  toggle_deafen: () => false,
  get_voice_state: () => ({
    isInVoice: false, channelId: null, serverId: null,
    isMuted: false, isDeafened: false, participants: [],
  }),
  get_system_health: () => {
    const jitter = (base: number, range: number) =>
      +(base + (Math.random() - 0.5) * range).toFixed(1);

    const bandwidthIn: number[] = [];
    const bandwidthOut: number[] = [];
    for (let i = 0; i < 14; i++) {
      bandwidthIn.push(Math.round(300 + Math.random() * 500));
      bandwidthOut.push(Math.round(200 + Math.random() * 600));
    }

    const events: { timestamp: string; level: string; message: string }[] = [
      { timestamp: "14:22:01", level: "OK", message: "Protocol handshake successful: peer_id=8x2f1..." },
      { timestamp: "14:21:44", level: "INFO", message: "Updating local ledger shards (delta 0.04s)" },
      { timestamp: "14:21:30", level: "OK", message: "Broadcasted 14 encrypted packets to swarm" },
      { timestamp: "14:20:55", level: "WARN", message: "Latency spike detected in Frankfurt relay node" },
      { timestamp: "14:20:12", level: "OK", message: "Heartbeat signal acknowledged by gateway" },
      { timestamp: "14:19:40", level: "INFO", message: "DHT route table optimized (7 new nodes added)" },
      { timestamp: "14:18:55", level: "OK", message: "TLS certificate rotation completed" },
      { timestamp: "14:18:10", level: "INFO", message: "Peer discovery sweep complete (3 new peers)" },
    ];

    return {
      stabilityIndex: jitter(99.4, 0.6),
      bandwidthIn,
      bandwidthOut,
      latencyMs: Math.round(jitter(24, 10)),
      activePeers: Math.round(jitter(1402, 50)),
      cpuPercent: jitter(12.4, 5),
      ramUsedGb: jitter(4.2, 0.6),
      ramTotalGb: 16,
      diskIoMbps: jitter(0.8, 0.4),
      uptime: "342d 12h",
      encryptedTrafficTb: jitter(4.2, 0.1),
      reputation: "A++",
      events,
    };
  },
  start_webhost: () => ({
    url: "http://192.168.1.152:8080",
    pin: "482917",
    port: 8080,
    activeGuests: 0,
  }),
  stop_webhost: () => undefined,
  get_webhost_status: () => null,
};

/* ── Trust Types ─────────────────────────────────────────────── */

export type TrustLevel =
  | "unverified"
  | "recognized"
  | "established"
  | "trusted"
  | "backbone";

export interface TrustInfo {
  peerId: string;
  score: number;
  attestationCount: number;
  badge: TrustLevel;
  identityAgeDays: number;
}

export interface Attestation {
  attesterId: string;
  subjectId: string;
  sinceTimestamp: number;
}

/* ── DM Types ───────────────────────────────────────────────── */

export interface DmMessage {
  id: string;
  fromPeer: string;
  toPeer: string;
  content: string;
  timestamp: number;
}

/* ── TOTP Types ─────────────────────────────────────────────── */

export interface TotpSetup {
  secret: string;
  uri: string;
}

/* ── Tunnel Types ────────────────────────────────────────────── */

export interface TunnelInfo {
  peerId: string;
  connectionType: "direct" | "relayed" | "local";
  remoteAddress: string;
  establishedAt: number;
  rttMs: number | null;
}

/* ── Voice Types ─────────────────────────────────────────────── */

export interface VoiceState {
  isInVoice: boolean;
  channelId: string | null;
  serverId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  participants: VoiceParticipant[];
}

export interface VoiceParticipant {
  peerId: string;
  isMuted: boolean;
  isSpeaking: boolean;
}

/* ── Types ───────────────────────────────────────────────────── */

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  content: string;
  timestamp: number;
}

export interface PeerInfo {
  peerId: string;
  addresses: string[];
  displayName?: string;
}

export interface NodeStatus {
  isOnline: boolean;
  connectedPeers: number;
  peerId: string;
}

export interface Identity {
  peerId: string;
  displayName: string;
}

export interface ChannelPayload {
  id: string;
  serverId: string;
  name: string;
  channelType: "text" | "voice" | "video";
}

export interface ServerPayload {
  id: string;
  name: string;
  ownerId: string;
  visibility: "public" | "private" | "federated";
  channels: ChannelPayload[];
  memberCount: number;
  inviteCode?: string;
}

export interface InvitePayload {
  code: string;
  serverId: string;
}

export interface MemberPayload {
  peerId: string;
  role: string;
  joinedAt: number;
}

/* ── Tauri Command Wrappers ───────────────────────────────────── */

export async function getIdentity(): Promise<Identity> {
  return safeInvoke<Identity>("get_identity");
}

export async function sendMessage(
  channelId: string,
  content: string,
  serverId?: string,
): Promise<Message> {
  return safeInvoke<Message>("send_message", { channelId, content, serverId });
}

export async function getMessages(
  channelId: string,
  limit?: number,
  before?: string,
): Promise<Message[]> {
  return safeInvoke<Message[]>("get_messages", { channelId, limit, before });
}

export async function getNearbyPeers(): Promise<PeerInfo[]> {
  return safeInvoke<PeerInfo[]>("get_nearby_peers");
}

export async function getNodeStatus(): Promise<NodeStatus> {
  return safeInvoke<NodeStatus>("get_node_status");
}

export async function subscribeChannel(topic: string): Promise<void> {
  return safeInvoke<void>("subscribe_channel", { topic });
}

/* ── Server Management ──────────────────────────────────────── */

export async function createServer(
  name: string,
  visibility: "public" | "private" | "federated",
  channels?: { name: string; channelType: string }[],
): Promise<ServerPayload> {
  return safeInvoke<ServerPayload>("create_server", { name, visibility, channels });
}

export async function getServers(): Promise<ServerPayload[]> {
  return safeInvoke<ServerPayload[]>("get_servers");
}

export async function getServer(serverId: string): Promise<ServerPayload> {
  return safeInvoke<ServerPayload>("get_server", { serverId });
}

export async function getChannels(serverId: string): Promise<ChannelPayload[]> {
  return safeInvoke<ChannelPayload[]>("get_channels", { serverId });
}

export async function joinServer(inviteCode: string): Promise<ServerPayload> {
  return safeInvoke<ServerPayload>("join_server", { inviteCode });
}

export async function createInvite(serverId: string): Promise<InvitePayload> {
  return safeInvoke<InvitePayload>("create_invite", { serverId });
}

export async function leaveServer(serverId: string): Promise<void> {
  return safeInvoke<void>("leave_server", { serverId });
}

export async function getServerMembers(
  serverId: string,
): Promise<MemberPayload[]> {
  return safeInvoke<MemberPayload[]>("get_server_members", { serverId });
}

/* ── Voice Commands ──────────────────────────────────────────── */

export async function joinVoice(
  serverId: string,
  channelId: string,
): Promise<VoiceState> {
  return safeInvoke<VoiceState>("join_voice", { serverId, channelId });
}

export async function leaveVoice(): Promise<void> {
  return safeInvoke<void>("leave_voice");
}

export async function toggleMute(): Promise<boolean> {
  return safeInvoke<boolean>("toggle_mute");
}

export async function toggleDeafen(): Promise<boolean> {
  return safeInvoke<boolean>("toggle_deafen");
}

export async function getVoiceState(): Promise<VoiceState> {
  return safeInvoke<VoiceState>("get_voice_state");
}

/* ── Tunnel Commands ──────────────────────────────────────────── */

export async function getTunnels(): Promise<TunnelInfo[]> {
  return safeInvoke<TunnelInfo[]>("get_tunnels");
}

export async function dialPeer(peerId: string, address: string): Promise<void> {
  return safeInvoke<void>("dial_peer", { peerId, address });
}

export async function bootstrapDht(): Promise<void> {
  return safeInvoke<void>("bootstrap_dht");
}

/* ── Trust Commands ───────────────────────────────────────────── */

export async function getPeerTrust(peerId: string): Promise<TrustInfo> {
  return safeInvoke<TrustInfo>("get_peer_trust", { peerId });
}

export async function attestPeer(peerId: string): Promise<void> {
  return safeInvoke<void>("attest_peer", { peerId });
}

export async function getAttestations(peerId: string): Promise<Attestation[]> {
  return safeInvoke<Attestation[]>("get_attestations", { peerId });
}

/* ── DM Commands ─────────────────────────────────────────────── */

export async function sendDm(
  peerId: string,
  content: string,
): Promise<DmMessage> {
  return safeInvoke<DmMessage>("send_dm", { peerId, content });
}

export async function getDmHistory(
  peerId: string,
  limit?: number,
): Promise<DmMessage[]> {
  return safeInvoke<DmMessage[]>("get_dm_history", { peerId, limit });
}

export async function initiateDmSession(peerId: string): Promise<void> {
  return safeInvoke<void>("initiate_dm_session", { peerId });
}

/* ── TOTP Commands ───────────────────────────────────────────── */

export async function setupTotp(): Promise<TotpSetup> {
  return safeInvoke<TotpSetup>("setup_totp");
}

export async function verifyTotp(code: string): Promise<boolean> {
  return safeInvoke<boolean>("verify_totp", { code });
}

export async function enableTotp(code: string): Promise<void> {
  return safeInvoke<void>("enable_totp", { code });
}

export async function disableTotp(code: string): Promise<void> {
  return safeInvoke<void>("disable_totp", { code });
}

export async function isTotpEnabled(): Promise<boolean> {
  return safeInvoke<boolean>("is_totp_enabled");
}

/* ── System Health Types ─────────────────────────────────────── */

export interface HealthEvent {
  timestamp: string;
  level: "OK" | "INFO" | "WARN";
  message: string;
}

export interface SystemHealth {
  stabilityIndex: number;
  bandwidthIn: number[];
  bandwidthOut: number[];
  latencyMs: number;
  activePeers: number;
  cpuPercent: number;
  ramUsedGb: number;
  ramTotalGb: number;
  diskIoMbps: number;
  uptime: string;
  encryptedTrafficTb: number;
  reputation: string;
  events: HealthEvent[];
}

/* ── Webhost Types ───────────────────────────────────────────── */

export interface WebhostInfo {
  url: string;
  pin: string;
  port: number;
  activeGuests: number;
}

/* ── Webhost Commands ────────────────────────────────────────── */

export async function startWebhost(port?: number): Promise<WebhostInfo> {
  return safeInvoke<WebhostInfo>("start_webhost", { port });
}

export async function stopWebhost(): Promise<void> {
  return safeInvoke<void>("stop_webhost");
}

export async function getWebhostStatus(): Promise<WebhostInfo | null> {
  return safeInvoke<WebhostInfo | null>("get_webhost_status");
}

/* ── System Health Commands ──────────────────────────────────── */

export async function getSystemHealth(): Promise<SystemHealth> {
  return safeInvoke<SystemHealth>("get_system_health");
}

/* ── Event Listener ───────────────────────────────────────────── */

export function onEvent<T>(
  event: string,
  callback: (payload: T) => void,
): Promise<UnlistenFn> {
  return safeListen<T>(event, callback);
}
