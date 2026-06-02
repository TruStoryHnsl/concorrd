# Hard-Disconnect on App Close — Scope

**Status:** Scope document. No implementation in this PR.
**Author:** Architecture E spin-out from `hero-account-rfc.md` (2026-06-01).
**Cross-refs:** `hero-account-rfc.md` §3, §5; F-WG queued dispatch.

## Motivation

Concord sessions are alive only while the user is actively interacting with the running app. When the user closes the app, every native peer-to-peer connection tears down — no background daemon, no warm-resume, no idle reconnect loop. Each device retains full control over its connectivity. Re-connect on next launch must be cheap, but cold-start cost is acceptable. This rule supersedes any prior framing in the RFC about "device-link token TTL" — tokens do not have a TTL; sessions end when the user closes the app.

## Scope

- A single, well-defined "app close" event that tears down every active native p2p connection: porch greet sessions, home-sync exchanges, server discovery, address rotation, history fetch, export delivery, and the WireGuard tunnels themselves.
- A guarantee that no Concord process remains running in the background after app close on the user's primary platform targets.
- A fast cold-start path on next launch so the user does not perceive the cost.
- An exit-handler abstraction usable by every subsystem that opens a native connection.

## Non-scope

- Mobile foreground/background lifecycle nuance — already handled by INS-022 / user-management Phase 3. Mobile installs do not have a "background daemon" mode either; this scope formalizes the rule across all platforms.
- Web build connection lifecycle — the web build does not own the native connection set this scope governs.
- Persistent state on disk (SQLite, exported bundles) — unaffected; only live connections tear down.
- Reconnection / handshake re-negotiation logic on next launch — that's downstream of this scope and handled by the existing porch greet + Phase F sync handshakes.

## Dependencies on other Concord subsystems

- F-WG (WireGuard tunnel wrapping) — Architecture E governs the tear-down of the tunnels F-WG establishes.
- The porch ephemeral server — already wired to "no persistent state across launches"; this scope formalizes the connection-tear-down half of that semantic.
- The home-sync exchange (`hero-account-rfc.md` §5) — Architecture E hard-stops any in-flight sync when the user closes the app.
- Architecture C (Tailscale-gated hero sync) — the reachability gate is re-evaluated on every cold start because the prior session's reachability state did not survive close.
- Architecture D (resumable conflict-agent sessions) — if a conflict-resolver agent was running when the user closed the app, the next launch picks up via the resume model.

## Follow-up tasks for a future implementation dispatch

1. Enumerate every native subsystem that opens a connection and register each with the exit-handler abstraction.
2. Define the exit-handler protocol: synchronous best-effort tear-down with a bounded grace window before the process exits.
3. Specify the cold-start budget: target time-to-first-usable-state on next launch and the subsystems that must meet it.
4. Verify on each desktop platform (Linux, macOS, Windows) that no Concord process survives app close, and add a regression check.
5. Audit any prior TTL-based assumptions in the RFC and downstream design docs and replace them with the close-driven lifecycle.
6. Document the user-visible contract: "closing Concord ends every connection; opening Concord starts them again from scratch."
