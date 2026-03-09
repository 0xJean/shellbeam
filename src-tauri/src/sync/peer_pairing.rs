use serde::Deserialize;

use super::{
    load_sync_state, save_sync_state,
    SyncPairingSessionResponse, SyncTrustedPeer,
};
use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::storage::now_unix_ms;

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

    // Start background polling: periodically ask the receiver if they accepted.
    // This handles the case where the receiver can't connect back to us
    // (common on Android where inbound TCP is often blocked).
    let poll_app = app.clone();
    let poll_endpoint = endpoint.clone();
    let poll_device_id = device.device_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for i in 0..60 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let result = super::transport::sync_request_peer_encrypted(
                &poll_endpoint, "pair_check",
                serde_json::json!({ "device_id": poll_device_id }),
                None,
            );
            match result {
                Ok(resp) => {
                    let status = resp.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    if status == "confirmed" {
                        let peer_device_id = resp.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let peer_device_name = resp.get("device_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                        let peer_sync_secret = resp.get("sync_secret").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if !peer_device_id.is_empty() && !peer_sync_secret.is_empty() {
                            if let Ok(mut state) = super::load_sync_state_for_transport(&poll_app) {
                                let now = crate::storage::now_unix_ms();
                                let peer = super::SyncTrustedPeer {
                                    peer_device_id: peer_device_id.clone(),
                                    peer_device_name: peer_device_name.clone(),
                                    verified_at: now,
                                    last_seen_at: now,
                                    source: "network-pair".to_string(),
                                    peer_endpoint: Some(poll_endpoint.clone()),
                                    sync_secret: Some(peer_sync_secret),
                                };
                                if let Some(existing) = state.trusted_peers.iter_mut().find(|p| p.peer_device_id == peer_device_id) {
                                    *existing = peer;
                                } else {
                                    state.trusted_peers.push(peer);
                                }
                                for s in state.pairing_sessions.iter_mut() {
                                    if s.status == "pending" && s.expires_at > now {
                                        s.status = "verified".to_string();
                                        s.verified_at = Some(now);
                                    }
                                }
                                state.last_sync_at = Some(now);
                                let _ = super::save_sync_state_for_transport(&poll_app, &state);
                            }
                            use tauri::Emitter;
                            let _ = poll_app.emit("pair-confirmed", serde_json::json!({
                                "peerDeviceId": peer_device_id,
                                "peerDeviceName": peer_device_name,
                            }));
                            log::info!("[pair] poll confirmed: peer {} accepted (attempt {})", peer_device_id, i + 1);
                        }
                        break;
                    }
                }
                Err(e) => {
                    log::debug!("[pair] poll attempt {} failed: {}", i + 1, e);
                }
            }
        }
    });

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
