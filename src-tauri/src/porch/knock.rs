//! Porch Phase B — knock-to-enter request lifecycle for inner channels
//! gated by `acl_mode = 'allowlist'` (or `'owner_only'`).
//!
//! Lifecycle:
//!
//! 1. A visitor without an ACL row dials the host and sends
//!    `PorchRequest::Knock { channel_id, message }`. The host records a
//!    row in `channel_knocks` with `status = 'pending'`.
//! 2. The host's UI polls `Porch::pending_knocks` and surfaces each
//!    knock as a row with Accept / Reject buttons.
//! 3. On accept: the row's `status` flips to `accepted` AND a `member`
//!    ACL grant is inserted in the same SQL transaction. The visitor
//!    can see the channel via `ListChannels` on their next poll.
//! 4. On reject: the row's `status` flips to `rejected`. No ACL change.
//!    The visitor can re-knock later.
//! 5. A visitor can `withdraw` their own pending knock — only the
//!    original knocker is allowed to do this.
//!
//! Concurrency: a partial unique index in the schema (`status = 'pending'`)
//! enforces "at most one open knock per (channel, knocker)". Re-knocking
//! while a pending row exists is a no-op at the application layer
//! ([`Porch::knock`] returns the existing row instead of erroring on
//! the unique index).

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use super::channel::AclRole;
use super::db::{unix_millis, Porch};
use super::error::PorchError;

/// Current status of a knock row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnockStatus {
    /// Visitor is waiting on the owner to accept or reject.
    Pending,
    /// Owner accepted; the visitor was granted `member` on the channel.
    Accepted,
    /// Owner rejected. The visitor can re-knock later.
    Rejected,
    /// Visitor withdrew the knock before it was resolved.
    Withdrawn,
}

impl KnockStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            KnockStatus::Pending => "pending",
            KnockStatus::Accepted => "accepted",
            KnockStatus::Rejected => "rejected",
            KnockStatus::Withdrawn => "withdrawn",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(KnockStatus::Pending),
            "accepted" => Some(KnockStatus::Accepted),
            "rejected" => Some(KnockStatus::Rejected),
            "withdrawn" => Some(KnockStatus::Withdrawn),
            _ => None,
        }
    }
}

/// A single knock row. Returned by every knock-management call so
/// callers don't need a follow-up SELECT to learn the resulting state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Knock {
    pub id: String,
    pub channel_id: String,
    pub knocker_peer_id: String,
    pub message: Option<String>,
    pub status: KnockStatus,
    pub created_at: i64,
    /// `unix_millis` at the time the knock was resolved
    /// (accepted/rejected/withdrawn). `None` while pending.
    pub resolved_at: Option<i64>,
}

/// Maximum size of the optional `message` body on a knock. Knocks are
/// cheap one-liners ("let me into the campaign room"); keep them tight
/// to discourage abuse + bound the envelope size.
pub const MAX_KNOCK_MESSAGE_BYTES: usize = 1024;

impl Porch {
    /// Visitor-side: record a knock. Returns the [`Knock`]; calling this
    /// twice for the same `(channel_id, knocker_peer_id)` while the
    /// previous knock is still `Pending` returns the EXISTING knock
    /// instead of inserting a duplicate (the partial unique index would
    /// otherwise error). After accept/reject/withdraw a fresh knock can
    /// be filed.
    pub fn knock(
        &self,
        channel_id: &str,
        knocker_peer_id: &str,
        message: Option<&str>,
    ) -> Result<Knock, PorchError> {
        // Channel-existence check up front so the wire layer can return
        // 404 instead of a generic 500 on a bogus channel id.
        if self.get_channel(channel_id)?.is_none() {
            return Err(PorchError::ChannelNotFound {
                channel_id: channel_id.to_string(),
            });
        }
        if let Some(msg) = message {
            if msg.len() > MAX_KNOCK_MESSAGE_BYTES {
                return Err(PorchError::InvalidInput(format!(
                    "knock message too large: {} > {}",
                    msg.len(),
                    MAX_KNOCK_MESSAGE_BYTES
                )));
            }
        }
        let conn = self.conn.lock().expect("porch conn mutex poisoned");

        // Dedup against an existing pending knock for this (channel, peer).
        if let Some(existing) = lookup_knock_pending(&conn, channel_id, knocker_peer_id)? {
            return Ok(existing);
        }

        let id = Ulid::new().to_string();
        let now = unix_millis();
        conn.execute(
            "INSERT INTO channel_knocks
                (id, channel_id, knocker_peer_id, message, status, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5, NULL)",
            params![id, channel_id, knocker_peer_id, message, now],
        )?;
        Ok(Knock {
            id,
            channel_id: channel_id.to_string(),
            knocker_peer_id: knocker_peer_id.to_string(),
            message: message.map(|s| s.to_string()),
            status: KnockStatus::Pending,
            created_at: now,
            resolved_at: None,
        })
    }

    /// Owner-side: list every pending knock across all of the user's
    /// channels. Ordered by `created_at` ASC so the UI surfaces the
    /// oldest waiting visitor first.
    pub fn pending_knocks(&self) -> Result<Vec<Knock>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, knocker_peer_id, message, status, created_at, resolved_at
             FROM channel_knocks
             WHERE status = 'pending'
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], row_to_knock)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Owner-side: accept a knock. Atomically flips `status` to
    /// `accepted` AND inserts a `member` ACL row for the knocker on the
    /// channel. Returns the updated knock.
    ///
    /// If the knock is not in `Pending` state, returns
    /// `PorchError::InvalidInput` — accepting an already-resolved knock
    /// is a no-op that would mask a UI race condition.
    pub fn accept_knock(&self, knock_id: &str) -> Result<Knock, PorchError> {
        let mut conn_guard = self.conn.lock().expect("porch conn mutex poisoned");
        let tx = conn_guard.transaction()?;

        let knock = match lookup_knock_by_id(&tx, knock_id)? {
            Some(k) => k,
            None => {
                return Err(PorchError::InvalidInput(format!(
                    "knock not found: {knock_id}"
                )));
            }
        };
        if knock.status != KnockStatus::Pending {
            return Err(PorchError::InvalidInput(format!(
                "knock {knock_id} is not pending (status={})",
                knock.status.as_str()
            )));
        }
        let now = unix_millis();
        tx.execute(
            "UPDATE channel_knocks
                SET status = 'accepted', resolved_at = ?1
                WHERE id = ?2",
            params![now, knock_id],
        )?;
        // Insert (or upgrade) the ACL row. Same ON CONFLICT shape as
        // `grant_acl`, kept inline so the whole accept fires in one
        // transaction (no Phase-A vs Phase-B locking race).
        tx.execute(
            "INSERT INTO channel_acl (channel_id, peer_id, role, granted_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(channel_id, peer_id) DO UPDATE SET
                    role = excluded.role,
                    granted_at = excluded.granted_at",
            params![
                knock.channel_id,
                knock.knocker_peer_id,
                AclRole::Member.as_str(),
                now
            ],
        )?;
        tx.commit()?;
        Ok(Knock {
            status: KnockStatus::Accepted,
            resolved_at: Some(now),
            ..knock
        })
    }

    /// Owner-side: reject a knock. Status -> `Rejected`. No ACL change.
    /// The visitor can re-knock later.
    pub fn reject_knock(&self, knock_id: &str) -> Result<Knock, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let knock = match lookup_knock_by_id(&conn, knock_id)? {
            Some(k) => k,
            None => {
                return Err(PorchError::InvalidInput(format!(
                    "knock not found: {knock_id}"
                )));
            }
        };
        if knock.status != KnockStatus::Pending {
            return Err(PorchError::InvalidInput(format!(
                "knock {knock_id} is not pending (status={})",
                knock.status.as_str()
            )));
        }
        let now = unix_millis();
        conn.execute(
            "UPDATE channel_knocks
                SET status = 'rejected', resolved_at = ?1
                WHERE id = ?2",
            params![now, knock_id],
        )?;
        Ok(Knock {
            status: KnockStatus::Rejected,
            resolved_at: Some(now),
            ..knock
        })
    }

    /// Visitor-side: withdraw a knock that hasn't been resolved yet.
    /// Only the original `knocker_peer_id` is allowed to withdraw —
    /// other callers get `PorchError::AccessDenied`.
    pub fn withdraw_knock(
        &self,
        knock_id: &str,
        knocker_peer_id: &str,
    ) -> Result<Knock, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        let knock = match lookup_knock_by_id(&conn, knock_id)? {
            Some(k) => k,
            None => {
                return Err(PorchError::InvalidInput(format!(
                    "knock not found: {knock_id}"
                )));
            }
        };
        if knock.knocker_peer_id != knocker_peer_id {
            return Err(PorchError::AccessDenied {
                channel_id: knock.channel_id.clone(),
            });
        }
        if knock.status != KnockStatus::Pending {
            return Err(PorchError::InvalidInput(format!(
                "knock {knock_id} is not pending (status={})",
                knock.status.as_str()
            )));
        }
        let now = unix_millis();
        conn.execute(
            "UPDATE channel_knocks
                SET status = 'withdrawn', resolved_at = ?1
                WHERE id = ?2",
            params![now, knock_id],
        )?;
        Ok(Knock {
            status: KnockStatus::Withdrawn,
            resolved_at: Some(now),
            ..knock
        })
    }

    /// Visitor-side: status check for a single (channel, knocker)
    /// pair. Returns the most-recent matching knock — pending if one
    /// exists, otherwise the latest resolved one (so the visitor UI
    /// can show "Pending" / "Accepted (refresh)" / "Rejected" /
    /// "Withdrawn"). `None` means the visitor has never knocked.
    pub fn knock_status_for(
        &self,
        channel_id: &str,
        knocker_peer_id: &str,
    ) -> Result<Option<Knock>, PorchError> {
        let conn = self.conn.lock().expect("porch conn mutex poisoned");
        // Prefer pending if there is one (there can be at most one due
        // to the partial unique index). Otherwise fall back to the most
        // recent resolved row.
        if let Some(pending) = lookup_knock_pending(&conn, channel_id, knocker_peer_id)? {
            return Ok(Some(pending));
        }
        let row = conn
            .query_row(
                "SELECT id, channel_id, knocker_peer_id, message, status, created_at, resolved_at
                 FROM channel_knocks
                 WHERE channel_id = ?1 AND knocker_peer_id = ?2
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1",
                params![channel_id, knocker_peer_id],
                row_to_knock,
            )
            .optional()?;
        Ok(row)
    }
}

fn lookup_knock_pending(
    conn: &rusqlite::Connection,
    channel_id: &str,
    knocker_peer_id: &str,
) -> Result<Option<Knock>, PorchError> {
    let row = conn
        .query_row(
            "SELECT id, channel_id, knocker_peer_id, message, status, created_at, resolved_at
             FROM channel_knocks
             WHERE channel_id = ?1 AND knocker_peer_id = ?2 AND status = 'pending'",
            params![channel_id, knocker_peer_id],
            row_to_knock,
        )
        .optional()?;
    Ok(row)
}

fn lookup_knock_by_id(
    conn: &rusqlite::Connection,
    knock_id: &str,
) -> Result<Option<Knock>, PorchError> {
    let row = conn
        .query_row(
            "SELECT id, channel_id, knocker_peer_id, message, status, created_at, resolved_at
             FROM channel_knocks
             WHERE id = ?1",
            params![knock_id],
            row_to_knock,
        )
        .optional()?;
    Ok(row)
}

fn row_to_knock(r: &rusqlite::Row<'_>) -> rusqlite::Result<Knock> {
    let status: String = r.get(4)?;
    Ok(Knock {
        id: r.get(0)?,
        channel_id: r.get(1)?,
        knocker_peer_id: r.get(2)?,
        message: r.get(3)?,
        // CHECK constraint guarantees a valid variant; the unwrap_or
        // is a future-compat guard against an unknown status string.
        status: KnockStatus::from_str(&status).unwrap_or(KnockStatus::Pending),
        created_at: r.get(5)?,
        resolved_at: r.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::porch::channel::{AclMode, ChannelKind};

    fn inner_porch() -> Porch {
        let porch = Porch::open_in_memory().expect("open ok");
        porch
            .insert_channel("inner-1", "Inner", ChannelKind::Inner, AclMode::Allowlist)
            .expect("insert ok");
        porch
    }

    #[test]
    fn knock_then_status_for_visitor_returns_pending() {
        let porch = inner_porch();
        let k = porch
            .knock("inner-1", "12D3Visitor", Some("let me in"))
            .expect("knock ok");
        assert_eq!(k.status, KnockStatus::Pending);
        assert_eq!(k.message.as_deref(), Some("let me in"));
        assert!(k.resolved_at.is_none());

        let looked_up = porch
            .knock_status_for("inner-1", "12D3Visitor")
            .expect("status ok")
            .expect("must have a row");
        assert_eq!(looked_up.id, k.id);
        assert_eq!(looked_up.status, KnockStatus::Pending);
    }

    #[test]
    fn knock_dedupes_on_existing_pending() {
        let porch = inner_porch();
        let k1 = porch.knock("inner-1", "12D3V", None).expect("knock 1 ok");
        let k2 = porch
            .knock("inner-1", "12D3V", Some("retry"))
            .expect("knock 2 ok");
        assert_eq!(
            k1.id, k2.id,
            "second knock while pending must return the existing row"
        );
        let pending = porch.pending_knocks().expect("pending ok");
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn accept_knock_flips_status_and_grants_member() {
        let porch = inner_porch();
        let k = porch
            .knock("inner-1", "12D3V", None)
            .expect("knock ok");
        let accepted = porch.accept_knock(&k.id).expect("accept ok");
        assert_eq!(accepted.status, KnockStatus::Accepted);
        assert!(accepted.resolved_at.is_some());
        let role = porch
            .lookup_acl("inner-1", "12D3V")
            .expect("lookup ok");
        assert_eq!(role, Some(AclRole::Member));
    }

    #[test]
    fn reject_knock_does_not_grant_acl() {
        let porch = inner_porch();
        let k = porch.knock("inner-1", "12D3V", None).expect("knock ok");
        let rejected = porch.reject_knock(&k.id).expect("reject ok");
        assert_eq!(rejected.status, KnockStatus::Rejected);
        let role = porch.lookup_acl("inner-1", "12D3V").expect("lookup ok");
        assert_eq!(role, None);
    }

    #[test]
    fn accept_twice_errors_on_second_call() {
        let porch = inner_porch();
        let k = porch.knock("inner-1", "12D3V", None).expect("knock ok");
        porch.accept_knock(&k.id).expect("first accept ok");
        let err = porch.accept_knock(&k.id).expect_err("second must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }

    #[test]
    fn withdraw_only_works_for_knocker() {
        let porch = inner_porch();
        let k = porch.knock("inner-1", "12D3V", None).expect("knock ok");
        let err = porch
            .withdraw_knock(&k.id, "12D3OtherPeer")
            .expect_err("wrong peer must be denied");
        assert!(matches!(err, PorchError::AccessDenied { .. }));
        let ok = porch
            .withdraw_knock(&k.id, "12D3V")
            .expect("real knocker ok");
        assert_eq!(ok.status, KnockStatus::Withdrawn);
    }

    #[test]
    fn re_knock_after_withdraw_is_allowed() {
        let porch = inner_porch();
        let k1 = porch.knock("inner-1", "12D3V", None).expect("knock ok");
        porch
            .withdraw_knock(&k1.id, "12D3V")
            .expect("withdraw ok");
        let k2 = porch.knock("inner-1", "12D3V", None).expect("re-knock ok");
        assert_ne!(k1.id, k2.id, "post-withdraw, re-knock mints a new row");
        assert_eq!(k2.status, KnockStatus::Pending);
    }

    #[test]
    fn knock_on_missing_channel_errors() {
        let porch = Porch::open_in_memory().expect("open ok");
        let err = porch
            .knock("nope", "12D3V", None)
            .expect_err("must error");
        assert!(matches!(err, PorchError::ChannelNotFound { .. }));
    }

    #[test]
    fn message_too_large_rejected() {
        let porch = inner_porch();
        let huge = "x".repeat(MAX_KNOCK_MESSAGE_BYTES + 1);
        let err = porch
            .knock("inner-1", "12D3V", Some(&huge))
            .expect_err("must error");
        assert!(matches!(err, PorchError::InvalidInput(_)));
    }
}
