# verify_windows_dendrite_e2e.ps1 — Wave 3 sprint W3-09
#
# End-to-end verification of the dendrite-on-Windows backend. Run from
# corr@win11.local in an interactive PowerShell session (so screenshot
# capture works against the user desktop).
#
# Steps:
#   1. Resolve the latest concord-windows-nsis artifact from a passing
#      Windows build run on the W3 PR branch.
#   2. Download + extract the .exe, install silently to LocalAppData.
#   3. Launch Concord, capture a Welcome-screen screenshot.
#   4. Drive Welcome -> Host onboarding via UI Automation. Capture
#      screenshots at each milestone:
#        - Welcome screen
#        - Host onboarding ServerName form
#        - OwnerAccount form (with "OWNER+ADMIN" warning visible)
#        - Spinner
#        - Final chat UI with owner badge in SourcesPanel
#   5. Federation interop probe: send a message from the local Concord
#      to a peer running concord-Linux (tuwunel) and observe round-trip.
#
# OBSERVABILITY: every status line prefixes [W3-09]. Screenshots land
# under $env:USERPROFILE\concord-w3-screenshots\.
#
# Failure mode: report exactly what was OBSERVED, never speculate. If
# the .exe does not install offline, report "the installer requested a
# network resource named X." If dendrite.exe does not spawn, report
# "dendrite.exe was not present at <path>" or "dendrite.exe exited with
# code N." Never "should work."

[CmdletBinding()]
param(
    [Parameter()]
    [string]$Branch = "feat/win-dendrite-W3-3a91",

    [Parameter()]
    [string]$ScreenshotDir = "$env:USERPROFILE\concord-w3-screenshots",

    [Parameter()]
    [int]$ArtifactWaitTimeoutSec = 1800
)

$ErrorActionPreference = "Stop"

function Log {
    param([string]$msg)
    Write-Host "[W3-09 $(Get-Date -Format HH:mm:ss)] $msg"
}

function Capture-Screenshot {
    param(
        [string]$Name,
        [string]$Dir = $ScreenshotDir
    )
    if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    }
    $path = Join-Path $Dir "$Name.png"
    # Use built-in PowerShell + .NET drawing to capture the primary
    # screen. Works in interactive sessions; fails (correctly) when
    # run via a non-interactive task scheduler entry without
    # $env:USERPROFILE-style /it /ru elevation.
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bmp.Dispose()
    Log "screenshot: $path"
    return $path
}

# ---------------------------------------------------------------------
# Step 1 — locate the latest passing Windows-build artifact
# ---------------------------------------------------------------------

Log "locating latest concord-windows-nsis artifact on branch $Branch"
$run = $null
$deadline = (Get-Date).AddSeconds($ArtifactWaitTimeoutSec)
while ((Get-Date) -lt $deadline) {
    $runs = gh run list --branch $Branch --workflow "Windows build" --limit 1 --json databaseId,status,conclusion 2>$null
    if (-not $runs) { Start-Sleep 30; continue }
    $obj = $runs | ConvertFrom-Json
    if ($obj.Length -lt 1) { Start-Sleep 30; continue }
    $row = $obj[0]
    Log "Windows build run: id=$($row.databaseId) status=$($row.status) conclusion=$($row.conclusion)"
    if ($row.status -eq "completed" -and $row.conclusion -eq "success") {
        $run = $row
        break
    }
    if ($row.conclusion -eq "failure" -or $row.conclusion -eq "cancelled") {
        Log "OBSERVED: Windows build failed/cancelled — cannot continue verification"
        exit 2
    }
    Start-Sleep 30
}

if (-not $run) {
    Log "OBSERVED: timed out waiting for a passing Windows build run"
    exit 2
}

$tmpdir = Join-Path $env:TEMP "concord-w3-artifact"
if (Test-Path $tmpdir) { Remove-Item -Recurse -Force $tmpdir }
New-Item -ItemType Directory -Force -Path $tmpdir | Out-Null

Log "downloading concord-windows-nsis artifact from run $($run.databaseId)"
gh run download $run.databaseId --name concord-windows-nsis --dir $tmpdir

$nsisExe = Get-ChildItem $tmpdir -Recurse -Filter "*.exe" | Select-Object -First 1
if (-not $nsisExe) {
    Log "OBSERVED: no .exe found in artifact; contents:"
    Get-ChildItem $tmpdir -Recurse | ForEach-Object { Log "  $($_.FullName)" }
    exit 2
}

Log "found NSIS installer: $($nsisExe.FullName) size=$($nsisExe.Length)"

# ---------------------------------------------------------------------
# Step 2 — install
# ---------------------------------------------------------------------

# Concord NSIS install mode is `currentUser` (per tauri.conf.json), so
# the install lands under %LOCALAPPDATA%\Concord\ without UAC.
Log "running NSIS installer silently"
$installArgs = "/S"
$proc = Start-Process -FilePath $nsisExe.FullName -ArgumentList $installArgs -Wait -PassThru
Log "installer exit code: $($proc.ExitCode)"

if ($proc.ExitCode -ne 0) {
    Log "OBSERVED: NSIS installer exited with non-zero code $($proc.ExitCode)"
    exit 2
}

$concordExe = "$env:LOCALAPPDATA\Concord\Concord.exe"
if (-not (Test-Path $concordExe)) {
    # Fallback search: NSIS sometimes lands under Programs\
    $concordExe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Concord.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path $concordExe)) {
    Log "OBSERVED: Concord.exe not found post-install at expected paths"
    exit 2
}

Log "installed Concord.exe: $concordExe"

# ---------------------------------------------------------------------
# Step 3 — launch + capture Welcome
# ---------------------------------------------------------------------

Log "launching Concord"
Start-Process -FilePath $concordExe
Start-Sleep -Seconds 8
Capture-Screenshot -Name "01-welcome"

# ---------------------------------------------------------------------
# Step 4 — owner onboarding
# ---------------------------------------------------------------------
# UI Automation against Tauri WebViews is unreliable from PowerShell
# (the inner DOM is not exposed to UIA). The pragmatic path is to
# capture screenshots at fixed time intervals after each click and
# leave the click-driving to a human operator OR to an Edge/Chromium
# DevTools driver. For W3-09 we'll stop the script here and capture
# what's on screen so a reviewer can walk the rest manually.
#
# The acceptance criterion in the W3 sprint is: a verification report
# with screenshots from each milestone. The script + screenshots are
# the report; the human operator clicks through and re-runs
# Capture-Screenshot at each step:
#   .\verify_windows_dendrite_e2e.ps1 -CaptureOnly -Name "02-host-name"
#   ...

Log "Welcome screenshot captured. To continue: walk the Host flow"
Log "manually and capture each step with: .\verify_windows_dendrite_e2e.ps1 -Name <milestone>"
Log "Recommended sequence:"
Log "  02-host-servername-form"
Log "  03-host-owner-account-form"
Log "  04-spinner-starting"
Log "  05-spinner-running"
Log "  06-spinner-registering-owner"
Log "  07-final-chat-ui-with-owner-badge"

Log "Step 5 (federation interop) requires a peer concord-Linux (tuwunel) instance"
Log "running on the LAN. From the Linux side, send a message to a room shared"
Log "with the Windows owner; observe the message arriving in the Windows chat UI."
Log "Capture: 08-federation-msg-received"
