use serde::{Deserialize, Serialize};
use std::time::Instant;
use uuid::Uuid;

use crate::ssh::{failed_result, run_ssh_command_sync, CommandRunResult, SshRequest};
use crate::storage::{data_file_path, now_unix_ms, read_json_or_default, write_json};
use crate::vaults_meta;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetEntry {
    pub id: String,
    pub name: String,
    pub command: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDraft {
    name: String,
    command: String,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRunRequest {
    snippet_id: String,
    host_id: Option<String>,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
}

fn snippets_file_name(vault_id: Option<&str>) -> String {
    let suffix = vaults_meta::vault_storage_suffix(vault_id);
    format!("snippets{suffix}.json")
}

pub fn load_snippets(app: &tauri::AppHandle, vault_id: Option<&str>) -> Result<Vec<SnippetEntry>, String> {
    let file = snippets_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    read_json_or_default::<Vec<SnippetEntry>>(&path)
}

pub fn save_snippets(
    app: &tauri::AppHandle,
    snippets: &[SnippetEntry],
    vault_id: Option<&str>,
) -> Result<(), String> {
    let file = snippets_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    write_json(&path, snippets)
}

#[tauri::command]
pub fn list_snippets(app: tauri::AppHandle, vault_id: Option<String>) -> Result<Vec<SnippetEntry>, String> {
    load_snippets(&app, vault_id.as_deref())
}

#[tauri::command]
pub fn create_snippet(
    app: tauri::AppHandle,
    payload: SnippetDraft,
    vault_id: Option<String>,
) -> Result<SnippetEntry, String> {
    if payload.name.trim().is_empty() {
        return Err("snippet name is required".to_string());
    }
    if payload.command.trim().is_empty() {
        return Err("snippet command is required".to_string());
    }
    let vid = vault_id.as_deref();
    let mut snippets = load_snippets(&app, vid)?;
    let now = now_unix_ms();
    let entry = SnippetEntry {
        id: Uuid::new_v4().to_string(),
        name: payload.name.trim().to_string(),
        command: payload.command.trim().to_string(),
        tags: payload.tags.unwrap_or_default(),
        created_at: now,
        updated_at: now,
        last_used_at: None,
    };
    snippets.push(entry.clone());
    save_snippets(&app, &snippets, vid)?;
    Ok(entry)
}

#[tauri::command]
pub fn update_snippet(
    app: tauri::AppHandle,
    payload: SnippetEntry,
    vault_id: Option<String>,
) -> Result<SnippetEntry, String> {
    let vid = vault_id.as_deref();
    let mut snippets = load_snippets(&app, vid)?;
    let idx = snippets
        .iter()
        .position(|snippet| snippet.id == payload.id)
        .ok_or_else(|| "Snippet not found".to_string())?;
    let mut updated = payload;
    updated.name = updated.name.trim().to_string();
    updated.command = updated.command.trim().to_string();
    updated.updated_at = now_unix_ms();
    snippets[idx] = updated.clone();
    save_snippets(&app, &snippets, vid)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_snippet(
    app: tauri::AppHandle,
    id: String,
    vault_id: Option<String>,
) -> Result<(), String> {
    let vid = vault_id.as_deref();
    let mut snippets = load_snippets(&app, vid)?;
    let before_len = snippets.len();
    snippets.retain(|snippet| snippet.id != id);
    if snippets.len() == before_len {
        return Err("Snippet not found".to_string());
    }
    save_snippets(&app, &snippets, vid)
}

#[tauri::command]
pub async fn run_snippet_command(
    app: tauri::AppHandle,
    payload: SnippetRunRequest,
    vault_id: Option<String>,
) -> Result<CommandRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let vid = vault_id.as_deref();
        let snippets = match load_snippets(&app, vid) {
            Ok(items) => items,
            Err(err) => {
                return failed_result(
                    Instant::now(),
                    format!("Load snippets failed: {err}"),
                    "internal",
                    "snippet_load_failed",
                    "storage",
                    true,
                )
            }
        };
        let snippet = match snippets.iter().find(|item| item.id == payload.snippet_id) {
            Some(item) => item.clone(),
            None => {
                return failed_result(
                    Instant::now(),
                    "Snippet not found".to_string(),
                    "validation",
                    "not_found",
                    "snippet",
                    false,
                )
            }
        };

        let request = SshRequest {
            host_id: payload.host_id,
            host: payload.host,
            port: payload.port,
            username: payload.username,
            auth_type: payload.auth_type,
            password: payload.password,
            private_key: payload.private_key,
            passphrase: payload.passphrase,
            command: snippet.command,
        };
        let result = run_ssh_command_sync(app.clone(), request);

        let mut snippets = match load_snippets(&app, vid) {
            Ok(items) => items,
            Err(_) => return result,
        };
        if let Some(item) = snippets.iter_mut().find(|item| item.id == snippet.id) {
            item.last_used_at = Some(now_unix_ms());
            item.updated_at = now_unix_ms();
            let _ = save_snippets(&app, &snippets, vid);
        }
        result
    }).await.map_err(|e| format!("Task panicked: {e}"))
}
