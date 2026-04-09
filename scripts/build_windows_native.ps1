# build_windows_native.ps1 — Build Concord as a native Windows .msi via Tauri v2.
#
# Designed to run on a Windows host (or orrion's Windows partition if dual-booted).
# Produces a signed-ready .msi installer in
# src-tauri\target\release\bundle\msi\.
#
# Prerequisites:
#   - Visual Studio 2022 Build Tools (with "Desktop development with C++")
#   - WiX Toolset 3.x (https://wixtoolset.org/releases/) on PATH
#   - Rust (https://rustup.rs) with x86_64-pc-windows-msvc target
#   - Tauri CLI: cargo install tauri-cli --version '^2.0' --locked
#   - Node 18+ and npm
#
# Optional environment variables:
#   $env:SIGNING_CERT_THUMBPRINT — SHA1 thumbprint of a code-signing certificate
#                                  in CurrentUser\My. If set, signtool will sign
#                                  the produced .msi automatically.
#   $env:RELEASE_DIR             — Where to copy final artifacts. Defaults to
#                                  ${repo_root}\dist\windows-x64
#
# Usage:
#   .\scripts\build_windows_native.ps1
#
# Exit codes:
#   0  build succeeded
#   1  missing prerequisite
#   2  build failed
#   3  signing failed

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Resolve-Path (Join-Path $ScriptDir "..")
$SrcTauri    = Join-Path $RepoRoot "src-tauri"
$ClientDir   = Join-Path $RepoRoot "client"
$ReleaseDir  = if ($env:RELEASE_DIR) { $env:RELEASE_DIR } else { Join-Path $RepoRoot "dist\windows-x64" }

function Write-Log    { param($msg) Write-Host "[build_windows] $msg" -ForegroundColor Cyan }
function Write-Warn   { param($msg) Write-Host "[build_windows] $msg" -ForegroundColor Yellow }
function Write-ErrLog { param($msg) Write-Host "[build_windows ERROR] $msg" -ForegroundColor Red }
function Die          { param($msg, $code = 1) Write-ErrLog $msg; exit $code }

function Require-Tool {
    param($Tool, $Hint)
    if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) {
        Die "missing required tool '$Tool'. $Hint" 1
    }
}

# ----------------------------------------------------------------------------
# Prerequisite checks
# ----------------------------------------------------------------------------
Write-Log "Checking prerequisites..."
Require-Tool "cargo" "Install Rust from https://rustup.rs/"
Require-Tool "node"  "Install Node 18+ from https://nodejs.org/"
Require-Tool "npm"   "Comes with Node"

try {
    $null = & cargo tauri --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "tauri-cli not found" }
} catch {
    Die "tauri-cli is not installed. Run: cargo install tauri-cli --version '^2.0' --locked" 1
}

# WiX is needed for .msi bundling.
if (-not (Get-Command "candle.exe" -ErrorAction SilentlyContinue)) {
    Write-Warn "WiX (candle.exe) not found on PATH. Tauri will fetch it on first run, but the build may stall."
}

Write-Log "cargo:     $(& cargo --version)"
Write-Log "rustc:     $(& rustc --version)"
Write-Log "tauri-cli: $(& cargo tauri --version)"
Write-Log "node:      $(& node --version)"

# ----------------------------------------------------------------------------
# Build the React client
# ----------------------------------------------------------------------------
Write-Log "Building React client ($ClientDir)..."
Push-Location $ClientDir
try {
    if (-not (Test-Path "node_modules")) {
        & npm ci
        if ($LASTEXITCODE -ne 0) { Die "npm ci failed" 2 }
    }
    & npm run build
    if ($LASTEXITCODE -ne 0) { Die "client build failed" 2 }
} finally {
    Pop-Location
}

# ----------------------------------------------------------------------------
# Build the Tauri shell
# ----------------------------------------------------------------------------
Write-Log "Running cargo tauri build --bundles msi..."
Push-Location $SrcTauri
try {
    & cargo tauri build --bundles msi
    if ($LASTEXITCODE -ne 0) { Die "cargo tauri build failed" 2 }
} finally {
    Pop-Location
}

# ----------------------------------------------------------------------------
# Locate artifacts
# ----------------------------------------------------------------------------
$BundleDir = Join-Path $SrcTauri "target\release\bundle"
$Msi = Get-ChildItem -Path (Join-Path $BundleDir "msi") -Filter "*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -eq $Msi) {
    Die "no .msi produced under $BundleDir\msi" 2
}

Write-Log "Build artifacts:"
Write-Log "  MSI: $($Msi.FullName)"

# ----------------------------------------------------------------------------
# Optional code signing
# ----------------------------------------------------------------------------
if ($env:SIGNING_CERT_THUMBPRINT) {
    Write-Log "Signing MSI with cert thumbprint $($env:SIGNING_CERT_THUMBPRINT)"
    $signtool = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
    if ($null -eq $signtool) {
        Die "signtool.exe not found on PATH. Install Windows SDK." 3
    }
    & signtool sign `
        /sha1 $env:SIGNING_CERT_THUMBPRINT `
        /tr http://timestamp.digicert.com `
        /td sha256 `
        /fd sha256 `
        $Msi.FullName
    if ($LASTEXITCODE -ne 0) { Die "signtool failed" 3 }
} else {
    Write-Warn "SIGNING_CERT_THUMBPRINT not set — MSI will be unsigned (Windows SmartScreen will warn users)."
}

# ----------------------------------------------------------------------------
# Aggregate into release directory
# ----------------------------------------------------------------------------
if (-not (Test-Path $ReleaseDir)) {
    New-Item -ItemType Directory -Path $ReleaseDir | Out-Null
}
Write-Log "Copying artifacts to $ReleaseDir"
Copy-Item -Path $Msi.FullName -Destination $ReleaseDir -Force

Write-Log "Done. Artifact ready in $ReleaseDir"
