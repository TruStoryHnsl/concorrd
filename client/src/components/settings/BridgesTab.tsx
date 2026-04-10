import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../../api/servitude";
import {
  discordBridgeSetBotToken,
  discordBridgeDisable,
  discordBridgeStatus,
  discordBridgeEnableAndStart,
  discordBridgeListGuilds,
  discordBridgeGuild,
  discordBridgeUnbridgeGuild,
  type BridgeStatus,
  type DiscordGuild,
} from "../../api/bridges";
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

type SetupStep = 1 | 2 | 3 | 4 | 5;

export function BridgesTab() {
  const native = isTauri();
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

      {!native && (
        <div
          className="rounded-md border border-outline-variant/30 bg-surface-container-high/40 px-4 py-3"
          data-testid="bridges-browser-banner"
        >
          <p className="text-sm text-on-surface">
            Bridge configuration is only available in the native Concord app.
          </p>
          <p className="text-xs text-on-surface-variant mt-1">
            Install the desktop build and reopen this settings tab.
          </p>
        </div>
      )}

      {/* Discord Bridge Section */}
      <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
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
      </div>

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

      {/* Error banner */}
      {error && (
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
