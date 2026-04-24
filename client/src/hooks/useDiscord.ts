import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "../stores/auth";
import {
  userDiscordStatus,
  userDiscordGuilds,
  apiFetch,
  type DiscordConnectionStatus,
  type DiscordGuild,
} from "../api/concord";

/** Short-lived cache so opening the same guild twice doesn't refetch. */
interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const GUILD_TTL_MS = 60_000;
const CHANNEL_TTL_MS = 30_000;
const MESSAGE_TTL_MS = 5_000;

/**
 * Reads the caller's Discord OAuth2 connection state + profile. Polls
 * every 5s so an OAuth redirect that completes in a separate tab
 * flips the UI without the user having to refresh.
 */
export function useDiscordStatus() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [status, setStatus] = useState<DiscordConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!accessToken) {
      setStatus(null);
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }
    const tick = async () => {
      try {
        const s = await userDiscordStatus(accessToken);
        if (!mounted.current) return;
        setStatus(s);
      } catch {
        // Silent — the UI already shows loading / disconnected states.
      } finally {
        if (mounted.current) setLoading(false);
      }
    };
    void tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
    };
  }, [accessToken]);

  return { status, loading, connected: status?.connected ?? false };
}

/**
 * Lists the caller's Discord guilds. Fetches once when the hook mounts
 * and whenever the connected status flips from false to true. No
 * periodic poll — guilds change rarely enough that a manual refresh
 * is acceptable.
 */
export function useDiscordGuilds(connected: boolean) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<CacheEntry<DiscordGuild[]> | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken || !connected) {
      setGuilds(null);
      return;
    }
    const cached = cacheRef.current;
    if (cached && Date.now() - cached.fetchedAt < GUILD_TTL_MS) {
      setGuilds(cached.data);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await userDiscordGuilds(accessToken);
      cacheRef.current = { data: resp.guilds, fetchedAt: Date.now() };
      setGuilds(resp.guilds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accessToken, connected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { guilds, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// Channels + messages via the captured-session hybrid path. The server
// transparently falls back to an empty list with `limited_by_discord: true`
// when the bridge session isn't available, so callers here just surface
// that flag to the UI.
// ---------------------------------------------------------------------------

export interface DiscordChannelEntry {
  id: string;
  name: string | null;
  type: number;
  parent_id: string | null;
  position: number | null;
  topic: string | null;
  nsfw: boolean;
}

export interface DiscordChannelsResponse {
  channels: DiscordChannelEntry[];
  limited_by_discord: boolean;
}

export interface DiscordMessageAuthor {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordMessageEntry {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  author: DiscordMessageAuthor;
}

export interface DiscordMessagesResponse {
  messages: DiscordMessageEntry[];
  limited_by_discord: boolean;
}

export function useDiscordChannels(guildId: string | null) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [state, setState] = useState<DiscordChannelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Record<string, CacheEntry<DiscordChannelsResponse>>>({});

  const refresh = useCallback(async () => {
    if (!accessToken || !guildId) {
      setState(null);
      return;
    }
    const cached = cacheRef.current[guildId];
    if (cached && Date.now() - cached.fetchedAt < CHANNEL_TTL_MS) {
      setState(cached.data);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<DiscordChannelsResponse>(
        `/users/me/discord/guilds/${encodeURIComponent(guildId)}/channels`,
        {},
        accessToken,
      );
      cacheRef.current[guildId] = { data, fetchedAt: Date.now() };
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accessToken, guildId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, loading, error, refresh };
}

export function useDiscordMessages(channelId: string | null) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [state, setState] = useState<DiscordMessagesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Record<string, CacheEntry<DiscordMessagesResponse>>>({});

  const refresh = useCallback(async () => {
    if (!accessToken || !channelId) {
      setState(null);
      return;
    }
    const cached = cacheRef.current[channelId];
    if (cached && Date.now() - cached.fetchedAt < MESSAGE_TTL_MS) {
      setState(cached.data);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<DiscordMessagesResponse>(
        `/users/me/discord/channels/${encodeURIComponent(channelId)}/messages`,
        {},
        accessToken,
      );
      cacheRef.current[channelId] = { data, fetchedAt: Date.now() };
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accessToken, channelId]);

  useEffect(() => {
    void refresh();
    // Poll while a channel is active — captured-session-based reads
    // have no gateway push so this is how the chat view stays live.
    // 4s matches the cadence we use for Matrix unreads; slow enough
    // to stay well under Discord's per-channel rate limit.
    const id = channelId ? window.setInterval(refresh, 4000) : null;
    return () => {
      if (id !== null) window.clearInterval(id);
    };
  }, [channelId, refresh]);

  return { state, loading, error, refresh };
}

export async function sendDiscordMessage(
  accessToken: string,
  channelId: string,
  content: string,
): Promise<void> {
  await apiFetch(
    `/users/me/discord/channels/${encodeURIComponent(channelId)}/messages`,
    { method: "POST", body: JSON.stringify({ content }) },
    accessToken,
  );
}
