//! Submits the moonlight pairing pin to the Sunshine web api.
//!
//! Normally the pin generated while pairing is shown to the user and typed into the
//! Sunshine web ui. For an unattended setup the pin is forwarded to Sunshine
//! automatically, so connecting to a host never requires a manual code.

use std::time::Duration;

use tracing::{debug, info, warn};

use crate::config::AutoPairConfig;

const PIN_API_PATH: &str = "/api/pin";
const ATTEMPTS: u32 = 40;
const ATTEMPT_INTERVAL: Duration = Duration::from_millis(250);

enum Outcome {
    /// Sunshine accepted the pin for a pending pair session.
    Accepted,
    /// Sunshine answered, but there was no pending pair session (yet).
    Pending,
}

/// Submits the pin to Sunshine, retrying until it is accepted.
///
/// Sunshine only accepts the pin once the pairing handshake has been started, which
/// happens right after this is called, so a couple of retries are required.
pub async fn auto_submit_pin(config: &AutoPairConfig, pin: &str, device_name: &str) {
    let device_name = config.device_name.as_deref().unwrap_or(device_name);

    for attempt in 1..=ATTEMPTS {
        tokio::time::sleep(ATTEMPT_INTERVAL).await;

        match submit_pin(config, pin, device_name).await {
            Ok(Outcome::Accepted) => {
                info!("auto-pair: Sunshine released the host for pin {pin}");
                return;
            }
            Ok(Outcome::Pending) => {
                debug!("auto-pair: no pending pair session on Sunshine yet (attempt {attempt})");
            }
            Err(err) => {
                warn!("auto-pair: failed to submit pin to Sunshine: {err}");
            }
        }
    }

    warn!("auto-pair: gave up submitting pin {pin} after {ATTEMPTS} attempts");
}

async fn submit_pin(
    config: &AutoPairConfig,
    pin: &str,
    device_name: &str,
) -> anyhow::Result<Outcome> {
    let url = format!("{}{PIN_API_PATH}", config.api_url.trim_end_matches('/'));
    let body = serde_json::json!({ "pin": pin, "name": device_name }).to_string();

    // curl is used because it is available on every supported platform and handles
    // both the cloudflare tunnel and a direct (self signed) Sunshine connection.
    let output = tokio::process::Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--insecure",
            "--max-time",
            "10",
            "--user",
            &format!("{}:{}", config.username, config.password),
            "--header",
            "Content-Type: application/json",
            "--request",
            "POST",
            "--data-binary",
            &body,
            &url,
        ])
        .output()
        .await?;

    if !output.status.success() {
        anyhow::bail!(
            "curl exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let response = String::from_utf8_lossy(&output.stdout);
    debug!("auto-pair: Sunshine answered {response}");

    let accepted = serde_json::from_str::<serde_json::Value>(response.trim())
        .ok()
        .and_then(|value| value.get("status").and_then(|status| status.as_bool()))
        .unwrap_or(false);

    Ok(if accepted {
        Outcome::Accepted
    } else {
        Outcome::Pending
    })
}
