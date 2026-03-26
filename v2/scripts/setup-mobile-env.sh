#!/bin/sh
# Concord Mobile Development Environment Setup
# Source this script or add these exports to your shell profile.
#
# Usage:
#   source ./scripts/setup-mobile-env.sh
#   OR add the exports below to ~/.zprofile / ~/.config/fish/config.fish

# Android SDK
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# Java (use system default)
export JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null)"

# Rust / Cargo
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

echo "Mobile dev environment loaded."
echo "  ANDROID_HOME=$ANDROID_HOME"
echo "  NDK_HOME=$NDK_HOME"
echo "  JAVA_HOME=$JAVA_HOME"
echo "  Rust: $(rustc --version 2>/dev/null || echo 'not found')"
echo "  Tauri: $(cargo tauri --version 2>/dev/null || echo 'not found')"
