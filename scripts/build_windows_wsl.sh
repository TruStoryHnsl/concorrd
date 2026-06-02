#!/usr/bin/env bash
# build_windows_wsl.sh — Cross-build Concord as a Windows binary from a
# Linux host (or WSL) using cargo-xwin.
#
# STATUS: PARTIALLY WORKING (2026-04-27). The build chain produces a
# Windows binary if and only if every C dep cross-compiles cleanly under
# clang-cl + xwin. Concord's stronghold dep pulls in
# `libsodium-sys-stable` whose autoconf script ships C code that uses
# POSIX-only types (`pid_t`, `getpid()`); under cargo-xwin those calls
# are visible to clang-cl's MSVC mode, and the build hard-fails at:
#
#   randombytes/internal/randombytes_internal_random.c(121,5):
#       error: unknown type name 'pid_t'
#
# Until libsodium-sys-stable adds a clean MSVC cross-build path, the
# CANONICAL build paths are:
#
#   - Native: scripts/build_windows_native.ps1 on a real Windows host.
#   - CI:     .github/workflows/windows-build.yml on `windows-latest`.
#
# This script is retained because (a) several Rust deps DO cross-build
# fine and (b) once libsodium ships an MSVC fix, this becomes the
# fastest dev iteration path. It now exits with a clear diagnostic if
# the libsodium failure is detected, instead of dumping a 200-line C
# preprocessor stack and confusing the next agent.
#
# Prereqs:
#   - rustup target add x86_64-pc-windows-msvc
#   - cargo install cargo-xwin
#   - cargo install tauri-cli --version '^2.0' --locked
#   - WiX is NOT used here — bundling (.msi / NSIS .exe) requires a
#     Windows host and is deferred.
#
# Usage:
#   scripts/build_windows_wsl.sh
#
# Exit codes:
#   0  raw .exe produced (bundling deferred to Windows)
#   1  missing prerequisite
#   2  build failed (other reason — see log)
#   3  known libsodium cross-compile failure — use a real Windows host
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
    die "cargo-xwin is not installed. Run: cargo install cargo-xwin" 1
fi

log "cargo:       $(cargo --version)"
log "rustc:       $(rustc --version)"
log "tauri-cli:   $(cargo tauri --version)"
log "node:        $(node --version)"
log "cargo-xwin:  $(cargo xwin --version | head -1)"

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
# Cross-compile the Rust binary
# ----------------------------------------------------------------------------
# We deliberately do NOT use `cargo tauri build --target ...` here:
# Tauri's bundler step shells out to candle/light (WiX) which only
# function on a Windows host. A `cargo xwin build` produces the raw
# .exe; bundling is deferred to native or CI.
log "Cross-compiling Rust binary (cargo xwin build --release --target x86_64-pc-windows-msvc)..."
BUILD_LOG="$(mktemp)"
pushd "${SRC_TAURI}" >/dev/null
set +e
cargo xwin build --release --target x86_64-pc-windows-msvc 2>&1 | tee "${BUILD_LOG}"
build_rc=${PIPESTATUS[0]}
set -e
popd >/dev/null

if [[ "${build_rc}" -ne 0 ]]; then
    rc=2
    if grep -q "libsodium-sys-stable" "${BUILD_LOG}" \
       && grep -q "unknown type name 'pid_t'" "${BUILD_LOG}"; then
        warn ""
        warn "================================================================"
        warn "DETECTED: libsodium-sys-stable POSIX cross-compile failure."
        warn ""
        warn "  This is a known issue with libsodium's autoconf-generated"
        warn "  randombytes/internal/randombytes_internal_random.c which"
        warn "  references pid_t / getpid() unconditionally. Under cargo-xwin"
        warn "  + clang-cl those POSIX symbols are not visible, the build"
        warn "  fails inside the iota_stronghold dep tree."
        warn ""
        warn "  Cross-build from Linux is NOT viable for Concord today."
        warn ""
        warn "  Use one of:"
        warn "    - scripts/build_windows_native.ps1   (native, on Windows)"
        warn "    - .github/workflows/windows-build.yml (CI on windows-latest)"
        warn "================================================================"
        rc=3
    fi
    rm -f "${BUILD_LOG}"
    exit "${rc}"
fi
rm -f "${BUILD_LOG}"

# ----------------------------------------------------------------------------
# Locate raw artifact (no .msi here — bundler is Windows-only)
# ----------------------------------------------------------------------------
EXE="${SRC_TAURI}/target/x86_64-pc-windows-msvc/release/concord.exe"
if [[ ! -f "${EXE}" ]]; then
    die "expected concord.exe not produced at ${EXE}" 2
fi

log "Build artifact:"
log "  EXE: ${EXE} ($(stat -c %s "${EXE}") bytes)"
log ""
log "NOTE: bundling (.msi / NSIS .exe) requires a Windows host. Use"
log "      scripts/build_windows_native.ps1 there. This script's output"
log "      is useful for fast Rust-side iteration, not for distribution."
