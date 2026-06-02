# Concord Windows Dev Bootstrap
# Run in PowerShell as Administrator.
# Usage: iex (Get-Content .\win-dev-bootstrap.ps1 -Raw)
#
# Installs everything needed to build Concord natively on Windows:
#   - Git
#   - Visual Studio 2022 Build Tools (MSVC + Windows SDK + C++ workload)
#   - Rust (rustup) + stable toolchain w/ x86_64-pc-windows-msvc target
#   - Node.js LTS
#   - Tauri CLI (cargo install)
#   - WiX Toolset (winget — needed for MSI bundling; Tauri also fetches
#     it on first build but pre-installing avoids a stall)
#   - Concord repo cloned to %USERPROFILE%\concord
#
# Why Build Tools matters: without `link.exe` from MSVC and the Windows
# SDK headers/libs, `cargo build` cannot link Rust binaries on Windows.
# rustup-init normally prompts for this and refuses to install otherwise;
# this script makes it non-interactive by pre-installing the C++ workload.

$ErrorActionPreference = "Stop"

function Step {
    param([int]$Index, [int]$Total, [string]$Title)
    Write-Host "`n[$Index/$Total] $Title" -ForegroundColor Yellow
}

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

Write-Host "=== Concord Windows Dev Bootstrap ===" -ForegroundColor Cyan

$Total = 8

# ---------------------------------------------------------------------------
# 1. Git
# ---------------------------------------------------------------------------
Step 1 $Total "Installing Git..."
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "  git already on PATH ($((Get-Command git).Source))" -ForegroundColor Gray
} else {
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
}

# ---------------------------------------------------------------------------
# 2. Visual Studio 2022 Build Tools — C++ workload
# ---------------------------------------------------------------------------
# Without the C++ workload (MSVC compiler + Windows 10/11 SDK), Rust on
# Windows-msvc cannot link. rustup will refuse to default to stable
# unless these are present, which is why this MUST happen before
# `rustup default stable`.
Step 2 $Total "Installing Visual Studio 2022 Build Tools (C++ workload)..."
$vsHasMsvc = $false
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsHasMsvc = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
}
if ($vsHasMsvc) {
    Write-Host "  MSVC tools already installed at: $vsHasMsvc" -ForegroundColor Gray
} else {
    # The --override flag passes through to the VS bootstrapper to
    # add only the bare-minimum components for Rust:
    #   - VC.Tools.x86.x64       (MSVC v143 build tools)
    #   - Windows11SDK.22621     (Windows SDK)
    # These two are what `rustc --target x86_64-pc-windows-msvc`
    # actually needs at link time.
    winget install --id Microsoft.VisualStudio.2022.BuildTools `
        -e --accept-source-agreements --accept-package-agreements `
        --override "--quiet --wait --norestart --nocache `
            --add Microsoft.VisualStudio.Workload.VCTools `
            --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
    Refresh-Path
}

# ---------------------------------------------------------------------------
# 3. Rust (rustup)
# ---------------------------------------------------------------------------
Step 3 $Total "Installing Rust (rustup)..."
if (Get-Command rustup -ErrorAction SilentlyContinue) {
    Write-Host "  rustup already on PATH" -ForegroundColor Gray
} else {
    winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
}

# ---------------------------------------------------------------------------
# 4. Node.js LTS
# ---------------------------------------------------------------------------
Step 4 $Total "Installing Node.js LTS..."
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "  node already on PATH ($((Get-Command node).Source))" -ForegroundColor Gray
} else {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
}

# ---------------------------------------------------------------------------
# 5. Rust stable toolchain + x86_64-pc-windows-msvc target
# ---------------------------------------------------------------------------
Step 5 $Total "Installing Rust stable toolchain + msvc target..."
$rustup = "$env:USERPROFILE\.cargo\bin\rustup.exe"
if (-not (Test-Path $rustup)) {
    $rustup = (Get-Command rustup -ErrorAction Stop).Source
}
& $rustup default stable
& $rustup target add x86_64-pc-windows-msvc
Refresh-Path

# ---------------------------------------------------------------------------
# 6. Tauri CLI
# ---------------------------------------------------------------------------
# Pinned to ^2.0 — Concord is on Tauri v2.
Step 6 $Total "Installing Tauri CLI (cargo install tauri-cli ^2.0)..."
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
if (-not (Test-Path $cargo)) {
    $cargo = (Get-Command cargo -ErrorAction Stop).Source
}
$tauriInstalled = $false
try {
    $null = & $cargo tauri --version 2>&1
    if ($LASTEXITCODE -eq 0) { $tauriInstalled = $true }
} catch {}
if ($tauriInstalled) {
    Write-Host "  tauri-cli already installed: $(& $cargo tauri --version)" -ForegroundColor Gray
} else {
    & $cargo install tauri-cli --version "^2.0" --locked
}

# ---------------------------------------------------------------------------
# 7. WiX Toolset (for MSI bundling)
# ---------------------------------------------------------------------------
Step 7 $Total "Installing WiX Toolset 3.x..."
if (Get-Command candle.exe -ErrorAction SilentlyContinue) {
    Write-Host "  WiX (candle.exe) already on PATH" -ForegroundColor Gray
} else {
    # WiXToolset.WiXToolset is the v3 binary distribution that Tauri's
    # MSI bundler expects (Tauri v2 still calls candle/light, not the
    # v4 wix CLI).
    try {
        winget install --id WiXToolset.WiXToolset -e --accept-source-agreements --accept-package-agreements
    } catch {
        Write-Host "  WiX winget install failed — Tauri will fetch it on first build." -ForegroundColor DarkYellow
    }
    Refresh-Path
}

# ---------------------------------------------------------------------------
# 8. Concord repo
# ---------------------------------------------------------------------------
Step 8 $Total "Cloning Concord..."
$concordPath = "$env:USERPROFILE\concord"
if (Test-Path $concordPath) {
    Write-Host "  Concord already cloned at $concordPath — pulling latest" -ForegroundColor Gray
    git -C $concordPath pull --ff-only
} else {
    git clone https://github.com/TruStoryHnsl/concord.git $concordPath
}

Write-Host "`n=== Bootstrap complete ===" -ForegroundColor Green
Write-Host "Concord cloned to: $concordPath"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open a NEW PowerShell (to pick up PATH changes)"
Write-Host "  2. cd $concordPath\client && npm ci && npm run build"
Write-Host "  3. cd $concordPath && .\scripts\build_windows_native.ps1"
Write-Host ""
Write-Host "First build is slow — Rust compiles ~700 crates from scratch."
