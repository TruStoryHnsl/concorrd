/**
 * Vanity instance-name editor.
 *
 * One text field. Writes through the {@link useInstanceNameStore}
 * surface, which persists to the servitude config store and (on
 * next swarm start) updates the libp2p Identify protocol's
 * `agent_version` so peers see the chosen name when they connect.
 *
 * Empty input means "use the default 'local' label" — the store
 * normalizes whitespace and clears the persisted value when the
 * field is blank on save.
 *
 * Native-only — on web builds the docker stack picks the label at
 * compose time, so the section renders a read-only explanation.
 */

import { useEffect, useState } from "react";
import { isTauri } from "../../api/servitude";
import { useInstanceNameStore } from "../../stores/instanceName";

export function InstanceNameSection() {
  const persisted = useInstanceNameStore((s) => s.name);
  const loading = useInstanceNameStore((s) => s.loading);
  const error = useInstanceNameStore((s) => s.error);
  const save = useInstanceNameStore((s) => s.set);

  const [draft, setDraft] = useState(persisted);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Keep the input in sync when the persisted value loads / is
  // updated from elsewhere (e.g. settings reset).
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const trimmed = draft.trim();
  const dirty = trimmed !== persisted;

  if (!isTauri()) {
    return (
      <section className="flex flex-col gap-2 p-3 rounded-xl bg-surface-container">
        <h3 className="text-sm font-headline font-semibold text-on-surface">
          Instance name
        </h3>
        <p className="text-xs text-on-surface-variant">
          Web instances inherit their name from the docker stack's
          configuration — there's no runtime field here.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2 p-3 rounded-xl bg-surface-container">
      <h3 className="text-sm font-headline font-semibold text-on-surface">
        Instance name
      </h3>
      <p className="text-xs text-on-surface-variant">
        Shown on this device's source rail and broadcast to peers so
        they can confirm they reached the right device. Takes effect
        on next servitude restart.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          placeholder="local"
          maxLength={64}
          disabled={loading || saving}
          aria-label="Instance name"
          className="flex-1 px-3 py-2 rounded-lg bg-surface text-sm text-on-surface placeholder:text-on-surface-variant/60 border border-outline-variant/30 focus:outline-none focus:border-primary"
        />
        <button
          type="button"
          disabled={!dirty || saving || loading}
          onClick={async () => {
            setSaving(true);
            setSaved(false);
            try {
              await save(draft);
              setSaved(true);
            } catch {
              // useInstanceNameStore.error is already populated.
            } finally {
              setSaving(false);
            }
          }}
          className="px-3 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
      {saved && !error && (
        <p className="text-xs text-on-surface-variant">
          Saved. Restart your instance for peers to see the new name.
        </p>
      )}
    </section>
  );
}
