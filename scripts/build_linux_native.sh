#!/usr/bin/env bash
# build_linux_native.sh — Build Concord as a native Linux desktop bundle
# (AppImage + .deb) via Tauri v2.
#
# Designed to run on orrion (CachyOS) but works on any Linux x86_64 host with
# the listed prerequisites installed. See client/NATIVE_BUILD.md for the full
# prerequisite matrix and machine-split convention.
#
# Usage:
#   scripts/build_linux_native.sh           # build only
#   scripts/build_linux_native.sh --smoke   # build then smoke-launch the AppImage
#
# Exit codes:
#   0  build (and smoke, if requested) succeeded
#   1  missing prerequisite tool
#   2  build failed
#   3  smoke test failed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_TAURI="${REPO_ROOT}/src-tauri"
CLIENT_DIR="${REPO_ROOT}/client"

# Pinned upstream tuwunel version bundled as the embedded-servitude
# Matrix homeserver. Bump via PR when the upstream track ships a new
# stable release. See PLAN.md INS-022 Wave 2 for the rationale behind
# the "bundle upstream .deb as a child process" approach.
TUWUNEL_VERSION="v1.5.1"
# Baseline x86_64 variant — runs on any modern Intel/AMD CPU without
# requiring v2/v3 instruction sets.
TUWUNEL_DEB_ASSET="${TUWUNEL_VERSION}-release-all-x86_64-v1-linux-gnu-tuwunel.deb"
TUWUNEL_DEB_URL="https://github.com/matrix-construct/tuwunel/releases/download/${TUWUNEL_VERSION}/${TUWUNEL_DEB_ASSET}"
# Cache location — the downloaded .deb is large (~35MB) and we don't
# want to re-fetch it on every build. Kept outside src-tauri so cargo
# clean doesn't wipe it.
TUWUNEL_CACHE_DIR="${REPO_ROOT}/.build-cache/tuwunel"
# Final bundled path — declared in tauri.conf.json under
# `bundle.resources` so the AppImage/deb pick it up automatically.
TUWUNEL_BUNDLED_DIR="${SRC_TAURI}/resources/tuwunel"
TUWUNEL_BUNDLED_BIN="${TUWUNEL_BUNDLED_DIR}/tuwunel"

# Pinned upstream mautrix-discord version bundled as the embedded
# Discord-bridge child process. See PLAN.md INS-024 Wave 3 for the
# sandboxed-child-process rationale. Bump via PR when upstream ships a
# release fixing a Discord API drift or CVE; the Rust test suite
# (`cargo test -p concord_app discord_bridge`) is the regression gate.
MAUTRIX_DISCORD_VERSION="v0.7.2"
# Linux amd64 tar.gz release asset from the mautrix-discord GitHub
# releases page. Matches the Docker image (`dock.mau.dev/mautrix/discord:v0.7.2`)
# shipped in Wave 2's docker-compose.yml so desktop + Docker paths
# stay feature-parity.
MAUTRIX_DISCORD_ASSET="mautrix-discord-amd64"
MAUTRIX_DISCORD_URL="https://github.com/mautrix/discord/releases/download/${MAUTRIX_DISCORD_VERSION}/${MAUTRIX_DISCORD_ASSET}"
MAUTRIX_DISCORD_CACHE_DIR="${REPO_ROOT}/.build-cache/mautrix-discord"
MAUTRIX_DISCORD_BUNDLED_DIR="${SRC_TAURI}/resources/discord_bridge"
MAUTRIX_DISCORD_BUNDLED_BIN="${MAUTRIX_DISCORD_BUNDLED_DIR}/mautrix-discord"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log()  { printf '\033[1;36m[build_linux]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build_linux]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build_linux ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

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
require_tool npm   "Comes with Node"

if ! cargo tauri --version >/dev/null 2>&1; then
    die "tauri-cli is not installed. Run: cargo install tauri-cli --version '^2.0' --locked" 1
fi

# Optional but warn if missing — don't block the build.
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    warn "webkit2gtk-4.1 development files not detected. The build will fail without them."
    warn "  CachyOS/Arch: sudo pacman -S webkit2gtk-4.1 gtk3 librsvg patchelf"
    warn "  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf"
fi

# Bubblewrap is required for the sandboxed Discord bridge. Auto-install
# if missing — it's a runtime dependency, not a build-time one, but we
# want the build to produce a fully functional bundle.
if ! command -v bwrap >/dev/null 2>&1; then
    log "bubblewrap (bwrap) not found — installing..."
    if command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm --needed bubblewrap \
            || die "failed to install bubblewrap via pacman" 1
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y bubblewrap \
            || die "failed to install bubblewrap via apt" 1
    else
        die "bubblewrap (bwrap) is required for the Discord bridge sandbox. Install it manually." 1
    fi
    log "bubblewrap installed: $(bwrap --version 2>&1 || echo 'ok')"
else
    log "bwrap:       $(bwrap --version 2>&1 || echo 'present')"
fi

log "cargo:       $(cargo --version)"
log "rustc:       $(rustc --version)"
log "tauri-cli:   $(cargo tauri --version)"
log "node:        $(node --version)"

# ----------------------------------------------------------------------------
# Fetch and stage upstream tuwunel binary for embedded-servitude bundle
# ----------------------------------------------------------------------------
#
# The embedded servitude module spawns tuwunel as a child process on
# `servitude_start`. To make that work from an installed AppImage/.deb
# without requiring the end user to install tuwunel separately, we
# download the upstream tuwunel release .deb, extract the binary, and
# drop it at src-tauri/resources/tuwunel/tuwunel. `tauri.conf.json`
# declares resources/tuwunel/** under `bundle.resources` so the Tauri
# bundler includes the binary in the final AppImage/deb.
#
# At runtime, `resolve_binary()` in
# src-tauri/src/servitude/transport/matrix_federation.rs looks next to
# the current executable and finds the binary via the same relative
# path the bundler writes it to.

stage_tuwunel_binary() {
    if [[ -f "${TUWUNEL_BUNDLED_BIN}" ]]; then
        log "Bundled tuwunel already present: ${TUWUNEL_BUNDLED_BIN}"
        return 0
    fi

    mkdir -p "${TUWUNEL_CACHE_DIR}"
    mkdir -p "${TUWUNEL_BUNDLED_DIR}"

    local cache_deb="${TUWUNEL_CACHE_DIR}/${TUWUNEL_DEB_ASSET}"

    if [[ ! -f "${cache_deb}" ]]; then
        log "Downloading upstream tuwunel ${TUWUNEL_VERSION}..."
        log "  ${TUWUNEL_DEB_URL}"
        if command -v curl >/dev/null 2>&1; then
            curl -fL --retry 3 -o "${cache_deb}" "${TUWUNEL_DEB_URL}" \
                || die "failed to download tuwunel .deb" 2
        elif command -v wget >/dev/null 2>&1; then
            wget -O "${cache_deb}" "${TUWUNEL_DEB_URL}" \
                || die "failed to download tuwunel .deb" 2
        else
            die "neither curl nor wget available to fetch tuwunel .deb" 1
        fi
    else
        log "Using cached tuwunel .deb: ${cache_deb}"
    fi

    # Extract the .deb's data tarball. Debian packages are `ar` archives
    # containing `data.tar.*`. Native `dpkg-deb` does this cleanly; the
    # `ar` + `tar` fallback covers non-Debian build hosts.
    local extract_tmp
    extract_tmp="$(mktemp -d)"
    trap 'rm -rf "${extract_tmp}"' EXIT

    if command -v dpkg-deb >/dev/null 2>&1; then
        log "Extracting tuwunel binary via dpkg-deb..."
        dpkg-deb -x "${cache_deb}" "${extract_tmp}" \
            || die "dpkg-deb extraction failed" 2
    else
        log "Extracting tuwunel binary via ar + tar fallback (no dpkg-deb)..."
        (
            cd "${extract_tmp}"
            ar x "${cache_deb}"
            # data.tar may be .xz, .gz, or .zst depending on packager
            if [[ -f data.tar.zst ]]; then
                zstd -d --stdout data.tar.zst | tar -xf -
            elif [[ -f data.tar.xz ]]; then
                tar -xf data.tar.xz
            elif [[ -f data.tar.gz ]]; then
                tar -xzf data.tar.gz
            else
                die "unsupported data.tar format inside tuwunel .deb" 2
            fi
        )
    fi

    local extracted_bin
    extracted_bin="$(find "${extract_tmp}" -type f -name tuwunel -executable 2>/dev/null | head -n1 || true)"
    if [[ -z "${extracted_bin}" ]]; then
        # Some .deb packages don't mark the executable bit until install
        # scripts run — fall back to a name-only lookup and chmod.
        extracted_bin="$(find "${extract_tmp}" -type f -name tuwunel 2>/dev/null | head -n1 || true)"
    fi
    if [[ -z "${extracted_bin}" ]]; then
        die "could not find tuwunel binary inside extracted .deb" 2
    fi

    cp "${extracted_bin}" "${TUWUNEL_BUNDLED_BIN}"
    chmod +x "${TUWUNEL_BUNDLED_BIN}"
    rm -rf "${extract_tmp}"
    trap - EXIT

    log "Staged bundled tuwunel at ${TUWUNEL_BUNDLED_BIN}"
    log "  size: $(stat -c%s "${TUWUNEL_BUNDLED_BIN}" 2>/dev/null || stat -f%z "${TUWUNEL_BUNDLED_BIN}") bytes"
}

stage_tuwunel_binary

# ----------------------------------------------------------------------------
# Fetch and stage upstream mautrix-discord binary for sandboxed Discord bridge
# ----------------------------------------------------------------------------
#
# INS-024 Wave 3: the embedded servitude's DiscordBridge transport spawns
# mautrix-discord as a bubblewrap-sandboxed child process. To make that
# work from an installed AppImage/.deb without requiring the end user to
# install mautrix-discord separately, we download the upstream release
# binary and drop it at src-tauri/resources/discord_bridge/mautrix-discord.
# `tauri.conf.json` declares resources/discord_bridge/** under
# bundle.resources so the Tauri bundler picks it up.
#
# At runtime, `resolve_binary()` in
# src-tauri/src/servitude/transport/discord_bridge.rs looks next to the
# current executable and finds the binary via the same relative path.
#
# The bridge is a NON-CRITICAL transport — if this download fails (no
# network, GitHub outage, etc.), the build still produces a usable
# Concord bundle that runs without Discord support. The runtime's
# `resolve_binary()` surfaces `BinaryNotFound` and the Discord bridge
# lands in the degraded state.
stage_mautrix_discord_binary() {
    if [[ -f "${MAUTRIX_DISCORD_BUNDLED_BIN}" ]]; then
        log "Bundled mautrix-discord already present: ${MAUTRIX_DISCORD_BUNDLED_BIN}"
        return 0
    fi

    mkdir -p "${MAUTRIX_DISCORD_CACHE_DIR}"
    mkdir -p "${MAUTRIX_DISCORD_BUNDLED_DIR}"

    local cache_bin="${MAUTRIX_DISCORD_CACHE_DIR}/${MAUTRIX_DISCORD_ASSET}"

    if [[ ! -f "${cache_bin}" ]]; then
        log "Downloading upstream mautrix-discord ${MAUTRIX_DISCORD_VERSION}..."
        log "  ${MAUTRIX_DISCORD_URL}"
        if command -v curl >/dev/null 2>&1; then
            if ! curl -fL --retry 3 -o "${cache_bin}" "${MAUTRIX_DISCORD_URL}"; then
                warn "failed to download mautrix-discord — building without Discord bridge support"
                warn "  (DiscordBridge transport will report BinaryNotFound at runtime)"
                return 0
            fi
        elif command -v wget >/dev/null 2>&1; then
            if ! wget -O "${cache_bin}" "${MAUTRIX_DISCORD_URL}"; then
                warn "failed to download mautrix-discord — building without Discord bridge support"
                return 0
            fi
        else
            warn "neither curl nor wget available to fetch mautrix-discord — skipping"
            return 0
        fi
    else
        log "Using cached mautrix-discord: ${cache_bin}"
    fi

    cp "${cache_bin}" "${MAUTRIX_DISCORD_BUNDLED_BIN}"
    chmod +x "${MAUTRIX_DISCORD_BUNDLED_BIN}"

    log "Staged bundled mautrix-discord at ${MAUTRIX_DISCORD_BUNDLED_BIN}"
    log "  size: $(stat -c%s "${MAUTRIX_DISCORD_BUNDLED_BIN}" 2>/dev/null || stat -f%z "${MAUTRIX_DISCORD_BUNDLED_BIN}") bytes"

    # Non-blocking warning if bwrap is missing on the build host. The
    # runtime still enforces the sandbox contract, but operators
    # installing the .deb will get bubblewrap via the package's
    # declared `depends` array in tauri.conf.json.
    if ! command -v bwrap >/dev/null 2>&1; then
        warn "bwrap (bubblewrap) not found on build host. This is fine for the build itself —"
        warn "the .deb package declares bubblewrap as a runtime dep, and the AppImage refuses"
        warn "to start the Discord bridge without bwrap at runtime. Install locally if you"
        warn "want to smoke-test the sandboxed path: pacman -S bubblewrap OR apt install bubblewrap"
    fi
}

stage_mautrix_discord_binary

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

log "Running cargo tauri build (appimage,deb)..."
# NO_STRIP=true: linuxdeploy (the AppImage tool tauri invokes) does not
# cope with ELF binaries whose section headers have been stripped — it
# bails with "failed to run linuxdeploy" and no useful error. Disabling
# the bundler's strip pass costs ~10MB of release-binary size but makes
# the AppImage build reliable. The deb bundle is unaffected.
pushd "${SRC_TAURI}" >/dev/null
if ! NO_STRIP=true cargo tauri build --bundles appimage,deb; then
    die "cargo tauri build failed" 2
fi
popd >/dev/null

# ----------------------------------------------------------------------------
# Locate artifacts
# ----------------------------------------------------------------------------
BUNDLE_DIR="${SRC_TAURI}/target/release/bundle"
APPIMAGE="$(find "${BUNDLE_DIR}/appimage" -maxdepth 1 -name '*.AppImage' 2>/dev/null | head -n1 || true)"
DEB="$(find "${BUNDLE_DIR}/deb" -maxdepth 2 -name '*.deb' 2>/dev/null | head -n1 || true)"

log "Build artifacts:"
[[ -n "${APPIMAGE}" ]] && log "  AppImage: ${APPIMAGE}" || warn "  AppImage: NOT FOUND"
[[ -n "${DEB}"      ]] && log "  Deb:      ${DEB}"      || warn "  Deb:      NOT FOUND"

# ----------------------------------------------------------------------------
# Optional smoke test
# ----------------------------------------------------------------------------
if [[ "${1:-}" == "--smoke" ]]; then
    if [[ -z "${APPIMAGE}" ]]; then
        die "cannot smoke-test: no AppImage produced" 3
    fi

    log "Running smoke test on AppImage..."
    chmod +x "${APPIMAGE}"

    SMOKE_CMD=("${APPIMAGE}" --version)
    if command -v xvfb-run >/dev/null 2>&1; then
        log "Wrapping in xvfb-run for headless launch"
        SMOKE_CMD=(xvfb-run -a "${APPIMAGE}" --version)
    else
        warn "xvfb-run not available; running AppImage directly (display may be required)"
    fi

    if "${SMOKE_CMD[@]}" >/dev/null 2>&1; then
        log "Smoke test passed."
    else
        # --version is not guaranteed by Tauri shells; fall back to a 2s launch.
        warn "--version flag failed; trying a 2-second launch..."
        if timeout 2s "${SMOKE_CMD[@]:0:1}" >/dev/null 2>&1; then
            log "Smoke launch survived 2s — assuming healthy."
        else
            EC=$?
            # timeout exits 124 on success-by-timeout, which is what we want.
            if [[ ${EC} -eq 124 ]]; then
                log "Smoke launch survived 2s (timeout reached) — assuming healthy."
            else
                die "Smoke test failed (exit ${EC})" 3
            fi
        fi
    fi
fi

log "Done."
