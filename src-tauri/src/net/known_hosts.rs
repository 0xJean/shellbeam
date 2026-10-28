//! Known hosts: store and verify SSH host key fingerprints.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use std::path::Path;
use std::sync::Mutex;

use crate::storage::{
    app_data_dir, legacy_endpoint_owners, load_vault_host_indexes, read_json_or_default,
    retire_legacy_file, split_by_owner, vault_data_file_name, write_json, VaultHostIndex,
};

/// Pre-vault global file; each vault now has `known_hosts_vault_{id}.json`.
const KNOWN_HOSTS_FILE: &str = "known_hosts.json";

lazy_static::lazy_static! {
    // One lock for every vault's file: read-modify-write never interleaves.
    static ref KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub fingerprint_sha256: String,
    pub key_type: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostsFile {
    entries: Vec<KnownHostEntry>,
}

fn host_key(host: &str, port: u16) -> String {
    format!("{}:{}", host, port)
}

fn compute_fingerprint_sha256(key_bytes: &[u8]) -> String {
    let hash = Sha256::digest(key_bytes);
    base64::engine::general_purpose::STANDARD.encode(hash)
}

fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "Known hosts mutex poisoned".to_string())
}

fn load_entries_in(dir: &Path, vault_id: Option<&str>) -> Result<Vec<KnownHostEntry>, String> {
    let path = dir.join(vault_data_file_name(KNOWN_HOSTS_FILE, vault_id));
    let file: KnownHostsFile = read_json_or_default(&path)?;
    Ok(file.entries)
}

fn save_entries_in(
    dir: &Path,
    vault_id: Option<&str>,
    entries: &[KnownHostEntry],
) -> Result<(), String> {
    let path = dir.join(vault_data_file_name(KNOWN_HOSTS_FILE, vault_id));
    write_json(
        &path,
        &KnownHostsFile {
            entries: entries.to_vec(),
        },
    )
}

/// Split the pre-vault global file into the vaults that reach each endpoint.
/// Entries already present in a vault's file win; the legacy file is retired.
fn migrate_legacy_in(
    dir: &Path,
    indexes: impl FnOnce() -> Result<Vec<VaultHostIndex>, String>,
) -> Result<(), String> {
    let legacy_path = dir.join(KNOWN_HOSTS_FILE);
    if !legacy_path.exists() {
        return Ok(());
    }
    let legacy: KnownHostsFile = read_json_or_default(&legacy_path)?;
    let indexes = indexes()?;
    let split = split_by_owner(&legacy.entries, |entry| {
        legacy_endpoint_owners(&entry.host, entry.port, &indexes)
    });
    for (vault_id, moved) in split {
        let mut entries = load_entries_in(dir, Some(&vault_id))?;
        for entry in moved {
            let key = host_key(&entry.host, entry.port);
            if !entries.iter().any(|e| host_key(&e.host, e.port) == key) {
                entries.push(entry);
            }
        }
        save_entries_in(dir, Some(&vault_id), &entries)?;
    }
    if legacy_path.exists() {
        retire_legacy_file(&legacy_path)?;
    }
    Ok(())
}

/// Caller holds the lock.
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_data_dir(app)?;
    migrate_legacy_in(&dir, || load_vault_host_indexes(app))?;
    Ok(dir)
}

fn load_entries(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Vec<KnownHostEntry>, String> {
    load_entries_in(&data_dir(app)?, vault_id)
}

fn save_entries(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    entries: &[KnownHostEntry],
) -> Result<(), String> {
    save_entries_in(&data_dir(app)?, vault_id, entries)
}

/// Verify host key. Returns Ok(true) if known and matches, Ok(false) if not in list, Err if known but mismatch.
/// Only the given vault's trusted keys count (None means Personal).
pub fn verify_known_host(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    host: &str,
    port: u16,
    fingerprint_sha256: &str,
) -> Result<bool, String> {
    let _guard = lock()?;
    let entries = load_entries(app, vault_id)?;
    let key = host_key(host, port);
    let entry = entries.iter().find(|e| host_key(&e.host, e.port) == key);
    match entry {
        Some(e) => {
            if e.fingerprint_sha256 == fingerprint_sha256 {
                Ok(true)
            } else {
                Err(format!(
                    "Host key mismatch for {}:{}. Expected fingerprint changed (possible MITM).",
                    host, port
                ))
            }
        }
        None => Ok(false),
    }
}

/// Add or update known host. Returns true if added, false if updated.
pub fn add_known_host(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    host: &str,
    port: u16,
    fingerprint_sha256: &str,
    key_type: &str,
) -> Result<KnownHostEntry, String> {
    use crate::storage::now_unix_ms;

    let _guard = lock()?;
    let mut entries = load_entries(app, vault_id)?;
    let key = host_key(host, port);
    let now = now_unix_ms();
    let entry = KnownHostEntry {
        host: host.to_string(),
        port,
        fingerprint_sha256: fingerprint_sha256.to_string(),
        key_type: key_type.to_string(),
        added_at: now,
    };
    entries.retain(|e| host_key(&e.host, e.port) != key);
    entries.push(entry.clone());
    save_entries(app, vault_id, &entries)?;
    Ok(entry)
}

#[tauri::command]
pub fn list_known_hosts(
    app: tauri::AppHandle,
    vault_id: Option<String>,
) -> Result<Vec<KnownHostEntry>, String> {
    let _guard = lock()?;
    load_entries(&app, vault_id.as_deref())
}

/// Connect to host, perform handshake, get host key fingerprint, and add to known hosts.
#[tauri::command]
pub async fn fetch_and_add_known_host(
    app: tauri::AppHandle,
    vault_id: Option<String>,
    host: String,
    port: u16,
) -> Result<KnownHostEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_and_add_known_host_sync(&app, vault_id.as_deref(), &host, port)
    })
        .await
        .map_err(|e| format!("Task panicked: {e}"))?
}

fn fetch_and_add_known_host_sync(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    host: &str,
    port: u16,
) -> Result<KnownHostEntry, String> {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let host = host.trim();
    if host.is_empty() {
        return Err("Host is required".to_string());
    }
    let address = format!("{}:{}", host, port);
    let addr = address
        .to_socket_addrs()
        .map_err(|e| format!("DNS resolve failed: {e}"))?
        .next()
        .ok_or_else(|| "DNS resolve returned no addresses".to_string())?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10))
        .map_err(|e| format!("Connect failed: {e}"))?;
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(10))).ok();

    let mut session = ssh2::Session::new().map_err(|e| format!("Create session failed: {e}"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("Handshake failed: {e}"))?;

    let (key_bytes, key_type) = session
        .host_key()
        .ok_or_else(|| "Get host key failed".to_string())?;
    let key_type_str = format!("{:?}", key_type);
    let fingerprint = compute_fingerprint_sha256(key_bytes);

    add_known_host(app, vault_id, host, port, &fingerprint, &key_type_str)
}

#[tauri::command]
pub fn remove_known_host(
    app: tauri::AppHandle,
    vault_id: Option<String>,
    host: String,
    port: u16,
) -> Result<(), String> {
    let _guard = lock()?;
    let vault_id = vault_id.as_deref();
    let mut entries = load_entries(&app, vault_id)?;
    let key = host_key(&host, port);
    let before = entries.len();
    entries.retain(|e| host_key(&e.host, e.port) != key);
    if entries.len() == before {
        return Err("Known host not found".to_string());
    }
    save_entries(&app, vault_id, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shellbeam-known-hosts-{name}-{}-{}",
            std::process::id(),
            crate::storage::now_unix_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(host: &str, port: u16, fingerprint: &str) -> KnownHostEntry {
        KnownHostEntry {
            host: host.into(),
            port,
            fingerprint_sha256: fingerprint.into(),
            key_type: "Ed25519".into(),
            added_at: 1,
        }
    }

    fn vault(id: &str, endpoints: &[(&str, u16)]) -> VaultHostIndex {
        VaultHostIndex {
            vault_id: id.into(),
            endpoints: endpoints
                .iter()
                .map(|(host, port)| (host.to_string(), *port))
                .collect::<HashSet<_>>(),
            ..VaultHostIndex::default()
        }
    }

    #[test]
    fn vaults_keep_separate_known_host_files() {
        let dir = temp_dir("separate");
        save_entries_in(&dir, Some("work"), &[entry("a.example", 22, "work-key")]).unwrap();
        assert!(dir.join("known_hosts_vault_work.json").exists());
        assert!(load_entries_in(&dir, Some("personal")).unwrap().is_empty());
        assert!(load_entries_in(&dir, None).unwrap().is_empty());
        assert_eq!(load_entries_in(&dir, Some("work")).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_file_is_split_by_owning_vaults_once() {
        let dir = temp_dir("migrate");
        save_entries_in(&dir, Some("work"), &[entry("shared.example", 22, "already")]).unwrap();
        write_json(
            &dir.join(KNOWN_HOSTS_FILE),
            &KnownHostsFile {
                entries: vec![
                    entry("shared.example", 22, "legacy-shared"),
                    entry("jump.example", 2222, "legacy-jump"),
                    entry("stray.example", 22, "legacy-stray"),
                ],
            },
        )
        .unwrap();
        let indexes = || {
            Ok(vec![
                vault("personal", &[("shared.example", 22)]),
                vault("work", &[("shared.example", 22), ("jump.example", 2222)]),
            ])
        };
        migrate_legacy_in(&dir, indexes).unwrap();

        let personal = load_entries_in(&dir, Some("personal")).unwrap();
        let fingerprints = |entries: &[KnownHostEntry]| {
            entries
                .iter()
                .map(|e| e.fingerprint_sha256.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(fingerprints(&personal), ["legacy-shared", "legacy-stray"]);
        let work = load_entries_in(&dir, Some("work")).unwrap();
        // The vault's own entry wins over the legacy duplicate.
        assert_eq!(fingerprints(&work), ["already", "legacy-jump"]);
        assert!(!dir.join(KNOWN_HOSTS_FILE).exists());
        assert!(!dir.join("known_hosts.json.migrated").exists());

        // Idempotent: no legacy file, no index load, nothing changes.
        migrate_legacy_in(&dir, || panic!("legacy file was re-read")).unwrap();
        assert_eq!(load_entries_in(&dir, Some("work")).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
