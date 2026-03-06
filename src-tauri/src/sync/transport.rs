//! A2-2: Minimal LAN P2P sync transport.
//! TCP server accepts connections; client connects to peer endpoint.
//! Protocol: newline-delimited JSON request/response with AES-256-GCM encryption.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::storage::now_unix_ms;
use super::{SyncChangeRecord, SyncCursorRecord};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn encrypt_message(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|e| format!("encrypt: {e}"))?;
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(&out))
}

fn decrypt_message(key: &[u8; 32], encoded: &str) -> Result<Vec<u8>, String> {
    let data = B64.decode(encoded.trim()).map_err(|e| format!("b64 decode: {e}"))?;
    if data.len() < 12 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ciphertext).map_err(|e| format!("decrypt: {e}"))
}

pub(crate) fn parse_sync_secret(secret: &Option<String>) -> Option<[u8; 32]> {
    secret.as_ref().and_then(|s| {
        B64.decode(s).ok().and_then(|v| {
            if v.len() == 32 { let mut arr = [0u8; 32]; arr.copy_from_slice(&v); Some(arr) } else { None }
        })
    })
}

const SYNC_DEFAULT_PORT: u16 = 9123;
const READ_TIMEOUT_SECS: u64 = 30;
const WRITE_TIMEOUT_SECS: u64 = 30;

static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

pub const SHELLBEAM_SERVICE_TYPE: &str = "_shellbeam._tcp.local.";
pub static MDNS_DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

#[derive(Debug, Deserialize)]
struct SyncRequestRaw {
    method: String,
    params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok")]
enum SyncResponse {
    #[serde(rename = "true")]
    Ok { data: serde_json::Value },
    #[serde(rename = "false")]
    Err { error: String },
}

fn handle_request(
    app: &tauri::AppHandle,
    req: SyncRequestRaw,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<serde_json::Value, String> {
    match req.method.as_str() {
        "get_bootstrap" => {
            let bootstrap =
                super::sync_get_bootstrap(app.clone()).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(bootstrap).map_err(|e| e.to_string())?)
        }
        "query_changes" => {
            let params = req.params.as_ref();
            let since_version =
                params.and_then(|p| p.get("since_version").and_then(|v| v.as_u64()));
            let limit =
                params.and_then(|p| p.get("limit").and_then(|v| v.as_u64().map(|u| u as usize)));
            let state = super::load_sync_state_for_transport(app)?;
            let since = since_version.unwrap_or(0);
            let lim = limit.unwrap_or(200).min(2000);
            let mut items: Vec<SyncChangeRecord> = state
                .changes
                .into_iter()
                .filter(|c| c.version > since)
                .collect();
            items.sort_by_key(|c| c.version);
            if items.len() > lim {
                items.truncate(lim);
            }
            Ok(serde_json::to_value(items).map_err(|e| e.to_string())?)
        }
        "push_changes" => {
            let params = req.params.ok_or("params required")?;
            let changes: Vec<SyncChangeRecord> = serde_json::from_value(
                params
                    .get("changes")
                    .cloned()
                    .unwrap_or(serde_json::json!([])),
            )
            .map_err(|e| format!("Invalid changes: {e}"))?;
            let peer_device_id = params
                .get("peer_device_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut state = super::load_sync_state_for_transport(app)?;
            let existing_ids: HashSet<String> =
                state.changes.iter().map(|c| c.change_id.clone()).collect();
            let mut applied = 0u64;
            let next_version = state.changes.iter().map(|c| c.version).max().unwrap_or(0) + 1;
            let mut v = next_version;
            for mut rec in changes {
                if existing_ids.contains(&rec.change_id) {
                    continue;
                }
                rec.version = v;
                v += 1;
                state.changes.push(rec);
                applied += 1;
            }
            state.last_sync_at = Some(now_unix_ms());
            if let Some(p) = state
                .trusted_peers
                .iter_mut()
                .find(|p| p.peer_device_id == peer_device_id)
            {
                p.last_seen_at = now_unix_ms();
            }
            super::save_sync_state_for_transport(app, &state)?;
            Ok(serde_json::json!({ "applied": applied }))
        }
        "upsert_cursor" => {
            let params = req.params.ok_or("params required")?;
            let peer_device_id = params
                .get("peer_device_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let last_pulled_version = params.get("last_pulled_version").and_then(|v| v.as_u64());
            let last_pushed_version = params.get("last_pushed_version").and_then(|v| v.as_u64());
            let mut state = super::load_sync_state_for_transport(app)?;
            let now = now_unix_ms();
            let peer = peer_device_id.trim();
            let mut cursor = state
                .cursors
                .iter()
                .find(|c| c.peer_device_id == peer)
                .cloned()
                .unwrap_or(SyncCursorRecord {
                    peer_device_id: peer.to_string(),
                    last_pulled_version: 0,
                    last_pushed_version: 0,
                    updated_at: now,
                });
            if let Some(v) = last_pulled_version {
                cursor.last_pulled_version = v;
            }
            if let Some(v) = last_pushed_version {
                cursor.last_pushed_version = v;
            }
            cursor.updated_at = now;
            if let Some(ex) = state
                .cursors
                .iter_mut()
                .find(|c| c.peer_device_id == cursor.peer_device_id)
            {
                *ex = cursor.clone();
            } else {
                state.cursors.push(cursor.clone());
            }
            state.last_sync_at = Some(now);
            super::save_sync_state_for_transport(app, &state)?;
            Ok(serde_json::to_value(cursor).map_err(|e| e.to_string())?)
        }
        "get_full_backup" => {
            // Peer requests our full backup payload (for "pull" sync).
            // Params may include { includeHosts, includeSnippets, includeVault }
            let inc_hosts = req.params.as_ref().and_then(|p| p.get("includeHosts")).and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_snippets = req.params.as_ref().and_then(|p| p.get("includeSnippets")).and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_vault = req.params.as_ref().and_then(|p| p.get("includeVault")).and_then(|v| v.as_bool()).unwrap_or(false);

            let payload = crate::data::backup::backup_create_in_memory(app, None, inc_hosts, inc_snippets, false, false, false)
                .map_err(|e| format!("create backup: {e}"))?;
            let mut result = serde_json::to_value(&payload).map_err(|e| e.to_string())?;

            // If vault secrets requested, export them decrypted
            if inc_vault {
                let vault_state: tauri::State<'_, crate::vault::VaultState> = app.state();
                match crate::vault::vault_export_decrypted_secrets(app, &vault_state, None) {
                    Ok(secrets) if !secrets.is_empty() => {
                        result["decryptedSecrets"] = serde_json::to_value(&secrets).map_err(|e| e.to_string())?;
                        log::info!("[sync] get_full_backup: serving {} secrets + backup to peer", secrets.len());
                    }
                    Ok(_) => {
                        log::info!("[sync] get_full_backup: vault requested but no secrets");
                    }
                    Err(e) => {
                        log::warn!("[sync] get_full_backup: vault export failed ({}), skipping secrets", e);
                    }
                }
            } else {
                log::info!("[sync] get_full_backup: serving backup to peer (no vault)");
            }
            Ok(result)
        }
        "push_full_backup" => {
            // Peer pushes their full backup payload to us (for "push" sync).
            // Params: BackupPayload JSON + optional decryptedSecrets
            let params = req.params.ok_or("params required")?;
            // Extract decrypted secrets before parsing as backup (backup ignores unknown fields)
            let decrypted_secrets: Option<std::collections::HashMap<String, String>> =
                params.get("decryptedSecrets").and_then(|v| serde_json::from_value(v.clone()).ok());
            let backup: crate::data::backup::BackupPayload = serde_json::from_value(params)
                .map_err(|e| format!("parse backup payload: {e}"))?;
            let result = crate::data::backup::backup_restore_in_memory(app, &backup, None, true, true, false, false, false)
                .map_err(|e| format!("restore backup: {e}"))?;

            // Import vault secrets if present and our vault is unlocked
            let mut vault_restored = false;
            if let Some(secrets) = &decrypted_secrets {
                if !secrets.is_empty() {
                    let vault_state: tauri::State<'_, crate::vault::VaultState> = app.state();
                    match crate::vault::vault_import_decrypted_secrets(app, &vault_state, secrets, None) {
                        Ok(count) => {
                            log::info!("[sync] push_full_backup: imported {} vault secrets", count);
                            vault_restored = true;
                        }
                        Err(e) => {
                            log::warn!("[sync] push_full_backup: vault import failed ({}), skipping", e);
                        }
                    }
                }
            }

            log::info!("[sync] push_full_backup: restored {} hosts, {} snippets, vault={}",
                result.hosts_restored, result.snippets_restored, vault_restored);
            // Notify frontend to refresh data after receiving a push
            let _ = app.emit("sync-data-changed", ());
            Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
        }
        "notify_pull" => {
            // Reverse-push: peer A tells us "I have data for you, pull from me".
            // Params: { endpoint, device_id, includeHosts, includeSnippets, includeVault }
            let params = req.params.ok_or("params required")?;
            let pull_endpoint = params.get("endpoint").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let peer_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let inc_hosts = params.get("includeHosts").and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_snippets = params.get("includeSnippets").and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_vault = params.get("includeVault").and_then(|v| v.as_bool()).unwrap_or(false);
            if pull_endpoint.is_empty() {
                return Err("endpoint is required".to_string());
            }
            log::info!("[sync] notify_pull: peer {} asks us to pull from {} (hosts={}, snippets={}, vault={})",
                peer_device_id, pull_endpoint, inc_hosts, inc_snippets, inc_vault);

            // Look up encryption key from trusted peers
            let state = super::load_sync_state_for_transport(app)?;
            let enc_key = state.trusted_peers.iter()
                .find(|p| p.peer_device_id == peer_device_id)
                .and_then(|p| parse_sync_secret(&p.sync_secret));

            // Pull from peer's endpoint with options
            let data = sync_request_peer_encrypted(
                &pull_endpoint,
                "get_full_backup",
                serde_json::json!({
                    "includeHosts": inc_hosts,
                    "includeSnippets": inc_snippets,
                    "includeVault": inc_vault,
                }),
                enc_key.as_ref(),
            ).map_err(|e| format!("reverse-pull from {pull_endpoint}: {e}"))?;

            // Extract decrypted secrets from raw JSON before parsing as BackupPayload.
            // We cannot use #[serde(flatten)] because serde silently drops sibling fields.
            let decrypted_secrets: Option<std::collections::HashMap<String, String>> =
                data.get("decryptedSecrets").and_then(|v| serde_json::from_value(v.clone()).ok());
            let backup: crate::data::backup::BackupPayload = serde_json::from_value(data)
                .map_err(|e| format!("parse reverse-pull response: {e}"))?;
            let result = crate::data::backup::backup_restore_in_memory(
                app, &backup, None, inc_hosts, inc_snippets, false, false, false,
            ).map_err(|e| format!("restore reverse-pull backup: {e}"))?;

            // Import vault secrets if present
            let mut vault_restored = false;
            if inc_vault {
                if let Some(secrets) = &decrypted_secrets {
                    if !secrets.is_empty() {
                        let vault_state: tauri::State<'_, crate::vault::VaultState> = app.state();
                        match crate::vault::vault_import_decrypted_secrets(app, &vault_state, secrets, None) {
                            Ok(count) => {
                                log::info!("[sync] notify_pull: imported {} vault secrets", count);
                                vault_restored = true;
                            }
                            Err(e) => {
                                log::warn!("[sync] notify_pull: vault import failed ({}), skipping", e);
                            }
                        }
                    }
                }
            }

            log::info!("[sync] notify_pull: restored {} hosts, {} snippets, vault={}",
                result.hosts_restored, result.snippets_restored, vault_restored);

            // Notify frontend to refresh
            let _ = app.emit("sync-data-changed", ());
            Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
        }
        "pair_request" => {
            // Incoming pair request from a remote device.
            // Params: { device_id, device_name, verification_code }
            let params = req.params.ok_or("params required")?;
            let peer_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let peer_device_name = params.get("device_name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            let verification_code = params.get("verification_code").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if peer_device_id.is_empty() || verification_code.is_empty() {
                return Err("device_id and verification_code are required".to_string());
            }
            let now = now_unix_ms();
            let session_id = uuid::Uuid::new_v4().to_string();
            let session = super::SyncPairingSessionRecord {
                session_id: session_id.clone(),
                initiator_device_id: peer_device_id.clone(),
                initiator_device_name: peer_device_name.clone(),
                verification_code: verification_code.clone(),
                status: "pending".to_string(),
                created_at: now,
                expires_at: now + 5 * 60 * 1000,
                verified_at: None,
            };
            let mut state = super::load_sync_state_for_transport(app)?;
            state.pairing_sessions.push(session);
            state.last_sync_at = Some(now);
            super::save_sync_state_for_transport(app, &state)?;

            // Emit event so the UI shows the incoming pair request
            let peer_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
            use tauri::Emitter;
            let _ = app.emit("pair-request-received", serde_json::json!({
                "sessionId": session_id,
                "peerDeviceId": peer_device_id,
                "peerDeviceName": peer_device_name,
                "peerHost": peer_ip,
                "verificationCode": verification_code,
            }));
            log::info!("[pair] incoming pair_request from {} ({}) ip={}", peer_device_name, peer_device_id, peer_ip);
            Ok(serde_json::json!({ "session_id": session_id, "status": "pending" }))
        }
        "pair_confirm" => {
            // Remote device confirms the pairing. Add them as trusted peer.
            // Params: { device_id, device_name, sync_secret }
            // Note: the receiver sends this back to the initiator. The initiator
            // doesn't have the receiver's session_id, so we don't require it.
            let params = req.params.ok_or("params required")?;
            let peer_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let peer_device_name = params.get("device_name").and_then(|v| v.as_str());
            let peer_sync_secret = params.get("sync_secret").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if peer_device_id.is_empty() || peer_sync_secret.is_empty() {
                return Err("device_id and sync_secret are required".to_string());
            }
            let mut state = super::load_sync_state_for_transport(app)?;
            let now = now_unix_ms();

            // Add the remote peer's IP as endpoint
            let peer_ip = remote_addr.map(|a| format!("{}:9123", a.ip())).unwrap_or_default();

            let peer = super::SyncTrustedPeer {
                peer_device_id: peer_device_id.clone(),
                peer_device_name: peer_device_name.map(|s| s.to_string()),
                verified_at: now,
                last_seen_at: now,
                source: "network-pair".to_string(),
                peer_endpoint: if peer_ip.is_empty() { None } else { Some(peer_ip) },
                sync_secret: Some(peer_sync_secret),
            };
            if let Some(existing) = state.trusted_peers.iter_mut().find(|p| p.peer_device_id == peer_device_id) {
                *existing = peer.clone();
            } else {
                state.trusted_peers.push(peer.clone());
            }

            // Mark any pending local pairing sessions as verified
            for s in state.pairing_sessions.iter_mut() {
                if s.status == "pending" && s.expires_at > now {
                    s.status = "verified".to_string();
                    s.verified_at = Some(now);
                }
            }
            state.last_sync_at = Some(now);
            let local_device = state.local_device.clone();
            super::save_sync_state_for_transport(app, &state)?;

            use tauri::Emitter;
            let _ = app.emit("pair-confirmed", serde_json::json!({
                "peerDeviceId": peer_device_id,
                "peerDeviceName": peer_device_name,
            }));
            log::info!("[pair] pair_confirm from {} — trusted peer added", peer_device_id);

            let our_device_id = local_device.as_ref().map(|d| d.device_id.as_str()).unwrap_or("");
            let our_device_name = local_device.as_ref().map(|d| d.device_name.as_str()).unwrap_or("");
            Ok(serde_json::json!({
                "status": "confirmed",
                "device_id": our_device_id,
                "device_name": our_device_name,
            }))
        }
        _ => Err(format!("Unknown method: {}", req.method)),
    }
}

fn try_decrypt_with_any_peer(app: &tauri::AppHandle, encoded: &str) -> Option<(String, [u8; 32])> {
    let state = super::load_sync_state_for_transport(app).ok()?;
    for peer in &state.trusted_peers {
        if let Some(key) = parse_sync_secret(&peer.sync_secret) {
            if let Ok(plaintext) = decrypt_message(&key, encoded) {
                if let Ok(text) = String::from_utf8(plaintext) {
                    return Some((text, key));
                }
            }
        }
    }
    None
}

fn serve_connection(app: tauri::AppHandle, stream: TcpStream) {
    let remote_addr = stream.peer_addr().ok();
    let _ = stream.set_read_timeout(Some(Duration::from_secs(READ_TIMEOUT_SECS)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(WRITE_TIMEOUT_SECS)));
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(_) => return,
    };
    let mut writer = stream;
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.is_empty() {
        return;
    }

    let (json_str, enc_key) = if let Ok(_req) = serde_json::from_str::<SyncRequestRaw>(line.trim()) {
        (line.trim().to_string(), None)
    } else if let Some((decrypted, key)) = try_decrypt_with_any_peer(&app, line.trim()) {
        (decrypted, Some(key))
    } else {
        (line.trim().to_string(), None)
    };

    let req: SyncRequestRaw = match serde_json::from_str(&json_str) {
        Ok(r) => r,
        Err(e) => {
            let resp = SyncResponse::Err { error: format!("Parse request failed: {e}") };
            let _ = writeln!(writer, "{}", serde_json::to_string(&resp).unwrap_or_default());
            return;
        }
    };
    let result = handle_request(&app, req, remote_addr);
    let resp = match result {
        Ok(data) => SyncResponse::Ok { data },
        Err(e) => SyncResponse::Err { error: e },
    };
    let resp_json = serde_json::to_string(&resp).unwrap_or_default();
    if let Some(key) = enc_key {
        if let Ok(encrypted) = encrypt_message(&key, resp_json.as_bytes()) {
            let _ = writeln!(writer, "{encrypted}");
            return;
        }
    }
    let _ = writeln!(writer, "{resp_json}");
}

fn sanitize_hostname_for_dns(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.trim_matches('-');
    let s = if s.is_empty() { "shellbeam" } else { s };
    s.chars().take(63).collect()
}

/// Public accessor for native_device_name, used by commands.rs.
pub fn native_device_name_public() -> String {
    native_device_name()
}

/// Get a human-friendly device name using platform-native APIs.
/// iOS: UIDevice.current.name (e.g. "张剑的 iPhone")
/// macOS/other: hostname::get() with .local suffix stripped (e.g. "MacBook-Pro")
fn native_device_name() -> String {
    #[cfg(target_os = "ios")]
    {
        unsafe {
            use objc::runtime::{Class, Object};
            use objc::{msg_send, sel, sel_impl};
            let cls = Class::get("UIDevice").unwrap();
            let device: *mut Object = msg_send![cls, currentDevice];
            let name: *mut Object = msg_send![device, name];
            let utf8: *const std::os::raw::c_char = msg_send![name, UTF8String];
            if !utf8.is_null() {
                let s = std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }

    let name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default();
    // macOS hostname::get() often returns "MacBook-Pro.local" — strip the suffix
    name.strip_suffix(".local").unwrap_or(&name).to_string()
}

/// Get the device type string for mDNS TXT records.
fn device_type() -> &'static str {
    #[cfg(target_os = "ios")]
    { "phone" }
    #[cfg(target_os = "macos")]
    { "computer" }
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    { "computer" }
}

/// Find the best non-loopback, non-link-local IPv4 address suitable for LAN.
/// Prefers WiFi/Ethernet interfaces (en*) over cellular (pdp_ip*) or VPN (utun*).
fn find_lan_ipv4() -> Option<std::net::Ipv4Addr> {
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        let mut preferred: Option<std::net::Ipv4Addr> = None; // en* interfaces
        let mut fallback: Option<std::net::Ipv4Addr> = None;  // any other

        for iface in &ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                if v4.is_link_local() || v4.is_loopback() {
                    continue;
                }
                // en0/en1/en2 = WiFi or Ethernet on macOS/iOS
                if iface.name.starts_with("en") {
                    if preferred.is_none() {
                        preferred = Some(v4);
                    }
                } else if fallback.is_none() {
                    fallback = Some(v4);
                }
            }
        }
        preferred.or(fallback)
    } else {
        None
    }
}

/// On iOS, store the NSNetService pointer and its RunLoop so we can stop them later.
#[cfg(target_os = "ios")]
static IOS_NET_SERVICE: Mutex<Option<usize>> = Mutex::new(None); // stores *mut Object as usize
#[cfg(target_os = "ios")]
static IOS_SERVICE_RUNLOOP: Mutex<Option<usize>> = Mutex::new(None); // stores CFRunLoopRef as usize

/// Register mDNS service. On iOS, uses native Bonjour (NSNetService) via objc
/// so the service is published through the system mDNSResponder and discoverable
/// by other devices. On macOS, uses the mdns-sd crate.
fn register_mdns_service(port: u16) {
    let device_name = native_device_name();
    let instance_name = if device_name.is_empty() || device_name == "localhost" {
        format!("ShellBeam-{port}")
    } else {
        device_name
    };

    #[cfg(target_os = "ios")]
    {
        register_mdns_service_ios(port, &instance_name);
    }

    #[cfg(not(target_os = "ios"))]
    {
        register_mdns_service_mdns_sd(port, &instance_name);
    }
}

#[cfg(target_os = "ios")]
fn register_mdns_service_ios(port: u16, instance_name: &str) {
    // NSNetService requires an active RunLoop to publish.
    // We spawn a dedicated thread that creates the service, publishes it,
    // and runs its own RunLoop to keep the service alive.
    let name_owned = instance_name.to_string();

    std::thread::spawn(move || {
        unsafe {
            use objc::runtime::{Class, Object, BOOL};
            use objc::{msg_send, sel, sel_impl};

            let cls = Class::get("NSNetService").unwrap();
            let alloc: *mut Object = msg_send![cls, alloc];

            let ns_string_cls = Class::get("NSString").unwrap();
            let domain: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: b"\0".as_ptr()];
            let svc_type_str = b"_shellbeam._tcp.\0";
            let svc_type: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: svc_type_str.as_ptr()];
            let name_cstr = std::ffi::CString::new(name_owned.as_str()).unwrap_or_default();
            let name: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: name_cstr.as_ptr()];

            let service: *mut Object = msg_send![alloc,
                initWithDomain: domain
                type: svc_type
                name: name
                port: (port as i32)
            ];

            if service.is_null() {
                log::warn!("[iOS] NSNetService init returned nil");
                return;
            }

            // Set TXT record with device type
            let dt_key: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: b"dt\0".as_ptr()];
            let dt_val: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: b"phone\0".as_ptr()];
            let dict_cls = Class::get("NSDictionary").unwrap();
            let txt_dict: *mut Object = msg_send![dict_cls, dictionaryWithObject: dt_val forKey: dt_key];
            let ns_net_service_cls = Class::get("NSNetService").unwrap();
            let txt_data: *mut Object = msg_send![ns_net_service_cls, dataFromTXTRecordDictionary: txt_dict];
            let _: BOOL = msg_send![service, setTXTRecordData: txt_data];

            // Schedule in current thread's RunLoop and publish
            let run_loop_cls = Class::get("NSRunLoop").unwrap();
            let current_rl: *mut Object = msg_send![run_loop_cls, currentRunLoop];
            let default_mode: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: b"kCFRunLoopDefaultMode\0".as_ptr()];
            let _: () = msg_send![service, scheduleInRunLoop: current_rl forMode: default_mode];
            let _: () = msg_send![service, publish];

            log::info!("[iOS] NSNetService published: name={} type=_shellbeam._tcp. port={}", name_owned, port);

            // Get the CFRunLoopRef for this thread
            let cf_rl: *mut std::ffi::c_void = msg_send![current_rl, getCFRunLoop];

            // Store for later cleanup
            if let Ok(mut guard) = IOS_NET_SERVICE.lock() {
                *guard = Some(service as usize);
            }
            if let Ok(mut guard) = IOS_SERVICE_RUNLOOP.lock() {
                *guard = Some(cf_rl as usize);
            }

            // Run the RunLoop to keep the service alive.
            // This thread will block here until CFRunLoopStop is called.
            #[link(name = "CoreFoundation", kind = "framework")]
            extern "C" {
                fn CFRunLoopRun();
            }
            CFRunLoopRun();
            log::info!("[iOS] NSNetService RunLoop exited");
        }
    });

    log::info!("[iOS] mDNS Bonjour service thread started: name={} port={}", instance_name, port);
}

#[cfg(not(target_os = "ios"))]
fn register_mdns_service_mdns_sd(port: u16, instance_name: &str) {
    let dns_safe = sanitize_hostname_for_dns(instance_name);
    let host_name = format!("{dns_safe}.local.");
    let ip_str = find_lan_ipv4()
        .map(|ip| ip.to_string())
        .unwrap_or_default();

    let mut props = HashMap::new();
    props.insert("dt".to_string(), device_type().to_string());

    match ServiceDaemon::new() {
        Ok(daemon) => {
            let service_result = ServiceInfo::new(
                SHELLBEAM_SERVICE_TYPE,
                instance_name,
                &host_name,
                &ip_str,
                port,
                Some(props),
            ).map(|s| s.enable_addr_auto());
            match service_result {
                Ok(info) => {
                    if let Err(e) = daemon.register(info) {
                        log::warn!("mDNS register failed: {e}");
                    } else {
                        log::info!("mDNS registered: name={instance_name} host={host_name} ip={ip_str} port={port} type={}", device_type());
                    }
                }
                Err(e) => log::warn!("mDNS ServiceInfo creation failed: {e}"),
            }
            if let Ok(mut guard) = MDNS_DAEMON.lock() {
                *guard = Some(daemon);
            }
        }
        Err(e) => log::warn!("mDNS daemon creation failed: {e}"),
    }
}

fn unregister_mdns_service() {
    #[cfg(target_os = "ios")]
    {
        // Stop the NSNetService
        if let Ok(mut guard) = IOS_NET_SERVICE.lock() {
            if let Some(ptr) = guard.take() {
                unsafe {
                    use objc::runtime::Object;
                    use objc::{msg_send, sel, sel_impl};
                    let service = ptr as *mut Object;
                    let _: () = msg_send![service, stop];
                    log::info!("[iOS] NSNetService stopped");
                }
            }
        }
        // Stop the dedicated RunLoop thread
        if let Ok(mut guard) = IOS_SERVICE_RUNLOOP.lock() {
            if let Some(rl_ptr) = guard.take() {
                unsafe {
                    #[link(name = "CoreFoundation", kind = "framework")]
                    extern "C" {
                        fn CFRunLoopStop(rl: *mut std::ffi::c_void);
                    }
                    CFRunLoopStop(rl_ptr as *mut std::ffi::c_void);
                    log::info!("[iOS] NSNetService RunLoop stopped");
                }
            }
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        if let Ok(mut guard) = MDNS_DAEMON.lock() {
            if let Some(daemon) = guard.take() {
                daemon.shutdown().ok();
                log::info!("mDNS service unregistered");
            }
        }
    }
}

fn server_loop(app: tauri::AppHandle, port: u16) {
    let listener = match TcpListener::bind(format!("0.0.0.0:{port}")) {
        Ok(l) => l,
        Err(e) => {
            log::error!("Sync server bind failed: {e}");
            SERVER_RUNNING.store(false, Ordering::SeqCst);
            SERVER_PORT.store(0, Ordering::SeqCst);
            return;
        }
    };
    SERVER_RUNNING.store(true, Ordering::SeqCst);
    SERVER_PORT.store(port, Ordering::SeqCst);
    register_mdns_service(port);
    log::info!("Sync server listening on 0.0.0.0:{port}");
    for stream in listener.incoming() {
        if !SERVER_RUNNING.load(Ordering::SeqCst) {
            break;
        }
        match stream {
            Ok(s) => {
                let app_clone = app.clone();
                thread::spawn(move || serve_connection(app_clone, s));
            }
            Err(e) => log::warn!("Sync server accept error: {e}"),
        }
    }
    unregister_mdns_service();
    SERVER_RUNNING.store(false, Ordering::SeqCst);
    SERVER_PORT.store(0, Ordering::SeqCst);
}

/// Diagnostic: test each step of mDNS registration and return results.
pub fn mdns_diagnose() -> Vec<String> {
    let mut log = Vec::new();

    // Step 1: device name & type
    let device_name = native_device_name();
    log.push(format!("[OK] native_device_name() = {:?}", device_name));
    log.push(format!("[OK] device_type() = {:?}", device_type()));

    // Step 2: LAN IP (prefers en* interfaces)
    match find_lan_ipv4() {
        Some(ip) => log.push(format!("[OK] LAN IPv4 = {}", ip)),
        None => log.push("[WARN] No LAN IPv4 found".to_string()),
    }

    // Step 3: network interfaces (summary)
    match if_addrs::get_if_addrs() {
        Ok(ifaces) => {
            let ipv4_non_lo: Vec<_> = ifaces.iter()
                .filter(|i| !i.is_loopback() && matches!(i.ip(), std::net::IpAddr::V4(_)))
                .collect();
            log.push(format!("[OK] if_addrs: {} total, {} non-loopback IPv4", ifaces.len(), ipv4_non_lo.len()));
            for iface in &ipv4_non_lo {
                log.push(format!("  - {} ip={}", iface.name, iface.ip()));
            }
        }
        Err(e) => log.push(format!("[FAIL] if_addrs error: {e}")),
    }

    // Step 4: computed registration params
    let port = SERVER_PORT.load(Ordering::SeqCst);
    let test_port = if port > 0 { port } else { SYNC_DEFAULT_PORT };
    log.push(format!("[INFO] sync server port = {} (0 = not started)", port));

    let instance_name = if device_name.is_empty() || device_name == "localhost" {
        format!("ShellBeam-{test_port}")
    } else {
        device_name
    };
    let dns_safe = sanitize_hostname_for_dns(&instance_name);
    let host_name = format!("{dns_safe}.local.");
    let ip_str = find_lan_ipv4().map(|ip| ip.to_string()).unwrap_or_default();

    log.push(format!("[INFO] instance={:?} host={:?} ip={:?} dt={:?}", instance_name, host_name, ip_str, device_type()));

    // Step 5: test register
    match ServiceDaemon::new() {
        Ok(daemon) => {
            log.push("[OK] ServiceDaemon::new() succeeded".to_string());
            match ServiceInfo::new(
                SHELLBEAM_SERVICE_TYPE,
                &instance_name,
                &host_name,
                &ip_str,
                test_port,
                None,
            ) {
                Ok(info) => {
                    let info = info.enable_addr_auto();
                    log.push("[OK] ServiceInfo::new() succeeded".to_string());
                    match daemon.register(info) {
                        Ok(_) => {
                            log.push("[OK] daemon.register() succeeded".to_string());
                            std::thread::sleep(std::time::Duration::from_secs(2));
                            let _ = daemon.shutdown();
                            log.push("[OK] test service unregistered".to_string());
                        }
                        Err(e) => log.push(format!("[FAIL] daemon.register() error: {e}")),
                    }
                }
                Err(e) => log.push(format!("[FAIL] ServiceInfo::new() error: {e}")),
            }
        }
        Err(e) => log.push(format!("[FAIL] ServiceDaemon::new() error: {e}")),
    }

    log
}

pub fn sync_start_server(app: tauri::AppHandle, port: Option<u16>) -> Result<u16, String> {
    if SERVER_RUNNING.load(Ordering::SeqCst) {
        return Err("Sync server already running".to_string());
    }
    let port = port.unwrap_or(SYNC_DEFAULT_PORT);
    let app_clone = app.clone();
    thread::spawn(move || server_loop(app_clone, port));
    Ok(port)
}

pub fn sync_server_status() -> (bool, u16) {
    let running = SERVER_RUNNING.load(Ordering::SeqCst);
    let port = SERVER_PORT.load(Ordering::SeqCst);
    (running, port)
}

pub fn sync_request_peer_encrypted(
    endpoint: &str,
    method: &str,
    params: serde_json::Value,
    secret: Option<&[u8; 32]>,
) -> Result<serde_json::Value, String> {
    let addr: std::net::SocketAddr = endpoint.parse()
        .map_err(|e| format!("Invalid endpoint {endpoint}: {e}"))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("Connect to {endpoint} failed: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(READ_TIMEOUT_SECS))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(WRITE_TIMEOUT_SECS))).ok();
    let req = serde_json::json!({ "method": method, "params": params });
    let req_str = req.to_string();
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;

    if let Some(key) = secret {
        let encrypted = encrypt_message(key, req_str.as_bytes())?;
        writeln!(writer, "{encrypted}").map_err(|e| e.to_string())?;
    } else {
        writeln!(writer, "{req_str}").map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;

    let resp_str = if let Some(key) = secret {
        let decrypted = decrypt_message(key, line.trim())?;
        String::from_utf8(decrypted).map_err(|e| format!("UTF-8 decode: {e}"))?
    } else {
        line.trim().to_string()
    };

    let resp: serde_json::Value =
        serde_json::from_str(&resp_str).map_err(|e| format!("Parse response failed: {e}"))?;
    let is_ok = resp.get("ok").map(|v| v.as_bool() == Some(true) || v.as_str() == Some("true")).unwrap_or(false);
    if is_ok {
        resp.get("data").cloned().ok_or_else(|| "Missing data in response".to_string())
    } else {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
        Err(err.to_string())
    }
}
