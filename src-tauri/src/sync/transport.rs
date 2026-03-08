//! A2-2: Minimal LAN P2P sync transport.
//! TCP server accepts connections; client connects to peer endpoint.
//! Protocol: newline-delimited JSON request/response with AES-256-GCM encryption.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use mdns_sd::ServiceDaemon;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
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

pub(crate) const SYNC_DEFAULT_PORT: u16 = 9123;
const READ_TIMEOUT_SECS: u64 = 30;
const WRITE_TIMEOUT_SECS: u64 = 30;

pub(crate) static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
pub(crate) static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

#[allow(dead_code)]
pub const SHELLBEAM_SERVICE_TYPE: &str = "_shellbeam._tcp.local.";
#[allow(dead_code)]
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

pub(crate) fn serve_connection(app: tauri::AppHandle, stream: TcpStream) {
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

// mDNS, server loop, and diagnostics are in transport_mdns.rs

pub fn sync_start_server(app: tauri::AppHandle, port: Option<u16>) -> Result<u16, String> {
    if SERVER_RUNNING.load(Ordering::SeqCst) {
        return Err("Sync server already running".to_string());
    }
    let port = port.unwrap_or(SYNC_DEFAULT_PORT);
    let app_clone = app.clone();
    thread::spawn(move || super::transport_mdns::server_loop(app_clone, port));
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
