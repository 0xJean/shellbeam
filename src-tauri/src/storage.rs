use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

pub const HISTORY_FILE: &str = "command_history.json";
pub const SYNC_STATE_FILE: &str = "sync_state.json";
pub const MAX_HISTORY_ENTRIES: usize = 1000;

pub fn now_unix_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

pub fn data_file_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Resolve app data dir failed: {err}"))?;
    fs::create_dir_all(&app_data_dir)
        .map_err(|err| format!("Create app data dir failed: {err}"))?;
    Ok(app_data_dir.join(file_name))
}

pub fn read_json_or_default<T: DeserializeOwned + Default>(path: &PathBuf) -> Result<T, String> {
    if !path.exists() {
        return Ok(T::default());
    }
    let content =
        fs::read_to_string(path).map_err(|err| format!("Read data file failed: {err}"))?;
    serde_json::from_str::<T>(&content).map_err(|err| format!("Parse data file failed: {err}"))
}

pub fn write_json<T: Serialize + ?Sized>(path: &PathBuf, value: &T) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Serialize data failed: {err}"))?;
    fs::write(path, content).map_err(|err| format!("Write data file failed: {err}"))
}

/// Remove all files inside the app data directory (but keep the directory itself).
#[tauri::command]
pub fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Resolve app data dir failed: {err}"))?;
    if !app_data_dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&app_data_dir)
        .map_err(|err| format!("Read app data dir failed: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Read dir entry failed: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|err| format!("Remove dir failed: {err}"))?;
        } else {
            fs::remove_file(&path)
                .map_err(|err| format!("Remove file failed: {err}"))?;
        }
    }
    Ok(())
}
