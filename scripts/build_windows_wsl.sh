#!/usr/bin/env bash
# build_windows_wsl.sh — Cross-build Concord as a native Windows .msi from WSL.
#
# Designed to run on orrion under WSL (or any Linux host with the
# `x86_64-pc-windows-msvc` target installed via xwin/cargo-xwin).
#
# Prereqs:
#   - rustup target add x86_64-pc-windows-msvc
#   - cargo install cargo-xwin    (handles MSVC headers + libs without needing
#                                  Visual Studio installed natively)
#   - cargo install tauri-cli --version '^2.0' --locked
#   - WiX 3.x is fetched automatically by Tauri's MSI bundler on first run.
#
# Usage:
#   scripts/build_windows_wsl.sh
#
# Exit codes:
#   0  build succeeded
#   1  missing prerequisite
#   2  build failed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_TAURI="${REPO_ROOT}/src-tauri"
CLIENT_DIR="${REPO_ROOT}/client"

log()  { printf '\033[1;36m[build_windows_wsl]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build_windows_wsl]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build_windows_wsl ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

require_tool() {
    local tool="$1"
    local hint="$2"
    if ! command -v "${tool}" >/dev/null 2>&1; then
        die "missing required tool '${tool}'. ${hint}" 1
    fi
}

# ----------------------------------------------------------------------------
# Prerequisite checks
# ----------------------------------------------------------------------------
log "Checking prerequisites..."
require_tool cargo "Install Rust: https://rustup.rs/"
require_tool node  "Install Node 18+ for the React client build"

if ! cargo tauri --version >/dev/null 2>&1; then
    die "tauri-cli is not installed. Run: cargo install tauri-cli --version '^2.0' --locked" 1
fi

if ! rustup target list --installed 2>/dev/null | grep -qx "x86_64-pc-windows-msvc"; then
    log "Installing Rust target x86_64-pc-windows-msvc"
    rustup target add x86_64-pc-windows-msvc
fi

if ! cargo xwin --version >/dev/null 2>&1; then
    warn "cargo-xwin not detected. Install with: cargo install cargo-xwin"
    warn "  (Required for MSVC headers + libs when not on a real Windows host.)"
fi

log "cargo:       $(cargo --version)"
log "rustc:       $(rustc --version)"
log "tauri-cli:   $(cargo tauri --version)"
log "node:        $(node --version)"

# ----------------------------------------------------------------------------
# Build the React client
# ----------------------------------------------------------------------------
log "Building React client (${CLIENT_DIR})..."
pushd "${CLIENT_DIR}" >/dev/null
if [[ ! -d node_modules ]]; then
    npm ci
fi
npm run build
popd >/dev/null

# ----------------------------------------------------------------------------
# Build the Tauri shell for Windows
# ----------------------------------------------------------------------------
log "Running cargo tauri build --target x86_64-pc-windows-msvc..."
pushd "${SRC_TAURI}" >/dev/null
if ! cargo tauri build --target x86_64-pc-windows-msvc --bundles msi; then
    die "cargo tauri build failed" 2
fi
popd >/dev/null

# ----------------------------------------------------------------------------
# Locate artifacts
# ----------------------------------------------------------------------------
BUNDLE_DIR="${SRC_TAURI}/target/x86_64-pc-windows-msvc/release/bundle"
MSI="$(find "${BUNDLE_DIR}/msi" -maxdepth 1 -name '*.msi' 2>/dev/null | head -n1 || true)"

log "Build artifacts:"
[[ -n "${MSI}" ]] && log "  MSI: ${MSI}" || warn "  MSI: NOT FOUND"

log "Done. Sign with signtool.exe on a real Windows host before distribution."
