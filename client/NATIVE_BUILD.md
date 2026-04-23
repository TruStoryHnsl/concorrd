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
| **Google TV / Android TV** | orrion · same `cargo tauri android build` (shared APK with leanback manifest flags) | embedded module (foreground MVP) | Play Store (TV track) + direct .apk sideload | `src-tauri/gen/android/app/build/outputs/apk/release/` (same APK as Android phone) |
| **Apple TV (tvOS)** | orrpheus · Xcode build of `src-tvos/ConcordTV.xcodeproj` (Path C shell, **deferred to post-v0.3**) | not embedded (web-only shell, no Rust runtime) | App Store (tvOS track, future) | `src-tvos/build/` |

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

### 7c. Build script (recommended)

Use `scripts/build_android_native.sh` instead of calling `cargo tauri android build`
directly. It handles:

- Auto-detection of `ANDROID_HOME` / `ANDROID_NDK_HOME`
- Rust target installation if any are missing
- React client build (with `npm ci` freshness check)
- Signing via env vars (debug skips signing)
- Artifact collection to `dist/android-release/` or `dist/android-debug/`

**Environment variables:**

| Variable | Required for | Description |
|---|---|---|
| `ANDROID_HOME` | All builds | Android SDK root (`~/Android/Sdk`). Auto-detected from common paths. |
| `ANDROID_NDK_HOME` | All builds | Android NDK root. Auto-detected from `$ANDROID_HOME/ndk/*`. |
| `KEYSTORE_PATH` | Signed release | Absolute path to `.jks` / `.keystore` file |
| `KEYSTORE_PASS` | Signed release | Keystore password |
| `KEY_ALIAS` | Signed release | Key alias within the keystore |
| `KEY_PASS` | Signed release | Key password (defaults to `KEYSTORE_PASS` if unset) |
| `RELEASE_DIR` | Optional | Override output directory |

**Usage:**

```bash
# Debug APK (unsigned, fast — good for device-over-USB iteration):
scripts/build_android_native.sh --debug

# Unsigned release APK (requires signing before distribution):
scripts/build_android_native.sh

# Signed release APK (ready for Play Store / direct install):
KEYSTORE_PATH=/path/to/concord.jks \
KEYSTORE_PASS=mypassword \
KEY_ALIAS=concord \
  scripts/build_android_native.sh

# Install debug build on connected device:
adb install dist/android-debug/concord.apk
```

**Output:** `dist/android-release/concord.apk` (release) or `dist/android-debug/concord.apk` (debug).

The `[target.'cfg(target_os = "android")'.dependencies]` section in
`src-tauri/Cargo.toml` is reserved for Android-only crates (e.g. JNI helpers)
when servitude grows real platform integration.

### 7a. Google TV / Android TV variant

Google TV and Android TV share the Tauri Android target — no new
Rust shell, no new APK track. The same `cargo tauri android build`
output installs on both phones and TVs provided the generated
`AndroidManifest.xml` includes leanback + touchscreen-optional
feature flags and a TV banner.

**Source-of-truth checklist**: `src-tauri/gen/android/AndroidManifest.xml.template`.
After `cargo tauri android init` runs on orrion, the porting step
must copy the keys from this template into the generated
`src-tauri/gen/android/app/src/main/AndroidManifest.xml`. The key
additions Tauri's default init does NOT include:

- `<uses-feature android:name="android.software.leanback" android:required="false"/>` — allows install on TVs without excluding phones
- `<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>` — required before Play Store ships the APK to TVs
- A second `<intent-filter>` under the MainActivity with `android.intent.category.LEANBACK_LAUNCHER` so the TV launcher grid shows the app
- `android:banner="@drawable/tv_banner"` on the `<application>` tag — mandatory for Google TV

**TV banner asset**: the 320x180 PNG spec and drop path are documented
in `src-tauri/gen/android/tv-banner-README.md`. The Play Store will
accept a placeholder banner for v0.1 — the branding pass is tracked
as a downstream task.

**Sideload to a Google TV / Android TV device**: the same APK that
installs on phones via `adb install concord.apk` installs on TVs the
exact same way. Enable Developer Options on the TV (Settings → System
→ About → press Build Number 7x) and turn on USB debugging, then
connect over the LAN:

```bash
adb connect <tv-ip>:5555
adb -s <tv-ip>:5555 install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

**DPAD navigation**: the React client detects TV mode at runtime via
the `usePlatform()` hook (TV detection = large screen + no pointer,
or UA contains "TV") and enables roving-tabindex focus navigation
through the `useDpadNav()` hook. Both hooks ship with unit tests in
`client/src/hooks/__tests__/`.

**Sub-platform detection**: `usePlatform()` exposes `isAndroidTV`
(true when `isAndroid && isTV`) and `isAppleTV` (true when the UA
contains "AppleTV" or "tvOS") for components that need to branch on
the specific TV platform rather than the generic `isTV` flag.

### 7b. Google TV build and sideload commands

Google TV uses the **same APK** as Android phones. No separate build
command is needed — `cargo tauri android build` produces a universal
APK that installs on both phones and TVs.

**Pre-build validation**: run the manifest compliance checker before
building to confirm all Google TV requirements are met:

```bash
scripts/build_androidtv_check.sh
```

This validates the 4 required manifest entries: leanback feature,
touchscreen optional, LEANBACK_LAUNCHER intent-filter, and
android:banner attribute. Exit code 0 means compliant; 1 means one
or more entries are missing.

**Build + sideload to a Google TV device**:

```bash
# Build (same as phone):
cd src-tauri
cargo tauri android build

# Sideload to a Google TV / Android TV device on the LAN:
adb connect <tv-ip>:5555
adb -s <tv-ip>:5555 install -r \
    src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

**TV banner asset**: the 320x180 placeholder banner lives at
`src-tauri/gen/android/app/src/main/res/drawable-xhdpi/tv_banner.png`.
See `src-tauri/gen/android/tv-banner-README.md` for the spec and
design pass instructions.

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
2026-03-28 iOS pipeline proof-of-concept into the generated Xcode
project. The porting step reads from two committed template files:

- `src-tauri/gen/apple/ios-entitlements.plist` — entitlements checklist
- `src-tauri/gen/apple/Info.plist.template` — Info.plist checklist,
  including the critical `UIDeviceFamily = [1, 2]` iPad enablement key

Both are plutil-validated and meant to be copied from — they are NOT
the files Xcode reads at build time. The generated
`src-tauri/gen/apple/concord_iOS/Info.plist` and
`concord_iOS.entitlements` must end up containing the union of
Tauri's default output and these template keys.

Required entitlements (all in `ios-entitlements.plist`):

- **Multicast networking** (`com.apple.developer.networking.multicast`) — needs Apple Developer Program approval
- **Wi-Fi information** (`com.apple.developer.networking.wifi-info`)
- **Keychain access group** — team-prefixed `com.concord.chat` group

Required Info.plist keys (all in `Info.plist.template`):

- **UIDeviceFamily = [1, 2]** — enables iPhone + iPad on the same build
- **NSLocalNetworkUsageDescription** — required for any multicast/Bonjour call
- **NSBonjourServices** — whitelist matching servitude's advertised types
- **NSMicrophoneUsageDescription** — voice channels
- **NSCameraUsageDescription** — video channels
- **NSBluetoothAlwaysUsageDescription** — future mesh BLE fallback
- **UIBackgroundModes → audio** — keep voice running when backgrounded

### iPad support (INS-020 acceptance)

iPad uses the **same Tauri target and same entitlements** as iPhone.
The split is declared entirely in the Info.plist — `UIDeviceFamily =
[1, 2]` tells iOS the app supports both devices. No separate Rust
target, no separate Xcode scheme, no second build command.

The React client adapts to iPad via CSS breakpoints at 768 px
(portrait) and 1024 px (landscape) plus the `usePlatform()` hook's
`isIPad` detection, which lets hooks and components branch on the
device without relying on viewport width alone (Mac-Safari-reported
iPad is otherwise indistinguishable).

`UISupportedInterfaceOrientations~ipad` allows all four orientations
on iPad; iPhone stays portrait + landscape-left/right. `UIRequiresFullScreen`
is `false` so iPad Split View and Slide Over work out of the box.

> **MVP scope:** servitude on iOS runs **foreground-only** for v0.1. The
> VoIP background entitlement (which would allow servitude to keep hosting
> while the app is suspended) is a stretch goal that requires additional
> Apple review. Document but do not enable it for the v0.1 cut.

After init + entitlements are wired, builds use the repo wrapper script
`scripts/build_ios_native.sh` (preferred) or the raw Tauri CLI:

```bash
# Repo wrapper (preferred — does prereq checks + artifact aggregation)
./scripts/build_ios_native.sh --sim       # simulator debug .app (no signing)
./scripts/build_ios_native.sh             # device release .app (signed if
                                          # APPLE_TEAM_ID + APPLE_CERT_NAME set,
                                          # unsigned otherwise for Sideloadly)

# Raw Tauri CLI (equivalent, no prereq checks)
cargo tauri ios build                     # release .app (device)
cargo tauri ios build --target aarch64-sim --debug   # simulator debug
cargo tauri ios dev                       # iterate against a USB device or simulator
```

The `[target.'cfg(target_os = "ios")'.dependencies]` section in
`src-tauri/Cargo.toml` is reserved for iOS-only crates when servitude grows
real platform integration.

The Apple Developer Program enrollment was submitted on 2026-04-07; ID
verification is in progress. Plan as if active — the build flow above
assumes the team ID is available by the time you run a real signed build.
Until `bundle.iOS.developmentTeam` is populated in `src-tauri/tauri.conf.json`,
`build_ios_native.sh` produces an **unsigned** device .app — fine for
Sideloadly / AltStore re-signing (see §8a below), not for TestFlight.

### 8a. Sideloading unsigned dev builds to a physical iPhone

This flow produces a Concord .app that can be installed on your own
iPhone today without waiting for Apple Developer Program ID verification
to finish. The re-signing is done on-device by Sideloadly or AltStore
against your free personal Apple ID, which gets a 7-day provisioning
profile — so you'll need to re-install once a week until you upgrade to
a paid team.

**Step 1. Produce an unsigned device .app.** With `APPLE_TEAM_ID`
and `APPLE_CERT_NAME` both unset in the environment:

```bash
unset APPLE_TEAM_ID APPLE_CERT_NAME
./scripts/build_ios_native.sh
```

The script will print a warning line acknowledging the unsigned mode and
drop the .app under `dist/ios-device/Concord.app`.

**Step 2. Convert .app → .ipa.** Sideloadly and AltStore both prefer an
.ipa (a zip of `Payload/Concord.app/`). Convert with:

```bash
cd dist/ios-device
mkdir -p Payload
mv Concord.app Payload/
zip -r Concord.ipa Payload
rm -rf Payload
```

If a future Tauri release emits the .ipa directly under
`src-tauri/gen/apple/build/` (older versions did this), `build_ios_native.sh`
picks it up automatically and you can skip the zip step.

**Step 3a. AltStore mac-companion install (preferred).**

1. Install AltServer for macOS from <https://altstore.io/>
2. Plug your iPhone into orrpheus via USB (or Lightning, depending on
   the device).
3. On the iPhone: Settings → General → VPN & Device Management → trust
   the developer certificate that AltStore installed.
4. In AltServer's menu bar icon: "Install AltStore" → pick your device.
5. In AltStore on the iPhone: tap `+` → browse to `Concord.ipa` synced
   over AirDrop or via iTunes file sharing → install.
6. AltStore signs the .ipa against your Apple ID and installs it. The
   resulting app expires after 7 days; relaunch AltStore on the phone
   before then to auto-refresh, or re-install from scratch.

**Step 3b. Sideloadly alternative.**

1. Install Sideloadly from <https://sideloadly.io/>
2. Plug the iPhone into orrpheus.
3. Drag `Concord.ipa` into the Sideloadly window.
4. Enter your Apple ID email and an app-specific password (required —
   Apple rejects plain account passwords from third-party installers).
5. Click "Start". Sideloadly re-signs the .ipa and installs it directly.
6. Same 7-day expiration applies; re-run Sideloadly to refresh.

**Step 4. Upgrade path to TestFlight.** Once the Apple Developer
Program ID verification completes:

1. Read the team ID out of the developer portal (it's the 10-character
   "Team ID" on the membership page).
2. Set `bundle.iOS.developmentTeam` in `src-tauri/tauri.conf.json` to
   that value.
3. Set `APPLE_TEAM_ID` and `APPLE_CERT_NAME` in your environment.
4. Re-run `./scripts/build_ios_native.sh` — it now produces a signed
   device .app suitable for Xcode's Archive flow or direct TestFlight
   submission via `xcrun altool` / the Transporter app.
5. Stop using Sideloadly/AltStore — you no longer need the 7-day
   re-sign loop.

**Sideload caveat:** the free personal-team provisioning profile that
Sideloadly/AltStore generates does NOT carry the multicast entitlement
(`com.apple.developer.networking.multicast`) that Concord's servitude
module requests for Bonjour peer discovery. On a sideloaded build, the
mDNS-based local-mesh features will silently fall back to manual peer
entry. This limitation disappears once the paid team's provisioning
profile is in use. Everything else (Matrix federation, WebRTC voice,
LAN chat against a homeserver on the same network via explicit IP) works
normally.

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

## 9a. Apple TV (tvOS) scaffolding status

**Status:** ACTIVE — native SwiftUI shell with server picker, bridge
implementation, asset catalog, and build script committed.

The Apple TV client follows **Path C** from the feasibility study
(`docs/native-apps/appletv-feasibility.md`): a standalone SwiftUI
native frontend. Unlike the Google TV target, tvOS cannot use the
Tauri Android shell — it is a completely separate Xcode project with
no Rust runtime. Since WebKit is unavailable on tvOS, the app is a
fully native SwiftUI frontend (not a webview wrapper) that talks to
the Concord/Matrix API via URLSession.

**What is committed:**

- `src-tvos/ConcordTV.xcodeproj/` — Xcode project targeting tvOS 17.0+
- `src-tvos/ConcordTV/ConcordTVApp.swift` — SwiftUI `@main` app entry with server picker flow
- `src-tvos/ConcordTV/ServerPickerView.swift` — Native server picker (URL input, validation, persistence)
- `src-tvos/ConcordTV/WebViewHost.swift` — Post-connection placeholder (channel list + chat coming later)
- `src-tvos/ConcordTV/JSBridge.swift` — 4-function bridge with real UserDefaults + ASWebAuthenticationSession
- `src-tvos/ConcordTV/Info.plist` — tvOS plist with network keys
- `src-tvos/ConcordTV/ConcordTV.entitlements` — keychain + multicast
- `src-tvos/ConcordTV/Assets.xcassets/` — Asset catalog with App Icon + Top Shelf Image placeholders
- `client/src/api/tvOSHost.ts` — TypeScript bridge client (no-ops on non-tvOS)
- `client/src/styles/tv.css` — 10-foot UI CSS overrides (active when `data-tv="true"`)
- `client/src/components/tv/TVCapabilityBanner.tsx` — Voice/video unavailability banner for TV
- `scripts/build_tvos_native.sh` — Build script for orrpheus

**What is NOT committed yet:**

- Native channel list + message view (server picker + placeholder only)
- Real UIFocus <-> SwiftUI focus bridging (focusChanged is a stub)
- Actual App Icon and Top Shelf artwork (catalog structure is placeholder)
- CI/CD pipeline for tvOS

**Build command (orrpheus):**

```bash
# Release build (device):
./scripts/build_tvos_native.sh

# Debug build (simulator):
./scripts/build_tvos_native.sh --sim

# Show help:
./scripts/build_tvos_native.sh --help
```

Artifacts land in `src-tvos/build/Build/Products/`.

**When to begin full implementation:** see `src-tvos/README.md` and the
feasibility study for the prerequisites checklist.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `error: failed to find development files for webkit2gtk-4.1` | webkit dev headers missing | Install `webkit2gtk-4.1` (Arch) or `libwebkit2gtk-4.1-dev` (Debian) |
| `tauri-cli: command not found` | Tauri CLI not installed | `cargo install tauri-cli --version '^2.0' --locked` |
| `cargo tauri ios init` fails on orrion | Apple toolchain not present | iOS builds run on orrpheus only — see §8 |
| iOS sideloaded app installs but crashes immediately on launch | `Info.plist` `UIDeviceFamily` and the entitlements file are out of sync, or an entitlement the app requests is missing from the provisioning profile | (1) Verify `plutil -p src-tauri/gen/apple/concord_iOS/Info.plist` shows `UIDeviceFamily = [1, 2]` and the `NSBonjourServices` types match servitude's advertised types. (2) On a free personal-team sideload, the multicast entitlement is silently stripped — Concord still launches but local-mesh features fall back to manual peer entry. (3) Check the device console (Console.app, attached to the iPhone) for the exact missing-entitlement string. |
| `cargo tauri ios build --target aarch64-apple-ios-sim` fails with `invalid value` | Tauri CLI uses short target aliases | Use `--target aarch64-sim` (simulator) or `--target aarch64` (device); `aarch64-apple-ios-sim` is the rustup name, not the Tauri CLI alias |
| AppImage smoke launch hangs in CI | No display server | Run with `xvfb-run` or skip `--smoke` |
| `linker 'cc' not found` on Windows | MSVC build tools missing | Install Visual Studio 2022 Build Tools |
| Google TV APK installs but app does not appear in TV launcher | Missing `LEANBACK_LAUNCHER` intent-filter or `android:banner` attribute | Run `scripts/build_androidtv_check.sh` to validate manifest compliance. Ensure the TV banner PNG exists at `src-tauri/gen/android/app/src/main/res/drawable-xhdpi/tv_banner.png`. |
| DPAD navigation not working on Google TV — arrow keys scroll the page | `useDpadNav` hook not enabled | Verify `usePlatform().isTV` returns `true` on the device. The hook must be passed `enabled: isTV`. Check that the webview UA string or `pointer: none` matchMedia is being detected. |
| Google TV build rejected by Play Store with "TV apps must declare leanback" | `android.software.leanback` uses-feature missing or `required="true"` | The template at `src-tauri/gen/android/AndroidManifest.xml.template` has `required="false"`. Ensure the generated manifest matches. |
