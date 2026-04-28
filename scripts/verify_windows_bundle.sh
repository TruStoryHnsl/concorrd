#!/usr/bin/env bash
# verify_windows_bundle.sh — Install + smoke-launch a Concord Windows bundle
# on the test machine `corr@win11.local` over SSH and report observed state.
#
# Why this script exists
# ----------------------
# The "WRITTEN IN BLOOD" rule in CLAUDE.md is non-negotiable: a Windows
# build is not "verified" until somebody has watched it install and
# launch on a real Windows host. Doing that by hand for every PR is how
# regressions slip in. This script encodes the verification protocol so
# every developer agent runs the *same* steps and reports the *same*
# pass/fail signal.
#
# What it does (in order)
#   1. Probes SSH reachability + key-only auth to corr@win11.local.
#      ANY password prompt or auth failure is a HARD STOP — the script
#      must NEVER silently pass on a missing key. The blocker surfaces
#      to the user explicitly.
#   2. Copies the bundle (.msi or NSIS .exe) to win11 via scp.
#   3. Runs a silent install over PowerShell + msiexec /qn (or NSIS /S).
#   4. Waits for Concord.exe to appear under
#      C:\Program Files\Concord\ or %LOCALAPPDATA%\Programs\Concord\
#      (NSIS currentUser installs land in LOCALAPPDATA).
#   5. Launches Concord.exe in the background, waits ~8 seconds.
#   6. Captures a screenshot of the primary monitor via PowerShell.
#   7. SCPs the screenshot back to ./artifacts/win11-launch-<ts>.png.
#   8. Tears down: kills Concord.exe and uninstalls.
#
# This script is the verification harness; it does NOT build. Pair with
# scripts/build_windows_wsl.sh (cross-build) or
# scripts/build_windows_native.ps1 (native build on Windows).
#
# Modes
#   --dry-run    Probe SSH only; do not install. Use to confirm the test
#                machine is reachable before queuing real verification.
#   --no-uninstall  Skip teardown so a human can poke at the install.
#
# Exit codes
#   0  verified — install + launch + screenshot all succeeded
#   1  arg error
#   2  SSH unreachable / not key-auth (BLOCKER — surfaces to the user)
#   3  bundle missing or unreadable
#   4  install failed on win11
#   5  launch did not produce a Concord.exe process
#   6  screenshot capture failed
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-corr@win11.local}"
REMOTE_TMP='C:\Users\corr\AppData\Local\Temp\concord-verify'
ARTIFACT_DIR="${ARTIFACT_DIR:-$(pwd)/artifacts}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log()  { printf '\033[1;36m[verify_win]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[verify_win]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[verify_win ERROR]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

# ---------------------------------------------------------------------------
# Phase 0 — argument parsing
# ---------------------------------------------------------------------------
DRY_RUN=0
NO_UNINSTALL=0
BUNDLE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --no-uninstall) NO_UNINSTALL=1; shift ;;
        -h|--help)
            grep -E '^# ' "$0" | sed -E 's/^# ?//'
            exit 0 ;;
        --) shift; break ;;
        -*) die "unknown flag: $1" 1 ;;
        *)  BUNDLE="$1"; shift ;;
    esac
done

if [[ $DRY_RUN -eq 0 && -z "$BUNDLE" ]]; then
    die "usage: $0 [--dry-run|--no-uninstall] <path-to-bundle.msi-or-.exe>" 1
fi

# ---------------------------------------------------------------------------
# Phase 1 — SSH reachability probe (BatchMode=yes => fail on password
# prompts; this is what makes the "no silent pass" guarantee real).
# ---------------------------------------------------------------------------
log "Probing SSH to ${REMOTE_HOST} with key-only auth (BatchMode)..."
SSH_PROBE_OUT="$(
    ssh -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o StrictHostKeyChecking=accept-new \
        "$REMOTE_HOST" \
        'powershell -NoProfile -Command "Write-Output OK; (Get-CimInstance Win32_OperatingSystem).Caption"' \
        2>&1
)" || SSH_RC=$?
SSH_RC="${SSH_RC:-0}"

if [[ "$SSH_RC" -ne 0 ]] || ! grep -q '^OK' <<<"$SSH_PROBE_OUT"; then
    cat >&2 <<EOF

BLOCKER: cannot reach ${REMOTE_HOST} over SSH with key-only auth.

What the probe got back:
${SSH_PROBE_OUT}

Required setup on ${REMOTE_HOST}:
  1. Install OpenSSH Server (Settings → Apps → Optional features → "OpenSSH Server").
  2. Run as admin in PowerShell:
        Start-Service sshd
        Set-Service -Name sshd -StartupType 'Automatic'
        New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' \\
            -Enabled True -Direction Inbound -Protocol TCP \\
            -Action Allow -LocalPort 22
  3. From this Linux host, copy your public key to win11:
        ssh-copy-id corr@win11.local
     (or paste ~/.ssh/id_*.pub into C:\\Users\\corr\\.ssh\\authorized_keys
      manually — note: for *admin* users, Windows OpenSSH reads from
      C:\\ProgramData\\ssh\\administrators_authorized_keys instead of the
      per-user file. Trips up everyone on first setup.)
  4. Re-run this probe:
        bash scripts/verify_windows_bundle.sh --dry-run

This script DOES NOT proceed without working key auth. Password prompts
fail BatchMode, which is intentional — silent password fallback is what
lets a "verified" claim ship that was never actually verified.

EOF
    exit 2
fi

log "SSH OK — remote reports: $(grep -v '^OK' <<<"$SSH_PROBE_OUT" | head -1)"

if [[ "$DRY_RUN" -eq 1 ]]; then
    log "Dry run complete. ${REMOTE_HOST} reachable with key auth."
    exit 0
fi

# ---------------------------------------------------------------------------
# Phase 2 — bundle pre-flight
# ---------------------------------------------------------------------------
[[ -r "$BUNDLE" ]] || die "bundle not found or unreadable: $BUNDLE" 3

BUNDLE_NAME="$(basename "$BUNDLE")"
BUNDLE_EXT="${BUNDLE_NAME##*.}"
case "$BUNDLE_EXT" in
    msi|exe) ;;
    *) die "unsupported bundle extension '${BUNDLE_EXT}' — expected .msi or .exe" 3 ;;
esac

log "Bundle: ${BUNDLE_NAME} ($(stat -c %s "$BUNDLE") bytes)"

mkdir -p "$ARTIFACT_DIR"

# ---------------------------------------------------------------------------
# Phase 3 — copy bundle to remote
# ---------------------------------------------------------------------------
log "Creating remote temp dir..."
ssh -o BatchMode=yes "$REMOTE_HOST" \
    "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path '${REMOTE_TMP}' | Out-Null\"" \
    >/dev/null

REMOTE_BUNDLE="${REMOTE_TMP}\\${BUNDLE_NAME}"
log "Copying bundle to ${REMOTE_HOST}:${REMOTE_BUNDLE}"
scp -o BatchMode=yes "$BUNDLE" "${REMOTE_HOST}:${REMOTE_BUNDLE//\\//}"

# ---------------------------------------------------------------------------
# Phase 4 — install
# ---------------------------------------------------------------------------
log "Installing on ${REMOTE_HOST} (silent)..."
case "$BUNDLE_EXT" in
    msi)
        # /qn = no UI, /norestart = don't reboot, /l*v = verbose log
        INSTALL_CMD=$(cat <<PS
\$log = '${REMOTE_TMP}\\install-${TIMESTAMP}.log'
\$proc = Start-Process -FilePath msiexec.exe -ArgumentList '/i','${REMOTE_BUNDLE}','/qn','/norestart','/l*v',\"\$log\" -Wait -PassThru
Write-Output \"installer-exit-code: \$(\$proc.ExitCode)\"
if (\$proc.ExitCode -ne 0) { Get-Content \$log -Tail 40 | Write-Output; exit 1 }
PS
)
        ;;
    exe)
        # NSIS Tauri default: /S = silent, currentUser-mode installs land
        # under %LOCALAPPDATA%\Programs\Concord\
        INSTALL_CMD=$(cat <<PS
\$proc = Start-Process -FilePath '${REMOTE_BUNDLE}' -ArgumentList '/S' -Wait -PassThru
Write-Output \"installer-exit-code: \$(\$proc.ExitCode)\"
if (\$proc.ExitCode -ne 0) { exit 1 }
PS
)
        ;;
esac

if ! ssh -o BatchMode=yes "$REMOTE_HOST" "powershell -NoProfile -Command \"$INSTALL_CMD\""; then
    die "install failed on ${REMOTE_HOST}" 4
fi

# ---------------------------------------------------------------------------
# Phase 5 — locate Concord.exe
# ---------------------------------------------------------------------------
log "Locating Concord.exe on remote..."
LOCATE_CMD=$(cat <<'PS'
$candidates = @(
    "$env:ProgramFiles\Concord\Concord.exe",
    "$env:ProgramFiles(x86)\Concord\Concord.exe",
    "$env:LOCALAPPDATA\Programs\Concord\Concord.exe"
)
$found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $found) {
    Write-Error "Concord.exe not found in any expected location"
    exit 1
}
Write-Output $found
PS
)
CONCORD_EXE="$(ssh -o BatchMode=yes "$REMOTE_HOST" "powershell -NoProfile -Command \"$LOCATE_CMD\"")"
[[ -n "$CONCORD_EXE" ]] || die "Concord.exe was not located after install" 4
log "Found Concord.exe at: $CONCORD_EXE"

# ---------------------------------------------------------------------------
# Phase 6 — launch + screenshot
# ---------------------------------------------------------------------------
SCREEN_PATH="${REMOTE_TMP}\\launch-${TIMESTAMP}.png"
LAUNCH_CMD=$(cat <<PS
Start-Process -FilePath '${CONCORD_EXE}'
Start-Sleep -Seconds 8
\$proc = Get-Process -Name 'Concord' -ErrorAction SilentlyContinue
if (-not \$proc) { Write-Error 'Concord.exe is not running 8s after launch'; exit 1 }
Write-Output \"concord-pid: \$(\$proc.Id)\"

Add-Type -AssemblyName System.Drawing,System.Windows.Forms
\$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
\$bmp = New-Object System.Drawing.Bitmap \$bounds.Width, \$bounds.Height
\$gfx = [System.Drawing.Graphics]::FromImage(\$bmp)
\$gfx.CopyFromScreen(\$bounds.Location, [System.Drawing.Point]::Empty, \$bounds.Size)
\$bmp.Save('${SCREEN_PATH}', [System.Drawing.Imaging.ImageFormat]::Png)
\$gfx.Dispose()
\$bmp.Dispose()
Write-Output \"screenshot: ${SCREEN_PATH}\"
PS
)
if ! ssh -o BatchMode=yes "$REMOTE_HOST" "powershell -NoProfile -Command \"$LAUNCH_CMD\""; then
    die "launch / screenshot failed" 5
fi

LOCAL_SCREEN="${ARTIFACT_DIR}/win11-launch-${TIMESTAMP}.png"
log "Pulling screenshot to ${LOCAL_SCREEN}"
scp -o BatchMode=yes "${REMOTE_HOST}:${SCREEN_PATH//\\//}" "$LOCAL_SCREEN" || die "screenshot pull failed" 6

[[ -s "$LOCAL_SCREEN" ]] || die "pulled screenshot is empty" 6

# ---------------------------------------------------------------------------
# Phase 7 — teardown (unless --no-uninstall)
# ---------------------------------------------------------------------------
if [[ "$NO_UNINSTALL" -eq 0 ]]; then
    log "Tearing down (kill Concord.exe, uninstall)..."
    TEARDOWN_CMD=$(cat <<'PS'
Get-Process -Name 'Concord' -ErrorAction SilentlyContinue | Stop-Process -Force
$uninst = Get-WmiObject -Class Win32_Product -Filter "Name LIKE 'Concord%'" -ErrorAction SilentlyContinue
if ($uninst) { $uninst.Uninstall() | Out-Null; Write-Output 'msi-uninstalled' }
$nsisUninst = "$env:LOCALAPPDATA\Programs\Concord\uninstall.exe"
if (Test-Path $nsisUninst) {
    Start-Process -FilePath $nsisUninst -ArgumentList '/S' -Wait
    Write-Output 'nsis-uninstalled'
}
PS
)
    ssh -o BatchMode=yes "$REMOTE_HOST" "powershell -NoProfile -Command \"$TEARDOWN_CMD\"" || \
        warn "teardown reported non-zero — manual cleanup may be needed on ${REMOTE_HOST}"
fi

log "VERIFIED on ${REMOTE_HOST}: ${BUNDLE_NAME} installed, launched, screenshot at ${LOCAL_SCREEN}"
exit 0
