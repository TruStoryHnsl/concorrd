/**
 * Phase D — owner-side editor for an Obsidian-bound channel.
 *
 * The owner picks a vault directory (via the OS-native folder
 * picker), optionally narrows to a subfolder, and toggles the
 * follow-symlinks setting. On save, the chosen path is persisted via
 * the `porch_set_obsidian_config` Tauri command — which canonicalizes
 * the path before storing it.
 *
 * Native-only by construction: the dialog plugin is only available
 * inside Tauri. Browsers cannot pick a host-filesystem path.
 */

import { useEffect, useState } from "react";
import {
  porchGetObsidianConfig,
  porchSetObsidianConfig,
  type ObsidianChannelConfig,
} from "../../api/porch";
import { isTauri } from "../../api/servitude";

export interface ObsidianChannelEditorProps {
  channelId: string;
  channelName: string;
}

export function ObsidianChannelEditor({
  channelId,
  channelName,
}: ObsidianChannelEditorProps) {
  const [config, setConfig] = useState<ObsidianChannelConfig | null>(null);
  const [vaultRoot, setVaultRoot] = useState<string>("");
  const [subfolder, setSubfolder] = useState<string>("");
  const [followSymlinks, setFollowSymlinks] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const cfg = await porchGetObsidianConfig(channelId);
        if (cancelled) return;
        if (cfg) {
          setConfig(cfg);
          setVaultRoot(cfg.vault_root);
          setSubfolder(cfg.subfolder ?? "");
          setFollowSymlinks(cfg.follow_symlinks);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const pickVaultRoot = async () => {
    if (!isTauri()) {
      setError("Folder picker requires the desktop app.");
      return;
    }
    setError(null);
    setWarning(null);
    try {
      // Lazy import so the dialog plugin chunk only loads when the
      // editor is actually used.
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Pick the vault directory",
      });
      if (typeof picked !== "string") return;
      setVaultRoot(picked);
      // Resetting the subfolder when the root changes — the prior
      // subfolder is no longer guaranteed to live under the new root.
      setSubfolder("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickSubfolder = async () => {
    if (!isTauri()) {
      setError("Folder picker requires the desktop app.");
      return;
    }
    if (!vaultRoot) {
      setError("Pick a vault root first.");
      return;
    }
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: vaultRoot,
        title: "Pick a subfolder (cancel for whole vault)",
      });
      if (typeof picked !== "string") return;
      // If the user picked the vault root itself, treat as "no
      // subfolder" — the Rust side accepts both forms but this keeps
      // the UI clean.
      if (picked === vaultRoot) {
        setSubfolder("");
        return;
      }
      // Try to derive a relative path so the visible form is short.
      const rel = relativeUnder(vaultRoot, picked);
      setSubfolder(rel ?? picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!vaultRoot.trim()) {
      setError("Pick a vault directory first.");
      return;
    }
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const saved = await porchSetObsidianConfig(
        channelId,
        vaultRoot.trim(),
        subfolder.trim() ? subfolder.trim() : null,
        followSymlinks,
      );
      setConfig(saved);
      setVaultRoot(saved.vault_root);
      setSubfolder(saved.subfolder ?? "");
      setFollowSymlinks(saved.follow_symlinks);
      setSavedAt(Date.now());
      // Non-blocking advisory if no `.obsidian/` subdirectory is
      // visible at the chosen root. (We can't actually list the
      // host's vault from the editor — `porch_list_vault` filters
      // dotfiles. The advisory is heuristic; the binding still
      // works against a plain markdown folder.)
      setWarning(
        "Tip: this folder doesn't need to be a full Obsidian vault — plain markdown works too.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="obsidian-channel-editor"
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
        Obsidian vault — {channelName}
      </div>

      <Row label="Vault root">
        <div
          style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}
        >
          <code
            data-testid="obsidian-vault-root-display"
            style={{
              flex: 1,
              padding: "4px 6px",
              background: "var(--surface, #18191c)",
              border: "1px solid var(--outline-variant, #2a2c30)",
              borderRadius: 4,
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {vaultRoot || "(not set)"}
          </code>
          <button
            type="button"
            onClick={() => void pickVaultRoot()}
            data-testid="obsidian-pick-vault-root"
            style={pickButton}
          >
            Pick…
          </button>
        </div>
      </Row>

      <Row label="Subfolder (optional)">
        <div
          style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}
        >
          <code
            data-testid="obsidian-subfolder-display"
            style={{
              flex: 1,
              padding: "4px 6px",
              background: "var(--surface, #18191c)",
              border: "1px solid var(--outline-variant, #2a2c30)",
              borderRadius: 4,
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: subfolder ? 1 : 0.6,
            }}
          >
            {subfolder || "(whole vault)"}
          </code>
          <button
            type="button"
            onClick={() => void pickSubfolder()}
            disabled={!vaultRoot}
            data-testid="obsidian-pick-subfolder"
            style={{
              ...pickButton,
              opacity: vaultRoot ? 1 : 0.5,
              cursor: vaultRoot ? "pointer" : "not-allowed",
            }}
          >
            Pick…
          </button>
          {subfolder && (
            <button
              type="button"
              onClick={() => setSubfolder("")}
              data-testid="obsidian-clear-subfolder"
              style={pickButton}
            >
              Clear
            </button>
          )}
        </div>
      </Row>

      <label
        style={{
          fontSize: 12,
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        <input
          type="checkbox"
          checked={followSymlinks}
          data-testid="obsidian-follow-symlinks"
          onChange={(e) => setFollowSymlinks(e.target.checked)}
        />
        Follow symlinks (off by default — symlinks pointing outside the
        vault are blocked)
      </label>

      {error && (
        <div
          data-testid="obsidian-error"
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
      {warning && !error && (
        <div
          data-testid="obsidian-warning"
          style={{
            fontSize: 12,
            color: "#f0c674",
            background: "rgba(240, 198, 116, 0.06)",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          {warning}
        </div>
      )}
      {savedAt && !error && !warning && (
        <div data-testid="obsidian-saved" style={{ fontSize: 12, opacity: 0.7 }}>
          Saved.
        </div>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !vaultRoot.trim()}
          data-testid="obsidian-save"
          style={{
            fontSize: 12,
            background: "var(--primary, #4f9eff)",
            border: 0,
            color: "white",
            padding: "4px 10px",
            borderRadius: 4,
            cursor: busy || !vaultRoot.trim() ? "not-allowed" : "pointer",
            opacity: busy || !vaultRoot.trim() ? 0.5 : 1,
          }}
        >
          {busy ? "Saving…" : config ? "Update binding" : "Save binding"}
        </button>
      </div>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.8 }}>{label}</span>
      {children}
    </div>
  );
}

const pickButton: React.CSSProperties = {
  fontSize: 11,
  background: "transparent",
  border: "1px solid var(--outline-variant, #2a2c30)",
  color: "inherit",
  padding: "4px 8px",
  borderRadius: 4,
  cursor: "pointer",
};

/** Compute a vault-root-relative form of a picked path, or `null` if
 *  the picked path isn't under the root (the Rust side will reject
 *  cross-root picks, so the UI falls back to the absolute form). */
function relativeUnder(root: string, picked: string): string | null {
  const r = root.endsWith("/") || root.endsWith("\\") ? root : root + "/";
  if (picked.startsWith(r)) {
    return picked.slice(r.length);
  }
  // Try the Windows backslash form too.
  const rb = root.endsWith("\\") ? root : root + "\\";
  if (picked.startsWith(rb)) {
    return picked.slice(rb.length);
  }
  return null;
}

export default ObsidianChannelEditor;
