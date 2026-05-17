use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use ssh2::Session;

use super::{
    failed_result, format_ssh_handshake_error, CommandRunResult, ConnectionTestResult, SshRequest,
    TCP_CONNECT_TIMEOUT_SECS,
};
use crate::history::append_history;

fn failed_connection_test(
    started_at: Instant,
    message: String,
    error_type: &str,
    error_code: &str,
    error_source: &str,
    retryable: bool,
) -> ConnectionTestResult {
    ConnectionTestResult {
        connected: false,
        duration_ms: started_at.elapsed().as_millis(),
        error_type: Some(error_type.to_string()),
        message: Some(message),
        error_code: Some(error_code.to_string()),
        error_source: Some(error_source.to_string()),
        retryable: Some(retryable),
    }
}

#[tauri::command]
pub async fn test_ssh_connection(payload: SshRequest) -> Result<ConnectionTestResult, String> {
    tauri::async_runtime::spawn_blocking(move || test_ssh_connection_sync(payload))
        .await
        .map_err(|e| format!("Task panicked: {e}"))
}

fn test_ssh_connection_sync(payload: SshRequest) -> ConnectionTestResult {
    let started_at = Instant::now();
    let address = format!("{}:{}", payload.host, payload.port);
    let addr = match address.to_socket_addrs().and_then(|mut a| {
        a.next()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "No addresses"))
    }) {
        Ok(a) => a,
        Err(err) => {
            return failed_connection_test(
                started_at,
                format!("DNS resolve failed: {err}"),
                "network",
                "network_error",
                "ssh",
                true,
            )
        }
    };
    let tcp = match TcpStream::connect_timeout(&addr, Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS))
    {
        Ok(tcp) => tcp,
        Err(err) => {
            return failed_connection_test(
                started_at,
                format!("TCP connect failed: {err}"),
                "network",
                "network_error",
                "ssh",
                true,
            );
        }
    };

    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();

    let mut session = match Session::new() {
        Ok(session) => session,
        Err(err) => {
            return failed_connection_test(
                started_at,
                format!("Create SSH session failed: {err}"),
                "internal",
                "session_create_failed",
                "ssh",
                true,
            );
        }
    };

    session.set_tcp_stream(tcp);
    if let Err(err) = session.handshake() {
        return failed_connection_test(
            started_at,
            format_ssh_handshake_error(&err.to_string()),
            "network",
            "handshake_failed",
            "ssh",
            true,
        );
    }

    match payload.auth_type.as_str() {
        "password" => {
            let password = payload.password.as_deref().unwrap_or_default();
            if password.is_empty() {
                return failed_connection_test(
                    started_at,
                    "password is required for password auth".to_string(),
                    "validation",
                    "validation_error",
                    "client",
                    false,
                );
            }
            if let Err(err) = session.userauth_password(&payload.username, password) {
                return failed_connection_test(
                    started_at,
                    format!("Password auth failed: {err}"),
                    "auth",
                    "auth_failed",
                    "ssh",
                    false,
                );
            }
        }
        "privateKey" => {
            let private_key = payload.private_key.as_deref().unwrap_or_default();
            if private_key.is_empty() {
                return failed_connection_test(
                    started_at,
                    "privateKey is required for private key auth".to_string(),
                    "validation",
                    "validation_error",
                    "client",
                    false,
                );
            }
            if let Err(err) = session.userauth_pubkey_memory(
                &payload.username,
                None,
                private_key,
                payload.passphrase.as_deref(),
            ) {
                return failed_connection_test(
                    started_at,
                    format!("Private key auth failed: {err}"),
                    "auth",
                    "auth_failed",
                    "ssh",
                    false,
                );
            }
        }
        _ => {
            return failed_connection_test(
                started_at,
                "Unsupported authType. Use password or privateKey.".to_string(),
                "validation",
                "validation_error",
                "client",
                false,
            );
        }
    };

    if !session.authenticated() {
        return failed_connection_test(
            started_at,
            "SSH authentication failed".to_string(),
            "auth",
            "auth_failed",
            "ssh",
            false,
        );
    }

    ConnectionTestResult {
        connected: true,
        duration_ms: started_at.elapsed().as_millis(),
        error_type: None,
        message: None,
        error_code: None,
        error_source: None,
        retryable: None,
    }
}

#[tauri::command]
pub async fn run_ssh_command(
    app: tauri::AppHandle,
    payload: SshRequest,
) -> Result<CommandRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_ssh_command_sync(app, payload))
        .await
        .map_err(|e| format!("Task panicked: {e}"))
}

pub(crate) fn run_ssh_command_sync(app: tauri::AppHandle, payload: SshRequest) -> CommandRunResult {
    let started_at = Instant::now();
    let mut result = (|| {
        if payload.command.trim().is_empty() {
            return failed_result(
                started_at,
                "command is required".to_string(),
                "validation",
                "validation_error",
                "client",
                false,
            );
        }

        let address = format!("{}:{}", payload.host, payload.port);
        let addr = match address.to_socket_addrs().and_then(|mut a| {
            a.next()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "No addresses"))
        }) {
            Ok(a) => a,
            Err(err) => {
                return failed_result(
                    started_at,
                    format!("DNS resolve failed: {err}"),
                    "network",
                    "network_error",
                    "ssh",
                    true,
                )
            }
        };
        let tcp = match TcpStream::connect_timeout(
            &addr,
            Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS),
        ) {
            Ok(tcp) => tcp,
            Err(err) => {
                return failed_result(
                    started_at,
                    format!("TCP connect failed: {err}"),
                    "network",
                    "network_error",
                    "ssh",
                    true,
                )
            }
        };
        tcp.set_nodelay(true).ok();
        tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
        tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();

        let mut session = match Session::new() {
            Ok(session) => session,
            Err(err) => {
                return failed_result(
                    started_at,
                    format!("Create SSH session failed: {err}"),
                    "internal",
                    "session_create_failed",
                    "ssh",
                    true,
                )
            }
        };
        session.set_tcp_stream(tcp);
        if let Err(err) = session.handshake() {
            return failed_result(
                started_at,
                format_ssh_handshake_error(&err.to_string()),
                "network",
                "handshake_failed",
                "ssh",
                true,
            );
        }

        let auth_error = match payload.auth_type.as_str() {
            "password" => {
                let Some(password) = payload.password.as_deref() else {
                    return failed_result(
                        started_at,
                        "password is required for password auth".to_string(),
                        "validation",
                        "validation_error",
                        "client",
                        false,
                    );
                };
                session
                    .userauth_password(&payload.username, password)
                    .err()
                    .map(|err| format!("Password auth failed: {err}"))
            }
            "privateKey" => {
                let Some(private_key) = payload.private_key.as_deref() else {
                    return failed_result(
                        started_at,
                        "privateKey is required for private key auth".to_string(),
                        "validation",
                        "validation_error",
                        "client",
                        false,
                    );
                };
                session
                    .userauth_pubkey_memory(
                        &payload.username,
                        None,
                        private_key,
                        payload.passphrase.as_deref(),
                    )
                    .err()
                    .map(|err| format!("Private key auth failed: {err}"))
            }
            _ => {
                return failed_result(
                    started_at,
                    "Unsupported authType. Use password or privateKey.".to_string(),
                    "validation",
                    "validation_error",
                    "client",
                    false,
                )
            }
        };

        if let Some(message) = auth_error {
            return failed_result(started_at, message, "auth", "auth_failed", "ssh", false);
        }

        if !session.authenticated() {
            return failed_result(
                started_at,
                "SSH authentication failed".to_string(),
                "auth",
                "auth_failed",
                "ssh",
                false,
            );
        }

        let mut channel = match session.channel_session() {
            Ok(channel) => channel,
            Err(err) => {
                return failed_result(
                    started_at,
                    format!("Open channel failed: {err}"),
                    "command",
                    "open_channel_failed",
                    "ssh",
                    true,
                )
            }
        };

        if let Err(err) = channel.exec(&payload.command) {
            return failed_result(
                started_at,
                format!("Execute command failed: {err}"),
                "command",
                "execute_failed",
                "ssh",
                false,
            );
        }

        let mut stdout = String::new();
        if let Err(err) = channel.read_to_string(&mut stdout) {
            return failed_result(
                started_at,
                format!("Read stdout failed: {err}"),
                "command",
                "read_stdout_failed",
                "ssh",
                true,
            );
        }

        let mut stderr = String::new();
        if let Err(err) = channel.stderr().read_to_string(&mut stderr) {
            return failed_result(
                started_at,
                format!("Read stderr failed: {err}"),
                "command",
                "read_stderr_failed",
                "ssh",
                true,
            );
        }

        if let Err(err) = channel.wait_close() {
            return failed_result(
                started_at,
                format!("Wait channel close failed: {err}"),
                "command",
                "wait_close_failed",
                "ssh",
                true,
            );
        }

        let exit_code = match channel.exit_status() {
            Ok(code) => code,
            Err(err) => {
                return failed_result(
                    started_at,
                    format!("Read exit code failed: {err}"),
                    "command",
                    "read_exit_code_failed",
                    "ssh",
                    true,
                )
            }
        };

        CommandRunResult {
            stdout,
            stderr,
            exit_code,
            duration_ms: started_at.elapsed().as_millis(),
            error_type: if exit_code == 0 {
                None
            } else {
                Some("command".to_string())
            },
            error_code: if exit_code == 0 {
                None
            } else {
                Some("remote_command_failed".to_string())
            },
            error_source: if exit_code == 0 {
                None
            } else {
                Some("remote".to_string())
            },
            retryable: if exit_code == 0 { None } else { Some(false) },
        }
    })();

    if let Err(err) = append_history(&app, &payload, &result) {
        let append_message = format!("Persist history failed: {err}");
        if result.stderr.is_empty() {
            result.stderr = append_message;
        } else {
            result.stderr = format!("{}\n{append_message}", result.stderr);
        }
        if result.error_type.is_none() {
            result.error_type = Some("internal".to_string());
            result.error_code = Some("history_persist_failed".to_string());
            result.error_source = Some("storage".to_string());
            result.retryable = Some(true);
        }
    }

    result
}
