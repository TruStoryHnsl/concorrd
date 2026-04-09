# Apple TV (tvOS) feasibility study for Concord

**Status:** DESIGN SPIKE — no implementation committed.
**Sprint:** 2026-04-09 native-apps sprint
**Scope:** determine whether Concord can ship a tvOS client alongside
the iOS / iPadOS / Android / Google TV targets already in flight, and
if so, via what concrete path.

## TL;DR recommendation

**Do not attempt tvOS for v0.1. Ship the Google TV / Android TV target
first (it is free with the existing Tauri Android shell) and revisit
tvOS no earlier than Concord v0.3 when the Apple Developer Program
relationship is established and the iOS bundle is already shipping
to TestFlight.**

When tvOS is eventually pursued, take **Path C — parallel SwiftUI +
WKWebView shell that loads the same `client/dist` bundle** — because
it is the only path whose total risk, maintenance burden, and wait
time are all within Concord's control.

The body of this document explains the reasoning.

## 1. Why Apple TV is different from the other four platforms

Concord's sprint goal names five platforms: iOS, iPadOS, Android,
Google TV, and Apple TV. Four of them land inside the existing Tauri
v2 mobile pipeline with minimal incremental work:

| Platform        | Shell                              | Work this sprint |
|-----------------|------------------------------------|------------------|
| iOS             | Tauri v2 iOS (`aarch64-apple-ios`) | entitlements + Info.plist templates committed (T2) |
| iPadOS          | Tauri v2 iOS (shared target)       | `UIDeviceFamily = [1, 2]` key in Info.plist template (T2), CSS breakpoints (T6) |
| Android phone   | Tauri v2 Android                   | manifest template with permissions committed (T3) |
| Google TV       | Tauri v2 Android + leanback flags  | leanback intent-filter, uses-feature, TV banner (T3) |
| **Apple TV**    | **???**                            | **no Tauri target exists** |

Tauri v2 officially supports macOS, iOS, Android, Windows, and Linux.
**tvOS is not on the list.** Tauri's mobile runtime (the Rust <->
WebKit bridge that makes `cargo tauri ios build` produce a working
.ipa) hard-codes iOS-specific toolchain assumptions, and the
underlying `wry` webview crate has no tvOS backend. This is not an
oversight that the Tauri team will fix next week — it is an absent
platform target that would require writing a new runtime layer.

Concretely, reaching tvOS from inside the existing Concord shell
requires ONE of:

- **(A)** waiting for upstream Tauri to add `aarch64-apple-tvos`
  support
- **(B)** forking Tauri + `wry` to add the tvOS target ourselves
- **(C)** writing a parallel, non-Tauri SwiftUI + `WKWebView` host app
  that loads the same `client/dist` bundle

All three are examined below, with explicit cost, risk, and
maintenance estimates.

## 2. Path A — Wait for upstream Tauri tvOS support

### What it would take

Nothing on our side except patience. When the Tauri project ships an
`aarch64-apple-tvos` target, Concord runs `cargo tauri tvos init`
(or whatever the command ends up being), ports the entitlements, and
ships.

### Timeline reality check

The Tauri v2 roadmap (as of 2026-04-09) has no tvOS milestone, no
open tracking issue with a labelled owner, and no public discussion
about WebKit-on-tvOS. The Tauri team has historically prioritized
platforms where a non-trivial number of contributors ran into the gap
themselves; tvOS app store submissions are a tiny fraction of iOS
submissions, and streaming apps (the usual tvOS use case) are served
by native frameworks, not by webviews. There is no obvious market
pressure on Tauri to take this on.

**Plausible window for upstream tvOS support:** 12-24 months, with a
real chance of "never."

### Cost

- Engineering: zero
- Dollar: zero
- Calendar: unbounded

### Risk

- **Very high schedule risk** — we have no control over delivery.
- Zero technical risk (we implement nothing).
- Zero maintenance burden until delivery.

### Recommendation

This is a reasonable *default* path but a terrible *plan*. Check in
once per quarter (Tauri v2 changelog) and switch to a real path if
Concord's native suite is ever held up on tvOS alone.

## 3. Path B — Fork Tauri + wry to add tvOS

### What it would take

1. Fork `tauri-apps/tauri` and `tauri-apps/wry`.
2. Add a new `src/platform_impl/tvos` module in `wry` that wraps
   `WKWebView` with the tvOS-specific frame lifecycle. tvOS WebKit
   uses the same `WKWebView` API surface as iOS but runs under
   `TVApplicationController` or a custom `UIApplicationDelegate`
   subclass, and many UIKit conveniences are unavailable (no
   `UINavigationController`, no touch scroll, focus model is DPAD-
   only via `UIFocusItem`).
3. Add a `tauri-runtime-tvos` crate (or extend `tauri-runtime-wry` with
   a `#[cfg(target_os = "tvos")]` branch).
4. Add `aarch64-apple-tvos` + `aarch64-apple-tvos-sim` to the Tauri
   CLI's supported targets and teach `cargo tauri` about `cargo tauri
   tvos init` and `cargo tauri tvos build`.
5. Teach the signing / packaging pipeline that tvOS uses a different
   App Store Connect track, different provisioning profile type, and
   different .ipa layout.
6. Handle the tvOS focus model — `WKWebView` on tvOS does NOT expose
   DOM focus directly to the DPAD. Focus has to be bridged from the
   UIFocus system into JavaScript via a custom message handler, which
   our `useDpadNav` hook would then consume.

### Cost

- **Engineering**: 6-12 months of a single full-time engineer
  familiar with both Rust and Apple platform development. The tvOS
  focus-bridge alone is a 2-4 week subproject; the CI / packaging
  integration is another 4-6 weeks.
- **Dollar**: non-trivial — we would be maintaining a soft-fork of an
  active upstream project and would either (a) continuously rebase on
  Tauri main, or (b) let the fork diverge and then have to un-fork
  when upstream adopts tvOS, at which point our work is thrown away.
- **Calendar**: 6-12 months minimum.

### Risk

- **Very high technical risk.** We would be doing Tauri's R&D on
  Tauri's behalf. Every time Tauri or wry refactor the runtime
  internals (which they do frequently in v2 land), our patch rebase
  becomes harder.
- **Very high maintenance burden.** Every upstream Tauri release has
  to be reviewed for conflicts with the tvOS code. If the core Tauri
  team rejects our PR upstream (likely — they will want their own
  design), we're on the fork forever.
- **Platform target risk.** WebKit on tvOS is much more restricted
  than on iOS. Many Web APIs that Concord relies on (MediaStream,
  WebAudio for custom capture, WebRTC device enumeration, etc.) may
  simply not be available. The fork could work, the build could
  produce an .ipa, and the app could still be unusable because
  tvOS-WebKit does not expose WebRTC at parity with iOS-WebKit.

### Recommendation

**Reject.** The tvOS WebKit feature-gap risk alone is enough to kill
this path. If the platform's webview can't do WebRTC, the cost of
getting Tauri to run on it is wasted.

## 4. Path C — Parallel SwiftUI + WKWebView shell

### What it would take

1. Create a new repository directory `src-tvos/` (or a sibling
   `concord-tvos/` checkout) containing a standalone Xcode tvOS app
   target. No Tauri. No Rust runtime.
2. The tvOS app is a SwiftUI wrapper that hosts a single full-screen
   `WKWebView`. On launch it loads the same `client/dist` bundle
   shipped inside the iOS / desktop builds — either bundled as a
   resource directory in the .ipa, or pointed at the first-launch
   server picker's resolved `api_base` with a companion well-known
   `/tvos/bootstrap.json`.
3. A thin Swift <-> JavaScript bridge exposes the four things the web
   bundle needs from the host:
     - `host.setServerConfig(config)` — persist to UserDefaults
     - `host.getServerConfig()` — load from UserDefaults
     - `host.focusChanged(elementId)` — bridge tvOS UIFocus into the
       JS `useDpadNav` hook's expected DOM `focus` events
     - `host.openAuthURL(url)` — delegate to `ASWebAuthenticationSession`
       for OAuth flows
4. The tvOS focus model is driven at the SwiftUI layer — a
   `FocusableView` wraps the WebKit host and translates DPAD events
   into the JS bridge. Our `useDpadNav.ts` hook already implements
   the JS-side roving tabindex; Path C's only responsibility is
   feeding it DOM focus events that mirror where the tvOS UIFocus
   engine thinks the user wants to go.
5. Signing + distribution uses the existing Apple Developer Program
   team that iOS uses — no new relationship required.

### Cost

- **Engineering**: 4-6 weeks of a single engineer fluent in Swift.
  ~1 week to stand up the SwiftUI shell, ~2 weeks for the JS bridge,
  ~1 week for the focus bridge, ~1 week for signing + TestFlight, ~1
  week of polish.
- **Dollar**: nothing beyond the existing Apple Developer Program
  enrollment (already in progress per `client/NATIVE_BUILD.md` §8).
- **Calendar**: 4-6 weeks elapsed.

### Risk

- **Low technical risk.** WKWebView on tvOS is a known quantity.
  Several major apps (Disney+, a few small games) have used the same
  pattern. WebRTC is still limited in tvOS-WebKit (Apple has not
  granted full WebRTC to tvOS), so any **voice / video** call the
  Concord bundle tries to initiate from the tvOS build will fall
  back to "view-only" mode — this is a capability gap we'd need to
  acknowledge in-app.
- **Low maintenance burden.** The tvOS shell has no Tauri dependency
  and no Rust runtime. Upstream Tauri can evolve however it wants
  without breaking our tvOS build. The only thing we have to keep
  in sync is the `client/dist` bundle shape and the 4-function JS
  bridge API.
- **Code duplication risk.** The tvOS shell is a second implementation
  of a thin host app. It drifts if no one watches it. Mitigation: the
  shell is so thin (~300 LoC of Swift) that an annual audit is cheap.

### Recommendation

**This is the one to pick when the time comes.** It is the only path
whose calendar risk and technical risk are both within Concord's
control, it reuses the existing client bundle and server picker
flow, and it co-exists peacefully with whatever Tauri does upstream.

## 5. Concrete capability gaps on tvOS (any path)

Even after the shell exists, the following Concord features are
**not available on tvOS** at parity with the iOS build:

- **Voice channels** — tvOS-WebKit has never shipped full WebRTC.
  LiveKit ICE negotiation may work in receive-only mode (pull-based
  SFU) but microphone capture from a tvOS remote is not a thing.
  The tvOS build would be **view-only** for voice, with a clear
  in-app banner saying "Voice unavailable on Apple TV."
- **Video channels** — same constraint. View-only.
- **Multipeer / Bonjour peer discovery** — tvOS apps can use
  `MultipeerConnectivity` at the native layer, but routing that back
  up into the JS bundle is non-trivial. v0.1 tvOS would disable the
  peer-discovery mesh entirely and require a picker-selected
  homeserver.
- **Camera / photo picker** — no camera on Apple TVs. Feature hidden.
- **File sharing uploads** — no filesystem picker. Feature hidden.

The remaining Concord surface (text chat, channel browsing, server
picker, settings) works identically because it is all
DOM-and-fetch-based.

## 6. Next steps checklist (for when tvOS becomes a priority)

When the team decides to revisit tvOS (target: post-v0.3, no earlier
than Q3 2026):

- [ ] Re-verify this feasibility study — WebKit on tvOS may have
      added WebRTC; Tauri may have landed upstream support; both
      changes affect the path choice.
- [ ] Stand up `src-tvos/` as a new Xcode tvOS target (Path C).
- [ ] Port the iOS entitlements from
      `src-tauri/gen/apple/ios-entitlements.plist` — tvOS uses the
      same multicast + Bonjour + keychain entitlements where
      applicable, minus the ones the platform doesn't expose.
- [ ] Implement the 4-function JS bridge and a
      `tvOSHost.ts` TypeScript module in `client/src/api/` that
      feature-detects the bridge and no-ops on other platforms.
- [ ] Extend `usePlatform().isTV` to also return `isAppleTV: true`
      when the WKWebView UA string identifies tvOS.
- [ ] Add a clear in-app "Voice unavailable on Apple TV" banner.
- [ ] Ship to TestFlight alongside the iOS build from the same
      Apple Developer Program account.

## 7. What this sprint delivers instead

This sprint ships the following in lieu of any tvOS code:

- **iOS / iPadOS / Android / Google TV** native-build scaffolding
  (tasks T1-T6) — the four tractable platforms of the original five.
- **This feasibility doc** as a decision record so the next time
  someone asks "why don't we have an Apple TV app?" the answer is
  written down.
- **Google TV as the big-screen target** — it is already covered by
  the Android build with zero incremental shell work, and the DPAD
  navigation hook lands alongside it.

## 8. Cross-references

- `client/NATIVE_BUILD.md` — authoritative per-platform build matrix
- `src-tauri/gen/android/AndroidManifest.xml.template` — Google TV
  leanback config that this doc contrasts with
- `client/src/hooks/usePlatform.ts` — TV detection heuristics (will
  need `isAppleTV` extension if/when Path C proceeds)
- `client/src/hooks/useDpadNav.ts` — JS focus model that the tvOS
  Swift bridge would feed into
