# Session Report — 2026-03-26/27 (orrpheus)

## Session: Cross-Platform Mobile Builds + Mesh Node Verification System

**Machine:** orrpheus (macOS M1 Pro, clamshell mode)
**Duration:** ~12 hours across 2026-03-26 to 2026-03-27
**Agent:** Claude Opus 4.6 (orrpheus - concord)
**Parallel agent:** Another Claude instance was working on orrion simultaneously (audio pipeline, commercial audit)

---

## Objectives

1. Build testable iOS and Android applications from Concord v2
2. Zero code duplication across platforms
3. Install Android mobile dev tools on orrpheus
4. Enable remote emulator viewing from orrion
5. Implement mesh node verification tagging system
6. Implement processing power distribution model

---

## Completed Work

### 1. Mobile Development Environment (orrpheus)

Installed from scratch on orrpheus:
- **Rust 1.94.1** via rustup (7 cross-compilation targets: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios, aarch64-linux-android, armv7-linux-androideabi, i686-linux-android, x86_64-linux-android)
- **Tauri CLI 2.10.1** (compiled from source, ~1400 dependencies)
- **Android SDK** at `~/Library/Android/sdk` — platform-tools, build-tools 34, NDK 27.0.12077973, emulator, API 34 system image, Pixel 7 AVD
- **Xcode 16.2** configured — xcode-select switched, license accepted, first-launch completed, iOS 18.3.1 Simulator runtime downloaded (8.72 GB)
- **CocoaPods 1.16.2**, XcodeGen 2.45.3, libimobiledevice, cmake
- **Fish shell** config updated with ANDROID_HOME, NDK_HOME, Rust paths

### 2. Tauri v2 Mobile Targets (Zero Code Duplication)

**Architecture:** Tauri v2 wraps the existing React frontend + Rust backend in native platform shells. The same codebase compiles for macOS, iOS, and Android with zero duplication.

**iOS:**
- `cargo tauri ios init` — generated Xcode project at `v2/src-tauri/gen/apple/`
- Added `SystemConfiguration.framework`, `AudioToolbox.framework`, `AVFAudio.framework` to project.yml
- Added `#[cfg_attr(mobile, tauri::mobile_entry_point)]` on `run()` in lib.rs
- Fixed iOS Simulator runtime match policy (SDK 18.2 → runtime 18.3.1)
- Fixed cmake policy for cross-compilation (`CMAKE_POLICY_VERSION_MINIMUM=3.5`)
- **Successfully built and deployed to iPhone 16 Pro Simulator**

**Android:**
- `cargo tauri android init` — generated Gradle project at `v2/src-tauri/gen/android/`
- NDK 27.0.12077973 with proper source.properties
- **Successfully built debug APK (28MB) and deployed to Pixel 7 emulator**

### 3. Frontend Mobile Adaptations

- **`usePlatform` hook** — detects iOS/Android/desktop via `@tauri-apps/plugin-os`
- **Safe area CSS** — `env(safe-area-inset-*)` utilities for notch/home indicator padding
- **AppShell** — forces mobile layout on iOS/Android regardless of screen size tier; wraps TopBar/BottomNav in safe-area containers
- **MessageInput** — added `enterKeyHint="send"`, autocorrect, selectable class
- **Viewport meta** — `viewport-fit=cover`, `maximum-scale=1.0`, `user-scalable=no`
- **Global CSS** — overscroll-behavior, tap-highlight, user-select defaults for native feel

### 4. Mesh Node Verification Tagging System

**Core types** (`concord-core/types.rs`):
- `VerificationState` — Verified / Stale / Speculative
- `VerificationTag` — per-peer freshness with heartbeat-based TTL
- `NodeProbeMessage` — Probe/ProbeResponse for peer liveness
- `ComputeAllocationMessage` + `ComputeEntry` — processing power distribution
- `MeshNodeRecord` — enriched node combining all data for frontend

**Database** (`concord-store/mesh_store.rs` + db.rs):
- 3 new tables: `peer_verification`, `compute_allocations`, `local_compute_priorities`
- 9 store methods: upsert/mark verified, TTL decay, compute allocation storage, priority management
- Triangular distribution formula: rank R of N gets share `(N-R+1) / (N*(N+1)/2)`

**Network events** (`concord-net/events.rs`):
- `NodeProbeReceived` and `ComputeAllocationReceived` variants

**Tauri commands** (`commands/mesh.rs`):
- `get_mesh_nodes` — enriched peer list with verification state + compute weight
- `set_compute_priorities` / `get_compute_priorities` — manage power distribution

### 5. Mesh Map Visualization Updates

**NodeMapPage** now reflects:
- **Verification-driven opacity**: Verified=0.95, Stale=0.55, Speculative=0.3
- **Ring indicators**: Verified gets a bright secondary ring, Stale gets a muted ring, Speculative has none
- **Compute-weighted dot sizing**: `baseDotSize * (1 + receivedComputeWeight * 0.5)`
- **Tooltip additions**: Verification state row with icon, compute weight percentage, probe button placeholder
- **Legend**: Three new entries for Verified/Stale/Speculative states
- Data source upgraded from `getNearbyPeers()` + `getTunnels()` to also include `getMeshNodes()`

### 6. orrpheus System Configuration

- **Sleep prevention**: `SleepDisabled=1`, `sleep=0`, `standby=0`, `hibernatemode=0`, `displaysleep=0` on AC profile
- **Persistent caffeinate** daemon via LaunchDaemon (survives reboots)
- **Auto-login** enabled, screen lock disabled for headless/clamshell operation
- **Stage Manager** disabled (caused VNC display issues)
- **Display resolution** set to 1280x800 for VNC usability
- **VNC/ARD** activated via kickstart
- **Spotify auto-launch** killed and disabled (was triggered by loginwindow restart)

### 7. Remote Emulator Viewer

Built `v2/scripts/emulator-viewer.py` — a custom web-based viewer that:
- Captures both iOS Simulator and Android Emulator screenshots via `xcrun simctl io` and `adb screencap`
- Serves side-by-side view at `http://100.66.55.59:8090`
- Atomic writes with file locks to prevent serving partial images
- Preloads images in browser before swapping (no layout reflow on failure)
- Click-to-tap interaction forwarding via `simctl send_event` and `adb shell input tap`
- Status bar with per-device health indicators and frame counts

---

## Files Created

| File | Purpose |
|------|---------|
| `v2/crates/concord-store/src/mesh_store.rs` | Verification tag + compute allocation DB methods |
| `v2/frontend/src/hooks/usePlatform.ts` | Platform detection hook for cross-platform UI |
| `v2/src-tauri/capabilities/mobile.json` | Tauri mobile platform capability |
| `v2/scripts/setup-mobile-env.sh` | Mobile dev environment setup script |
| `v2/scripts/remote-display.sh` | VNC remote display helper |
| `v2/scripts/stream-to-orrion.sh` | noVNC streaming to orrion |
| `v2/scripts/emulator-viewer.py` | Web-based dual emulator viewer |

## Files Modified

| File | Changes |
|------|---------|
| `v2/crates/concord-core/src/types.rs` | +7 new types (VerificationState, VerificationTag, NodeProbeMessage, ComputeAllocationMessage, ComputeEntry, MeshNodeRecord, DEFAULT_VERIFICATION_TTL) |
| `v2/crates/concord-store/src/db.rs` | +3 new tables in schema |
| `v2/crates/concord-store/src/lib.rs` | +mesh_store module |
| `v2/crates/concord-net/src/events.rs` | +2 NetworkEvent variants |
| `v2/src-tauri/src/commands/mesh.rs` | +3 commands (get_mesh_nodes, set_compute_priorities, get_compute_priorities), +2 payload types |
| `v2/src-tauri/src/events.rs` | +2 event constants |
| `v2/src-tauri/src/lib.rs` | +3 command registrations, mobile_entry_point macro |
| `v2/src-tauri/tauri.conf.json` | iOS bundle config |
| `v2/src-tauri/gen/apple/project.yml` | +SystemConfiguration, AudioToolbox, AVFAudio frameworks, cmake policy fix |
| `v2/frontend/src/api/tauri.ts` | +MeshNode, VerificationState, ComputePriorityEntry types, +3 API functions |
| `v2/frontend/src/stores/mesh.ts` | +meshNodes, computePriorities state, +3 actions |
| `v2/frontend/src/components/mesh/NodeMapPage.tsx` | Verification-driven rendering, compute-weighted sizing, enriched tooltips, legend |
| `v2/frontend/src/components/layout/AppShell.tsx` | Platform-aware mobile layout, safe area padding |
| `v2/frontend/src/components/chat/MessageInput.tsx` | Mobile keyboard hints |
| `v2/frontend/src/index.css` | Safe area utilities, mobile defaults |
| `v2/frontend/index.html` | Mobile viewport meta |
| `~/.config/fish/config.fish` | Android SDK, NDK, Rust paths |

---

## Known Issues

1. **Android cross-compile** currently fails on `openssl-sys` build — the other agent's audio dependency (`audiopus_sys`) introduces an OpenSSL build requirement that doesn't cross-compile cleanly to Android. The earlier Android build (pre-audio) works. Needs an Android-compatible OpenSSL or vendored alternative.
2. **iOS Simulator GUI** doesn't render windows in clamshell mode — the simulator runs headlessly and screenshots work via `simctl io`, but the Simulator.app window doesn't compose to the macOS display in clamshell. The emulator-viewer workaround handles this.
3. **cmake policy warning** on newer cmake versions — patched via `CMAKE_POLICY_VERSION_MINIMUM=3.5` env var in the Xcode build script.
4. **Test file type errors** — vitest types needed explicit `types: ["vitest/globals"]` in tsconfig.json (pre-existing issue from other agent's test additions).

---

## Architecture Decisions

**Why Tauri v2 mobile (not Flutter/React Native):** Concord v2 is already a Tauri v2 app. Tauri v2 has native mobile support — the same React frontend runs in WKWebView (iOS) and Android WebView. The same Rust crates cross-compile to all platforms. Zero code duplication, zero framework migration.

**Why heartbeat-based TTL (not time-based):** Each node computes verification freshness from its own observation perspective. A node that's actively chatting has frequent heartbeats and tight verification. A dormant node lets TTLs expire naturally. This matches the vision: "always varying degrees of inaccurate, always being updated and refined by the collective network analysis efforts."

**Why triangular distribution for compute:** Simple, fair, and predictable. Top-priority node gets the most, but everyone gets something. The formula `(N-R+1) / sum(1..N)` is deterministic and doesn't need negotiation between nodes.
