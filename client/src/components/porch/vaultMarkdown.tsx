/**
 * Phase D — lazy-loaded markdown renderer for the visitor's vault
 * browser. Split out so `react-markdown` + `remark-gfm` only pull
 * into the bundle when the visitor actually opens a markdown note.
 *
 * Wikilinks (`[[Note Title]]`) are detected via a pre-processing
 * regex and rendered as plain styled text — following the link is
 * deferred to a Phase D follow-up (see design doc).
 *
 * Embedded images (`![alt](path/to/img.png)`) are resolved via the
 * existing `porch_visit_get_vault_file` envelope: paths relative to
 * the markdown file's location are fetched as blob URLs. Anything
 * over the 256 KiB inline cap surfaces a placeholder.
 */

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { porchVisitGetVaultFile } from "../../api/porch";

export interface MarkdownViewProps {
  markdown: string;
  peerId: string;
  channelId: string;
  /** Path of the file being rendered, relative to the effective vault
   *  root. Used to resolve relative image paths inside the markdown.
   *  Optional; if absent, image paths are resolved relative to the
   *  effective root. */
  filePath?: string;
  onRegisterBlob: (url: string) => void;
}

export default function MarkdownView({
  markdown,
  peerId,
  channelId,
  filePath,
  onRegisterBlob,
}: MarkdownViewProps) {
  // Pre-process wikilinks: replace `[[X]]` and `[[X|Y]]` with
  // `<span class="porch-wikilink">Y</span>` so the renderer can
  // surface them. We don't resolve targets in Phase D.
  const preprocessed = wikilinkToSpan(markdown);

  return (
    <div
      className="porch-vault-markdown"
      data-testid="vault-markdown-rendered"
      style={{ fontSize: 14, lineHeight: 1.55 }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: (imgProps) => (
            <VaultImage
              src={typeof imgProps.src === "string" ? imgProps.src : ""}
              alt={imgProps.alt ?? ""}
              peerId={peerId}
              channelId={channelId}
              filePath={filePath}
              onRegisterBlob={onRegisterBlob}
            />
          ),
          a: (aProps) => {
            const href = typeof aProps.href === "string" ? aProps.href : "#";
            if (href === "#wikilink") {
              // Phase D — wikilink: render as plain styled text. The
              // design doc explicitly defers link resolution.
              return (
                <span
                  className="porch-wikilink"
                  data-testid="vault-wikilink"
                  style={{
                    color: "var(--accent, #7c4dff)",
                    borderBottom: "1px dotted currentColor",
                  }}
                >
                  {aProps.children}
                </span>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: "var(--primary, #4f9eff)" }}
              >
                {aProps.children}
              </a>
            );
          },
        }}
      >
        {preprocessed}
      </ReactMarkdown>
    </div>
  );
}

function VaultImage({
  src,
  alt,
  peerId,
  channelId,
  filePath,
  onRegisterBlob,
}: {
  src: string;
  alt: string;
  peerId: string;
  channelId: string;
  filePath?: string;
  onRegisterBlob: (url: string) => void;
}) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [errored, setErrored] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const isExternal =
      src.startsWith("http://") ||
      src.startsWith("https://") ||
      src.startsWith("data:") ||
      src.startsWith("blob:");
    if (isExternal) {
      setResolved(src);
      return;
    }
    const resolvedPath = resolveRelative(filePath, src);
    void (async () => {
      try {
        const resp = await porchVisitGetVaultFile(
          peerId,
          channelId,
          resolvedPath,
        );
        if (cancelled) return;
        if (resp.kind === "too_large") {
          setErrored(true);
          return;
        }
        const bin = atob(resp.bytes_b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: resp.mime_type });
        const url = URL.createObjectURL(blob);
        onRegisterBlob(url);
        setResolved(url);
      } catch {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, peerId, channelId, filePath, onRegisterBlob]);

  if (errored) {
    return (
      <span
        style={{
          fontSize: 12,
          fontStyle: "italic",
          opacity: 0.7,
          padding: "2px 6px",
          background: "var(--surface-container, #1f2125)",
          borderRadius: 4,
        }}
      >
        (image not available: {src})
      </span>
    );
  }
  if (!resolved) {
    return <span style={{ opacity: 0.5 }}>(loading {src})</span>;
  }
  return (
    <img
      src={resolved}
      alt={alt}
      style={{ maxWidth: "100%", height: "auto", borderRadius: 6 }}
    />
  );
}

/** Resolve `target` relative to `filePath`'s directory. If
 *  `filePath` is undefined, target is taken as already-relative-to-root. */
function resolveRelative(filePath: string | undefined, target: string): string {
  if (!filePath) return stripLeadingSlash(target);
  if (target.startsWith("/")) return stripLeadingSlash(target);
  const dir = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";
  // Collapse `..` segments — the Rust side rejects unresolved `..` so
  // we collapse here to keep the wire payload clean.
  const parts: string[] = [];
  for (const seg of (dir ? dir.split("/") : []).concat(target.split("/"))) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

/** Transform `[[Target]]` and `[[Target|Display]]` into a non-clickable
 *  markdown link so react-markdown surfaces them as styled text without
 *  needing rehype-raw. The link's href is the empty fragment `#` and
 *  the custom `a` component overrides it to render a plain styled
 *  span — Phase D explicitly does NOT resolve wikilinks (see the
 *  design doc's deferred-features section). */
function wikilinkToSpan(input: string): string {
  return input.replace(/\[\[([^\]\n]+?)\]\]/g, (_match, inner) => {
    const text = String(inner).includes("|")
      ? String(inner).split("|")[1].trim()
      : String(inner).trim();
    // The escapes here ensure `[Display]` doesn't itself get parsed
    // as a footnote / image / etc.
    return `[${text}](#wikilink)`;
  });
}
