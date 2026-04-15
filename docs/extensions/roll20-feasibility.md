# Roll20 BrowserSurface Feasibility (INS-036 W5)

**Status:** Blocked — embedding not feasible via BrowserSurface  
**Date:** 2026-04-14  
**Verdict:** Roll20 cannot be embedded in a Concord `BrowserSurface` iframe. Three independent mechanisms block it.

---

## Blocking Mechanisms

### 1. X-Frame-Options: SAMEORIGIN

Roll20 serves the `X-Frame-Options: SAMEORIGIN` HTTP response header on all authenticated pages (the VTT campaign view, character sheets, etc.). This is a **server-enforced policy** — it is set by Roll20's servers and cannot be overridden by client-side code or sandbox attributes.

When a browser receives `X-Frame-Options: SAMEORIGIN`, it refuses to render the page inside any frame whose parent origin differs from Roll20's own origin. Since Concord is served from a different origin (e.g. `app.concord.app` or an Electron/Tauri shell), the browser will produce a load error and display nothing.

This mechanism blocks the embed at the browser rendering layer before any JavaScript executes.

### 2. CSP frame-ancestors

Roll20's Content Security Policy includes `frame-ancestors 'self'`, which has the same effect as `X-Frame-Options: SAMEORIGIN` but is **stricter and takes precedence** in modern browsers (Chrome, Firefox, Safari all prefer `frame-ancestors` when both headers are present).

`frame-ancestors 'self'` means only Roll20's own origin may frame Roll20 pages. Unlike `X-Frame-Options`, CSP `frame-ancestors` cannot be bypassed by iframe sandbox attributes — the directive is evaluated by the browser regardless of how the parent framed the page.

Even if Roll20 removed `X-Frame-Options`, the CSP directive would independently block the embed.

### 3. BrowserSurface Allowlist

`client/src/components/extension/BrowserSurface.tsx` enforces an additional Concord-layer restriction:

```ts
const BROWSER_SURFACE_ALLOWLIST = /^https:\/\/[a-zA-Z0-9-]+\.concord\.app(\/|$)/;
```

Any `src` URL that does not match `*.concord.app` is **rejected before the iframe is created**. The component renders a blocked error card instead. `roll20.net` and `app.roll20.net` do not match this pattern.

This means even if Roll20 lifted both the `X-Frame-Options` and `frame-ancestors` restrictions, BrowserSurface would still refuse to load the URL. Removing this allowlist check would require a deliberate, audited policy change — it exists to prevent extension abuse.

---

## Why All Three Must Be Addressed

Each mechanism operates at a different layer:

| Layer | Mechanism | Who Controls It |
|---|---|---|
| Browser rendering | `X-Frame-Options: SAMEORIGIN` | Roll20 servers |
| Browser CSP enforcement | `frame-ancestors 'self'` | Roll20 servers |
| Concord extension surface | BrowserSurface allowlist regex | Concord codebase |

Removing the BrowserSurface allowlist restriction (Concord-controlled) would not help because the browser would still refuse to render the page due to Roll20's server headers. Roll20 would need to opt in to cross-origin embedding for any iframe approach to work.

---

## Alternative Integration Paths

### Option A: Companion App

A native or web companion application runs Roll20 in the user's own browser session (bypassing framing restrictions entirely) and mirrors selected VTT state back to Concord via Roll20's API or webhooks. Concord displays a read-only "VTT state panel" extension surface showing initiative order, character HP, current scene thumbnail, etc.

- Roll20 has a documented API for campaign data reads.
- State can be pushed to Concord via WebSocket or SSE from a small backend proxy.
- No Roll20 cooperation needed; no X-Frame-Options involved.
- Limitation: users must be logged into Roll20 in a separate browser tab.

### Option B: Bookmarklet / Browser Extension

A JavaScript bookmarklet or browser extension injected into an active Roll20 tab intercepts relevant game state events (turn change, HP update, map reveal) and forwards them to Concord via a WebSocket connection. Concord renders a lightweight companion panel using standard extension surfaces.

- No server-side Roll20 cooperation needed.
- Works within the user's existing Roll20 session.
- Limitation: requires the user to install a browser extension or click a bookmarklet each session; not zero-friction.

### Option C: external_url Loader

The Concord extension session model supports `"loader": "external_url"` in `launch_descriptor`, which opens the target URL in the user's system browser rather than embedding it. This is the correct path when the target app does not permit framing.

A Roll20 extension using `external_url` would:
1. Open `https://app.roll20.net/sessions/<campaign_id>` in the system browser when the user starts the session.
2. Use the companion app or bookmarklet approach (Option A or B) for state sync back into Concord.

This is the **recommended path** — it respects Roll20's security policy and is implementable without Roll20's cooperation.

---

## Summary

| Path | Feasible | Effort | Roll20 cooperation needed |
|---|---|---|---|
| BrowserSurface iframe | No | — | Yes (server header removal) |
| Companion app | Yes | Medium | No |
| Bookmarklet / browser extension | Yes | Medium | No |
| external_url + state sync | Yes | Low–Medium | No |
