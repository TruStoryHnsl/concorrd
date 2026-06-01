/**
 * VanityNameBanner — inline first-launch nudge to set the instance name.
 *
 * The vanity instance name is what peers see when they connect to this
 * device over libp2p. We never gate boot on it — the porch auto-activates
 * with the default `local` label so the user reaches a working surface
 * immediately. The banner is the *first-class affordance* that surfaces
 * the rename without making it a modal/wizard step.
 *
 * Render gating (callers do this — the component itself just renders):
 *   - `useInstanceNameStore.name` is empty (user has not picked one yet)
 *   - the porch channel has no messages (so we only nag on a genuinely
 *     fresh install; long-running porches with history don't get the
 *     banner re-surfaced on every visit)
 *   - the user hasn't tapped "skip" in this browser session
 *
 * On save:
 *   - calls `useInstanceNameStore.getState().set(input)` which persists
 *     to the Tauri store; the banner auto-hides because the gating
 *     condition (`name === ""`) flips false.
 *
 * On skip:
 *   - writes a sessionStorage flag (`concord:vanity-banner:skipped`)
 *     so the banner doesn't re-mount when the user navigates away and
 *     back within the same session.
 *
 * No spinners in here — any in-flight save uses the standing project
 * pattern of disabling the input + button and switching the label text.
 * If a future variant needs a loading visual, reuse `<BringingUpSplash
 * size="inline" />` — never invent another spinner.
 */

import { useCallback, useEffect, useState } from "react";
import { useInstanceNameStore } from "../../stores/instanceName";

const SKIP_KEY = "concord:vanity-banner:skipped";

/**
 * Check whether the banner has been dismissed in this session. Read at
 * mount time so other components can hide the banner without prop-
 * drilling state through the porch tree.
 */
export function isVanityBannerSkipped(): boolean {
  try {
    return window.sessionStorage.getItem(SKIP_KEY) === "1";
  } catch {
    // sessionStorage unavailable (private mode, sandbox) — fall back to
    // "not skipped" so the banner stays visible.
    return false;
  }
}

interface VanityNameBannerProps {
  /** Fired when the user dismisses (skip or successful save). */
  onDismiss?: () => void;
}

export function VanityNameBanner({ onDismiss }: VanityNameBannerProps) {
  const persistedName = useInstanceNameStore((s) => s.name);
  const error = useInstanceNameStore((s) => s.error);
  const save = useInstanceNameStore((s) => s.set);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // When the persisted name flips non-empty (either we just saved, or
  // another surface like Settings → Hosting beat us to it), tell the
  // parent to hide us.
  useEffect(() => {
    if (persistedName.trim().length > 0) {
      onDismiss?.();
    }
  }, [persistedName, onDismiss]);

  const handleSkip = useCallback(() => {
    try {
      window.sessionStorage.setItem(SKIP_KEY, "1");
    } catch {
      // Ignore — the parent's onDismiss still hides the banner for the
      // remainder of this mount; we just won't remember across remounts.
    }
    onDismiss?.();
  }, [onDismiss]);

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await save(trimmed);
      onDismiss?.();
    } catch {
      // The store already populated `error`; surface it inline.
    } finally {
      setSaving(false);
    }
  }, [canSave, save, trimmed, onDismiss]);

  return (
    <section
      data-testid="vanity-name-banner"
      className="mx-4 mt-4 mb-2 flex flex-col gap-2 rounded-xl border border-outline-variant/30 bg-surface-container p-4"
      aria-label="Name your instance"
    >
      <h3 className="text-sm font-headline font-semibold text-on-surface">
        Name your instance
      </h3>
      <p className="text-xs text-on-surface-variant">
        This is the label peers see when they reach this device. No Matrix
        account, no password, no homeserver involved — just a friendly
        handle for your porch.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid="vanity-name-banner-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) {
              e.preventDefault();
              void handleSave();
            }
          }}
          placeholder="Name your instance (peers see this)"
          maxLength={64}
          disabled={saving}
          aria-label="Instance name"
          className="flex-1 min-w-[12rem] rounded-lg border border-outline-variant/30 bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
        />
        <button
          data-testid="vanity-name-banner-save"
          type="button"
          disabled={!canSave}
          onClick={() => void handleSave()}
          className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          data-testid="vanity-name-banner-skip"
          type="button"
          onClick={handleSkip}
          disabled={saving}
          className="text-xs text-on-surface-variant underline-offset-2 hover:underline disabled:opacity-40"
        >
          Skip for now
        </button>
      </div>
      {error && (
        <p data-testid="vanity-name-banner-error" className="text-xs text-error">
          {error}
        </p>
      )}
    </section>
  );
}
