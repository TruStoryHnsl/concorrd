# Concord on Windows — Runtime Paths and Lifecycle

This doc maps every place Concord touches the Windows filesystem at
runtime, why each path was chosen, and what the user-facing
implications are (uninstall behaviour, data preservation, support
mode, etc.).

It exists because Windows is the platform where path mistakes show
up most violently — Linux apps that hard-code `~/.local/share` work
on macOS too, but on Windows the same code path silently fails to
resolve `HOME` and the embedded server (servitude) never starts.

---

## Path table

| Concern                             | Windows path                                                        | Resolved by                          |
|-------------------------------------|---------------------------------------------------------------------|--------------------------------------|
| Tauri plugin-store                  | `%APPDATA%\com.concord.chat\`                                       | `tauri-plugin-store`                 |
| `serverConfig` (INS-027)            | `%APPDATA%\com.concord.chat\` + `localStorage` mirror in webview    | Zustand persist (writes both stores) |
| `stronghold` keystore               | `%APPDATA%\com.concord.chat\stronghold\`                            | `tauri-plugin-stronghold`            |
| Embedded **tuwunel** data + RocksDB | `%APPDATA%\concord\tuwunel\`                                        | `MatrixFederationTransport::resolve_data_dir()` |
| Reticulum (mesh, when enabled)      | `%APPDATA%\concord\reticulum\`                                      | `ReticulumTransport`                 |
| Cached webview assets               | `%LOCALAPPDATA%\com.concord.chat\EBWebView\` (Edge WebView2 cache)  | Microsoft Edge WebView2 runtime      |
| Crash dumps                         | `%LOCALAPPDATA%\com.concord.chat\EBWebView\Crashpad\`               | WebView2                             |
| Install root (MSI default)          | `%PROGRAMFILES%\Concord\`                                           | Tauri MSI bundler / WiX              |
| Install root (NSIS currentUser)     | `%LOCALAPPDATA%\Programs\Concord\`                                  | Tauri NSIS bundler                   |
| Per-user uninstaller (NSIS)         | `%LOCALAPPDATA%\Programs\Concord\uninstall.exe`                     | NSIS                                 |

`%APPDATA%` is the Roaming folder (`C:\Users\<u>\AppData\Roaming`),
`%LOCALAPPDATA%` is non-roaming (`C:\Users\<u>\AppData\Local`).
Roaming data follows the user across machines on a domain-joined
network; Local data is per-machine.

---

## Why `concord\tuwunel` is its own root, NOT under `com.concord.chat\`

The Tauri-side data (plugin-store, stronghold, webview cache) all
live under `%APPDATA%\com.concord.chat\` because that's the
identifier in `tauri.conf.json` (`"identifier": "com.concord.chat"`)
and Tauri's plugins derive their path from it.

The embedded tuwunel intentionally sits in `%APPDATA%\concord\`
INSTEAD. Two reasons:

1. **MSI uninstall preserves user data.** The default Tauri MSI
   uninstall logic clears `%APPDATA%\com.concord.chat\`; if tuwunel
   data lived there, every uninstall would wipe the user's chat
   database, encryption keys, and joined-room state. Putting
   tuwunel under `%APPDATA%\concord\` means MSI uninstall leaves
   it intact. Reinstalling Concord (e.g. across a major version)
   resumes the same conversations.

2. **Cross-flavor compatibility.** When the standalone
   `servitude` binary eventually ships (currently embedded-only —
   see audit memory `project_servitude_embedded.md`), it will
   have a different identifier and its own state directory. Both
   the standalone and the embedded should land in the same
   `%APPDATA%\concord\` root so users running both can share
   tuwunel data.

If you ever need to fully reset a Windows user's Concord state for
debugging, the right invocation is:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\com.concord.chat" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:APPDATA\concord"           -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.concord.chat" -ErrorAction SilentlyContinue
```

---

## Lifecycle: shutdown semantics on Windows

There is no `SIGTERM` on Windows. `std::process::Child::kill` and
`tokio::process::Child::kill` map to `TerminateProcess`, the moral
equivalent of SIGKILL — the child gets no chance to flush state.

`MatrixFederationTransport::stop()` knows this:

- On Unix, Phase 1 sends `SIGTERM` and waits up to 10 s for tuwunel
  to flush RocksDB cleanly. Phase 2 escalates to `start_kill` if
  Phase 1 timed out.
- On Windows (anywhere `cfg(not(unix))`), `send_sigterm` returns
  `Err` immediately so the stop logic SKIPS the 10-second graceful
  wait and goes straight to Phase 2. This shaves the worst-case
  uninstall and app-exit times by 10 seconds.

### RocksDB consequence

Hard-killing tuwunel mid-write can leave the WAL needing recovery
on next boot. RocksDB's atomic-rename + WAL replay makes this
*survivable* (no lost data), but recovery adds startup latency
(typically <1 s, occasionally up to ~5 s on a busy DB). This is
acceptable given the alternative is a user-perceived 10-second
hang on every "X" click in the title bar.

### Future: graceful shutdown on Windows

The proper fix is to add a Windows-specific stop that posts
`WM_CLOSE` to tuwunel's main window — but tuwunel is a console
binary, so no main window exists. The next-best mechanism is
`SetConsoleCtrlHandler` + `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)`,
which tuwunel's signal handler does respect on Windows. This is
filed as a future improvement; the current `cfg(not(unix))`
no-graceful path is documented and intentional.

---

## Verification status (2026-04-27)

- `cargo build --release` on host (Linux): PASS, no
  cfg-gated compile errors. The Windows branch in
  `resolve_data_dir` is dead code on Linux (compiled out via
  `#[cfg(target_os = "windows")]`) so any syntax/type error
  there will only surface when the Windows CI build (W-03) runs.
- `cargo test` on host: 45 passed, 0 failed. The
  `test_resolve_data_dir_prefers_xdg_data_home` test still
  passes — XDG_DATA_HOME wins on every platform that sets it.
- Real Windows runtime verification: NOT YET RUN. Once the W-03
  CI workflow produces an artifact and W-01's verify script
  installs it on `corr@win11.local`, the empirical proof will be
  the screenshot showing the app booted (which only happens if
  `resolve_data_dir` returned a usable path).
