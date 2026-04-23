import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "../../stores/auth";
import { useSettingsStore } from "../../stores/settings";
import { useSourcesStore } from "../../stores/sources";
import {
  userDiscordStatus,
  userDiscordLogin,
  userDiscordLogout,
  type UserDiscordStatus,
} from "../../api/bridges";
import { DiscordTosModal } from "./DiscordTosModal";
import { SourceBrandIcon } from "../sources/sourceBrand";

/**
 * Per-user Connections tab (PR3/5 of the user-scoped bridge redesign,
 * expanded to cover all source types in the Sources menu).
 *
 * Lives under the user's own profile settings — NOT the admin section.
 * Any authenticated user can manage their own connections here; admins
 * have no "manage someone else's connection" path.
 *
 * Available connection types mirror the Add-Source modal in ChatLayout:
 *   - Concord instance (custom hostname + invite token)
 *   - matrix.org (preset Matrix homeserver)
 *   - chat.mozilla.org (preset, delegated SSO)
 *   - Custom Matrix homeserver
 *   - Discord (bot-free, user-owned login via bridge)
 *   - Slack, Reticulum (placeholders — "Soon")
 *
 * Non-Discord entries hand off to the existing AddSourceModal in
 * ChatLayout via the settings store's `requestAddSource` action —
 * clicking closes the settings panel and opens the modal pre-targeted
 * to the chosen screen.
 *
 * Discord is handled inline because it's the flagship case of the
 * user-scoped redesign: one click, ToS gate on first use, inline
 * status + disconnect, no deep-link into a separate modal.
 */
export function UserConnectionsTab() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const requestAddSource = useSettingsStore((s) => s.requestAddSource);
  const sources = useSourcesStore((s) => s.sources);

  const [status, setStatus] = useState<UserDiscordStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTos, setShowTos] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [pendingConnect, setPendingConnect] = useState(false);
  const [lastLoginRoomId, setLastLoginRoomId] = useState<string | null>(null);
  const [lastStatusMsg, setLastStatusMsg] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("concord_settings");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.state?.discord_bridge_tos_accepted_at) {
          setTosAccepted(true);
        }
      }
    } catch {
      // Fresh device — nothing to restore.
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    try {
      const s = await userDiscordStatus(accessToken);
      if (!mountedRef.current) return;
      setStatus(s);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [accessToken]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const runDiscordLogin = useCallback(async () => {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    setLastStatusMsg(null);
    try {
      const result = await userDiscordLogin(accessToken);
      if (!mountedRef.current) return;
      setLastLoginRoomId(result.room_id);
      setLastStatusMsg(result.message);
      window.setTimeout(refresh, 500);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [accessToken, refresh]);

  const handleTosClosed = useCallback(() => {
    setShowTos(false);
    try {
      const raw = localStorage.getItem("concord_settings");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.state?.discord_bridge_tos_accepted_at) {
          setTosAccepted(true);
          if (pendingConnect) {
            setPendingConnect(false);
            window.setTimeout(() => { void runDiscordLogin(); }, 0);
          }
        } else {
          setPendingConnect(false);
        }
      }
    } catch {
      setPendingConnect(false);
    }
  }, [pendingConnect, runDiscordLogin]);

  const handleDiscordConnect = useCallback(() => {
    if (!accessToken) return;
    if (!tosAccepted) {
      setPendingConnect(true);
      setShowTos(true);
      return;
    }
    void runDiscordLogin();
  }, [accessToken, tosAccepted, runDiscordLogin]);

  const handleDiscordDisconnect = useCallback(async () => {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      await userDiscordLogout(accessToken);
      if (!mountedRef.current) return;
      setLastLoginRoomId(null);
      setLastStatusMsg("Disconnected.");
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

  // Count how many of each platform the user has already added via the
  // Sources flow, so we can show "Add another" instead of "Connect" when
  // they have ≥1.
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

      {/* ── Concord instance ──────────────────────────────────────── */}
      <ConnectionCard
        brand="concord"
        title="Concord Instance"
        subtitle="Connect to another Concord domain with an invite token"
        action={concordCount === 0 ? "Connect" : "Add another"}
        onAction={() => requestAddSource("concord")}
        count={concordCount}
      />

      {/* ── Matrix presets + custom ───────────────────────────────── */}
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

      {/* ── Discord (inline, handled by this tab) ─────────────────── */}
      <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
          <div className="w-8 h-8 rounded-lg bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
            <SourceBrandIcon brand="discord" size={24} className="text-[#5865F2]" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-on-surface">Discord</h4>
            <p className="text-xs text-on-surface-variant">
              Connect your personal Discord account. Your guilds appear as
              Concord rooms scoped to you.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {status === null ? (
              <span className="text-xs text-on-surface-variant/50">Loading…</span>
            ) : discordConnected ? (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-green-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Connected
                </span>
                <button
                  type="button"
                  onClick={handleDiscordDisconnect}
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
                onClick={handleDiscordConnect}
                disabled={busy}
                data-testid="user-discord-connect-btn"
                className="px-3 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px]"
              >
                {busy ? "…" : "Connect"}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 bg-error/10 border-t border-error/20">
            <p className="text-xs text-error" data-testid="user-discord-error">
              {error}
            </p>
          </div>
        )}

        {lastStatusMsg && !error && (
          <div className="px-4 py-2 bg-primary/5 border-t border-primary/10">
            <p className="text-xs text-on-surface" data-testid="user-discord-msg">
              {lastStatusMsg}
            </p>
          </div>
        )}

        {lastLoginRoomId && !discordConnected && (
          <div className="px-4 py-3 border-t border-outline-variant/10 bg-primary/5">
            <p className="text-xs text-on-surface">
              Login triggered. Open your DM with <code
                className="bg-surface-container-highest px-1 py-0.5 rounded"
              >@discordbot</code> in Concord to scan the QR code with your
              Discord phone app. This page will update automatically once
              the handshake completes.
            </p>
          </div>
        )}

        {discordConnected && (
          <div className="px-4 py-3 border-t border-outline-variant/10 bg-surface-container-lowest/40">
            <p className="text-xs text-on-surface-variant">
              Signed in as{" "}
              <code className="bg-surface-container-highest px-1 py-0.5 rounded">
                {status?.mxid}
              </code>
              . Disconnect to revoke access and purge your session from the
              bridge.
            </p>
          </div>
        )}
      </div>

      {/* ── Placeholders for future platforms ─────────────────────── */}
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

      {showTos && <DiscordTosModal onClose={handleTosClosed} />}
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
  // Only a subset of brands has a dedicated SourceBrandIcon. For the
  // placeholder platforms (slack / reticulum) fall back to a generic
  // material icon, matching the AddSourceModal's "Soon" tile treatment.
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
