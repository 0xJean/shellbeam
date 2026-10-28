use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::Emitter;

use super::{load_sync_state, save_sync_state, SyncTrustedPeer};
use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::storage::now_unix_ms;
use crate::vault::VaultState;

use super::transport::parse_sync_secret;
use super::vault_ref::{local_vault_ref, resolve_vault_param, vault_ref_json, VAULT_PARAM};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncDataOptions {
    #[serde(default = "default_true")]
    pub include_hosts: bool,
    #[serde(default = "default_true")]
    pub include_snippets: bool,
    #[serde(default)]
    pub include_vault: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncUpdatePeerEndpointRequest {
    peer_device_id: String,
    peer_endpoint: Option<String>,
}

#[tauri::command]
pub fn sync_update_peer_endpoint(
    app: tauri::AppHandle,
    payload: SyncUpdatePeerEndpointRequest,
) -> Result<SyncTrustedPeer, String> {
    if payload.peer_device_id.trim().is_empty() {
        return Err(standard_error_payload(
            "validation_error",
            "sync",
            false,
            "peerDeviceId is required",
            None,
        ));
    }
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "update peer endpoint", err))?;
    let peer_id = payload.peer_device_id.trim();
    let endpoint = payload
        .peer_endpoint
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let peer = state
        .trusted_peers
        .iter_mut()
        .find(|p| p.peer_device_id == peer_id)
        .ok_or_else(|| {
            standard_error_payload("not_found", "sync", false, "Trusted peer not found", None)
        })?;
    peer.peer_endpoint = endpoint;
    peer.last_seen_at = now_unix_ms();
    state.last_sync_at = Some(now_unix_ms());
    let peer_clone = peer.clone();
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "update peer endpoint", err))?;
    Ok(peer_clone)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemovePeerRequest {
    peer_device_id: String,
}

#[tauri::command]
pub fn sync_remove_trusted_peer(
    app: tauri::AppHandle,
    payload: SyncRemovePeerRequest,
) -> Result<(), String> {
    let mut state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "remove peer", err))?;
    let before = state.trusted_peers.len();
    state
        .trusted_peers
        .retain(|p| p.peer_device_id != payload.peer_device_id);
    if state.trusted_peers.len() == before {
        return Err(standard_error_payload(
            "not_found",
            "sync",
            false,
            "Trusted peer not found",
            None,
        ));
    }
    state
        .cursors
        .retain(|c| c.peer_device_id != payload.peer_device_id);
    state.last_sync_at = Some(now_unix_ms());
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "remove peer", err))?;
    log::info!("[sync] removed trusted peer: {}", payload.peer_device_id);
    Ok(())
}

#[tauri::command]
pub fn sync_start_server(app: tauri::AppHandle, port: Option<u16>) -> Result<u16, String> {
    super::transport::sync_start_server(app, port)
        .map_err(|e| standard_error_from_raw("sync", "start server", e))
}

#[tauri::command]
pub fn sync_server_status() -> (bool, u16) {
    super::transport::sync_server_status()
}

#[tauri::command]
pub fn mdns_diagnose() -> Vec<String> {
    super::transport_mdns::mdns_diagnose()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullRequest {
    peer_device_id: String,
    #[serde(default)]
    options: Option<SyncDataOptions>,
    /// Local vault to restore into; missing → Personal.
    #[serde(default)]
    vault_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResult {
    hosts_restored: usize,
    snippets_restored: usize,
    vault_restored: bool,
}

/// Pull = request full backup from peer → restore locally.
/// Optionally includes vault secrets (decrypted by peer, re-encrypted locally).
#[tauri::command]
pub async fn sync_pull_from_peer(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    payload: SyncPullRequest,
) -> Result<SyncPullResult, String> {
    let opts = payload.options.unwrap_or(SyncDataOptions {
        include_hosts: true,
        include_snippets: true,
        include_vault: false,
    });
    let sync_state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "pull", err))?;
    let peer = sync_state
        .trusted_peers
        .iter()
        .find(|p| p.peer_device_id == payload.peer_device_id)
        .ok_or_else(|| {
            standard_error_payload("not_found", "sync", false, "Trusted peer not found", None)
        })?;
    let endpoint = peer
        .peer_endpoint
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            standard_error_payload(
                "validation_error",
                "sync",
                false,
                "Peer endpoint not configured",
                None,
            )
        })?
        .to_string();
    let enc_key = parse_sync_secret(&peer.sync_secret);
    let req_opts = opts.clone();
    let (vault_id, vault_name) = local_vault_ref(&app, payload.vault_id.as_deref())
        .map_err(|e| standard_error_from_raw("sync", "pull", e))?;
    let vault_param = vault_ref_json(&vault_id, &vault_name);

    let ep = endpoint.clone();
    let data = tauri::async_runtime::spawn_blocking(move || {
        super::transport::sync_request_peer_encrypted(
            &ep,
            "get_full_backup",
            serde_json::json!({
                "includeHosts": req_opts.include_hosts,
                "includeSnippets": req_opts.include_snippets,
                "includeVault": req_opts.include_vault,
                VAULT_PARAM: vault_param,
            }),
            enc_key.as_ref(),
        )
    })
    .await
    .map_err(|e| standard_error_from_raw("sync", "pull", format!("{e}")))?
    .map_err(|e| standard_error_from_raw("sync", "pull request", e))?;

    let decrypted_secrets: Option<HashMap<String, String>> = data
        .get("decryptedSecrets")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let backup: crate::data::backup::BackupPayload = serde_json::from_value(data)
        .map_err(|e| standard_error_from_raw("sync", "parse pull response", e.to_string()))?;

    let result = crate::data::backup::backup_restore_in_memory(
        &app,
        &backup,
        Some(&vault_id),
        opts.include_hosts,
        opts.include_snippets,
        false,
        false,
        false,
    )
    .map_err(|e| standard_error_from_raw("sync", "restore pull backup", e))?;

    let mut vault_restored = false;
    if opts.include_vault {
        if let Some(secrets) = &decrypted_secrets {
            if !secrets.is_empty() {
                let count = crate::vault::vault_import_decrypted_secrets(
                    &app,
                    &state,
                    secrets,
                    Some(&vault_id),
                )
                .map_err(|e| standard_error_from_raw("sync", "import vault secrets", e))?;
                log::info!("[sync] pull: imported {} vault secrets", count);
                vault_restored = true;
            }
        }
    }

    log::info!(
        "[sync] pull complete into vault {}: {} hosts, {} snippets, vault={}",
        vault_id,
        result.hosts_restored,
        result.snippets_restored,
        vault_restored
    );

    let mut sync_state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "pull", err))?;
    if let Some(p) = sync_state
        .trusted_peers
        .iter_mut()
        .find(|p| p.peer_device_id == payload.peer_device_id)
    {
        p.last_seen_at = now_unix_ms();
    }
    sync_state.last_sync_at = Some(now_unix_ms());
    save_sync_state(&app, &sync_state)
        .map_err(|err| standard_error_from_raw("sync", "pull", err))?;

    Ok(SyncPullResult {
        hosts_restored: result.hosts_restored,
        snippets_restored: result.snippets_restored,
        vault_restored,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushRequest {
    peer_device_id: String,
    #[serde(default)]
    options: Option<SyncDataOptions>,
    /// Local vault to push from; missing → Personal.
    #[serde(default)]
    vault_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResult {
    hosts_pushed: usize,
    snippets_pushed: usize,
    vault_pushed: bool,
}

/// Push = notify peer to pull from us (reverse-push).
/// Fallback: if notify_pull fails, try direct push_full_backup.
#[tauri::command]
pub async fn sync_push_to_peer(
    app: tauri::AppHandle,
    vault_state: tauri::State<'_, VaultState>,
    payload: SyncPushRequest,
) -> Result<SyncPushResult, String> {
    let opts = payload.options.unwrap_or(SyncDataOptions {
        include_hosts: true,
        include_snippets: true,
        include_vault: false,
    });
    let sync_state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "push", err))?;
    let peer = sync_state
        .trusted_peers
        .iter()
        .find(|p| p.peer_device_id == payload.peer_device_id)
        .ok_or_else(|| {
            standard_error_payload("not_found", "sync", false, "Trusted peer not found", None)
        })?;
    let peer_endpoint = peer
        .peer_endpoint
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            standard_error_payload(
                "validation_error",
                "sync",
                false,
                "Peer endpoint not configured",
                None,
            )
        })?
        .to_string();
    let enc_key = parse_sync_secret(&peer.sync_secret);
    let (vault_id, vault_name) = local_vault_ref(&app, payload.vault_id.as_deref())
        .map_err(|e| standard_error_from_raw("sync", "push", e))?;
    let vault_param = vault_ref_json(&vault_id, &vault_name);

    let backup = crate::data::backup::backup_create_in_memory(
        &app,
        Some(&vault_id),
        opts.include_hosts,
        opts.include_snippets,
        false,
        false,
        false,
    )
    .map_err(|e| standard_error_from_raw("sync", "create push backup", e))?;
    let hosts_count = backup.hosts.as_ref().map(|h: &Vec<_>| h.len()).unwrap_or(0);
    let snippets_count = backup
        .snippets
        .as_ref()
        .map(|s: &Vec<_>| s.len())
        .unwrap_or(0);

    let decrypted_secrets: Option<HashMap<String, String>> = if opts.include_vault {
        match crate::vault::vault_export_decrypted_secrets(&app, &vault_state, Some(&vault_id)) {
            Ok(secrets) if !secrets.is_empty() => Some(secrets),
            Ok(_) => None,
            Err(e) => return Err(standard_error_from_raw("sync", "export vault secrets", e)),
        }
    } else {
        None
    };
    let has_vault = decrypted_secrets.is_some();

    let mut push_payload = serde_json::to_value(&backup)
        .map_err(|e| standard_error_from_raw("sync", "serialize push backup", e.to_string()))?;
    if let Some(ref secrets) = decrypted_secrets {
        push_payload["decryptedSecrets"] = serde_json::to_value(secrets).map_err(|e| {
            standard_error_from_raw("sync", "serialize vault secrets", e.to_string())
        })?;
    }
    // Direct and pending pushes carry the vault ref inside the payload.
    push_payload[VAULT_PARAM] = vault_param.clone();

    let (server_running, server_port) = super::transport::sync_server_status();
    let local_device_id = sync_state
        .local_device
        .as_ref()
        .map(|d| d.device_id.clone())
        .unwrap_or_default();

    if server_running && server_port > 0 {
        let our_host = get_local_ip_for_peer(&peer_endpoint);
        let our_endpoint = format!("{}:{}", our_host, server_port);
        log::info!(
            "[sync] push: trying notify_pull → peer={}, our_endpoint={}",
            peer_endpoint,
            our_endpoint
        );

        let ep = peer_endpoint.clone();
        let ek = enc_key;
        let oe = our_endpoint.clone();
        let did = local_device_id.clone();
        let oo = opts.clone();
        let vp = vault_param.clone();
        let notify_result = tauri::async_runtime::spawn_blocking(move || {
            super::transport::sync_request_peer_encrypted(
                &ep, "notify_pull",
                serde_json::json!({
                    "endpoint": oe, "device_id": did,
                    "includeHosts": oo.include_hosts, "includeSnippets": oo.include_snippets, "includeVault": oo.include_vault,
                    VAULT_PARAM: vp,
                }),
                ek.as_ref(),
            )
        }).await;

        match notify_result {
            Ok(Ok(resp)) => {
                // Check if the peer actually restored any data from the notify_pull.
                // The response contains the restore result from the peer side.
                let peer_hosts = resp
                    .get("hosts_restored")
                    .or_else(|| resp.get("hostsRestored"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let peer_snippets = resp
                    .get("snippets_restored")
                    .or_else(|| resp.get("snippetsRestored"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if peer_hosts > 0 || peer_snippets > 0 || (hosts_count == 0 && snippets_count == 0)
                {
                    log::info!("[sync] push (notify_pull) complete: {} hosts, {} snippets, vault={} (peer restored: {} hosts, {} snippets)",
                        hosts_count, snippets_count, has_vault, peer_hosts, peer_snippets);
                    update_push_last_seen(&app, &payload.peer_device_id)?;
                    return Ok(SyncPushResult {
                        hosts_pushed: hosts_count,
                        snippets_pushed: snippets_count,
                        vault_pushed: has_vault,
                    });
                } else {
                    log::warn!("[sync] push: notify_pull succeeded but peer restored 0 items (we have {} hosts, {} snippets), falling back to direct push",
                        hosts_count, snippets_count);
                }
            }
            Ok(Err(e)) => log::warn!(
                "[sync] push: notify_pull failed ({}), falling back to direct push",
                e
            ),
            Err(e) => log::warn!(
                "[sync] push: notify_pull spawn error ({}), falling back to direct push",
                e
            ),
        }
    } else {
        log::warn!("[sync] push: local sync server not running, falling back to direct push");
    }

    log::info!("[sync] push: fallback direct push to {}", peer_endpoint);
    let ep = peer_endpoint.clone();
    let ek = enc_key;
    let direct_result = tauri::async_runtime::spawn_blocking(move || {
        super::transport::sync_request_peer_encrypted(
            &ep,
            "push_full_backup",
            push_payload.clone(),
            ek.as_ref(),
        )
        .map_err(|e| (e, push_payload))
    })
    .await
    .map_err(|e| {
        log::error!("[sync] push: spawn error: {e}");
        standard_error_from_raw("sync", "push", format!("{e}"))
    })?;

    match direct_result {
        Ok(_resp) => {
            log::info!(
                "[sync] push (direct) complete: {} hosts, {} snippets, vault={}",
                hosts_count,
                snippets_count,
                has_vault
            );
            update_push_last_seen(&app, &payload.peer_device_id)?;
            Ok(SyncPushResult {
                hosts_pushed: hosts_count,
                snippets_pushed: snippets_count,
                vault_pushed: has_vault,
            })
        }
        Err((err, push_payload)) => {
            // Both notify_pull and direct push failed — likely Android blocking inbound TCP.
            // Store as pending push so Android can claim it when it connects to us.
            log::warn!(
                "[sync] push: direct push also failed ({}), storing as pending push for peer {}",
                err,
                payload.peer_device_id
            );
            super::pending_push_store(
                &payload.peer_device_id,
                super::PendingPush {
                    payload: push_payload,
                    created_at: crate::storage::now_unix_ms(),
                    include_hosts: opts.include_hosts,
                    include_snippets: opts.include_snippets,
                    include_vault: opts.include_vault,
                },
            );
            let _ = app.emit(
                "sync-pending-push-stored",
                serde_json::json!({
                    "peerDeviceId": payload.peer_device_id,
                }),
            );
            // Return success — the data is queued and will be delivered when Android polls
            Ok(SyncPushResult {
                hosts_pushed: hosts_count,
                snippets_pushed: snippets_count,
                vault_pushed: has_vault,
            })
        }
    }
}

fn update_push_last_seen(app: &tauri::AppHandle, peer_device_id: &str) -> Result<(), String> {
    let mut state =
        load_sync_state(app).map_err(|err| standard_error_from_raw("sync", "push", err))?;
    if let Some(p) = state
        .trusted_peers
        .iter_mut()
        .find(|p| p.peer_device_id == peer_device_id)
    {
        p.last_seen_at = now_unix_ms();
    }
    state.last_sync_at = Some(now_unix_ms());
    save_sync_state(app, &state).map_err(|err| standard_error_from_raw("sync", "push", err))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCheckPendingRequest {
    peer_device_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncClaimPendingResult {
    pub claimed: bool,
    pub hosts_restored: usize,
    pub snippets_restored: usize,
    pub vault_restored: bool,
    /// Local vault the claimed push was restored into.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
}

/// Android calls this to check & claim any pending push from a peer.
/// It connects TO the peer (macOS) which Android can do, asks if there's
/// a pending push for us, and if so claims + restores it locally.
#[tauri::command]
pub async fn sync_claim_pending_from_peer(
    app: tauri::AppHandle,
    vault_state: tauri::State<'_, VaultState>,
    payload: SyncCheckPendingRequest,
) -> Result<SyncClaimPendingResult, String> {
    let sync_state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "pending", err))?;
    let local_device_id = sync_state
        .local_device
        .as_ref()
        .map(|d| d.device_id.clone())
        .unwrap_or_default();
    let peer = sync_state
        .trusted_peers
        .iter()
        .find(|p| p.peer_device_id == payload.peer_device_id)
        .ok_or_else(|| {
            standard_error_payload("not_found", "sync", false, "Trusted peer not found", None)
        })?;
    let endpoint = peer
        .peer_endpoint
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            standard_error_payload(
                "validation_error",
                "sync",
                false,
                "Peer endpoint not configured",
                None,
            )
        })?
        .to_string();
    let enc_key = super::transport::parse_sync_secret(&peer.sync_secret);

    // Step 1: check if peer has a pending push for us
    let ep = endpoint.clone();
    let ek = enc_key;
    let did = local_device_id.clone();
    let check_resp = tauri::async_runtime::spawn_blocking(move || {
        super::transport::sync_request_peer_encrypted(
            &ep,
            "check_pending_push",
            serde_json::json!({ "device_id": did }),
            ek.as_ref(),
        )
    })
    .await
    .map_err(|e| standard_error_from_raw("sync", "check pending", format!("{e}")))?
    .map_err(|e| standard_error_from_raw("sync", "check pending request", e))?;

    let has_pending = check_resp
        .get("hasPending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !has_pending {
        return Ok(SyncClaimPendingResult {
            claimed: false,
            hosts_restored: 0,
            snippets_restored: 0,
            vault_restored: false,
            vault_id: None,
        });
    }

    // Step 2: claim the pending push — peer returns the backup payload
    log::info!(
        "[sync] peer {} has pending push for us, claiming...",
        payload.peer_device_id
    );
    let ep = endpoint.clone();
    let ek = enc_key;
    let did = local_device_id.clone();
    let claim_resp = tauri::async_runtime::spawn_blocking(move || {
        super::transport::sync_request_peer_encrypted(
            &ep,
            "claim_pending_push",
            serde_json::json!({ "device_id": did }),
            ek.as_ref(),
        )
    })
    .await
    .map_err(|e| standard_error_from_raw("sync", "claim pending", format!("{e}")))?
    .map_err(|e| standard_error_from_raw("sync", "claim pending request", e))?;

    let claimed = claim_resp
        .get("claimed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !claimed {
        return Ok(SyncClaimPendingResult {
            claimed: false,
            hosts_restored: 0,
            snippets_restored: 0,
            vault_restored: false,
            vault_id: None,
        });
    }

    // Step 3: restore the backup payload locally
    let backup_data = claim_resp.get("backup").cloned().ok_or_else(|| {
        standard_error_from_raw(
            "sync",
            "claim pending",
            "missing backup in response".to_string(),
        )
    })?;
    let inc_hosts = claim_resp
        .get("includeHosts")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let inc_snippets = claim_resp
        .get("includeSnippets")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let inc_vault = claim_resp
        .get("includeVault")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let decrypted_secrets: Option<HashMap<String, String>> = backup_data
        .get("decryptedSecrets")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    // We are the receiver here: map the sender's vault ref onto ours.
    let vault_id = resolve_vault_param(&app, Some(&backup_data), true)
        .map_err(|e| standard_error_from_raw("sync", "resolve pending vault", e))?;
    let backup: crate::data::backup::BackupPayload = serde_json::from_value(backup_data)
        .map_err(|e| standard_error_from_raw("sync", "parse pending backup", e.to_string()))?;
    let result = crate::data::backup::backup_restore_in_memory(
        &app,
        &backup,
        Some(&vault_id),
        inc_hosts,
        inc_snippets,
        false,
        false,
        false,
    )
    .map_err(|e| standard_error_from_raw("sync", "restore pending backup", e))?;

    let mut vault_restored = false;
    if inc_vault {
        if let Some(secrets) = &decrypted_secrets {
            if !secrets.is_empty() {
                match crate::vault::vault_import_decrypted_secrets(
                    &app,
                    &vault_state,
                    secrets,
                    Some(&vault_id),
                ) {
                    Ok(count) => {
                        log::info!("[sync] claim_pending: imported {} vault secrets", count);
                        vault_restored = true;
                    }
                    Err(e) => log::warn!(
                        "[sync] claim_pending: vault import failed ({}), skipping",
                        e
                    ),
                }
            }
        }
    }

    log::info!(
        "[sync] claimed pending push from {} into vault {}: {} hosts, {} snippets, vault={}",
        payload.peer_device_id,
        vault_id,
        result.hosts_restored,
        result.snippets_restored,
        vault_restored
    );

    let _ = app.emit(
        "sync-data-changed",
        serde_json::json!({ "vaultId": vault_id }),
    );

    Ok(SyncClaimPendingResult {
        claimed: true,
        vault_id: Some(vault_id),
        hosts_restored: result.hosts_restored,
        snippets_restored: result.snippets_restored,
        vault_restored,
    })
}

/// Try to determine our LAN IP by looking at the peer's endpoint host.
fn get_local_ip_for_peer(_peer_endpoint: &str) -> String {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" && ip != "127.0.0.1" {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".to_string()
}
