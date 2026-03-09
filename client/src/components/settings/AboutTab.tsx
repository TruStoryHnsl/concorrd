import { useSettingsStore } from "../../stores/settings";

export function AboutTab() {
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-white">About</h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-zinc-400">Version</span>
          <span className="text-sm text-zinc-300">0.1.0</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-zinc-400">Project</span>
          <span className="text-sm text-zinc-300">Concord</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-zinc-400">Protocol</span>
          <span className="text-sm text-zinc-300">Matrix + LiveKit</span>
        </div>
      </div>

      <div className="border-t border-zinc-700 pt-6">
        <h4 className="text-sm font-medium text-white mb-2">
          Desktop App
        </h4>
        <p className="text-xs text-zinc-500 mb-3">
          Use Concord as a standalone desktop application.
        </p>
        <div className="flex gap-2 flex-wrap">
          <a
            href="/downloads/Concord Setup.exe"
            className="inline-block px-4 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 text-sm rounded-md transition-colors"
          >
            Windows
          </a>
          <a
            href="/downloads/Concord.AppImage"
            className="inline-block px-4 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 text-sm rounded-md transition-colors"
          >
            Linux
          </a>
          <a
            href="/downloads/Concord-mac.zip"
            className="inline-block px-4 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 text-sm rounded-md transition-colors"
          >
            macOS
          </a>
        </div>
      </div>

      <div className="border-t border-zinc-700 pt-6">
        <h4 className="text-sm font-medium text-white mb-2">
          Reset Settings
        </h4>
        <p className="text-xs text-zinc-500 mb-3">
          Restore all audio and voice settings to their default values. This
          clears per-user volume overrides.
        </p>
        <button
          onClick={resetToDefaults}
          className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-sm rounded-md transition-colors"
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
