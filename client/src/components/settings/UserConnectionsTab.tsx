import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "../../stores/auth";
import { useSettingsStore } from "../../stores/settings";
import { useSourcesStore } from "../../stores/sources";
import {
  userDiscordOAuthConfig,
  userDiscordStatus,
  userDiscordOAuthStart,
  userDiscordOAuthRevoke,
  type DiscordConnectionStatus,
  type DiscordOAuthUserConfig,
} from "../../api/concord";
import { SourceBrandIcon } from "../sources/sourceBrand";
import { DiscordBrowser } from "../discord/DiscordBrowser";

/**
 * Per-user Connections tab.
 *
 * Architecture (post v0.5.0):
 *   - Discord is the flagship per-user OAuth2 integration. User clicks
 *     "Sign in with Discord", we POST /oauth/start, navigate the browser
 *     to Discord's authorize URL, Discord redirects back to our
 *     callback, and the server stores the access + refresh tokens.
 *   - The admin-managed mautrix-discord bridge is a SEPARATE thing —
 *     its configuration lives under the Admin surface now, not here.
 *   - Other platforms (Concord / Matrix / Mozilla) still deep-link to
 *     the AddSource modal via requestAddSource.
 *   - Slack / Reticulum remain placeholder tiles until their flows ship.
 *
 * Each connection is personal to the caller; admins have no path to
 * manage anyone else's Discord login.
 */
export function UserConnectionsTab() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const requestAddSource = useSettingsStore((s) => s.requestAddSource);
  const sources = useSourcesStore((s) => s.sources);

  const [status, setStatus] = useState<DiscordConnectionStatus | null>(null);
  const [oauthCfg, setOauthCfg] = useState<DiscordOAuthUserConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [s, cfg] = await Promise.all([
        userDiscordStatus(accessToken),
        userDiscordOAuthConfig(accessToken),
      ]);
      if (!mountedRef.current) return;
      setStatus(s);
      setOauthCfg(cfg);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [accessToken]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    // Poll so that after the user completes the Discord redirect the
    // status flips from "not connected" to "connected" without a manual
    // refresh. 5s matches the cadence we used for the retired bridge
    // flow — slow enough to not hammer the API, fast enough to feel
    // instant after the redirect lands.
    const interval = window.setInterval(refresh, 5000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  // Surface an error param that may be appended to the URL after a
  // failed OAuth redirect (see /oauth/callback). One-shot read + URL
  // scrub so refreshes don't keep showing a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("discord_oauth_error");
    const msg = params.get("message");
    if (err) {
      setError(msg ? `${err}: ${msg}` : err);
      params.delete("discord_oauth_error");
      params.delete("message");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      );
    }
  }, []);

  const handleConnect = useCallback(async () => {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      const { authorize_url } = await userDiscordOAuthStart(
        { return_to: window.location.pathname + window.location.search },
        accessToken,
      );
      // Full-page redirect — Discord's consent screen is outside our
      // origin and must own the browser until the callback fires.
      window.location.href = authorize_url;
    } catch (err) {
      if (!mountedRef.current) return;
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [accessToken]);

  const handleDisconnect = useCallback(async () => {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      await userDiscordOAuthRevoke(accessToken);
      await refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [accessToken, refresh]);

  if (!accessToken) {
    return (
      <div className="space-y-4" data-testid="user-connections-tab">
        <h3 className="text-xl font-semibold text-on-surface">Connections</h3>
        <p className="text-sm text-on-surface-variant">
          Sign in to manage your connected accounts.
        </p>
      </div>
    );
  }

  const discordConnected = status?.connected ?? false;
  const discordProfile = status?.user;
  const oauthReady = oauthCfg?.enabled ?? false;

  const concordCount = sources.filter((s) => s.platform === "concord").length;
  const matrixCount = sources.filter((s) => s.platform === "matrix").length;

  return (
    <div className="space-y-6" data-testid="user-connections-tab">
      <div>
        <h3 className="text-xl font-semibold text-on-surface">Connections</h3>
        <p className="text-sm text-on-surface-variant mt-1">
          Link external accounts and instances to Concord. Each connection
          is personal to you — other users and admins can't see or act on
          your connections.
        </p>
      </div>

      <ConnectionCard
        brand="concord"
        title="Concord Instance"
        subtitle="Connect to another Concord domain with an invite token"
        action={concordCount === 0 ? "Connect" : "Add another"}
        onAction={() => requestAddSource("concord")}
        count={concordCount}
      />

      <ConnectionCard
        brand="matrix"
        title="matrix.org"
        subtitle="Discover public rooms with Matrix login flows"
        action={matrixCount === 0 ? "Connect" : "Add another"}
        onAction={() => requestAddSource("matrix.org")}
      />
      <ConnectionCard
        brand="mozilla"
        title="Mozilla"
        subtitle="Use Mozilla's delegated Matrix login"
        action="Connect"
        onAction={() => requestAddSource("chat.mozilla.org")}
      />
      <ConnectionCard
        brand="matrix"
        title="Custom Matrix Homeserver"
        subtitle="Enter any Matrix domain manually"
        action="Connect"
        onAction={() => requestAddSource("matrix")}
        count={matrixCount > 0 ? matrixCount : undefined}
      />

      {/* ── Discord (OAuth2) ─────────────────────────────────────── */}
      <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
          <div className="w-8 h-8 rounded-lg bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
            <SourceBrandIcon brand="discord" size={24} className="text-[#5865F2]" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-on-surface">Discord</h4>
            <p className="text-xs text-on-surface-variant">
              Sign in with Discord via OAuth. Your servers appear as
              Discord-scoped sources in the sidebar.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {status === null || oauthCfg === null ? (
              <span className="text-xs text-on-surface-variant/50">Loading…</span>
            ) : !oauthReady ? (
              <span className="text-xs text-on-surface-variant/70">Not configured</span>
            ) : discordConnected ? (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-green-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Connected
                </span>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={busy}
                  data-testid="user-discord-disconnect-btn"
                  className="px-3 py-1.5 bg-error/10 hover:bg-error/15 text-error text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px]"
                >
                  {busy ? "…" : "Disconnect"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={busy}
                data-testid="user-discord-connect-btn"
                className="px-3 py-1.5 bg-[#5865F2]/15 hover:bg-[#5865F2]/25 text-[#5865F2] text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px] font-medium"
              >
                {busy ? "…" : "Sign in with Discord"}
              </button>
            )}
          </div>
        </div>

        {!oauthReady && status !== null && oauthCfg !== null && (
          <div className="px-4 py-2 bg-surface-container/50 border-t border-outline-variant/10">
            <p className="text-xs text-on-surface-variant">
              Discord OAuth isn't configured yet. An admin needs to register
              a Discord app and set the Client ID + Secret under
              Admin&nbsp;→&nbsp;Integrations&nbsp;→&nbsp;Discord OAuth.
            </p>
          </div>
        )}

        {error && (
          <div className="px-4 py-2 bg-error/10 border-t border-error/20">
            <p className="text-xs text-error" data-testid="user-discord-error">
              {error}
            </p>
          </div>
        )}

        {discordConnected && discordProfile && (
          <div className="px-4 py-3 border-t border-outline-variant/10 bg-surface-container-lowest/40 flex items-center gap-3">
            {discordProfile.avatar && (
              <img
                src={`https://cdn.discordapp.com/avatars/${discordProfile.id}/${discordProfile.avatar}.png?size=64`}
                alt=""
                className="w-8 h-8 rounded-full"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs text-on-surface-variant">
                Signed in as{" "}
                <strong className="text-on-surface">
                  {discordProfile.global_name || discordProfile.username}
                </strong>
                {" "}
                <code className="bg-surface-container-highest px-1 py-0.5 rounded text-[11px]">
                  @{discordProfile.username}
                </code>
                . Disconnect revokes the token on Discord's side and clears
                your session here.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setBrowserOpen(true)}
              className="flex-shrink-0 px-3 py-1.5 text-xs rounded-md bg-[#5865F2] hover:bg-[#5865F2]/90 text-white transition-colors font-medium"
            >
              Browse servers
            </button>
          </div>
        )}
      </div>

      {browserOpen && <DiscordBrowser onClose={() => setBrowserOpen(false)} />}

      <ConnectionCard
        brand="slack"
        title="Slack"
        subtitle="Preloaded release target"
        action="Soon"
        disabled
      />
      <ConnectionCard
        brand="reticulum"
        title="Reticulum"
        subtitle="Preloaded release target"
        action="Soon"
        disabled
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Presentation helper: a uniform card for each connection platform.
// Keeps the Discord card inline in the parent so it can own its busy
// / error / status-message state; this helper is for the simpler
// "deep-link to Add Source" tiles.
// ─────────────────────────────────────────────────────────────────────

function ConnectionCard({
  brand,
  title,
  subtitle,
  action,
  onAction,
  disabled,
  count,
}: {
  brand: "concord" | "matrix" | "mozilla" | "discord" | "slack" | "reticulum";
  title: string;
  subtitle: string;
  action: string;
  onAction?: () => void;
  disabled?: boolean;
  count?: number;
}) {
  const brandedIcon =
    brand === "concord" || brand === "matrix" || brand === "mozilla" || brand === "discord"
      ? <SourceBrandIcon brand={brand} size={24} />
      : <span className="material-symbols-outlined text-on-surface-variant">
          {brand === "slack" ? "forum" : "sensors"}
        </span>;

  return (
    <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
        <div className="w-8 h-8 rounded-lg bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
          {brandedIcon}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-on-surface">
            {title}
            {count !== undefined && count > 0 && (
              <span className="ml-2 text-xs text-on-surface-variant">
                · {count} connected
              </span>
            )}
          </h4>
          <p className="text-xs text-on-surface-variant">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          data-testid={`connection-action-${brand}`}
          className={
            disabled
              ? "px-3 py-1.5 bg-surface-container/40 text-on-surface-variant/60 text-xs rounded-md min-h-[32px] cursor-not-allowed"
              : "px-3 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors min-h-[32px]"
          }
        >
          {action}
        </button>
      </div>
    </div>
  );
}
