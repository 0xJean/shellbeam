//! Phase C: Port forwarding rules - local and remote SSH tunnels.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use uuid::Uuid;

use crate::error::standard_error_from_raw;
use crate::hosts::load_hosts;
use crate::storage::{data_file_path, now_unix_ms, read_json_or_default, write_json};
use crate::vaults_meta;

fn port_forward_rules_file(vault_id: Option<&str>) -> String {
    let suffix = vaults_meta::vault_storage_suffix(vault_id);
    format!("port_forward_rules{suffix}.json")
}

fn write_temp_private_key(app: &tauri::AppHandle, private_key: &str) -> Result<std::path::PathBuf, String> {
    let key_path = data_file_path(app, &format!("port_forward_{}.key", Uuid::new_v4()))?;
    fs::write(&key_path, private_key).map_err(|e| format!("Write temp key failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&key_path, permissions).map_err(|e| format!("Set key permissions failed: {e}"))?;
    }
    Ok(key_path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRule {
    pub id: String,
    pub host_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub rule_type: String, // "local" | "remote"
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRuleDraft {
    pub host_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub rule_type: String,
    pub bind_host: Option<String>,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

lazy_static::lazy_static! {
    static ref RUNNING_TUNNELS: Mutex<HashMap<String, (Child, std::path::PathBuf)>> = Mutex::new(HashMap::new());
}

fn load_rules(app: &tauri::AppHandle, vault_id: Option<&str>) -> Result<Vec<PortForwardRule>, String> {
    let file = port_forward_rules_file(vault_id);
    let path = data_file_path(app, &file)?;
    read_json_or_default::<Vec<PortForwardRule>>(&path)
}

fn save_rules(app: &tauri::AppHandle, rules: &[PortForwardRule], vault_id: Option<&str>) -> Result<(), String> {
    let file = port_forward_rules_file(vault_id);
    let path = data_file_path(app, &file)?;
    write_json(&path, rules)
}

#[tauri::command]
pub fn list_port_forward_rules(
    app: tauri::AppHandle,
    vault_id: Option<String>,
) -> Result<Vec<PortForwardRule>, String> {
    load_rules(&app, vault_id.as_deref())
}

#[tauri::command]
pub fn add_port_forward_rule(
    app: tauri::AppHandle,
    payload: PortForwardRuleDraft,
    vault_id: Option<String>,
) -> Result<PortForwardRule, String> {
    let rule_type = payload.rule_type.to_lowercase();
    if rule_type != "local" && rule_type != "remote" && rule_type != "dynamic" {
        return Err("rule_type must be 'local', 'remote', or 'dynamic'".to_string());
    }
    let vid = vault_id.as_deref();
    let now = now_unix_ms();
    let mut rules = load_rules(&app, vid)?;
    let rule = PortForwardRule {
        id: Uuid::new_v4().to_string(),
        host_id: payload.host_id,
        name: payload.name.trim().to_string(),
        rule_type,
        bind_host: payload.bind_host.unwrap_or_else(|| "127.0.0.1".to_string()),
        bind_port: payload.bind_port,
        target_host: payload.target_host.trim().to_string(),
        target_port: payload.target_port,
        created_at: now,
        updated_at: now,
    };
    rules.push(rule.clone());
    save_rules(&app, &rules, vid)?;
    Ok(rule)
}

#[tauri::command]
pub fn delete_port_forward_rule(
    app: tauri::AppHandle,
    rule_id: String,
    vault_id: Option<String>,
) -> Result<(), String> {
    stop_port_forward_tunnel(rule_id.clone())?;
    let vid = vault_id.as_deref();
    let mut rules = load_rules(&app, vid)?;
    rules.retain(|r| r.id != rule_id);
    save_rules(&app, &rules, vid)
}

#[tauri::command]
pub fn start_port_forward_tunnel(
    app: tauri::AppHandle,
    rule_id: String,
    private_key: String,
    vault_id: Option<String>,
) -> Result<(), String> {
    let vid = vault_id.as_deref();
    let rules = load_rules(&app, vid)?;
    let rule = rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| "Rule not found".to_string())?;

    let hosts = load_hosts(&app, vid).map_err(|e| standard_error_from_raw("port_forward", "load hosts", e))?;
    let host = hosts
        .iter()
        .find(|h| h.id == rule.host_id)
        .ok_or_else(|| "Host not found".to_string())?;

    if host.auth_type != "privateKey" {
        return Err("Port forwarding requires private key authentication".to_string());
    }

    if private_key.trim().is_empty() {
        return Err("Private key is required".to_string());
    }

    let (ssh_flag, spec) = match rule.rule_type.as_str() {
        "local" => (
            "-L",
            format!("{}:{}:{}:{}", rule.bind_host, rule.bind_port, rule.target_host, rule.target_port),
        ),
        "remote" => (
            "-R",
            format!("{}:{}:{}:{}", rule.bind_host, rule.bind_port, rule.target_host, rule.target_port),
        ),
        "dynamic" => (
            "-D",
            format!("{}:{}", rule.bind_host, rule.bind_port),
        ),
        _ => return Err("Invalid rule type".to_string()),
    };

    let key_path = write_temp_private_key(&app, &private_key)
        .map_err(|e| standard_error_from_raw("port_forward", "write temp key", e))?;

    let host_addr = host.address.clone();
    let host_port = host.port;
    let username = host.username.clone();
    let rule_id_clone = rule_id.clone();

    thread::spawn(move || {
        let child = match Command::new("ssh")
            .arg("-N")
            .arg(ssh_flag)
            .arg(&spec)
            .arg("-p")
            .arg(host_port.to_string())
            .arg("-i")
            .arg(&key_path)
            .arg("-o")
            .arg("StrictHostKeyChecking=no")
            .arg("-o")
            .arg("UserKnownHostsFile=/dev/null")
            .arg(format!("{}@{}", username, host_addr))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("Port forward spawn failed: {e}");
                let _ = std::fs::remove_file(&key_path);
                return;
            }
        };

        if let Ok(mut map) = RUNNING_TUNNELS.lock() {
            map.insert(rule_id_clone.clone(), (child, key_path.clone()));
        }

        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if let Ok(mut map) = RUNNING_TUNNELS.lock() {
                if let Some((ref mut c, _)) = map.get_mut(&rule_id_clone) {
                    if c.try_wait().ok().flatten().is_some() {
                        map.remove(&rule_id_clone);
                        drop(map);
                        let _ = std::fs::remove_file(&key_path);
                        break;
                    }
                } else {
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_port_forward_tunnel(rule_id: String) -> Result<(), String> {
    let mut map = RUNNING_TUNNELS
        .lock()
        .map_err(|_| "Failed to lock tunnel map".to_string())?;
    if let Some((mut child, key_path)) = map.remove(&rule_id) {
        let _ = child.kill();
        let _ = std::fs::remove_file(&key_path);
        Ok(())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn port_forward_tunnel_status(rule_id: String) -> Result<bool, String> {
    let map = RUNNING_TUNNELS
        .lock()
        .map_err(|_| "Failed to lock tunnel map".to_string())?;
    Ok(map.contains_key(&rule_id))
}
