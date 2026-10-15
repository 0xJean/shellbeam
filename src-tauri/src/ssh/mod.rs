pub mod commands;
pub mod interactive;

pub(crate) use commands::run_ssh_command_sync;

use base64;
use serde::{Deserialize, Serialize};
use sha2;
use ssh2::Session;
use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const TCP_CONNECT_TIMEOUT_SECS: u64 = 10;
type SshProgress<'a> = Option<&'a mut dyn FnMut(&str)>;

pub(crate) fn format_ssh_handshake_error(err: &str) -> String {
    let raw = format!("SSH handshake failed: {err}");
    let lower = err.to_ascii_lowercase();

    if lower.contains("failed getting banner") {
        format!(
            "{raw}. The TCP connection opened, but the remote side did not send a valid SSH banner. This usually means the port is not serving SSH, sshd is temporarily unavailable, or a proxy/firewall/security device interrupted the connection. If this happens only sometimes, the remote host or network path is likely unstable."
        )
    } else {
        raw
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRequest {
    pub host_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRunResult {
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

/// Connect, handshake, and optionally verify the host key before authenticating.
/// When `app` is provided, host key is checked against known_hosts.
/// When `accept_host_key` is true, unknown keys are auto-added.
pub fn connect_and_authenticate(
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
    app: Option<&tauri::AppHandle>,
    accept_host_key: bool,
) -> Result<Session, String> {
    connect_and_authenticate_with_progress(
        host,
        port,
        username,
        auth_type,
        password,
        private_key,
        passphrase,
        app,
        accept_host_key,
        None,
    )
}

pub fn connect_and_authenticate_with_progress(
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
    app: Option<&tauri::AppHandle>,
    accept_host_key: bool,
    mut progress: SshProgress<'_>,
) -> Result<Session, String> {
    let address = format!("{host}:{port}");
    if let Some(cb) = progress.as_mut() {
        cb("resolve_host");
    }
    let addr = address
        .to_socket_addrs()
        .map_err(|e| format!("DNS resolve failed: {e}"))?
        .next()
        .ok_or_else(|| "DNS resolve returned no addresses".to_string())?;
    if let Some(cb) = progress.as_mut() {
        cb("open_tcp");
    }
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS))
        .map_err(|err| {
            format!("TCP connect failed (timeout {TCP_CONNECT_TIMEOUT_SECS}s): {err}")
        })?;
    // SSH is latency-sensitive; disable Nagle so small keystroke packets are sent immediately.
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();

    let mut session = Session::new().map_err(|err| format!("Create SSH session failed: {err}"))?;
    session.set_timeout(15_000);
    session.set_tcp_stream(tcp);
    if let Some(cb) = progress.as_mut() {
        cb("secure_session");
    }
    session
        .handshake()
        .map_err(|err| format_ssh_handshake_error(&err.to_string()))?;

    if let Some(app) = app {
        if let Some(cb) = progress.as_mut() {
            cb("verify_host");
        }
        verify_host_key(&session, app, host, port, accept_host_key)?;
    }

    if let Some(cb) = progress.as_mut() {
        cb("authenticate");
    }
    authenticate_session(
        &mut session,
        username,
        auth_type,
        password,
        private_key,
        passphrase,
    )?;
    Ok(session)
}

/// Authenticate an SSH session over an already-connected TCP stream. This is
/// used by ProxyJump consumers: the socket is local, but host-key verification
/// must still use the destination host identity before credentials are sent.
pub(crate) fn authenticate_tcp_stream(
    tcp: TcpStream,
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
    app: Option<&tauri::AppHandle>,
    accept_host_key: bool,
) -> Result<Session, String> {
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();

    let mut session = Session::new().map_err(|err| format!("Create SSH session failed: {err}"))?;
    session.set_timeout(15_000);
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|err| format_ssh_handshake_error(&err.to_string()))?;
    if let Some(app) = app {
        verify_host_key(&session, app, host, port, accept_host_key)?;
    }
    authenticate_session(
        &mut session,
        username,
        auth_type,
        password,
        private_key,
        passphrase,
    )?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::format_ssh_handshake_error;

    #[test]
    fn adds_diagnostic_context_for_missing_banner_errors() {
        let message = format_ssh_handshake_error("[Session(-13)] Failed getting banner");

        assert!(message.contains("SSH handshake failed: [Session(-13)] Failed getting banner"));
        assert!(message.contains("did not send a valid SSH banner"));
        assert!(message.contains("not serving SSH"));
        assert!(message.contains("happens only sometimes"));
    }

    #[test]
    fn leaves_other_handshake_errors_unchanged() {
        let message = format_ssh_handshake_error("Unable to exchange encryption keys");

        assert_eq!(
            message,
            "SSH handshake failed: Unable to exchange encryption keys"
        );
    }
}

/// Legacy wrapper that skips host key verification (used by pool/sftp where keys are checked elsewhere).
pub fn connect_authenticated_ssh_session(
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
) -> Result<Session, String> {
    connect_and_authenticate(
        host,
        port,
        username,
        auth_type,
        password,
        private_key,
        passphrase,
        None,
        false,
    )
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
pub struct SshSessionPool {
    pool: Mutex<HashMap<String, Session>>,
}

impl SshSessionPool {
    fn pool_key(host: &str, port: u16, username: &str) -> String {
        format!("{username}@{host}:{port}")
    }

    pub fn checkout(
        &self,
        host: &str,
        port: u16,
        username: &str,
        auth_type: &str,
        password: Option<&str>,
        private_key: Option<&str>,
        passphrase: Option<&str>,
    ) -> Result<Session, String> {
        let key = Self::pool_key(host, port, username);
        if let Ok(mut pool) = self.pool.lock() {
            if let Some(session) = pool.remove(&key) {
                if session.authenticated() {
                    return Ok(session);
                }
            }
        }
        connect_authenticated_ssh_session(
            host,
            port,
            username,
            auth_type,
            password,
            private_key,
            passphrase,
        )
    }

    pub fn checkin(&self, host: &str, port: u16, username: &str, session: Session) {
        let key = Self::pool_key(host, port, username);
        if let Ok(mut pool) = self.pool.lock() {
            pool.insert(key, session);
        }
    }
}
