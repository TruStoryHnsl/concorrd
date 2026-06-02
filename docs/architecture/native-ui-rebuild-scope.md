---
title: Native UI Rebuild — Feasibility & Implementation Scope
status: assessment / pre-decision
author: assessment session 2026-06-01
audience: an implementing session that will execute this rebuild
supersedes: nothing (new track)
related:
  - docs/architecture/p2p-design.md
  - docs/architecture/porch-design.md
  - docs/architecture/concord-user-protocol-scope.md
  - docs/architecture/tailscale-gated-hero-sync-scope.md
---

# Native UI Rebuild — Feasibility & Implementation Scope

> **Read this first if you are picking up the native-UI work.** This is an
> evidence-grounded assessment with the inventory already done, the hard
> problems ranked, toolkit options laid out, and a de-risked migration
> sequence. Numbers were measured on `main` at the time of writing — re-measure
> before quoting them as current.

## 0. Goal (verbatim intent)

Build a **true native, OS-window-managed desktop application** for Concord that:

1. **Drops webview rendering entirely** for native builds (no WebKitGTK, no
   WKWebView — actual native widgets / GPU compositing).
2. Is **near-identical to but improved over** the current React UI — elegant,
   Discord-style p2p chat.
3. Has **100% compatibility with the Concord docker implementation and zero
   capacity compromise** — anything the web client can do against a docker
   deployment, the native app can do, and more.

The **docker/web implementation is explicitly NOT changing.** It is the free,
configurable, self-hosted *infrastructure* surface, and the web-first React UI
is the correct UI for it. This track is purely about the native client.

## 1. The core finding — compatibility is a protocol property, not a UI property

A Concord docker deployment exposes exactly three wire surfaces:

1. **Matrix client-server API** (the `tuwunel` homeserver).
2. **FastAPI REST** — **146 endpoints** (`server/routers/*.py`, `server/main.py`).
3. **LiveKit voice/video** (WebRTC media + signaling).

The web client has **no privileged channel** — it speaks only those three.
Therefore **any client that speaks those three is fully docker-compatible**, and
a native client has **no inherent capacity ceiling** relative to the web client.

The web UI's limitations are **DOM/CSS limitations, not backend limitations.** A
native UI can match every web feature and add things the DOM structurally cannot:
real OS windows + multi-window, GPU-composited virtualized timelines, native
audio DSP, system tray, global hotkeys, native notifications, true filesystem
access. **No compatibility is traded** — compat is guaranteed by speaking the
same protocols, not by sharing view code.

> Corollary for the repo split (separate track): the **web client stays in the
> public docker repo**; the **native engine + native UI live in the private
> repo**. They share the *protocol contract*, not view code — so there is no
> code-leak vector and no compat coupling.

## 2. Inventory (measured on `main`, 2026-06-01)

| Layer | Location | Size | Fate in native rebuild |
|---|---|---|---|
| React view | `client/src` | **101 components** (139 `.tsx` incl. tests), **20 stores**, **~53.6K LOC** TS/TSX (+15.5K test LOC) | **Fully rebuilt** — dominant cost |
| Rust core | `src-tauri/src` | **~38K LOC**, **100 `#[tauri::command]`** | **Reused as-is** — already native, toolkit-agnostic |
| Native WebRTC voice plane | `src-tauri/src/**/voice/*.rs` | **~3K LOC** (webrtc-rs 0.8, "Phase 8") | **Reused / finished** |
| Matrix client | `client/src` (`matrix-js-sdk@41`) | **24 files**, ~40 call sites | **Must move to Rust** (matrix-rust-sdk) |
| REST layer | `client/src/api/*` (`fetch`) | 146 endpoints consumed | **Mechanical port** to reqwest |

**View hotspots (LOC, non-test):** `settings` 9.0K · `layout` 6.8K · `voice` 3.9K
· `porch` 3.0K · `chat` 2.4K · `peers` 1.2K · `server` 1.2K. The bulk of the
rebuild is settings + layout + voice + porch.

**Component groups** (`client/src/components/`): `auth brand chat dm extension
layout local moderation onboarding pairing peers porch public server settings
sources ui voice` + top-level `BringingUpSplash`, `LaunchAnimation`, `Welcome`,
modals.

### 2.1 The Rust core is the asset

`src-tauri/src` is **already native and has no React dependency**. It contains:
libp2p (porch / hero-sync / mesh / peer-store), boringtun WireGuard, Stronghold
identity, rusqlite persistence, ed25519 + ChaCha20-Poly1305 + Argon2id crypto,
the concord-user protocol, and a **partial pure-Rust WebRTC media plane**
(`webrtc = "0.8"`, with a LiveKit fallback path selector). The "backend" of the
native app is largely done; what's missing is the **view layer** and **two
protocol clients that currently live in JS** (Matrix, LiveKit).

### 2.2 Every current "native" build is actually a webview

- **Desktop:** Tauri 2.11 renders `client/` in WebKitGTK. It is a webview.
- **tvOS** (`src-tvos/`): SwiftUI shell hosting a `WKWebView` + `JSBridge` of the
  same React app (`WebViewHost.swift`, `FocusableWebView.swift`,
  `WebViewContainer.swift`, `JSBridge.swift`). Also a webview.

**There is no true-native-UI precedent in the tree yet.** This track creates the
first one.

## 3. The compatibility contract a native client must satisfy

1. **Matrix CS API** — sync, rooms, timeline + pagination, E2EE, media.
   - Today: `matrix-js-sdk`. Coupling is **concentrated** (~40 call sites:
     `getRoom`/`getRooms`/`sendEvent`/`sendMessage`/`on(...)`/`startClient`/
     `paginateEventTimeline`), not smeared — bounded lift.
   - Native: **`matrix-rust-sdk`** (the engine under Element X — mature, fast,
     E2EE-complete).
2. **FastAPI REST (146 endpoints)** — registration, media, admin, DMs, explore,
   direct-invites, ext-proxy, etc. (`server/routers/`). Native: `reqwest`
   (already a `src-tauri` dependency) + serde. Mechanical.
3. **LiveKit voice/video** — today `livekit-client` + `@livekit/components-react`.
   Native: LiveKit's official **Rust SDK** (libwebrtc-backed) **or** finish the
   existing `webrtc-rs` path.

## 4. Hard problems, ranked by risk

1. **Native voice/video parity (HIGHEST risk).** Browser WebRTC is free; native
   is not. LiveKit Rust SDK gives echo-cancellation / simulcast / SVC via
   libwebrtc but pulls a heavy C++ dependency and per-platform build complexity.
   `webrtc-rs` (already vendored) is pure-Rust but trails libwebrtc on AEC,
   simulcast, and hardware codecs. Screen-share, video tiles, soundboard mixing,
   and audio device hot-swap all need native plumbing. **This is the real test
   of "no capacity compromise."**
2. **Matrix → Rust.** `matrix-rust-sdk` is excellent, but reproducing the exact
   timeline / sync / read-receipt / threading behaviors the JS UI assumes is
   weeks of careful work, not a drop-in.
3. **Discord-class chat rendering.** Virtualized infinite timeline + markdown +
   code blocks + custom emoji + reactions + inline media/video + link previews +
   edit/reply/threads. **Retained-mode toolkits (Slint, Qt, Flutter) handle this
   far better than immediate-mode (egui).** This is where "elegant" is won/lost.
4. **Rich media** — image/GIF/video decode + display, uploads, drag-drop, the
   mp4 splash. Native video playback is per-platform.
5. **Brand polish / animation** — the splash (THE only loading animation —
   reuse, never reinvent) + transitions need a toolkit with real animation, not
   a static widget grid.

## 5. Toolkit options (honest tradeoffs)

Decision bar: elegant Discord-class UI · OS-window-managed (no webview) ·
cross-platform incl. eventual mobile/TV · Rust-leaning (user default is Rust).

| Toolkit | View lang | Elegant Discord-class? | Mobile/TV reach | Notes |
|---|---|---|---|---|
| **gpui** (Zed) | Rust | Best-in-class GPU UI | Desktop strong; mobile not yet | Gorgeous, but unstable API, no stable release, steep |
| **Slint** | Rust + `.slint` | Good; declarative + animation | Desktop + embedded; mobile partial | **Strongest all-Rust product path** |
| **iced** | Rust | Decent (COSMIC uses it) | Desktop; mobile experimental | Mature-ish; rich-text/media still maturing |
| **Flutter** + `flutter_rust_bridge` | Dart / Rust core | Excellent, easily | **Desktop + iOS + Android** | **Best product velocity**; violates Rust-default (Dart view) |
| **egui** | Rust | No — tool aesthetic | Yes | Fast to prototype; wrong for this product |
| **SwiftUI / WinUI / GTK** per-platform | Swift/C#/C | Best OS-native feel | Each platform separately | Best feel, **~3× UI work**, no view reuse |

**Two serious contenders:**

- **All-Rust priority → Slint** (or **gpui** if you accept bleeding edge). One
  language, FFI-free to the Rust core, more bespoke rendering effort.
- **UI velocity / polish / mobile priority → Flutter + flutter_rust_bridge.**
  Dart view layer, mature FFI to your Rust engine, Discord-class UIs are routine,
  and it ships to mobile/TV. Cost: Dart in the view layer.

**This toolkit choice is the #1 open decision (see §8).** Everything else in
this doc is toolkit-agnostic.

## 6. Effort estimate (one focused dev; parity first, then "improved")

| Workstream | Estimate |
|---|---|
| REST → Rust (`reqwest` port of 146 endpoints) | ~1 week (mechanical) |
| Matrix → Rust (`matrix-rust-sdk` integration) | ~3–5 weeks |
| Native voice (LiveKit Rust SDK or finish `webrtc-rs`) + UI | ~3–6 weeks (high variance) |
| View rebuild to parity (~54K LOC React → native) | ~3–5 months (dominant cost) |
| **Total to parity** | **~½–¾ year** |

"Improved beyond parity" is open-ended on top. Native is often denser per
feature than React, but the view rebuild still dominates the schedule.

## 7. De-risked migration strategy (the important part)

1. **Promote the Rust core to a clean `concord-engine` library crate.** Expose a
   real Rust API (not Tauri-command-shaped). It already has no React dependency —
   formalize the boundary so both the existing Tauri app and the new native UI
   bind to the same engine. The 100 Tauri commands become thin wrappers over
   engine methods.
2. **Build the native UI as a parallel front-end / separate binary** bound to the
   engine, behind a feature flag. **Do NOT remove the webview until the native UI
   reaches parity surface-by-surface.** No big-bang cutover.
3. **Sequence by surface:** identity/sources → chat timeline → voice →
   porch/p2p → settings. Ship native incrementally; webview covers the rest
   meanwhile.
4. **Compat is structural.** The native app is "just another Matrix + REST +
   LiveKit client." Because it speaks the same wire protocols the docker stack
   already serves, docker-compatibility is guaranteed *by construction* — there
   is no separate compat layer to maintain and no capacity ceiling vs web.

### 7.1 Suggested first spikes (de-risk before committing the schedule)

- **Voice spike:** stand up a minimal Rust LiveKit client (official SDK) that
  joins a room on a live docker deployment and pushes/pulls one audio track —
  versus the same on `webrtc-rs`. Decide the voice path on evidence. **Do this
  first; it is the highest-variance item.**
- **Toolkit spike:** build the chat timeline (virtualized list + markdown + one
  inline image) in the top-2 candidate toolkits. Judge "elegant" on a real
  surface, not a hello-world.
- **Matrix spike:** drive `matrix-rust-sdk` through login → sync → render one
  room's timeline → send a message, against a docker deployment.

## 8. Open decisions for the user (resolve before implementation)

1. **Toolkit** (§5) — all-Rust (Slint/gpui) vs Flutter+frb. Gates everything.
2. **Voice path** (§4.1) — LiveKit Rust SDK (libwebrtc, heavier build, full
   parity) vs finish `webrtc-rs` (pure-Rust, parity risk). Decide via the spike.
3. **Platform scope of v1** — desktop-only first, or desktop + mobile from the
   start (this strongly influences toolkit choice; `src-tvos` implies TV/mobile
   is on the roadmap).
4. **Parity bar for cutover** — which surfaces must reach native parity before
   the webview is retired per-platform.

## 9. Hard constraints (inherited project rules — do not violate)

- **Secret domain:** the personal instance domain is a SECRET — it must NEVER
  appear in code, commits, docs, logs, or shipped state. Grep the staged diff
  for it before every commit (the exact slug + check live in the project's
  auto-memory under the "domain is a secret" feedback note).
- **Splash is sacred:** the splash mp4 is THE only loading animation. Reuse it
  for every loading state; never invent a new spinner.
- **Session branch isolation + tiered merge to main** at session close.
- **Verify by observation** (`spectacle-peek` / `gui-sandbox`) before claiming
  any native UI surface works — do not claim "done" on a green build alone.

## 10. Bottom line

Technically there is **no capacity compromise**: the docker stack imposes no
ceiling a native client can't meet or exceed; the entire cost is implementation
effort, dominated by the ~54K-LOC view rebuild plus moving Matrix into Rust and
solving native voice. The highest-risk item is **native WebRTC voice parity**;
the biggest asset is that the **~38K-LOC Rust core (including a partial native
voice plane) is already toolkit-agnostic and reusable**. The recommended path is
a **parallel, surface-by-surface native front-end over a promoted
`concord-engine` crate**, with the webview retired per-surface only as native
parity lands — and the web client left untouched as the docker infrastructure UI.
