/**
 * FirstLaunchTwoNameBanner — empty-state prompt that asks the user for
 * the two names a fresh install needs:
 *
 *   1. "This device" → source-rail label. What peers see when they
 *      reach this device. Default "local". Backed by
 *      `useInstanceNameStore` (existing).
 *   2. "Your home server" → the persistent default Concord server
 *      hosted on this device. Default "home". Backed by
 *      `useHomeServerNameStore` (added in this PR, full backing by
 *      F1b-IMPL).
 *
 * The porch is implicit — always "porch", never user-named, ephemeral
 * per-launch — so we mention it in one body line ("Your porch — the
 * always-fresh guest entrance — is automatic") rather than asking the
 * user to choose anything about it.
 *
 * Dismiss rules:
 *
 *   - Save persists whatever fields the user filled in (blank fields
 *     are skipped — the store keeps its prior empty/default state) and
 *     drops a `sessionStorage` flag so the banner is gone for the rest
 *     of this session.
 *   - Skip drops the same flag without writing anything.
 *   - The banner does NOT render if EITHER `useInstanceNameStore.name`
 *     or `useHomeServerNameStore.name` is already non-empty — a name
 *     has been picked, the prompt is done.
 *   - The banner does NOT render if the `sessionStorage` flag is set
 *     even if both names are still empty — the user declined this
 *     session and we won't pester them again.
 *
 * Visual: matches the empty-state typography in the message-list pane
 * (font-body for prose, font-label for input labels) so it doesn't
 * fight the existing design. Tailwind classes only — no new CSS.
 */

import { useCallback, useEffect, useState } from "react";
import { useInstanceNameStore } from "../../stores/instanceName";
import { useHomeServerNameStore } from "../../stores/homeServerName";

/** sessionStorage key — keep in sync with the dispatch brief. */
const DISMISS_KEY = "concord:first-launch-banner-dismissed";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    // sessionStorage may be unavailable in some sandboxes (jsdom edge
    // cases, private-mode browsers). Treat "couldn't read" as
    // "not dismissed" so the banner still gets a chance to render.
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Best-effort — if sessionStorage rejects, the banner will reappear
    // next render, which is fine for a single-session prompt.
  }
}

export function FirstLaunchTwoNameBanner() {
  const instanceName = useInstanceNameStore((s) => s.name);
  const setInstance = useInstanceNameStore((s) => s.set);
  const homeName = useHomeServerNameStore((s) => s.name);
  const setHome = useHomeServerNameStore((s) => s.set);

  // Local controlled inputs — separate from the stores so the user can
  // edit freely without firing a Tauri round-trip on every keystroke.
  const [deviceInput, setDeviceInput] = useState("");
  const [homeInput, setHomeInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track dismissal in component state so Save/Skip hide the banner
  // immediately without waiting for a parent re-render.
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());

  // If another part of the app sets either name (e.g. settings panel)
  // the banner should disappear — observe the store values on every
  // render below.
  useEffect(() => {
    // Re-sync the dismissed flag in case another tab cleared it. Cheap
    // and safe because sessionStorage reads are O(1).
    setDismissed(readDismissed());
  }, []);

  const hide =
    dismissed ||
    instanceName.trim().length > 0 ||
    homeName.trim().length > 0;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const device = deviceInput.trim();
      const home = homeInput.trim();
      // Skip empty fields — the store keeps its prior empty state and
      // the default ("local" / "home") continues to render in the UI.
      if (device.length > 0) {
        await setInstance(device);
      }
      if (home.length > 0) {
        await setHome(home);
      }
      writeDismissed();
      setDismissed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [deviceInput, homeInput, setInstance, setHome]);

  const handleSkip = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  if (hide) return null;

  return (
    <section
      data-testid="first-launch-two-name-banner"
      className="w-full rounded-2xl bg-surface-container border border-outline/30 p-6 flex flex-col gap-4 shadow-sm text-left"
      aria-labelledby="first-launch-two-name-banner-headline"
    >
      <header className="flex flex-col gap-1">
        <h2
          id="first-launch-two-name-banner-headline"
          className="text-lg font-headline font-semibold text-on-surface"
        >
          Welcome — name your space
        </h2>
        <p className="text-sm text-on-surface-variant font-body">
          Your porch — the always-fresh guest entrance — is automatic.
          Pick a label for this device and your home server below.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-wider">
            This device (what peers see)
          </span>
          <input
            data-testid="first-launch-device-input"
            type="text"
            value={deviceInput}
            onChange={(e) => setDeviceInput(e.target.value)}
            placeholder="local"
            disabled={saving}
            className="rounded-lg bg-surface px-3 py-2 text-sm font-body text-on-surface placeholder:text-on-surface-variant/60 border border-outline/30 focus:outline-none focus:ring-2 focus:ring-primary/40"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-label font-medium text-on-surface-variant uppercase tracking-wider">
            Your home server
          </span>
          <input
            data-testid="first-launch-home-input"
            type="text"
            value={homeInput}
            onChange={(e) => setHomeInput(e.target.value)}
            placeholder="home"
            disabled={saving}
            className="rounded-lg bg-surface px-3 py-2 text-sm font-body text-on-surface placeholder:text-on-surface-variant/60 border border-outline/30 focus:outline-none focus:ring-2 focus:ring-primary/40"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          className="text-xs font-body text-error"
          data-testid="first-launch-two-name-banner-error"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          data-testid="first-launch-two-name-banner-save"
          onClick={handleSave}
          disabled={saving}
          className="btn-press rounded-lg px-4 py-2 text-sm font-label font-semibold primary-glow text-on-primary disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          data-testid="first-launch-two-name-banner-skip"
          onClick={handleSkip}
          disabled={saving}
          className="text-xs font-label font-medium text-on-surface-variant underline underline-offset-2 hover:text-on-surface disabled:opacity-60"
        >
          Skip for now
        </button>
      </div>
    </section>
  );
}
