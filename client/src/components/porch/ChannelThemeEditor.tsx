/**
 * Porch Phase C — owner-side per-channel theme editor.
 *
 * Lives inside `PorchManagement` (the existing porch modal). The user
 * picks a channel, this editor renders color pickers + a font dropdown
 * + a background tab strip + a live preview, and a Save button calls
 * `porchSetTheme`.
 *
 * The editor is self-contained — the parent only needs to pass the
 * channel to edit (and optionally an `onSaved` callback if it wants to
 * react after a successful save).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  defaultChannelTheme,
  porchGetTheme,
  porchSetTheme,
  porchUploadAsset,
  type Background,
  type ChannelTheme,
  type FontFamily,
  type PorchAsset,
} from "../../api/porch";
import { applyTheme, passesContrastFloor } from "./themeRenderer";

const FONT_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: "system", label: "System sans-serif" },
  { value: "serif", label: "Serif (campaign / lore)" },
  { value: "mono", label: "Mono (terminal vibes)" },
  { value: "display", label: "Display (loud header)" },
];

const BG_TABS: { value: Background["kind"]; label: string }[] = [
  { value: "none", label: "None" },
  { value: "solid", label: "Solid" },
  { value: "gradient", label: "Gradient" },
  { value: "image", label: "Image" },
];

export interface ChannelThemeEditorProps {
  channelId: string;
  channelName: string;
  /** Called after a successful save with the persisted theme. */
  onSaved?: (theme: ChannelTheme) => void;
}

export function ChannelThemeEditor({
  channelId,
  channelName,
  onSaved,
}: ChannelThemeEditorProps) {
  const [theme, setTheme] = useState<ChannelTheme>(() =>
    defaultChannelTheme(channelId),
  );
  const [originalTheme, setOriginalTheme] = useState<ChannelTheme | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [uploads, setUploads] = useState<PorchAsset[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Gradient editor state — derived from the gradient string for UX,
  // not persisted independently.
  const [gradientStart, setGradientStart] = useState("#1a1a2a");
  const [gradientEnd, setGradientEnd] = useState("#3a1a4a");
  const [gradientAngle, setGradientAngle] = useState(135);

  // Load the persisted theme on mount + when the channel changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    porchGetTheme(channelId)
      .then((t) => {
        setTheme(t);
        setOriginalTheme(t);
        if (t.background.kind === "gradient") {
          // Best-effort parse so the gradient controls reflect the
          // saved string. The parse is forgiving — failure just leaves
          // the controls at their defaults.
          const m = t.background.value.match(
            /linear-gradient\(\s*(\d+)deg\s*,\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/,
          );
          if (m) {
            setGradientAngle(Number(m[1]));
            setGradientStart(m[2]);
            setGradientEnd(m[3]);
          }
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [channelId]);

  // Refresh the assets list whenever the channel changes (or after a
  // new upload).
  useEffect(() => {
    void refreshAssets(channelId).then(setUploads).catch(() => undefined);
  }, [channelId]);

  const dirty = useMemo(() => {
    if (!originalTheme) return false;
    return JSON.stringify(originalTheme) !== JSON.stringify(theme);
  }, [originalTheme, theme]);

  const contrastOk = passesContrastFloor(theme);

  // Stable callback: clone+patch helper so individual control handlers
  // stay terse.
  const patch = (mut: Partial<ChannelTheme>) =>
    setTheme((prev) => ({ ...prev, ...mut }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await porchSetTheme(theme);
      setTheme(saved);
      setOriginalTheme(saved);
      setSavedAt(Date.now());
      onSaved?.(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    const fresh = defaultChannelTheme(channelId);
    setTheme(fresh);
  };

  const handleUpload = async (file: File) => {
    setError(null);
    try {
      const arrayBuf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(arrayBuf);
      const asset = await porchUploadAsset(channelId, file.type, b64);
      setUploads((prev) => [...prev, asset]);
      // Auto-bind the new asset as the background.
      patch({ background: { kind: "image", value: { asset_id: asset.id } } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleBgTab = (kind: Background["kind"]) => {
    switch (kind) {
      case "none":
        patch({ background: { kind: "none" } });
        break;
      case "solid":
        patch({ background: { kind: "solid", value: theme.surface_color } });
        break;
      case "gradient": {
        const value = composeGradient(gradientAngle, gradientStart, gradientEnd);
        patch({ background: { kind: "gradient", value } });
        break;
      }
      case "image":
        // No-op if no asset chosen yet — surface a hint instead.
        if (uploads.length > 0) {
          patch({
            background: { kind: "image", value: { asset_id: uploads[0].id } },
          });
        } else {
          patch({
            background: {
              kind: "image",
              value: { asset_id: "" },
            },
          });
        }
        break;
    }
  };

  const updateGradient = (next: {
    angle?: number;
    start?: string;
    end?: string;
  }) => {
    const a = next.angle ?? gradientAngle;
    const s = next.start ?? gradientStart;
    const e = next.end ?? gradientEnd;
    if (next.angle !== undefined) setGradientAngle(a);
    if (next.start !== undefined) setGradientStart(s);
    if (next.end !== undefined) setGradientEnd(e);
    patch({ background: { kind: "gradient", value: composeGradient(a, s, e) } });
  };

  if (loading) {
    return (
      <div data-testid="theme-editor-loading" style={{ padding: 12, fontSize: 12 }}>
        Loading theme…
      </div>
    );
  }

  return (
    <section
      data-testid="channel-theme-editor"
      style={{
        background: "var(--surface-container, #1f2125)",
        border: "1px solid var(--outline-variant, #2a2c30)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <header
        style={{
          fontSize: 12,
          fontWeight: 600,
          opacity: 0.8,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>Theme · {channelName}</span>
        {savedAt && !dirty && (
          <span
            data-testid="theme-saved-badge"
            style={{
              marginLeft: "auto",
              fontSize: 10,
              opacity: 0.7,
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            Saved
          </span>
        )}
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <ColorPickerRow
          label="Primary"
          value={theme.primary_color}
          onChange={(v) => patch({ primary_color: v })}
          testId="color-primary"
        />
        <ColorPickerRow
          label="Surface"
          value={theme.surface_color}
          onChange={(v) => patch({ surface_color: v })}
          testId="color-surface"
        />
        <ColorPickerRow
          label="On surface"
          value={theme.on_surface_color}
          onChange={(v) => patch({ on_surface_color: v })}
          testId="color-on-surface"
        />
        <ColorPickerRow
          label="Accent"
          value={theme.accent_color}
          onChange={(v) => patch({ accent_color: v })}
          testId="color-accent"
        />
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
        <span style={{ opacity: 0.8 }}>Font:</span>
        <select
          data-testid="font-family-select"
          value={theme.font_family}
          onChange={(e) => patch({ font_family: e.target.value as FontFamily })}
          style={{
            flex: 1,
            padding: "4px 6px",
            borderRadius: 4,
            border: "1px solid var(--outline-variant, #2a2c30)",
            background: "var(--surface, #18191c)",
            color: "inherit",
            fontSize: 12,
          }}
        >
          {FONT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {/* Background tab strip + per-tab controls */}
      <div
        role="tablist"
        aria-label="Background style"
        style={{ display: "flex", gap: 4 }}
      >
        {BG_TABS.map((tab) => {
          const active = theme.background.kind === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => handleBgTab(tab.value)}
              data-testid={`bg-tab-${tab.value}`}
              style={{
                flex: 1,
                padding: "4px 6px",
                fontSize: 11,
                background: active
                  ? "var(--primary, #4f9eff)"
                  : "transparent",
                color: active ? "white" : "inherit",
                border: "1px solid var(--outline-variant, #2a2c30)",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {theme.background.kind === "solid" && (
        <ColorPickerRow
          label="Solid color"
          value={theme.background.value}
          onChange={(v) => patch({ background: { kind: "solid", value: v } })}
          testId="bg-solid-color"
        />
      )}

      {theme.background.kind === "gradient" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <ColorPickerRow
              label="Gradient start"
              value={gradientStart}
              onChange={(v) => updateGradient({ start: v })}
              testId="bg-gradient-start"
            />
            <ColorPickerRow
              label="Gradient end"
              value={gradientEnd}
              onChange={(v) => updateGradient({ end: v })}
              testId="bg-gradient-end"
            />
          </div>
          <label style={{ fontSize: 11, opacity: 0.8 }}>
            Angle: {gradientAngle}°
            <input
              type="range"
              min={0}
              max={359}
              step={1}
              value={gradientAngle}
              onChange={(e) => updateGradient({ angle: Number(e.target.value) })}
              style={{ width: "100%" }}
              aria-label="Gradient angle"
            />
          </label>
        </div>
      )}

      {theme.background.kind === "image" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              data-testid="bg-image-upload-button"
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                background: "var(--primary, #4f9eff)",
                color: "white",
                border: 0,
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Upload image
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              data-testid="bg-image-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
              }}
              style={{ display: "none" }}
            />
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              PNG / JPEG / WebP / GIF up to 5 MiB
            </span>
          </div>
          {uploads.length === 0 ? (
            <div style={{ fontSize: 11, opacity: 0.6, fontStyle: "italic" }}>
              No images uploaded yet.
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {uploads.map((a) => {
                const selected =
                  theme.background.kind === "image" &&
                  theme.background.value.asset_id === a.id;
                return (
                  <button
                    type="button"
                    key={a.id}
                    data-testid={`bg-image-asset-${a.id}`}
                    onClick={() =>
                      patch({
                        background: {
                          kind: "image",
                          value: { asset_id: a.id },
                        },
                      })
                    }
                    title={`${a.mime_type} · ${Math.round(a.bytes / 1024)} KiB`}
                    style={{
                      width: 56,
                      height: 56,
                      padding: 0,
                      border: selected
                        ? "2px solid var(--primary, #4f9eff)"
                        : "1px solid var(--outline-variant, #2a2c30)",
                      background: "#000",
                      color: "var(--on-surface, #e3e4e6)",
                      cursor: "pointer",
                      fontSize: 9,
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    {a.id.slice(0, 6)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!contrastOk && (
        <div
          data-testid="contrast-warning"
          style={{
            fontSize: 11,
            color: "#ffb066",
            background: "rgba(255, 176, 102, 0.08)",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          Text-against-surface contrast is low. Pick a brighter
          on-surface color for readability.
        </div>
      )}

      {/* Live preview */}
      <div
        data-testid="theme-live-preview"
        style={{
          ...applyTheme(theme),
          borderRadius: 8,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minHeight: 120,
          border: "1px solid var(--outline-variant, #2a2c30)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            opacity: 0.7,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Preview
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "4px 8px",
              borderRadius: 4,
              background: theme.primary_color,
              color: "#fff",
              fontSize: 12,
              fontFamily: "inherit",
            }}
          >
            Primary call-to-action
          </div>
          <div style={{ fontSize: 13, fontFamily: "inherit" }}>
            Quick brown fox jumps over the lazy dog.
          </div>
          <div
            style={{
              fontSize: 12,
              opacity: 0.85,
              color: theme.accent_color,
              fontFamily: "inherit",
            }}
          >
            Accent tone — hyperlinks, mentions, hover states.
          </div>
        </div>
      </div>

      {error && (
        <div
          data-testid="theme-editor-error"
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

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          data-testid="theme-save-button"
          style={{
            padding: "6px 14px",
            fontSize: 12,
            background: "var(--primary, #4f9eff)",
            color: "white",
            border: 0,
            borderRadius: 4,
            cursor: saving || !dirty ? "not-allowed" : "pointer",
            opacity: saving || !dirty ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save theme"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          data-testid="theme-reset-button"
          style={{
            padding: "6px 14px",
            fontSize: 12,
            background: "transparent",
            color: "inherit",
            border: "1px solid var(--outline-variant, #2a2c30)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Reset to defaults
        </button>
      </div>
    </section>
  );
}

function ColorPickerRow({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        opacity: 0.9,
      }}
    >
      <span style={{ minWidth: 80 }}>{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        style={{
          width: 28,
          height: 24,
          padding: 0,
          background: "transparent",
          border: 0,
          cursor: "pointer",
        }}
      />
      <code
        style={{
          fontSize: 10,
          opacity: 0.7,
          fontFamily: "monospace",
        }}
      >
        {value}
      </code>
    </label>
  );
}

function composeGradient(angle: number, start: string, end: string): string {
  return `linear-gradient(${angle}deg, ${start}, ${end})`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // chunk to avoid stack-blowing on multi-MB files.
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function refreshAssets(channelId: string): Promise<PorchAsset[]> {
  const mod = await import("../../api/porch");
  return await mod.porchListAssets(channelId);
}

export default ChannelThemeEditor;
