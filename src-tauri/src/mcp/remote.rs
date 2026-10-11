use super::policy::Client;
use crate::data::hosts::HostProfile;
use crate::vault::secrets::{get_secret_value, VaultState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::Manager;

const OUTPUT_LIMIT: usize = 256 * 1024;
const PROBE: &str = include_str!("probe.sh");

fn connect(
    app: &tauri::AppHandle,
    client: &Client,
    host: &HostProfile,
) -> Result<(ssh2::Session, String), String> {
    if host
        .jump_host
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Err("JUMP_HOST_UNSUPPORTED: MCP v1 does not bypass a configured jump host".into());
    }
    let vault = app.state::<VaultState>();
    if !vault.is_unlocked(&client.vault_id) {
        return Err("VAULT_LOCKED: unlock this vault in ShellBeam".into());
    }
    let secret_ref = match host.auth_type.as_str() {
        "password" => host.password_key_ref.as_deref(),
        "privateKey" => host.private_key_ref.as_deref(),
        _ => return Err("UNSUPPORTED_AUTH_TYPE".into()),
    }
    .filter(|s| !s.trim().is_empty())
    .or(host.secret_key_ref.as_deref())
    .ok_or("MISSING_CREDENTIAL")?;
    let secret =
        get_secret_value(app, &vault, &client.vault_id, secret_ref)?.ok_or("MISSING_CREDENTIAL")?;
    let session = crate::ssh::connect_and_authenticate(
        &host.address,
        host.port,
        &host.username,
        &host.auth_type,
        (host.auth_type == "password").then_some(secret.as_str()),
        (host.auth_type == "privateKey").then_some(secret.as_str()),
        None,
        Some(app),
        false,
    )?;
    // A lock/revocation during the handshake must not permit starting an operation.
    super::recheck(app, client, host)?;
    if !vault.is_unlocked(&client.vault_id) {
        return Err("VAULT_LOCKED".into());
    }
    Ok((session, secret))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn bounded_append(target: &mut Vec<u8>, bytes: &[u8]) -> bool {
    let remaining = OUTPUT_LIMIT.saturating_sub(target.len());
    target.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    bytes.len() > remaining
}

fn would_block(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
}

fn command(session: &ssh2::Session, text: &str, timeout: u64) -> Result<Value, String> {
    let start = Instant::now();
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel
        .exec(text)
        .map_err(|e| format!("EXECUTION_UNKNOWN: {e}; verify before retrying"))?;
    session.set_blocking(false);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        if start.elapsed() >= Duration::from_secs(timeout) {
            return Ok(
                json!({"status":"unknown","reason":"TIMEOUT", "stdout":String::from_utf8_lossy(&stdout),
                "stderr":String::from_utf8_lossy(&stderr),"truncated":truncated,
                "notice":"SSH channel closed; the remote command may still be running. Verify before retrying."}),
            );
        }
        // Drain both streams on each pass so a full stderr window cannot deadlock stdout.
        let mut got_data = false;
        let mut disconnected = false;
        for (stream, bytes) in [(0, &mut stdout), (1, &mut stderr)] {
            match channel.stream(stream).read(&mut buffer) {
                Ok(0) => {}
                Ok(count) => {
                    got_data = true;
                    truncated |= bounded_append(bytes, &buffer[..count]);
                }
                Err(e) if would_block(&e) => {}
                Err(_) => {
                    disconnected = true;
                    break;
                }
            }
        }
        if disconnected {
            return Ok(json!({"status":"unknown","reason":"CONNECTION_LOST",
            "stdout":String::from_utf8_lossy(&stdout),"stderr":String::from_utf8_lossy(&stderr),"truncated":truncated}));
        }
        if channel.eof() && !got_data {
            break;
        }
        if !got_data {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    session.set_blocking(true);
    session.set_timeout(3000);
    channel
        .wait_close()
        .map_err(|_| "EXECUTION_UNKNOWN: cannot confirm command completion")?;
    let exit = channel
        .exit_status()
        .map_err(|_| "EXECUTION_UNKNOWN: exit status unavailable")?;
    Ok(
        json!({"status":if exit == 0 {"completed"} else {"failed"}, "exitCode":exit,
        "stdout":String::from_utf8_lossy(&stdout),"stderr":String::from_utf8_lossy(&stderr),
        "durationMs":start.elapsed().as_millis() as u64,"truncated":truncated}),
    )
}

pub fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path == "/"
        || path.contains('\0')
        || path.split('/').any(|part| part == "..")
    {
        return Err("INVALID_PATH: use an absolute remote file path without '..'".into());
    }
    Ok(())
}

fn file_operation(
    session: &ssh2::Session,
    tool: &str,
    args: &Value,
    secret: &str,
) -> Result<Value, String> {
    let path = args["path"].as_str().ok_or("INVALID_PATH")?;
    validate_path(path)?;
    session.set_timeout(10_000);
    let sftp = session.sftp().map_err(|e| e.to_string())?;
    let path = Path::new(path);
    if tool == "read_remote_file" {
        if !sftp.stat(path).map_err(|e| e.to_string())?.is_file() {
            return Err("NOT_A_REGULAR_FILE".into());
        }
        let mut file = sftp.open(path).map_err(|e| e.to_string())?;
        let stat = file.stat().map_err(|e| e.to_string())?;
        if !stat.is_file() {
            return Err("NOT_A_REGULAR_FILE".into());
        }
        let offset = args["offset"].as_u64().unwrap_or(0);
        let length = args["length"].as_u64().unwrap_or(65536).min(131072);
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        file.take(length)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if !secret.is_empty()
            && data
                .windows(secret.len())
                .any(|window| window == secret.as_bytes())
        {
            return Err("SENSITIVE_CONTENT: file contains the connection credential".into());
        }
        let next = offset + data.len() as u64;
        return Ok(
            json!({"status":"completed","dataBase64":STANDARD.encode(&data),"offset":offset,
            "nextOffset":next,"eof":stat.size.is_some_and(|size| next >= size),"sizeBytes":stat.size,
            "untrustedContent":true}),
        );
    }
    let bytes = if tool == "upload_file" {
        STANDARD
            .decode(args["contentBase64"].as_str().ok_or("MISSING_CONTENT")?)
            .map_err(|_| "INVALID_BASE64")?
    } else {
        args["content"]
            .as_str()
            .ok_or("MISSING_CONTENT")?
            .as_bytes()
            .to_vec()
    };
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("FILE_TOO_LARGE".into());
    }
    let overwrite = args["overwrite"].as_bool().unwrap_or(false);
    if !overwrite && sftp.lstat(path).is_ok() {
        return Err("FILE_EXISTS: explicit overwrite=true is required".into());
    }
    let parent = path.parent().ok_or("INVALID_PATH")?;
    let temporary = parent.join(format!(".shellbeam-mcp-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = sftp
            .open_mode(
                &temporary,
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                0o600,
                ssh2::OpenType::File,
            )
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.close().map_err(|e| e.to_string())?;
        let flags = if overwrite {
            ssh2::RenameFlags::OVERWRITE
        } else {
            ssh2::RenameFlags::empty()
        };
        sftp.rename(&temporary, path, Some(flags)).map_err(|e| {
            format!("WRITE_OUTCOME_UNKNOWN: {e}; inspect destination before retrying")
        })?;
        Ok(json!({"status":"completed","bytesWritten":bytes.len(),"permissions":"0600"}))
    })();
    if result.is_err() {
        let _ = sftp.unlink(&temporary);
    }
    result
}

pub fn run(
    app: &tauri::AppHandle,
    client: &Client,
    host: &HostProfile,
    tool: &str,
    args: &Value,
) -> Result<Value, String> {
    if tool == "refresh_server_info" {
        if let Some(mut cached) = super::store::read_probe(
            app,
            &client.vault_id,
            &host.id,
            &super::policy::identity(host),
        )? {
            let age = crate::storage::now_unix_ms() - cached["sampledAt"].as_i64().unwrap_or(0);
            if (0..30_000).contains(&age) {
                super::recheck(app, client, host)?;
                cached["cached"] = json!(true);
                return Ok(cached);
            }
        }
    }
    let started_at = Instant::now();
    let (session, secret) = connect(app, client, host)?;
    let result = match tool {
        "run_command" => command(
            &session,
            args["command"].as_str().unwrap(),
            args["timeoutSeconds"].as_u64().unwrap_or(90),
        ),
        "refresh_server_info" => command(&session, &format!("/bin/sh -c {}", quote(PROBE)), 60)
            .and_then(|output| {
                if output["status"] != "completed" || output["truncated"] == true {
                    return Err(
                        "PROBE_FAILED: missing or truncated inventory; previous data retained"
                            .into(),
                    );
                }
                parse_probe(output["stdout"].as_str().unwrap_or(""))
            }),
        _ => file_operation(&session, tool, args, &secret),
    };
    // Mask known credential values; arbitrary application output is not a secret-free sandbox.
    result
        .map(|mut value| {
            if tool == "refresh_server_info" {
                value["latencyMs"] = json!(started_at.elapsed().as_millis() as u64);
            }
            redact(value, &secret)
        })
        .map_err(|error| {
            if secret.is_empty() {
                error
            } else {
                error.replace(&secret, "[REDACTED]")
            }
        })
}

fn redact(value: Value, secret: &str) -> Value {
    match value {
        Value::String(text) if !secret.is_empty() => {
            Value::String(text.replace(secret, "[REDACTED]"))
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact(value, secret))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, redact(value, secret)))
                .collect(),
        ),
        other => other,
    }
}

fn parse_probe(output: &str) -> Result<Value, String> {
    if !output.lines().any(|line| line == "__SB_MCP_BEGIN")
        || !output.lines().any(|line| line == "__SB_MCP_END")
    {
        return Err("PROBE_INCOMPLETE".into());
    }
    let mut capacity = Map::new();
    let mut disks = Vec::new();
    let mut inodes = Vec::new();
    let mut ports = Vec::new();
    let mut tools = Vec::new();
    let mut containers = Vec::new();
    let mut services = Vec::new();
    let mut projects = Vec::new();
    for line in output.lines() {
        let Some((key, value)) = line
            .strip_prefix("__SB_MCP_")
            .and_then(|line| line.split_once('='))
        else {
            continue;
        };
        let parts: Vec<_> = value.split_whitespace().collect();
        match key {
            "ARCH" | "HOSTNAME" | "OS" | "KERNEL" => {
                capacity.insert(key.to_ascii_lowercase(), json!(value.trim_matches('"')));
            }
            "CPU" => {
                capacity.insert(
                    "cpuPercent".into(),
                    value
                        .parse::<f64>()
                        .ok()
                        .filter(|v| v.is_finite())
                        .map_or(Value::Null, |v| json!(v.clamp(0.0, 100.0))),
                );
            }
            "NETWORK" => {
                for (index, field) in ["networkRxBytesPerSec", "networkTxBytesPerSec"]
                    .iter()
                    .enumerate()
                {
                    capacity.insert(
                        (*field).into(),
                        parts
                            .get(index)
                            .and_then(|v| v.parse::<f64>().ok())
                            .filter(|v| v.is_finite() && *v >= 0.0)
                            .map_or(Value::Null, |v| json!(v)),
                    );
                }
            }
            "CORES" | "UPTIME" => {
                capacity.insert(
                    if key == "CORES" {
                        "cpuCores"
                    } else {
                        "uptimeSeconds"
                    }
                    .into(),
                    value
                        .parse::<f64>()
                        .ok()
                        .filter(|v| v.is_finite() && *v >= 0.0)
                        .map_or(Value::Null, |v| json!(v)),
                );
            }
            "MEM" if parts.len() == 2 => {
                let field = match parts[0] {
                    "MemTotal:" => "memoryTotalBytes",
                    "MemAvailable:" => "memoryAvailableBytes",
                    "SwapTotal:" => "swapTotalBytes",
                    "SwapFree:" => "swapFreeBytes",
                    _ => continue,
                };
                capacity.insert(
                    field.into(),
                    parts[1]
                        .parse::<u64>()
                        .ok()
                        .and_then(|v| v.checked_mul(1024))
                        .map_or(Value::Null, |v| json!(v)),
                );
            }
            "LOAD" => {
                capacity.insert(
                    "load".into(),
                    json!(parts
                        .iter()
                        .take(3)
                        .map(|v| v.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0))
                        .collect::<Vec<_>>()),
                );
            }
            "DISK" | "INODE" if parts.len() >= 6 && parts[1].parse::<u64>().is_ok() => {
                let multiplier = if key == "DISK" { 1024 } else { 1 };
                let number = |index: usize| {
                    parts[index]
                        .parse::<u64>()
                        .ok()
                        .and_then(|v| v.checked_mul(multiplier))
                };
                let item = json!({"device":parts[0],"mount":parts[5..].join(" "),"total":number(1),"used":number(2),"available":number(3),"usedPercent":parts[4].trim_end_matches('%').parse::<f64>().ok().filter(|v|v.is_finite()).map(|v|v.clamp(0.0,100.0)),"unit":if key == "DISK" {"bytes"} else {"inodes"}});
                if key == "DISK" {
                    disks.push(item);
                } else {
                    inodes.push(item);
                }
            }
            "PORT" => ports.push(json!(value)),
            "TOOL" if parts.len() == 2 => {
                tools.push(json!({"name":parts[0],"path":parts[1],"version":null}))
            }
            "CONTAINER" => {
                if let Ok(container) = serde_json::from_str::<Value>(value) {
                    containers.push(container);
                }
            }
            "SERVICE" => services.push(json!(value)),
            "PROJECT" => {
                projects.push(json!({"manifestPath":value,"status":"detected","verified":false}))
            }
            _ => {}
        }
    }
    Ok(
        json!({"status":"completed","source":"ssh-on-demand","sampledAt":crate::storage::now_unix_ms(),
        "capacity":capacity,"filesystems":disks,"inodes":inodes,"listeningPorts":ports,"tools":tools,
        "containers":containers,"services":services,"projects":projects,"untrustedContent":true,
        "completeness":"partial", "limitations":["Optional tools or permissions may be unavailable; empty lists do not prove absence.",
        "At most 100 filesystems, 200 listening sockets/services, 100 containers/manifests; project depth limited to 3.",
        "Runtime versions and project health must be verified separately; this scan does not execute project code."]}),
    )
}

pub(super) fn monitor_snapshot(probe: &Value) -> Value {
    let capacity = &probe["capacity"];
    let total = capacity["memoryTotalBytes"].as_u64().filter(|v| *v > 0);
    let available = capacity["memoryAvailableBytes"].as_u64();
    let used = total
        .zip(available)
        .map(|(total, available)| total.saturating_sub(available));
    let percent = used
        .zip(total)
        .map(|(used, total)| 100.0 * used as f64 / total as f64);
    let root = probe["filesystems"]
        .as_array()
        .and_then(|disks| disks.iter().find(|disk| disk["mount"] == "/"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({"hostname":capacity["hostname"].as_str().unwrap_or(""),"os":capacity["os"].as_str().unwrap_or(""),
        "kernel":capacity["kernel"].as_str().unwrap_or(""),"uptimeSeconds":capacity["uptimeSeconds"],
        "cpuPercent":capacity["cpuPercent"],"cpuCores":capacity["cpuCores"],
        "load1":capacity["load"][0],"load5":capacity["load"][1],"load15":capacity["load"][2],
        "memoryUsedBytes":used,"memoryTotalBytes":total,"memoryPercent":percent,
        "diskTotalBytes":root["total"],"diskUsedBytes":root["used"],"diskPercent":root["usedPercent"],
        "networkRxBytesPerSec":capacity["networkRxBytesPerSec"],"networkTxBytesPerSec":capacity["networkTxBytesPerSec"],
        "latencyMs":probe["latencyMs"],"sampledAt":probe["sampledAt"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_is_bounded_partial_and_numeric() {
        assert!(parse_probe("").is_err());
        let result = parse_probe("__SB_MCP_BEGIN\n__SB_MCP_CORES=4\n__SB_MCP_MEM=MemAvailable: 1024\n__SB_MCP_DISK=/dev/sda 100 20 75 20% /\n__SB_MCP_END\n").unwrap();
        assert_eq!(result["capacity"]["cpuCores"], 4.0);
        assert_eq!(result["capacity"]["memoryAvailableBytes"], 1048576);
        assert_eq!(result["filesystems"][0]["available"], 76800);
        assert_eq!(result["completeness"], "partial");
        assert!(result["capacity"].get("memoryTotalBytes").is_none());
        for forbidden in ["sudo ", "apt ", "yum ", "restart", " > ", "source "] {
            assert!(!PROBE.contains(forbidden));
        }
    }
    #[test]
    fn limits_and_path_validation() {
        assert!(validate_path("/srv/app/config.json").is_ok());
        for path in ["config.json", "/", "/srv/../etc/passwd", "/tmp/\0"] {
            assert!(validate_path(path).is_err());
        }
        let mut output = vec![0; OUTPUT_LIMIT - 1];
        assert!(bounded_append(&mut output, b"abcd"));
        assert_eq!(output.len(), OUTPUT_LIMIT);
        assert_eq!(
            redact(json!({"stdout":"my secret"}), "secret")["stdout"],
            "my [REDACTED]"
        );
    }

    #[test]
    fn missing_probe_metrics_stay_null_in_shared_history() {
        let probe = parse_probe("__SB_MCP_BEGIN\n__SB_MCP_MEM=MemTotal: 2048\n__SB_MCP_MEM=MemAvailable: 1024\n__SB_MCP_CPU=500\n__SB_MCP_END\n").unwrap();
        let snapshot = monitor_snapshot(&probe);
        assert_eq!(snapshot["cpuPercent"], 100.0);
        assert_eq!(snapshot["memoryTotalBytes"], 2097152);
        assert_eq!(snapshot["memoryUsedBytes"], 1048576);
        assert_eq!(snapshot["memoryPercent"], 50.0);
        assert!(snapshot["diskPercent"].is_null());
        assert!(snapshot["load1"].is_null());
        assert!(snapshot["networkRxBytesPerSec"].is_null());
    }
}
