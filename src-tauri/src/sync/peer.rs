use serde::{Deserialize, Serialize};

use super::{
    load_sync_state, save_sync_state,
    SyncPairingSessionResponse, SyncTrustedPeer,
};
use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::storage::now_unix_ms;

use super::transport::parse_sync_secret;

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
            "validation_error", "sync", false, "peerDeviceId is required", None,
        ));
    }
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "update peer endpoint", err))?;
    let peer_id = payload.peer_device_id.trim();
    let endpoint = payload.peer_endpoint.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let peer = state.trusted_peers.iter_mut().find(|p| p.peer_device_id == peer_id).ok_or_else(|| {
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
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "remove peer", err))?;
    let before = state.trusted_peers.len();
    state.trusted_peers.retain(|p| p.peer_device_id != payload.peer_device_id);
    if state.trusted_peers.len() == before {
        return Err(standard_error_payload("not_found", "sync", false, "Trusted peer not found", None));
    }
    state.cursors.retain(|c| c.peer_device_id != payload.peer_device_id);
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
    super::transport::mdns_diagnose()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullRequest {
    peer_device_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResult {
    hosts_restored: usize,
    snippets_restored: usize,
    vault_restored: bool,
}

/// Pull = request full backup from peer → restore locally.
#[tauri::command]
pub async fn sync_pull_from_peer(
    app: tauri::AppHandle,
    payload: SyncPullRequest,
) -> Result<SyncPullResult, String> {
    let state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "pull", err))?;
    let peer = state.trusted_peers.iter().find(|p| p.peer_device_id == payload.peer_device_id).ok_or_else(|| {
        standard_error_payload("not_found", "sync", false, "Trusted peer not found", None)
    })?;
    let endpoint = peer.peer_endpoint.as_deref().filter(|s| !s.trim().is_empty()).ok_or_else(|| {
        standard_error_payload("validation_error", "sync", false, "Peer endpoint not configured", None)
    })?.to_string();
    let enc_key = parse_sync_secret(&peer.sync_secret);

    // Fetch full backup from peer in background thread
    let ep = endpoint.clone();
    let data = tauri::async_runtime::spawn_blocking(move || {
        super::transport::sync_request_peer_encrypted(
            &ep,
            "get_full_backup",
            serde_json::json!({}),
            enc_key.as_ref(),
        )
    }).await.map_err(|e| standard_error_from_raw("sync", "pull", format!("{e}")))?
      .map_err(|e| standard_error_from_raw("sync", "pull request", e))?;

    let backup: crate::data::backup::BackupPayload = serde_json::from_value(data)
        .map_err(|e| standard_error_from_raw("sync", "parse pull backup", e.to_string()))?;

    // Restore the backup locally
    let result = crate::data::backup::backup_restore_in_memory(&app, &backup, None, true, true, true, false, false)
        .map_err(|e| standard_error_from_raw("sync", "restore pull backup", e))?;

    log::info!("[sync] pull complete: {} hosts, {} snippets, vault={}",
        result.hosts_restored, result.snippets_restored, result.vault_restored);

    // Update last_seen_at
    let mut state = load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "pull", err))?;
    if let Some(p) = state.trusted_peers.iter_mut().find(|p| p.peer_device_id == payload.peer_device_id) {
        p.last_seen_at = now_unix_ms();
    }
    state.last_sync_at = Some(now_unix_ms());
    save_sync_state(&app, &state).map_err(|err| standard_error_from_raw("sync", "pull", err))?;

    Ok(SyncPullResult {
        hosts_restored: result.hosts_restored,
        snippets_restored: result.snippets_restored,
        vault_restored: result.vault_restored,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushRequest {
    peer_device_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResult {
    hosts_pushed: usize,
    snippets_pushed: usize,
    vault_pushed: bool,
}

/// Push = create in-memory backup → send to peer via push_full_backup.
#[tauri::command]
pub async fn sync_push_to_peer(
    app: tauri::AppHandle,
    payload: SyncPushRequest,
) -> Result<SyncPushResult, String> {
    let state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "push", err))?;
    let peer = state.trusted_peers.iter().find(|p| p.peer_device_id == payload.peer_device_id).ok_or_else(|| {
        standard_error_payload("not_found", "sync", false, "Trusted peer not found", None)
    })?;
    let endpoint = peer.peer_endpoint.as_deref().filter(|s| !s.trim().is_empty()).ok_or_else(|| {
        standard_error_payload("validation_error", "sync", false, "Peer endpoint not configured", None)
    })?.to_string();
    let enc_key = parse_sync_secret(&peer.sync_secret);

    // Create in-memory backup
    let backup = crate::data::backup::backup_create_in_memory(&app, None, true, true, true, false, false)
        .map_err(|e| standard_error_from_raw("sync", "create push backup", e))?;
    let hosts_count = backup.hosts.as_ref().map(|h: &Vec<_>| h.len()).unwrap_or(0);
    let snippets_count = backup.snippets.as_ref().map(|s: &Vec<_>| s.len()).unwrap_or(0);
    let has_vault = backup.vault_raw.is_some();

    let backup_json = serde_json::to_value(&backup)
        .map_err(|e| standard_error_from_raw("sync", "serialize push backup", e.to_string()))?;

    // Send to peer in background thread
    let ep = endpoint.clone();
    let _resp = tauri::async_runtime::spawn_blocking(move || {
        super::transport::sync_request_peer_encrypted(
            &ep,
            "push_full_backup",
            backup_json,
            enc_key.as_ref(),
        )
    }).await.map_err(|e| standard_error_from_raw("sync", "push", format!("{e}")))?
      .map_err(|e| standard_error_from_raw("sync", "push request", e))?;

    log::info!("[sync] push complete: {} hosts, {} snippets, vault={}",
        hosts_count, snippets_count, has_vault);

    // Update last_seen_at
    let mut state = load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "push", err))?;
    if let Some(p) = state.trusted_peers.iter_mut().find(|p| p.peer_device_id == payload.peer_device_id) {
        p.last_seen_at = now_unix_ms();
    }
    state.last_sync_at = Some(now_unix_ms());
    save_sync_state(&app, &state).map_err(|err| standard_error_from_raw("sync", "push", err))?;

    Ok(SyncPushResult {
        hosts_pushed: hosts_count,
        snippets_pushed: snippets_count,
        vault_pushed: has_vault,
    })
}

/// Send a pair request to a remote device's sync server.
/// This is called by the initiator (Device A) when clicking on Device B.
/// The remote device will receive a "pair-request-received" event.
/// Returns the session info including the verification code.
#[tauri::command]
pub async fn sync_send_pair_request(
    app: tauri::AppHandle,
    payload: SyncSendPairRequestPayload,
) -> Result<SyncPairingSessionResponse, String> {
    let state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "send pair request", err))?;
    let device = state.local_device.clone().ok_or_else(|| {
        standard_error_payload("not_initialized", "sync", false, "Local sync device is not initialized", None)
    })?;

    let endpoint = format!("{}:{}", payload.peer_host, payload.peer_port);
    let now = now_unix_ms();
    let verification_code = format!("{:06}", (now as u64 ^ rand::random::<u64>()) % 1_000_000);

    // Send pair_request in a background thread so the UI doesn't freeze
    let endpoint_clone = endpoint.clone();
    let device_id = device.device_id.clone();
    let device_name = device.device_name.clone();
    let code_clone = verification_code.clone();
    let resp = tauri::async_runtime::spawn_blocking(move || {
        super::transport::sync_request_peer_encrypted(
            &endpoint_clone,
            "pair_request",
            serde_json::json!({
                "device_id": device_id,
                "device_name": device_name,
                "verification_code": code_clone,
            }),
            None,
        )
    }).await.map_err(|e| standard_error_from_raw("sync", "send pair request", format!("{e}")))?
      .map_err(|e| standard_error_from_raw("sync", "send pair request", e))?;

    let remote_session_id = resp.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Also create a local session record so the UI can track it
    let local_session_id = uuid::Uuid::new_v4().to_string();
    let session = super::SyncPairingSessionRecord {
        session_id: local_session_id.clone(),
        initiator_device_id: device.device_id.clone(),
        initiator_device_name: payload.peer_name.clone().unwrap_or_else(|| "unknown".to_string()),
        verification_code: verification_code.clone(),
        status: "pending".to_string(),
        created_at: now,
        expires_at: now + 5 * 60 * 1000,
        verified_at: None,
    };
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "send pair request", err))?;
    state.pairing_sessions.push(session.clone());
    state.last_sync_at = Some(now);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "send pair request", err))?;

    log::info!("[pair] sent pair_request to {} — remote session={}, code={}", endpoint, remote_session_id, verification_code);

    Ok(SyncPairingSessionResponse {
        session_id: local_session_id,
        initiator_device_id: device.device_id,
        initiator_device_name: session.initiator_device_name,
        verification_code,
        status: "pending".to_string(),
        created_at: now,
        expires_at: session.expires_at,
    })
}

/// Accept an incoming pair request. Called by the receiver (Device B)
/// after reviewing the PIN. Sends pair_confirm back to the initiator
/// to exchange sync secrets and establish trust.
#[tauri::command]
pub async fn sync_accept_pair(
    app: tauri::AppHandle,
    payload: SyncAcceptPairPayload,
) -> Result<SyncTrustedPeer, String> {
    let state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "accept pair", err))?;
    let device = state.local_device.clone().ok_or_else(|| {
        standard_error_payload("not_initialized", "sync", false, "Local sync device is not initialized", None)
    })?;

    // Find the session
    let session = state.pairing_sessions.iter().find(|s| s.session_id == payload.session_id).ok_or_else(|| {
        standard_error_payload("not_found", "sync", false, "Pairing session not found", None)
    })?;
    if session.status != "pending" {
        return Err(standard_error_payload("invalid_state", "sync", false, "Session is not pending", None));
    }

    // Generate a sync secret
    let sync_secret = {
        use base64::Engine;
        let mut key = [0u8; 32];
        use rand::RngCore;
        rand::rng().fill_bytes(&mut key);
        base64::engine::general_purpose::STANDARD.encode(key)
    };

    // The initiator's device info comes from the session
    let peer_device_id = session.initiator_device_id.clone();
    let peer_device_name = session.initiator_device_name.clone();
    let peer_endpoint = format!("{}:{}", payload.peer_host, payload.peer_port);

    let now = now_unix_ms();
    let peer = SyncTrustedPeer {
        peer_device_id: peer_device_id.clone(),
        peer_device_name: Some(peer_device_name.clone()),
        verified_at: now,
        last_seen_at: now,
        source: "network-pair".to_string(),
        peer_endpoint: Some(peer_endpoint.clone()),
        sync_secret: Some(sync_secret.clone()),
    };

    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "accept pair", err))?;
    // Update session status
    if let Some(s) = state.pairing_sessions.iter_mut().find(|s| s.session_id == payload.session_id) {
        s.status = "verified".to_string();
        s.verified_at = Some(now);
    }
    // Add trusted peer
    if let Some(existing) = state.trusted_peers.iter_mut().find(|p| p.peer_device_id == peer_device_id) {
        *existing = peer.clone();
    } else {
        state.trusted_peers.push(peer.clone());
    }
    state.last_sync_at = Some(now);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "accept pair", err))?;

    // Try to send pair_confirm to the initiator in a background thread
    let session_id = payload.session_id.clone();
    let device_id = device.device_id.clone();
    let device_name = device.device_name.clone();
    let secret = sync_secret.clone();
    let ep = peer_endpoint.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let result = super::transport::sync_request_peer_encrypted(
            &ep,
            "pair_confirm",
            serde_json::json!({
                "session_id": session_id,
                "device_id": device_id,
                "device_name": device_name,
                "sync_secret": secret,
            }),
            None,
        );
        match result {
            Ok(_) => log::info!("[pair] pair_confirm sent to {} — trust established", ep),
            Err(e) => log::warn!("[pair] pair_confirm to {} failed: {} — trust only local", ep, e),
        }
    }).await;

    Ok(peer)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSendPairRequestPayload {
    pub peer_host: String,
    pub peer_port: u16,
    pub peer_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAcceptPairPayload {
    pub session_id: String,
    pub peer_host: String,
    pub peer_port: u16,
}

#[tauri::command]
pub fn sync_list_pairing_sessions(
    app: tauri::AppHandle,
) -> Result<Vec<SyncPairingSessionResponse>, String> {
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "list pairing sessions", err))?;
    let now = now_unix_ms();
    state.pairing_sessions.retain(|item| item.status != "pending" || item.expires_at > now);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "list pairing sessions", err))?;
    let mut sessions: Vec<_> = state.pairing_sessions.into_iter().map(|item| SyncPairingSessionResponse {
        session_id: item.session_id,
        initiator_device_id: item.initiator_device_id,
        initiator_device_name: item.initiator_device_name,
        verification_code: item.verification_code,
        status: item.status,
        created_at: item.created_at,
        expires_at: item.expires_at,
    }).collect();
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(sessions)
}
