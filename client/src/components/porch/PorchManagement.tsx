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

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  porchCreateChannel,
  type AclMode,
  type ChannelKind,
} from "../../api/porch";
import { usePorchStore } from "../../stores/porchStore";
import { KnocksAtTheDoor } from "./KnocksAtTheDoor";

// Lazy-load the theme editor so the color-picker / file-upload surface
// only pulls into the bundle when the owner actually opens the Themes
// tab. Keeps the main porch-management chunk tight for the common
// "view knocks + create channel" flow.
const ChannelThemeEditor = lazy(() =>
  import("./ChannelThemeEditor").then((m) => ({
    default: m.ChannelThemeEditor,
  })),
);

// Phase D — lazy-load the obsidian editor too. The file picker + the
// markdown renderer aren't needed unless the owner actually has an
// obsidian channel to configure.
const ObsidianChannelEditor = lazy(() =>
  import("./ObsidianChannelEditor").then((m) => ({
    default: m.ObsidianChannelEditor,
  })),
);

// Phase E — lazy-load the backup settings surface. The list /
// add-target form is small but it pulls in the encrypted-blob status
// polling effect, so deferring the chunk keeps Channel-tab load fast.
const BackupSettings = lazy(() =>
  import("./BackupSettings").then((m) => ({
    default: m.BackupSettings,
  })),
);

// Phase F — lazy-load the personal-devices tab. The background
// auto-sync timer fires every 60s while mounted, so deferring keeps
// it inert when the user isn't looking.
const PersonalDevices = lazy(() =>
  import("./PersonalDevices").then((m) => ({
    default: m.PersonalDevices,
  })),
);

type ManagementTab = "channels" | "themes" | "backup" | "devices";

export function PorchManagement() {
  const porch = usePorchStore();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState<ChannelKind>("inner");
  const [draftAcl, setDraftAcl] = useState<AclMode>("allowlist");
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [tab, setTab] = useState<ManagementTab>("channels");
  const [themedChannelId, setThemedChannelId] = useState<string | null>(null);
  // Phase D — when the owner clicks "Configure" on an obsidian-kind
  // channel, the editor opens inline below the channel list. `null`
  // hides it.
  const [obsidianChannelId, setObsidianChannelId] = useState<string | null>(null);

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

  // Default the themed-channel selector to the first available channel
  // when the user first switches to the Themes tab.
  const activeThemeChannelId =
    themedChannelId ?? porch.channels[0]?.id ?? null;

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
      <div
        role="tablist"
        aria-label="Porch management sections"
        style={{ display: "flex", gap: 4 }}
      >
        <ManagementTabButton
          label="Channels"
          active={tab === "channels"}
          onClick={() => setTab("channels")}
          testId="porch-tab-channels"
        />
        <ManagementTabButton
          label="Themes"
          active={tab === "themes"}
          onClick={() => setTab("themes")}
          testId="porch-tab-themes"
        />
        <ManagementTabButton
          label="Backup"
          active={tab === "backup"}
          onClick={() => setTab("backup")}
          testId="porch-tab-backup"
        />
        <ManagementTabButton
          label="Devices"
          active={tab === "devices"}
          onClick={() => setTab("devices")}
          testId="porch-tab-devices"
        />
      </div>

      {tab === "devices" ? (
        <Suspense
          fallback={
            <div
              data-testid="personal-devices-suspense"
              style={{ fontSize: 12 }}
            >
              Loading personal devices…
            </div>
          }
        >
          <PersonalDevices />
        </Suspense>
      ) : tab === "backup" ? (
        <Suspense
          fallback={
            <div
              data-testid="backup-settings-suspense"
              style={{ fontSize: 12 }}
            >
              Loading backup settings…
            </div>
          }
        >
          <BackupSettings />
        </Suspense>
      ) : tab === "themes" ? (
        <ThemesPanel
          channels={porch.channels.map((c) => ({ id: c.id, name: c.name }))}
          activeChannelId={activeThemeChannelId}
          onSelectChannel={setThemedChannelId}
        />
      ) : (
        <>
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
          <>
          {obsidianChannelId &&
            porch.channels.some(
              (c) => c.id === obsidianChannelId && c.kind === "obsidian",
            ) && (
              <Suspense
                fallback={
                  <div
                    data-testid="obsidian-editor-suspense"
                    style={{ fontSize: 12 }}
                  >
                    Loading vault editor…
                  </div>
                }
              >
                <ObsidianChannelEditor
                  key={obsidianChannelId}
                  channelId={obsidianChannelId}
                  channelName={
                    porch.channels.find((c) => c.id === obsidianChannelId)
                      ?.name ?? "vault"
                  }
                />
              </Suspense>
            )}
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
                {c.kind === "obsidian" && (
                  <button
                    type="button"
                    onClick={() =>
                      setObsidianChannelId(
                        obsidianChannelId === c.id ? null : c.id,
                      )
                    }
                    data-testid={`obsidian-configure-${c.id}`}
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
                    {obsidianChannelId === c.id ? "Hide" : "Configure"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          </>
        )}
      </section>
        </>
      )}
    </div>
  );
}

function ManagementTabButton({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      style={{
        padding: "4px 12px",
        fontSize: 12,
        background: active ? "var(--primary, #4f9eff)" : "transparent",
        color: active ? "white" : "inherit",
        border: "1px solid var(--outline-variant, #2a2c30)",
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function ThemesPanel({
  channels,
  activeChannelId,
  onSelectChannel,
}: {
  channels: { id: string; name: string }[];
  activeChannelId: string | null;
  onSelectChannel: (id: string) => void;
}) {
  if (channels.length === 0) {
    return (
      <section
        data-testid="themes-panel-empty"
        style={{
          background: "var(--surface-container, #1f2125)",
          border: "1px solid var(--outline-variant, #2a2c30)",
          borderRadius: 8,
          padding: 12,
          fontSize: 13,
          fontStyle: "italic",
          opacity: 0.7,
        }}
      >
        No channels to theme yet. Create a channel in the Channels tab
        first.
      </section>
    );
  }
  const active = channels.find((c) => c.id === activeChannelId) ?? channels[0];
  return (
    <section
      data-testid="themes-panel"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ opacity: 0.8 }}>Channel:</span>
        <select
          data-testid="theme-channel-select"
          value={active.id}
          onChange={(e) => onSelectChannel(e.target.value)}
          style={{
            flex: 1,
            padding: "4px 6px",
            background: "var(--surface, #18191c)",
            color: "inherit",
            border: "1px solid var(--outline-variant, #2a2c30)",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <Suspense
        fallback={
          <div data-testid="theme-editor-suspense" style={{ fontSize: 12 }}>
            Loading editor…
          </div>
        }
      >
        <ChannelThemeEditor
          key={active.id}
          channelId={active.id}
          channelName={active.name}
        />
      </Suspense>
    </section>
  );
}

export default PorchManagement;
