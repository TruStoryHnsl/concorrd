/**
 * Phase B — "Knocks at the door" surface.
 *
 * Polls `porch_pending_knocks` every 10s while mounted and renders the
 * list of visitors waiting on an inner-channel grant. Each row carries
 * Accept / Reject buttons that fire `porch_accept_knock` /
 * `porch_reject_knock`. Empty state: "Nobody knocking right now."
 *
 * The component is owner-side only — it short-circuits in browser
 * builds (the porch is native-only).
 */

import { useCallback, useEffect, useState } from "react";
import {
  porchAcceptKnock,
  porchPendingKnocks,
  porchRejectKnock,
  type Knock,
} from "../../api/porch";
import { isTauri } from "../../api/servitude";

const POLL_INTERVAL_MS = 10_000;

export interface KnocksAtTheDoorProps {
  /** Optional map from channel id → display name so the row can show
   *  "Campaign Notes" rather than just the ULID. The host's
   *  `porch_list_my_channels` provides this. */
  channelNames?: Record<string, string>;
  /** Optional callback invoked after a successful accept — the host
   *  surface might want to refresh its channel list to show the new
   *  member count. */
  onChange?: () => void;
}

export function KnocksAtTheDoor({
  channelNames,
  onChange,
}: KnocksAtTheDoorProps) {
  const [knocks, setKnocks] = useState<Knock[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      // The visitor's browser build never has pending knocks — the
      // porch lives on the host only.
      setKnocks([]);
      return;
    }
    try {
      const next = await porchPendingKnocks();
      setKnocks(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [refresh]);

  const handleAccept = async (knockId: string) => {
    setBusy(knockId);
    try {
      await porchAcceptKnock(knockId);
      await refresh();
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async (knockId: string) => {
    setBusy(knockId);
    try {
      await porchRejectKnock(knockId);
      await refresh();
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      data-testid="knocks-at-the-door"
      style={{
        background: "var(--surface-container, #1f2125)",
        border: "1px solid var(--outline-variant, #2a2c30)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          opacity: 0.8,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Knocks at the door
      </div>

      {error && (
        <div
          style={{
            fontSize: 12,
            color: "var(--error, #e57373)",
            background: "rgba(229, 115, 115, 0.08)",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}

      {knocks.length === 0 ? (
        <div
          data-testid="knocks-empty"
          style={{ fontSize: 13, opacity: 0.6, fontStyle: "italic" }}
        >
          Nobody knocking right now.
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {knocks.map((k) => {
            const channelLabel =
              channelNames?.[k.channel_id] ?? k.channel_id;
            const peerLabel = `${k.knocker_peer_id.slice(0, 12)}…`;
            return (
              <li
                key={k.id}
                data-testid={`knock-row-${k.id}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "8px 10px",
                  background: "var(--surface, #18191c)",
                  borderRadius: 6,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <code
                    style={{ fontSize: 11, opacity: 0.7 }}
                    title={k.knocker_peer_id}
                  >
                    {peerLabel}
                  </code>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    on {channelLabel}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      opacity: 0.5,
                      marginLeft: "auto",
                    }}
                  >
                    {new Date(k.created_at).toLocaleTimeString()}
                  </span>
                </div>
                {k.message && (
                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.9,
                      fontStyle: "italic",
                      borderLeft: "2px solid var(--outline-variant, #2a2c30)",
                      paddingLeft: 6,
                    }}
                  >
                    “{k.message}”
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    data-testid={`knock-accept-${k.id}`}
                    onClick={() => void handleAccept(k.id)}
                    disabled={busy === k.id}
                    style={{
                      fontSize: 12,
                      background: "var(--primary, #4f9eff)",
                      border: 0,
                      color: "white",
                      padding: "4px 10px",
                      borderRadius: 4,
                      cursor: busy === k.id ? "wait" : "pointer",
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    data-testid={`knock-reject-${k.id}`}
                    onClick={() => void handleReject(k.id)}
                    disabled={busy === k.id}
                    style={{
                      fontSize: 12,
                      background: "transparent",
                      border: "1px solid var(--outline-variant, #2a2c30)",
                      color: "inherit",
                      padding: "4px 10px",
                      borderRadius: 4,
                      cursor: busy === k.id ? "wait" : "pointer",
                    }}
                  >
                    Reject
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default KnocksAtTheDoor;
