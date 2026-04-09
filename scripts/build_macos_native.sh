#!/usr/bin/env bash
# build_macos_native.sh — Build Concord as a Universal macOS app via Tauri v2.
#
# Designed to run on orrpheus (M1 Pro, macOS 14+). Builds a fat binary that
# runs on both Apple Silicon and Intel, then code-signs and notarizes it
# with the Apple Developer ID Application certificate.
#
# Required environment:
#   APPLE_ID         — Apple ID email used for notarization
#   APPLE_TEAM_ID    — 10-character Apple Developer Team ID
#   APPLE_CERT_NAME  — Common name of the Developer ID Application certificate,
#                      e.g. "Developer ID Application: Your Name (ABCDEFGHIJ)"
#
# Optional environment:
#   APPLE_PASSWORD   — App-specific password for notarytool. If unset, the
#                      script assumes a keychain profile is already configured
#                      via `xcrun notarytool store-credentials`.
#   RELEASE_DIR      — Where to copy final artifacts. Defaults to
#                      ${REPO_ROOT}/dist/macos-universal
#   SKIP_NOTARIZE    — Set to "1" to skip notarization (e.g. for local dev)
#   WITH_DMG         — Set to "1" to ALSO produce a .dmg disk image alongside
#                      the .app. NOT compatible with SSH-only sessions: Tauri's
#                      bundle_dmg.sh runs an AppleScript that talks to Finder,
#                      and Finder cannot accept AppleEvents over SSH (errors
#                      with -1712 "AppleEvent timed out"). Only set this when
#                      running the script from a logged-in GUI session on
#                      orrpheus, e.g. via Terminal.app at the keyboard.
#                      The default skips dmg so SSH-driven CI works.
#
# Usage:
#   scripts/build_macos_native.sh                # .app only (SSH-safe)
#   WITH_DMG=1 scripts/build_macos_native.sh     # .app + .dmg (GUI session only)
#
# Exit codes:
#   0  build (and signing/notarization, if requested) succeeded
#   1  missing prerequisite tool or environment variable
#   2  build failed
#   3  signing or notarization failed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_TAURI="${REPO_ROOT}/src-tauri"
CLIENT_DIR="${REPO_ROOT}/client"
RELEASE_DIR="${RELEASE_DIR:-${REPO_ROOT}/dist/macos-universal}"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log()  { printf '\033[1;36m[build_macos]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build_macos]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build_macos ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

require_tool() {
    local tool="$1"
    local hint="$2"
    if ! command -v "${tool}" >/dev/null 2>&1; then
        die "missing required tool '${tool}'. ${hint}" 1
    fi
}

require_env() {
    local var="$1"
    if [[ -z "${!var:-}" ]]; then
        die "required environment variable ${var} is not set" 1
    fi
}

# ----------------------------------------------------------------------------
# Platform check
# ----------------------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
    die "this script must run on macOS (orrpheus). Current uname: $(uname -s)" 1
fi

# ----------------------------------------------------------------------------
# Prerequisites
# ----------------------------------------------------------------------------
log "Checking prerequisites..."
require_tool cargo "Install Rust: https://rustup.rs/"
require_tool node "Install Node 18+ via homebrew: brew install node"
require_tool xcodebuild "Install Xcode 15+ from the App Store"
require_tool codesign "Comes with Xcode CLT"

if ! cargo tauri --version >/dev/null 2>&1; then
    die "tauri-cli is not installed. Run: cargo install tauri-cli --version '^2.0' --locked" 1
fi

# Ensure both Apple targets are installed.
for target in x86_64-apple-darwin aarch64-apple-darwin; do
    if ! rustup target list --installed 2>/dev/null | grep -qx "${target}"; then
        log "Installing Rust target ${target}"
        rustup target add "${target}"
    fi
done

require_env APPLE_TEAM_ID
require_env APPLE_CERT_NAME

if [[ "${SKIP_NOTARIZE:-0}" != "1" ]]; then
    require_env APPLE_ID
fi

log "cargo:       $(cargo --version)"
log "rustc:       $(rustc --version)"
log "tauri-cli:   $(cargo tauri --version)"
log "xcodebuild:  $(xcodebuild -version | head -n1)"

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
log "Building React client (${CLIENT_DIR})..."
pushd "${CLIENT_DIR}" >/dev/null
# Refresh node_modules when missing OR when package-lock.json has been
# touched more recently than the last install's fingerprint. The second
# condition catches the cross-machine case: Syncthing mirrors
# package{,-lock}.json but excludes node_modules, so the working tree's
# lockfile can be ahead of the locally-installed deps after a pull.
if [[ ! -d node_modules ]] \
   || [[ ! -f node_modules/.package-lock.json ]] \
   || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
    log "node_modules is missing or stale relative to package-lock.json — running npm ci"
    npm ci
fi
npm run build
popd >/dev/null

log "Running cargo tauri build --target universal-apple-darwin..."
# Explicit --bundles required: tauri.conf.json's bundle.targets only
# declares Linux targets (deb, rpm, appimage). Without an explicit
# bundle list here, tauri compiles the binary and silently skips
# bundling on macOS, leaving us with a release/concord ELF and no .app.
# Mirrors the Linux script's `--bundles appimage,deb` pattern.
#
# .dmg is gated behind WITH_DMG=1 because Tauri's bundle_dmg.sh runs an
# AppleScript that requires a logged-in GUI Finder session — it does
# NOT work over SSH (errors with -1712). The .app alone is the primary
# distribution artifact; codesigning + (optional) notarization happen
# below regardless of WITH_DMG.
if [[ "${WITH_DMG:-0}" == "1" ]]; then
    log "WITH_DMG=1 — building .app AND .dmg (requires logged-in GUI session)"
    BUNDLE_LIST="app,dmg"
else
    log "default — building .app only (SSH-safe). Set WITH_DMG=1 for .dmg."
    BUNDLE_LIST="app"
fi

pushd "${SRC_TAURI}" >/dev/null
if ! cargo tauri build --target universal-apple-darwin --bundles "${BUNDLE_LIST}"; then
    die "cargo tauri build failed" 2
fi
popd >/dev/null

# ----------------------------------------------------------------------------
# Locate artifacts
# ----------------------------------------------------------------------------
BUNDLE_DIR="${SRC_TAURI}/target/universal-apple-darwin/release/bundle"
APP_BUNDLE="$(find "${BUNDLE_DIR}/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -n1 || true)"
DMG="$(find "${BUNDLE_DIR}/dmg" -maxdepth 1 -name '*.dmg' 2>/dev/null | head -n1 || true)"

if [[ -z "${APP_BUNDLE}" ]]; then
    die "no .app bundle produced under ${BUNDLE_DIR}/macos" 2
fi

log "Build artifacts:"
log "  .app bundle: ${APP_BUNDLE}"
[[ -n "${DMG}" ]] && log "  .dmg disk image: ${DMG}"

# ----------------------------------------------------------------------------
# Code sign
# ----------------------------------------------------------------------------
log "Code-signing ${APP_BUNDLE}..."
if ! codesign --deep --force --options runtime \
    --sign "${APPLE_CERT_NAME}" \
    --timestamp \
    "${APP_BUNDLE}"; then
    die "codesign failed" 3
fi

if ! codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"; then
    die "codesign verification failed" 3
fi

log "Code signing complete."

# ----------------------------------------------------------------------------
# Notarize (optional)
# ----------------------------------------------------------------------------
if [[ "${SKIP_NOTARIZE:-0}" == "1" ]]; then
    warn "SKIP_NOTARIZE=1 — skipping notarization. Artifact will Gatekeeper-block on other Macs."
else
    log "Notarizing ${APP_BUNDLE} via xcrun notarytool..."
    NOTARIZE_ZIP="$(mktemp -t concord-notarize.XXXXXX.zip)"
    /usr/bin/ditto -c -k --keepParent "${APP_BUNDLE}" "${NOTARIZE_ZIP}"

    if [[ -n "${APPLE_PASSWORD:-}" ]]; then
        if ! xcrun notarytool submit "${NOTARIZE_ZIP}" \
            --apple-id "${APPLE_ID}" \
            --team-id "${APPLE_TEAM_ID}" \
            --password "${APPLE_PASSWORD}" \
            --wait; then
            die "notarytool submission failed" 3
        fi
    else
        log "Using stored keychain profile 'concord-notarize' (run xcrun notarytool store-credentials concord-notarize first)"
        if ! xcrun notarytool submit "${NOTARIZE_ZIP}" \
            --keychain-profile concord-notarize \
            --wait; then
            die "notarytool submission failed" 3
        fi
    fi

    log "Stapling notarization ticket..."
    if ! xcrun stapler staple "${APP_BUNDLE}"; then
        die "stapler failed" 3
    fi

    rm -f "${NOTARIZE_ZIP}"
fi

# ----------------------------------------------------------------------------
# Aggregate into release directory
# ----------------------------------------------------------------------------
mkdir -p "${RELEASE_DIR}"
log "Copying artifacts to ${RELEASE_DIR}"
cp -R "${APP_BUNDLE}" "${RELEASE_DIR}/"
[[ -n "${DMG}" ]] && cp "${DMG}" "${RELEASE_DIR}/"

log "Done. Artifacts ready in ${RELEASE_DIR}"
