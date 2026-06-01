/**
 * Visibility — Settings → Hosting subsection (F-VIS).
 *
 * Per-server max-mesh-hops slider. The user picks how far across the
 * peer mesh their server is advertised — 0 = owner-only (the default
 * for "home" until they opt in), 1 = direct paired peers (the default
 * for the always-fresh porch), N = up to N hops away.
 *
 * Implementation notes:
 *   - Two sliders by default (porch + home), one row each. Future
 *     user-created servers will land in this same section once the
 *     server-list endpoint ships.
 *   - The slider is bounded at 0..=5 in the UI for sanity (most
 *     practical mesh diameters), but the backend accepts the full
 *     u8 range. A user with an enormous mesh can hit the underlying
 *     command directly.
 *   - Writes go through `setVisibility`, which both persists to
 *     `visibility_meta` AND broadcasts a `VisibilityUpdate` over the
 *     F3 gossipsub mesh so paired peers refresh their explore-menu
 *     filters.
 *   - Web build: shows a "Native only" placeholder. The browser node
 *     doesn't host servers — visibility is meaningless there.
 */

import { useEffect, useState } from "react";

import { isTauri } from "../../api/servitude";
import {
  fetchVisibility,
  setVisibility,
  VISIBILITY_SERVER_ID_HOME,
  VISIBILITY_SERVER_ID_PORCH,
  type VisibilityRow,
} from "../../api/visibility";
import { useToastStore } from "../../stores/toast";

/**
 * UI cap on the slider. The Rust side accepts 0..=255; the UI hides
 * the long tail because mesh diameter past 5 hops is impractical for
 * the typical user. A power user can call the command directly with a
 * larger value and the value will round-trip through the slider on
 * read (the displayed number snaps to the cap, but the persisted
 * value stays whatever they set).
 */
const UI_MAX_HOPS = 5;

/**
 * Hop-radius copy for each slider position. Centralized so the
 * Hosting + Explore UIs use the same language.
 */
const HOP_DESCRIPTIONS: Record<number, string> = {
  0: "Owner only — nobody else sees this server in their explore menu.",
  1: "Direct paired peers — only the peers you've paired with see it.",
  2: "Paired-of-paired — your peers and their direct peers see it.",
  3: "Three hops — pairs of pairs of pairs.",
  4: "Four hops — a wider local mesh.",
  5: "Five hops — about as far as practical mesh propagation reaches.",
};

interface ServerEntry {
  id: string;
  label: string;
  /** Hint copy shown above the slider. */
  defaultHint: string;
}

const SERVERS: ServerEntry[] = [
  {
    id: VISIBILITY_SERVER_ID_PORCH,
    label: "Porch (always-fresh guest entrance)",
    defaultHint:
      "Defaults to 1 hop — only your directly-paired peers can see it.",
  },
  {
    id: VISIBILITY_SERVER_ID_HOME,
    label: "Home (your persistent server)",
    defaultHint:
      "Defaults to 0 hops — owner-only until you opt in. Raise this to let paired peers (or wider) see it in their explore menu.",
  },
];

export function VisibilitySection() {
  if (!isTauri()) {
    return (
      <div
        className="border-t border-outline-variant/20 pt-6 space-y-3"
        data-testid="visibility-section"
      >
        <div>
          <h4 className="text-sm font-headline font-semibold text-on-surface">
            Server visibility
          </h4>
          <p className="text-xs text-on-surface-variant mt-1">
            Available on the native build only. The browser tab doesn't host
            servers, so there's nothing to advertise into the mesh.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-t border-outline-variant/20 pt-6 space-y-4"
      data-testid="visibility-section"
    >
      <div>
        <h4 className="text-sm font-headline font-semibold text-on-surface">
          Server visibility
        </h4>
        <p className="text-xs text-on-surface-variant mt-1">
          Each server you host has a configurable mesh-hop visibility
          ceiling. A peer N hops away on the mesh only sees a server
          when its ceiling is at least N. Outside that radius, the
          server is invisible to them. Visibility is independent of
          access — a peer can see a server without being able to dial
          in.
        </p>
      </div>

      {SERVERS.map((entry) => (
        <VisibilityRowSlider key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function VisibilityRowSlider({ entry }: { entry: ServerEntry }) {
  const [row, setRow] = useState<VisibilityRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fetched = await fetchVisibility(entry.id);
        if (!cancelled) {
          setRow(fetched);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  const handleChange = async (next: number) => {
    if (!row) return;
    setPending(true);
    setError(null);
    try {
      const updated = await setVisibility(entry.id, next);
      setRow(updated);
      addToast(`${entry.label}: visibility set to ${next} hop${next === 1 ? "" : "s"}`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast(`Could not update visibility: ${message}`);
    } finally {
      setPending(false);
    }
  };

  const current = row?.maxHops ?? 0;
  // UI clamps; the persisted value still survives if it's higher than UI_MAX_HOPS.
  const displayValue = Math.min(current, UI_MAX_HOPS);
  const description =
    HOP_DESCRIPTIONS[displayValue] ??
    `${current} hops — a wider mesh propagation.`;

  return (
    <div
      className="bg-surface-container rounded-xl p-3 space-y-2"
      data-testid={`visibility-row-${entry.id}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-on-surface">{entry.label}</span>
        <span
          className="text-xs text-on-surface-variant font-mono"
          data-testid={`visibility-value-${entry.id}`}
        >
          {row === null ? "—" : `${current} hop${current === 1 ? "" : "s"}`}
        </span>
      </div>

      {row === null ? (
        <p className="text-xs text-on-surface-variant italic">
          {error ? `Couldn't load: ${error}` : "Loading…"}
        </p>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={UI_MAX_HOPS}
            step={1}
            value={displayValue}
            disabled={pending}
            onChange={(e) => void handleChange(Number(e.target.value))}
            aria-label={`Max mesh hops for ${entry.label}`}
            data-testid={`visibility-slider-${entry.id}`}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-[10px] text-on-surface-variant font-mono">
            <span>0</span>
            <span>1</span>
            <span>2</span>
            <span>3</span>
            <span>4</span>
            <span>{UI_MAX_HOPS}</span>
          </div>
          <p className="text-xs text-on-surface-variant">
            {description}
          </p>
          <p className="text-xs text-on-surface-variant/70 italic">
            {entry.defaultHint}
          </p>
          {error && (
            <p className="text-xs text-error">Last error: {error}</p>
          )}
        </>
      )}
    </div>
  );
}
