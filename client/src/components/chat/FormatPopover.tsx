import { useRef, useEffect } from "react";
import type { FormatOverride } from "../../stores/format";

const ALIGNMENT_OPTIONS: { value: FormatOverride["alignment"]; icon: string; label: string }[] = [
  { value: "left", icon: "format_align_left", label: "Left" },
  { value: "center", icon: "format_align_center", label: "Center" },
  { value: "right", icon: "format_align_right", label: "Right" },
  { value: "justify", icon: "format_align_justify", label: "Justify" },
];

const FONT_FAMILIES = ["system", "serif", "mono"] as const;
const FONT_LABELS: Record<string, string> = {
  system: "System",
  serif: "Serif",
  mono: "Monospace",
};

const COLOR_PRESETS = ["", "#e5e7eb", "#7c5cfc", "#10b981", "#f59e0b", "#ef4444", "#3b82f6"];
const COLOR_LABELS: Record<string, string> = {
  "": "Default",
  "#e5e7eb": "Light",
  "#7c5cfc": "Purple",
  "#10b981": "Green",
  "#f59e0b": "Amber",
  "#ef4444": "Red",
  "#3b82f6": "Blue",
};

interface FormatPopoverProps {
  value: FormatOverride;
  onChange: (fmt: Partial<FormatOverride>) => void;
  onClose: () => void;
  viewerMode?: {
    scope: "message" | "sender";
    senderName: string;
    onScopeChange: (scope: "message" | "sender") => void;
    onReset: () => void;
  };
}

export function FormatPopover({ value, onChange, onClose, viewerMode }: FormatPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="w-[260px] glass-panel rounded-2xl p-3 space-y-3 shadow-2xl z-50"
    >
      <p className="text-[10px] uppercase tracking-wider text-on-surface-variant font-label">
        Message Display
      </p>

      {/* Alignment */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-on-surface-variant w-14">Align</span>
        <div className="flex gap-1">
          {ALIGNMENT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange({ alignment: opt.value })}
              title={opt.label}
              className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
                value.alignment === opt.value
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined text-sm">{opt.icon}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Font size */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-on-surface-variant w-14">Size</span>
        <input
          type="range"
          min={12}
          max={32}
          step={1}
          value={value.fontSize}
          onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          className="flex-1 accent-primary"
        />
        <span className="text-[10px] text-on-surface-variant w-6 text-right">{value.fontSize}</span>
      </div>

      {/* Text color */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-on-surface-variant w-14">Color</span>
        <div className="flex gap-1.5 flex-wrap">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c || "default"}
              type="button"
              title={COLOR_LABELS[c] ?? c}
              onClick={() => onChange({ color: c })}
              className={`w-4 h-4 rounded-full border transition-all ${
                value.color === c ? "border-white scale-110" : "border-transparent"
              }`}
              style={{
                background: c || "var(--color-on-surface)",
                opacity: c ? 1 : 0.4,
              }}
            />
          ))}
        </div>
      </div>

      {/* Font family */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-on-surface-variant w-14">Font</span>
        <select
          value={value.fontFamily}
          onChange={(e) => onChange({ fontFamily: e.target.value })}
          className="flex-1 bg-surface-container-high rounded-lg px-2 py-1 text-xs text-on-surface border-none outline-none"
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>{FONT_LABELS[f]}</option>
          ))}
        </select>
      </div>

      {/* Viewer-mode scope + reset */}
      {viewerMode && (
        <div className="pt-2 border-t border-outline-variant/20 space-y-2">
          <div className="flex rounded-lg overflow-hidden border border-outline-variant/20">
            <button
              type="button"
              onClick={() => viewerMode.onScopeChange("message")}
              className={`flex-1 text-[10px] py-1 transition-colors ${
                viewerMode.scope === "message"
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
              }`}
            >
              This message
            </button>
            <button
              type="button"
              onClick={() => viewerMode.onScopeChange("sender")}
              className={`flex-1 text-[10px] py-1 transition-colors ${
                viewerMode.scope === "sender"
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
              }`}
            >
              All from {viewerMode.senderName}
            </button>
          </div>
          <button
            type="button"
            onClick={viewerMode.onReset}
            className="w-full text-[10px] text-error hover:text-error/80 transition-colors text-left"
          >
            Reset to sender default
          </button>
        </div>
      )}
    </div>
  );
}
