use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

pub const HISTORY_FILE: &str = "command_history.json";
pub const SYNC_STATE_FILE: &str = "sync_state.json";
pub const MAX_HISTORY_ENTRIES: usize = 1000;

static FILE_SUFFIX_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    match serde_json::from_str::<T>(&content) {
        Ok(value) => Ok(value),
        Err(err) => {
            let backup_path = corrupt_backup_path(path);
            fs::rename(path, &backup_path).map_err(|rename_err| {
                format!("Parse data file failed: {err}; backup corrupt file failed: {rename_err}")
            })?;
            log::error!(
                "Recovered from corrupt data file {} by moving it to {}: {}",
                path.display(),
                backup_path.display(),
                err
            );
            Ok(T::default())
        }
    }
}

pub fn write_json<T: Serialize + ?Sized>(path: &PathBuf, value: &T) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Serialize data failed: {err}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Resolve parent dir failed for {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|err| format!("Create data dir failed: {err}"))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Resolve data file name failed for {}", path.display()))?;
    let temp_path = parent.join(format!(".{file_name}.tmp-{}", unique_file_suffix()));

    let mut temp_file = fs::File::create(&temp_path)
        .map_err(|err| format!("Create temp data file failed: {err}"))?;
    temp_file
        .write_all(content.as_bytes())
        .map_err(|err| format!("Write temp data file failed: {err}"))?;
    temp_file
        .sync_all()
        .map_err(|err| format!("Flush temp data file failed: {err}"))?;

    if cfg!(windows) && path.exists() {
        fs::remove_file(path).map_err(|err| format!("Replace existing data file failed: {err}"))?;
    }

    fs::rename(&temp_path, path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!("Replace data file failed: {err}")
    })
}

fn corrupt_backup_path(path: &PathBuf) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");
    path.with_file_name(format!("{file_name}.corrupt-{}", unique_file_suffix()))
}

fn unique_file_suffix() -> String {
    format!(
        "{}-{}-{}",
        now_unix_ms(),
        std::process::id(),
        FILE_SUFFIX_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Remove all files inside the app data directory (but keep the directory itself).
#[tauri::command]
pub fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    crate::mcp::prepare_reset(&app)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Resolve app data dir failed: {err}"))?;
    if !app_data_dir.exists() {
        return Ok(());
    }
    for entry in
        fs::read_dir(&app_data_dir).map_err(|err| format!("Read app data dir failed: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Read dir entry failed: {err}"))?;
        let path = entry.path();
        // Keep the empty process-ownership lock, not user data, while this app is alive.
        if crate::mcp::is_runtime_lock_file(&entry.file_name()) {
            continue;
        }
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|err| format!("Remove dir failed: {err}"))?;
        } else {
            fs::remove_file(&path).map_err(|err| format!("Remove file failed: {err}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read_json_or_default, unique_file_suffix};
    use std::fs;
    use std::path::PathBuf;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shellbeam-storage-tests-{}-{}-{}",
            name,
            std::process::id(),
            super::now_unix_ms()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn read_json_or_default_recovers_from_corrupt_json() {
        let dir = test_dir("recover");
        let path = dir.join("command_history.json");
        fs::write(&path, "[\n  {\"id\":1}\n]]").expect("write corrupt json");

        let value =
            read_json_or_default::<Vec<serde_json::Value>>(&path).expect("recover corrupt json");

        assert!(value.is_empty());
        let entries = fs::read_dir(&dir)
            .expect("read dir")
            .map(|entry| {
                entry
                    .expect("dir entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert!(entries
            .iter()
            .any(|name| name.starts_with("command_history.json.corrupt-")));
        assert!(!path.exists());
    }

    #[test]
    fn unique_file_suffix_is_distinct_for_sequential_calls() {
        let first = unique_file_suffix();
        let second = unique_file_suffix();

        assert_ne!(first, second);
    }
}
