use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ssh::{CommandRunResult, SshRequest};
use crate::storage::{
    data_file_path, now_unix_ms, read_json_or_default, write_json, HISTORY_FILE,
    MAX_HISTORY_ENTRIES,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub id: String,
    pub host_id: Option<String>,
    pub host: String,
    pub command: String,
    pub status: String,
    pub error_type: Option<String>,
    pub error_code: Option<String>,
    pub error_source: Option<String>,
    pub retryable: Option<bool>,
    pub result: CommandRunResult,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    host: Option<String>,
    status: Option<String>,
    error_code: Option<String>,
    retryable: Option<bool>,
    from: Option<i64>,
    to: Option<i64>,
}

fn load_history(app: &tauri::AppHandle) -> Result<Vec<CommandHistoryEntry>, String> {
    let path = data_file_path(app, HISTORY_FILE)?;
    read_json_or_default::<Vec<CommandHistoryEntry>>(&path)
}

fn save_history(app: &tauri::AppHandle, entries: &[CommandHistoryEntry]) -> Result<(), String> {
    let path = data_file_path(app, HISTORY_FILE)?;
    write_json(&path, entries)
}

pub fn append_history(
    app: &tauri::AppHandle,
    payload: &SshRequest,
    result: &CommandRunResult,
) -> Result<(), String> {
    let mut history = load_history(app)?;
    let status = if result.error_type.is_none() && result.exit_code == 0 {
        "success"
    } else {
        "failed"
    };
    history.push(CommandHistoryEntry {
        id: Uuid::new_v4().to_string(),
        host_id: payload.host_id.clone(),
        host: payload.host.clone(),
        command: payload.command.clone(),
        status: status.to_string(),
        error_type: result.error_type.clone(),
        error_code: result.error_code.clone(),
        error_source: result.error_source.clone(),
        retryable: result.retryable,
        result: result.clone(),
        created_at: now_unix_ms(),
    });

    if history.len() > MAX_HISTORY_ENTRIES {
        let drop_count = history.len() - MAX_HISTORY_ENTRIES;
        history.drain(0..drop_count);
    }
    save_history(app, &history)
}

#[tauri::command]
pub fn list_command_history(
    app: tauri::AppHandle,
    filter: Option<HistoryFilter>,
) -> Result<Vec<CommandHistoryEntry>, String> {
    let history = load_history(&app)?;
    let Some(filter) = filter else {
        return Ok(history);
    };

    let entries = history
        .into_iter()
        .filter(|entry| {
            if let Some(host) = &filter.host {
                if entry.host != *host {
                    return false;
                }
            }
            if let Some(status) = &filter.status {
                if entry.status != *status {
                    return false;
                }
            }
            if let Some(error_code) = &filter.error_code {
                if entry.error_code.as_deref() != Some(error_code.as_str()) {
                    return false;
                }
            }
            if let Some(retryable) = filter.retryable {
                if entry.retryable.unwrap_or(false) != retryable {
                    return false;
                }
            }
            if let Some(from) = filter.from {
                if entry.created_at < from {
                    return false;
                }
            }
            if let Some(to) = filter.to {
                if entry.created_at > to {
                    return false;
                }
            }
            true
        })
        .collect();

    Ok(entries)
}
