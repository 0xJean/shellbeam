use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

use crate::storage::{
    app_data_dir, legacy_entry_owner, load_vault_host_indexes, now_unix_ms, read_json_or_default,
    retire_legacy_file, split_by_owner, vault_data_file_name, write_json, VaultHostIndex,
};

/// Pre-vault global file; each vault now has `activity_log_vault_{id}.json`.
const ACTIVITY_LOG_FILE: &str = "activity_log.json";
const MAX_ACTIVITY_ENTRIES: usize = 500;

lazy_static::lazy_static! {
    // One lock for every vault's log file and the legacy migration.
    static ref ACTIVITY_LOG_LOCK: Mutex<()> = Mutex::new(());
}

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

fn log_path(dir: &Path, vault_id: Option<&str>) -> PathBuf {
    dir.join(vault_data_file_name(ACTIVITY_LOG_FILE, vault_id))
}

fn trim_log(log: &mut Vec<ActivityEntry>) {
    if log.len() > MAX_ACTIVITY_ENTRIES {
        let drop = log.len() - MAX_ACTIVITY_ENTRIES;
        log.drain(0..drop);
    }
}

/// Split the pre-vault global log into the vaults owning each host.
fn migrate_legacy_in(
    dir: &Path,
    indexes: impl FnOnce() -> Result<Vec<VaultHostIndex>, String>,
) -> Result<(), String> {
    let legacy_path = dir.join(ACTIVITY_LOG_FILE);
    if !legacy_path.exists() {
        return Ok(());
    }
    let legacy = read_json_or_default::<Vec<ActivityEntry>>(&legacy_path)?;
    let indexes = indexes()?;
    let split = split_by_owner(&legacy, |entry| {
        vec![legacy_entry_owner(
            entry.host_id.as_deref(),
            &entry.host_address,
            &indexes,
        )]
    });
    for (vault_id, moved) in split {
        let path = log_path(dir, Some(&vault_id));
        let mut log = read_json_or_default::<Vec<ActivityEntry>>(&path)?;
        for entry in moved {
            if !log.iter().any(|existing| existing.id == entry.id) {
                log.push(entry);
            }
        }
        log.sort_by_key(|entry| entry.created_at);
        trim_log(&mut log);
        write_json(&path, &log)?;
    }
    if legacy_path.exists() {
        retire_legacy_file(&legacy_path)?;
    }
    Ok(())
}

/// Caller holds ACTIVITY_LOG_LOCK.
fn vault_log_path(app: &tauri::AppHandle, vault_id: Option<&str>) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?;
    migrate_legacy_in(&dir, || load_vault_host_indexes(app))?;
    Ok(log_path(&dir, vault_id))
}

fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    ACTIVITY_LOG_LOCK
        .lock()
        .map_err(|_| "Activity log mutex poisoned".to_string())
}

/// Move the entries `take` selects from one vault's log to another's (host
/// move). Target first, deduped by id, so a rerun finishes an interrupted move.
pub(crate) fn move_vault_activity(
    app: &tauri::AppHandle,
    source: &str,
    target: &str,
    take: impl Fn(&ActivityEntry) -> bool,
) -> Result<usize, String> {
    let _guard = lock()?;
    let source_path = vault_log_path(app, Some(source))?;
    let mut source_log = read_json_or_default::<Vec<ActivityEntry>>(&source_path)?;
    let (moving, staying): (Vec<_>, Vec<_>) = source_log.drain(..).partition(|e| take(e));
    if moving.is_empty() {
        return Ok(0);
    }
    let target_path = vault_log_path(app, Some(target))?;
    let mut target_log = read_json_or_default::<Vec<ActivityEntry>>(&target_path)?;
    for entry in &moving {
        if !target_log.iter().any(|existing| existing.id == entry.id) {
            target_log.push(entry.clone());
        }
    }
    target_log.sort_by_key(|entry| entry.created_at);
    trim_log(&mut target_log);
    write_json(&target_path, &target_log)?;
    write_json(&source_path, &staying)?;
    Ok(moving.len())
}

#[tauri::command]
pub fn append_activity(
    app: tauri::AppHandle,
    vault_id: Option<String>,
    event: String,
    host_id: Option<String>,
    host_name: String,
    host_address: String,
    username: Option<String>,
    auth_type: Option<String>,
    detail: Option<String>,
) -> Result<(), String> {
    let _guard = lock()?;
    let path = vault_log_path(&app, vault_id.as_deref())?;
    let mut log = read_json_or_default::<Vec<ActivityEntry>>(&path)?;
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
    trim_log(&mut log);
    write_json(&path, &log)
}

#[tauri::command]
pub fn list_activity_log(
    app: tauri::AppHandle,
    vault_id: Option<String>,
) -> Result<Vec<ActivityEntry>, String> {
    let _guard = lock()?;
    let path = vault_log_path(&app, vault_id.as_deref())?;
    read_json_or_default::<Vec<ActivityEntry>>(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn entry(id: &str, host_id: Option<&str>, address: &str) -> ActivityEntry {
        ActivityEntry {
            id: id.into(),
            event: "connect".into(),
            host_id: host_id.map(str::to_owned),
            host_name: "server".into(),
            host_address: address.into(),
            username: None,
            auth_type: None,
            detail: None,
            created_at: 1,
        }
    }

    #[test]
    fn legacy_activity_moves_to_owning_vaults() {
        let dir = std::env::temp_dir().join(format!(
            "shellbeam-activity-migrate-{}-{}",
            std::process::id(),
            now_unix_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        write_json(
            &dir.join(ACTIVITY_LOG_FILE),
            &vec![
                entry("a", Some("h-work"), "10.0.0.2"),
                entry("b", None, "10.0.0.2"),
                entry("c", None, "unknown.example"),
            ],
        )
        .unwrap();
        let work = VaultHostIndex {
            vault_id: "work".into(),
            host_ids: HashSet::from(["h-work".to_string()]),
            addresses: HashSet::from(["10.0.0.2".to_string()]),
            ..VaultHostIndex::default()
        };
        migrate_legacy_in(&dir, || Ok(vec![work])).unwrap();
        let ids = |vault: &str| {
            read_json_or_default::<Vec<ActivityEntry>>(&log_path(&dir, Some(vault)))
                .unwrap()
                .into_iter()
                .map(|entry| entry.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("work"), ["a", "b"]);
        assert_eq!(ids("personal"), ["c"]);
        assert!(dir.join("activity_log_vault_work.json").exists());
        assert!(!dir.join("activity_log.json.migrated").exists());
        migrate_legacy_in(&dir, || panic!("legacy log was re-read")).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
