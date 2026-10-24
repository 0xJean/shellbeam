pub mod commands;
pub mod forward;
pub mod http_proxy;
pub mod interactive;
pub mod transport;

#[cfg(test)]
mod ops_smoke;
#[cfg(test)]
mod test_fixture;

pub(crate) use commands::run_ssh_command_sync;

use base64;
use serde::{Deserialize, Serialize};
use sha2;
use ssh2::Session;
use std::time::Instant;

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRequest {
    pub host_id: Option<String>,
    pub vault_id: Option<String>,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
    pub command: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRunResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_identity: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_host_keys: Option<Vec<transport::VerifiedHostKey>>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u128,
    pub error_type: Option<String>,
    pub error_code: Option<String>,
    pub error_source: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub connected: bool,
    pub duration_ms: u128,
    pub error_type: Option<String>,
    pub message: Option<String>,
    pub error_code: Option<String>,
    pub error_source: Option<String>,
    pub retryable: Option<bool>,
}

pub fn failed_result(
    started_at: Instant,
    message: String,
    error_type: &str,
    error_code: &str,
    error_source: &str,
    retryable: bool,
) -> CommandRunResult {
    CommandRunResult {
        host_identity: None,
        verified_host_keys: None,
        stdout: String::new(),
        stderr: message,
        exit_code: -1,
        duration_ms: started_at.elapsed().as_millis(),
        error_type: Some(error_type.to_string()),
        error_code: Some(error_code.to_string()),
        error_source: Some(error_source.to_string()),
        retryable: Some(retryable),
    }
}

pub(crate) fn verify_host_key(
    session: &Session,
    app: &tauri::AppHandle,
    host: &str,
    port: u16,
    accept_host_key: bool,
) -> Result<(), String> {
    use crate::error::{host_key_mismatch_payload, host_key_unknown_payload};
    use crate::net::known_hosts::{add_known_host, verify_known_host};

    let (key_bytes, key_type) = session
        .host_key()
        .ok_or_else(|| "Failed to get host key after handshake".to_string())?;
    let key_type_str = format!("{:?}", key_type);

    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(key_bytes);
    let fingerprint = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hash);

    match verify_known_host(app, host, port, &fingerprint) {
        Ok(true) => Ok(()),
        Ok(false) => {
            if accept_host_key {
                add_known_host(app, host, port, &fingerprint, &key_type_str)?;
                Ok(())
            } else {
                Err(host_key_unknown_payload(
                    host,
                    port,
                    &fingerprint,
                    &key_type_str,
                ))
            }
        }
        Err(_mismatch) => Err(host_key_mismatch_payload(
            host,
            port,
            &fingerprint,
            &key_type_str,
        )),
    }
}

pub(crate) fn authenticate_session(
    session: &mut Session,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
) -> Result<(), String> {
    match auth_type {
        "password" => {
            let password = password.unwrap_or_default();
            if password.is_empty() {
                return Err("password is required for password auth".to_string());
            }
            session
                .userauth_password(username, password)
                .map_err(|err| format!("Password auth failed: {err}"))?;
        }
        "privateKey" => {
            let private_key = private_key.unwrap_or_default();
            if private_key.is_empty() {
                return Err("privateKey is required for private key auth".to_string());
            }
            session
                .userauth_pubkey_memory(username, None, private_key, passphrase)
                .map_err(|err| format!("Private key auth failed: {err}"))?;
        }
        _ => return Err("Unsupported authType. Use password or privateKey.".to_string()),
    }
    if !session.authenticated() {
        return Err("SSH authentication failed".to_string());
    }
    Ok(())
}

#[derive(Default)]
pub struct SshSessionPool;
