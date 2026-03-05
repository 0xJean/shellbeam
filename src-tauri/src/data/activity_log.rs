use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::storage::{data_file_path, now_unix_ms, read_json_or_default, write_json};

const ACTIVITY_LOG_FILE: &str = "activity_log.json";
const MAX_ACTIVITY_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub event: String,
    pub host_id: Option<String>,
    pub host_name: String,
    pub host_address: String,
    pub username: Option<String>,
    pub auth_type: Option<String>,
    pub detail: Option<String>,
    pub created_at: i64,
}

fn load_log(app: &tauri::AppHandle) -> Result<Vec<ActivityEntry>, String> {
    let path = data_file_path(app, ACTIVITY_LOG_FILE)?;
    read_json_or_default::<Vec<ActivityEntry>>(&path)
}

fn save_log(app: &tauri::AppHandle, entries: &[ActivityEntry]) -> Result<(), String> {
    let path = data_file_path(app, ACTIVITY_LOG_FILE)?;
    write_json(&path, entries)
}

#[tauri::command]
pub fn append_activity(
    app: tauri::AppHandle,
    event: String,
    host_id: Option<String>,
    host_name: String,
    host_address: String,
    username: Option<String>,
    auth_type: Option<String>,
    detail: Option<String>,
) -> Result<(), String> {
    let mut log = load_log(&app)?;
    log.push(ActivityEntry {
        id: Uuid::new_v4().to_string(),
        event,
        host_id,
        host_name,
        host_address,
        username,
        auth_type,
        detail,
        created_at: now_unix_ms(),
    });
    if log.len() > MAX_ACTIVITY_ENTRIES {
        let drop = log.len() - MAX_ACTIVITY_ENTRIES;
        log.drain(0..drop);
    }
    save_log(&app, &log)
}

#[tauri::command]
pub fn list_activity_log(app: tauri::AppHandle) -> Result<Vec<ActivityEntry>, String> {
    load_log(&app)
}
