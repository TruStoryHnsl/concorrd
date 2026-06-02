#!/usr/bin/env bash
# build_tvos_native.sh — Build the Concord tvOS (Apple TV) app.
#
# Runs on macOS (Xcode 15+). Builds the SwiftUI Path C shell from
# src-tvos/ConcordTV.xcodeproj targeting the Apple TV SDK.
#
# =================================================================
# Usage:
# =================================================================
#
#   scripts/build_tvos_native.sh              # release build (device)
#   scripts/build_tvos_native.sh --sim        # debug build (simulator)
#   scripts/build_tvos_native.sh --clean      # clean before building
#   scripts/build_tvos_native.sh --help       # show this help
#
# =================================================================
# Prerequisites:
# =================================================================
#
#   - macOS with Xcode 15+ installed
#   - tvOS SDK available (ships with Xcode by default)
#   - Apple Developer Program team (for signed device builds)
#
# =================================================================
# Output:
# =================================================================
#
#   Device build:    src-tvos/build/Release-appletvos/ConcordTV.app
#   Simulator build: src-tvos/build/Debug-appletvsimulator/ConcordTV.app
#
# =================================================================
# Exit codes:
# =================================================================
#
#   0  build succeeded
#   1  prerequisite check failed
#   2  xcodebuild failed
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TVOS_PROJECT="${REPO_ROOT}/src-tvos/ConcordTV.xcodeproj"
BUILD_DIR="${REPO_ROOT}/src-tvos/build"

# Defaults
MODE="release"
CLEAN=false

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log()  { printf '\033[1;36m[tvos-build]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[tvos-build]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[tvos-build ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }
ok()   { printf '\033[1;32m[tvos-build]\033[0m %s\n' "$*"; }

# ----------------------------------------------------------------------------
# Arg parsing
# ----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sim|--simulator)
            MODE="simulator"
            shift
            ;;
        --clean)
            CLEAN=true
            shift
            ;;
        -h|--help)
            sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#$//'
            exit 0
            ;;
        *)
            die "unknown argument: $1" 1
            ;;
    esac
done

# ----------------------------------------------------------------------------
# Prerequisite checks
# ----------------------------------------------------------------------------
log "Checking prerequisites..."

# 1. Xcode
if ! command -v xcodebuild &>/dev/null; then
    die "xcodebuild not found — install Xcode 15+ from the Mac App Store" 1
fi

XCODE_VERSION="$(xcodebuild -version 2>/dev/null | head -1)"
log "  Xcode: ${XCODE_VERSION}"

# 2. tvOS SDK
TVOS_SDK_PATH="$(xcrun --sdk appletvos --show-sdk-path 2>/dev/null || echo "")"
if [[ -z "${TVOS_SDK_PATH}" ]]; then
    die "tvOS SDK not found — ensure Xcode includes the tvOS platform (Xcode → Settings → Platforms)" 1
fi
log "  tvOS SDK: ${TVOS_SDK_PATH}"

TVOS_SIM_SDK_PATH="$(xcrun --sdk appletvsimulator --show-sdk-path 2>/dev/null || echo "")"
if [[ "${MODE}" == "simulator" && -z "${TVOS_SIM_SDK_PATH}" ]]; then
    die "tvOS Simulator SDK not found — download it via Xcode → Settings → Platforms" 1
fi

# 3. Project exists
if [[ ! -d "${TVOS_PROJECT}" ]]; then
    die "Xcode project not found at ${TVOS_PROJECT}" 1
fi

log "  Project: ${TVOS_PROJECT}"

# ----------------------------------------------------------------------------
# Build client dist (the web bundle tvOS would serve if WebKit were available;
# still useful as a reference build to verify the client compiles)
# ----------------------------------------------------------------------------
if [[ -f "${REPO_ROOT}/client/package.json" ]]; then
    log "Building client dist (reference build)..."
    (cd "${REPO_ROOT}/client" && npm ci --silent 2>/dev/null && npm run build --silent 2>/dev/null) || warn "Client build skipped (non-fatal for tvOS native shell)"
fi

# ----------------------------------------------------------------------------
# Clean (optional)
# ----------------------------------------------------------------------------
if [[ "${CLEAN}" == true ]]; then
    log "Cleaning previous build..."
    rm -rf "${BUILD_DIR}"
fi

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
mkdir -p "${BUILD_DIR}"

if [[ "${MODE}" == "simulator" ]]; then
    log "Building ConcordTV for tvOS Simulator (Debug)..."
    xcodebuild \
        -project "${TVOS_PROJECT}" \
        -scheme ConcordTV \
        -configuration Debug \
        -sdk appletvsimulator \
        -derivedDataPath "${BUILD_DIR}" \
        ONLY_ACTIVE_ARCH=YES \
        build 2>&1 | tail -20

    ARTIFACT="${BUILD_DIR}/Build/Products/Debug-appletvsimulator/ConcordTV.app"
else
    log "Building ConcordTV for Apple TV (Release)..."

    # Check for signing identity
    SIGNING_FLAGS=()
    if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
        log "  Team ID: ${APPLE_TEAM_ID}"
        SIGNING_FLAGS+=(
            "DEVELOPMENT_TEAM=${APPLE_TEAM_ID}"
            "CODE_SIGN_STYLE=Automatic"
        )
    else
        warn "APPLE_TEAM_ID not set — building unsigned (sideload only)"
        SIGNING_FLAGS+=(
            "CODE_SIGN_IDENTITY=-"
            "CODE_SIGNING_REQUIRED=NO"
            "CODE_SIGNING_ALLOWED=NO"
        )
    fi

    xcodebuild \
        -project "${TVOS_PROJECT}" \
        -scheme ConcordTV \
        -configuration Release \
        -sdk appletvos \
        -derivedDataPath "${BUILD_DIR}" \
        "${SIGNING_FLAGS[@]}" \
        build 2>&1 | tail -20

    ARTIFACT="${BUILD_DIR}/Build/Products/Release-appletvos/ConcordTV.app"
fi

# ----------------------------------------------------------------------------
# Result
# ----------------------------------------------------------------------------
if [[ -d "${ARTIFACT}" ]]; then
    ok "Build succeeded!"
    ok "Artifact: ${ARTIFACT}"
    ok "Size: $(du -sh "${ARTIFACT}" | cut -f1)"
    exit 0
else
    die "Build completed but artifact not found at ${ARTIFACT}" 2
fi
