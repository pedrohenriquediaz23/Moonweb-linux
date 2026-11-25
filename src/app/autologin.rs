use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use moonlight_common::{crypto::rustcrypto::RustCryptoBackend, http::pair::PairingCryptoBackend};
use tokio::sync::RwLock;

use crate::app::{AppError, user::UserId};

/// Size of the random token in bytes (256 bits of entropy).
const TOKEN_SIZE: usize = 32;

/// A temporary credential that logs a device in without typing the user
/// password. It stops working as soon as it expires or every host gets unpaired.
#[derive(Clone)]
pub struct AutologinToken {
    pub user_id: UserId,
    /// Path the browser is redirected to after the session cookie is set,
    /// relative to the server root (already includes the url path prefix).
    pub target: String,
    pub expires_at: Instant,
}

/// In-memory store of the temporary autologin tokens.
#[derive(Default)]
pub struct AutologinStore {
    tokens: RwLock<HashMap<String, AutologinToken>>,
}

impl AutologinStore {
    /// Creates a new token valid for `lifetime`.
    pub async fn create(
        &self,
        user_id: UserId,
        target: String,
        lifetime: Duration,
    ) -> Result<String, AppError> {
        let mut tokens = self.tokens.write().await;

        let now = Instant::now();

        // Drop whatever already expired while we hold the lock anyway.
        tokens.retain(|_, token| token.expires_at > now);

        // Generate a unique random token.
        let token = loop {
            let mut bytes = [0u8; TOKEN_SIZE];
            RustCryptoBackend.random_bytes(&mut bytes)?;

            let token = hex::encode(bytes);
            if !tokens.contains_key(&token) {
                break token;
            }
        };

        tokens.insert(
            token.clone(),
            AutologinToken {
                user_id,
                target,
                expires_at: now + lifetime,
            },
        );

        Ok(token)
    }

    /// Returns the token data while it is still valid. Tokens are reusable, so
    /// reloading the stream page keeps working until the token expires.
    pub async fn validate(&self, token: &str) -> Option<AutologinToken> {
        let mut tokens = self.tokens.write().await;

        let now = Instant::now();
        tokens.retain(|_, token| token.expires_at > now);

        tokens.get(token).cloned()
    }

    /// Removes a single token, returning whether it existed.
    pub async fn revoke(&self, token: &str) -> bool {
        self.tokens.write().await.remove(token).is_some()
    }

    /// Invalidates every token, returning how many were removed. Used when a
    /// host gets unpaired.
    pub async fn clear(&self) -> usize {
        let mut tokens = self.tokens.write().await;

        let removed = tokens.len();
        tokens.clear();

        removed
    }
}
