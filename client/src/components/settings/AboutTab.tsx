import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { usePlatform } from "../../hooks/usePlatform";
import {
  checkForUpdates,
  getLastCheckedDisplay,
  type UpdaterCheckResult,
} from "../../lib/updater";

// Per-platform release-suffix tags emitted by the desktop pipeline
// (.github/workflows/release.yml). Each one carries exactly one
// installer asset; the asset filename embeds the SemVer version,
// so we cannot use GitHub's static `/releases/latest/download/<name>`
// redirect — we resolve the latest tag of each suffix at runtime via
// the public releases listing.
type PlatformSuffix = "windows" | "macos-intel" | "macos-arm64" | "linux";

interface PlatformDownload {
  label: string;
  suffix: PlatformSuffix;
  /** Fallback static URL (latest release page) shown while resolution is pending. */
  fallback: string;
}

const PLATFORMS: PlatformDownload[] = [
  {
    label: "Windows",
    suffix: "windows",
    fallback: "https://github.com/TruStoryHnsl/concord/releases?q=windows",
  },
  {
    label: "macOS (Intel)",
    suffix: "macos-intel",
    fallback: "https://github.com/TruStoryHnsl/concord/releases?q=macos-intel",
  },
  {
    label: "macOS (Apple Silicon)",
    suffix: "macos-arm64",
    fallback: "https://github.com/TruStoryHnsl/concord/releases?q=macos-arm64",
  },
  {
    label: "Linux",
    suffix: "linux",
    fallback: "https://github.com/TruStoryHnsl/concord/releases?q=linux",
  },
];

interface ResolvedAssetMap {
  [suffix: string]: string; // suffix -> installer asset browser_download_url
}

const CACHE_KEY = "concord.about.platformDownloads.v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface CachedAssets {
  resolved: ResolvedAssetMap;
  fetchedAt: number;
}

function loadCache(): CachedAssets | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAssets;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(resolved: ResolvedAssetMap) {
  try {
    const payload: CachedAssets = { resolved, fetchedAt: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota / disabled storage
  }
}

/**
 * Resolve the latest release URL for each per-platform suffix by hitting
 * the public releases listing. We pull the first page (default 30 items,
 * each suffix re-publishes every release cycle so the top of the list
 * always contains the most recent four suffix releases).
 */
async function resolvePlatformAssets(): Promise<ResolvedAssetMap> {
  const res = await fetch(
    "https://api.github.com/repos/TruStoryHnsl/concord/releases?per_page=30",
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`GitHub releases fetch ${res.status}`);
  const releases = (await res.json()) as Array<{
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  }>;
  const out: ResolvedAssetMap = {};
  for (const platform of PLATFORMS) {
    const suffixTag = `-${platform.suffix}`;
    const release = releases.find((r) => r.tag_name.endsWith(suffixTag));
    if (!release) continue;
    // Each per-platform release attaches exactly one installer asset.
    const installer = release.assets.find(
      (a) =>
        a.name.endsWith(".exe") ||
        a.name.endsWith(".dmg") ||
        a.name.endsWith(".AppImage"),
    );
    if (installer) {
      out[platform.suffix] = installer.browser_download_url;
    }
  }
  return out;
}

export function AboutTab() {
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);
  const { isTauri } = usePlatform();

  // Web build only: resolve per-platform installer URLs at render time.
  const [assets, setAssets] = useState<ResolvedAssetMap>(
    () => loadCache()?.resolved ?? {},
  );
  // Native build only: in-app update check state.
  const [updateState, setUpdateState] = useState<UpdaterCheckResult | null>(
    null,
  );
  const [updateBusy, setUpdateBusy] = useState(false);
  const [lastCheckedLabel, setLastCheckedLabel] = useState<string>(
    () => getLastCheckedDisplay(),
  );

  useEffect(() => {
    if (isTauri) return; // native build doesn't render the CTA section
    if (Object.keys(assets).length > 0) return;
    let cancelled = false;
    resolvePlatformAssets()
      .then((resolved) => {
        if (cancelled) return;
        setAssets(resolved);
        saveCache(resolved);
      })
      .catch(() => {
        // swallow — fallback URLs already wired into the buttons
      });
    return () => {
      cancelled = true;
    };
  }, [isTauri, assets]);

  async function onCheckForUpdates() {
    setUpdateBusy(true);
    try {
      const result = await checkForUpdates({ force: true });
      setUpdateState(result);
      setLastCheckedLabel(getLastCheckedDisplay());
    } finally {
      setUpdateBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-on-surface">About</h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-on-surface-variant">Version</span>
          <span className="text-sm text-on-surface">
            {import.meta.env.VITE_CONCORD_VERSION ?? "0.1.0"}
          </span>
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

      {/*
        Native builds: show "Check for updates" instead of download CTAs.
        Tauri webviews already are the installed app — pointing them at a
        download page is a footgun, and an in-app self-updater is the
        right path.
      */}
      {isTauri && (
        <div className="border-t border-outline-variant/15 pt-6">
          <h4 className="text-sm font-medium text-on-surface mb-2">Updates</h4>
          <p className="text-xs text-on-surface-variant mb-3">
            Last checked: {lastCheckedLabel}.
          </p>
          <button
            type="button"
            onClick={onCheckForUpdates}
            disabled={updateBusy}
            className="px-4 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-sm rounded-md transition-colors disabled:opacity-50"
          >
            {updateBusy ? "Checking…" : "Check for updates"}
          </button>
          {updateState && updateState.kind === "up-to-date" && (
            <p className="mt-2 text-xs text-on-surface-variant">
              You are on the latest version ({updateState.currentVersion}).
            </p>
          )}
          {updateState && updateState.kind === "available" && (
            <p className="mt-2 text-xs text-on-surface">
              Version {updateState.latestVersion} is available. An update
              prompt has been shown.
            </p>
          )}
          {updateState && updateState.kind === "error" && (
            <p className="mt-2 text-xs text-error">
              Update check failed: {updateState.message}
            </p>
          )}
        </div>
      )}

      {/*
        Web build (docker / hosted): present the four desktop installers.
        We resolve the actual installer URL per platform at render time
        because the per-platform release tag suffixes (v0.X.Y-windows etc.)
        cannot be served by GitHub's static `/releases/latest/download/<name>`
        redirect.
      */}
      {!isTauri && (
        <div className="border-t border-outline-variant/15 pt-6">
          <h4 className="text-sm font-medium text-on-surface mb-2">
            Desktop App
          </h4>
          <p className="text-xs text-on-surface-variant mb-3">
            Download Concord as a standalone desktop application.
          </p>
          <div className="flex gap-2 flex-wrap">
            {PLATFORMS.map((p) => {
              const href = assets[p.suffix] ?? p.fallback;
              return (
                <a
                  key={p.suffix}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block px-4 py-2 bg-primary/10 hover:bg-primary/15 text-primary text-sm rounded-md transition-colors"
                >
                  {p.label}
                </a>
              );
            })}
          </div>
        </div>
      )}

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
