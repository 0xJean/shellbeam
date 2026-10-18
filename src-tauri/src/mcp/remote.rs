use super::policy::Client;
use crate::collection_limits::{limits, render_probe_collector};
use crate::data::hosts::HostProfile;
use crate::vault::secrets::VaultState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::Manager;

type Connection = crate::ssh::transport::Connection;

fn has_jump_host(host: &HostProfile) -> bool {
    host.jump_host_id.is_some()
        || host
            .jump_host
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
}

fn connect(
    app: &tauri::AppHandle,
    client: &Client,
    host: &HostProfile,
) -> Result<(Connection, Vec<String>, Value), String> {
    let hosts = crate::data::hosts::load_hosts(app, Some(&client.vault_id))?;
    let route = crate::ssh::transport::route_for_host(app, &client.vault_id, host, &hosts)?;
    let mut secrets = vec![route.target.secret.clone()];
    if let Some(jump) = &route.jump {
        secrets.push(jump.secret.clone());
    }
    let identity =
        crate::ssh::transport::route_identity(&route, &host.id, host.jump_host_id.as_deref());
    let connection = crate::ssh::transport::connect(app, &route)?;
    super::recheck(app, client, host)?;
    if !app.state::<VaultState>().is_unlocked(&client.vault_id) {
        return Err("VAULT_LOCKED".into());
    }
    Ok((connection, secrets, identity))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn command(session: &ssh2::Session, text: &str, timeout: u64) -> Result<Value, String> {
    let result = crate::ssh::commands::execute(
        Connection {
            session: session.clone(),
            tunnel: None,
            verified_host_keys: Vec::new(),
        },
        text,
        Instant::now(),
        Duration::from_secs(timeout),
    );
    let uncertain = result.error_type.as_deref() == Some("unknown")
        || matches!(
            result.error_code.as_deref(),
            Some(
                "target_timeout" | "target_disconnected" | "output_limit" | "remote_state_unknown"
            )
        );
    Ok(
        json!({"status":if uncertain {"unknown"} else if result.exit_code == 0 {"completed"} else {"failed"},
        "exitCode":result.exit_code,"stdout":result.stdout,"stderr":result.stderr,
        "durationMs":result.duration_ms as u64,"truncated":result.error_code.as_deref()==Some("output_limit"),
        "reason":result.error_code,"notice":if uncertain {"Remote outcome is unknown; verify before retrying."} else {""}}),
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
    secrets: &[String],
) -> Result<Value, String> {
    let path = args["path"].as_str().ok_or("INVALID_PATH")?;
    validate_path(path)?;
    session.set_timeout(limits().remote.mcp_file_timeout_ms);
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
        let length = args["length"]
            .as_u64()
            .unwrap_or(limits().remote.mcp_file_default_read_bytes)
            .min(limits().remote.mcp_file_max_read_bytes);
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        file.take(length)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if secrets.iter().any(|secret| {
            !secret.is_empty()
                && data
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes())
        }) {
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
            if (0..limits().cadence.mcp_probe_cache_ms).contains(&age) {
                super::recheck(app, client, host)?;
                cached["cached"] = json!(true);
                return Ok(cached);
            }
        }
    }
    let started_at = Instant::now();
    let (connection, secrets, identity) = connect(app, client, host)?;
    let session = &connection.session;
    let result = match tool {
        "run_command" => command(
            &session,
            args["command"].as_str().unwrap(),
            args["timeoutSeconds"]
                .as_u64()
                .unwrap_or(limits().remote.command_timeout_ms / 1000)
                .clamp(
                    limits().remote.min_command_timeout_ms / 1000,
                    limits().remote.mcp_command_max_timeout_ms / 1000,
                ),
        ),
        "refresh_server_info" => command(
            &session,
            &format!("/bin/sh -c {}", quote(&render_probe_collector())),
            limits().remote.collector_timeout_ms / 1000,
        )
        .and_then(|output| {
            if let Some(os) = unsupported_probe_os(&output) {
                return Ok(json!({"status":"completed","unsupportedOs":os}));
            }
            if output["status"] != "completed" || output["truncated"] == true {
                return Err(
                    "PROBE_FAILED: missing or truncated inventory; previous data retained".into(),
                );
            }
            parse_probe(output["stdout"].as_str().unwrap_or(""))
        }),
        _ => file_operation(&session, tool, args, &secrets),
    };
    // Mask known credential values; arbitrary application output is not a secret-free sandbox.
    result
        .map(|mut value| {
            if tool == "refresh_server_info" {
                value["latencyMs"] = json!(started_at.elapsed().as_millis() as u64);
                // Keep MCP probe responses aligned with the shared
                // ProbeProvider contract while retaining the legacy flattened
                // capacity/inventory fields for existing clients. The
                // observation wrappers are intentionally additive so older
                // clients can continue reading `capacity`, `filesystems`,
                // and `projects` without a migration.
                attach_probe_contract(&mut value, host);
                value["host"] = identity.clone();
                value["host"]["verifiedHostKeys"] = json!(connection.verified_host_keys);
            }
            secrets
                .iter()
                .fold(value, |value, secret| redact(value, secret))
        })
        .map_err(|error| {
            secrets
                .iter()
                .filter(|secret| !secret.is_empty())
                .fold(error, |error, secret| error.replace(secret, "[REDACTED]"))
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

fn unsupported_probe_os(output: &Value) -> Option<String> {
    if output["exitCode"] != 2 || output["truncated"] == true {
        return None;
    }
    output["stdout"].as_str()?.lines().find_map(|line| {
        let os = line.strip_prefix("__SB_PROBE_UNSUPPORTED_OS=")?;
        if os.is_empty() || os.len() > 80 || os.chars().any(char::is_control) {
            return None;
        }
        Some(os.to_owned())
    })
}

fn parse_probe(output: &str) -> Result<Value, String> {
    if output.len() > limits().remote.output_bytes {
        return Err("PROBE_OUTPUT_LIMIT".into());
    }
    let canonical = output.lines().any(|line| line == "__SB_PROBE_BEGIN");
    if canonical && !output.lines().any(|line| line == "__SB_PROBE_SCHEMA=1") {
        return Err("PROBE_SCHEMA_UNSUPPORTED".into());
    }
    let output = if canonical {
        output.replace("__SB_PROBE_", "__SB_MCP_")
    } else {
        output.to_owned()
    };
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
    let mut service_details = std::collections::BTreeMap::new();
    let mut pm2 = Vec::new();
    let mut sampled_at = crate::storage::now_unix_ms();
    let mut valid_sample_time = false;
    for line in output.lines() {
        let Some((key, value)) = line
            .strip_prefix("__SB_MCP_")
            .and_then(|line| line.split_once('='))
        else {
            continue;
        };
        let parts: Vec<_> = value.split_whitespace().collect();
        match key {
            "SAMPLED_AT" => {
                if let Ok(value) = value.parse::<i64>() {
                    if value > 0 && value <= crate::storage::now_unix_ms() {
                        sampled_at = value;
                        valid_sample_time = true;
                    }
                }
            }
            "TOOLDETAIL" => {
                let fields: Vec<_> = value.split('|').collect();
                if fields.len() >= 6 && tools.len() < limits().collector.tool_rows {
                    tools.push(json!({"id":fields[0],"displayName":fields[1],"category":fields[2],"name":fields[3],"path":fields[4],"version":fields[5]}));
                }
            }
            "SERVICEDETAIL" => {
                let fields: Vec<_> = value.split('|').collect();
                if fields.len() >= 3
                    && service_details.len() < limits().collector.service_detail_rows
                {
                    service_details.insert(
                        fields[0].to_string(),
                        json!({"name":fields[0],"active":fields[1],"enabled":fields[2]}),
                    );
                }
            }
            "DOCKERDETAIL" => {
                let fields: Vec<_> = value.split('|').collect();
                if fields.len() >= 4 && containers.len() < limits().collector.container_rows {
                    containers.push(json!({"name":fields[0],"image":fields[1],"status":fields[2],"ports":fields[3],"id":fields.get(4)}));
                }
            }
            "PROJECTDETAIL" => {
                let fields: Vec<_> = value.split('|').collect();
                if fields.len() >= 4 && projects.len() < limits().collector.project_rows {
                    projects.push(json!({"path":fields[0],"kind":fields[1],"name":fields[2],"modifiedAt":fields[3],"manifestPath":fields.get(4).unwrap_or(&fields[0]),"status":"detected","verified":false}));
                }
            }
            "PM2" => {
                if pm2.len() < limits().collector.pm2_rows {
                    pm2.push(json!({"raw":value}));
                }
            }
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
                    if disks.len() < limits().collector.filesystem_rows {
                        disks.push(item);
                    }
                } else if inodes.len() < limits().collector.filesystem_rows {
                    inodes.push(item);
                }
            }
            "PORT" if ports.len() < limits().collector.port_rows => ports.push(json!(value)),
            "TOOL" if parts.len() == 2 && tools.len() < limits().collector.tool_rows => {
                tools.push(json!({"name":parts[0],"path":parts[1],"version":null}))
            }
            "CONTAINER" if containers.len() < limits().collector.container_rows => {
                if let Ok(container) = serde_json::from_str::<Value>(value) {
                    containers.push(container);
                }
            }
            "SERVICE" => {
                if services.len() < limits().collector.service_rows {
                    services.push(json!(value));
                    if parts.len() >= 3 {
                        service_details.entry(parts[0].to_string()).or_insert_with(
                            || json!({"name":parts[0],"active":parts[2],"enabled":"unknown"}),
                        );
                    }
                }
            }
            "PROJECT" if projects.len() < limits().collector.project_rows => {
                projects.push(json!({"manifestPath":value,"status":"detected","verified":false}))
            }
            _ => {}
        }
    }
    if canonical && !valid_sample_time {
        return Err("PROBE_INVALID_SAMPLE_TIME".into());
    }
    Ok(
        json!({"status":"completed","source":"ssh-on-demand","sampledAt":sampled_at,
        "capacity":capacity,"filesystems":disks,"inodes":inodes,"listeningPorts":ports,"tools":tools,
        "containers":containers,"services":services,"serviceDetails":service_details.into_values().collect::<Vec<_>>(),"pm2":pm2,"projects":projects,"untrustedContent":true,
        "completeness":"partial", "limitations":["Optional tools or permissions may be unavailable; empty lists do not prove absence.",
        format!("At most {} filesystems, {} listening sockets, {} discovered services plus curated service details, {} containers, {} manifests; project depth limited to {}.", limits().collector.filesystem_rows, limits().collector.port_rows, limits().collector.service_rows, limits().collector.container_rows, limits().collector.project_rows, limits().collector.project_depth),
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

fn probe_host_identity(host: &HostProfile) -> Value {
    let mut identity = json!({
        "hostId": host.id,
        "address": host.address,
        "port": host.port,
        "username": host.username,
    });
    if let Some(id) = &host.jump_host_id {
        // Only the native resolver can supply current referenced endpoints.
        identity["jump"] = json!({"hostId":id});
    } else if let Some(address) = host
        .jump_host
        .as_deref()
        .filter(|address| !address.trim().is_empty())
    {
        identity["jump"] = json!({"address":address.trim(),"port":host.jump_port.unwrap_or(22),"username":host.jump_user.as_deref().filter(|user| !user.trim().is_empty()).unwrap_or(&host.username)});
    }
    identity
}

fn probe_provider_ref() -> Value {
    json!({
        "kind": "ssh-agentless",
        "id": "ssh-agentless",
        "capabilities": ["metrics", "inventory"],
    })
}

fn probe_observation(
    data: Value,
    source: &Value,
    sampled_at: i64,
    received_at: i64,
    ttl_ms: i64,
    confidence: &str,
) -> Value {
    json!({
        "data": data,
        "source": source,
        "freshness": {
            "sampledAt": sampled_at,
            "receivedAt": received_at,
            "ttlMs": ttl_ms,
            "expiresAt": sampled_at.saturating_add(ttl_ms),
            "expired": received_at > sampled_at.saturating_add(ttl_ms),
        },
        "confidence": confidence,
    })
}

fn inventory_snapshot(probe: &Value, sampled_at: i64) -> Value {
    let capacity = &probe["capacity"];
    let used = capacity["memoryTotalBytes"]
        .as_u64()
        .zip(capacity["memoryAvailableBytes"].as_u64())
        .map(|(total, available)| total.saturating_sub(available));
    let root = probe["filesystems"]
        .as_array()
        .and_then(|disks| disks.iter().find(|disk| disk["mount"] == "/"));
    let number_text = |value: &Value| {
        value
            .as_u64()
            .map(|value| value.to_string())
            .or_else(|| {
                value
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .map(|value| {
                        if value.fract() == 0.0 {
                            format!("{value:.0}")
                        } else {
                            format!("{value:.2}")
                        }
                    })
            })
            .unwrap_or_default()
    };
    let tools = probe["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|tool| {
            let name = tool["name"].as_str()?.to_string();
            Some(json!({
                "id": tool["id"].as_str().unwrap_or(&name),
                "name": tool["displayName"].as_str().unwrap_or(&name),
                "category": tool["category"].as_str().unwrap_or("system"),
                "binary": tool["name"].clone(),
                "path": tool["path"].clone(),
                "version": tool.get("version").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect::<Vec<_>>();
    let services = probe.get("serviceDetails").filter(|value| value.as_array().is_some_and(|values| !values.is_empty())).unwrap_or(&probe["services"])
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|service| {
            if service.is_object() { return Some(service.clone()); }
            let value = service.as_str()?;
            let fields: Vec<_> = value.split_whitespace().collect();
            Some(json!({"name": fields.first().copied().unwrap_or_default(), "active": fields.get(2).copied().unwrap_or("unknown"), "enabled": "unknown"}))
        })
        .collect::<Vec<_>>();
    let containers = probe["containers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|container| {
            let field = |name: &str, legacy_name: &str| {
                container
                    .get(name)
                    .filter(|value| !value.is_null())
                    .cloned()
                    .or_else(|| {
                        container
                            .get(legacy_name)
                            .filter(|value| !value.is_null())
                            .cloned()
                    })
                    .unwrap_or(Value::Null)
            };
            json!({
                "name": field("name", "Names"),
                "image": field("image", "Image"),
                "status": field("status", "Status"),
                "ports": field("ports", "Ports"),
            })
        })
        .collect::<Vec<_>>();
    let projects = probe["projects"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|project| {
            let path = project["path"]
                .as_str()
                .or_else(|| project["manifestPath"].as_str())?
                .to_string();
            let name = Path::new(&path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&path)
                .to_string();
            Some(json!({
                "path": path,
                "kind": project["kind"].as_str().unwrap_or("detected"),
                "name": project["name"].as_str().unwrap_or(&name),
                "modifiedAt": project["modifiedAt"].as_str().unwrap_or_default(),
            }))
        })
        .collect::<Vec<_>>();
    json!({
        "resource": {
            "hostname": capacity["hostname"].as_str().unwrap_or_default(),
            "os": capacity["os"].as_str().unwrap_or_default(),
            "kernel": capacity["kernel"].as_str().unwrap_or_default(),
            "arch": capacity["arch"].as_str().filter(|value| !value.trim().is_empty()),
            "uptime": if capacity["uptimeSeconds"].is_number() { format!("{}s", number_text(&capacity["uptimeSeconds"])) } else { String::new() },
            "cpuPercent": capacity["cpuPercent"],
            "memoryPercent": used.zip(capacity["memoryTotalBytes"].as_u64()).and_then(|(used, total)| (total > 0).then_some(100.0 * used as f64 / total as f64)),
            "memoryText": format!("{}/{}", used.map(|value| value.to_string()).unwrap_or_default(), number_text(&capacity["memoryTotalBytes"])),
            "diskPercent": root.map(|disk| disk["usedPercent"].clone()).unwrap_or(Value::Null),
            "diskText": root.map(|disk| format!("{}/{}", number_text(&disk["used"]), number_text(&disk["total"]))).unwrap_or_default(),
            "network": format!("{}/{}", number_text(&capacity["networkRxBytesPerSec"]), number_text(&capacity["networkTxBytesPerSec"])),
        },
        "tools": tools,
        "services": services,
        "containers": containers,
        "pm2": probe["pm2"].as_array().cloned().unwrap_or_default(),
        "listeningPorts": probe["listeningPorts"],
        "filesystems": probe["filesystems"],
        "inodes": probe["inodes"],
        "projects": projects,
        "scannedAt": sampled_at,
    })
}

fn has_capacity_data(probe: &Value) -> bool {
    let Some(capacity) = probe["capacity"].as_object() else {
        return false;
    };
    [
        "hostname",
        "os",
        "kernel",
        "uptimeSeconds",
        "cpuPercent",
        "load",
        "memoryTotalBytes",
        "memoryAvailableBytes",
        "networkRxBytesPerSec",
        "networkTxBytesPerSec",
    ]
    .iter()
    .any(|key| capacity.get(*key).is_some_and(|value| !value.is_null()))
}

/// Add the canonical ProbeProvider envelope to a legacy MCP probe response.
/// The legacy fields intentionally remain untouched because MCP clients may
/// still depend on them. Freshness is measured from the remote sample marker,
/// while `receivedAt` records when ShellBeam accepted the result.
fn attach_probe_contract(value: &mut Value, host: &HostProfile) {
    let received_at = crate::storage::now_unix_ms();
    if let Some(os) = value["unsupportedOs"].as_str().map(str::to_owned) {
        value["schemaVersion"] = json!(1);
        value["host"] = probe_host_identity(host);
        value["provider"] = probe_provider_ref();
        value["transport"] = json!(if has_jump_host(host) {
            "proxy-jump"
        } else {
            "direct"
        });
        value["health"] = json!("unsupported");
        value["receivedAt"] = json!(received_at);
        value["metrics"] = Value::Null;
        value["inventory"] = Value::Null;
        value["errors"] = json!([{"section":"provider","code":"unsupported_os","message":format!("Linux metrics are unsupported on {os}")}]);
        return;
    }
    let sampled_at = value["sampledAt"].as_i64().unwrap_or(received_at);
    let provider = probe_provider_ref();
    let metrics = monitor_snapshot(value);
    let inventory = inventory_snapshot(value, sampled_at);
    let confidence = if value["completeness"] == "partial" {
        "partial"
    } else {
        "observed"
    };
    let health = if has_capacity_data(value) {
        "online"
    } else {
        "unknown"
    };
    value["schemaVersion"] = json!(1);
    value["host"] = probe_host_identity(host);
    value["provider"] = provider.clone();
    value["transport"] = json!(if has_jump_host(host) {
        "proxy-jump"
    } else {
        "direct"
    });
    value["health"] = json!(health);
    value["receivedAt"] = json!(received_at);
    value["metrics"] = probe_observation(
        metrics,
        &provider,
        sampled_at,
        received_at,
        limits().cadence.metrics_ttl_ms,
        confidence,
    );
    value["inventory"] = probe_observation(
        inventory,
        &provider,
        sampled_at,
        received_at,
        limits().cadence.inventory_ttl_ms,
        "partial",
    );
    value["errors"] = json!([]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_with_jump(auth_type: &str) -> HostProfile {
        HostProfile {
            id: "host".into(),
            name: "host".into(),
            address: "target.example.com".into(),
            port: 22,
            username: "target".into(),
            group: String::new(),
            auth_type: auth_type.into(),
            secret_key_ref: None,
            password_key_ref: None,
            private_key_ref: Some("private-key".into()),
            tags: Vec::new(),
            jump_host: Some("jump.example.com".into()),
            jump_port: Some(2200),
            jump_user: Some("bastion".into()),
            jump_host_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn shared_collector_fixture_retains_metrics_and_rich_inventory() {
        let value =
            parse_probe(include_str!("../../../shared/fixtures/linux-probe-v1.txt")).unwrap();
        assert_eq!(value["sampledAt"], 1792281600000_i64);
        let metrics = monitor_snapshot(&value);
        assert_eq!(metrics["cpuPercent"], 25.5);
        assert_eq!(metrics["memoryPercent"], 75.0);
        let inventory = inventory_snapshot(&value, 1792281600000);
        assert_eq!(inventory["tools"][0]["version"], "v22.0.0");
        assert!(inventory["services"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["name"] == "nginx.service" && row["active"] == "active"));
        assert_eq!(inventory["containers"][0]["image"], "nginx:stable");
        assert_eq!(inventory["projects"][0]["kind"], "node");
        assert_eq!(inventory["listeningPorts"].as_array().unwrap().len(), 1);
        assert_eq!(inventory["pm2"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn non_linux_probe_has_no_observations_and_preserves_unsupported_health() {
        let output = json!({"exitCode":2,"stdout":"__SB_PROBE_UNSUPPORTED_OS=Darwin\n","status":"failed","truncated":false});
        let os = unsupported_probe_os(&output).unwrap();
        let mut value = json!({"unsupportedOs":os});
        attach_probe_contract(&mut value, &host_with_jump("privateKey"));
        assert_eq!(value["health"], "unsupported");
        assert!(value["metrics"].is_null());
        assert!(value["inventory"].is_null());
        assert!(value.get("sampledAt").is_none());
        assert_eq!(value["errors"][0]["code"], "unsupported_os");
        assert!(unsupported_probe_os(
            &json!({"exitCode":1,"stdout":"__SB_PROBE_UNSUPPORTED_OS=Darwin"})
        )
        .is_none());
        assert!(unsupported_probe_os(
            &json!({"exitCode":2,"stdout":"__SB_PROBE_UNSUPPORTED_OS=Darwin","truncated":true})
        )
        .is_none());
    }

    #[test]
    fn referenced_jump_display_never_reuses_stale_copied_fields() {
        let mut host = host_with_jump("privateKey");
        host.jump_host_id = Some("edited-jump".into());
        assert_eq!(
            probe_host_identity(&host)["jump"],
            json!({"hostId":"edited-jump"})
        );
    }

    #[test]
    fn proxy_jump_accepts_single_hop_private_key_configuration() {
        let host = host_with_jump("privateKey");
        assert!(has_jump_host(&host));
    }

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
            assert!(!render_probe_collector().contains(forbidden));
        }
    }
    #[test]
    fn shared_budgets_bound_decoded_rows_and_preserve_remote_architecture() {
        let fixture = include_str!("../../../shared/fixtures/linux-probe-v1.txt");
        let mut probe = parse_probe(fixture).unwrap();
        attach_probe_contract(&mut probe, &host_with_jump("privateKey"));
        assert_eq!(probe["capacity"]["arch"], "x86_64");
        assert_eq!(probe["inventory"]["data"]["resource"]["arch"], "x86_64");
        let without_arch = fixture
            .lines()
            .filter(|line| !line.starts_with("__SB_PROBE_ARCH="))
            .collect::<Vec<_>>()
            .join("\n");
        let mut unknown = parse_probe(&without_arch).unwrap();
        attach_probe_contract(&mut unknown, &host_with_jump("privateKey"));
        assert!(unknown["inventory"]["data"]["resource"]["arch"].is_null());
        let mut rows = String::new();
        for index in 0..limits().collector.port_rows + 5 {
            rows.push_str(&format!("__SB_PROBE_PORT=tcp {index}\n"));
        }
        let bounded =
            parse_probe(&fixture.replace("__SB_PROBE_END", &format!("{rows}__SB_PROBE_END")))
                .unwrap();
        assert_eq!(
            bounded["listeningPorts"].as_array().unwrap().len(),
            limits().collector.port_rows
        );
        assert!(parse_probe(&"x".repeat(limits().remote.output_bytes + 1)).is_err());
    }
    #[test]
    fn limits_and_path_validation() {
        assert!(validate_path("/srv/app/config.json").is_ok());
        for path in ["config.json", "/", "/srv/../etc/passwd", "/tmp/\0"] {
            assert!(validate_path(path).is_err());
        }
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

    #[test]
    fn probe_contract_emits_canonical_observations_without_removing_legacy_fields() {
        let mut probe = parse_probe(
            "__SB_MCP_BEGIN\n__SB_MCP_HOSTNAME=node-1\n__SB_MCP_OS=Linux\n__SB_MCP_UPTIME=42\n__SB_MCP_CPU=25\n__SB_MCP_NETWORK=0 0\n__SB_MCP_MEM=MemTotal: 2048\n__SB_MCP_MEM=MemAvailable: 1024\n__SB_MCP_DISK=/dev/sda 100 20 75 20% /\n__SB_MCP_TOOL=systemctl /usr/bin/systemctl\n__SB_MCP_SERVICE=sshd\n__SB_MCP_PROJECT=/srv/app/package.json\n__SB_MCP_END\n",
        )
        .unwrap();
        let legacy_capacity = probe["capacity"].clone();
        attach_probe_contract(&mut probe, &host_with_jump("privateKey"));

        assert_eq!(probe["schemaVersion"], 1);
        assert_eq!(probe["transport"], "proxy-jump");
        assert_eq!(probe["provider"]["kind"], "ssh-agentless");
        assert_eq!(probe["host"]["jump"]["address"], "jump.example.com");
        assert_eq!(probe["health"], "online");
        assert_eq!(probe["capacity"], legacy_capacity);
        assert_eq!(probe["metrics"]["data"]["cpuPercent"], 25.0);
        assert_eq!(probe["metrics"]["confidence"], "partial");
        assert_eq!(
            probe["metrics"]["freshness"]["ttlMs"],
            limits().cadence.metrics_ttl_ms
        );
        assert_eq!(probe["inventory"]["data"]["resource"]["uptime"], "42s");
        assert_eq!(probe["inventory"]["data"]["resource"]["network"], "0/0");
        assert_eq!(probe["inventory"]["data"]["resource"]["hostname"], "node-1");
        assert_eq!(probe["inventory"]["data"]["services"][0]["name"], "sshd");
        assert_eq!(
            probe["inventory"]["data"]["projects"][0]["path"],
            "/srv/app/package.json"
        );
        assert_eq!(probe["errors"], json!([]));
    }

    #[test]
    fn probe_contract_marks_empty_observation_unknown() {
        let mut probe = parse_probe("__SB_MCP_BEGIN\n__SB_MCP_END\n").unwrap();
        attach_probe_contract(&mut probe, &host_with_jump("privateKey"));
        assert_eq!(probe["health"], "unknown");
        assert!(probe["metrics"]["data"]["cpuPercent"].is_null());
        assert_eq!(probe["inventory"]["confidence"], "partial");
        assert!(!probe["metrics"]["freshness"]["expiresAt"].is_null());
    }

    #[test]
    fn architecture_only_probe_does_not_claim_online_health() {
        let mut probe =
            parse_probe("__SB_MCP_BEGIN\n__SB_MCP_ARCH=x86_64\n__SB_MCP_END\n").unwrap();
        attach_probe_contract(&mut probe, &host_with_jump("privateKey"));
        assert_eq!(probe["health"], "unknown");
    }
}
