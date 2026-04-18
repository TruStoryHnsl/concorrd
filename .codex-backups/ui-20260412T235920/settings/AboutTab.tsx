import { useSettingsStore } from "../../stores/settings";

export function AboutTab() {
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-on-surface">About</h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-on-surface-variant">Version</span>
          <span className="text-sm text-on-surface">0.1.0</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-on-surface-variant">Project</span>
          <span className="text-sm text-on-surface">Concord</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-on-surface-variant">Protocol</span>
          <span className="text-sm text-on-surface">Matrix + LiveKit</span>
        </div>
      </div>

      <div className="border-t border-outline-variant/15 pt-6">
        <h4 className="text-sm font-medium text-on-surface mb-2">
          Desktop App
        </h4>
        <p className="text-xs text-on-surface-variant mb-3">
          Use Concord as a standalone desktop application.
        </p>
        <div className="flex gap-2 flex-wrap">
          <a
            href="/downloads/Concord Setup.exe"
            className="inline-block px-4 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-sm rounded-md transition-colors"
          >
            Windows
          </a>
          <a
            href="/downloads/Concord.AppImage"
            className="inline-block px-4 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-sm rounded-md transition-colors"
          >
            Linux
          </a>
          <a
            href="/downloads/Concord-mac.zip"
            className="inline-block px-4 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-sm rounded-md transition-colors"
          >
            macOS
          </a>
        </div>
      </div>

      <div className="border-t border-outline-variant/15 pt-6">
        <h4 className="text-sm font-medium text-on-surface mb-2">
          Reset Settings
        </h4>
        <p className="text-xs text-on-surface-variant mb-3">
          Restore all audio and voice settings to their default values. This
          clears per-user volume overrides.
        </p>
        <button
          onClick={resetToDefaults}
          className="px-4 py-2 bg-error/20 hover:bg-error-container/30 text-error text-sm rounded-md transition-colors"
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
