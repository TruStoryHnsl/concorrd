/**
 * HostOnboarding — vanity-instance-name picker.
 *
 * The pre-2026-05-31 wizard spawned a Matrix homeserver alongside the
 * porch: it called `servitude_register_owner` against a tuwunel /
 * dendrite instance, persisted a Matrix source with `isOwner: true`,
 * and routed the user to that homeserver. That entire flow was
 * architecturally wrong (see `project_porch_is_matrix_data` memory):
 *
 *   - The porch IS this device's hosted server. It's not a Matrix
 *     homeserver — it's a peer-accessible local datastore that
 *     renders through ChatLayout in the same shape as other sources.
 *   - The libp2p swarm is already running by default on the native
 *     `p2p_only` profile; that IS what makes the porch reachable.
 *   - "Hosting" therefore isn't a wizard with a spinner — it's a
 *     state of the running native client.
 *
 * What "starting to host" still has to do, materially:
 *
 *   1. Let the user pick a vanity instance name. This name replaces
 *      "local" on the source-rail home tile AND rides in the libp2p
 *      Identify protocol's agent_version so connecting peers can
 *      confirm they reached the right device.
 *
 * That's it. No Matrix bring-up, no admin elevation, no owner-
 * account form, no spinner — the porch already exists, the swarm
 * is already up. The single step here is the vanity-name input.
 *
 * Open questions tracked in memory's task list:
 *   - The wizard could just be folded into Settings → Hosting
 *     (which already renders the vanity-name section). That's a
 *     UX call for a follow-up; this rewrite preserves the wizard
 *     entry point so Welcome.tsx and ChatLayout's "Host your own"
 *     CTA don't break.
 */

import { useState } from "react";
import { useInstanceNameStore } from "../../stores/instanceName";

export interface HostOnboardingProps {
  onCancel: () => void;
  onConnected: () => void;
}

export function HostOnboarding({ onCancel, onConnected }: HostOnboardingProps) {
  const persisted = useInstanceNameStore((s) => s.name);
  const save = useInstanceNameStore((s) => s.set);

  const [draft, setDraft] = useState(persisted);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Empty input is allowed — it just clears any prior vanity
      // name and the rail tile falls back to "local". The store
      // normalizes whitespace internally.
      await save(draft);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="host-onboarding-name"
      className="h-full w-full bg-surface mesh-background flex items-center justify-center"
    >
      <form
        onSubmit={handleSubmit}
        className="max-w-md w-full px-8 py-12 flex flex-col gap-6"
      >
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-bold text-text-primary">
            Name your instance
          </h2>
          <p className="text-sm text-text-secondary">
            This is the label peers see when they reach your device.
            Leave it blank to be known as "local". You can change it
            later in Settings → Hosting.
          </p>
        </div>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-text-secondary">Instance name</span>
          <input
            type="text"
            data-testid="host-onboarding-displayname"
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder="local"
            maxLength={64}
            className="px-4 py-3 rounded-xl bg-surface-elevated border border-border-soft text-text-primary"
          />
        </label>
        {error && (
          <p data-testid="host-onboarding-error-message" className="text-sm text-error">
            {error}
          </p>
        )}
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="host-onboarding-account-submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-accent text-on-accent disabled:opacity-50"
          >
            {saving ? "Saving…" : "Start hosting"}
          </button>
        </div>
      </form>
    </div>
  );
}
