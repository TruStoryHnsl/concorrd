#!/usr/bin/env bash
# build_ios_native.sh — Build Concord as an iOS app via Tauri v2.
#
# Designed to run on orrpheus (M1 Pro, macOS 14+). Produces either a
# simulator-arch debug .app (for on-box smoke tests) or a device-arch
# release .app / .ipa (for sideloading to a physical iPhone).
#
# Companion to scripts/build_macos_native.sh. Same shape, same exit
# codes, same env-var discipline, so CI / humans can trust both scripts
# behave identically.
#
# =================================================================
# Required environment (device builds only — simulator builds work
# without any Apple Developer Program relationship):
# =================================================================
#
#   APPLE_TEAM_ID       — 10-character Apple Developer Team ID
#   APPLE_CERT_NAME     — Common name of the iOS Development certificate,
#                         e.g. "Apple Development: Your Name (ABCDEFGHIJ)"
#
# Optional:
#
#   APPLE_ID            — Apple ID email (only needed if you later add
#                         TestFlight submission via notarytool; unused in
#                         the current sideload-only flow)
#   RELEASE_DIR         — Override output directory. Defaults to
#                         ${REPO_ROOT}/dist/ios-device (device builds) or
#                         ${REPO_ROOT}/dist/ios-sim (simulator builds).
#
# =================================================================
# Usage:
# =================================================================
#
#   scripts/build_ios_native.sh                # device release build (requires team ID)
#   scripts/build_ios_native.sh --sim          # simulator debug build (unsigned, no team ID required)
#   scripts/build_ios_native.sh --sim --release # simulator release build
#
# =================================================================
# Unsigned mode (no APPLE_TEAM_ID):
# =================================================================
#
# When both APPLE_TEAM_ID and APPLE_CERT_NAME are unset, the script falls
# back to producing an **unsigned** device .app. This is intended for
# post-processing with Sideloadly or the AltStore mac companion, which
# re-sign the bundle against the user's personal Apple ID on install.
# See `client/NATIVE_BUILD.md` §8a for the sideload walkthrough.
#
# An unsigned build is NOT suitable for TestFlight — once the Apple
# Developer Program enrollment completes and `developmentTeam` is set in
# `src-tauri/tauri.conf.json`, re-run this script with APPLE_TEAM_ID set
# to produce a signed build.
#
# =================================================================
# Exit codes:
# =================================================================
#
#   0  build succeeded (artifact is in $RELEASE_DIR)
#   1  missing prerequisite tool, env var, or Xcode project
#   2  cargo tauri build failed
#   3  signing or post-processing failed
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_TAURI="${REPO_ROOT}/src-tauri"
CLIENT_DIR="${REPO_ROOT}/client"
APPLE_GEN_DIR="${SRC_TAURI}/gen/apple"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log()  { printf '\033[1;36m[build_ios]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build_ios]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build_ios ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

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
# Arg parsing
# ----------------------------------------------------------------------------
MODE="device"            # device | sim
PROFILE="release"        # release | debug — default for device, overridden for sim
PROFILE_EXPLICIT=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --sim)
            MODE="sim"
            shift
            ;;
        --device)
            MODE="device"
            shift
            ;;
        --debug)
            PROFILE="debug"
            PROFILE_EXPLICIT=1
            shift
            ;;
        --release)
            PROFILE="release"
            PROFILE_EXPLICIT=1
            shift
            ;;
        -h|--help)
            sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#$//'
            exit 0
            ;;
        *)
            die "unknown argument: $1" 1
            ;;
    esac
done

# Simulator builds default to debug — release-configured simulator .apps
# are rarely useful and tauri-cli errors out if the toolchain isn't in
# the expected state. Humans who really want a release sim build can
# pass --release explicitly.
if [[ "${MODE}" == "sim" && "${PROFILE_EXPLICIT}" -eq 0 ]]; then
    PROFILE="debug"
fi

# Default RELEASE_DIR depends on mode.
if [[ "${MODE}" == "sim" ]]; then
    RELEASE_DIR="${RELEASE_DIR:-${REPO_ROOT}/dist/ios-sim}"
else
    RELEASE_DIR="${RELEASE_DIR:-${REPO_ROOT}/dist/ios-device}"
fi

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

if ! cargo tauri --version >/dev/null 2>&1; then
    die "tauri-cli is not installed. Run: cargo install tauri-cli --version '^2.0' --locked" 1
fi

# Check Rust iOS targets.
REQUIRED_TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim)
for target in "${REQUIRED_TARGETS[@]}"; do
    if ! rustup target list --installed 2>/dev/null | grep -qx "${target}"; then
        log "Installing Rust target ${target}"
        rustup target add "${target}"
    fi
done

# The Xcode project must exist. It is generated by `cargo tauri ios init`
# and committed to the repo — if it's missing, the user is on a fresh
# clone that hasn't run the one-time init step yet.
if [[ ! -d "${APPLE_GEN_DIR}/concord.xcodeproj" ]]; then
    die "no Xcode project found at ${APPLE_GEN_DIR}/concord.xcodeproj.
Run 'cd src-tauri && cargo tauri ios init' first (one-time setup on orrpheus).
See client/NATIVE_BUILD.md §8 for the full scaffolding guide." 1
fi

# Device builds require a signing identity. Unsigned device builds are
# allowed — they land in $RELEASE_DIR and are intended for Sideloadly /
# AltStore re-signing (see NATIVE_BUILD.md §8a).
SIGNED_BUILD=0
if [[ "${MODE}" == "device" ]]; then
    if [[ -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_CERT_NAME:-}" ]]; then
        SIGNED_BUILD=1
        log "Device build mode: SIGNED (team=${APPLE_TEAM_ID}, cert=${APPLE_CERT_NAME})"
    else
        warn "APPLE_TEAM_ID and/or APPLE_CERT_NAME unset — producing UNSIGNED device build."
        warn "Unsigned output is intended for Sideloadly / AltStore re-signing."
        warn "See client/NATIVE_BUILD.md §8a for the sideload walkthrough."
    fi
else
    log "Simulator build mode: unsigned (simulator builds do not require signing)"
fi

log "cargo:       $(cargo --version)"
log "rustc:       $(rustc --version)"
log "tauri-cli:   $(cargo tauri --version)"
log "xcodebuild:  $(xcodebuild -version | head -n1)"
log "mode:        ${MODE}"
log "profile:     ${PROFILE}"
log "release_dir: ${RELEASE_DIR}"

# ----------------------------------------------------------------------------
# Build the React client first
# ----------------------------------------------------------------------------
log "Building React client (${CLIENT_DIR})..."
pushd "${CLIENT_DIR}" >/dev/null
# Same freshness check as build_macos_native.sh — refresh node_modules
# when the lockfile is newer than the last install's fingerprint.
if [[ ! -d node_modules ]] \
   || [[ ! -f node_modules/.package-lock.json ]] \
   || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
    log "node_modules is missing or stale — running npm ci"
    npm ci
fi
npm run build
popd >/dev/null

# ----------------------------------------------------------------------------
# Run cargo tauri ios build
# ----------------------------------------------------------------------------
#
# Tauri CLI target aliases:
#   aarch64     — aarch64-apple-ios (device)
#   aarch64-sim — aarch64-apple-ios-sim (Apple Silicon simulator)
#   x86_64      — x86_64-apple-ios (Intel simulator, deprecated)
#
# Profile flags:
#   (default)   — release (tauri-cli default)
#   --debug     — debug
#
if [[ "${MODE}" == "sim" ]]; then
    TAURI_TARGET="aarch64-sim"
else
    TAURI_TARGET="aarch64"
fi

TAURI_ARGS=(ios build --target "${TAURI_TARGET}")
if [[ "${PROFILE}" == "debug" ]]; then
    TAURI_ARGS+=(--debug)
fi

log "Running: cargo tauri ${TAURI_ARGS[*]}"

# Tauri's post-build "rename xcarchive .app -> arch-tag dir" step uses
# fs::rename, which fails with "Directory not empty (os error 66)" if a
# previous Concord.app is still in the destination. Pre-clean the
# arch-tagged output directories to make the build idempotent — Xcode's
# DerivedData cache survives the cleanup and the actual build is still
# incremental (only Tauri's final move step needs an empty destination).
if [[ "${MODE}" == "sim" ]]; then
    rm -rf "${APPLE_GEN_DIR}/build/arm64-sim" "${APPLE_GEN_DIR}/build/x86_64-sim"
else
    rm -rf "${APPLE_GEN_DIR}/build/arm64"
fi
# Stale .xcarchive from a half-finished previous run also blocks the
# rename — wipe it too.
rm -rf "${APPLE_GEN_DIR}/build/concord_iOS.xcarchive"

pushd "${SRC_TAURI}" >/dev/null
if ! cargo tauri "${TAURI_ARGS[@]}"; then
    die "cargo tauri ios build failed" 2
fi
popd >/dev/null

# ----------------------------------------------------------------------------
# Locate artifacts
# ----------------------------------------------------------------------------
#
# Tauri v2 (verified against tauri-cli 2.10.1 on 2026-04-09) places the
# final .app bundle at:
#
#   src-tauri/gen/apple/build/<arch-tag>/Concord.app
#
# Where <arch-tag> is one of:
#   arm64-sim   — aarch64-apple-ios-sim
#   arm64       — aarch64-apple-ios (device)
#   x86_64-sim  — x86_64-apple-ios (Intel sim, deprecated)
#
# Older Tauri layouts placed it under
# `gen/apple/build/Build/Products/<Config>-<platform>/`. We probe the
# current arch-tag location first, then fall back to the legacy path,
# then a generic recursive search so a future Tauri layout shift
# doesn't break the script.
#
if [[ "${MODE}" == "sim" ]]; then
    PRIMARY_DIR="${APPLE_GEN_DIR}/build/arm64-sim"
    LEGACY_PRODUCTS_DIR="${APPLE_GEN_DIR}/build/Build/Products/$( [[ "${PROFILE}" == "debug" ]] && echo Debug || echo Release )-iphonesimulator"
else
    PRIMARY_DIR="${APPLE_GEN_DIR}/build/arm64"
    LEGACY_PRODUCTS_DIR="${APPLE_GEN_DIR}/build/Build/Products/$( [[ "${PROFILE}" == "debug" ]] && echo Debug || echo Release )-iphoneos"
fi

APP_BUNDLE=""
for candidate_dir in "${PRIMARY_DIR}" "${LEGACY_PRODUCTS_DIR}"; do
    if [[ -d "${candidate_dir}" ]]; then
        APP_BUNDLE="$(find "${candidate_dir}" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -n1 || true)"
        [[ -n "${APP_BUNDLE}" ]] && break
    fi
done

# Final fallback — recursive search anywhere under gen/apple/build/.
# Bounded to maxdepth 6 so we don't traverse the multi-GB DerivedData
# tree.
if [[ -z "${APP_BUNDLE}" && -d "${APPLE_GEN_DIR}/build" ]]; then
    APP_BUNDLE="$(find "${APPLE_GEN_DIR}/build" -maxdepth 6 -name 'Concord.app' -print 2>/dev/null | grep -v '\.xcarchive' | head -n1 || true)"
fi

# .ipa hunt — Tauri may emit one for device builds.
LEGACY_IPA=""
if [[ -d "${APPLE_GEN_DIR}/build" ]]; then
    LEGACY_IPA="$(find "${APPLE_GEN_DIR}/build" -maxdepth 4 -name '*.ipa' -print 2>/dev/null | head -n1 || true)"
fi

if [[ -z "${APP_BUNDLE}" && -z "${LEGACY_IPA}" ]]; then
    die "no .app or .ipa produced. Looked under:
  ${PRIMARY_DIR}
  ${LEGACY_PRODUCTS_DIR} (legacy DerivedData layout)
  ${APPLE_GEN_DIR}/build (recursive .app fallback)
Tauri may have put the artifact in a new location — update this script and NATIVE_BUILD.md §8." 2
fi

log "Build artifacts:"
[[ -n "${APP_BUNDLE}" ]] && log "  .app bundle: ${APP_BUNDLE}"
[[ -n "${LEGACY_IPA}" ]] && log "  .ipa: ${LEGACY_IPA}"

# ----------------------------------------------------------------------------
# Aggregate into release directory
# ----------------------------------------------------------------------------
mkdir -p "${RELEASE_DIR}"
log "Copying artifacts to ${RELEASE_DIR}"
if [[ -n "${APP_BUNDLE}" ]]; then
    cp -R "${APP_BUNDLE}" "${RELEASE_DIR}/"
fi
if [[ -n "${LEGACY_IPA}" ]]; then
    cp "${LEGACY_IPA}" "${RELEASE_DIR}/"
fi

# ----------------------------------------------------------------------------
# Post-build: unsigned-build reminder
# ----------------------------------------------------------------------------
if [[ "${MODE}" == "device" && "${SIGNED_BUILD}" -eq 0 ]]; then
    warn "UNSIGNED device .app produced at ${RELEASE_DIR}."
    warn "Next step: re-sign via Sideloadly or AltStore (see NATIVE_BUILD.md §8a)."
fi

log "Done. Artifacts ready in ${RELEASE_DIR}"
