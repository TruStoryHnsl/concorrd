import { useCallback, useState } from "react";

/**
 * Discord ToS warning modal — INS-024 Wave 4b.
 *
 * This modal MUST be shown before user-mode (puppeting) is accessible.
 * Commercial scope demands that the user explicitly acknowledges the
 * risk of using a self-bot approach with their personal Discord account.
 *
 * The checkbox must be ticked before the Continue button enables.
 * Acceptance is persisted as `discord_bridge_tos_accepted_at` (ISO
 * timestamp) in the zustand settings store for audit purposes.
 */

interface DiscordTosModalProps {
  onClose: () => void;
}

export function DiscordTosModal({ onClose }: DiscordTosModalProps) {
  const [accepted, setAccepted] = useState(false);

  const handleAccept = useCallback(() => {
    if (!accepted) return;

    // Persist the acceptance timestamp to the settings store.
    const timestamp = new Date().toISOString();
    try {
      const stored = localStorage.getItem("concord_settings");
      const parsed = stored ? JSON.parse(stored) : { state: {}, version: 0 };
      if (!parsed.state) parsed.state = {};
      parsed.state.discord_bridge_tos_accepted_at = timestamp;
      localStorage.setItem("concord_settings", JSON.stringify(parsed));
    } catch {
      // If localStorage fails, still allow acceptance for this session.
    }

    onClose();
  }, [accepted, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="discord-tos-modal"
    >
      <div className="bg-surface-container rounded-xl shadow-xl max-w-lg w-full mx-4 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-on-surface">
          Discord User Mode — Important Notice
        </h3>

        <div className="space-y-3 text-sm text-on-surface-variant">
          <p>
            User mode connects your <strong>personal Discord account</strong> to
            the bridge so messages appear as you, not a bot. Before proceeding,
            please understand:
          </p>

          <ul className="list-disc list-inside space-y-1.5">
            <li>
              <strong>Discord's Terms of Service prohibit self-bots</strong> and
              automated use of personal accounts. Using this feature may violate
              Discord's ToS.
            </li>
            <li>
              <strong>Enforcement is inconsistent</strong> — some users have run
              bridges for years without issue, while others have had accounts
              suspended. Discord may change their enforcement at any time.
            </li>
            <li>
              <strong>Concord cannot warrant safety.</strong> We cannot guarantee
              that your Discord account will not be flagged, rate-limited, or
              banned as a result of using this feature.
            </li>
            <li>
              <strong>Your Discord token never touches Concord.</strong> It flows
              directly from Discord to the sandboxed mautrix-discord bridge
              process and is stored in the bridge's encrypted database, not in
              Concord's settings or logs.
            </li>
          </ul>
        </div>

        <label
          className="flex items-start gap-3 cursor-pointer select-none"
          data-testid="tos-checkbox-label"
        >
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            data-testid="tos-checkbox"
            className="mt-1 w-4 h-4 accent-primary"
          />
          <span className="text-sm text-on-surface">
            I understand the risks described above and accept full responsibility
            for my use of Discord user mode. I acknowledge that Concord provides
            no warranty regarding Discord account safety.
          </span>
        </label>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            data-testid="tos-cancel-btn"
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors min-h-[40px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAccept}
            disabled={!accepted}
            data-testid="tos-continue-btn"
            className="px-4 py-2 bg-primary text-on-primary text-sm rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px]"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
