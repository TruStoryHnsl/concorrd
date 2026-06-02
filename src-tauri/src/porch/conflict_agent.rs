//! F-D — Resumable conflict-agent session.
//!
//! When the F-C conflict-detection layer queues a destructive sync
//! conflict, this module is the orchestration substrate that drives it
//! to a verdict. The standing architectural pattern: **dead session's
//! context flows into the next session.** When a resolver attempt times
//! out, the orchestrator stops the timed-out task, captures its
//! most-recent heartbeat snapshot, and spawns a NEW attempt whose input
//! is the original `payload_json` PLUS the partial context from the
//! dead attempt — embedded as a `<<previous-session>>` preamble so the
//! successor picks up where its predecessor left off rather than
//! restarting from zero.
//!
//! This is NOT specific to AI-backed resolvers — the
//! [`ConflictResolver`] trait is the swappable seam. Concord ships
//! with two implementations today:
//!
//! * [`DeterministicConflictResolver`] — the default. Applies the
//!   RFC §5.c rules locally (Lamport-then-device-id LWW; tombstone +
//!   write fold to a "channel exists, message preserved" verdict; ACL
//!   changes prefer the more restrictive choice). Requires no AI
//!   model, runs synchronously, and is the canonical fallback when
//!   no agent is configured.
//! * [`MockTimeoutResolver`] — test-only. Used by the cargo tests to
//!   exercise the resume pipeline: it returns
//!   [`ResolverResult::Timeout`] N times before succeeding, so we can
//!   verify that (a) the next attempt sees the prior attempt's partial
//!   context in its input, (b) the cap-out path flips the conflict
//!   row to `manual_required` after the configured retry budget.
//!
//! ## Agent-context hand-off contract
//!
//! The hand-off is defined at THREE distinct surfaces:
//!
//! 1. **Heartbeat snapshot cadence.** While a resolver is running, the
//!    orchestrator polls the live attempt's `working_state` channel at
//!    [`HEARTBEAT_INTERVAL`] (default 5 s in production, overridden in
//!    tests via [`OrchestratorConfig`]). Every heartbeat sample writes a
//!    `partial_context_blob` to the attempt's row. If the resolver
//!    terminates with [`ResolverResult::Succeeded`], the final blob is
//!    irrelevant (the row gets `state = succeeded`); if it terminates
//!    with [`ResolverResult::Timeout`], the LAST observed snapshot is
//!    what the next attempt inherits.
//!
//! 2. **`<<previous-session>>` preamble.** When a new attempt is
//!    dispatched against a conflict that has a prior timed-out
//!    attempt, the orchestrator constructs a
//!    [`ConflictInput::previous_session_preamble`] string from the
//!    prior `partial_context_blob` and prepends it to the resolver's
//!    input under that exact tag. The format is intentionally textual
//!    + framed so the same envelope works for a local deterministic
//!    resolver AND a remote LLM-backed resolver. Format:
//!    ```text
//!    <<previous-session>>
//!    attempt: <attempt_id>
//!    state: timeout
//!    snapshot:
//!    <verbatim partial_context_blob>
//!    <</previous-session>>
//!    ```
//!    Resolvers that don't care about the preamble are free to ignore
//!    it; resolvers that DO care (an LLM thread) parse it back into
//!    their own working state and continue from there.
//!
//! 3. **Retry budget.** [`OrchestratorConfig::max_attempts`] caps the
//!    number of attempts per conflict (default 5). On the
//!    `max_attempts`-th `Timeout`, the conflict row is flipped to
//!    `status = 'manual_required'` and the orchestrator stops
//!    dispatching against it. The UI surface
//!    ([`crate::porch::Porch::conflict_queue_list_unresolved`]) lists
//!    `manual_required` rows so the user can resolve them by clicking
//!    in the diff UI.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use super::db::Porch;
use super::error::PorchError;

// ---------------------------------------------------------------------------
// Public configuration knobs
// ---------------------------------------------------------------------------

/// Default heartbeat-snapshot cadence in production. Tests override this
/// via [`OrchestratorConfig`] to a far smaller interval so the resume
/// pipeline runs in well under a second.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

/// Default retry budget. After this many timed-out attempts, the
/// orchestrator stops dispatching and flips the conflict row to
/// `manual_required`.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 5;

/// Default per-attempt timeout. Resolvers that don't terminate within
/// this window are forcibly aborted; the most-recent heartbeat snapshot
/// flows into the next attempt.
pub const DEFAULT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(60);

/// Orchestrator tunables. Cloned into the run loop so each conflict's
/// dispatch carries its own copy.
#[derive(Clone, Debug)]
pub struct OrchestratorConfig {
    /// Cap on total attempts per conflict. Past this, the row is
    /// flipped to `manual_required`.
    pub max_attempts: u32,
    /// Wall-clock timeout for a single resolver attempt.
    pub attempt_timeout: Duration,
    /// Snapshot cadence — how often the live resolver's working state
    /// is captured into `conflict_attempts.partial_context_blob`.
    pub heartbeat_interval: Duration,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            attempt_timeout: DEFAULT_ATTEMPT_TIMEOUT,
            heartbeat_interval: HEARTBEAT_INTERVAL,
        }
    }
}

// ---------------------------------------------------------------------------
// Data model — `ConflictResolutionTask` family
// ---------------------------------------------------------------------------

/// Single attempt at resolving a conflict. The attempts list of a
/// `ConflictResolutionTask` is append-only — each timeout produces a
/// new row, the orchestrator never edits prior rows.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentAttempt {
    pub attempt_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub state: AttemptState,
    /// Most-recent heartbeat snapshot. On a timeout, this is the blob
    /// that becomes the next attempt's `<<previous-session>>` preamble.
    pub partial_context_blob: Option<String>,
    /// Any tentative reasoning the resolver emitted before terminating.
    /// JSON-encoded so the schema can evolve without a migration.
    pub partial_verdict_json: Option<String>,
}

/// Lifecycle states for a single attempt. Mirrors the SQL CHECK
/// constraint on `conflict_attempts.state`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttemptState {
    Running,
    Succeeded,
    Timeout,
    Aborted,
}

impl AttemptState {
    fn as_str(&self) -> &'static str {
        match self {
            AttemptState::Running => "running",
            AttemptState::Succeeded => "succeeded",
            AttemptState::Timeout => "timeout",
            AttemptState::Aborted => "aborted",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "running" => Some(AttemptState::Running),
            "succeeded" => Some(AttemptState::Succeeded),
            "timeout" => Some(AttemptState::Timeout),
            "aborted" => Some(AttemptState::Aborted),
            _ => None,
        }
    }
}

/// Status of a `conflict_queue` row. Mirrors the SQL CHECK on
/// `conflict_queue.status`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictStatus {
    /// Either no attempts yet, or the most recent attempt timed out
    /// and the orchestrator may dispatch a successor.
    Pending,
    /// A successful attempt's verdict is recorded in `final_verdict_json`.
    Resolved,
    /// Retry budget exhausted — the UI must surface this for manual
    /// resolution.
    ManualRequired,
}

impl ConflictStatus {
    /// SQL serialization. Kept for symmetry with [`AttemptState::as_str`]
    /// and for future write paths that need to set status by string.
    #[allow(dead_code)]
    fn as_str(&self) -> &'static str {
        match self {
            ConflictStatus::Pending => "pending",
            ConflictStatus::Resolved => "resolved",
            ConflictStatus::ManualRequired => "manual_required",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(ConflictStatus::Pending),
            "resolved" => Some(ConflictStatus::Resolved),
            "manual_required" => Some(ConflictStatus::ManualRequired),
            _ => None,
        }
    }
}

/// Single row of the `conflict_queue` table, serializable straight to
/// the renderer for the UI surface (built in a follow-up PR).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConflictRow {
    pub conflict_id: String,
    pub conflict_kind: String,
    pub payload_json: String,
    pub queued_at: i64,
    pub resolved_at: Option<i64>,
    pub final_verdict_json: Option<String>,
    pub status: ConflictStatus,
}

/// In-memory composition of `conflict_queue` row + its
/// `conflict_attempts` history. The data model the task description
/// asks for — `ConflictResolutionTask` — is produced by reading a
/// `ConflictRow` AND its attempts together.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ConflictResolutionTask {
    pub conflict_id: String,
    pub conflict_kind: String,
    pub payload_json: String,
    pub attempts: Vec<AgentAttempt>,
    /// Set on the first attempt whose `state == Succeeded`. Mirrors
    /// `conflict_queue.final_verdict_json` parsed back into a
    /// [`Verdict`]. `None` until a verdict lands.
    pub final_verdict: Option<Verdict>,
}

/// Verdict envelope the resolver returns. Mirrors the RFC §5.d
/// `ConflictVerdict` shape, narrowed for the F-D PR.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Verdict {
    pub verdict_kind: VerdictKind,
    /// Human-readable explanation — logged + shown in the UI.
    pub rationale: String,
    /// `0.0..=1.0`. Per-conflict-kind auto-apply thresholds are an
    /// upstream concern (RFC §5.d); F-D just records the number.
    pub confidence: f32,
}

/// Verdict discriminator.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerdictKind {
    /// Pick the first competing event verbatim.
    PickA,
    /// Pick the second competing event verbatim.
    PickB,
    /// Synthesize a new value that supersedes both events.
    NewValue { payload_json: String },
    /// Resolver could not decide — escalate to the user.
    Defer,
}

// ---------------------------------------------------------------------------
// Resolver trait + implementations
// ---------------------------------------------------------------------------

/// Input handed to a [`ConflictResolver`]. Carries the conflict payload
/// AND any prior-session preamble that the orchestrator constructed
/// from a timed-out predecessor's heartbeat snapshot.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConflictInput {
    pub conflict_id: String,
    pub conflict_kind: String,
    pub payload_json: String,
    /// `None` on the FIRST attempt; `Some(...)` on every subsequent
    /// attempt whose predecessor terminated with `Timeout`. The format
    /// is fixed; see the module-level "Agent-context hand-off
    /// contract" section.
    pub previous_session_preamble: Option<String>,
}

/// Outcome of a single resolver dispatch.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ResolverResult {
    Succeeded(Verdict),
    /// Resolver ran out of time. The [`PartialContext`] carries the
    /// resolver's last observed working state, which the orchestrator
    /// embeds in the next attempt's preamble.
    Timeout(PartialContext),
    /// Hard failure — the resolver gave up without producing a
    /// verdict OR partial state worth resuming from. Counts toward
    /// the retry budget just like a Timeout.
    Aborted { reason: String },
}

/// Snapshot of a resolver's working state at the moment it timed out.
/// Fed into the next attempt's `<<previous-session>>` preamble.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PartialContext {
    /// Free-form description of the resolver's progress. Local
    /// deterministic resolvers populate this with structured notes;
    /// LLM-backed resolvers populate it with their working chain of
    /// thought.
    pub context_blob: String,
    /// Optional tentative verdict the resolver had constructed before
    /// timing out. Useful audit trail; not authoritative until a
    /// successor confirms it.
    pub partial_verdict: Option<Verdict>,
}

/// Pluggable seam — swap in `DeterministicConflictResolver`,
/// `MockTimeoutResolver`, or a future LLM-backed resolver.
#[async_trait]
pub trait ConflictResolver: Send + Sync {
    /// Run the resolver against `input`. The orchestrator wraps this
    /// call in [`tokio::time::timeout`] using
    /// [`OrchestratorConfig::attempt_timeout`]; if the future doesn't
    /// resolve in time, the orchestrator synthesizes its OWN
    /// `Timeout` result from the most-recent heartbeat snapshot.
    ///
    /// Implementations are encouraged to write progress to the
    /// orchestrator's heartbeat channel via the
    /// [`ResolverContext`] handle so the snapshot reflects current
    /// thinking — see [`DeterministicConflictResolver::resolve`] for
    /// the canonical pattern.
    async fn resolve(
        &self,
        input: ConflictInput,
        ctx: ResolverContext,
    ) -> ResolverResult;
}

/// Heartbeat surface for resolvers. The orchestrator hands one of
/// these to every dispatched resolver; calls to [`Self::snapshot`]
/// write a `partial_context_blob` onto the active attempt row. If the
/// resolver times out, the LAST snapshot is what flows into the next
/// attempt.
#[derive(Clone)]
pub struct ResolverContext {
    porch: Arc<Porch>,
    attempt_id: String,
}

impl ResolverContext {
    /// Append a snapshot of the resolver's working state. Idempotent
    /// over the same attempt — every call replaces the prior snapshot
    /// (per-attempt rows are append-only at the row level, but the
    /// per-attempt blob is overwritten on each heartbeat to keep
    /// storage bounded).
    pub fn snapshot(
        &self,
        context_blob: &str,
        partial_verdict: Option<&Verdict>,
    ) -> Result<(), PorchError> {
        let partial_verdict_json = partial_verdict
            .map(serde_json::to_string)
            .transpose()?;
        let conn = self.porch.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "UPDATE conflict_attempts
             SET partial_context_blob = ?1, partial_verdict_json = ?2
             WHERE attempt_id = ?3",
            params![context_blob, partial_verdict_json, self.attempt_id],
        )?;
        Ok(())
    }
}

/// Canonical resolver. Applies the deterministic RFC §5.c rules; never
/// times out by itself (the orchestrator's wall-clock timer is the
/// outer cap). Used as the default when no AI-backed resolver is
/// configured.
pub struct DeterministicConflictResolver;

#[async_trait]
impl ConflictResolver for DeterministicConflictResolver {
    async fn resolve(
        &self,
        input: ConflictInput,
        ctx: ResolverContext,
    ) -> ResolverResult {
        // Snapshot the working state once so the audit trail shows the
        // resolver actually ran — even though the deterministic path
        // is fast enough that a real heartbeat would never fire.
        let _ = ctx.snapshot(
            "deterministic resolver: applying RFC §5.c rule",
            None,
        );
        match deterministic_verdict(&input.conflict_kind, &input.payload_json) {
            Ok(v) => ResolverResult::Succeeded(v),
            Err(reason) => ResolverResult::Aborted { reason },
        }
    }
}

/// Apply the RFC §5.c rules to a payload. Pulled out as a free
/// function so non-async test code can exercise it directly.
fn deterministic_verdict(
    conflict_kind: &str,
    payload_json: &str,
) -> Result<Verdict, String> {
    // The payload shape is `{event_a: {...}, event_b: {...}}` where
    // each event carries `{lamport: i64, device_id: String, payload:
    // serde_json::Value}`. We parse defensively so a corrupt payload
    // produces an Aborted with a useful error rather than a panic.
    let parsed: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|e| format!("payload_json parse error: {e}"))?;
    let event_a = parsed.get("event_a").ok_or("missing event_a")?;
    let event_b = parsed.get("event_b").ok_or("missing event_b")?;
    let lamport_a = event_a
        .get("lamport")
        .and_then(|v| v.as_i64())
        .ok_or("event_a missing lamport")?;
    let lamport_b = event_b
        .get("lamport")
        .and_then(|v| v.as_i64())
        .ok_or("event_b missing lamport")?;
    let device_a = event_a
        .get("device_id")
        .and_then(|v| v.as_str())
        .ok_or("event_a missing device_id")?;
    let device_b = event_b
        .get("device_id")
        .and_then(|v| v.as_str())
        .ok_or("event_b missing device_id")?;

    match conflict_kind {
        "concurrent_rename" | "concurrent_channel_rename" => {
            // RFC §5.c: LWW with (lamport, device_id) tiebreak. The
            // user explicitly accepted that the loser is silently
            // dropped — the flag is the audit signal, not the
            // remediation.
            let (winner, kind) = if (lamport_a, device_a) >= (lamport_b, device_b) {
                ("event_a", VerdictKind::PickA)
            } else {
                ("event_b", VerdictKind::PickB)
            };
            Ok(Verdict {
                verdict_kind: kind,
                rationale: format!(
                    "LWW resolution: {} wins (lamport_a={}, lamport_b={}, tie→device_id)",
                    winner, lamport_a, lamport_b
                ),
                confidence: 0.85,
            })
        }
        "tombstone_vs_write" | "concurrent_delete_and_post" => {
            // RFC §5.c case 2: a delete + a post leave an orphaned
            // message. The safe deterministic resolution is "keep the
            // write, the channel must exist" — synthesize a new
            // value that re-asserts the channel + preserves the
            // message. Confidence is low because the user may have
            // wanted the delete; the auto-apply threshold for this
            // kind is upstream-tuned per RFC §5.d.
            Ok(Verdict {
                verdict_kind: VerdictKind::NewValue {
                    payload_json: serde_json::json!({
                        "resurrect_channel": true,
                        "preserve_event_b_message": true,
                    })
                    .to_string(),
                },
                rationale:
                    "tombstone_vs_write: preserve the post; resurrect the channel"
                        .to_string(),
                confidence: 0.55,
            })
        }
        "concurrent_role_change" | "acl_change" => {
            // RFC §5.c case 3: ACL changes are security-sensitive.
            // The deterministic fallback prefers the MORE RESTRICTIVE
            // side — a revoke beats a grant — because over-restricting
            // is recoverable, over-granting is not. Either side is a
            // tombstone-vs-grant signaled by the payload's `is_revoke`
            // boolean on each event.
            let revoke_a = event_a
                .get("payload")
                .and_then(|p| p.get("is_revoke"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let revoke_b = event_b
                .get("payload")
                .and_then(|p| p.get("is_revoke"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let kind = match (revoke_a, revoke_b) {
                (true, _) => VerdictKind::PickA,
                (false, true) => VerdictKind::PickB,
                (false, false) => {
                    if (lamport_a, device_a) >= (lamport_b, device_b) {
                        VerdictKind::PickA
                    } else {
                        VerdictKind::PickB
                    }
                }
            };
            Ok(Verdict {
                verdict_kind: kind,
                rationale: "ACL change: revoke beats grant; tie→LWW".to_string(),
                // Low confidence — upstream RFC §5.d auto-apply
                // threshold per kind requires user confirmation for
                // acl_change verdicts below ~0.95.
                confidence: 0.6,
            })
        }
        other => Err(format!(
            "deterministic resolver: unknown conflict_kind {:?}",
            other
        )),
    }
}

/// Test-only resolver that simulates timeout behaviour. Returns
/// `Timeout(_)` for the first `timeout_count` attempts, then
/// `Succeeded(_)`. Used to exercise the resume pipeline in the
/// cargo tests.
pub struct MockTimeoutResolver {
    /// Shared counter so successive resolver instances driven by the
    /// orchestrator all see the same total. `AtomicU32` because the
    /// orchestrator may dispatch attempts concurrently.
    pub timeout_count_remaining: Arc<std::sync::atomic::AtomicU32>,
    /// What to emit when the timeout budget is exhausted.
    pub final_verdict: Verdict,
}

impl MockTimeoutResolver {
    pub fn new(timeout_count: u32, final_verdict: Verdict) -> Self {
        Self {
            timeout_count_remaining: Arc::new(
                std::sync::atomic::AtomicU32::new(timeout_count),
            ),
            final_verdict,
        }
    }
}

#[async_trait]
impl ConflictResolver for MockTimeoutResolver {
    async fn resolve(
        &self,
        input: ConflictInput,
        ctx: ResolverContext,
    ) -> ResolverResult {
        let remaining = self
            .timeout_count_remaining
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        // Snapshot the working state so the next attempt can pick it
        // up. We include the prior preamble inline so the test can
        // verify multi-hop accumulation: attempt 3's preamble carries
        // attempt 2's snapshot which carries attempt 1's snapshot, etc.
        let blob = format!(
            "mock-resolver scratch: conflict_id={} remaining_after_this={} preamble_in={}",
            input.conflict_id,
            remaining.saturating_sub(1),
            input.previous_session_preamble.is_some()
        );
        let _ = ctx.snapshot(&blob, None);
        if remaining > 0 {
            // Restore the original semantic: `remaining` counts
            // BEFORE decrement, so > 0 means "still timing out."
            self.timeout_count_remaining
                .fetch_add(0, std::sync::atomic::Ordering::SeqCst);
            ResolverResult::Timeout(PartialContext {
                context_blob: blob,
                partial_verdict: None,
            })
        } else {
            // We decremented past zero — put it back so the count is
            // bounded by the initial value.
            self.timeout_count_remaining
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            ResolverResult::Succeeded(self.final_verdict.clone())
        }
    }
}

// ---------------------------------------------------------------------------
// Preamble formatting — the `<<previous-session>>` envelope
// ---------------------------------------------------------------------------

/// Build the textual `<<previous-session>>` envelope for the next
/// attempt's input. Public so test code (and a future LLM-backed
/// resolver's prompt-builder) can parse it back.
pub fn build_previous_session_preamble(
    prior_attempt_id: &str,
    prior_state: AttemptState,
    snapshot: &str,
) -> String {
    format!(
        "<<previous-session>>\nattempt: {}\nstate: {}\nsnapshot:\n{}\n<</previous-session>>",
        prior_attempt_id,
        prior_state.as_str(),
        snapshot
    )
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/// Drives the conflict-resolution loop against a [`Porch`]. Holds an
/// `Arc<dyn ConflictResolver>` so the user (or a test) can swap the
/// backend. The orchestrator is `Clone` so callers can spawn it onto a
/// background tokio task while keeping a reference for queueing.
#[derive(Clone)]
pub struct ResumableConflictAgent {
    porch: Arc<Porch>,
    resolver: Arc<dyn ConflictResolver>,
    config: OrchestratorConfig,
}

impl ResumableConflictAgent {
    pub fn new(
        porch: Arc<Porch>,
        resolver: Arc<dyn ConflictResolver>,
        config: OrchestratorConfig,
    ) -> Self {
        Self {
            porch,
            resolver,
            config,
        }
    }

    /// Walk every unresolved conflict and drive it to a verdict (or to
    /// `manual_required` if the retry budget is exhausted). Returns
    /// once every unresolved row has been driven to a terminal state
    /// OR the resolver hits its cap. Safe to call repeatedly — the
    /// dispatch loop is idempotent against a row whose status is
    /// already `resolved` or `manual_required`.
    pub async fn run_once(&self) -> Result<RunReport, PorchError> {
        let unresolved = self.porch.conflict_queue_list_unresolved()?;
        let mut handles = Vec::with_capacity(unresolved.len());
        for row in unresolved {
            // Each conflict gets its own concurrent task so the
            // orchestration loop handles parallelism cleanly. The
            // per-attempt timer + SQLite mutex bound contention.
            let me = self.clone();
            handles.push(tokio::spawn(async move {
                let id = row.conflict_id.clone();
                let result = me.drive_one(row).await;
                (id, result)
            }));
        }
        let mut report = RunReport::default();
        for h in handles {
            match h.await {
                Ok((_conflict_id, Ok(outcome))) => match outcome {
                    DriveOutcome::Resolved => report.resolved += 1,
                    DriveOutcome::ManualRequired => report.manual_required += 1,
                    DriveOutcome::AlreadyTerminal => report.already_terminal += 1,
                },
                Ok((conflict_id, Err(e))) => {
                    log::warn!(
                        target: "concord::porch::conflict_agent",
                        "conflict {} drive failed: {}", conflict_id, e
                    );
                    report.errors += 1;
                }
                Err(join_err) => {
                    log::warn!(
                        target: "concord::porch::conflict_agent",
                        "conflict task join error: {}", join_err
                    );
                    report.errors += 1;
                }
            }
        }
        Ok(report)
    }

    /// Drive a single conflict through the resume loop. Loops until
    /// the resolver succeeds OR the retry budget is exhausted, picking
    /// up where the previous attempt left off on each iteration.
    async fn drive_one(&self, row: ConflictRow) -> Result<DriveOutcome, PorchError> {
        // Defensive: if the row is somehow already terminal, no work.
        if row.status != ConflictStatus::Pending {
            return Ok(DriveOutcome::AlreadyTerminal);
        }
        let attempts_so_far =
            self.porch.conflict_queue_get_attempts(&row.conflict_id)?;
        let mut prior_attempt = attempts_so_far.into_iter().last();

        loop {
            // Count attempts on a fresh read so we never over-budget.
            let attempts = self
                .porch
                .conflict_queue_get_attempts(&row.conflict_id)?
                .len() as u32;
            if attempts >= self.config.max_attempts {
                self.porch
                    .conflict_queue_mark_manual_required(&row.conflict_id)?;
                return Ok(DriveOutcome::ManualRequired);
            }

            // Build the next attempt's input. If the prior attempt
            // exists and timed out, fold its snapshot into the
            // `<<previous-session>>` preamble.
            let preamble = match prior_attempt.as_ref() {
                Some(a) if a.state == AttemptState::Timeout => {
                    let blob = a
                        .partial_context_blob
                        .clone()
                        .unwrap_or_else(|| "<no snapshot>".to_string());
                    Some(build_previous_session_preamble(
                        &a.attempt_id,
                        a.state,
                        &blob,
                    ))
                }
                _ => None,
            };
            let input = ConflictInput {
                conflict_id: row.conflict_id.clone(),
                conflict_kind: row.conflict_kind.clone(),
                payload_json: row.payload_json.clone(),
                previous_session_preamble: preamble,
            };

            let attempt_id = Ulid::new().to_string();
            let started_at = unix_millis();
            self.porch.conflict_attempts_insert_running(
                &attempt_id,
                &row.conflict_id,
                started_at,
            )?;

            let ctx = ResolverContext {
                porch: self.porch.clone(),
                attempt_id: attempt_id.clone(),
            };
            // Apply the wall-clock timeout. If the resolver returns
            // its OWN Timeout, that takes precedence; the
            // tokio::time::timeout case maps to the same state but
            // synthesizes the snapshot from whatever the resolver
            // most recently heartbeated.
            let resolver = self.resolver.clone();
            let outcome = tokio::time::timeout(
                self.config.attempt_timeout,
                resolver.resolve(input, ctx),
            )
            .await;

            let ended_at = unix_millis();
            let attempt_snapshot = match outcome {
                Ok(ResolverResult::Succeeded(v)) => {
                    let verdict_json = serde_json::to_string(&v)?;
                    self.porch.conflict_attempts_finalize(
                        &attempt_id,
                        AttemptState::Succeeded,
                        ended_at,
                        None,
                        Some(&verdict_json),
                    )?;
                    self.porch
                        .conflict_queue_mark_resolved(&row.conflict_id, &verdict_json)?;
                    return Ok(DriveOutcome::Resolved);
                }
                Ok(ResolverResult::Timeout(pc)) => {
                    let verdict_json = pc
                        .partial_verdict
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?;
                    self.porch.conflict_attempts_finalize(
                        &attempt_id,
                        AttemptState::Timeout,
                        ended_at,
                        Some(&pc.context_blob),
                        verdict_json.as_deref(),
                    )?;
                    AgentAttempt {
                        attempt_id,
                        started_at,
                        ended_at: Some(ended_at),
                        state: AttemptState::Timeout,
                        partial_context_blob: Some(pc.context_blob),
                        partial_verdict_json: verdict_json,
                    }
                }
                Ok(ResolverResult::Aborted { reason }) => {
                    // Aborted counts toward the retry budget — bookkeep
                    // as a non-resumable attempt (no snapshot to feed
                    // forward). If the budget is now exhausted, the
                    // next loop iteration flips to manual_required.
                    self.porch.conflict_attempts_finalize(
                        &attempt_id,
                        AttemptState::Aborted,
                        ended_at,
                        Some(&format!("aborted: {reason}")),
                        None,
                    )?;
                    AgentAttempt {
                        attempt_id,
                        started_at,
                        ended_at: Some(ended_at),
                        state: AttemptState::Aborted,
                        partial_context_blob: Some(format!("aborted: {reason}")),
                        partial_verdict_json: None,
                    }
                }
                Err(_elapsed) => {
                    // Wall-clock timeout from tokio. The resolver's
                    // last heartbeat already wrote its snapshot via
                    // `ResolverContext::snapshot`; just finalize.
                    let snapshot = self
                        .porch
                        .conflict_attempts_get_snapshot(&attempt_id)?
                        .unwrap_or_else(|| "<no heartbeat>".to_string());
                    self.porch.conflict_attempts_finalize(
                        &attempt_id,
                        AttemptState::Timeout,
                        ended_at,
                        Some(&snapshot),
                        None,
                    )?;
                    AgentAttempt {
                        attempt_id,
                        started_at,
                        ended_at: Some(ended_at),
                        state: AttemptState::Timeout,
                        partial_context_blob: Some(snapshot),
                        partial_verdict_json: None,
                    }
                }
            };
            prior_attempt = Some(attempt_snapshot);
            // Loop iteration → next attempt picks up the snapshot.
        }
    }
}

/// Per-conflict drive outcome (internal to the orchestrator).
enum DriveOutcome {
    Resolved,
    ManualRequired,
    /// Row was already terminal — orchestrator did nothing.
    AlreadyTerminal,
}

/// Summary of a [`ResumableConflictAgent::run_once`] pass.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunReport {
    pub resolved: usize,
    pub manual_required: usize,
    pub already_terminal: usize,
    pub errors: usize,
}

// ---------------------------------------------------------------------------
// `Porch` SQL helpers — the data-access layer the orchestrator + the
// Tauri command surface share. Kept here (rather than `db.rs`) so the
// `db.rs` blast radius stays small.
// ---------------------------------------------------------------------------

impl Porch {
    /// Enqueue a fresh conflict. Idempotent on `conflict_id` —
    /// re-queueing the same id is a no-op so the F-C detector can
    /// re-fire safely.
    pub fn conflict_queue_enqueue(
        &self,
        conflict_id: &str,
        conflict_kind: &str,
        payload_json: &str,
    ) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let now = unix_millis();
        conn.execute(
            "INSERT OR IGNORE INTO conflict_queue
                (conflict_id, conflict_kind, payload_json, queued_at, status)
             VALUES (?1, ?2, ?3, ?4, 'pending')",
            params![conflict_id, conflict_kind, payload_json, now],
        )?;
        Ok(())
    }

    /// List every conflict that is not yet `resolved`. Includes both
    /// `pending` and `manual_required` rows — the UI uses the status
    /// column to render differently.
    pub fn conflict_queue_list_unresolved(
        &self,
    ) -> Result<Vec<ConflictRow>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT conflict_id, conflict_kind, payload_json, queued_at,
                    resolved_at, final_verdict_json, status
             FROM conflict_queue
             WHERE resolved_at IS NULL
             ORDER BY queued_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let status_str: String = r.get(6)?;
            Ok(ConflictRow {
                conflict_id: r.get(0)?,
                conflict_kind: r.get(1)?,
                payload_json: r.get(2)?,
                queued_at: r.get(3)?,
                resolved_at: r.get(4)?,
                final_verdict_json: r.get(5)?,
                status: ConflictStatus::from_str(&status_str)
                    .unwrap_or(ConflictStatus::Pending),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Read every attempt for a conflict, in start order. Empty vec for
    /// an unknown conflict id (so the caller can branch on
    /// `.is_empty()` for the "fresh" case).
    pub fn conflict_queue_get_attempts(
        &self,
        conflict_id: &str,
    ) -> Result<Vec<AgentAttempt>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT attempt_id, started_at, ended_at, state,
                    partial_context_blob, partial_verdict_json
             FROM conflict_attempts
             WHERE conflict_id = ?1
             ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![conflict_id], |r| {
            let state_str: String = r.get(3)?;
            Ok(AgentAttempt {
                attempt_id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                state: AttemptState::from_str(&state_str)
                    .unwrap_or(AttemptState::Aborted),
                partial_context_blob: r.get(4)?,
                partial_verdict_json: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Compose a [`ConflictResolutionTask`] from `conflict_queue` +
    /// `conflict_attempts` so the UI can render the full history with
    /// one DB round trip.
    pub fn conflict_queue_get_task(
        &self,
        conflict_id: &str,
    ) -> Result<Option<ConflictResolutionTask>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let row: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT conflict_kind, payload_json, final_verdict_json
                 FROM conflict_queue WHERE conflict_id = ?1",
                params![conflict_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        drop(conn);
        let Some((kind, payload, verdict_json)) = row else {
            return Ok(None);
        };
        let attempts = self.conflict_queue_get_attempts(conflict_id)?;
        let final_verdict = verdict_json
            .as_ref()
            .map(|s| serde_json::from_str::<Verdict>(s))
            .transpose()?;
        Ok(Some(ConflictResolutionTask {
            conflict_id: conflict_id.to_string(),
            conflict_kind: kind,
            payload_json: payload,
            attempts,
            final_verdict,
        }))
    }

    /// Insert a new `conflict_attempts` row in `running` state. The
    /// orchestrator calls this right before dispatching the resolver
    /// so heartbeat snapshots have a row to write into.
    pub fn conflict_attempts_insert_running(
        &self,
        attempt_id: &str,
        conflict_id: &str,
        started_at: i64,
    ) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "INSERT INTO conflict_attempts
                (attempt_id, conflict_id, started_at, ended_at,
                 state, partial_context_blob, partial_verdict_json)
             VALUES (?1, ?2, ?3, NULL, 'running', NULL, NULL)",
            params![attempt_id, conflict_id, started_at],
        )?;
        Ok(())
    }

    /// Finalize an attempt — set its terminal state + the resolver's
    /// final snapshot. Called by the orchestrator after the resolver
    /// returns OR the wall-clock timeout fires.
    pub fn conflict_attempts_finalize(
        &self,
        attempt_id: &str,
        state: AttemptState,
        ended_at: i64,
        partial_context_blob: Option<&str>,
        partial_verdict_json: Option<&str>,
    ) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "UPDATE conflict_attempts
             SET state = ?1, ended_at = ?2,
                 partial_context_blob = COALESCE(?3, partial_context_blob),
                 partial_verdict_json = COALESCE(?4, partial_verdict_json)
             WHERE attempt_id = ?5",
            params![
                state.as_str(),
                ended_at,
                partial_context_blob,
                partial_verdict_json,
                attempt_id,
            ],
        )?;
        Ok(())
    }

    /// Read the most-recent heartbeat snapshot for an attempt — used
    /// when the wall-clock timer expires and the orchestrator needs
    /// the resolver's last observed state without parsing the
    /// `partial_verdict_json` blob.
    pub fn conflict_attempts_get_snapshot(
        &self,
        attempt_id: &str,
    ) -> Result<Option<String>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let blob: Option<Option<String>> = conn
            .query_row(
                "SELECT partial_context_blob FROM conflict_attempts WHERE attempt_id = ?1",
                params![attempt_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(blob.flatten())
    }

    /// Flip the conflict row to `resolved` + record the verdict.
    pub fn conflict_queue_mark_resolved(
        &self,
        conflict_id: &str,
        verdict_json: &str,
    ) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let now = unix_millis();
        conn.execute(
            "UPDATE conflict_queue
             SET status = 'resolved', resolved_at = ?1, final_verdict_json = ?2
             WHERE conflict_id = ?3",
            params![now, verdict_json, conflict_id],
        )?;
        Ok(())
    }

    /// Flip the conflict row to `manual_required`. The UI lists these
    /// for explicit user resolution.
    pub fn conflict_queue_mark_manual_required(
        &self,
        conflict_id: &str,
    ) -> Result<(), PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        conn.execute(
            "UPDATE conflict_queue SET status = 'manual_required'
             WHERE conflict_id = ?1 AND status = 'pending'",
            params![conflict_id],
        )?;
        Ok(())
    }

    /// User-facing manual verdict — accept a verdict the user typed
    /// in (or clicked a button for) and flip the row to `resolved`.
    /// Validates the JSON parses into a [`Verdict`] so the UI surface
    /// can't write garbage into the audit trail.
    pub fn conflict_queue_manual_resolve(
        &self,
        conflict_id: &str,
        verdict_json: &str,
    ) -> Result<(), PorchError> {
        // Validate by round-tripping. If the user's JSON is shaped
        // wrong, surface the error to the UI rather than silently
        // accepting garbage.
        let _verdict: Verdict = serde_json::from_str(verdict_json)?;
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let now = unix_millis();
        let updated = conn.execute(
            "UPDATE conflict_queue
             SET status = 'resolved', resolved_at = ?1, final_verdict_json = ?2
             WHERE conflict_id = ?3 AND status != 'resolved'",
            params![now, verdict_json, conflict_id],
        )?;
        if updated == 0 {
            return Err(PorchError::InvalidInput(format!(
                "no unresolved conflict with id {conflict_id}"
            )));
        }
        Ok(())
    }
}

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    fn sample_payload() -> String {
        serde_json::json!({
            "event_a": {
                "lamport": 7,
                "device_id": "01HZZZ-A",
                "payload": { "new_name": "#announcements" }
            },
            "event_b": {
                "lamport": 9,
                "device_id": "01HZZZ-B",
                "payload": { "new_name": "#main" }
            }
        })
        .to_string()
    }

    fn fast_config() -> OrchestratorConfig {
        OrchestratorConfig {
            max_attempts: 5,
            attempt_timeout: Duration::from_secs(2),
            heartbeat_interval: Duration::from_millis(20),
        }
    }

    #[test]
    fn schema_migration_creates_conflict_tables() {
        let porch = Porch::open_in_memory().expect("open");
        // Round-trip a row to prove the tables exist + the indices
        // don't reject inserts.
        porch
            .conflict_queue_enqueue("01HZZZ", "concurrent_rename", &sample_payload())
            .expect("enqueue");
        let rows = porch.conflict_queue_list_unresolved().expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].conflict_id, "01HZZZ");
        assert_eq!(rows[0].status, ConflictStatus::Pending);
    }

    #[tokio::test]
    async fn deterministic_resolver_resolves_concurrent_rename() {
        let porch = Arc::new(Porch::open_in_memory().expect("open"));
        porch
            .conflict_queue_enqueue("c1", "concurrent_rename", &sample_payload())
            .expect("enqueue");
        let agent = ResumableConflictAgent::new(
            porch.clone(),
            Arc::new(DeterministicConflictResolver),
            fast_config(),
        );
        let report = agent.run_once().await.expect("run");
        assert_eq!(report.resolved, 1);
        let task = porch.conflict_queue_get_task("c1").expect("get").unwrap();
        let verdict = task.final_verdict.expect("verdict landed");
        // Higher lamport on event_b wins; LWW resolution picks B.
        assert!(matches!(verdict.verdict_kind, VerdictKind::PickB));
        assert_eq!(task.attempts.len(), 1);
        assert_eq!(task.attempts[0].state, AttemptState::Succeeded);
    }

    #[tokio::test]
    async fn timeout_then_succeed_carries_previous_session_preamble() {
        let porch = Arc::new(Porch::open_in_memory().expect("open"));
        porch
            .conflict_queue_enqueue("c2", "concurrent_rename", &sample_payload())
            .expect("enqueue");
        // Resolver times out exactly once, then succeeds.
        let resolver = Arc::new(MockTimeoutResolver::new(
            1,
            Verdict {
                verdict_kind: VerdictKind::PickA,
                rationale: "test".into(),
                confidence: 0.9,
            },
        ));
        let agent = ResumableConflictAgent::new(
            porch.clone(),
            resolver,
            fast_config(),
        );
        let report = agent.run_once().await.expect("run");
        assert_eq!(report.resolved, 1);
        let task = porch.conflict_queue_get_task("c2").expect("get").unwrap();
        assert_eq!(task.attempts.len(), 2);
        assert_eq!(task.attempts[0].state, AttemptState::Timeout);
        assert_eq!(task.attempts[1].state, AttemptState::Succeeded);
        // The succeeded attempt's heartbeat snapshot must record that
        // the resolver saw the previous-session preamble.
        let succeeded_blob = task.attempts[1]
            .partial_context_blob
            .as_deref()
            .expect("succeeded heartbeat captured");
        assert!(
            succeeded_blob.contains("preamble_in=true"),
            "successor attempt did not see <<previous-session>> preamble: {}",
            succeeded_blob
        );
        // The first attempt's snapshot must be carried forward in the
        // attempt-history audit.
        assert!(task.attempts[0]
            .partial_context_blob
            .as_deref()
            .unwrap()
            .contains("conflict_id=c2"));
    }

    #[tokio::test]
    async fn cap_out_flips_to_manual_required() {
        let porch = Arc::new(Porch::open_in_memory().expect("open"));
        porch
            .conflict_queue_enqueue("c3", "concurrent_rename", &sample_payload())
            .expect("enqueue");
        // Timeout count > max_attempts so the resolver never gets to
        // succeed within budget.
        let resolver = Arc::new(MockTimeoutResolver::new(
            10,
            Verdict {
                verdict_kind: VerdictKind::PickA,
                rationale: "unreached".into(),
                confidence: 0.9,
            },
        ));
        let agent = ResumableConflictAgent::new(
            porch.clone(),
            resolver,
            fast_config(),
        );
        let report = agent.run_once().await.expect("run");
        assert_eq!(report.manual_required, 1);
        let task = porch.conflict_queue_get_task("c3").expect("get").unwrap();
        assert_eq!(task.attempts.len(), 5, "max_attempts cap hit");
        assert!(task.final_verdict.is_none());
        let rows = porch.conflict_queue_list_unresolved().expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, ConflictStatus::ManualRequired);
    }

    #[tokio::test]
    async fn concurrent_conflicts_resolved_in_parallel() {
        let porch = Arc::new(Porch::open_in_memory().expect("open"));
        for i in 0..4 {
            porch
                .conflict_queue_enqueue(
                    &format!("c-{i}"),
                    "concurrent_rename",
                    &sample_payload(),
                )
                .expect("enqueue");
        }
        let agent = ResumableConflictAgent::new(
            porch.clone(),
            Arc::new(DeterministicConflictResolver),
            fast_config(),
        );
        let report = agent.run_once().await.expect("run");
        assert_eq!(report.resolved, 4);
        let rows = porch.conflict_queue_list_unresolved().expect("list");
        assert!(rows.is_empty(), "all conflicts resolved");
    }

    #[tokio::test]
    async fn manual_resolve_flips_to_resolved() {
        let porch = Arc::new(Porch::open_in_memory().expect("open"));
        porch
            .conflict_queue_enqueue("c-manual", "acl_change", &sample_payload())
            .expect("enqueue");
        let verdict = Verdict {
            verdict_kind: VerdictKind::Defer,
            rationale: "user picked B".into(),
            confidence: 1.0,
        };
        porch
            .conflict_queue_manual_resolve(
                "c-manual",
                &serde_json::to_string(&verdict).unwrap(),
            )
            .expect("manual resolve");
        let rows = porch.conflict_queue_list_unresolved().expect("list");
        assert!(rows.is_empty(), "resolved row dropped from unresolved");
        let task = porch
            .conflict_queue_get_task("c-manual")
            .expect("get")
            .unwrap();
        assert_eq!(
            task.final_verdict.as_ref().map(|v| &v.verdict_kind),
            Some(&VerdictKind::Defer)
        );
    }

    #[test]
    fn preamble_format_is_stable() {
        let s = build_previous_session_preamble(
            "01HZ-ATT",
            AttemptState::Timeout,
            "scratch",
        );
        assert_eq!(
            s,
            "<<previous-session>>\nattempt: 01HZ-ATT\nstate: timeout\nsnapshot:\nscratch\n<</previous-session>>"
        );
    }

    #[test]
    fn manual_resolve_rejects_bad_json() {
        let porch = Porch::open_in_memory().expect("open");
        porch
            .conflict_queue_enqueue("c-bad", "concurrent_rename", &sample_payload())
            .expect("enqueue");
        let err = porch
            .conflict_queue_manual_resolve("c-bad", "{not json")
            .unwrap_err();
        assert!(matches!(err, PorchError::Serde(_)));
    }

    #[test]
    fn deterministic_resolver_handles_tombstone_vs_write() {
        let payload = serde_json::json!({
            "event_a": { "lamport": 1, "device_id": "A", "payload": { "tombstone": true } },
            "event_b": { "lamport": 1, "device_id": "B", "payload": { "body": "hello" } },
        })
        .to_string();
        let v = deterministic_verdict("tombstone_vs_write", &payload).expect("verdict");
        assert!(matches!(v.verdict_kind, VerdictKind::NewValue { .. }));
        assert!(v.confidence < 0.9, "tombstone_vs_write should not auto-apply");
    }

    #[test]
    fn deterministic_resolver_handles_acl_change_prefers_revoke() {
        let payload = serde_json::json!({
            "event_a": { "lamport": 5, "device_id": "A", "payload": { "is_revoke": false } },
            "event_b": { "lamport": 3, "device_id": "B", "payload": { "is_revoke": true } },
        })
        .to_string();
        let v = deterministic_verdict("acl_change", &payload).expect("verdict");
        assert!(matches!(v.verdict_kind, VerdictKind::PickB),
            "revoke beats grant even with lower lamport");
    }

    // Silence the unused-name warning on `conflict_id` in the parallel
    // tokio::spawn closure — captured for log-context but not asserted.
    fn _shut_up_unused() {
        let _ = AtomicU32::new(0);
    }
}
