# Apple TV Build Handoff — orrpheus

Branch: `feat/ins-023-appletv`
Date: 2026-04-10
From: orrion (Linux, no Xcode)

## What's on the branch

Two commits ship the full tvOS scaffold:

1. **SwiftUI + WKWebView shell** (`src-tvos/`) — 5 Swift files, XcodeGen `project.yml`, JS bridge, build script
2. **TV UI wiring** — CSS classes on components, `data-focusable` DPAD attributes, `useDpadNav` activated, 10-foot layout, read-only message banner, 3 TV test cases

125 client tests pass, 0 regressions.

## Prerequisites (one-time)

```bash
# Install xcodegen if not already present
brew install xcodegen

# Ensure Xcode 15+ is installed with tvOS SDK
xcodebuild -showsdks | grep tvos
# Expected: appletvos17.x, appletvsimulator17.x

# Ensure Node 18+ is available
node --version
```

## Quick start — Simulator build

```bash
cd ~/projects/concord
git fetch origin
git checkout feat/ins-023-appletv

# Build + run in Apple TV Simulator (debug, unsigned)
scripts/build_tvos_native.sh --sim

# The .app lands in dist/tvos-sim/
# Open the simulator and install:
xcrun simctl boot "Apple TV 4K (3rd generation)"
xcrun simctl install booted dist/tvos-sim/Concord.app
xcrun simctl launch booted com.concord.chat.tv
```

## Device build (unsigned, for Sideloadly)

```bash
scripts/build_tvos_native.sh
# Output: dist/tvos-device/Concord.app (unsigned)
# Re-sign with Sideloadly or AltStore for physical Apple TV
```

## Device build (signed, for TestFlight)

```bash
export APPLE_TEAM_ID="<your-10-char-team-id>"
export APPLE_CERT_NAME="Apple Development: Your Name (XXXXXXXXXX)"
scripts/build_tvos_native.sh
# Output: dist/tvos-device/Concord.app (signed)
```

## What to verify on orrpheus

### Simulator smoke test
- [ ] `xcodegen generate` in `src-tvos/` produces `concord-tvos.xcodeproj` without errors
- [ ] `scripts/build_tvos_native.sh --sim` completes (exit 0)
- [ ] App launches in Apple TV Simulator
- [ ] Server picker screen appears on first launch
- [ ] Can enter a hostname and connect to concorrd.com (or local server)
- [ ] Login flow works (registration or existing account)
- [ ] Channel list renders with visible text at TV distance
- [ ] DPAD navigation moves focus between server icons (left rail)
- [ ] DPAD navigation moves focus between channels (channel sidebar)
- [ ] "Read-only on TV" banner appears instead of message input
- [ ] Voice channel shows "Voice channels are view-only on Apple TV" banner

### Device test (if Apple TV hardware available)
- [ ] Sideloaded .app installs on physical Apple TV
- [ ] Same smoke test items as simulator
- [ ] Siri Remote physical button mapping: arrows, select, menu, play/pause

## Known limitations

- **Voice/video**: View-only. tvOS WebKit lacks full WebRTC; microphone capture from Siri Remote is not possible.
- **File upload**: Hidden. No filesystem picker on tvOS.
- **Message input**: Replaced with read-only banner. No on-screen keyboard on tvOS (Apple's pattern is companion-device text entry).
- **Camera**: Hidden. No camera on Apple TV hardware.
- **Bonjour discovery**: Entitlement is in place but not wired to the UI yet.

## Branding assets needed

Replace placeholders in `src-tvos/concord-tvos/Assets.xcassets/`:
- `AppIcon.brandassets/` — needs 1280x768 and 400x240 app icon images
- `TopShelfImage.imageset/` — needs 1920x720 (1x) and 3840x1440 (2x) Top Shelf banner

## Architecture reference

See `docs/native-apps/appletv-feasibility.md` for the full Path C rationale.

The tvOS app is a standalone SwiftUI shell (~300 LOC) that loads the same `client/dist` React bundle in a WKWebView. No Tauri, no Rust runtime. The bridge layer is 4 functions:
- `setServerConfig` / `getServerConfig` — UserDefaults persistence
- `focusChanged` — reserved for Swift-initiated focus updates
- `openAuthURL` — ASWebAuthenticationSession for OAuth
