//! Request handler for the sync transport protocol.
//! Extracted from transport.rs to keep files under 500 lines.

use std::collections::HashSet;
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::storage::now_unix_ms;
use super::{SyncChangeRecord, SyncCursorRecord};
use super::transport::{parse_sync_secret, sync_request_peer_encrypted};

#[derive(Debug, Serialize)]
#[serde(tag = "ok")]
pub(crate) enum SyncResponse {
    #[serde(rename = "true")]
    Ok { data: serde_json::Value },
    #[serde(rename = "false")]
    Err { error: String },
}

pub(crate) fn handle_request(
    app: &tauri::AppHandle,
    method: &str,
    params: Option<serde_json::Value>,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<serde_json::Value, String> {
    match method {
        "get_bootstrap" => {
            let bootstrap =
                super::sync_get_bootstrap(app.clone()).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(bootstrap).map_err(|e| e.to_string())?)
        }
        "query_changes" => {
            let since_version =
                params.as_ref().and_then(|p| p.get("since_version").and_then(|v| v.as_u64()));
            let limit =
                params.as_ref().and_then(|p| p.get("limit").and_then(|v| v.as_u64().map(|u| u as usize)));
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
            let params = params.ok_or("params required")?;
            let changes: Vec<SyncChangeRecord> = serde_json::from_value(
                params.get("changes").cloned().unwrap_or(serde_json::json!([])),
            ).map_err(|e| format!("Invalid changes: {e}"))?;
            let peer_device_id = params
                .get("peer_device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut state = super::load_sync_state_for_transport(app)?;
            let existing_ids: HashSet<String> =
                state.changes.iter().map(|c| c.change_id.clone()).collect();
            let mut applied = 0u64;
            let next_version = state.changes.iter().map(|c| c.version).max().unwrap_or(0) + 1;
            let mut v = next_version;
            for mut rec in changes {
                if existing_ids.contains(&rec.change_id) { continue; }
                rec.version = v;
                v += 1;
                state.changes.push(rec);
                applied += 1;
            }
            state.last_sync_at = Some(now_unix_ms());
            if let Some(p) = state.trusted_peers.iter_mut().find(|p| p.peer_device_id == peer_device_id) {
                p.last_seen_at = now_unix_ms();
            }
            super::save_sync_state_for_transport(app, &state)?;
            Ok(serde_json::json!({ "applied": applied }))
        }
        "upsert_cursor" => {
            let params = params.ok_or("params required")?;
            let peer_device_id = params
                .get("peer_device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let last_pulled_version = params.get("last_pulled_version").and_then(|v| v.as_u64());
            let last_pushed_version = params.get("last_pushed_version").and_then(|v| v.as_u64());
            let mut state = super::load_sync_state_for_transport(app)?;
            let now = now_unix_ms();
            let peer = peer_device_id.trim();
            let mut cursor = state.cursors.iter()
                .find(|c| c.peer_device_id == peer).cloned()
                .unwrap_or(SyncCursorRecord {
                    peer_device_id: peer.to_string(),
                    last_pulled_version: 0,
                    last_pushed_version: 0,
                    updated_at: now,
                });
            if let Some(v) = last_pulled_version { cursor.last_pulled_version = v; }
            if let Some(v) = last_pushed_version { cursor.last_pushed_version = v; }
            cursor.updated_at = now;
            if let Some(ex) = state.cursors.iter_mut().find(|c| c.peer_device_id == cursor.peer_device_id) {
                *ex = cursor.clone();
            } else {
                state.cursors.push(cursor.clone());
            }
            state.last_sync_at = Some(now);
            super::save_sync_state_for_transport(app, &state)?;
            Ok(serde_json::to_value(cursor).map_err(|e| e.to_string())?)
        }
        "get_full_backup" => {
            let inc_hosts = params.as_ref().and_then(|p| p.get("includeHosts")).and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_snippets = params.as_ref().and_then(|p| p.get("includeSnippets")).and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_vault = params.as_ref().and_then(|p| p.get("includeVault")).and_then(|v| v.as_bool()).unwrap_or(false);

            let payload = crate::data::backup::backup_create_in_memory(app, None, inc_hosts, inc_snippets, false, false, false)
                .map_err(|e| format!("create backup: {e}"))?;
            let mut result = serde_json::to_value(&payload).map_err(|e| e.to_string())?;

            if inc_vault {
                let vault_state: tauri::State<'_, crate::vault::VaultState> = app.state();
                match crate::vault::vault_export_decrypted_secrets(app, &vault_state, None) {
                    Ok(secrets) if !secrets.is_empty() => {
                        result["decryptedSecrets"] = serde_json::to_value(&secrets).map_err(|e| e.to_string())?;
                        log::info!("[sync] get_full_backup: serving {} secrets + backup to peer", secrets.len());
                    }
                    Ok(_) => log::info!("[sync] get_full_backup: vault requested but no secrets"),
                    Err(e) => log::warn!("[sync] get_full_backup: vault export failed ({}), skipping secrets", e),
                }
            } else {
                log::info!("[sync] get_full_backup: serving backup to peer (no vault)");
            }
            Ok(result)
        }
        "push_full_backup" => {
            let params = params.ok_or("params required")?;
            let decrypted_secrets: Option<std::collections::HashMap<String, String>> =
                params.get("decryptedSecrets").and_then(|v| serde_json::from_value(v.clone()).ok());
            let backup: crate::data::backup::BackupPayload = serde_json::from_value(params)
                .map_err(|e| format!("parse backup payload: {e}"))?;
            let result = crate::data::backup::backup_restore_in_memory(app, &backup, None, true, true, false, false, false)
                .map_err(|e| format!("restore backup: {e}"))?;

            let mut vault_restored = false;
            if let Some(secrets) = &decrypted_secrets {
                if !secrets.is_empty() {
                    let vault_state: tauri::State<'_, crate::vault::VaultState> = app.state();
                    match crate::vault::vault_import_decrypted_secrets(app, &vault_state, secrets, None) {
                        Ok(count) => { log::info!("[sync] push_full_backup: imported {} vault secrets", count); vault_restored = true; }
                        Err(e) => log::warn!("[sync] push_full_backup: vault import failed ({}), skipping", e),
                    }
                }
            }
            log::info!("[sync] push_full_backup: restored {} hosts, {} snippets, vault={}",
                result.hosts_restored, result.snippets_restored, vault_restored);
            let _ = app.emit("sync-data-changed", ());
            Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
        }
        "notify_pull" => {
            let params = params.ok_or("params required")?;
            let pull_endpoint = params.get("endpoint").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let peer_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let inc_hosts = params.get("includeHosts").and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_snippets = params.get("includeSnippets").and_then(|v| v.as_bool()).unwrap_or(true);
            let inc_vault = params.get("includeVault").and_then(|v| v.as_bool()).unwrap_or(false);
            if pull_endpoint.is_empty() { return Err("endpoint is required".to_string()); }
            log::info!("[sync] notify_pull: peer {} asks us to pull from {} (hosts={}, snippets={}, vault={})",
                peer_device_id, pull_endpoint, inc_hosts, inc_snippets, inc_vault);

            let state = super::load_sync_state_for_transport(app)?;
            let enc_key = state.trusted_peers.iter()
                .find(|p| p.peer_device_id == peer_device_id)
                .and_then(|p| parse_sync_secret(&p.sync_secret));

            let data = sync_request_peer_encrypted(
                &pull_endpoint, "get_full_backup",
                serde_json::json!({ "includeHosts": inc_hosts, "includeSnippets": inc_snippets, "includeVault": inc_vault }),
                enc_key.as_ref(),
            ).map_err(|e| format!("reverse-pull from {pull_endpoint}: {e}"))?;

            let decrypted_secrets: Option<std::collections::HashMap<String, String>> =
                data.get("decryptedSecrets").and_then(|v| serde_json::from_value(v.clone()).ok());
            let backup: crate::data::backup::BackupPayload = serde_json::from_value(data)
                .map_err(|e| format!("parse reverse-pull response: {e}"))?;
            let result = crate::data::backup::backup_restore_in_memory(
                app, &backup, None, inc_hosts, inc_snippets, false, false, false,
            ).map_err(|e| format!("restore reverse-pull backup: {e}"))?;

            let mut vault_restored = false;
            if inc_vault {
                if let Some(secrets) = &decrypted_secrets {
                    if !secrets.is_empty() {
                        let vault_state: tauri::State<'_, crate::vault::VaultState> = app.state();
                        match crate::vault::vault_import_decrypted_secrets(app, &vault_state, secrets, None) {
                            Ok(count) => { log::info!("[sync] notify_pull: imported {} vault secrets", count); vault_restored = true; }
                            Err(e) => log::warn!("[sync] notify_pull: vault import failed ({}), skipping", e),
                        }
                    }
                }
            }
            log::info!("[sync] notify_pull: restored {} hosts, {} snippets, vault={}",
                result.hosts_restored, result.snippets_restored, vault_restored);
            let _ = app.emit("sync-data-changed", ());
            Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
        }
        "check_pending_push" => {
            let params = params.ok_or("params required")?;
            let requester_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if requester_device_id.is_empty() {
                return Err("device_id is required".to_string());
            }
            let has_pending = super::pending_push_check(&requester_device_id);
            log::info!("[sync] check_pending_push from {}: has_pending={}", requester_device_id, has_pending);
            Ok(serde_json::json!({ "hasPending": has_pending }))
        }
        "claim_pending_push" => {
            let params = params.ok_or("params required")?;
            let requester_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if requester_device_id.is_empty() {
                return Err("device_id is required".to_string());
            }
            match super::pending_push_claim(&requester_device_id) {
                Some(pending) => {
                    log::info!("[sync] claim_pending_push from {}: delivering pending push payload (created_at={})",
                        requester_device_id, pending.created_at);
                    // Return the full backup payload to the requester so they can restore locally
                    Ok(serde_json::json!({
                        "claimed": true,
                        "backup": pending.payload,
                        "includeHosts": pending.include_hosts,
                        "includeSnippets": pending.include_snippets,
                        "includeVault": pending.include_vault,
                    }))
                }
                None => {
                    log::info!("[sync] claim_pending_push from {}: no pending push", requester_device_id);
                    Ok(serde_json::json!({ "claimed": false }))
                }
            }
        }
        "pair_request" => {
            let params = params.ok_or("params required")?;
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

            let peer_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
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
            let params = params.ok_or("params required")?;
            let peer_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let peer_device_name = params.get("device_name").and_then(|v| v.as_str());
            let peer_sync_secret = params.get("sync_secret").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if peer_device_id.is_empty() || peer_sync_secret.is_empty() {
                return Err("device_id and sync_secret are required".to_string());
            }
            let mut state = super::load_sync_state_for_transport(app)?;
            let now = now_unix_ms();
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
            for s in state.pairing_sessions.iter_mut() {
                if s.status == "pending" && s.expires_at > now {
                    s.status = "verified".to_string();
                    s.verified_at = Some(now);
                }
            }
            state.last_sync_at = Some(now);
            let local_device = state.local_device.clone();
            super::save_sync_state_for_transport(app, &state)?;

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
        "pair_check" => {
            let params = params.ok_or("params required")?;
            let initiator_device_id = params.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if initiator_device_id.is_empty() {
                return Err("device_id is required".to_string());
            }
            let state = super::load_sync_state_for_transport(app)?;
            if let Some(peer) = state.trusted_peers.iter().find(|p| p.peer_device_id == initiator_device_id) {
                let local_device = state.local_device.clone();
                let our_device_id = local_device.as_ref().map(|d| d.device_id.as_str()).unwrap_or("");
                let our_device_name = local_device.as_ref().map(|d| d.device_name.as_str()).unwrap_or("");
                Ok(serde_json::json!({
                    "status": "confirmed",
                    "device_id": our_device_id,
                    "device_name": our_device_name,
                    "sync_secret": peer.sync_secret,
                }))
            } else {
                Ok(serde_json::json!({ "status": "pending" }))
            }
        }
        _ => Err(format!("Unknown method: {}", method)),
    }
}
