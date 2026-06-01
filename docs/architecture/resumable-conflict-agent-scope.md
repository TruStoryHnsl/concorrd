# Resumable Conflict-Agent Session — Scope + Implementation Notes

**Status:** Implemented in PR `feat(sync): resumable conflict-agent session with dead-session context handoff` (F-D, 2026-06-01).
**Author:** Architecture D spin-out from `hero-account-rfc.md` (2026-06-01).
**Cross-refs:** `hero-account-rfc.md` §5.d; orrchestrator agent dispatch surface.
**Module:** [`src-tauri/src/porch/conflict_agent.rs`](../../src-tauri/src/porch/conflict_agent.rs).

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

---

## Implemented contract (F-D PR)

### Schema (v9 → v10)

Two new tables, one append-only audit log + one current-state queue:

```sql
CREATE TABLE conflict_queue (
    conflict_id        TEXT PRIMARY KEY,
    conflict_kind      TEXT NOT NULL,
    payload_json       TEXT NOT NULL,
    queued_at          INTEGER NOT NULL,
    resolved_at        INTEGER,
    final_verdict_json TEXT,
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'resolved', 'manual_required'))
);
CREATE TABLE conflict_attempts (
    attempt_id           TEXT PRIMARY KEY,
    conflict_id          TEXT NOT NULL,
    started_at           INTEGER NOT NULL,
    ended_at             INTEGER,
    state                TEXT NOT NULL
                         CHECK (state IN ('running', 'succeeded', 'timeout', 'aborted')),
    partial_context_blob TEXT,
    partial_verdict_json TEXT,
    FOREIGN KEY (conflict_id) REFERENCES conflict_queue(conflict_id) ON DELETE CASCADE
);
CREATE INDEX idx_conflict_queue_unresolved
    ON conflict_queue(queued_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_conflict_attempts_by_conflict
    ON conflict_attempts(conflict_id, started_at);
```

`conflict_attempts` rows are **append-only at the row level** — a timed-out attempt produces a row, the orchestrator NEVER edits a finalized row. The `partial_context_blob` column IS overwritten on each heartbeat snapshot WITHIN a single live attempt, but once that attempt finalizes the row is immutable.

### `ConflictResolutionTask` data model

```rust
pub struct ConflictResolutionTask {
    pub conflict_id:    String,
    pub conflict_kind:  String,   // catalogue: concurrent_rename | tombstone_vs_write | acl_change | …
    pub payload_json:   String,   // { event_a: {...}, event_b: {...} }
    pub attempts:       Vec<AgentAttempt>,
    pub final_verdict:  Option<Verdict>,
}

pub struct AgentAttempt {
    pub attempt_id:           String,
    pub started_at:           i64,
    pub ended_at:             Option<i64>,
    pub state:                AttemptState, // Running | Succeeded | Timeout | Aborted
    pub partial_context_blob: Option<String>,
    pub partial_verdict_json: Option<String>,
}
```

A `ConflictResolutionTask` is composed at read time from `conflict_queue` + `conflict_attempts`; the SQL surface exposes both halves (see `Porch::conflict_queue_get_task`).

### `ConflictResolver` trait

```rust
#[async_trait]
pub trait ConflictResolver: Send + Sync {
    async fn resolve(&self, input: ConflictInput, ctx: ResolverContext) -> ResolverResult;
}

pub enum ResolverResult {
    Succeeded(Verdict),
    Timeout(PartialContext),
    Aborted { reason: String },
}
```

Two implementations ship today:

1. **`DeterministicConflictResolver`** — the default. Applies the RFC §5.c rules locally:
   - `concurrent_rename` / `concurrent_channel_rename` → LWW (lamport, device_id) tiebreak; rationale + confidence stamped.
   - `tombstone_vs_write` / `concurrent_delete_and_post` → synthesize a `NewValue` verdict that resurrects the channel + preserves the post (confidence 0.55 — below the RFC §5.d auto-apply threshold for destructive kinds, so a `pending` UI confirmation is intended for safety).
   - `acl_change` / `concurrent_role_change` → prefer the more restrictive side (revoke beats grant); tie → LWW; confidence 0.6 (security-sensitive ⇒ user confirmation expected per RFC §5.d).
   - Unknown kind → `Aborted { reason }` so the orchestrator burns the attempt and (eventually) flips to `manual_required`.
2. **`MockTimeoutResolver`** — test-only. Emits `Timeout` N times then `Succeeded`, used to verify the resume pipeline.

Future PRs swap in a real LLM-backed resolver by `impl ConflictResolver`-ing a new struct and constructing the orchestrator with it. No schema change required.

### Agent-context hand-off format (the `<<previous-session>>` preamble)

The hand-off contract is defined at three surfaces:

1. **Heartbeat snapshot cadence.** While a resolver is running, it can call `ResolverContext::snapshot(blob, partial_verdict)` to update the active attempt's `partial_context_blob`. In production the cadence is one snapshot per `HEARTBEAT_INTERVAL` (default 5 s); in tests it's 20 ms. The LAST snapshot before a timeout is what the next attempt inherits.

2. **The `<<previous-session>>` preamble.** When the orchestrator dispatches a NEW attempt against a conflict whose previous attempt timed out, the dispatch input carries this exact envelope as its `previous_session_preamble`:

   ```text
   <<previous-session>>
   attempt: <prior_attempt_id>
   state: timeout
   snapshot:
   <verbatim partial_context_blob>
   <</previous-session>>
   ```

   Resolvers that don't care about it can ignore the field; LLM-backed resolvers parse it back into their own working state and continue.

3. **Retry budget.** `OrchestratorConfig::max_attempts` (default 5) caps the number of attempts per conflict. On the cap-th timeout (or aborted attempt), the conflict row flips to `status = 'manual_required'` and the orchestrator stops dispatching against it. The UI surface (`conflict_queue_list_unresolved`) lists `manual_required` rows so the user can resolve them by clicking in the diff UI.

### Orchestration loop (`ResumableConflictAgent::run_once`)

```text
walk unresolved conflict_queue rows
for each row, spawn a task that loops:
    count attempts so far
    if attempts >= max_attempts → mark manual_required, exit
    build ConflictInput {
        payload_json,
        previous_session_preamble: if prior attempt timed out, build envelope from prior blob else None
    }
    insert running attempt row
    tokio::time::timeout(attempt_timeout, resolver.resolve(input, ctx)).await
    finalize attempt row with terminal state + final snapshot
    if Succeeded → mark conflict resolved, return
    if Timeout/Aborted → loop, attempt N+1 picks up the heartbeat snapshot
```

The orchestrator is `Clone`, so callers can spawn it on a background tokio task while keeping the queue-write side (`conflict_queue_enqueue`, called by F-C's detector) on the main thread.

### Tauri command surface (read-side + manual fallback)

| Command                              | Purpose                                                                |
|--------------------------------------|------------------------------------------------------------------------|
| `conflict_queue_list_unresolved`     | List every unresolved conflict (status = `pending` or `manual_required`). |
| `conflict_queue_get_attempts`        | Read the per-attempt audit trail for a single conflict.                |
| `conflict_queue_force_manual`        | Abandon agent dispatch on a conflict; flag for manual resolution.      |
| `conflict_queue_manual_resolve`      | Apply a user-typed verdict (validated against `Verdict` shape).        |

The UI builds on these in a follow-up PR; F-D ships only the state.

### Tests (`cargo test --lib porch::conflict_agent`)

10 tests, all passing:

- `schema_migration_creates_conflict_tables` — round-trip on v9→v10 migration.
- `deterministic_resolver_resolves_concurrent_rename` — happy path; LWW verdict lands; row resolved.
- `timeout_then_succeed_carries_previous_session_preamble` — resolver times out once, the orchestrator re-dispatches with the `<<previous-session>>` preamble, the successor sees `preamble_in=true` in its heartbeat blob, succeeds on attempt 2.
- `cap_out_flips_to_manual_required` — resolver times out 5× in a row; row flips to `manual_required`; final verdict still `None`.
- `concurrent_conflicts_resolved_in_parallel` — 4 conflicts queued; all resolve in one `run_once` pass without DB contention.
- `manual_resolve_flips_to_resolved` — user verdict accepted via `conflict_queue_manual_resolve`.
- `preamble_format_is_stable` — envelope format pinned (regression guard for cross-version resolvers).
- `manual_resolve_rejects_bad_json` — malformed verdict JSON returns `Serde` error, never silently writes garbage.
- `deterministic_resolver_handles_tombstone_vs_write` — `NewValue` verdict + low confidence (no auto-apply).
- `deterministic_resolver_handles_acl_change_prefers_revoke` — revoke beats grant even with lower Lamport.

## Follow-up tasks

The original spin-out listed six follow-ups; the F-D PR closes 1–5. Remaining:

6. **Operator-visibility surfaces** — UI panel rendering `conflict_queue_list_unresolved` + `conflict_queue_get_attempts`, including a per-attempt timeline that shows the `<<previous-session>>` hand-off explicitly. Uses `<BringingUpSplash />` for the loading state per global UI convention.

Future PRs:

- Real AI-backed resolver `impl ConflictResolver` (orrchestrator integration first; HTTP webhook + local LLM second).
- Per-conflict-kind timeout + retry-budget overrides per RFC §5.d's "auto-apply threshold is per-conflict-kind" rule.
- Auto-run loop: spawn `ResumableConflictAgent::run_once` on a tokio task at app start; re-trigger when F-C enqueues a new row (channel-based wake).
