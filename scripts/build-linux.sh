#!/usr/bin/env bash
# Build Concord desktop app for Linux (AppImage, deb, rpm)
# Run this on a Linux machine with Rust, Node.js, and WebKitGTK installed.
#
# Prerequisites (Arch/CachyOS):
#   sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg patchelf
#
# Prerequisites (Ubuntu/Debian):
#   sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev \
#                    librsvg2-dev patchelf
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building client..."
cd client
npm ci
npm run build
cd ..

echo "==> Building Tauri app for Linux..."
cargo tauri build 2>&1

echo "==> Build artifacts:"
ls -lh src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null || true
ls -lh src-tauri/target/release/bundle/deb/*.deb 2>/dev/null || true
ls -lh src-tauri/target/release/bundle/rpm/*.rpm 2>/dev/null || true

echo "==> Done."
