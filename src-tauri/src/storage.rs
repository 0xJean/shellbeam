use serde::{de::DeserializeOwned, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// Pre-vault global history file; per-vault files are `command_history_vault_{id}.json`.
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
    Ok(app_data_dir(app)?.join(file_name))
}

pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Resolve app data dir failed: {err}"))?;
    fs::create_dir_all(&app_data_dir)
        .map_err(|err| format!("Create app data dir failed: {err}"))?;
    Ok(app_data_dir)
}

/// Normalized vault id: blank or missing means the default Personal vault.
pub fn vault_id_or_default(vault_id: Option<&str>) -> String {
    vault_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(crate::vaults_meta::DEFAULT_VAULT_ID)
        .to_string()
}

/// Per-vault data file name, e.g. `known_hosts_vault_personal.json` for
/// `known_hosts.json`. Vault purge deletes `*_vault_{id}.json`, so every
/// per-vault file must be named through the shared suffix.
pub fn vault_data_file_name(legacy_file: &str, vault_id: Option<&str>) -> String {
    let stem = legacy_file.strip_suffix(".json").unwrap_or(legacy_file);
    let suffix = crate::vaults_meta::vault_storage_suffix(Some(&vault_id_or_default(vault_id)));
    format!("{stem}{suffix}.json")
}

/// Host facts of one vault, used to assign entries of pre-vault global files
/// (known hosts, history, activity) to the vaults that own those servers.
#[derive(Debug, Clone, Default)]
pub struct VaultHostIndex {
    pub vault_id: String,
    pub host_ids: HashSet<String>,
    pub addresses: HashSet<String>,
    pub endpoints: HashSet<(String, u16)>,
}

fn address_key(address: &str) -> String {
    address.trim().to_ascii_lowercase()
}

impl VaultHostIndex {
    pub fn from_hosts(vault_id: &str, hosts: &[crate::data::hosts::HostProfile]) -> Self {
        let mut index = Self {
            vault_id: vault_id.to_string(),
            ..Self::default()
        };
        let mut add = |address: &str, port: u16, jump: Option<&str>, jump_port: Option<u16>| {
            if !address.trim().is_empty() {
                index.addresses.insert(address_key(address));
                index.endpoints.insert((address_key(address), port));
            }
            if let Some(jump) = jump.filter(|jump| !jump.trim().is_empty()) {
                index
                    .endpoints
                    .insert((address_key(jump), jump_port.unwrap_or(22)));
            }
        };
        for host in hosts {
            add(
                &host.address,
                host.port,
                host.jump_host.as_deref(),
                host.jump_port,
            );
            for connection in host.connections.iter().flatten() {
                add(
                    &connection.address,
                    connection.port,
                    connection.jump_host.as_deref(),
                    connection.jump_port,
                );
            }
        }
        index.host_ids = hosts.iter().map(|host| host.id.clone()).collect();
        index
    }
}

/// Every vault that reaches `host:port` (directly or as a jump host); a key
/// trusted before vaults existed stays trusted in each of them. Unknown
/// endpoints fall back to Personal.
pub fn legacy_endpoint_owners(host: &str, port: u16, vaults: &[VaultHostIndex]) -> Vec<String> {
    let key = (address_key(host), port);
    let owners: Vec<String> = vaults
        .iter()
        .filter(|vault| vault.endpoints.contains(&key))
        .map(|vault| vault.vault_id.clone())
        .collect();
    if owners.is_empty() {
        vec![crate::vaults_meta::DEFAULT_VAULT_ID.to_string()]
    } else {
        owners
    }
}

/// The single vault a legacy history/activity entry belongs to: the vault
/// holding its host id, else the first vault with that address, else Personal.
pub fn legacy_entry_owner(
    host_id: Option<&str>,
    address: &str,
    vaults: &[VaultHostIndex],
) -> String {
    let by_id = host_id
        .filter(|id| !id.trim().is_empty())
        .and_then(|id| vaults.iter().find(|vault| vault.host_ids.contains(id)));
    let address = address_key(address);
    by_id
        .or_else(|| {
            (!address.is_empty())
                .then(|| {
                    vaults
                        .iter()
                        .find(|vault| vault.addresses.contains(&address))
                })
                .flatten()
        })
        .map(|vault| vault.vault_id.clone())
        .unwrap_or_else(|| crate::vaults_meta::DEFAULT_VAULT_ID.to_string())
}

/// Group legacy entries by owning vault, preserving their order.
pub fn split_by_owner<T: Clone>(
    entries: &[T],
    owners: impl Fn(&T) -> Vec<String>,
) -> BTreeMap<String, Vec<T>> {
    let mut split: BTreeMap<String, Vec<T>> = BTreeMap::new();
    for entry in entries {
        for owner in owners(entry) {
            split.entry(owner).or_default().push(entry.clone());
        }
    }
    split
}

/// Host index of every local vault, for legacy migrations.
pub fn load_vault_host_indexes(app: &tauri::AppHandle) -> Result<Vec<VaultHostIndex>, String> {
    let mut indexes = Vec::new();
    for vault in crate::vaults_meta::list_vaults(app.clone())? {
        let hosts = crate::data::hosts::load_hosts(app, Some(&vault.id))?;
        indexes.push(VaultHostIndex::from_hosts(&vault.id, &hosts));
    }
    Ok(indexes)
}

/// Retire a migrated pre-vault file so it is never read again.
/// Delete a legacy global file once its entries live in per-vault files. Its
/// `.corrupt-*` recovery copies and any `.migrated` copy go too: they hold
/// every vault's entries and would outlive a vault deletion.
pub fn retire_legacy_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|err| format!("Remove legacy data file failed: {err}"))?;
    }
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return Ok(());
    };
    let corrupt_prefix = format!("{name}.corrupt-");
    let migrated = format!("{name}.migrated");
    for entry in fs::read_dir(dir).map_err(|err| format!("Read data dir failed: {err}"))? {
        let entry = entry.map_err(|err| format!("Read data dir failed: {err}"))?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with(&corrupt_prefix) || file_name == migrated {
            fs::remove_file(entry.path())
                .map_err(|err| format!("Remove legacy data copy failed: {err}"))?;
        }
    }
    Ok(())
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
    use super::{read_json_or_default, retire_legacy_file, unique_file_suffix};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn retiring_a_legacy_file_removes_its_copies_only() {
        let dir = std::env::temp_dir().join(format!("shellbeam-retire-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "command_history.json",
            "command_history.json.corrupt-1",
            "command_history.json.migrated",
            "command_history_vault_personal.json",
            "known_hosts.json.corrupt-1",
        ] {
            fs::write(dir.join(name), "[]").unwrap();
        }
        retire_legacy_file(&dir.join("command_history.json")).unwrap();
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "command_history_vault_personal.json",
                "known_hosts.json.corrupt-1"
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

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

    fn index(id: &str, host_ids: &[&str], endpoints: &[(&str, u16)]) -> super::VaultHostIndex {
        super::VaultHostIndex {
            vault_id: id.into(),
            host_ids: host_ids.iter().map(|id| id.to_string()).collect(),
            addresses: endpoints.iter().map(|(host, _)| host.to_string()).collect(),
            endpoints: endpoints
                .iter()
                .map(|(host, port)| (host.to_string(), *port))
                .collect(),
        }
    }

    #[test]
    fn per_vault_file_names_use_the_shared_suffix() {
        use super::vault_data_file_name;
        assert_eq!(
            vault_data_file_name("known_hosts.json", Some("v1")),
            "known_hosts_vault_v1.json"
        );
        assert_eq!(
            vault_data_file_name("activity_log.json", Some("  ")),
            "activity_log_vault_personal.json"
        );
        assert_eq!(
            vault_data_file_name(super::HISTORY_FILE, None),
            "command_history_vault_personal.json"
        );
    }

    #[test]
    fn legacy_known_hosts_go_to_every_vault_reaching_the_endpoint() {
        use super::legacy_endpoint_owners;
        let vaults = [
            index("personal", &[], &[("a.example", 22)]),
            index("work", &[], &[("a.example", 22), ("jump.example", 2200)]),
        ];
        assert_eq!(
            legacy_endpoint_owners("A.example", 22, &vaults),
            ["personal", "work"]
        );
        assert_eq!(
            legacy_endpoint_owners("jump.example", 2200, &vaults),
            ["work"]
        );
        // Same host on another port is a different server key.
        assert_eq!(
            legacy_endpoint_owners("jump.example", 22, &vaults),
            ["personal"]
        );
    }

    #[test]
    fn legacy_entries_prefer_host_id_then_address() {
        use super::legacy_entry_owner;
        let vaults = [
            index("personal", &["h1"], &[("shared.example", 22)]),
            index(
                "work",
                &["h2"],
                &[("shared.example", 22), ("w.example", 22)],
            ),
        ];
        assert_eq!(
            legacy_entry_owner(Some("h2"), "shared.example", &vaults),
            "work"
        );
        assert_eq!(
            legacy_entry_owner(Some("deleted"), "w.example", &vaults),
            "work"
        );
        assert_eq!(
            legacy_entry_owner(None, "shared.example", &vaults),
            "personal"
        );
        assert_eq!(legacy_entry_owner(None, "", &vaults), "personal");
        assert_eq!(
            legacy_entry_owner(Some("x"), "nowhere", &vaults),
            "personal"
        );
    }

    #[test]
    fn unique_file_suffix_is_distinct_for_sequential_calls() {
        let first = unique_file_suffix();
        let second = unique_file_suffix();

        assert_ne!(first, second);
    }
}
