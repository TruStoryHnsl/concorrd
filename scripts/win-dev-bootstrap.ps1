# Concord Windows Dev Bootstrap
# Run in PowerShell as Administrator after VirtIO drivers are installed
# Usage: iex (Get-Content .\win-dev-bootstrap.ps1 -Raw)

$ErrorActionPreference = "Stop"

Write-Host "=== Concord Windows Dev Bootstrap ===" -ForegroundColor Cyan

# 1. Install winget packages (Git, Rust, Node.js)
Write-Host "`n[1/5] Installing Git..." -ForegroundColor Yellow
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements

Write-Host "`n[2/5] Installing Rust (rustup)..." -ForegroundColor Yellow
winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements

Write-Host "`n[3/5] Installing Node.js LTS..." -ForegroundColor Yellow
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements

# Refresh PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "`n[4/5] Installing Rust stable toolchain..." -ForegroundColor Yellow
& "$env:USERPROFILE\.cargo\bin\rustup.exe" default stable

# 5. Clone Concord
Write-Host "`n[5/5] Cloning Concord..." -ForegroundColor Yellow
$concordPath = "$env:USERPROFILE\concord"
if (Test-Path $concordPath) {
    Write-Host "  Concord already cloned at $concordPath — pulling latest" -ForegroundColor Gray
    git -C $concordPath pull
} else {
    git clone https://github.com/TruStoryHnsl/concord.git $concordPath
}

Write-Host "`n=== Bootstrap complete ===" -ForegroundColor Green
Write-Host "Concord cloned to: $concordPath"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open a NEW terminal (to pick up PATH changes)"
Write-Host "  2. cd $concordPath"
Write-Host "  3. npm install"
Write-Host "  4. cd src-tauri && cargo tauri build"
Write-Host ""
Write-Host "NOTE: First Rust build will take a while (downloads + compiles dependencies)"
