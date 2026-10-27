//! Explicit, user-confirmed fix for `KOMARI_AGENT_LINGER_REQUIRED`: a non-root
//! account needs systemd lingering so its user service survives logout and
//! reboot. The probe installer never does this implicitly; this command runs one
//! fixed command for the SSH account itself and never prompts for a password.
use super::{host_connection, hosts};
use crate::{ssh::commands::execute, ssh::transport, vault::VaultState};
use serde::Deserialize;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableLinger {
    vault_id: String,
    host_id: String,
}

/// Self-service first (polkit usually allows it for one's own account), then
/// non-interactive sudo. Prints exactly one status word on stdout.
const ENABLE_LINGER: &str = r#"sh -c 'u=$(id -un) || exit 2
if [ "$(id -u)" = 0 ]; then echo root; exit 0; fi
if [ "$(loginctl show-user "$u" -p Linger --value 2>/dev/null)" = yes ]; then echo enabled; exit 0; fi
loginctl enable-linger "$u" >/dev/null 2>&1 || sudo -n loginctl enable-linger "$u" >/dev/null 2>&1
if [ "$(loginctl show-user "$u" -p Linger --value 2>/dev/null)" = yes ]; then echo enabled; exit 0; fi
echo denied; exit 3'"#;

#[tauri::command]
pub async fn komari_agent_enable_linger(
    app: tauri::AppHandle,
    input: EnableLinger,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || enable_linger(&app, input))
        .await
        .map_err(|_| "KOMARI_AGENT_INTERNAL")?
}

pub(super) fn linger_outcome(stdout: &str) -> Result<(), String> {
    match stdout.trim() {
        "enabled" | "root" => Ok(()),
        "denied" => Err("KOMARI_AGENT_LINGER_SUDO_REQUIRED".into()),
        _ => Err("KOMARI_AGENT_REMOTE_UNKNOWN".into()),
    }
}

fn enable_linger(app: &tauri::AppHandle, input: EnableLinger) -> Result<(), String> {
    if !app.state::<VaultState>().is_unlocked(&input.vault_id) {
        return Err("KOMARI_AGENT_SCOPE_CHANGED".into());
    }
    let (host, _) = host_connection(app, &input.vault_id, &input.host_id, None)?;
    let route = transport::route_for_host(
        app,
        &input.vault_id,
        &host,
        &hosts::load_hosts(app, Some(&input.vault_id))?,
    )
    .map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    let connection = transport::connect(app, &route).map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    let result = execute(
        connection,
        ENABLE_LINGER,
        Instant::now(),
        Duration::from_secs(20),
    );
    if result.error_code.is_some() && result.stdout.trim().is_empty() {
        return Err("KOMARI_AGENT_SSH_CONNECTION".into());
    }
    linger_outcome(&result.stdout)
}

#[cfg(test)]
mod linger_tests {
    use super::{linger_outcome, ENABLE_LINGER};

    #[test]
    fn maps_status_words() {
        assert!(linger_outcome("enabled\n").is_ok());
        assert!(linger_outcome("root").is_ok());
        assert_eq!(
            linger_outcome("denied").unwrap_err(),
            "KOMARI_AGENT_LINGER_SUDO_REQUIRED"
        );
        assert_eq!(
            linger_outcome("").unwrap_err(),
            "KOMARI_AGENT_REMOTE_UNKNOWN"
        );
    }

    #[test]
    fn never_prompts_or_targets_another_account() {
        assert!(ENABLE_LINGER.contains("sudo -n "));
        assert!(!ENABLE_LINGER.contains("sudo loginctl"));
        assert!(ENABLE_LINGER.contains("u=$(id -un)"));
    }
}
