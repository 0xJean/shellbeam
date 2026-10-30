//! Multi-Vault: vault metadata and active vault management.

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::Manager;
use uuid::Uuid;

use crate::storage::{data_file_path, now_unix_ms, read_json_or_default, write_json};

const VAULTS_META_FILE: &str = "vaults_meta.json";
pub const DEFAULT_VAULT_ID: &str = "personal";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultMeta {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultsMetaFile {
    vaults: Vec<VaultMeta>,
}

fn migrate_to_multi_vault(app: &tauri::AppHandle) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| format!("{e}"))?;
    let suffix = format!("_vault_{}", DEFAULT_VAULT_ID);

    let hosts_legacy = app_data.join("hosts.json");
    let hosts_new = app_data.join(format!("hosts{suffix}.json"));
    if hosts_legacy.exists() && !hosts_new.exists() {
        fs::copy(&hosts_legacy, &hosts_new).map_err(|e| format!("Migrate hosts: {e}"))?;
    }

    let snippets_legacy = app_data.join("snippets.json");
    let snippets_new = app_data.join(format!("snippets{suffix}.json"));
    if snippets_legacy.exists() && !snippets_new.exists() {
        fs::copy(&snippets_legacy, &snippets_new).map_err(|e| format!("Migrate snippets: {e}"))?;
    }

    let pf_legacy = app_data.join("port_forward_rules.json");
    let pf_new = app_data.join(format!("port_forward_rules{suffix}.json"));
    if pf_legacy.exists() && !pf_new.exists() {
        fs::copy(&pf_legacy, &pf_new).map_err(|e| format!("Migrate port_forward: {e}"))?;
    }

    let vault_legacy = app_data.join("vault.json");
    let vault_new = app_data.join(format!("vault_{}.json", DEFAULT_VAULT_ID));
    if vault_legacy.exists() && !vault_new.exists() {
        fs::copy(&vault_legacy, &vault_new).map_err(|e| format!("Migrate vault: {e}"))?;
    }

    Ok(())
}

fn load_meta_file(app: &tauri::AppHandle) -> Result<VaultsMetaFile, String> {
    let path = data_file_path(app, VAULTS_META_FILE)?;
    let mut meta: VaultsMetaFile = read_json_or_default(&path)?;
    if meta.vaults.is_empty() {
        let _ = migrate_to_multi_vault(app);
        meta.vaults.push(VaultMeta {
            id: DEFAULT_VAULT_ID.to_string(),
            name: "Personal".to_string(),
            created_at: now_unix_ms(),
            is_default: true,
        });
        let _ = save_meta_file(app, &meta);
    }
    Ok(meta)
}

fn save_meta_file(app: &tauri::AppHandle, meta: &VaultsMetaFile) -> Result<(), String> {
    let path = data_file_path(app, VAULTS_META_FILE)?;
    write_json(&path, meta)
}

fn ensure_vault_id(vault_id: Option<&str>) -> String {
    vault_id
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_VAULT_ID)
        .to_string()
}

#[tauri::command]
pub fn list_vaults(app: tauri::AppHandle) -> Result<Vec<VaultMeta>, String> {
    let meta = load_meta_file(&app)?;
    Ok(meta.vaults)
}

#[tauri::command]
pub fn create_vault(app: tauri::AppHandle, name: String) -> Result<VaultMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Vault name is required".to_string());
    }
    let mut meta = load_meta_file(&app)?;
    let id = Uuid::new_v4().to_string();
    let now = now_unix_ms();
    let vault = VaultMeta {
        id: id.clone(),
        name: name.to_string(),
        created_at: now,
        is_default: false,
    };
    meta.vaults.push(vault.clone());
    save_meta_file(&app, &meta)?;
    Ok(vault)
}

#[tauri::command]
pub fn update_vault(
    app: tauri::AppHandle,
    vault_id: String,
    name: String,
) -> Result<VaultMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Vault name is required".to_string());
    }
    let mut meta = load_meta_file(&app)?;
    let v = meta
        .vaults
        .iter_mut()
        .find(|x| x.id == vault_id)
        .ok_or_else(|| "Vault not found".to_string())?;
    v.name = name.to_string();
    let updated = v.clone();
    save_meta_file(&app, &meta)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_vault(app: tauri::AppHandle, vault_id: String) -> Result<(), String> {
    if vault_id == DEFAULT_VAULT_ID {
        return Err("Cannot delete the default Personal vault".to_string());
    }
    if find_vault(&app, &vault_id)?.is_none() {
        return Err("Vault not found".to_string());
    }
    // Purge before dropping the meta entry: a partial failure leaves the Vault
    // listed so deleting it again finishes the job.
    let report = super::purge::purge_vault_data(&app, &vault_id)?;
    log::info!(
        "Deleted vault {vault_id}: {} files, {} tables, {} MCP clients",
        report.files_removed.len(),
        report.rows_deleted.len(),
        report.mcp_clients_revoked
    );
    let mut meta = load_meta_file(&app)?;
    meta.vaults.retain(|v| v.id != vault_id);
    save_meta_file(&app, &meta)?;
    Ok(())
}

/// The local vault with this id, if any.
pub fn find_vault(app: &tauri::AppHandle, vault_id: &str) -> Result<Option<VaultMeta>, String> {
    Ok(load_meta_file(app)?
        .vaults
        .into_iter()
        .find(|v| v.id == vault_id))
}

/// Map a vault named by another device onto a local vault: same id first,
/// then the same name (ids are random per device), else create it with the
/// sender's id and name when `create` is set. Personal always maps to Personal.
pub fn resolve_peer_vault(
    app: &tauri::AppHandle,
    peer_id: &str,
    peer_name: &str,
    create: bool,
) -> Result<String, String> {
    let peer_id = peer_id.trim();
    if peer_id.is_empty() || peer_id == DEFAULT_VAULT_ID {
        return Ok(DEFAULT_VAULT_ID.to_string());
    }
    let mut meta = load_meta_file(app)?;
    if meta.vaults.iter().any(|v| v.id == peer_id) {
        return Ok(peer_id.to_string());
    }
    let name = peer_name.trim();
    if let Some(v) = meta
        .vaults
        .iter()
        .find(|v| !name.is_empty() && v.name.trim().eq_ignore_ascii_case(name))
    {
        return Ok(v.id.clone());
    }
    if !create {
        return Err(format!("Vault \"{name}\" does not exist on this device"));
    }
    // Ids become file names (vault_{id}.json); keep the peer's only if it is a plain token.
    let id = if is_safe_vault_id(peer_id) {
        peer_id.to_string()
    } else {
        Uuid::new_v4().to_string()
    };
    meta.vaults.push(VaultMeta {
        id: id.clone(),
        name: if name.is_empty() {
            peer_id.to_string()
        } else {
            name.to_string()
        },
        created_at: now_unix_ms(),
        is_default: false,
    });
    save_meta_file(app, &meta)?;
    Ok(id)
}

/// Plain id token: letters, digits, '-' and '_', at most 64 chars.
fn is_safe_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Resolve vault_id for storage paths. Used by hosts, snippets, port_forward, vault.
pub fn vault_storage_suffix(vault_id: Option<&str>) -> String {
    let id = ensure_vault_id(vault_id);
    format!("_vault_{}", id)
}

#[cfg(test)]
mod tests {
    use super::is_safe_vault_id;

    #[test]
    fn peer_vault_ids_must_be_plain_tokens() {
        assert!(is_safe_vault_id("3f2c9a1e-0b7d-4c55-9e1a-1d2b3c4d5e6f"));
        assert!(is_safe_vault_id("team_prod"));
        for bad in ["", "../x", "a/b", "a:b", "vault x", &"a".repeat(65)] {
            assert!(!is_safe_vault_id(bad), "{bad:?}");
        }
    }
}
