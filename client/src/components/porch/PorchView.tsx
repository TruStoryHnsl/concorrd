/**
 * Porch view — Phase A.
 *
 * Renders a porch's channel list on the left + selected channel's
 * messages in the middle + a send-message input at the bottom.
 *
 * The component is mode-agnostic: it reads from either
 * `usePorchStore` (the host's OWN porch) or `useVisitorStore` (a
 * visited peer's porch) depending on the `mode` prop. Both stores
 * expose the same surface shape, so the view doesn't branch on mode
 * once it picks one.
 *
 * Phase A intentionally ships plain styling — Phase C is where
 * per-channel theming lands.
 */

import { useEffect, useMemo, useState } from "react";
import { usePorchStore } from "../../stores/porchStore";
import { useVisitorStore } from "../../stores/visitorStore";
import type {
  ChannelMessage,
  ChannelTheme,
  PorchChannel,
  PorchListChannelRow,
} from "../../api/porch";
import {
  defaultChannelTheme,
  porchGetTheme,
  porchVisitGetAssetBytes,
  porchVisitGetTheme,
} from "../../api/porch";
import { applyTheme } from "./themeRenderer";

export type PorchViewMode = "self" | "visit";

interface CommonStore {
  channels: PorchChannel[];
  selectedChannelId: string | null;
  messages: ChannelMessage[];
  isLoading: boolean;
  error: string | null;
  selectChannel: (channelId: string) => Promise<void>;
  sendMessage: (body: string) => Promise<void>;
}

export interface PorchViewProps {
  mode: PorchViewMode;
  /** Optional title — defaults to "Porch" for self, "Visiting peer" for visit. */
  title?: string;
}

export function PorchView({ mode, title }: PorchViewProps) {
  // Both stores have the same shape but are different zustand
  // instances. Read both unconditionally; only one is active.
  const self = usePorchStore();
  const visit = useVisitorStore();

  const store: CommonStore = mode === "self" ? self : visit;

  const [draft, setDraft] = useState("");
  // Phase C — per-channel theme for the currently-selected channel.
  // Cached in a local map keyed by `${peer ?? "self"}::${channelId}` so
  // re-selecting a channel doesn't refetch.
  const [themeCache, setThemeCache] = useState<Record<string, ChannelTheme>>(
    {},
  );
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const visitPeer = mode === "visit" ? visit.currentPeerId : null;
  const selectedId = store.selectedChannelId;
  const themeKey = `${visitPeer ?? "self"}::${selectedId ?? ""}`;
  const activeTheme: ChannelTheme | null = useMemo(() => {
    if (!selectedId) return null;
    return themeCache[themeKey] ?? null;
  }, [themeCache, themeKey, selectedId]);

  // Fetch + cache the theme whenever the selected channel changes.
  useEffect(() => {
    if (!selectedId) return;
    if (themeCache[themeKey]) return; // already cached
    let cancelled = false;
    const load = async () => {
      try {
        const t =
          mode === "self"
            ? await porchGetTheme(selectedId)
            : visitPeer
              ? await porchVisitGetTheme(visitPeer, selectedId)
              : defaultChannelTheme(selectedId);
        if (!cancelled) {
          setThemeCache((prev) => ({ ...prev, [themeKey]: t }));
        }
      } catch {
        // Theme fetch is best-effort — fall back to default on error.
        if (!cancelled) {
          setThemeCache((prev) => ({
            ...prev,
            [themeKey]: defaultChannelTheme(selectedId),
          }));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [themeKey, themeCache, selectedId, mode, visitPeer]);

  // Resolve image background → blob URL. The blob URL is revoked on
  // unmount / change so we don't leak memory.
  useEffect(() => {
    setBgUrl(null);
    if (!activeTheme) return;
    if (activeTheme.background.kind !== "image") return;
    const assetId = activeTheme.background.value.asset_id;
    if (!assetId) return;
    let cancelled = false;
    let url: string | null = null;
    const load = async () => {
      try {
        const bytes =
          mode === "self"
            ? // The host's own assets aren't loaded here in Phase C —
              // the editor preview is the canonical view. Fall back to
              // the solid surface color until self-mode background
              // streaming lands.
              null
            : visitPeer
              ? await porchVisitGetAssetBytes(visitPeer, assetId)
              : null;
        if (!cancelled && bytes) {
          const blob = new Blob([bytes as BlobPart], {
            type: "image/*",
          });
          url = URL.createObjectURL(blob);
          setBgUrl(url);
        }
      } catch {
        // Best effort — keep the solid-color fallback.
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [activeTheme, mode, visitPeer]);

  // Trigger an initial load when the component mounts in self mode.
  // The visit mode is driven by an explicit `openVisit` call from
  // upstream — we don't auto-trigger it here.
  useEffect(() => {
    if (mode === "self" && !self.isLoaded && !self.isLoading) {
      void self.loadChannels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const headerLabel =
    title ?? (mode === "self" ? "Porch" : "Visiting peer");

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    await store.sendMessage(draft);
    setDraft("");
  };

  const themedStyle = applyTheme(activeTheme, {
    imageBackgroundUrl: bgUrl ?? undefined,
  });

  return (
    <div
      className="porch-view"
      data-testid="porch-view"
      style={{
        display: "flex",
        flexDirection: "row",
        height: "100%",
        width: "100%",
        background: "var(--surface, #18191c)",
        color: "var(--on-surface, #e3e4e6)",
        // Phase C — themed surface overrides the defaults above when
        // an active theme is loaded for the selected channel.
        ...themedStyle,
      }}
    >
      {/* Channel list */}
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid var(--outline-variant, #2a2c30)",
          padding: "12px 0",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "0 12px 8px",
            fontSize: 12,
            fontWeight: 600,
            opacity: 0.7,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {headerLabel}
        </div>
        {store.channels.length === 0 && !store.isLoading && (
          <div
            style={{
              padding: "8px 12px",
              fontSize: 13,
              opacity: 0.6,
              fontStyle: "italic",
            }}
          >
            {store.error === "native_only"
              ? "Hosting a porch requires the desktop app."
              : "No channels visible."}
          </div>
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {/* Phase B: in visit mode we render rows with visibility
              metadata so gated channels surface a Knock affordance.
              In self mode we still render plain channels. */}
          {mode === "visit"
            ? visit.rows.map((row) => (
                <VisitorChannelRow
                  key={row.id}
                  row={row}
                  selected={row.id === store.selectedChannelId}
                />
              ))
            : store.channels.map((ch) => {
                const selected = ch.id === store.selectedChannelId;
                return (
                  <li key={ch.id}>
                    <button
                      type="button"
                      onClick={() => {
                        void store.selectChannel(ch.id);
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        background: selected
                          ? "var(--surface-container-high, #2a2d32)"
                          : "transparent",
                        color: "inherit",
                        border: 0,
                        padding: "8px 12px",
                        fontSize: 14,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span style={{ opacity: 0.7, fontSize: 12 }}>
                        {ch.kind === "porch" ? "#" : ch.kind === "obsidian" ? "📓" : "🔒"}
                      </span>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ch.name}
                      </span>
                    </button>
                  </li>
                );
              })}
        </ul>
      </aside>

      {/* Messages + composer */}
      <section
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 16px",
            minHeight: 0,
          }}
        >
          {store.messages.length === 0 ? (
            <div style={{ opacity: 0.6, fontStyle: "italic", fontSize: 13 }}>
              {store.selectedChannelId === null
                ? "Select a channel."
                : store.isLoading
                  ? "Loading..."
                  : "No messages yet."}
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {store.messages.map((m) => (
                <li
                  key={m.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <div style={{ fontSize: 11, opacity: 0.6 }}>
                    <code style={{ fontSize: "0.95em" }}>
                      {m.author_peer_id.slice(0, 12)}…
                    </code>
                    <span style={{ marginLeft: 6 }}>
                      {new Date(m.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style={{ fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {m.body}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {store.error && store.error !== "native_only" && (
          <div
            style={{
              padding: "6px 12px",
              fontSize: 12,
              color: "var(--error, #e57373)",
              background: "rgba(229, 115, 115, 0.08)",
            }}
          >
            {store.error}
          </div>
        )}

        <form
          onSubmit={handleSend}
          style={{
            padding: 12,
            display: "flex",
            gap: 8,
            borderTop: "1px solid var(--outline-variant, #2a2c30)",
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              store.selectedChannelId
                ? "Say something..."
                : "Select a channel to post"
            }
            disabled={!store.selectedChannelId || store.error === "native_only"}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--outline-variant, #2a2c30)",
              background: "var(--surface-container, #1f2125)",
              color: "inherit",
              fontSize: 14,
            }}
          />
          <button
            type="submit"
            disabled={!draft.trim() || !store.selectedChannelId}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: 0,
              background: "var(--primary, #4f9eff)",
              color: "white",
              fontSize: 14,
              cursor: draft.trim() ? "pointer" : "not-allowed",
              opacity: draft.trim() ? 1 : 0.5,
            }}
          >
            Send
          </button>
        </form>
      </section>
    </div>
  );
}

/**
 * Phase B — single channel row inside the visitor's channel list.
 * Branches on `row.visibility`:
 *   - `visible`: standard click-to-enter (same as Phase A).
 *   - `needs_knock` with no existing knock: render a Knock button that
 *     opens an inline message input + Send.
 *   - `needs_knock` with `pending` knock: render a "Waiting on host"
 *     badge + Withdraw button.
 *   - `needs_knock` with `rejected` / `withdrawn`: render Knock again.
 */
function VisitorChannelRow({
  row,
  selected,
}: {
  row: PorchListChannelRow;
  selected: boolean;
}) {
  const store = useVisitorStore();
  const [draftMessage, setDraftMessage] = useState("");
  const [showKnockForm, setShowKnockForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const submitKnock = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const trimmed = draftMessage.trim();
      await store.knockOn(row.id, trimmed.length ? trimmed : null);
      setShowKnockForm(false);
      setDraftMessage("");
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    // We need the knock id; the visit store tracks visibility only, not
    // the row id. Look it up via the status endpoint — cheap.
    const peer = store.currentPeerId;
    if (!peer) return;
    setBusy(true);
    try {
      const mod = await import("../../api/porch");
      const status = await mod.porchVisitKnockStatus(peer, row.id);
      if (status && status.status === "pending") {
        await store.withdrawKnock(status.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const visKind = row.visibility.kind;
  const existing = visKind === "needs_knock" ? row.visibility.existing_knock ?? null : null;

  if (visKind === "visible") {
    return (
      <li>
        <button
          type="button"
          onClick={() => void store.selectChannel(row.id)}
          style={{
            width: "100%",
            textAlign: "left",
            background: selected
              ? "var(--surface-container-high, #2a2d32)"
              : "transparent",
            color: "inherit",
            border: 0,
            padding: "8px 12px",
            fontSize: 14,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ opacity: 0.7, fontSize: 12 }}>
            {row.kind === "porch" ? "#" : row.kind === "obsidian" ? "📓" : "🔒"}
          </span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.name}
          </span>
          <ThemeSwatch row={row} />
        </button>
      </li>
    );
  }

  // Gated channel.
  return (
    <li>
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          opacity: existing === "accepted" ? 1 : 0.85,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ opacity: 0.7, fontSize: 12 }} aria-hidden>
            🔒
          </span>
          <span
            style={{
              flex: 1,
              fontSize: 14,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.name}
          </span>
          <ThemeSwatch row={row} />
        </div>

        {existing === "pending" ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span
              data-testid="knock-pending-badge"
              style={{
                fontSize: 11,
                background: "rgba(255, 197, 102, 0.15)",
                color: "#ffc566",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              Waiting on host
            </span>
            <button
              type="button"
              onClick={() => void withdraw()}
              disabled={busy}
              style={{
                fontSize: 11,
                background: "transparent",
                border: "1px solid var(--outline-variant, #2a2c30)",
                color: "inherit",
                padding: "2px 8px",
                borderRadius: 4,
                cursor: busy ? "wait" : "pointer",
              }}
            >
              Withdraw
            </button>
          </div>
        ) : existing === "accepted" ? (
          <div style={{ display: "flex", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#3ad17d" }}>
              Accepted — refresh to enter
            </span>
            <button
              type="button"
              onClick={() => void store.refreshChannels()}
              style={{
                fontSize: 11,
                background: "transparent",
                border: "1px solid var(--outline-variant, #2a2c30)",
                color: "inherit",
                padding: "2px 8px",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Refresh
            </button>
          </div>
        ) : showKnockForm ? (
          <form
            onSubmit={submitKnock}
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <input
              type="text"
              value={draftMessage}
              onChange={(e) => setDraftMessage(e.target.value)}
              placeholder="Why are you knocking? (optional)"
              autoFocus
              maxLength={1024}
              style={{
                fontSize: 12,
                padding: "4px 6px",
                borderRadius: 4,
                border: "1px solid var(--outline-variant, #2a2c30)",
                background: "var(--surface-container, #1f2125)",
                color: "inherit",
              }}
            />
            <div style={{ display: "flex", gap: 4 }}>
              <button
                type="submit"
                disabled={busy}
                data-testid="knock-submit-button"
                style={{
                  fontSize: 11,
                  background: "var(--primary, #4f9eff)",
                  border: 0,
                  color: "white",
                  padding: "2px 8px",
                  borderRadius: 4,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                Send knock
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowKnockForm(false);
                  setDraftMessage("");
                }}
                style={{
                  fontSize: 11,
                  background: "transparent",
                  border: "1px solid var(--outline-variant, #2a2c30)",
                  color: "inherit",
                  padding: "2px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setShowKnockForm(true)}
              data-testid="knock-button"
              style={{
                fontSize: 11,
                background: "transparent",
                border: "1px solid var(--outline-variant, #2a2c30)",
                color: "inherit",
                padding: "2px 8px",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Knock
            </button>
            {existing === "rejected" && (
              <span style={{ fontSize: 11, color: "var(--error, #e57373)" }}>
                Previously rejected
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Phase C — two small color dots next to a channel name in the
 * visitor's rail, so the visitor sees a porch's character before
 * clicking into a channel. Falls back to the default-theme swatch
 * when the host hasn't customized.
 */
function ThemeSwatch({ row }: { row: PorchListChannelRow }) {
  const summary = row.theme_summary ?? null;
  // Default-theme summary for unstyled channels.
  const primary = summary?.primary_color ?? "#4f9eff";
  const accent = summary?.accent_color ?? "#7c4dff";
  return (
    <span
      data-testid={`theme-swatch-${row.id}`}
      aria-hidden
      style={{ display: "inline-flex", gap: 2 }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: primary,
          display: "inline-block",
        }}
      />
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: accent,
          display: "inline-block",
        }}
      />
    </span>
  );
}

export default PorchView;
