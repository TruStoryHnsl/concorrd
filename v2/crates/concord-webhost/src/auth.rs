// Authentication module.
//
// PIN-based guest authentication for browser clients joining via the webhost.
// No accounts — guests provide a PIN (shared out-of-band by the host) and
// a display name to receive a session token.

use std::collections::HashMap;
use std::sync::Arc;

use rand::Rng;
use tokio::sync::RwLock;

/// Generate a random 6-digit PIN.
pub fn generate_pin() -> String {
    let pin: u32 = rand::thread_rng().gen_range(100_000..1_000_000);
    pin.to_string()
}

/// An active guest session.
#[derive(Debug, Clone)]
pub struct GuestSession {
    pub guest_id: String,
    pub display_name: String,
    pub authenticated_at: i64,
}

/// Manages PIN verification and active guest sessions.
#[derive(Clone)]
pub struct GuestAuthManager {
    /// The PIN required to join.
    pin: String,
    /// Active session tokens mapped to guest sessions.
    sessions: Arc<RwLock<HashMap<String, GuestSession>>>,
}

impl GuestAuthManager {
    /// Create a new auth manager with the given PIN.
    pub fn new(pin: String) -> Self {
        Self {
            pin,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Verify a PIN and create a guest session.
    ///
    /// Returns a session token on success.
    pub async fn authenticate(
        &self,
        pin: &str,
        display_name: &str,
    ) -> Result<(String, String), AuthError> {
        if pin != self.pin {
            return Err(AuthError::InvalidPin);
        }

        let guest_id = uuid_v4();
        let token = uuid_v4();
        let now = chrono_now_millis();

        let session = GuestSession {
            guest_id: guest_id.clone(),
            display_name: display_name.to_string(),
            authenticated_at: now,
        };

        self.sessions.write().await.insert(token.clone(), session);

        Ok((token, guest_id))
    }

    /// Validate a session token. Returns a clone of the session if valid and not expired.
    /// Sessions expire after 24 hours.
    pub async fn validate_session(&self, token: &str) -> Option<GuestSession> {
        const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000; // 24 hours
        let sessions = self.sessions.read().await;
        let session = sessions.get(token)?;
        let now = chrono_now_millis();
        if now - session.authenticated_at > SESSION_TTL_MS {
            drop(sessions);
            self.sessions.write().await.remove(token);
            return None;
        }
        Some(session.clone())
    }

    /// Revoke a session by token.
    pub async fn revoke(&self, token: &str) {
        self.sessions.write().await.remove(token);
    }

    /// Get the PIN (for the host to share).
    pub fn pin(&self) -> &str {
        &self.pin
    }

    /// Count active sessions.
    pub async fn active_count(&self) -> usize {
        self.sessions.read().await.len()
    }
}

/// Auth errors.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("invalid PIN")]
    InvalidPin,
    #[error("session expired")]
    SessionExpired,
}

/// Generate a simple UUID-v4-like string for tokens and guest IDs.
fn uuid_v4() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.r#gen();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

/// Get current time in milliseconds since epoch.
fn chrono_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_generate_pin_length() {
        let pin = generate_pin();
        assert_eq!(pin.len(), 6);
        assert!(pin.parse::<u32>().is_ok());
    }

    #[tokio::test]
    async fn test_authenticate_valid_pin() {
        let mgr = GuestAuthManager::new("123456".to_string());
        let result = mgr.authenticate("123456", "Alice").await;
        assert!(result.is_ok());

        let (token, guest_id) = result.unwrap();
        assert!(!token.is_empty());
        assert!(!guest_id.is_empty());

        // Session should be valid.
        let session = mgr.validate_session(&token).await;
        assert!(session.is_some());
        assert_eq!(session.unwrap().display_name, "Alice");
    }

    #[tokio::test]
    async fn test_authenticate_invalid_pin() {
        let mgr = GuestAuthManager::new("123456".to_string());
        let result = mgr.authenticate("000000", "Bob").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_revoke_session() {
        let mgr = GuestAuthManager::new("111111".to_string());
        let (token, _) = mgr.authenticate("111111", "Charlie").await.unwrap();

        assert_eq!(mgr.active_count().await, 1);
        mgr.revoke(&token).await;
        assert_eq!(mgr.active_count().await, 0);
        assert!(mgr.validate_session(&token).await.is_none());
    }
}
