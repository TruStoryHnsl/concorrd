/**
 * Custom in-app updater for the Tauri desktop builds.
 *
 * Why a custom updater and not `tauri-plugin-updater`?
 *
 * `tauri-plugin-updater` is excellent but assumes a signed-manifest world.
 * Concord is shipping unsigned (project-owner directive: "free path only"),
 * which means the plugin's ed25519 verification is either disabled (defeats
 * the point) or requires us to maintain a separate signing keypair plus a
 * matching `pubkey` baked into `tauri.conf.json`. We picked the lighter-
 * weight Option (c) from the sprint plan: poll the GitHub releases API at
 * runtime, surface a "new version available" prompt, and open the platform-
 * appropriate installer download URL in the user's default browser. The OS
 * installer flow takes over from there.
 *
 * Manifest layout (published by `.github/workflows/release.yml`):
 *
 *   Each per-platform release (e.g. `v0.7.12-windows`) carries:
 *     1. its single installer asset (Concord_<v>_x64-setup.exe etc.)
 *     2. an `updater-manifest.json` describing the platform release
 *
 *   The manifest is intentionally per-platform-release rather than one
 *   global manifest because each platform job publishes its release
 *   independently and parallel-uploads to a global manifest would race.
 *   Clients walk the releases listing and pick the latest release whose
 *   tag ends in their platform suffix.
 *
 * Debounce: a 6h `lastChecked` is persisted in localStorage. `runStartupCheck`
 * is a no-op if the last check happened within that window. The manual
 * "Check for updates" button passes `force: true` to bypass the debounce.
 *
 * Platform detection: we read `__TAURI_INTERNALS__` to confirm we're on
 * native, then sniff `navigator.userAgent` + `navigator.platform` for the
 * specific platform/arch. Tauri's webview userAgent matches the host OS,
 * so this is reliable on desktop (it would be wrong on mobile — but mobile
 * doesn't ship through this updater anyway).
 */

import { compareVersions } from "../utils/version";

const LAST_CHECKED_KEY = "concord.updater.lastChecked.v1";
const LAST_DISMISSED_KEY = "concord.updater.lastDismissedVersion.v1";
const STARTUP_DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6h
const STARTUP_DELAY_MS = 1500; // give the app a moment to settle before nagging
const REPO_API = "https://api.github.com/repos/TruStoryHnsl/concord/releases";

export type PlatformSuffix =
  | "windows"
  | "macos-intel"
  | "macos-arm64"
  | "linux"
  | "unknown";

export interface UpdaterManifest {
  /** Bare SemVer string, no leading `v`. */
  version: string;
  /** Tag of the per-platform release this manifest belongs to. */
  tag: string;
  /** Direct download URL for the installer. */
  installerUrl: string;
  /** Installer asset filename. */
  installerName: string;
  /** Excerpt from CHANGELOG.md or a fallback line. */
  notes: string;
  /** Per-platform suffix (windows / macos-intel / macos-arm64 / linux). */
  platform: PlatformSuffix;
}

export type UpdaterCheckResult =
  | { kind: "up-to-date"; currentVersion: string }
  | {
      kind: "available";
      currentVersion: string;
      latestVersion: string;
      manifest: UpdaterManifest;
      accepted: boolean;
    }
  | { kind: "error"; message: string };

/**
 * Best-effort platform detection from the Tauri webview environment.
 *
 * Tauri 2's webviews preserve the host OS in the UA string on desktop:
 *   - Windows: contains "Windows NT"
 *   - macOS:   contains "Macintosh"; arch from `navigator.platform` ("MacIntel"
 *              for both Intel + Apple Silicon — Apple intentionally hides arch
 *              for fingerprint-resistance) so we fall back to a CPU probe
 *              via `navigator.userAgentData` (Chromium) or assume ARM on
 *              modern macOS.
 *   - Linux:   contains "Linux" and not Android.
 */
export function detectPlatform(): PlatformSuffix {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
  if (/Mac/i.test(ua)) {
    // navigator.userAgentData.platform is "macOS"; the architecture lives
    // on the high-entropy values which are async. We use a synchronous
    // best-effort: WebKit doesn't expose UAData, but Chromium (Tauri's
    // webview) does. If the high-entropy probe has been done elsewhere,
    // a flag may exist on the window. Default to arm64 on macOS-14+
    // hosted runners + recent Macs.
    const uaData = (
      navigator as unknown as {
        userAgentData?: { architecture?: string };
      }
    ).userAgentData;
    if (uaData?.architecture === "x86") return "macos-intel";
    if (uaData?.architecture === "arm") return "macos-arm64";
    // Heuristic: navigator.platform "MacIntel" is the lie Apple tells
    // every Mac since the Intel days. Use a Rosetta probe — recent
    // macOS Safari/WebKit reports a wider feature set on arm64. As a
    // sane default, prefer arm64 since arm64 Macs dominate post-2020.
    return "macos-arm64";
  }
  return "unknown";
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
interface ReleaseJson {
  tag_name: string;
  name: string;
  body?: string;
  assets: ReleaseAsset[];
}

/**
 * Walk the releases listing and return the newest release whose tag ends
 * with `-${platform}`. Excludes drafts and prereleases is left to the
 * caller (the API surface returns them all; tag-suffix match is the
 * filter we care about).
 */
export async function fetchLatestManifest(
  platform: PlatformSuffix,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdaterManifest | null> {
  if (platform === "unknown") return null;
  const res = await fetchImpl(`${REPO_API}?per_page=30`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub releases fetch ${res.status}`);
  const releases = (await res.json()) as ReleaseJson[];
  const suffixTag = `-${platform}`;
  const release = releases.find((r) => r.tag_name.endsWith(suffixTag));
  if (!release) return null;

  // Prefer an `updater-manifest.json` asset if the workflow has uploaded one;
  // fall back to synthesizing the manifest from the installer asset + tag.
  const manifestAsset = release.assets.find(
    (a) => a.name === "updater-manifest.json",
  );
  if (manifestAsset) {
    try {
      const m = await fetchImpl(manifestAsset.browser_download_url);
      if (m.ok) {
        const parsed = (await m.json()) as Partial<UpdaterManifest>;
        if (parsed.version && parsed.installerUrl) {
          return {
            version: parsed.version,
            tag: parsed.tag ?? release.tag_name,
            installerUrl: parsed.installerUrl,
            installerName: parsed.installerName ?? "installer",
            notes: parsed.notes ?? release.body ?? "",
            platform,
          };
        }
      }
    } catch {
      // fall through to synthesis
    }
  }

  // Synthesize. Installer asset = the single non-manifest asset.
  const installer = release.assets.find(
    (a) =>
      a.name.endsWith(".exe") ||
      a.name.endsWith(".dmg") ||
      a.name.endsWith(".AppImage"),
  );
  if (!installer) return null;

  // Strip leading "v" and trailing "-platform" to extract the bare SemVer.
  const tag = release.tag_name;
  const version = tag.replace(/^v/, "").replace(new RegExp(`${suffixTag}$`), "");

  return {
    version,
    tag,
    installerUrl: installer.browser_download_url,
    installerName: installer.name,
    notes: (release.body ?? "").slice(0, 800),
    platform,
  };
}

/**
 * The version baked into this build. Vite injects it at build time via the
 * `VITE_CONCORD_VERSION` env var (set by the release workflow's "Sync
 * version into tauri.conf.json" step). Falls back to `0.0.0-dev` so the
 * comparator treats a missing value as "older than everything" — i.e.
 * a dev build always reports updates available.
 */
export function getCurrentVersion(): string {
  // Vite-style injection — keep the optional chain so jsdom tests don't
  // explode on `import.meta.env`.
  try {
    const v = (
      import.meta as unknown as { env?: { VITE_CONCORD_VERSION?: string } }
    ).env?.VITE_CONCORD_VERSION;
    if (v && /^\d+\.\d+\.\d+/.test(v)) return v;
  } catch {
    // ignore
  }
  return "0.0.0-dev";
}

interface CheckOptions {
  /** Bypass the 6h debounce. */
  force?: boolean;
  /** Confirmation handler; default is `window.confirm`. */
  confirmFn?: (message: string) => boolean;
  /** Inject a fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

function readLastChecked(): number {
  try {
    const raw = localStorage.getItem(LAST_CHECKED_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeLastChecked(ts: number) {
  try {
    localStorage.setItem(LAST_CHECKED_KEY, String(ts));
  } catch {
    // ignore
  }
}

/**
 * Human-readable "last checked" label for the About panel. Returns
 * "never" if no check has run.
 */
export function getLastCheckedDisplay(): string {
  const ts = readLastChecked();
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}

function isTauriEnv(): boolean {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object)
  );
}

/**
 * Core check. Resolves the latest manifest, compares versions, and
 * (on a hit) prompts the user — accepting opens the installer URL in
 * the OS default browser via `window.open(url, "_blank")`. Tauri's
 * webview routes external-target navigations through the OS handler.
 */
export async function checkForUpdates(
  opts: CheckOptions = {},
): Promise<UpdaterCheckResult> {
  if (!isTauriEnv()) {
    return { kind: "error", message: "Updater is only available in the desktop app." };
  }

  const platform = detectPlatform();
  if (platform === "unknown") {
    return { kind: "error", message: "Unable to detect platform for updates." };
  }

  const currentVersion = getCurrentVersion();

  let manifest: UpdaterManifest | null = null;
  try {
    manifest = await fetchLatestManifest(platform, opts.fetchImpl ?? fetch);
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  writeLastChecked(Date.now());

  if (!manifest) {
    return { kind: "up-to-date", currentVersion };
  }

  const cmp = compareVersions(manifest.version, currentVersion);
  if (cmp <= 0) {
    return { kind: "up-to-date", currentVersion };
  }

  // Compress the release notes a bit so the confirm() dialog isn't
  // overwhelming. The first paragraph (~400 chars) is plenty.
  const notesExcerpt =
    manifest.notes.length > 0
      ? manifest.notes.slice(0, 400) + (manifest.notes.length > 400 ? "…" : "")
      : "(no release notes)";
  const message =
    `Concord ${manifest.version} is available (you have ${currentVersion}).\n\n` +
    `${notesExcerpt}\n\n` +
    `Update now? This will open ${manifest.installerName} in your browser.`;

  const confirmFn = opts.confirmFn ?? ((m: string) => window.confirm(m));
  const accepted = confirmFn(message);
  if (accepted) {
    // window.open with a non-self target routes through Tauri's external
    // link handler, which hands the URL to the OS default browser.
    window.open(manifest.installerUrl, "_blank", "noopener,noreferrer");
  } else {
    try {
      localStorage.setItem(LAST_DISMISSED_KEY, manifest.version);
    } catch {
      // ignore
    }
  }

  return {
    kind: "available",
    currentVersion,
    latestVersion: manifest.version,
    manifest,
    accepted,
  };
}

/**
 * Fire-and-forget launch-time check. Honors the 6h debounce. Never throws —
 * any error is swallowed (the user will see a chance to manually check from
 * Settings → About).
 */
export function runStartupCheck(): void {
  if (!isTauriEnv()) return;
  const last = readLastChecked();
  if (last && Date.now() - last < STARTUP_DEBOUNCE_MS) return;

  // Delay slightly so the app boot doesn't compete with the network call.
  window.setTimeout(() => {
    checkForUpdates().catch(() => {
      /* no-op — caller has no UI surface */
    });
  }, STARTUP_DELAY_MS);
}
