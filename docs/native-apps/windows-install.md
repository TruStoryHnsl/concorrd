# Concord on Windows — Install & Build Guide

This doc covers three audiences:

1. **End users** — install the prebuilt MSI from CI, click through SmartScreen, expect the Server Picker.
2. **Developers** — build Concord locally on a Windows host.
3. **Operators triaging issues** — where Concord puts its data, how to reset state, how to verify a build.

For the deep-dive on per-platform paths and shutdown semantics, see
[`windows-paths.md`](windows-paths.md).

---

## Audience 1 — Install the prebuilt MSI

### Step 1. Download

Concord has no signed releases yet. Builds come from the
[`Windows build`](../../.github/workflows/windows-build.yml) GitHub
Actions workflow.

1. Open the workflow's run history on GitHub Actions.
2. Click the most recent successful run on `main`.
3. Scroll to the **Artifacts** section.
4. Download `concord-windows-msi` (recommended) or
   `concord-windows-nsis` (per-user install, no admin rights needed).
5. Unzip the artifact.

### Step 2. SmartScreen warning

On the first time you run an unsigned installer, Windows shows:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognized app from
> starting. Running this app might put your PC at risk.

Click **More info**, then **Run anyway**.

This warning fires because Concord is not yet code-signed. We're aware
this is friction; signing is tracked as a separate work item and does
not block the open-source distribution. Once a code-signing cert is
provisioned, every CI artifact will be signed automatically and the
SmartScreen warning will stop appearing on fresh downloads.

### Step 3. Install + first launch

- **MSI** installs to `C:\Program Files\Concord\`. Requires admin
  consent (UAC prompt). Install is silent-installable for IT
  deployments via `msiexec /i Concord_*.msi /qn`.
- **NSIS** (`-setup.exe`) installs per-user to
  `%LOCALAPPDATA%\Programs\Concord\` and does NOT need admin rights.
  Silent-install via `Concord_*-setup.exe /S`.

First launch:

- The Server Picker screen renders — Join an existing server / Host
  your own. The installer does NOT pre-configure a server. Concord is
  a generic client that talks to any Concord or Matrix homeserver.
- For the public reference instance, enter `concordchat.net`.
- For self-hosted, enter the homeserver hostname you set up
  (whatever `CONDUWUIT_SERVER_NAME` is in that instance's `.env`).

If you see the chat shell instead of the Server Picker on a fresh
install, file a bug — the install accidentally inherited state from
a previous run (see "Reset state" below).

### Step 4. Uninstall

- **MSI**: Settings → Apps → Installed apps → Concord → Uninstall.
  Removes Program Files\Concord and `%APPDATA%\com.concord.chat\`,
  but PRESERVES `%APPDATA%\concord\tuwunel\` (the embedded chat
  database) so a reinstall resumes existing conversations.
- **NSIS**: run `%LOCALAPPDATA%\Programs\Concord\uninstall.exe` or
  use Settings → Apps. Same preservation behavior.

To wipe absolutely everything:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\com.concord.chat" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:APPDATA\concord" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.concord.chat" -ErrorAction SilentlyContinue
```

---

## Audience 2 — Build Concord locally on a Windows host

### Prereqs

Run `scripts/win-dev-bootstrap.ps1` in **PowerShell as Administrator**:

```powershell
git clone https://github.com/TruStoryHnsl/concord.git
cd concord
.\scripts\win-dev-bootstrap.ps1
```

The bootstrap installs:

- **Git** (`Git.Git`)
- **Visual Studio 2022 Build Tools** with the C++ workload + Windows
  11 SDK — this is non-optional, Rust on Windows MSVC cannot link
  without it.
- **Rust** (`rustup`) + stable toolchain + `x86_64-pc-windows-msvc`
  target.
- **Node.js LTS**.
- **Tauri CLI** (`cargo install tauri-cli ^2.0 --locked`).
- **WiX Toolset 3.x** (for MSI bundling — Tauri's bundler will fetch
  it on demand if missing, but pre-installing avoids a stall).

The bootstrap is idempotent — re-running it on a partially-set-up box
skips already-installed components.

### Build

After bootstrap, in a fresh PowerShell window (so PATH picks up the
new tools):

```powershell
cd $env:USERPROFILE\concord
.\scripts\build_windows_native.ps1
```

This:

1. Builds the React client (`npm ci && npm run build`).
2. Runs `cargo tauri build --bundles msi` (add `--bundles nsis` for
   per-user installer instead).
3. Optionally signs the MSI if `$env:SIGNING_CERT_THUMBPRINT` is set.
4. Copies the result to `dist\windows-x64\`.

First build takes ~25 min (Rust compiles ~700 crates from scratch).
Subsequent builds with a warm `target\` are 1–3 min.

### Cross-compile from Linux — currently NOT working

`scripts/build_windows_wsl.sh` was designed to cross-compile via
`cargo-xwin`. It is currently blocked by `libsodium-sys-stable`,
which the `tauri-plugin-stronghold → iota_stronghold → stronghold-runtime`
dependency tree pulls in. libsodium's autoconf-generated C source
references `pid_t` / `getpid()` unconditionally; clang-cl in MSVC
mode does not see those POSIX symbols, and the build hard-fails
inside libsodium's randombytes module.

The script detects this failure pattern and exits with code 3 +
a clear diagnostic pointing at the supported alternatives (CI or
native Windows).

If you only need a fast Rust-side iteration loop and don't need a
full installer, the cross-compile path produces a raw `concord.exe`
that can be useful for sanity checks — but the bundler step
(`cargo tauri build`) is Windows-only because of WiX.

### Verify a built installer

After CI or a local build produces an MSI/NSIS, validate it
statically (no install required):

```bash
bash scripts/verify_windows_artifact.sh path/to/Concord_0.1.0_x64.msi
```

Asserts: file size in [1 MB, 200 MB], PE32+ / CFB magic, NSIS marker
for `.exe`, embedded `tuwunel` resource string, MSI ProductName ==
"Concord" (when `msitools` is installed), prints SHA-256.

For the empirical "does it actually launch on Windows" check, see
the next section.

---

## Audience 3 — Triaging on a real Windows test rig

The verification harness is `scripts/verify_windows_bundle.sh`. Set
`WIN_TEST_HOST` (or pass it as the first argument to the script) to the
SSH alias of your Windows test rig. Once the machine is reachable and
key auth is in place:

```bash
# Probe reachability
bash scripts/verify_windows_bundle.sh --dry-run

# Full install + smoke launch + screenshot
bash scripts/verify_windows_bundle.sh \
    src-tauri/target/release/bundle/msi/Concord_0.1.0_x64_en-US.msi
```

The screenshot lands in `./artifacts/windows-launch-<utcts>.png`. The
expected first-launch screen is the Server Picker — anything else
(blank webview, chat shell, error dialog) is a bug.

---

## Known gaps / caveats

| Gap | Impact | Tracking |
|-----|--------|----------|
| No code-signing cert | Every download triggers SmartScreen on first run | Out-of-band |
| Cross-compile from Linux blocked | Devs without a Windows host depend on CI for installers | `libsodium-sys-stable` upstream |
| Server Picker is a modal gate, not a hollow shell | Spec says first launch should be the full empty UI with a `+` tile in Sources | INS-058 (`instructions_inbox.md`) |
| No graceful tuwunel shutdown on Windows | App-quit and uninstall do a hard kill (TerminateProcess); RocksDB recovers on next boot | `windows-paths.md` lifecycle section |
| WebView2 must be present | Tauri v2 webview depends on Microsoft Edge WebView2 runtime — present on Windows 11 by default, missing on stripped Windows 10 LTSC images | Tauri-level concern |
