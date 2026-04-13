/**
 * AppearanceTab — user-configurable visual preferences.
 *
 * Today this tab exposes a single control: **chat body text size** in
 * absolute pixels. The preference is persisted via
 * `useSettingsStore.chatFontSize` and wired into the live DOM by the
 * effect in `App.tsx`, which mirrors the value onto the
 * `--concord-chat-font-size` CSS variable. `.concord-message-body` in
 * `index.css` reads the variable, so the size updates without
 * re-rendering the message tree.
 *
 * Scope boundary: this tab deliberately only adjusts chat body prose
 * font-size. It does NOT scale UI chrome (sidebars, buttons, headings,
 * code blocks) because the goal is "big, readable chat text inside a
 * normal-sized interface" — a global zoom was explicitly rejected by
 * the user when this feature was scoped.
 *
 * Accessibility: the slider has a paired numeric input for users who
 * want a specific value, and a "Reset" button that returns to the
 * 14px default. The live preview renders a sample paragraph using
 * the same font family as real chat messages so the user can judge
 * the size without leaving settings.
 */
import { useCallback } from "react";
import {
  useSettingsStore,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_DEFAULT,
  THEME_PRESETS,
  type ThemePreset,
} from "../../stores/settings";
import { Slider } from "../ui/Slider";

/**
 * Sample prose used in the live preview pane. Chosen to include
 * descenders (g, p, y), ascenders (b, d, h, l), and a mix of
 * uppercase and lowercase so the user can judge line-height and
 * stroke weight at the selected size — not just glyph width.
 */
const PREVIEW_SAMPLE =
  "The quick brown fox jumps over the lazy dog. A wizard's job is to vex chumps quickly in fog.";

const THEME_META: Record<ThemePreset, {
  label: string;
  description: string;
  swatches: [string, string, string];
}> = {
  "kinetic-node": {
    label: "Kinetic Node",
    description: "Indigo, mint, graphite.",
    swatches: ["#a4a5ff", "#afefdd", "#171a1d"],
  },
  "verdant-signal": {
    label: "Verdant Signal",
    description: "Emerald, ice blue, deep pine.",
    swatches: ["#7de0b7", "#8bc8ff", "#17211f"],
  },
  "ember-circuit": {
    label: "Ember Circuit",
    description: "Copper, amber, charcoal.",
    swatches: ["#ff9a6b", "#ffd66e", "#231c18"],
  },
  "arctic-current": {
    label: "Arctic Current",
    description: "Sky, aqua, slate.",
    swatches: ["#7bc8ff", "#91f0d0", "#182027"],
  },
};

export function AppearanceTab() {
  const chatFontSize = useSettingsStore((s) => s.chatFontSize);
  const setChatFontSize = useSettingsStore((s) => s.setChatFontSize);
  const themePreset = useSettingsStore((s) => s.themePreset);
  const setThemePreset = useSettingsStore((s) => s.setThemePreset);

  // The numeric input is a plain controlled `<input type="number">`;
  // we forward every change through `setChatFontSize`, which clamps
  // non-finite and out-of-range values so invalid keystrokes can't
  // corrupt persisted state.
  const onNumericChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const parsed = parseInt(e.target.value, 10);
      if (Number.isNaN(parsed)) return;
      setChatFontSize(parsed);
    },
    [setChatFontSize],
  );

  const onReset = useCallback(() => {
    setChatFontSize(CHAT_FONT_SIZE_DEFAULT);
  }, [setChatFontSize]);

  const isDefault = chatFontSize === CHAT_FONT_SIZE_DEFAULT;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-headline font-semibold text-on-surface mb-1">
          Appearance
        </h2>
        <p className="text-sm text-on-surface-variant">
          Adjust how chat messages are rendered. These settings only affect
          message body text — sidebars, buttons, and other interface elements
          are unchanged.
        </p>
      </div>

      <section
        aria-labelledby="chat-font-size-heading"
        className="flex flex-col gap-3"
      >
        <div className="flex items-baseline justify-between">
          <h3
            id="chat-font-size-heading"
            className="text-sm font-medium text-on-surface"
          >
            Chat text size
          </h3>
          <button
            type="button"
            onClick={onReset}
            disabled={isDefault}
            className="btn-press text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="chat-font-size-reset"
          >
            Reset to default
          </button>
        </div>

        <Slider
          label="Size"
          value={chatFontSize}
          min={CHAT_FONT_SIZE_MIN}
          max={CHAT_FONT_SIZE_MAX}
          step={1}
          onChange={setChatFontSize}
          formatValue={(v) => `${v}px`}
        />

        <label className="flex items-center gap-2 text-xs text-on-surface-variant">
          <span className="min-w-0">Exact value:</span>
          <input
            type="number"
            min={CHAT_FONT_SIZE_MIN}
            max={CHAT_FONT_SIZE_MAX}
            step={1}
            value={chatFontSize}
            onChange={onNumericChange}
            aria-label="Chat text size in pixels"
            className="w-16 px-2 py-1 rounded bg-surface-container text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none tabular-nums"
            data-testid="chat-font-size-input"
          />
          <span>px (between {CHAT_FONT_SIZE_MIN} and {CHAT_FONT_SIZE_MAX})</span>
        </label>

        <div
          className="mt-2 p-4 rounded-lg bg-surface-container border border-outline-variant/15"
          data-testid="chat-font-size-preview"
        >
          <p className="text-xs font-medium text-on-surface-variant mb-2 uppercase tracking-wide">
            Preview
          </p>
          <p
            className="text-on-surface"
            style={{ fontSize: `${chatFontSize}px` }}
          >
            {PREVIEW_SAMPLE}
          </p>
        </div>
      </section>

      <section aria-labelledby="theme-preset-heading" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 id="theme-preset-heading" className="text-sm font-medium text-on-surface">
              Color theme
            </h3>
            <p className="text-xs text-on-surface-variant mt-1">
              Changes the application palette and the Concord logo colors together.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {THEME_PRESETS.map((preset) => {
            const meta = THEME_META[preset];
            const active = themePreset === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => setThemePreset(preset)}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  active
                    ? "bg-surface-container-high border-primary/50"
                    : "bg-surface-container border-outline-variant/20 hover:bg-surface-container-high"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-on-surface">{meta.label}</div>
                    <div className="text-xs text-on-surface-variant mt-1">{meta.description}</div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {meta.swatches.map((color) => (
                      <span
                        key={color}
                        className="w-4 h-4 rounded-full border border-black/20"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
