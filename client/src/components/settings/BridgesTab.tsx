import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../../api/servitude";
import { useAuthStore } from "../../stores/auth";
import {
  discordBridgeSetBotToken,
  discordBridgeDisable,
  discordBridgeStatus,
  discordBridgeEnableAndStart,
  discordBridgeListGuilds,
  discordBridgeGuild,
  discordBridgeUnbridgeGuild,
  discordBridgeHttpStatus,
  discordBridgeHttpEnable,
  discordBridgeHttpDisable,
  discordBridgeHttpGetBotProfile,
  discordBridgeHttpUpdateBotProfile,
  discordBridgeHttpRotate,
  discordBridgeHttpSaveBotToken,
  discordVoiceBridgeHttpDeleteRoom,
  discordVoiceBridgeHttpListRooms,
  discordVoiceBridgeHttpRestart,
  discordVoiceBridgeHttpStart,
  discordVoiceBridgeHttpStop,
  discordVoiceBridgeHttpUpsertRoom,
  type BridgeStatus,
  type DiscordVoiceBridgeRoom,
  type DiscordBotProfile,
  type DiscordGuild,
  type HttpBridgeStatus,
  type HttpBridgeMutationResponse,
} from "../../api/bridges";
import { useServerStore } from "../../stores/server";
import { DiscordTosModal } from "./DiscordTosModal";

/**
 * Settings tab for configuring Discord bridge integration.
 *
 * INS-024 Wave 4: bot-mode walkthrough + Wave 4b: user-mode with ToS.
 *
 * The tab guides the user through:
 *   1. Creating a Discord application + bot
 *   2. Enabling required intents (Server Members, Message Content)
 *   3. Pasting the bot token
 *   4. Generating the OAuth2 invite URL
 *   5. Enabling the bridge toggle
 *
 * User-mode (puppeting) is gated behind a ToS warning modal.
 */

const POLL_INTERVAL_MS = 5000;
const EMPTY_VOICE_CHANNELS: { id: number; name: string }[] = [];

type SetupStep = 1 | 2 | 3 | 4 | 5;

export function BridgesTab() {
  const native = isTauri();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<SetupStep>(1);
  const [tokenInput, setTokenInput] = useState("");
  const [showTosModal, setShowTosModal] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await discordBridgeStatus();
      if (!mountedRef.current) return;
      setStatus(s);
      // Auto-advance step based on current state.
      if (s.has_bot_token && step < 4) {
        setStep(4);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [step]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    if (!native) return () => { mountedRef.current = false; };
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [native, refresh]);

  const handleSetToken = useCallback(async () => {
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await discordBridgeSetBotToken(tokenInput.trim());
      setTokenInput("");
      setStep(4);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [tokenInput, refresh]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // One-click flow: downloads binary if needed, checks bwrap,
      // enables the transport, and restarts servitude.
      await discordBridgeEnableAndStart();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleDisable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await discordBridgeDisable();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const bridgeEnabled = status?.bridge_enabled ?? false;
  const hasBotToken = status?.has_bot_token ?? false;
  const isDegraded = status?.degraded_transports?.discord_bridge != null;

  return (
    <div className="space-y-6" data-testid="bridges-tab">
      <div>
        <h3 className="text-xl font-semibold text-on-surface">Bridges</h3>
        <p className="text-sm text-on-surface-variant mt-1">
          Connect external platforms to your Concord server. Messages are
          relayed bidirectionally between bridged channels.
        </p>
      </div>

      {/* Web/Docker bridge management — shown when not in native app */}
      {!native && accessToken && (
        <DockerBridgeSection accessToken={accessToken} />
      )}

      {/* Discord Bridge Section — native only */}
      {native && <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
          <span className="text-xl">🎮</span>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-on-surface">Discord Bridge</h4>
            <p className="text-xs text-on-surface-variant">
              Bridge Discord guilds into Concord rooms via mautrix-discord
            </p>
          </div>
          {native && (
            <div className="flex items-center gap-2 shrink-0">
              {bridgeEnabled ? (
                <button
                  type="button"
                  onClick={handleDisable}
                  disabled={busy}
                  data-testid="bridge-disable-btn"
                  className="px-3 py-1.5 bg-error/10 hover:bg-error/15 text-error text-xs rounded-md transition-colors disabled:opacity-40 min-h-[36px]"
                >
                  Disable
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleEnable}
                  disabled={busy || !hasBotToken}
                  data-testid="bridge-enable-btn"
                  className="px-3 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40 min-h-[36px]"
                >
                  Enable
                </button>
              )}
            </div>
          )}
        </div>

        {/* Status banner */}
        {isDegraded && (
          <div
            className="px-4 py-2 bg-warning/10 border-t border-warning/20"
            data-testid="bridge-degraded-banner"
          >
            <p className="text-xs text-warning font-medium">Bridge degraded</p>
            <p className="text-xs text-on-surface-variant mt-0.5">
              {status?.degraded_transports?.discord_bridge}
            </p>
          </div>
        )}

        {bridgeEnabled && !isDegraded && status?.lifecycle === "running" && (
          <div
            className="px-4 py-2 bg-primary/5 border-t border-primary/10"
            data-testid="bridge-running-banner"
          >
            <p className="text-xs text-primary font-medium">Bridge running</p>
          </div>
        )}

        {/* Guild picker — shown when bridge is running */}
        {bridgeEnabled && status?.lifecycle === "running" && (
          <div className="border-t border-outline-variant/10">
            <GuildPicker />
          </div>
        )}

        {/* Setup walkthrough */}
        {native && !bridgeEnabled && (
          <div className="p-4 space-y-4 border-t border-outline-variant/10">
            {/* Step 1: Create Discord App */}
            <StepBlock
              number={1}
              title="Create a Discord Application"
              active={step === 1}
              done={step > 1}
            >
              <p className="text-xs text-on-surface-variant">
                Go to{" "}
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  discord.com/developers/applications
                </a>{" "}
                and create a new application. Then go to the <strong>Bot</strong>{" "}
                section and create a bot user.
              </p>
              <button
                type="button"
                onClick={() => setStep(2)}
                className="mt-2 text-xs text-primary hover:underline"
                data-testid="step-1-next"
              >
                Done, next step
              </button>
            </StepBlock>

            {/* Step 2: Enable Intents */}
            <StepBlock
              number={2}
              title="Enable Required Intents"
              active={step === 2}
              done={step > 2}
            >
              <p className="text-xs text-on-surface-variant">
                In the Bot settings, enable these <strong>Privileged Gateway Intents</strong>:
              </p>
              <ul className="text-xs text-on-surface-variant list-disc list-inside mt-1 space-y-0.5">
                <li><strong>Server Members Intent</strong> — required for user presence</li>
                <li><strong>Message Content Intent</strong> — required for message relay</li>
              </ul>
              <button
                type="button"
                onClick={() => setStep(3)}
                className="mt-2 text-xs text-primary hover:underline"
                data-testid="step-2-next"
              >
                Done, next step
              </button>
            </StepBlock>

            {/* Step 3: Paste Bot Token */}
            <StepBlock
              number={3}
              title="Paste Bot Token"
              active={step === 3}
              done={step > 3 || hasBotToken}
            >
              <p className="text-xs text-on-surface-variant">
                Copy the bot token from the Bot settings page and paste it below.
                The token is stored securely and never leaves this device.
              </p>
              <div className="flex gap-2 mt-2">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Paste bot token here..."
                  data-testid="bot-token-input"
                  className="flex-1 px-3 py-1.5 bg-surface-container-highest rounded-md text-sm text-on-surface placeholder:text-on-surface-variant/50 border border-outline-variant/20 focus:border-primary/50 focus:outline-none min-h-[36px]"
                />
                <button
                  type="button"
                  onClick={handleSetToken}
                  disabled={busy || !tokenInput.trim()}
                  data-testid="save-token-btn"
                  className="px-4 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40 min-h-[36px]"
                >
                  {busy ? "Saving..." : "Save"}
                </button>
              </div>
            </StepBlock>

            {/* Step 4: Invite Bot */}
            <StepBlock
              number={4}
              title="Invite Bot to Your Discord Server"
              active={step === 4}
              done={step > 4}
            >
              <p className="text-xs text-on-surface-variant">
                Go to <strong>OAuth2 &gt; URL Generator</strong> in the developer portal.
                Select the <strong>bot</strong> scope and these permissions:
              </p>
              <ul className="text-xs text-on-surface-variant list-disc list-inside mt-1 space-y-0.5">
                <li>Read Messages/View Channels</li>
                <li>Send Messages</li>
                <li>Manage Messages (for edit/delete relay)</li>
                <li>Read Message History</li>
                <li>Add Reactions</li>
              </ul>
              <p className="text-xs text-on-surface-variant mt-1">
                Copy the generated URL and open it to invite the bot to your Discord server.
              </p>
              <button
                type="button"
                onClick={() => setStep(5)}
                className="mt-2 text-xs text-primary hover:underline"
                data-testid="step-4-next"
              >
                Done, next step
              </button>
            </StepBlock>

            {/* Step 5: Enable */}
            <StepBlock
              number={5}
              title="Enable the Bridge"
              active={step >= 5}
              done={bridgeEnabled}
            >
              <p className="text-xs text-on-surface-variant">
                Click <strong>Enable</strong> above to start the Discord bridge.
                {!status?.binary_available && " The bridge binary will be downloaded automatically (~20 MB)."}
              </p>
              {/* Dependency readiness */}
              <div className="mt-2 space-y-1">
                <DependencyCheck
                  label="mautrix-discord"
                  ready={status?.binary_available ?? false}
                  hint="Will auto-download on enable"
                />
                <DependencyCheck
                  label="bubblewrap sandbox"
                  ready={status?.bwrap_available ?? false}
                  hint="Will auto-install on enable"
                />
              </div>
              {!status?.bwrap_available && (
                <div className="mt-2 rounded bg-surface-container-high/60 px-3 py-2 border border-outline-variant/20">
                  <p className="text-xs text-on-surface-variant">
                    The sandbox will be installed automatically when you click Enable
                    (you'll see a password prompt).
                  </p>
                </div>
              )}
            </StepBlock>
          </div>
        )}
      </div>}

      {/* User-mode (Puppeting) Section — Wave 4b */}
      {native && (
        <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
            <span className="text-xl">👤</span>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-on-surface">User Mode (Puppeting)</h4>
              <p className="text-xs text-on-surface-variant">
                Login with your personal Discord account for full message puppeting
              </p>
            </div>
          </div>

          <div className="p-4 border-t border-outline-variant/10">
            <UserModeSection onShowTos={() => setShowTosModal(true)} />
          </div>
        </div>
      )}

      {/* Error banner — native only (web section handles its own errors) */}
      {native && error && (
        <div
          className="rounded-md border border-error/30 bg-error/10 px-4 py-3"
          data-testid="bridge-error"
        >
          <p className="text-sm text-error font-medium">Bridge error</p>
          <p className="text-xs text-on-surface-variant mt-1 break-all">{error}</p>
          <button
            type="button"
            onClick={() => { setError(null); refresh(); }}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* ToS Modal */}
      {showTosModal && (
        <DiscordTosModal onClose={() => setShowTosModal(false)} />
      )}
    </div>
  );
}

/**
 * Step block component for the setup walkthrough.
 */
function StepBlock({
  number,
  title,
  active,
  done,
  children,
}: {
  number: number;
  title: string;
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md border px-4 py-3 transition-colors ${
        done
          ? "border-primary/20 bg-primary/5"
          : active
          ? "border-outline-variant/30 bg-surface-container-high/40"
          : "border-outline-variant/10 bg-surface/50 opacity-50"
      }`}
      data-testid={`setup-step-${number}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium ${
            done
              ? "bg-primary text-on-primary"
              : "bg-surface-container-highest text-on-surface-variant"
          }`}
        >
          {done ? "✓" : number}
        </span>
        <h5 className="text-sm font-medium text-on-surface">{title}</h5>
      </div>
      {(active || done) && <div className="mt-2 pl-7">{children}</div>}
    </div>
  );
}

/**
 * Dependency readiness indicator.
 */
function DependencyCheck({
  label,
  ready,
  hint,
}: {
  label: string;
  ready: boolean;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={ready ? "text-primary" : "text-on-surface-variant/50"}>
        {ready ? "✓" : "○"}
      </span>
      <span className={ready ? "text-on-surface" : "text-on-surface-variant/60"}>
        {label}
      </span>
      {!ready && (
        <span className="text-on-surface-variant/40 italic">— {hint}</span>
      )}
    </div>
  );
}

/**
 * Guild picker — lets the user select which Discord servers to bridge.
 * Fetches the guild list from the provisioning API and shows checkboxes.
 */
function GuildPicker() {
  const [guilds, setGuilds] = useState<DiscordGuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyGuild, setBusyGuild] = useState<string | null>(null);

  const loadGuilds = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await discordBridgeListGuilds();
      setGuilds(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGuilds();
  }, [loadGuilds]);

  const handleBridge = useCallback(async (guild: DiscordGuild) => {
    setBusyGuild(guild.id);
    try {
      if (guild.bridged) {
        await discordBridgeUnbridgeGuild(guild.id);
      } else {
        await discordBridgeGuild(guild.id);
      }
      await loadGuilds();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyGuild(null);
    }
  }, [loadGuilds]);

  if (loading) {
    return (
      <div className="p-4 text-center">
        <p className="text-xs text-on-surface-variant">Loading Discord servers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 space-y-2">
        <p className="text-xs text-error">{error}</p>
        <button
          type="button"
          onClick={() => { setError(null); loadGuilds(); }}
          className="text-xs text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (guilds.length === 0) {
    return (
      <div className="p-4">
        <p className="text-xs text-on-surface-variant">
          No Discord servers found. Make sure your bot has been invited to at least one server.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3" data-testid="guild-picker">
      <div>
        <h5 className="text-sm font-medium text-on-surface">Discord Servers</h5>
        <p className="text-xs text-on-surface-variant mt-0.5">
          Select which servers to bridge into Concord.
        </p>
      </div>
      <div className="space-y-1.5">
        {guilds.map((guild) => (
          <div
            key={guild.id}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
              guild.bridged
                ? "bg-[#5865F2]/10 border border-[#5865F2]/20"
                : "bg-surface-container-high/40 border border-outline-variant/10 hover:border-outline-variant/30"
            }`}
          >
            <div className="w-8 h-8 rounded-lg bg-[#5865F2]/20 flex items-center justify-center text-[#5865F2] text-xs font-bold flex-shrink-0">
              {guild.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-on-surface font-medium truncate">{guild.name}</p>
              {guild.bridged && (
                <p className="text-[10px] text-[#5865F2]/70 uppercase tracking-wider">Bridged</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => handleBridge(guild)}
              disabled={busyGuild === guild.id}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors min-h-[32px] ${
                guild.bridged
                  ? "bg-error/10 hover:bg-error/15 text-error disabled:opacity-40"
                  : "bg-[#5865F2]/10 hover:bg-[#5865F2]/20 text-[#5865F2] disabled:opacity-40"
              }`}
            >
              {busyGuild === guild.id
                ? "..."
                : guild.bridged
                  ? "Unbridge"
                  : "Bridge"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * User-mode section with ToS gate (Wave 4b).
 */
function UserModeSection({ onShowTos }: { onShowTos: () => void }) {
  // Check if ToS has been accepted by reading from localStorage
  // (persisted settings store).
  const [tosAccepted, setTosAccepted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("concord_settings");
      if (stored) {
        const parsed = JSON.parse(stored);
        const state = parsed?.state;
        if (state?.discord_bridge_tos_accepted_at) {
          setTosAccepted(true);
        }
      }
    } catch {
      // Ignore parse errors.
    }
  }, []);

  // Listen for ToS acceptance (the modal writes to localStorage).
  useEffect(() => {
    const handler = () => {
      try {
        const stored = localStorage.getItem("concord_settings");
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed?.state?.discord_bridge_tos_accepted_at) {
            setTosAccepted(true);
          }
        }
      } catch {
        // Ignore.
      }
    };
    window.addEventListener("storage", handler);
    // Also check on a short interval for same-tab updates.
    const interval = setInterval(handler, 1000);
    return () => {
      window.removeEventListener("storage", handler);
      clearInterval(interval);
    };
  }, []);

  if (!tosAccepted) {
    return (
      <div data-testid="user-mode-tos-gate">
        <p className="text-xs text-on-surface-variant">
          User mode lets you log in with your personal Discord account so
          messages appear as you, not a bot. This requires accepting additional
          terms.
        </p>
        <button
          type="button"
          onClick={onShowTos}
          data-testid="user-mode-accept-tos-btn"
          className="mt-3 px-4 py-2 bg-secondary/10 hover:bg-secondary/15 text-secondary text-sm rounded-md transition-colors min-h-[36px]"
        >
          Review terms and enable
        </button>
      </div>
    );
  }

  return (
    <div data-testid="user-mode-instructions">
      <p className="text-xs text-on-surface-variant">
        To connect your personal Discord account:
      </p>
      <ol className="text-xs text-on-surface-variant list-decimal list-inside mt-2 space-y-1.5">
        <li>
          From any Matrix client, send a DM to{" "}
          <code className="bg-surface-container-highest px-1 py-0.5 rounded text-on-surface">
            @_discord_bot:&lt;your-server&gt;
          </code>{" "}
          with the message <strong>login</strong>.
        </li>
        <li>The bridge bot will respond with a QR code.</li>
        <li>
          Open Discord on your phone, go to{" "}
          <strong>Settings &gt; Advanced &gt; Scan Login QR Code</strong>{" "}
          and scan the QR code.
        </li>
        <li>
          Once connected, your Discord messages will appear under your name
          in the bridged rooms.
        </li>
      </ol>
      <p className="text-xs text-on-surface-variant/70 mt-3 italic">
        Concord never touches your Discord token. It flows directly from
        Discord to the sandboxed bridge process.
      </p>
    </div>
  );
}

/**
 * Docker/web bridge management section.
 *
 * Mirrors the native walkthrough UX: guides the admin through
 * creating a Discord app, enabling intents, pasting the bot token
 * (saved to the server via POST /bot-token), inviting the bot, and
 * finally enabling the bridge. No manual file editing required.
 */
function DockerBridgeSection({ accessToken }: { accessToken: string }) {
  const [status, setStatus] = useState<HttpBridgeStatus | null>(null);
  const [lastResult, setLastResult] = useState<HttpBridgeMutationResponse | null>(null);
  const [botProfile, setBotProfile] = useState<DiscordBotProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [botTokenInput, setBotTokenInput] = useState("");
  const [botNameInput, setBotNameInput] = useState("corr-bridge");
  const [savingBotName, setSavingBotName] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await discordBridgeHttpStatus(accessToken);
      if (!mountedRef.current) return;
      setStatus(s);
      // Auto-advance past token step if already configured.
      if (s.bot_token_configured && step < 4) setStep(4);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [accessToken, step]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => { mountedRef.current = false; };
  }, [refresh]);

  useEffect(() => {
    if (!status?.bot_token_configured) {
      setBotProfile(null);
      setBotNameInput("corr-bridge");
      return;
    }
    let cancelled = false;
    discordBridgeHttpGetBotProfile(accessToken)
      .then((profile) => {
        if (cancelled) return;
        setBotProfile(profile);
        setBotNameInput(profile.username || "corr-bridge");
      })
      .catch(() => {
        if (cancelled) return;
        setBotProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, status?.bot_token_configured]);

  const handleSaveToken = useCallback(async () => {
    if (!botTokenInput.trim()) return;
    setSavingToken(true);
    setError(null);
    try {
      await discordBridgeHttpSaveBotToken(accessToken, botTokenInput.trim());
      setBotTokenInput("");
      setStep(4);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingToken(false);
    }
  }, [accessToken, botTokenInput, refresh]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await discordBridgeHttpEnable(accessToken);
      if (!mountedRef.current) return;
      setLastResult(result);
      await refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [accessToken, refresh]);

  const handleDisable = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await discordBridgeHttpDisable(accessToken);
      if (!mountedRef.current) return;
      setLastResult(result);
      await refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [accessToken, refresh]);

  const handleRotate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await discordBridgeHttpRotate(accessToken);
      if (!mountedRef.current) return;
      setLastResult(result);
      await refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [accessToken, refresh]);

  const handleSaveBotName = useCallback(async () => {
    const username = botNameInput.trim();
    if (!username) return;
    setSavingBotName(true);
    setError(null);
    try {
      const profile = await discordBridgeHttpUpdateBotProfile(accessToken, { username });
      setBotProfile(profile);
      setBotNameInput(profile.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBotName(false);
    }
  }, [accessToken, botNameInput]);

  const tokenConfigured = status?.bot_token_configured ?? false;

  return (
    <div className="space-y-4" data-testid="docker-bridge-section">
      {/* Status card */}
      <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
          <span className="text-xl">🎮</span>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-on-surface">Discord Bridge</h4>
            <p className="text-xs text-on-surface-variant">
              mautrix-discord container • managed via Docker
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {status === null ? (
              <span className="text-xs text-on-surface-variant/50">Loading…</span>
            ) : status.enabled ? (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-green-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Enabled
                </span>
                <button
                  type="button"
                  onClick={handleDisable}
                  disabled={busy}
                  data-testid="docker-bridge-disable-btn"
                  className="px-3 py-1.5 bg-error/10 hover:bg-error/15 text-error text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px]"
                >
                  {busy ? "…" : "Disable"}
                </button>
                <button
                  type="button"
                  onClick={handleRotate}
                  disabled={busy}
                  data-testid="docker-bridge-rotate-btn"
                  className="px-3 py-1.5 bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px]"
                >
                  Rotate tokens
                </button>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-on-surface-variant/50">
                  <span className="w-1.5 h-1.5 rounded-full bg-outline-variant/40 inline-block" />
                  Disabled
                </span>
                <button
                  type="button"
                  onClick={handleEnable}
                  disabled={busy || !tokenConfigured}
                  title={!tokenConfigured ? "Complete setup steps first" : undefined}
                  data-testid="docker-bridge-enable-btn"
                  className="px-3 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px]"
                >
                  {busy ? "…" : "Enable"}
                </button>
              </>
            )}
          </div>
      </div>

      {tokenConfigured && (
        <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
            <span className="material-symbols-outlined text-xl text-on-surface-variant">badge</span>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-on-surface">Bridge Display Name</h4>
              <p className="text-xs text-on-surface-variant">
                Shown in Discord when the bridge joins voice. Default recommendation: <code className="text-on-surface">corr-bridge</code>
              </p>
            </div>
          </div>
          <div className="p-4 border-t border-outline-variant/10 space-y-3">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <input
                value={botNameInput}
                onChange={(event) => setBotNameInput(event.target.value)}
                placeholder="corr-bridge"
                className="px-3 py-2 bg-surface-container-highest rounded-md text-sm text-on-surface placeholder:text-on-surface-variant/50 border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setBotNameInput("corr-bridge")}
                disabled={savingBotName}
                className="px-3 py-2 bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant text-xs rounded-md transition-colors disabled:opacity-40"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={handleSaveBotName}
                disabled={savingBotName || !botNameInput.trim()}
                className="px-3 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40"
              >
                {savingBotName ? "Saving..." : "Save name"}
              </button>
            </div>
            <p className="text-[11px] text-on-surface-variant/70">
              Current Discord username: <span className="text-on-surface">{botProfile?.username ?? "Unknown"}</span>
            </p>
          </div>
        </div>
      )}

      {/* Setup walkthrough — shown when disabled */}
        {status !== null && !status.enabled && (
          <div className="p-4 border-t border-outline-variant/10 space-y-3">
            <StepBlock number={1} title="Create a Discord Application" active={step === 1} done={step > 1}>
              <p className="text-xs text-on-surface-variant">
                Go to{" "}
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  discord.com/developers/applications
                </a>{" "}
                and create a new application. Then open the <strong>Bot</strong> tab and create a bot user.
              </p>
              <button
                type="button"
                onClick={() => setStep(2)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Done, next step →
              </button>
            </StepBlock>

            <StepBlock number={2} title="Enable Required Intents" active={step === 2} done={step > 2}>
              <p className="text-xs text-on-surface-variant">
                In Bot settings, enable these <strong>Privileged Gateway Intents</strong>:
              </p>
              <ul className="text-xs text-on-surface-variant list-disc list-inside mt-1 space-y-0.5">
                <li><strong>Server Members Intent</strong></li>
                <li><strong>Message Content Intent</strong></li>
              </ul>
              <button
                type="button"
                onClick={() => setStep(3)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Done, next step →
              </button>
            </StepBlock>

            <StepBlock
              number={3}
              title="Paste Bot Token"
              active={step === 3}
              done={step > 3 || tokenConfigured}
            >
              <p className="text-xs text-on-surface-variant">
                Copy the bot token from the Bot page and paste it below.
                It is stored securely on the server and never exposed via the API.
              </p>
              {tokenConfigured ? (
                <p className="mt-2 text-xs text-green-500 font-medium">
                  ✓ Token configured
                </p>
              ) : (
                <div className="flex gap-2 mt-2">
                  <input
                    type="password"
                    value={botTokenInput}
                    onChange={(e) => setBotTokenInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveToken()}
                    placeholder="Paste bot token here…"
                    data-testid="docker-bot-token-input"
                    className="flex-1 px-3 py-1.5 bg-surface-container-highest rounded-md text-sm text-on-surface placeholder:text-on-surface-variant/50 border border-outline-variant/20 focus:border-primary/50 focus:outline-none min-h-[36px]"
                  />
                  <button
                    type="button"
                    onClick={handleSaveToken}
                    disabled={savingToken || !botTokenInput.trim()}
                    data-testid="docker-save-token-btn"
                    className="px-4 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40 min-h-[36px]"
                  >
                    {savingToken ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
            </StepBlock>

            <StepBlock number={4} title="Invite Bot to Your Discord Server" active={step === 4} done={step > 4}>
              <p className="text-xs text-on-surface-variant">
                In the developer portal go to <strong>OAuth2 › URL Generator</strong>.
                Select scope <strong>bot</strong> and permissions: Read Messages/View Channels,
                Send Messages, Manage Messages, Read Message History, Add Reactions.
                Copy the URL and open it to invite the bot.
              </p>
              <button
                type="button"
                onClick={() => setStep(5)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Done, next step →
              </button>
            </StepBlock>

            <StepBlock number={5} title="Enable the Bridge" active={step >= 5} done={status.enabled}>
              <p className="text-xs text-on-surface-variant">
                Click <strong>Enable</strong> above to generate credentials and start the bridge.
              </p>
            </StepBlock>
          </div>
        )}

        {/* Step results */}
        {lastResult && (
          <div
            className={`px-4 py-3 border-t text-xs space-y-1 ${
              lastResult.ok ? "border-primary/10 bg-primary/5" : "border-error/10 bg-error/5"
            }`}
            data-testid="docker-bridge-result"
          >
            <p className={`font-medium ${lastResult.ok ? "text-primary" : "text-error"}`}>
              {lastResult.message}
            </p>
            <div className="space-y-0.5 mt-1">
              {lastResult.steps.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-on-surface-variant">
                  <span className={s.status === "ok" ? "text-green-500" : s.status === "failed" ? "text-error" : "text-on-surface-variant/40"}>
                    {s.status === "ok" ? "✓" : s.status === "failed" ? "✗" : "–"}
                  </span>
                  <span>{s.name.replace(/_/g, " ")}</span>
                  {s.detail && <span className="text-on-surface-variant/60 truncate">{s.detail}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-3 border-t border-error/10 bg-error/5" data-testid="docker-bridge-error">
            <p className="text-xs text-error font-medium">{error}</p>
            <button type="button" onClick={() => { setError(null); refresh(); }} className="mt-1 text-xs text-primary hover:underline">
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Registration info — shown when enabled */}
      {status?.enabled && status.appservice_id && (
        <div className="rounded-md border border-outline-variant/15 bg-surface-container-low/40 px-4 py-3 space-y-1">
          <p className="text-xs text-on-surface-variant font-medium">Registration</p>
          <p className="text-[11px] text-on-surface-variant/70">
            Appservice ID: <code className="text-on-surface">{status.appservice_id}</code>
          </p>
          {status.sender_mxid_localpart && (
            <p className="text-[11px] text-on-surface-variant/70">
              Bot localpart: <code className="text-on-surface">@{status.sender_mxid_localpart}:&lt;server&gt;</code>
            </p>
          )}
        </div>
      )}

      {status?.enabled && (
        <DiscordVoiceBridgeSection accessToken={accessToken} />
      )}

      {/* User-mode (Puppeting) — shown when bridge is enabled */}
      {status?.enabled && (
        <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
            <span className="text-xl">👤</span>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-on-surface">Personal Discord Account</h4>
              <p className="text-xs text-on-surface-variant">
                Connect your own Discord account alongside the bot relay
              </p>
            </div>
          </div>
          <div className="p-4 border-t border-outline-variant/10">
            <p className="text-xs text-on-surface-variant">
              The bot relays messages for everyone. You can <em>also</em> connect your
              personal Discord account so your messages appear under your own name
              instead of through the webhook.
            </p>
            <ol className="text-xs text-on-surface-variant list-decimal list-inside mt-2 space-y-1.5">
              <li>
                Open a DM with{" "}
                <code className="bg-surface-container-highest px-1 py-0.5 rounded text-on-surface">
                  @discordbot
                </code>{" "}
                (the bridge bot) in Concord.
              </li>
              <li>
                Send the message <strong>login</strong>.
              </li>
              <li>The bridge bot will respond with a QR code.</li>
              <li>
                Open Discord on your phone → <strong>Settings › Scan QR Code</strong> and scan it.
              </li>
            </ol>
            <p className="text-xs text-on-surface-variant/70 mt-3 italic">
              Both connections work in parallel — the bot relay handles users without a
              personal login, while your own messages go through your puppeted account.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function DiscordVoiceBridgeSection({ accessToken }: { accessToken: string }) {
  const servers = useServerStore((s) => s.servers);
  const voiceChannels = useMemo(
    () =>
      servers.flatMap((server) =>
        server.channels
          .filter((channel) => channel.channel_type === "voice")
          .map((channel) => ({
            id: channel.id,
            name: `${server.name} / ${channel.name}`,
          })),
      ),
    [servers],
  );
  const [rooms, setRooms] = useState<DiscordVoiceBridgeRoom[]>([]);
  const [channelId, setChannelId] = useState("");
  const [discordGuildId, setDiscordGuildId] = useState("");
  const [discordChannelId, setDiscordChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRooms(await discordVoiceBridgeHttpListRooms(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [accessToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveMapping = useCallback(async () => {
    const parsedChannelId = Number(channelId);
    if (!parsedChannelId || !discordGuildId.trim() || !discordChannelId.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await discordVoiceBridgeHttpUpsertRoom(accessToken, {
        channel_id: parsedChannelId,
        discord_guild_id: discordGuildId.trim(),
        discord_channel_id: discordChannelId.trim(),
        enabled: true,
      });
      await discordVoiceBridgeHttpStart(accessToken);
      setDiscordGuildId("");
      setDiscordChannelId("");
      setMessage("Voice bridge mapping saved and sidecar started.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [accessToken, channelId, discordGuildId, discordChannelId, refresh]);

  const deleteMapping = useCallback(async (bridgeId: number) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await discordVoiceBridgeHttpDeleteRoom(accessToken, bridgeId);
      await discordVoiceBridgeHttpStart(accessToken);
      setMessage("Voice bridge mapping removed. The sidecar will drop it on the next config poll.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [accessToken, refresh]);

  const restart = useCallback(async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await discordVoiceBridgeHttpRestart(accessToken);
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [accessToken]);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await discordVoiceBridgeHttpStop(accessToken);
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [accessToken]);

  return (
    <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
        <span className="material-symbols-outlined text-xl text-on-surface-variant">headset_mic</span>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-on-surface">Discord Voice Bridge</h4>
          <p className="text-xs text-on-surface-variant">
            Joins Discord voice as the bot and relays audio to the selected Concord voice channel.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={restart}
            disabled={busy}
            className="px-3 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px]"
          >
            Reload bridge
          </button>
          <button
            type="button"
            onClick={stop}
            disabled={busy}
            className="px-3 py-1.5 bg-error/10 hover:bg-error/15 text-error text-xs rounded-md transition-colors disabled:opacity-40 min-h-[32px]"
          >
            Stop
          </button>
        </div>
      </div>

      <div className="p-4 border-t border-outline-variant/10 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="px-3 py-2 bg-surface-container-highest rounded-md text-sm text-on-surface border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
          >
            <option value="">Concord voice channel</option>
            {(voiceChannels.length > 0 ? voiceChannels : EMPTY_VOICE_CHANNELS).map((channel) => (
              <option key={channel.id} value={channel.id}>{channel.name}</option>
            ))}
          </select>
          <input
            value={discordGuildId}
            onChange={(e) => setDiscordGuildId(e.target.value)}
            placeholder="Discord server ID"
            className="px-3 py-2 bg-surface-container-highest rounded-md text-sm text-on-surface placeholder:text-on-surface-variant/50 border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
          />
          <input
            value={discordChannelId}
            onChange={(e) => setDiscordChannelId(e.target.value)}
            placeholder="Discord voice channel ID"
            className="px-3 py-2 bg-surface-container-highest rounded-md text-sm text-on-surface placeholder:text-on-surface-variant/50 border border-outline-variant/20 focus:border-primary/50 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={saveMapping}
          disabled={busy || !channelId || !discordGuildId.trim() || !discordChannelId.trim()}
          className="px-4 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors disabled:opacity-40"
        >
          Save voice mapping
        </button>

        {rooms.length > 0 && (
          <div className="space-y-2">
            {rooms.map((room) => (
              <div key={room.id} className="flex items-center gap-3 px-3 py-2 bg-surface-container-low/50 rounded-md">
                <div className="flex-1 min-w-0 text-xs text-on-surface-variant">
                  <p>
                    Concord channel #{room.channel_id} {"->"} Discord channel {room.discord_channel_id}
                  </p>
                  <p className="text-on-surface-variant/60">Guild {room.discord_guild_id}</p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteMapping(room.id)}
                  disabled={busy}
                  className="px-3 py-1.5 bg-error/10 hover:bg-error/15 text-error text-xs rounded-md transition-colors disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {message && <p className="text-xs text-primary">{message}</p>}
        {error && <p className="text-xs text-error">{error}</p>}
        <p className="text-[11px] text-on-surface-variant/70">
          Enable Discord developer mode, then right-click the Discord server and voice channel to copy their IDs.
        </p>
      </div>
    </div>
  );
}
