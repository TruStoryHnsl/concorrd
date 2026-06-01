# Resumable Conflict-Agent Session — Scope

**Status:** Scope document. No implementation in this PR.
**Author:** Architecture D spin-out from `hero-account-rfc.md` (2026-06-01).
**Cross-refs:** `hero-account-rfc.md` §5.d; orrchestrator agent dispatch surface.

## Motivation

When a destructive sync conflict is handed to a parallel-session agent and that agent times out, Concord does not abandon the work. The timed-out process is stopped, its context is folded into a new session, and the new session picks up where the previous one left off. This is a standing architectural pattern: any long-running AI sub-task in Concord follows the same resume model. Conflicts are too valuable a signal to drop on a timeout, and re-asking the user every time a session lapses is not acceptable UX.

## Scope

- A resume-on-timeout lifecycle for conflict-resolution agent sessions: detect timeout, stop the current agent process, capture its session context, spawn a successor with that context inlined, hand control to the successor.
- A serializable "agent session context" envelope that survives the death of the originating process and is portable to a new session of the same or different agent backend.
- A standing-pattern abstraction so other long-running AI sub-tasks in Concord (not only conflict resolution) reuse the same resume mechanism.
- Bookkeeping so a single conflict can span an arbitrary number of resumed sessions while remaining one entry in `conflict_queue`.

## Non-scope

- The verdict format itself (already in `hero-account-rfc.md` §5.d).
- The choice of agent backend (orrchestrator, local LLM, HTTP webhook) — already a configurable surface.
- The merge-event semantics of applying a verdict to the event log — `hero-account-rfc.md` §5.d.
- Cross-device convergence when two devices each resolve the same conflict — already resolved via the RFC's recommendation (higher-confidence verdict wins; tie → Lamport then device-id).

## Dependencies on other Concord subsystems

- The conflict queue + event log (`hero-account-rfc.md` §5).
- The agent-dispatch surface: orrchestrator integration, HTTP webhook, manual fallback (`hero-account-rfc.md` §5.d).
- Architecture E (hard-disconnect on app close) — if the user closes Concord mid-resolution, the agent session is torn down; the resume model picks back up on the next cold start.
- A standing convention for any other long-running AI sub-task (export packaging, history analysis, etc.) so they reuse the same envelope and lifecycle.

## Follow-up tasks for a future implementation dispatch

1. Specify the timeout policy per conflict kind (likely a default plus per-kind override; see also Architecture-D-adjacent confidence-threshold policy already resolved in the RFC).
2. Define the serializable session-context envelope: what fields, what redaction policy, what versioning.
3. Specify the stop-then-respawn lifecycle, including failure-to-respawn handling.
4. Integrate with the conflict-queue bookkeeping so a single conflict's history shows every resumed agent session for audit.
5. Generalize the lifecycle into a standing convention and document it so future long-running AI sub-tasks can adopt it without re-deriving the pattern.
6. Define operator-visibility surfaces: how the user sees "this conflict is being worked on" vs. "this conflict's last agent timed out and a successor is starting."
