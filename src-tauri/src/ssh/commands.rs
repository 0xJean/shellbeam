use super::transport::{self, Connection, Route};
use super::{failed_result, CommandRunResult, ConnectionTestResult, SshRequest};
use crate::collection_limits::limits;
use crate::history::append_history;
use serde_json::Value;
use std::io::Read;
use std::time::{Duration, Instant};

pub fn remote_output_limit() -> usize {
    limits().remote.output_bytes
}

fn command_timeout(requested_ms: Option<u64>) -> Duration {
    // Workspace probes can shorten their deadline, never extend the desktop
    // one-shot command ceiling. Explicit MCP tasks have a separate budget.
    Duration::from_millis(
        requested_ms
            .unwrap_or(limits().remote.command_timeout_ms)
            .clamp(
                limits().remote.min_command_timeout_ms,
                limits().remote.command_timeout_ms,
            ),
    )
}

fn route(app: &tauri::AppHandle, payload: &SshRequest) -> Result<(Route, Value), String> {
    if let Some(host_id) = payload
        .host_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    {
        if let Some(vault_id) = payload.vault_id.as_deref() {
            return transport::resolve_host_route_with_identity(app, vault_id, host_id);
        }
    }
    let route = transport::legacy_route(
        payload.vault_id.as_deref(),
        &payload.host,
        payload.port,
        &payload.username,
        &payload.auth_type,
        payload.password.as_deref(),
        payload.private_key.as_deref(),
        payload.passphrase.as_deref(),
        payload.jump_host.as_deref(),
        payload.jump_port,
        payload.jump_user.as_deref(),
    );
    let id = payload
        .host_id
        .clone()
        .unwrap_or_else(|| format!("{}@{}:{}", payload.username, payload.host, payload.port));
    let identity = transport::route_identity(&route, &id, None);
    Ok((route, identity))
}

fn connection_failure(start: Instant, error: String) -> CommandRunResult {
    let data = serde_json::from_str::<Value>(&error).ok();
    let code = data
        .as_ref()
        .and_then(|value| value["code"].as_str())
        .unwrap_or(&error);
    let stage = data
        .as_ref()
        .and_then(|value| value["source"].as_str())
        .unwrap_or("ssh");
    let kind = if code.contains("auth")
        || code.contains("CREDENTIAL")
        || code.contains("credential")
    {
        "auth"
    } else if code.contains("host_key") || code.contains("VAULT") || code.contains("HOST_NOT_FOUND")
    {
        "validation"
    } else {
        "network"
    };
    failed_result(start, error.clone(), kind, code, stage, false)
}

#[tauri::command]
pub async fn test_ssh_connection(
    app: tauri::AppHandle,
    payload: SshRequest,
) -> Result<ConnectionTestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        match route(&app, &payload).and_then(|(route, _)| transport::connect(&app, &route)) {
            Ok(_) => ConnectionTestResult {
                connected: true,
                duration_ms: start.elapsed().as_millis(),
                error_type: None,
                message: None,
                error_code: None,
                error_source: None,
                retryable: None,
            },
            Err(error) => {
                let failed = connection_failure(start, error);
                ConnectionTestResult {
                    connected: false,
                    duration_ms: failed.duration_ms,
                    error_type: failed.error_type,
                    message: Some(failed.stderr),
                    error_code: failed.error_code,
                    error_source: failed.error_source,
                    retryable: failed.retryable,
                }
            }
        }
    })
    .await
    .map_err(|error| format!("SSH task failed: {error}"))
}

#[tauri::command]
pub async fn run_ssh_command(
    app: tauri::AppHandle,
    payload: SshRequest,
) -> Result<CommandRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_ssh_command_sync(app, payload))
        .await
        .map_err(|error| format!("SSH task failed: {error}"))
}

pub(crate) fn run_ssh_command_sync(app: tauri::AppHandle, payload: SshRequest) -> CommandRunResult {
    let start = Instant::now();
    if payload.command.trim().is_empty() {
        return failed_result(
            start,
            "command is required".into(),
            "validation",
            "validation_error",
            "client",
            false,
        );
    }
    let result = match route(&app, &payload).and_then(|(route, identity)| {
        transport::connect(&app, &route).map(|connection| (connection, identity))
    }) {
        Ok((connection, identity)) => {
            match transport::ensure_vault_unlocked(&app, payload.vault_id.as_deref()) {
                Ok(()) => {
                    let mut result = execute(
                        connection,
                        &payload.command,
                        start,
                        command_timeout(payload.timeout_ms),
                    );
                    if result.verified_host_keys.is_some() {
                        result.host_identity = Some(identity);
                    }
                    result
                }
                Err(error) => connection_failure(start, error),
            }
        }
        Err(error) => connection_failure(start, error),
    };
    // Saved-host operations have their own bounded OperationJob journal. Do
    // not persist background commands, provider output or credentials there.
    if payload.vault_id.is_none() {
        let _ = append_history(&app, &payload, &result);
    }
    result
}

pub fn execute(
    connection: Connection,
    command: &str,
    start: Instant,
    timeout: Duration,
) -> CommandRunResult {
    if start.elapsed() >= timeout {
        return failed_result(
            start,
            "Command deadline elapsed before execution; no command was sent".into(),
            "network",
            "target_timeout_before_execution",
            "target",
            false,
        );
    }
    let session = &connection.session;
    let mut channel = match session.channel_session() {
        Ok(channel) => channel,
        Err(error) => return connection_failure(start, error.to_string()),
    };
    if start.elapsed() >= timeout {
        return failed_result(
            start,
            "Command deadline elapsed before execution; no command was sent".into(),
            "network",
            "target_timeout_before_execution",
            "target",
            false,
        );
    }
    if channel.exec(command).is_err() {
        return failed_result(
            start,
            "Remote command acceptance is unknown; verify before retrying".into(),
            "unknown",
            "remote_state_unknown",
            "target",
            false,
        );
    }
    session.set_blocking(false);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        if start.elapsed() >= timeout {
            return failed_result(
                start,
                "Remote command outcome is unknown after timeout".into(),
                "network",
                "target_timeout",
                "target",
                false,
            );
        }
        let mut progress = false;
        for stream in 0..2 {
            let read = if stream == 0 {
                channel.read(&mut buffer)
            } else {
                channel.stderr().read(&mut buffer)
            };
            match read {
                Ok(0) => {}
                Ok(count) => {
                    if stdout.len() + stderr.len() + count > remote_output_limit() {
                        return failed_result(
                            start,
                            "Remote output limit exceeded; verify the operation before retrying"
                                .into(),
                            "unknown",
                            "output_limit",
                            "target",
                            false,
                        );
                    }
                    if stream == 0 {
                        stdout.extend_from_slice(&buffer[..count]);
                    } else {
                        stderr.extend_from_slice(&buffer[..count]);
                    }
                    progress = true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    return failed_result(
                        start,
                        "Remote command outcome is unknown after disconnect".into(),
                        "network",
                        "target_disconnected",
                        "target",
                        false,
                    )
                }
            }
        }
        if channel.eof() && !progress {
            break;
        }
        if !progress {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    session.set_blocking(true);
    session.set_timeout(3000);
    if channel.wait_close().is_err() {
        return failed_result(
            start,
            "Remote command completion is unknown".into(),
            "unknown",
            "remote_state_unknown",
            "target",
            false,
        );
    }
    match channel.exit_signal() {
        Ok(signal) if signal.exit_signal.is_none() => {}
        _ => {
            return failed_result(
                start,
                "Remote command was signaled or its exit state is unknown; verify before retrying"
                    .into(),
                "unknown",
                "remote_state_unknown",
                "target",
                false,
            )
        }
    }
    let exit_code = match channel.exit_status() {
        Ok(code) => code,
        Err(_) => {
            return failed_result(
                start,
                "Remote exit status is unknown".into(),
                "unknown",
                "remote_state_unknown",
                "target",
                false,
            )
        }
    };
    CommandRunResult {
        host_identity: None,
        verified_host_keys: Some(connection.verified_host_keys.clone()),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        duration_ms: start.elapsed().as_millis(),
        error_type: (exit_code != 0).then(|| "command".into()),
        error_code: (exit_code != 0).then(|| "remote_command_failed".into()),
        error_source: (exit_code != 0).then(|| "remote".into()),
        retryable: None,
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn caller_can_shorten_but_never_extend_desktop_command_deadline() {
        let ordinary = Duration::from_millis(limits().remote.command_timeout_ms);
        assert_eq!(command_timeout(None), ordinary);
        assert_eq!(command_timeout(Some(u64::MAX)), ordinary);
        assert_eq!(
            command_timeout(Some(0)),
            Duration::from_millis(limits().remote.min_command_timeout_ms)
        );
        assert_eq!(
            command_timeout(Some(limits().remote.collector_timeout_ms)),
            Duration::from_millis(limits().remote.collector_timeout_ms)
        );
        assert_eq!(remote_output_limit(), limits().remote.output_bytes);
    }
}
