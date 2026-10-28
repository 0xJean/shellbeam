use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

use crate::ssh::{CommandRunResult, SshRequest};
use crate::storage::{
    app_data_dir, legacy_entry_owner, load_vault_host_indexes, now_unix_ms, read_json_or_default,
    retire_legacy_file, split_by_owner, vault_data_file_name, write_json, VaultHostIndex,
    HISTORY_FILE, MAX_HISTORY_ENTRIES,
};

lazy_static::lazy_static! {
    // One lock for every vault's history file and the legacy migration.
    static ref HISTORY_FILE_LOCK: Mutex<()> = Mutex::new(());
}

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

fn history_path(dir: &Path, vault_id: Option<&str>) -> PathBuf {
    dir.join(vault_data_file_name(HISTORY_FILE, vault_id))
}

/// Split the pre-vault global history into the vaults owning each host.
fn migrate_legacy_in(
    dir: &Path,
    indexes: impl FnOnce() -> Result<Vec<VaultHostIndex>, String>,
) -> Result<(), String> {
    let legacy_path = dir.join(HISTORY_FILE);
    if !legacy_path.exists() {
        return Ok(());
    }
    let legacy = read_json_or_default::<Vec<CommandHistoryEntry>>(&legacy_path)?;
    let indexes = indexes()?;
    let split = split_by_owner(&legacy, |entry| {
        vec![legacy_entry_owner(entry.host_id.as_deref(), &entry.host, &indexes)]
    });
    for (vault_id, moved) in split {
        let path = history_path(dir, Some(&vault_id));
        let mut history = read_json_or_default::<Vec<CommandHistoryEntry>>(&path)?;
        for entry in moved {
            if !history.iter().any(|existing| existing.id == entry.id) {
                history.push(entry);
            }
        }
        history.sort_by_key(|entry| entry.created_at);
        trim_history(&mut history);
        write_json(&path, &history)?;
    }
    if legacy_path.exists() {
        retire_legacy_file(&legacy_path)?;
    }
    Ok(())
}

fn trim_history(history: &mut Vec<CommandHistoryEntry>) {
    if history.len() > MAX_HISTORY_ENTRIES {
        let drop_count = history.len() - MAX_HISTORY_ENTRIES;
        history.drain(0..drop_count);
    }
}

/// Caller holds HISTORY_FILE_LOCK.
fn history_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?;
    migrate_legacy_in(&dir, || load_vault_host_indexes(app))?;
    Ok(dir)
}

fn load_history(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Vec<CommandHistoryEntry>, String> {
    let path = history_path(&history_dir(app)?, vault_id);
    read_json_or_default::<Vec<CommandHistoryEntry>>(&path)
}

fn save_history(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    entries: &[CommandHistoryEntry],
) -> Result<(), String> {
    let path = history_path(&history_dir(app)?, vault_id);
    write_json(&path, entries)
}

/// One vault's history, for backups.
pub(crate) fn load_vault_history(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Vec<CommandHistoryEntry>, String> {
    let _guard = HISTORY_FILE_LOCK
        .lock()
        .map_err(|_| "History file mutex poisoned".to_string())?;
    load_history(app, vault_id)
}

/// Replace one vault's history, for backup restore.
pub(crate) fn replace_vault_history(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    entries: &[CommandHistoryEntry],
) -> Result<(), String> {
    let _guard = HISTORY_FILE_LOCK
        .lock()
        .map_err(|_| "History file mutex poisoned".to_string())?;
    save_history(app, vault_id, entries)
}

/// Move the entries `take` selects from one vault's history to another's (host
/// move). The target is written first, so an interruption leaves a duplicate
/// that a rerun drops by id instead of losing an entry. Returns the moved count.
pub(crate) fn move_vault_history(
    app: &tauri::AppHandle,
    source: &str,
    target: &str,
    take: impl Fn(&CommandHistoryEntry) -> bool,
) -> Result<usize, String> {
    let _guard = HISTORY_FILE_LOCK
        .lock()
        .map_err(|_| "History file mutex poisoned".to_string())?;
    let mut source_entries = load_history(app, Some(source))?;
    let (moving, staying): (Vec<_>, Vec<_>) = source_entries.drain(..).partition(|e| take(e));
    if moving.is_empty() {
        return Ok(0);
    }
    let mut target_entries = load_history(app, Some(target))?;
    for entry in &moving {
        if !target_entries
            .iter()
            .any(|existing| existing.id == entry.id)
        {
            target_entries.push(entry.clone());
        }
    }
    target_entries.sort_by_key(|entry| entry.created_at);
    trim_history(&mut target_entries);
    save_history(app, Some(target), &target_entries)?;
    save_history(app, Some(source), &staying)?;
    Ok(moving.len())
}

pub fn append_history(
    app: &tauri::AppHandle,
    payload: &SshRequest,
    result: &CommandRunResult,
) -> Result<(), String> {
    let _guard = HISTORY_FILE_LOCK
        .lock()
        .map_err(|_| "History file mutex poisoned".to_string())?;
    let vault_id = payload.vault_id.as_deref();
    let mut history = load_history(app, vault_id)?;
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

    trim_history(&mut history);
    save_history(app, vault_id, &history)
}

#[tauri::command]
pub fn list_command_history(
    app: tauri::AppHandle,
    vault_id: Option<String>,
    filter: Option<HistoryFilter>,
) -> Result<Vec<CommandHistoryEntry>, String> {
    let _guard = HISTORY_FILE_LOCK
        .lock()
        .map_err(|_| "History file mutex poisoned".to_string())?;
    let history = load_history(&app, vault_id.as_deref())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shellbeam-history-{name}-{}-{}",
            std::process::id(),
            now_unix_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(id: &str, host_id: Option<&str>, host: &str, created_at: i64) -> CommandHistoryEntry {
        CommandHistoryEntry {
            id: id.into(),
            host_id: host_id.map(str::to_owned),
            host: host.into(),
            command: "uptime".into(),
            status: "success".into(),
            error_type: None,
            error_code: None,
            error_source: None,
            retryable: None,
            result: CommandRunResult {
                host_identity: None,
                verified_host_keys: None,
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
                duration_ms: 1,
                error_type: None,
                error_code: None,
                error_source: None,
                retryable: None,
            },
            created_at,
        }
    }

    fn ids(path: &Path) -> Vec<String> {
        read_json_or_default::<Vec<CommandHistoryEntry>>(&path.to_path_buf())
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect()
    }

    #[test]
    fn legacy_history_moves_to_owning_vaults() {
        let dir = temp_dir("migrate");
        write_json(
            &history_path(&dir, Some("work")),
            &vec![entry("w0", Some("h-work"), "10.0.0.2", 5)],
        )
        .unwrap();
        write_json(
            &dir.join(HISTORY_FILE),
            &vec![
                entry("p1", Some("h-home"), "10.0.0.1", 1),
                entry("w1", Some("h-work"), "10.0.0.2", 2),
                entry("w2", None, "10.0.0.2", 3),
                entry("w0", Some("h-work"), "10.0.0.2", 5),
                entry("x1", Some("gone"), "198.51.100.9", 4),
            ],
        )
        .unwrap();
        let index = |id: &str, host_id: &str, address: &str| VaultHostIndex {
            vault_id: id.into(),
            host_ids: HashSet::from([host_id.to_string()]),
            addresses: HashSet::from([address.to_string()]),
            ..VaultHostIndex::default()
        };
        migrate_legacy_in(&dir, || {
            Ok(vec![
                index("personal", "h-home", "10.0.0.1"),
                index("work", "h-work", "10.0.0.2"),
            ])
        })
        .unwrap();

        assert_eq!(ids(&history_path(&dir, Some("personal"))), ["p1", "x1"]);
        assert_eq!(ids(&history_path(&dir, Some("work"))), ["w1", "w2", "w0"]);
        assert!(dir.join("command_history_vault_work.json").exists());
        assert!(!dir.join(HISTORY_FILE).exists());
        assert!(!dir.join("command_history.json.migrated").exists());
        migrate_legacy_in(&dir, || panic!("legacy history was re-read")).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_paths_are_per_vault() {
        let dir = Path::new("/data");
        assert_eq!(
            history_path(dir, None),
            dir.join("command_history_vault_personal.json")
        );
        assert_eq!(
            history_path(dir, Some("v2")),
            dir.join("command_history_vault_v2.json")
        );
    }
}
