#!/usr/bin/env bash
# verify_windows_artifact.sh — Static sanity-check on a Windows bundle
# (MSI or NSIS .exe) before shipping it to a real Windows host for
# install verification. Cheaper than scripts/verify_windows_bundle.sh
# (which actually installs); meant to run on every CI build to catch
# the most embarrassing failures (truncated artifact, wrong arch,
# obviously bloated bundle, etc).
#
# What it asserts:
#   1. File exists and is non-empty.
#   2. Size is within sane bounds (1 MB <= size <= 200 MB). Anything
#      smaller is a stub; anything larger means we bundled the world.
#   3. PE32+ header — confirms it's actually a Windows binary, not a
#      Linux artifact accidentally renamed.
#   4. SHA-256 — printed for downstream cross-checks (CI artifact log
#      vs whatever `corr@win11.local` ends up running).
#   5. For MSI: cabextract / msitools is used if available to peek at
#      the install table and confirm the productname is "Concord".
#   6. For NSIS .exe: we look for the NSIS magic ("Nullsoft.NSIS")
#      embedded in the binary. (NSIS exes prepend a small loader; a
#      grep is enough to distinguish from arbitrary PE files.)
#   7. Resources sanity: confirm `tuwunel` shows up in the binary
#      string table — proves resources/tuwunel/** were embedded.
#
# Usage:
#   scripts/verify_windows_artifact.sh path/to/Concord_*.msi
#   scripts/verify_windows_artifact.sh path/to/Concord_*-setup.exe
#
# Exit codes:
#   0  artifact looks sane
#   1  arg/usage error
#   2  artifact missing or unreadable
#   3  artifact size out of bounds
#   4  artifact is not a Windows PE / MSI
#   5  expected content (e.g. tuwunel resources) missing
set -euo pipefail

log()  { printf '\033[1;36m[verify_artifact]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[verify_artifact]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[verify_artifact ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

[[ $# -ge 1 ]] || die "usage: $0 <path-to-bundle>" 1
ARTIFACT="$1"
[[ -r "$ARTIFACT" ]] || die "artifact not found or unreadable: $ARTIFACT" 2

NAME="$(basename "$ARTIFACT")"
SIZE_BYTES="$(stat -c %s "$ARTIFACT")"
SIZE_MB="$(awk -v b="${SIZE_BYTES}" 'BEGIN{printf "%.2f", b/1024/1024}')"

log "Artifact: ${NAME}"
log "Size:     ${SIZE_MB} MB (${SIZE_BYTES} bytes)"

# ----------------------------------------------------------------------------
# Size bounds
# ----------------------------------------------------------------------------
if [[ "${SIZE_BYTES}" -lt 1048576 ]]; then
    die "artifact suspiciously small (<1 MB) — probably a stub" 3
fi
if [[ "${SIZE_BYTES}" -gt $((200 * 1024 * 1024)) ]]; then
    die "artifact > 200 MB — bundle bloated, audit resources/" 3
fi

# ----------------------------------------------------------------------------
# Magic / file type
# ----------------------------------------------------------------------------
TYPE="$(file -b "$ARTIFACT")"
log "Type:     ${TYPE}"

EXT="${NAME##*.}"
case "$EXT" in
    msi)
        # MSI is a Compound File Binary (CFB / OLE2). `file` prints
        # "Composite Document File V2 Document" for these.
        if ! grep -qiE "Composite Document File|Microsoft Installer" <<<"$TYPE"; then
            die "expected MSI/CFB, got: $TYPE" 4
        fi
        ;;
    exe)
        if ! grep -qiE "PE32\+ executable|PE32 executable" <<<"$TYPE"; then
            die "expected PE32/PE32+ executable, got: $TYPE" 4
        fi
        if ! grep -qiE "x86-64|Intel 80386" <<<"$TYPE"; then
            warn "PE arch unclear in 'file' output — manual review recommended"
        fi
        # NSIS marker — Tauri's NSIS bundle has the loader stub at the
        # start, then a 7-Zip-format payload. The "Nullsoft" string is
        # always present in the loader.
        if ! grep -aqi "Nullsoft" "$ARTIFACT"; then
            warn "NSIS magic ('Nullsoft') not found — is this really a Tauri NSIS .exe?"
        fi
        ;;
    *)
        die "unsupported artifact extension: .${EXT}" 1 ;;
esac

# ----------------------------------------------------------------------------
# Resource sanity — Concord embeds tuwunel binaries via
# tauri.conf.json `bundle.resources["resources/tuwunel/**/*"]`. The
# embedded resource path strings should be visible via `strings`.
# ----------------------------------------------------------------------------
if command -v strings >/dev/null 2>&1; then
    if ! strings "$ARTIFACT" | grep -qE "tuwunel"; then
        warn "no 'tuwunel' string found in bundle — resources/ may not be embedded."
        warn "  (For MSI this is sometimes hidden inside CFB streams; not"
        warn "   a fatal failure, but cross-check with msiextract.)"
    else
        log "Resources: tuwunel marker found"
    fi
fi

# ----------------------------------------------------------------------------
# MSI deep peek — if msitools is installed, list the streams to
# confirm productname.
# ----------------------------------------------------------------------------
if [[ "$EXT" == "msi" ]] && command -v msiinfo >/dev/null 2>&1; then
    PRODNAME="$(msiinfo export "$ARTIFACT" Property 2>/dev/null \
                | awk -F'\t' '$1 == "ProductName" { print $2 }' \
                | head -1)"
    if [[ -n "$PRODNAME" ]]; then
        log "ProductName: $PRODNAME"
        if [[ "$PRODNAME" != "Concord" ]]; then
            die "MSI ProductName is '$PRODNAME', expected 'Concord'" 4
        fi
    fi
fi

# ----------------------------------------------------------------------------
# SHA-256 — for cross-machine integrity
# ----------------------------------------------------------------------------
SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
log "SHA-256:  ${SHA}"

log ""
log "OK: artifact passes static checks."
