; Concord NSIS installer hooks.
;
; Tauri's `bundle.windows.nsis.installerHooks` points at this file. Tauri
; defines specific named macros that get expanded at fixed points in the
; template; we only override the ones that solve Issue 1 of the P0 sprint
; (installer broken on reinstall / uninstall fails).
;
; The Tauri NSIS template injects calls to these macros in this order during
; install:
;   1. NSIS_HOOK_PREINSTALL
;   2. <files written to install dir>
;   3. NSIS_HOOK_POSTINSTALL
;
; And during uninstall:
;   1. NSIS_HOOK_PREUNINSTALL
;   2. <files removed from install dir>
;   3. NSIS_HOOK_POSTUNINSTALL
;
; Reference: https://v2.tauri.app/distribute/windows-installer/#installer-hooks

!macro NSIS_HOOK_PREINSTALL
  ; Before extracting the new payload, clear the existing install dir.
  ; Without this, NSIS-over-NSIS upgrades from an older Concord version
  ; that registered different filenames leave stale files behind, which
  ; is what causes the "Concord already installed / uninstall fails"
  ; trap from the field (P0 sprint, Issue 1, May 2026).
  ;
  ; $INSTDIR is the resolved per-user install location
  ; (%LOCALAPPDATA%\Programs\Concord by default for `installMode currentUser`).
  ; We only RMDir contents — never the directory itself — so any
  ; user-dropped files (rare) aren't surprisingly deleted from outside
  ; this folder.
  ;
  ; If the user is running Concord, this RMDir will leave concord.exe
  ; locked. The Tauri installer template already shows a "close running
  ; instance" prompt before invoking us, so the lock window is small;
  ; if files remain locked we continue anyway and let the post-extract
  ; step overwrite whatever it can. This is enough to recover from the
  ; current broken state — the next clean install will fully repair.
  IfFileExists "$INSTDIR\concord.exe" 0 +3
    SetOutPath "$TEMP"
    RMDir /r "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Purge per-user state when the user uninstalls. The embedded tuwunel
  ; database, settings store, logs, and webkit cache all live under
  ; %APPDATA%\com.concord.chat\ — without this purge an uninstall +
  ; fresh install of a newer version inherits half-state (stale auth
  ; tokens, mismatched DB schema), which is the second half of Issue 1.
  ;
  ; Note: we DO NOT touch %APPDATA%\concord\tuwunel — that's the
  ; embedded homeserver database. A future "Uninstall AND wipe chat
  ; history" checkbox can extend this; for now an uninstall preserves
  ; chat data so a reinstall picks up where the user left off (matches
  ; the documented behavior in README.md > Windows installer).
  RMDir /r "$APPDATA\com.concord.chat"
  RMDir /r "$LOCALAPPDATA\com.concord.chat"

  ; Clean the legacy `Concord` app-data folder name (some pre-1.0 builds
  ; wrote to %APPDATA%\Concord instead of the bundle identifier path).
  RMDir /r "$APPDATA\Concord"
!macroend
