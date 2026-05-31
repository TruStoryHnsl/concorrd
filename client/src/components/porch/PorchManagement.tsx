/**
 * Phase B — owner-side porch management surface.
 *
 * Sits at the top of the porch modal (the same one Phase A introduced
 * via the Paired Peers list). Renders:
 *
 *   1. KnocksAtTheDoor — pending visitors waiting on inner-channel
 *      grants. Polls every 10s.
 *   2. The host's own channel list with affordances to create a new
 *      inner channel (kind + acl_mode picker).
 *
 * Native-only by construction — the porch is hosted locally, not
 * exposed to browsers.
 */

import { useEffect, useMemo, useState } from "react";
import {
  porchCreateChannel,
  type AclMode,
  type ChannelKind,
} from "../../api/porch";
import { usePorchStore } from "../../stores/porchStore";
import { KnocksAtTheDoor } from "./KnocksAtTheDoor";

export function PorchManagement() {
  const porch = usePorchStore();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState<ChannelKind>("inner");
  const [draftAcl, setDraftAcl] = useState<AclMode>("allowlist");
  const [createErr, setCreateErr] = useState<string | null>(null);

  useEffect(() => {
    if (!porch.isLoaded && !porch.isLoading) {
      void porch.loadChannels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // KnocksAtTheDoor wants `channel_id → name` so the row can label the
  // channel a knock is on rather than show the ULID.
  const channelNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of porch.channels) {
      map[c.id] = c.name;
    }
    return map;
  }, [porch.channels]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    setCreateErr(null);
    try {
      await porchCreateChannel(name, draftKind, draftAcl);
      await porch.loadChannels();
      setDraftName("");
      setCreating(false);
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      data-testid="porch-management"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 12,
        background: "var(--surface, #18191c)",
        color: "var(--on-surface, #e3e4e6)",
      }}
    >
      <KnocksAtTheDoor
        channelNames={channelNames}
        onChange={() => void porch.loadChannels()}
      />

      <section
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
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>My channels</span>
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              data-testid="porch-management-new-channel-button"
              style={{
                fontSize: 11,
                background: "transparent",
                border: "1px solid var(--outline-variant, #2a2c30)",
                color: "inherit",
                padding: "2px 8px",
                borderRadius: 4,
                cursor: "pointer",
                marginLeft: "auto",
                textTransform: "none",
                letterSpacing: 0,
              }}
            >
              + New
            </button>
          )}
        </div>

        {creating && (
          <form
            onSubmit={handleCreate}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Channel name"
              autoFocus
              maxLength={120}
              style={{
                fontSize: 13,
                padding: "6px 8px",
                borderRadius: 4,
                border: "1px solid var(--outline-variant, #2a2c30)",
                background: "var(--surface, #18191c)",
                color: "inherit",
              }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <label style={{ fontSize: 11, opacity: 0.8 }}>
                Kind:
                <select
                  value={draftKind}
                  onChange={(e) => setDraftKind(e.target.value as ChannelKind)}
                  style={{
                    marginLeft: 4,
                    fontSize: 12,
                    padding: "2px 4px",
                    background: "var(--surface, #18191c)",
                    color: "inherit",
                    border: "1px solid var(--outline-variant, #2a2c30)",
                    borderRadius: 4,
                  }}
                >
                  <option value="inner">inner</option>
                  <option value="obsidian">obsidian</option>
                </select>
              </label>
              <label style={{ fontSize: 11, opacity: 0.8 }}>
                Access:
                <select
                  value={draftAcl}
                  onChange={(e) => setDraftAcl(e.target.value as AclMode)}
                  style={{
                    marginLeft: 4,
                    fontSize: 12,
                    padding: "2px 4px",
                    background: "var(--surface, #18191c)",
                    color: "inherit",
                    border: "1px solid var(--outline-variant, #2a2c30)",
                    borderRadius: 4,
                  }}
                >
                  <option value="allowlist">allowlist (knockable)</option>
                  <option value="owner_only">owner_only (private)</option>
                </select>
              </label>
            </div>
            {createErr && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--error, #e57373)",
                  background: "rgba(229, 115, 115, 0.08)",
                  padding: "4px 8px",
                  borderRadius: 4,
                }}
              >
                {createErr}
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="submit"
                disabled={!draftName.trim()}
                style={{
                  fontSize: 12,
                  background: "var(--primary, #4f9eff)",
                  border: 0,
                  color: "white",
                  padding: "4px 10px",
                  borderRadius: 4,
                  cursor: draftName.trim() ? "pointer" : "not-allowed",
                  opacity: draftName.trim() ? 1 : 0.5,
                }}
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setDraftName("");
                  setCreateErr(null);
                }}
                style={{
                  fontSize: 12,
                  background: "transparent",
                  border: "1px solid var(--outline-variant, #2a2c30)",
                  color: "inherit",
                  padding: "4px 10px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {porch.channels.length === 0 ? (
          <div
            style={{ fontSize: 13, opacity: 0.6, fontStyle: "italic" }}
            data-testid="porch-management-no-channels"
          >
            {porch.error === "native_only"
              ? "Hosting a porch requires the desktop app."
              : "No channels yet."}
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {porch.channels.map((c) => (
              <li
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 8px",
                  fontSize: 13,
                }}
              >
                <span style={{ opacity: 0.7, fontSize: 12 }} aria-hidden>
                  {c.kind === "porch" ? "#" : c.kind === "obsidian" ? "📓" : "🔒"}
                </span>
                <span style={{ flex: 1 }}>{c.name}</span>
                <span style={{ fontSize: 11, opacity: 0.5 }}>
                  {c.kind} · {c.acl_mode}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default PorchManagement;
