#!/usr/bin/env bash
# Concord — macOS uninstall helper.
#
# Bundled into the .app at /Applications/Concord.app/Contents/Resources/uninstall.sh
# (see tauri.conf.json > bundle.resources). The user invokes it from
# Terminal:
#
#   /Applications/Concord.app/Contents/Resources/uninstall.sh
#
# It removes:
#   - The .app bundle itself (drag-to-trash equivalent, but does the move).
#   - Per-user data: Application Support, Caches, Preferences, Logs.
#   - The embedded tuwunel chat database.
#
# Drag-to-trash alone does NOT remove the per-user state under
# ~/Library/{Application Support, Caches, Logs, Preferences}, which is what
# leaves "half-uninstalled" Concord installs that the P0 sprint Issue 1
# called out. This script closes that gap.
#
# Idempotent: safe to run a second time; missing paths are silently skipped.
# Returns 0 on success, non-zero if /Applications/Concord.app is in use and
# cannot be removed (user must quit Concord first).

set -euo pipefail

readonly BUNDLE_ID="com.concord.chat"
readonly APP_PATH="/Applications/Concord.app"
readonly HOME_LIB="$HOME/Library"

# Things to remove. Edit with care — every entry should be Concord-specific.
# Globbed paths use `~/Library/<dir>/<exact prefix>` so we never delete
# adjacent apps' state.
PATHS_TO_REMOVE=(
  "$HOME_LIB/Application Support/Concord"
  "$HOME_LIB/Application Support/$BUNDLE_ID"
  "$HOME_LIB/Application Support/com.concord.chat.WebKit"
  "$HOME_LIB/Caches/$BUNDLE_ID"
  "$HOME_LIB/Caches/Concord"
  "$HOME_LIB/Logs/Concord"
  "$HOME_LIB/Logs/$BUNDLE_ID"
  "$HOME_LIB/Preferences/$BUNDLE_ID.plist"
  "$HOME_LIB/WebKit/$BUNDLE_ID"
  "$HOME_LIB/Saved Application State/$BUNDLE_ID.savedState"
  "$HOME_LIB/HTTPStorages/$BUNDLE_ID"
  "$HOME_LIB/HTTPStorages/$BUNDLE_ID.binarycookies"
  "$HOME_LIB/Cookies/$BUNDLE_ID.binarycookies"
)

say() { printf '[concord uninstall] %s\n' "$*"; }

# 1. Quit any running instance. `osascript` is best-effort — if Concord
#    isn't running, this is a no-op.
say "Asking Concord to quit if running..."
osascript -e 'tell application "Concord" to quit' >/dev/null 2>&1 || true
sleep 1

# 2. Remove the .app bundle. `rm -rf` requires write permission on
#    /Applications which the user already has for any drag-installed app.
if [[ -d "$APP_PATH" ]]; then
  say "Removing $APP_PATH"
  rm -rf "$APP_PATH" || {
    say "ERROR: could not remove $APP_PATH (is Concord still running?)" >&2
    exit 1
  }
fi

# 3. Remove per-user state.
for p in "${PATHS_TO_REMOVE[@]}"; do
  if [[ -e "$p" ]]; then
    say "Removing $p"
    rm -rf "$p" || say "WARN: failed to remove $p (continuing)"
  fi
done

# 4. Reset launch services / cf-prefs cache so a fresh install starts clean.
say "Resetting cached app launch metadata..."
defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
  -kill -r -domain local -domain system -domain user >/dev/null 2>&1 || true

say "Concord uninstalled."
say "Note: chat database under ~/Library/Application Support was removed."
exit 0
