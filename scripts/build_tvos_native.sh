#!/usr/bin/env bash
# build_tvos_native.sh — Build Concord as a tvOS app (Apple TV).
#
# Designed to run on orrpheus (M1 Pro, macOS 14+). Produces either a
# simulator debug .app (for on-box smoke tests) or a device release
# .app / .ipa (for sideloading or TestFlight submission).
#
# This is the tvOS counterpart to scripts/build_ios_native.sh. Same
# shape, same exit codes, same env-var discipline.
#
# The tvOS app is a standalone SwiftUI + WKWebView shell that loads
# the same client/dist bundle — no Tauri dependency, no Rust runtime.
# See docs/native-apps/appletv-feasibility.md (Path C) for rationale.
#
# =================================================================
# Required environment (device builds only — simulator builds work
# without any Apple Developer Program relationship):
# =================================================================
#
#   APPLE_TEAM_ID       — 10-character Apple Developer Team ID
#   APPLE_CERT_NAME     — Common name of the tvOS Development certificate,
#                         e.g. "Apple Development: Your Name (ABCDEFGHIJ)"
#
# Optional:
#
#   RELEASE_DIR         — Override output directory. Defaults to
#                         ${REPO_ROOT}/dist/tvos-device (device builds) or
#                         ${REPO_ROOT}/dist/tvos-sim (simulator builds).
#
# =================================================================
# Usage:
# =================================================================
#
#   scripts/build_tvos_native.sh                # device release build (requires team ID)
#   scripts/build_tvos_native.sh --sim          # simulator debug build (unsigned)
#   scripts/build_tvos_native.sh --sim --release # simulator release build
#
# =================================================================
# Exit codes:
# =================================================================
#
#   0  build succeeded (artifact is in $RELEASE_DIR)
#   1  missing prerequisite tool, env var, or Xcode project
#   2  xcodebuild failed
#   3  signing or post-processing failed
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TVOS_DIR="${REPO_ROOT}/src-tvos"
CLIENT_DIR="${REPO_ROOT}/client"
SCHEME="concord-tvos"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log()  { printf '\033[1;36m[build_tvos]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build_tvos]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build_tvos ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

require_tool() {
    local tool="$1"
    local hint="$2"
    if ! command -v "${tool}" >/dev/null 2>&1; then
        die "missing required tool '${tool}'. ${hint}" 1
    fi
}

# ----------------------------------------------------------------------------
# Arg parsing
# ----------------------------------------------------------------------------
MODE="device"            # device | sim
PROFILE="release"        # release | debug
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
            sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#$//'
            exit 0
            ;;
        *)
            die "unknown argument: $1" 1
            ;;
    esac
done

# Simulator builds default to debug.
if [[ "${MODE}" == "sim" && "${PROFILE_EXPLICIT}" -eq 0 ]]; then
    PROFILE="debug"
fi

# Default RELEASE_DIR depends on mode.
if [[ "${MODE}" == "sim" ]]; then
    RELEASE_DIR="${RELEASE_DIR:-${REPO_ROOT}/dist/tvos-sim}"
else
    RELEASE_DIR="${RELEASE_DIR:-${REPO_ROOT}/dist/tvos-device}"
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
require_tool node "Install Node 18+ via homebrew: brew install node"
require_tool xcodebuild "Install Xcode 15+ from the App Store"

# Verify the Xcode project exists.
if [[ ! -f "${TVOS_DIR}/project.yml" ]]; then
    die "no project.yml found at ${TVOS_DIR}/project.yml. The src-tvos/ scaffold is missing." 1
fi

# Device builds need a signing identity.
SIGNED_BUILD=0
if [[ "${MODE}" == "device" ]]; then
    if [[ -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_CERT_NAME:-}" ]]; then
        SIGNED_BUILD=1
        log "Device build mode: SIGNED (team=${APPLE_TEAM_ID}, cert=${APPLE_CERT_NAME})"
    else
        warn "APPLE_TEAM_ID and/or APPLE_CERT_NAME unset — producing UNSIGNED device build."
    fi
else
    log "Simulator build mode: unsigned"
fi

log "xcodebuild:  $(xcodebuild -version | head -n1)"
log "mode:        ${MODE}"
log "profile:     ${PROFILE}"
log "release_dir: ${RELEASE_DIR}"

# ----------------------------------------------------------------------------
# Build the React client
# ----------------------------------------------------------------------------
log "Building React client (${CLIENT_DIR})..."
pushd "${CLIENT_DIR}" >/dev/null
if [[ ! -d node_modules ]] \
   || [[ ! -f node_modules/.package-lock.json ]] \
   || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
    log "node_modules is missing or stale — running npm ci"
    npm ci
fi
npm run build
popd >/dev/null

# ----------------------------------------------------------------------------
# Copy client/dist into the tvOS bundle resources
# ----------------------------------------------------------------------------
RESOURCES_DIR="${TVOS_DIR}/concord-tvos/Resources/dist"
log "Copying client/dist -> ${RESOURCES_DIR}"
rm -rf "${RESOURCES_DIR}"
mkdir -p "${RESOURCES_DIR}"
cp -R "${CLIENT_DIR}/dist/"* "${RESOURCES_DIR}/"

# ----------------------------------------------------------------------------
# Generate Xcode project from project.yml (requires xcodegen)
# ----------------------------------------------------------------------------
if command -v xcodegen >/dev/null 2>&1; then
    log "Generating Xcode project from project.yml..."
    pushd "${TVOS_DIR}" >/dev/null
    xcodegen generate
    popd >/dev/null
else
    warn "xcodegen not found — skipping project generation."
    warn "Install: brew install xcodegen, or manually maintain the .xcodeproj."
    if [[ ! -d "${TVOS_DIR}/${SCHEME}.xcodeproj" ]]; then
        die "no .xcodeproj found and xcodegen is not available." 1
    fi
fi

# ----------------------------------------------------------------------------
# Build with xcodebuild
# ----------------------------------------------------------------------------
XCODE_CONFIGURATION=$( [[ "${PROFILE}" == "debug" ]] && echo Debug || echo Release )

if [[ "${MODE}" == "sim" ]]; then
    DESTINATION="platform=tvOS Simulator,name=Apple TV 4K (3rd generation)"
else
    DESTINATION="generic/platform=tvOS"
fi

XCODEBUILD_ARGS=(
    -project "${TVOS_DIR}/${SCHEME}.xcodeproj"
    -scheme "${SCHEME}"
    -configuration "${XCODE_CONFIGURATION}"
    -destination "${DESTINATION}"
)

if [[ "${SIGNED_BUILD}" -eq 1 ]]; then
    XCODEBUILD_ARGS+=(
        DEVELOPMENT_TEAM="${APPLE_TEAM_ID}"
        CODE_SIGN_IDENTITY="${APPLE_CERT_NAME}"
    )
else
    XCODEBUILD_ARGS+=(
        CODE_SIGN_IDENTITY=""
        CODE_SIGNING_REQUIRED=NO
        CODE_SIGNING_ALLOWED=NO
    )
fi

if [[ "${MODE}" == "device" ]]; then
    # Archive for device builds.
    ARCHIVE_PATH="${TVOS_DIR}/build/${SCHEME}.xcarchive"
    rm -rf "${ARCHIVE_PATH}"
    XCODEBUILD_ARGS+=(
        -archivePath "${ARCHIVE_PATH}"
        archive
    )
else
    XCODEBUILD_ARGS+=(build)
fi

log "Running: xcodebuild ${XCODEBUILD_ARGS[*]}"
if ! xcodebuild "${XCODEBUILD_ARGS[@]}"; then
    die "xcodebuild failed" 2
fi

# ----------------------------------------------------------------------------
# Locate artifacts
# ----------------------------------------------------------------------------
APP_BUNDLE=""
if [[ "${MODE}" == "device" && -d "${ARCHIVE_PATH}" ]]; then
    APP_BUNDLE="$(find "${ARCHIVE_PATH}/Products/Applications" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -n1 || true)"
fi

# Simulator builds land in DerivedData.
if [[ -z "${APP_BUNDLE}" ]]; then
    DERIVED_DATA="${HOME}/Library/Developer/Xcode/DerivedData"
    APP_BUNDLE="$(find "${DERIVED_DATA}" -maxdepth 6 -path "*/${SCHEME}/*Build/Products/*" -name '*.app' -print 2>/dev/null | head -n1 || true)"
fi

if [[ -z "${APP_BUNDLE}" ]]; then
    die "no .app produced. Check xcodebuild output above." 2
fi

log "Build artifact: ${APP_BUNDLE}"

# ----------------------------------------------------------------------------
# Aggregate into release directory
# ----------------------------------------------------------------------------
mkdir -p "${RELEASE_DIR}"
log "Copying artifact to ${RELEASE_DIR}"
cp -R "${APP_BUNDLE}" "${RELEASE_DIR}/"

if [[ "${MODE}" == "device" && "${SIGNED_BUILD}" -eq 0 ]]; then
    warn "UNSIGNED device .app produced at ${RELEASE_DIR}."
fi

log "Done. Artifact ready in ${RELEASE_DIR}"
