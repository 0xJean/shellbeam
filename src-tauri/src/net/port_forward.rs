//! Phase C: Port forwarding rules - local and remote SSH tunnels.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::ssh::transport::TrafficCounters;
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

/// A started tunnel plus the traffic totals shared by all of its bridge workers.
/// Dropping it (stop/delete/restart) stops the lease and discards the counters.
struct RunningTunnel {
    lease: crate::ssh::forward::ForwardLease,
    counters: Arc<TrafficCounters>,
    started_at: i64,
}

/// Traffic snapshot for one registered tunnel. `bytesIn` is data received from
/// the far side of the tunnel, `bytesOut` is data sent into it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardTunnelStats {
    pub rule_id: String,
    pub running: bool,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub started_at: Option<i64>,
}

fn tunnel_stats(
    rule_id: &str,
    running: bool,
    counters: &TrafficCounters,
    started_at: i64,
) -> PortForwardTunnelStats {
    PortForwardTunnelStats {
        rule_id: rule_id.to_string(),
        running,
        bytes_in: counters.bytes_in(),
        bytes_out: counters.bytes_out(),
        started_at: Some(started_at),
    }
}

fn stopped_stats(rule_id: &str) -> PortForwardTunnelStats {
    PortForwardTunnelStats {
        rule_id: rule_id.to_string(),
        running: false,
        bytes_in: 0,
        bytes_out: 0,
        started_at: None,
    }
}

lazy_static::lazy_static! {
    static ref RUNNING_TUNNELS: Mutex<HashMap<String, RunningTunnel>> = Mutex::new(HashMap::new());
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

/// Move the rules of the given hosts from one vault to another (host move).
/// Target first, deduped by rule id, so a rerun finishes an interrupted move.
/// Running tunnels are keyed by rule id and keep running.
pub(crate) fn move_vault_rules(
    app: &tauri::AppHandle,
    source: &str,
    target: &str,
    host_ids: &std::collections::BTreeSet<String>,
) -> Result<usize, String> {
    let mut source_rules = load_rules(app, Some(source))?;
    let (moving, staying): (Vec<_>, Vec<_>) = source_rules
        .drain(..)
        .partition(|rule| host_ids.contains(&rule.host_id));
    if moving.is_empty() {
        return Ok(0);
    }
    let mut target_rules = load_rules(app, Some(target))?;
    for rule in &moving {
        if !target_rules.iter().any(|existing| existing.id == rule.id) {
            target_rules.push(rule.clone());
        }
    }
    save_rules(app, &target_rules, Some(target))?;
    save_rules(app, &staying, Some(source))?;
    Ok(moving.len())
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
    let counters = Arc::new(TrafficCounters::default());
    let lease = crate::ssh::forward::start_counted(
        connection,
        &rule.bind_host,
        rule.bind_port,
        kind,
        Some(counters.clone()),
    )?;
    RUNNING_TUNNELS
        .lock()
        .map_err(|_| "Tunnel registry unavailable")?
        .insert(
            rule_id,
            RunningTunnel {
                lease,
                counters,
                started_at: now_unix_ms(),
            },
        );
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
    Ok(map
        .get(&rule_id)
        .is_some_and(|tunnel| tunnel.lease.is_running()))
}

/// Traffic totals and start time for one rule (`rule_id` given; a rule with no
/// registered tunnel reports `running: false` and zeros) or for every
/// registered tunnel (`rule_id` omitted).
#[tauri::command]
pub fn port_forward_tunnel_stats(
    rule_id: Option<String>,
) -> Result<Vec<PortForwardTunnelStats>, String> {
    let map = RUNNING_TUNNELS
        .lock()
        .map_err(|_| "Failed to lock tunnel map".to_string())?;
    let snapshot = |id: &str, tunnel: &RunningTunnel| {
        tunnel_stats(
            id,
            tunnel.lease.is_running(),
            &tunnel.counters,
            tunnel.started_at,
        )
    };
    Ok(match rule_id {
        Some(id) => vec![map
            .get(&id)
            .map(|tunnel| snapshot(&id, tunnel))
            .unwrap_or_else(|| stopped_stats(&id))],
        None => map
            .iter()
            .map(|(id, tunnel)| snapshot(id, tunnel))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn counters_accumulate_across_concurrent_bridges_without_locks() {
        let counters = Arc::new(TrafficCounters::default());
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let counters = counters.clone();
                thread::spawn(move || {
                    for _ in 0..1_000 {
                        counters.add_in(3);
                        counters.add_out(2);
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(counters.bytes_in(), 24_000);
        assert_eq!(counters.bytes_out(), 16_000);
    }

    #[test]
    fn stats_snapshot_reports_totals_start_time_and_camel_case_json() {
        let counters = TrafficCounters::default();
        counters.add_in(190_840_832);
        counters.add_out(12_582_912);
        let stats = tunnel_stats("rule-1", true, &counters, 1_700_000_000_000);
        assert_eq!(
            serde_json::to_value(&stats).unwrap(),
            serde_json::json!({
                "ruleId": "rule-1",
                "running": true,
                "bytesIn": 190_840_832u64,
                "bytesOut": 12_582_912u64,
                "startedAt": 1_700_000_000_000i64,
            })
        );
    }

    #[test]
    fn unknown_rule_reports_stopped_without_traffic() {
        let stats = port_forward_tunnel_stats(Some("missing-rule".into())).unwrap();
        assert_eq!(stats, vec![stopped_stats("missing-rule")]);
        assert_eq!(
            serde_json::to_value(&stats[0]).unwrap()["startedAt"],
            serde_json::Value::Null
        );
    }
}
