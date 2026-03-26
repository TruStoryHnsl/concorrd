use rusqlite::params;
use tracing::{debug, warn};

use concord_core::identity::verify_attestation_signature;
use concord_core::trust::{
    compute_net_trust, compute_trust_level, compute_trust_with_bleed,
    AttestationType, TrustAttestation, TrustScore,
};

use crate::db::{Database, Result};

impl Database {
    /// Store (or replace) an attestation. Replaces any existing attestation
    /// from the same attester for the same subject.
    pub fn store_attestation(&self, att: &TrustAttestation) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let att_type = match att.attestation_type {
            AttestationType::Positive => "positive",
            AttestationType::Negative => "negative",
        };
        self.conn.execute(
            "INSERT INTO attestations (attester_id, subject_id, attestation_type, since_timestamp, reason, signature, attester_trust_weight, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(attester_id, subject_id) DO UPDATE SET
                attestation_type = ?3,
                since_timestamp = ?4,
                reason = ?5,
                signature = ?6,
                attester_trust_weight = ?7,
                received_at = ?8",
            params![
                att.attester_id,
                att.subject_id,
                att_type,
                att.since_timestamp as i64,
                att.reason,
                att.signature,
                att.attester_trust_weight,
                now,
            ],
        )?;
        debug!(
            attester = %att.attester_id,
            subject = %att.subject_id,
            r#type = att_type,
            "attestation stored"
        );
        Ok(())
    }

    /// Store an attestation ONLY if its Ed25519 signature is valid.
    /// Returns Ok(true) if stored, Ok(false) if signature verification failed.
    pub fn store_verified_attestation(&self, att: &TrustAttestation) -> Result<bool> {
        match verify_attestation_signature(
            &att.attester_id,
            &att.subject_id,
            att.since_timestamp,
            &att.signature,
        ) {
            Ok(true) => {
                self.store_attestation(att)?;
                Ok(true)
            }
            Ok(false) => {
                warn!(
                    attester = %att.attester_id,
                    subject = %att.subject_id,
                    "attestation signature verification FAILED — rejecting forged attestation"
                );
                Ok(false)
            }
            Err(e) => {
                warn!(
                    attester = %att.attester_id,
                    error = %e,
                    "attestation verification error (malformed key?) — rejecting"
                );
                Ok(false)
            }
        }
    }

    /// Get all attestations for a given subject peer.
    pub fn get_attestations_for(&self, subject_id: &str) -> Result<Vec<TrustAttestation>> {
        let mut stmt = self.conn.prepare(
            "SELECT attester_id, subject_id, attestation_type, since_timestamp, reason, signature, attester_trust_weight
             FROM attestations
             WHERE subject_id = ?1
             ORDER BY received_at DESC",
        )?;
        let rows = stmt.query_map(params![subject_id], row_to_attestation)?;
        let attestations: Vec<TrustAttestation> =
            rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(attestations)
    }

    /// Count the total number of attestations for a subject.
    pub fn get_attestation_count(&self, subject_id: &str) -> Result<u32> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM attestations WHERE subject_id = ?1",
            params![subject_id],
            |row| row.get(0),
        )?;
        Ok(count as u32)
    }

    /// Count positive attestations for a subject.
    pub fn get_positive_attestation_count(&self, subject_id: &str) -> Result<u32> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM attestations WHERE subject_id = ?1 AND attestation_type = 'positive'",
            params![subject_id],
            |row| row.get(0),
        )?;
        Ok(count as u32)
    }

    /// Count negative attestations for a subject.
    pub fn get_negative_attestation_count(&self, subject_id: &str) -> Result<u32> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM attestations WHERE subject_id = ?1 AND attestation_type = 'negative'",
            params![subject_id],
            |row| row.get(0),
        )?;
        Ok(count as u32)
    }

    /// Get weighted sums of positive and negative attestations.
    /// Returns (weighted_positive, weighted_negative).
    pub fn get_weighted_attestation_sums(&self, subject_id: &str) -> Result<(f64, f64)> {
        let weighted_pos: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN attester_trust_weight > 0 THEN attester_trust_weight ELSE 0.5 END), 0.0)
             FROM attestations WHERE subject_id = ?1 AND attestation_type = 'positive'",
            params![subject_id],
            |row| row.get(0),
        )?;
        let weighted_neg: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN attester_trust_weight > 0 THEN attester_trust_weight ELSE 0.5 END), 0.0)
             FROM attestations WHERE subject_id = ?1 AND attestation_type = 'negative'",
            params![subject_id],
            |row| row.get(0),
        )?;
        Ok((weighted_pos, weighted_neg))
    }

    /// Compute the trust score for a peer, update the peers table, and return the score.
    ///
    /// `identity_age_days` is how many days since the peer's identity was first seen.
    pub fn compute_and_update_trust(
        &self,
        subject_id: &str,
        identity_age_days: u64,
    ) -> Result<TrustScore> {
        let positive_count = self.get_positive_attestation_count(subject_id)?;
        let negative_count = self.get_negative_attestation_count(subject_id)?;
        let attestation_count = positive_count + negative_count;
        let (weighted_pos, weighted_neg) = self.get_weighted_attestation_sums(subject_id)?;

        let (score, badge) = compute_net_trust(
            positive_count,
            negative_count,
            weighted_pos,
            weighted_neg,
            identity_age_days,
        );

        // Update the peer's trust score in the peers table
        self.conn.execute(
            "UPDATE peers SET trust_score = ?1 WHERE peer_id = ?2",
            params![score, subject_id],
        )?;

        let trust_score = TrustScore {
            peer_id: subject_id.to_string(),
            score,
            attestation_count,
            positive_count,
            negative_count,
            badge,
        };

        debug!(
            peer_id = %subject_id,
            score,
            attestation_count,
            positive_count,
            negative_count,
            ?badge,
            "trust score computed and updated"
        );

        Ok(trust_score)
    }

    /// Compute trust score for a subject, factoring in cross-account bleed from aliases.
    pub fn compute_trust_with_aliases(
        &self,
        subject_id: &str,
        identity_age_days: u64,
    ) -> Result<TrustScore> {
        // First compute the individual score
        let individual = self.compute_and_update_trust(subject_id, identity_age_days)?;

        // Look up the root identity for this subject (may be an alias)
        let root_identity = self
            .get_root_identity_for_alias(subject_id)?
            .unwrap_or_else(|| subject_id.to_string());

        // Get all sibling alias IDs (excluding the subject itself)
        let sibling_aliases = self.get_known_aliases(&root_identity)?;
        let mut sibling_scores = Vec::new();
        for (alias_id, _name) in &sibling_aliases {
            if alias_id == subject_id {
                continue;
            }
            // Compute each sibling's individual score (without recursing into bleed)
            let sibling_pos = self.get_positive_attestation_count(alias_id)?;
            let sibling_neg = self.get_negative_attestation_count(alias_id)?;
            let (w_pos, w_neg) = self.get_weighted_attestation_sums(alias_id)?;
            let (sibling_score, _) =
                compute_net_trust(sibling_pos, sibling_neg, w_pos, w_neg, identity_age_days);
            sibling_scores.push(sibling_score);
        }

        // Also check if root_identity itself has attestations (and isn't the subject)
        if root_identity != subject_id {
            let root_pos = self.get_positive_attestation_count(&root_identity)?;
            let root_neg = self.get_negative_attestation_count(&root_identity)?;
            if root_pos + root_neg > 0 {
                let (w_pos, w_neg) = self.get_weighted_attestation_sums(&root_identity)?;
                let (root_score, _) =
                    compute_net_trust(root_pos, root_neg, w_pos, w_neg, identity_age_days);
                sibling_scores.push(root_score);
            }
        }

        let blended_score = compute_trust_with_bleed(individual.score, &sibling_scores);

        // Re-derive badge from blended score
        let net_count = (individual.positive_count as i64 - individual.negative_count as i64).max(0) as u32;
        let badge = if blended_score < -0.3 {
            concord_core::types::TrustLevel::Unverified
        } else {
            compute_trust_level(net_count, identity_age_days)
        };

        Ok(TrustScore {
            peer_id: subject_id.to_string(),
            score: blended_score,
            attestation_count: individual.attestation_count,
            positive_count: individual.positive_count,
            negative_count: individual.negative_count,
            badge,
        })
    }

    /// Get the cached trust score for a peer. Returns None if no attestations exist.
    pub fn get_trust_score(&self, peer_id: &str) -> Result<Option<TrustScore>> {
        let positive_count = self.get_positive_attestation_count(peer_id)?;
        let negative_count = self.get_negative_attestation_count(peer_id)?;
        let attestation_count = positive_count + negative_count;
        if attestation_count == 0 {
            return Ok(None);
        }

        let trust_val: f64 = self.conn.query_row(
            "SELECT trust_score FROM peers WHERE peer_id = ?1",
            params![peer_id],
            |row| row.get(0),
        ).unwrap_or(0.0);

        // We need identity age to compute the badge, but we don't store creation date
        // for peers directly. Use the earliest attestation's since_timestamp as a proxy.
        let earliest_since: i64 = self.conn.query_row(
            "SELECT MIN(since_timestamp) FROM attestations WHERE subject_id = ?1",
            params![peer_id],
            |row| row.get(0),
        ).unwrap_or(0);

        let now = chrono::Utc::now().timestamp() as u64;
        let age_secs = now.saturating_sub(earliest_since as u64);
        let age_days = age_secs / 86400;

        let net_count = (positive_count as i64 - negative_count as i64).max(0) as u32;
        let badge = if trust_val < -0.3 {
            concord_core::types::TrustLevel::Unverified
        } else {
            compute_trust_level(net_count, age_days)
        };

        Ok(Some(TrustScore {
            peer_id: peer_id.to_string(),
            score: trust_val,
            attestation_count,
            positive_count,
            negative_count,
            badge,
        }))
    }
}

fn row_to_attestation(row: &rusqlite::Row) -> rusqlite::Result<TrustAttestation> {
    let att_type_str: String = row.get(2)?;
    let attestation_type = if att_type_str == "negative" {
        AttestationType::Negative
    } else {
        AttestationType::Positive
    };
    Ok(TrustAttestation {
        attester_id: row.get(0)?,
        subject_id: row.get(1)?,
        attestation_type,
        since_timestamp: row.get::<_, i64>(3)? as u64,
        reason: row.get(4)?,
        signature: row.get(5)?,
        attester_trust_weight: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_positive_attestation(attester: &str, subject: &str) -> TrustAttestation {
        TrustAttestation {
            attester_id: attester.to_string(),
            subject_id: subject.to_string(),
            attestation_type: AttestationType::Positive,
            since_timestamp: 1700000000,
            reason: None,
            signature: vec![1, 2, 3, 4],
            attester_trust_weight: 1.0,
        }
    }

    fn make_negative_attestation(attester: &str, subject: &str, reason: &str) -> TrustAttestation {
        TrustAttestation {
            attester_id: attester.to_string(),
            subject_id: subject.to_string(),
            attestation_type: AttestationType::Negative,
            since_timestamp: 1700000000,
            reason: Some(reason.to_string()),
            signature: vec![1, 2, 3, 4],
            attester_trust_weight: 1.0,
        }
    }

    #[test]
    fn store_and_retrieve_attestation() {
        let db = Database::open_in_memory().unwrap();

        let att = make_positive_attestation("attester1", "subject1");
        db.store_attestation(&att).unwrap();

        let attestations = db.get_attestations_for("subject1").unwrap();
        assert_eq!(attestations.len(), 1);
        assert_eq!(attestations[0].attester_id, "attester1");
        assert_eq!(attestations[0].since_timestamp, 1700000000);
        assert_eq!(attestations[0].attestation_type, AttestationType::Positive);
    }

    #[test]
    fn store_and_retrieve_negative_attestation() {
        let db = Database::open_in_memory().unwrap();

        let att = make_negative_attestation("attester1", "subject1", "spamming");
        db.store_attestation(&att).unwrap();

        let attestations = db.get_attestations_for("subject1").unwrap();
        assert_eq!(attestations.len(), 1);
        assert_eq!(attestations[0].attestation_type, AttestationType::Negative);
        assert_eq!(attestations[0].reason, Some("spamming".to_string()));
    }

    #[test]
    fn attestation_count() {
        let db = Database::open_in_memory().unwrap();

        for i in 0..5 {
            let att = make_positive_attestation(&format!("attester{i}"), "subject1");
            db.store_attestation(&att).unwrap();
        }

        assert_eq!(db.get_attestation_count("subject1").unwrap(), 5);
        assert_eq!(db.get_attestation_count("nonexistent").unwrap(), 0);
    }

    #[test]
    fn positive_and_negative_counts() {
        let db = Database::open_in_memory().unwrap();

        // 3 positive, 2 negative
        for i in 0..3 {
            db.store_attestation(&make_positive_attestation(&format!("pos{i}"), "subject1")).unwrap();
        }
        for i in 0..2 {
            db.store_attestation(&make_negative_attestation(&format!("neg{i}"), "subject1", "bad")).unwrap();
        }

        assert_eq!(db.get_positive_attestation_count("subject1").unwrap(), 3);
        assert_eq!(db.get_negative_attestation_count("subject1").unwrap(), 2);
        assert_eq!(db.get_attestation_count("subject1").unwrap(), 5);
    }

    #[test]
    fn weighted_attestation_sums() {
        let db = Database::open_in_memory().unwrap();

        let mut att1 = make_positive_attestation("a1", "subject1");
        att1.attester_trust_weight = 2.0;
        db.store_attestation(&att1).unwrap();

        let mut att2 = make_positive_attestation("a2", "subject1");
        att2.attester_trust_weight = 1.5;
        db.store_attestation(&att2).unwrap();

        let mut att3 = make_negative_attestation("a3", "subject1", "bad");
        att3.attester_trust_weight = 3.0;
        db.store_attestation(&att3).unwrap();

        let (wp, wn) = db.get_weighted_attestation_sums("subject1").unwrap();
        assert!((wp - 3.5).abs() < 0.01); // 2.0 + 1.5
        assert!((wn - 3.0).abs() < 0.01);
    }

    #[test]
    fn upsert_attestation_replaces() {
        let db = Database::open_in_memory().unwrap();

        let att1 = make_positive_attestation("attester1", "subject1");
        db.store_attestation(&att1).unwrap();

        // Same attester+subject with different timestamp — change to negative
        let att2 = make_negative_attestation("attester1", "subject1", "changed mind");
        db.store_attestation(&att2).unwrap();

        // Should still be 1 attestation (upserted)
        assert_eq!(db.get_attestation_count("subject1").unwrap(), 1);
        let attestations = db.get_attestations_for("subject1").unwrap();
        assert_eq!(attestations[0].attestation_type, AttestationType::Negative);
    }

    #[test]
    fn compute_trust_from_stored_attestations() {
        let db = Database::open_in_memory().unwrap();

        // Create a peer first
        db.upsert_peer("subject1", Some("Subject"), &[]).unwrap();

        // Store 5 positive attestations
        for i in 0..5 {
            let att = make_positive_attestation(&format!("attester{i}"), "subject1");
            db.store_attestation(&att).unwrap();
        }

        // 5 attestations + 30 days -> Established
        let score = db.compute_and_update_trust("subject1", 30).unwrap();
        assert_eq!(score.attestation_count, 5);
        assert_eq!(score.positive_count, 5);
        assert_eq!(score.negative_count, 0);
        assert_eq!(score.badge, concord_core::types::TrustLevel::Established);
        assert!(score.score > 0.0);
    }

    #[test]
    fn compute_trust_with_negatives() {
        let db = Database::open_in_memory().unwrap();

        db.upsert_peer("subject1", Some("Subject"), &[]).unwrap();

        // 2 positive, 5 negative — should drag score below zero
        for i in 0..2 {
            db.store_attestation(&make_positive_attestation(&format!("pos{i}"), "subject1")).unwrap();
        }
        for i in 0..5 {
            db.store_attestation(&make_negative_attestation(&format!("neg{i}"), "subject1", "bad")).unwrap();
        }

        let score = db.compute_and_update_trust("subject1", 90).unwrap();
        assert!(score.score < 0.0);
        assert_eq!(score.positive_count, 2);
        assert_eq!(score.negative_count, 5);
    }

    #[test]
    fn compute_trust_with_alias_bleed() {
        let db = Database::open_in_memory().unwrap();

        // Create peers
        db.upsert_peer("root1", Some("Root"), &[]).unwrap();
        db.upsert_peer("alias1", Some("Alias1"), &[]).unwrap();
        db.upsert_peer("alias2", Some("Alias2"), &[]).unwrap();

        // Set up known aliases
        db.store_known_alias("alias1", "root1", "Alias One").unwrap();
        db.store_known_alias("alias2", "root1", "Alias Two").unwrap();

        // alias1 has positive attestations
        for i in 0..5 {
            db.store_attestation(&make_positive_attestation(&format!("a{i}"), "alias1")).unwrap();
        }
        // alias2 has negative attestations
        for i in 0..3 {
            db.store_attestation(&make_negative_attestation(&format!("b{i}"), "alias2", "bad")).unwrap();
        }

        // Compute trust with bleed for alias1
        let score = db.compute_trust_with_aliases("alias1", 30).unwrap();
        // alias1 individually is positive, but alias2 drags it down
        assert!(score.score > -1.0);
        assert!(score.score < 1.0);
    }

    #[test]
    fn get_trust_score_returns_none_for_unknown() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_trust_score("nonexistent").unwrap().is_none());
    }

    #[test]
    fn verified_attestation_stores_valid_signature() {
        let db = Database::open_in_memory().unwrap();
        let kp = concord_core::identity::Keypair::generate();
        let tm = concord_core::trust::TrustManager::new(&kp);
        let att = tm.create_attestation("subject_peer", 1000);
        assert!(db.store_verified_attestation(&att).unwrap());
        assert_eq!(db.get_attestation_count("subject_peer").unwrap(), 1);
    }

    #[test]
    fn verified_attestation_rejects_forged_signature() {
        use concord_core::trust::{AttestationType, TrustAttestation};
        let db = Database::open_in_memory().unwrap();
        let kp = concord_core::identity::Keypair::generate();
        let forged = TrustAttestation {
            attester_id: kp.peer_id(),
            subject_id: "victim".to_string(),
            attestation_type: AttestationType::Negative,
            since_timestamp: 1000,
            reason: Some("forged".to_string()),
            signature: vec![0u8; 64], // garbage signature
            attester_trust_weight: 1.0,
        };
        assert!(!db.store_verified_attestation(&forged).unwrap());
        assert_eq!(db.get_attestation_count("victim").unwrap(), 0);
    }

    #[test]
    fn verified_attestation_rejects_tampered_subject() {
        let db = Database::open_in_memory().unwrap();
        let kp = concord_core::identity::Keypair::generate();
        let tm = concord_core::trust::TrustManager::new(&kp);
        let mut att = tm.create_attestation("real_subject", 1000);
        att.subject_id = "tampered_subject".to_string(); // tamper after signing
        assert!(!db.store_verified_attestation(&att).unwrap());
        assert_eq!(db.get_attestation_count("tampered_subject").unwrap(), 0);
    }
}
