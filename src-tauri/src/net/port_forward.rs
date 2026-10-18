//! Phase C: Port forwarding rules - local and remote SSH tunnels.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

use crate::storage::{data_file_path, now_unix_ms, read_json_or_default, write_json};
use crate::vaults_meta;

fn port_forward_rules_file(vault_id: Option<&str>) -> String {
    let suffix = vaults_meta::vault_storage_suffix(vault_id);
    format!("port_forward_rules{suffix}.json")
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
    static ref RUNNING_TUNNELS: Mutex<HashMap<String, crate::ssh::forward::ForwardLease>> = Mutex::new(HashMap::new());
}

fn load_rules(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Vec<PortForwardRule>, String> {
    let file = port_forward_rules_file(vault_id);
    let path = data_file_path(app, &file)?;
    read_json_or_default::<Vec<PortForwardRule>>(&path)
}

fn save_rules(
    app: &tauri::AppHandle,
    rules: &[PortForwardRule],
    vault_id: Option<&str>,
) -> Result<(), String> {
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
    private_key: Option<String>,
    vault_id: Option<String>,
) -> Result<(), String> {
    let _ = private_key; // Legacy clients may send it; saved routes use Vault references exclusively.
    let vid = vault_id
        .as_deref()
        .unwrap_or(crate::vaults_meta::DEFAULT_VAULT_ID);
    let rules = load_rules(&app, Some(vid))?;
    let rule = rules
        .iter()
        .find(|rule| rule.id == rule_id)
        .ok_or("Rule not found")?;
    let route = crate::ssh::transport::resolve_host_route(&app, vid, &rule.host_id)?;
    let connection = crate::ssh::transport::connect(&app, &route)?;
    crate::ssh::transport::ensure_vault_unlocked(&app, Some(vid))?;
    let kind = match rule.rule_type.as_str() {
        "local" => crate::ssh::forward::ForwardKind::Local {
            host: rule.target_host.clone(),
            port: rule.target_port,
        },
        "remote" => crate::ssh::forward::ForwardKind::Remote {
            host: rule.target_host.clone(),
            port: rule.target_port,
        },
        "dynamic" => crate::ssh::forward::ForwardKind::Socks,
        _ => return Err("Invalid rule type".into()),
    };
    let lease = crate::ssh::forward::start(connection, &rule.bind_host, rule.bind_port, kind)?;
    RUNNING_TUNNELS
        .lock()
        .map_err(|_| "Tunnel registry unavailable")?
        .insert(rule_id, lease);
    Ok(())
}

#[tauri::command]
pub fn stop_port_forward_tunnel(rule_id: String) -> Result<(), String> {
    RUNNING_TUNNELS
        .lock()
        .map_err(|_| "Tunnel registry unavailable")?
        .remove(&rule_id);
    Ok(())
}

#[tauri::command]
pub fn port_forward_tunnel_status(rule_id: String) -> Result<bool, String> {
    let map = RUNNING_TUNNELS
        .lock()
        .map_err(|_| "Failed to lock tunnel map".to_string())?;
    Ok(map.get(&rule_id).is_some_and(|lease| lease.is_running()))
}
