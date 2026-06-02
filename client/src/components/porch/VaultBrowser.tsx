/**
 * Phase D — visitor-side Obsidian vault browser.
 *
 * Renders a two-pane layout:
 *
 *  - Left: a directory tree, fetched lazily via `porch_visit_list_vault`.
 *    Clicking a directory expands it; clicking a file selects it.
 *  - Right: the selected file's content. Markdown renders via
 *    `react-markdown` + `remark-gfm`. Plain text renders inside a
 *    `<pre>`. Images render as a `<img>` from a blob URL. PDFs render
 *    inside an `<iframe>` from a blob URL. Anything else (or a file
 *    over the 5 MiB cap) renders a friendly placeholder.
 *
 * Read-only by design — Phase D doesn't write to vaults. Wikilinks
 * (`[[Note Title]]`) render as plain text styled links but don't yet
 * resolve to a target file; the design doc flags wikilink resolution
 * as a Phase D follow-up.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  porchVisitGetVaultFile,
  porchVisitListVault,
  type VaultEntry,
  type VaultFileResponse,
} from "../../api/porch";

// react-markdown is ~50 KB raw — lazy-load it inside the browser so
// the porch-management chunk that opens for owners (no vault browsing)
// doesn't pay the cost. The renderer is only mounted on demand.
const MarkdownView = lazy(() => import("./vaultMarkdown"));

export interface VaultBrowserProps {
  /** PeerId of the host running the obsidian-bound channel. */
  peerId: string;
  channelId: string;
  channelName?: string;
}

interface DirState {
  loading: boolean;
  entries: VaultEntry[];
  error: string | null;
}

export function VaultBrowser({
  peerId,
  channelId,
  channelName,
}: VaultBrowserProps) {
  // Path => directory state. Empty string ("") = effective root.
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  // Which directories are expanded in the tree. Root is always shown.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "": true });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileResp, setFileResp] = useState<VaultFileResponse | null>(null);
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // Active blob URLs we created; revoke on unmount + on change to
  // avoid memory leaks.
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
      blobUrlsRef.current = [];
    };
  }, []);

  // Initial load of the root.
  useEffect(() => {
    void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, channelId]);

  const loadDir = async (path: string) => {
    setDirs((prev) => ({
      ...prev,
      [path]: { loading: true, entries: prev[path]?.entries ?? [], error: null },
    }));
    try {
      const entries = await porchVisitListVault(peerId, channelId, path);
      setDirs((prev) => ({
        ...prev,
        [path]: { loading: false, entries, error: null },
      }));
    } catch (e) {
      setDirs((prev) => ({
        ...prev,
        [path]: {
          loading: false,
          entries: prev[path]?.entries ?? [],
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  };

  const toggleDir = async (path: string) => {
    const wasExpanded = !!expanded[path];
    setExpanded((prev) => ({ ...prev, [path]: !wasExpanded }));
    if (!wasExpanded && !dirs[path]) {
      await loadDir(path);
    }
  };

  const selectFile = async (path: string) => {
    setSelectedPath(path);
    setFileResp(null);
    setFileError(null);
    setFileLoading(true);
    try {
      const resp = await porchVisitGetVaultFile(peerId, channelId, path);
      setFileResp(resp);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setFileLoading(false);
    }
  };

  return (
    <div
      data-testid="vault-browser"
      style={{
        display: "flex",
        height: "100%",
        width: "100%",
        background: "var(--surface, #18191c)",
        color: "var(--on-surface, #e3e4e6)",
      }}
    >
      <aside
        style={{
          width: 260,
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
            opacity: 0.8,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {channelName ?? "Vault"}
        </div>
        <TreeView
          path=""
          dirs={dirs}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={toggleDir}
          onSelectFile={selectFile}
        />
      </aside>

      <section
        style={{
          flex: 1,
          minWidth: 0,
          padding: 16,
          overflowY: "auto",
        }}
        data-testid="vault-file-pane"
      >
        {selectedPath === null && (
          <div style={{ opacity: 0.6, fontStyle: "italic", fontSize: 13 }}>
            Pick a note on the left.
          </div>
        )}
        {fileLoading && (
          <div
            data-testid="vault-file-loading"
            style={{ opacity: 0.6, fontSize: 13 }}
          >
            Loading…
          </div>
        )}
        {fileError && (
          <div
            data-testid="vault-file-error"
            style={{
              fontSize: 13,
              color: "var(--error, #e57373)",
              background: "rgba(229, 115, 115, 0.06)",
              padding: 8,
              borderRadius: 4,
            }}
          >
            {fileError}
          </div>
        )}
        {fileResp && (
          <RenderedFile
            response={fileResp}
            peerId={peerId}
            channelId={channelId}
            onRegisterBlob={(u) => blobUrlsRef.current.push(u)}
          />
        )}
      </section>
    </div>
  );
}

interface TreeViewProps {
  path: string;
  dirs: Record<string, DirState>;
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  onToggle: (path: string) => void | Promise<void>;
  onSelectFile: (path: string) => void | Promise<void>;
}

function TreeView(props: TreeViewProps) {
  const { path, dirs, expanded, selectedPath, onToggle, onSelectFile } = props;
  const state = dirs[path];
  if (!state) return null;
  if (state.loading && state.entries.length === 0) {
    return (
      <div
        data-testid={`vault-dir-loading-${path}`}
        style={{ padding: "4px 12px", fontSize: 12, opacity: 0.6 }}
      >
        Loading…
      </div>
    );
  }
  if (state.error) {
    return (
      <div
        data-testid={`vault-dir-error-${path}`}
        style={{
          padding: "4px 12px",
          fontSize: 12,
          color: "var(--error, #e57373)",
        }}
      >
        {state.error}
      </div>
    );
  }
  if (state.entries.length === 0) {
    return (
      <div
        data-testid={`vault-dir-empty-${path}`}
        style={{ padding: "4px 12px", fontSize: 12, opacity: 0.5, fontStyle: "italic" }}
      >
        Empty.
      </div>
    );
  }
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {state.entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          dirs={dirs}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelectFile={onSelectFile}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  dirs,
  expanded,
  selectedPath,
  onToggle,
  onSelectFile,
}: {
  entry: VaultEntry;
} & Omit<TreeViewProps, "path">) {
  const isDir = entry.kind === "directory";
  const isExpanded = !!expanded[entry.path];
  const isSelected = !isDir && selectedPath === entry.path;
  const leaf = entry.path.includes("/")
    ? entry.path.slice(entry.path.lastIndexOf("/") + 1)
    : entry.path;

  return (
    <li>
      <button
        type="button"
        onClick={() => (isDir ? void onToggle(entry.path) : void onSelectFile(entry.path))}
        data-testid={
          isDir ? `vault-dir-${entry.path}` : `vault-file-${entry.path}`
        }
        style={{
          width: "100%",
          textAlign: "left",
          background: isSelected
            ? "var(--surface-container-high, #2a2d32)"
            : "transparent",
          color: "inherit",
          border: 0,
          padding: "4px 12px",
          fontSize: 13,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ opacity: 0.7, fontSize: 11, width: 12 }} aria-hidden>
          {isDir ? (isExpanded ? "▾" : "▸") : "·"}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {leaf}
        </span>
      </button>
      {isDir && isExpanded && (
        <div style={{ paddingLeft: 14 }}>
          <TreeView
            path={entry.path}
            dirs={dirs}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
          />
        </div>
      )}
    </li>
  );
}

function RenderedFile({
  response,
  peerId,
  channelId,
  onRegisterBlob,
}: {
  response: VaultFileResponse;
  peerId: string;
  channelId: string;
  onRegisterBlob: (u: string) => void;
}) {
  if (response.kind === "too_large") {
    return (
      <div
        data-testid="vault-file-too-large"
        style={{
          fontSize: 13,
          padding: 12,
          background: "var(--surface-container, #1f2125)",
          border: "1px solid var(--outline-variant, #2a2c30)",
          borderRadius: 6,
        }}
      >
        This file is too large to preview here ({formatBytes(response.size)} of{" "}
        {response.mime_type}) — ask the owner to share it directly.
      </div>
    );
  }
  const mime = response.mime_type;
  if (mime === "text/markdown") {
    const text = useMemo(() => decodeBase64Utf8(response.bytes_b64), [response.bytes_b64]);
    return (
      <div data-testid="vault-file-markdown">
        <Suspense fallback={<div style={{ opacity: 0.7 }}>Rendering…</div>}>
          <MarkdownView
            markdown={text}
            peerId={peerId}
            channelId={channelId}
            onRegisterBlob={onRegisterBlob}
          />
        </Suspense>
      </div>
    );
  }
  if (mime === "text/plain") {
    const text = decodeBase64Utf8(response.bytes_b64);
    return (
      <pre
        data-testid="vault-file-text"
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 13,
          padding: 12,
          background: "var(--surface-container, #1f2125)",
          borderRadius: 6,
          margin: 0,
        }}
      >
        {text}
      </pre>
    );
  }
  if (mime.startsWith("image/")) {
    const url = decodeBase64ToBlobUrl(response.bytes_b64, mime);
    onRegisterBlob(url);
    return (
      <img
        data-testid="vault-file-image"
        src={url}
        alt={response.path}
        style={{ maxWidth: "100%", height: "auto", borderRadius: 6 }}
      />
    );
  }
  if (mime === "application/pdf") {
    const url = decodeBase64ToBlobUrl(response.bytes_b64, mime);
    onRegisterBlob(url);
    return (
      <iframe
        data-testid="vault-file-pdf"
        title={response.path}
        src={url}
        style={{ width: "100%", height: "80vh", border: 0, borderRadius: 6 }}
      />
    );
  }
  return (
    <div
      data-testid="vault-file-unsupported"
      style={{
        fontSize: 13,
        padding: 12,
        background: "var(--surface-container, #1f2125)",
        border: "1px solid var(--outline-variant, #2a2c30)",
        borderRadius: 6,
      }}
    >
      Can't preview this file type ({mime}). Ask the owner to share it directly.
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function decodeBase64Utf8(b64: string): string {
  // `atob` returns a binary string; pipe through TextDecoder for
  // proper UTF-8 handling.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeBase64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  return URL.createObjectURL(blob);
}

export default VaultBrowser;
