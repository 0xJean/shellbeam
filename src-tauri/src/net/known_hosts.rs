//! Known hosts: store and verify SSH host key fingerprints.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::storage::{data_file_path, read_json_or_default, write_json};

const KNOWN_HOSTS_FILE: &str = "known_hosts.json";

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

fn load_entries(app: &tauri::AppHandle) -> Result<Vec<KnownHostEntry>, String> {
    let path = data_file_path(app, KNOWN_HOSTS_FILE)?;
    let file: KnownHostsFile = read_json_or_default(&path)?;
    Ok(file.entries)
}

fn save_entries(app: &tauri::AppHandle, entries: &[KnownHostEntry]) -> Result<(), String> {
    let path = data_file_path(app, KNOWN_HOSTS_FILE)?;
    write_json(
        &path,
        &KnownHostsFile {
            entries: entries.to_vec(),
        },
    )
}

/// Verify host key. Returns Ok(true) if known and matches, Ok(false) if not in list, Err if known but mismatch.
pub fn verify_known_host(
    app: &tauri::AppHandle,
    host: &str,
    port: u16,
    fingerprint_sha256: &str,
) -> Result<bool, String> {
    let entries = load_entries(app)?;
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
    host: &str,
    port: u16,
    fingerprint_sha256: &str,
    key_type: &str,
) -> Result<KnownHostEntry, String> {
    use crate::storage::now_unix_ms;

    let mut entries = load_entries(app)?;
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
    save_entries(app, &entries)?;
    Ok(entry)
}

#[tauri::command]
pub fn list_known_hosts(app: tauri::AppHandle) -> Result<Vec<KnownHostEntry>, String> {
    load_entries(&app)
}

/// Connect to host, perform handshake, get host key fingerprint, and add to known hosts.
#[tauri::command]
pub async fn fetch_and_add_known_host(
    app: tauri::AppHandle,
    host: String,
    port: u16,
) -> Result<KnownHostEntry, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_and_add_known_host_sync(&app, &host, port))
        .await
        .map_err(|e| format!("Task panicked: {e}"))?
}

fn fetch_and_add_known_host_sync(
    app: &tauri::AppHandle,
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

    add_known_host(&app, host, port, &fingerprint, &key_type_str)
}

#[tauri::command]
pub fn remove_known_host(app: tauri::AppHandle, host: String, port: u16) -> Result<(), String> {
    let mut entries = load_entries(&app)?;
    let key = host_key(&host, port);
    let before = entries.len();
    entries.retain(|e| host_key(&e.host, e.port) != key);
    if entries.len() == before {
        return Err("Known host not found".to_string());
    }
    save_entries(&app, &entries)
}
