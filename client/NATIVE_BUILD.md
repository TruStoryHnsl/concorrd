# Concord Native Build Guide

This document describes how Concord's stable React client is packaged into
native binaries via **Tauri v2** for every supported platform, and how those
builds are split across the workshop's two build hosts.

> **Audience:** developers building Concord locally on orrion or orrpheus,
> or wiring up CI to reproduce these builds. This guide is the source of
> truth for which machine produces which artifact.

---

## 1. Toolchain matrix

| Tool | Required version | Notes |
|------|------------------|-------|
| Rust (stable) | 1.77.2+ | Pinned via `src-tauri/Cargo.toml` `rust-version` |
| Tauri CLI    | 2.x | `cargo install tauri-cli --version '^2.0' --locked` |
| Node.js      | 18+ | Required by the Vite/React client build |
| npm          | 9+  | Bundled with Node 18+ |

The current dev host (`orrion`) confirms `cargo 1.94.0`, `rustc 1.94.0`, and
`tauri-cli 2.10.1` work end-to-end.

## 2. Per-platform system prerequisites

### Linux x86_64 / aarch64

- `webkit2gtk-4.1` (development headers)
- `gtk3` (development headers)
- `libsoup-3.0` (transitive via webkit2gtk-4.1)
- `librsvg`
- `patchelf`

**CachyOS / Arch:**
```bash
sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg patchelf
```

**Debian / Ubuntu (22.04+):**
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev \
                 librsvg2-dev patchelf
```

### macOS Universal (Intel + Apple Silicon)

- Xcode 15+ (or Xcode Command Line Tools for the headless toolchain)
- A valid Apple Developer ID Application certificate in the login keychain
- `rustup target add x86_64-apple-darwin aarch64-apple-darwin`

### iOS ARM64

- Xcode 15+ (full IDE — Tauri's iOS init writes an `.xcodeproj`)
- `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
- Active Apple Developer Program enrollment (in progress as of 2026-04-07)
- **xtool** (open-source Xcode alternative) is being evaluated as a future
  fallback — see project memory `reference_xtool_xcode_alternative.md`

### Android ARM64

- Android Studio + the Android SDK (API 24+)
- Android NDK r25+
- `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- `JAVA_HOME` pointing at JDK 17

### Windows x86_64

- MSVC build tools (Visual Studio 2022 Build Tools or full Visual Studio)
- WiX Toolset 3.x (for `.msi` bundles)
- `rustup target add x86_64-pc-windows-msvc`
- Optional: a code-signing certificate (placeholder until Concord registers
  one)

---

## 3. Machine split

Concord uses a **two-machine workshop**:

| Build host | OS | Builds for | Why |
|------------|----|-----------|-----|
| **orrion** | CachyOS, RTX 3070 | Linux x86_64, Linux aarch64, Windows x86_64, Android ARM64 | Linux-native + cross-targets that don't need Apple toolchains |
| **orrpheus** | macOS 14+, M1 Pro | macOS Universal, iOS ARM64 | Apple toolchains require physical Apple hardware |

Both hosts share `~/projects/concord` via Syncthing. Each host runs only the
build scripts targeted at its platforms; artifacts written to
`src-tauri/target/release/bundle/` are picked up by the release aggregation
step (see §6).

---

## 4. Build scripts and the 5-platform × 2-role matrix

Concord's binaries split into two **roles** per platform:

- **Frontend Client** — the React/Tauri shell that users open. Renders the
  chat UI.
- **Servitude Companion** — the embedded service-node hosting module
  (`src-tauri/src/servitude/`). It is *embedded* — there is no separate
  binary. Both desktop and mobile builds ship the servitude module compiled
  into the Concord binary.

| Platform | Frontend Client (build host & cmd) | Servitude Companion | Release channel | Artifact aggregation path |
|---|---|---|---|---|
| **Linux x86_64**   | orrion · `scripts/build_linux_native.sh` | embedded module (always-on when foreground) | direct download (AppImage, .deb) + future Flathub | `src-tauri/target/release/bundle/{appimage,deb}/` |
| **Linux aarch64**  | orrion · `cargo tauri build --target aarch64-unknown-linux-gnu` | embedded module | direct download (AppImage, .deb) | `src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/` |
| **Windows x86_64** | orrion · `scripts/build_windows_wsl.sh` (WSL) or `scripts/build_windows_native.ps1` (native) | embedded module | direct download (.msi) + future Microsoft Store | `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/` |
| **macOS Universal**| orrpheus · `scripts/build_macos_native.sh` | embedded module | direct download (.dmg) + Mac App Store (future) | `src-tauri/target/universal-apple-darwin/release/bundle/{dmg,macos}/` |
| **iOS ARM64**      | orrpheus · `cargo tauri ios build` (after `cargo tauri ios init`) | embedded module (foreground MVP — VoIP background entitlement is a stretch goal) | App Store (Apple Developer Program enrollment in progress 2026-04-07) | `src-tauri/gen/apple/build/Build/Products/Release-iphoneos/` |
| **Android ARM64**  | orrion · `cargo tauri android build` (after `cargo tauri android init`) | embedded module (foreground MVP) | Play Store + direct .apk download + F-Droid (future) | `src-tauri/gen/android/app/build/outputs/apk/release/` |

> **Embedded servitude rule (2026-04-08):** servitude is *not* a standalone
> daemon. Every Concord build, on every platform, ships the servitude module
> compiled into the same binary. Mobile MVP runs servitude in the foreground
> only — background hosting on iOS requires the VoIP background entitlement
> and is deferred. External always-on infra can also run a headless Concord
> binary; that's the same binary with a config flag.

---

## 5. Quick-start commands

### Linux native (orrion)

```bash
# From repo root on orrion:
./scripts/build_linux_native.sh
./scripts/build_linux_native.sh --smoke   # also smoke-launch the AppImage
```

The script runs the prerequisite check, builds the React client, then runs
`cargo tauri build --bundles appimage,deb`. Artifacts land in
`src-tauri/target/release/bundle/{appimage,deb}/`.

### macOS native (orrpheus)

```bash
# From repo root on orrpheus:
export APPLE_ID="you@example.com"
export APPLE_TEAM_ID="ABCDEFGHIJ"
export APPLE_CERT_NAME="Developer ID Application: Your Name (ABCDEFGHIJ)"
./scripts/build_macos_native.sh
```

Artifacts land in `src-tauri/target/universal-apple-darwin/release/bundle/`.

### Windows native (orrion via WSL)

```bash
# From repo root on orrion (under WSL or with cross toolchain):
./scripts/build_windows_wsl.sh
```

Or, if running PowerShell on a real Windows host:

```powershell
.\scripts\build_windows_native.ps1
```

### Android (orrion)

Android requires a one-time scaffolding step. The Tauri v2 init command must
be run on a host with the Android SDK installed:

```bash
# One-time, on orrion:
cd src-tauri
cargo tauri android init
# Then for every build:
cargo tauri android build
```

A placeholder template lives at
`src-tauri/gen/android/build.gradle.kts.template` so the directory layout is
visible in git before the init runs. See §7 for the full Android section.

### iOS (orrpheus)

iOS likewise requires a one-time scaffolding step on orrpheus:

```bash
# One-time, on orrpheus:
cd src-tauri
cargo tauri ios init
# Then for every build:
cargo tauri ios build
```

A placeholder template lives at
`src-tauri/gen/apple/project.pbxproj.template`. See §8 for full iOS notes,
including reuse of the entitlements proven by the 2026-03-28 iOS pipeline
proof-of-concept (recorded in `PLAN.md` Recent Changes).

---

## 6. Release aggregation convention

Each build host writes artifacts into its local
`src-tauri/target/.../bundle/` tree. Syncthing replicates the entire
`~/projects/concord` directory between orrion and orrpheus, so the artifacts
become visible on both hosts within seconds of being written.

The release flow (manual today, scriptable later):

1. Bump the version in `VERSION` and `src-tauri/Cargo.toml`.
2. On orrion: run `scripts/build_linux_native.sh`,
   `scripts/build_windows_wsl.sh`, and (post-init) `cargo tauri android build`.
3. On orrpheus: run `scripts/build_macos_native.sh` and (post-init)
   `cargo tauri ios build`.
4. Wait for Syncthing to mirror the new bundle outputs to a single host.
5. Upload all artifacts to a GitHub Release using the existing
   `/release concord <bump>` workflow described in the project root
   `CLAUDE.md`.

The convention is: **each machine builds its own native targets locally; no
machine ever cross-builds for Apple platforms; aggregation happens via
Syncthing then GitHub Releases.**

---

## 7. Android scaffolding (one-time, on orrion)

The Android target lives in `src-tauri/gen/android/`, but the actual project
files are generated by `cargo tauri android init`, which can only run on a
host with the Android SDK + NDK installed. To make the target structure
visible in git before init runs, a placeholder template is committed at:

```
src-tauri/gen/android/build.gradle.kts.template
```

When you are ready to run init on orrion:

```bash
# 1. Install Android Studio (or just the SDK + NDK).
# 2. Set ANDROID_HOME and NDK_HOME, e.g. in ~/.zshrc:
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/25.2.9519653"
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk"

# 3. Add Rust Android targets:
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android

# 4. From src-tauri:
cd ~/projects/concord/src-tauri
cargo tauri android init
```

After init succeeds, delete the `.template` placeholder and commit the
generated `build.gradle.kts`. Subsequent builds use:

```bash
cargo tauri android build           # release APK / AAB
cargo tauri android dev             # iterate against a USB device or emulator
```

The `[target.'cfg(target_os = "android")'.dependencies]` section in
`src-tauri/Cargo.toml` is reserved for Android-only crates (e.g. JNI helpers)
when servitude grows real platform integration.

---

## 8. iOS scaffolding (one-time, on orrpheus)

The iOS target lives in `src-tauri/gen/apple/`, generated by
`cargo tauri ios init`. Like Android, init can only run on a host with the
matching toolchain — for iOS that's orrpheus with Xcode installed. A
placeholder template is committed at:

```
src-tauri/gen/apple/project.pbxproj.template
```

When you are ready to run init on orrpheus:

```bash
# 1. Confirm Xcode 15+ is installed and `xcodebuild -version` works.
# 2. Add Rust iOS targets:
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# 3. From src-tauri:
cd ~/projects/concord/src-tauri
cargo tauri ios init
```

After init succeeds, port the **already-validated entitlements** from the
2026-03-28 iOS pipeline proof-of-concept (the original Tauri v2 iOS PoC
recorded in `PLAN.md` Recent Changes — the proof lives at
`concord_beta/src-tauri` if you need to reference it). Required entitlements:

- **Multicast networking** (`com.apple.developer.networking.multicast`)
- **Bonjour services** (`NSBonjourServices` in `Info.plist`)
- **Local network usage** (`NSLocalNetworkUsageDescription`)
- **Microphone usage** (`NSMicrophoneUsageDescription`)
- **Camera usage** (`NSCameraUsageDescription`)
- **Bluetooth** (`NSBluetoothAlwaysUsageDescription`)
- **Background audio** mode (`UIBackgroundModes` → `audio`)

> **MVP scope:** servitude on iOS runs **foreground-only** for v0.1. The
> VoIP background entitlement (which would allow servitude to keep hosting
> while the app is suspended) is a stretch goal that requires additional
> Apple review. Document but do not enable it for the v0.1 cut.

After init + entitlements are wired, builds use:

```bash
cargo tauri ios build               # release IPA
cargo tauri ios dev                 # iterate against a USB device or simulator
```

The `[target.'cfg(target_os = "ios")'.dependencies]` section in
`src-tauri/Cargo.toml` is reserved for iOS-only crates when servitude grows
real platform integration.

The Apple Developer Program enrollment was submitted on 2026-04-07; ID
verification is in progress. Plan as if active — the build flow above
assumes the team ID is available by the time you run a real signed build.

---

## 9. Verifying a fresh clone (orrion)

A fresh clone on orrion should be buildable end-to-end with:

```bash
git clone https://github.com/TruStoryHnsl/concord.git
cd concord/client && npm ci && npm run build && cd ..
./scripts/build_linux_native.sh --smoke
```

If the smoke test passes, the AppImage and `.deb` in
`src-tauri/target/release/bundle/` are ready to upload to a GitHub Release.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `error: failed to find development files for webkit2gtk-4.1` | webkit dev headers missing | Install `webkit2gtk-4.1` (Arch) or `libwebkit2gtk-4.1-dev` (Debian) |
| `tauri-cli: command not found` | Tauri CLI not installed | `cargo install tauri-cli --version '^2.0' --locked` |
| `cargo tauri ios init` fails on orrion | Apple toolchain not present | iOS builds run on orrpheus only — see §8 |
| AppImage smoke launch hangs in CI | No display server | Run with `xvfb-run` or skip `--smoke` |
| `linker 'cc' not found` on Windows | MSVC build tools missing | Install Visual Studio 2022 Build Tools |
