use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::storage::{data_file_path, now_unix_ms, read_json_or_default, write_json};
use crate::vaults_meta;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub auth_type: String,
    pub secret_key_ref: Option<String>,
    pub password_key_ref: Option<String>,
    pub private_key_ref: Option<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_user: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfileDraft {
    name: String,
    address: String,
    port: u16,
    username: String,
    group: Option<String>,
    auth_type: String,
    secret_key_ref: Option<String>,
    password_key_ref: Option<String>,
    private_key_ref: Option<String>,
    tags: Option<Vec<String>>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
}

fn hosts_file_name(vault_id: Option<&str>) -> String {
    let suffix = vaults_meta::vault_storage_suffix(vault_id);
    format!("hosts{suffix}.json")
}

pub fn load_hosts(app: &tauri::AppHandle, vault_id: Option<&str>) -> Result<Vec<HostProfile>, String> {
    let file = hosts_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    read_json_or_default::<Vec<HostProfile>>(&path)
}

pub fn save_hosts(
    app: &tauri::AppHandle,
    hosts: &[HostProfile],
    vault_id: Option<&str>,
) -> Result<(), String> {
    let file = hosts_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    write_json(&path, hosts)
}

#[tauri::command]
pub fn list_hosts(app: tauri::AppHandle, vault_id: Option<String>) -> Result<Vec<HostProfile>, String> {
    load_hosts(&app, vault_id.as_deref())
}

#[tauri::command]
pub fn create_host(
    app: tauri::AppHandle,
    payload: HostProfileDraft,
    vault_id: Option<String>,
) -> Result<HostProfile, String> {
    let vid = vault_id.as_deref();
    let now = now_unix_ms();
    let mut hosts = load_hosts(&app, vid)?;
    let host = HostProfile {
        id: Uuid::new_v4().to_string(),
        name: payload.name.trim().to_string(),
        address: payload.address.trim().to_string(),
        port: payload.port,
        username: payload.username.trim().to_string(),
        group: payload.group.unwrap_or_else(|| "Custom".to_string()),
        auth_type: payload.auth_type,
        secret_key_ref: payload
            .secret_key_ref
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        password_key_ref: payload
            .password_key_ref
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        private_key_ref: payload
            .private_key_ref
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        tags: payload.tags.unwrap_or_default(),
        jump_host: payload.jump_host.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        jump_port: payload.jump_port,
        jump_user: payload.jump_user.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        created_at: now,
        updated_at: now,
    };
    hosts.push(host.clone());
    save_hosts(&app, &hosts, vid)?;
    Ok(host)
}

#[tauri::command]
pub fn update_host(
    app: tauri::AppHandle,
    payload: HostProfile,
    vault_id: Option<String>,
) -> Result<HostProfile, String> {
    let vid = vault_id.as_deref();
    let mut hosts = load_hosts(&app, vid)?;
    let idx = hosts
        .iter()
        .position(|host| host.id == payload.id)
        .ok_or_else(|| "Host not found".to_string())?;
    let mut updated = payload;
    updated.name = updated.name.trim().to_string();
    updated.address = updated.address.trim().to_string();
    updated.username = updated.username.trim().to_string();
    updated.secret_key_ref = updated
        .secret_key_ref
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    updated.password_key_ref = updated
        .password_key_ref
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    updated.private_key_ref = updated
        .private_key_ref
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    updated.updated_at = now_unix_ms();
    hosts[idx] = updated.clone();
    save_hosts(&app, &hosts, vid)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_host(
    app: tauri::AppHandle,
    id: String,
    vault_id: Option<String>,
) -> Result<(), String> {
    let vid = vault_id.as_deref();
    let mut hosts = load_hosts(&app, vid)?;
    let before_len = hosts.len();
    hosts.retain(|host| host.id != id);
    if hosts.len() == before_len {
        return Err("Host not found".to_string());
    }
    save_hosts(&app, &hosts, vid)
}
