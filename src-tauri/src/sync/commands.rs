use uuid::Uuid;

use super::{
    load_sync_state, save_sync_state, SyncBootstrapResponse, SyncChangeRecord,
    SyncConfirmPairingRequest, SyncCursorRecord, SyncDeviceIdentity, SyncInitDeviceRequest,
    SyncPairingSessionRecord, SyncPairingSessionResponse, SyncQueryChangesRequest,
    SyncRegisterChangeRequest, SyncStartPairingRequest, SyncTrustedPeer,
    SyncUpsertCursorRequest,
};
use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::storage::now_unix_ms;

fn system_hostname() -> String {
    super::transport::native_device_name_public()
}

#[tauri::command]
pub fn get_system_hostname() -> String {
    system_hostname()
}

#[tauri::command]
pub fn sync_get_bootstrap(app: tauri::AppHandle) -> Result<SyncBootstrapResponse, String> {
    let mut state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "get bootstrap", err))?;
    let now = now_unix_ms();
    state
        .pairing_sessions
        .retain(|item| item.status != "pending" || item.expires_at > now);
    let latest_version = state.changes.iter().map(|item| item.version).max().unwrap_or(0);
    let trusted_peer_count = state.trusted_peers.len();
    let active_pairing_count = state
        .pairing_sessions
        .iter()
        .filter(|item| item.status == "pending" && item.expires_at > now)
        .count();
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "get bootstrap", err))?;
    Ok(SyncBootstrapResponse {
        schema_version: state.schema_version.max(1),
        local_device: state.local_device,
        latest_version,
        change_count: state.changes.len(),
        cursor_count: state.cursors.len(),
        trusted_peer_count,
        active_pairing_count,
    })
}

#[tauri::command]
pub fn sync_init_local_device(
    app: tauri::AppHandle,
    payload: SyncInitDeviceRequest,
) -> Result<SyncDeviceIdentity, String> {
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "init local device", err))?;
    let now = now_unix_ms();
    let next = match state.local_device.clone() {
        Some(mut existing) => {
            if let Some(name) = payload.device_name {
                if !name.trim().is_empty() {
                    existing.device_name = name.trim().to_string();
                }
            }
            existing.last_seen_at = now;
            existing
        }
        None => {
            let id = Uuid::new_v4().to_string();
            SyncDeviceIdentity {
                device_id: id.clone(),
                device_name: payload
                    .device_name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        let h = system_hostname();
                        if h.is_empty() { format!("ShellBeam-{}", id.chars().take(8).collect::<String>()) } else { h }
                    }),
                public_key: format!("mock-pub-{id}"),
                created_at: now,
                last_seen_at: now,
            }
        }
    };
    state.local_device = Some(next.clone());
    state.schema_version = 1;
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "init local device", err))?;
    Ok(next)
}

#[tauri::command]
pub fn sync_register_change(
    app: tauri::AppHandle,
    payload: SyncRegisterChangeRequest,
) -> Result<SyncChangeRecord, String> {
    if payload.object_type.trim().is_empty() || payload.object_id.trim().is_empty() {
        return Err(standard_error_payload(
            "validation_error", "sync", false,
            "objectType and objectId are required", None,
        ));
    }
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "register change", err))?;
    let now = now_unix_ms();
    let version = state.changes.iter().map(|item| item.version).max().unwrap_or(0) + 1;
    let updated_by = payload
        .updated_by
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| state.local_device.as_ref().map(|device| device.device_id.clone()))
        .unwrap_or_else(|| "unknown-device".to_string());
    let record = SyncChangeRecord {
        version,
        change_id: Uuid::new_v4().to_string(),
        object_type: payload.object_type.trim().to_string(),
        object_id: payload.object_id.trim().to_string(),
        updated_at: now,
        updated_by,
        checksum: payload.checksum.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        deleted: payload.deleted.unwrap_or(false),
        summary: payload.summary.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
    };
    state.changes.push(record.clone());
    state.last_sync_at = Some(now);
    state.schema_version = 1;
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "register change", err))?;
    Ok(record)
}

#[tauri::command]
pub fn sync_query_changes(
    app: tauri::AppHandle,
    payload: Option<SyncQueryChangesRequest>,
) -> Result<Vec<SyncChangeRecord>, String> {
    let state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "query changes", err))?;
    let since_version = payload.as_ref().and_then(|item| item.since_version).unwrap_or(0);
    let limit = payload.as_ref().and_then(|item| item.limit).unwrap_or(200).min(2000);
    let mut items: Vec<_> = state.changes.into_iter().filter(|item| item.version > since_version).collect();
    items.sort_by_key(|item| item.version);
    if items.len() > limit {
        items.truncate(limit);
    }
    Ok(items)
}

#[tauri::command]
pub fn sync_upsert_cursor(
    app: tauri::AppHandle,
    payload: SyncUpsertCursorRequest,
) -> Result<SyncCursorRecord, String> {
    if payload.peer_device_id.trim().is_empty() {
        return Err(standard_error_payload(
            "validation_error", "sync", false, "peerDeviceId is required", None,
        ));
    }
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "upsert cursor", err))?;
    let now = now_unix_ms();
    let peer = payload.peer_device_id.trim();
    let mut cursor = state.cursors.iter().find(|item| item.peer_device_id == peer).cloned().unwrap_or(SyncCursorRecord {
        peer_device_id: peer.to_string(),
        last_pulled_version: 0,
        last_pushed_version: 0,
        updated_at: now,
    });
    if let Some(value) = payload.last_pulled_version { cursor.last_pulled_version = value; }
    if let Some(value) = payload.last_pushed_version { cursor.last_pushed_version = value; }
    cursor.updated_at = now;
    if let Some(existing) = state.cursors.iter_mut().find(|item| item.peer_device_id == cursor.peer_device_id) {
        *existing = cursor.clone();
    } else {
        state.cursors.push(cursor.clone());
    }
    state.last_sync_at = Some(now);
    state.schema_version = 1;
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "upsert cursor", err))?;
    Ok(cursor)
}

#[tauri::command]
pub fn sync_list_cursors(app: tauri::AppHandle) -> Result<Vec<SyncCursorRecord>, String> {
    let mut cursors = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "list cursors", err))?
        .cursors;
    cursors.sort_by(|a, b| a.peer_device_id.cmp(&b.peer_device_id));
    Ok(cursors)
}

#[tauri::command]
pub fn sync_start_pairing(
    app: tauri::AppHandle,
    payload: Option<SyncStartPairingRequest>,
) -> Result<SyncPairingSessionResponse, String> {
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "start pairing", err))?;
    let device = state.local_device.clone().ok_or_else(|| {
        standard_error_payload("not_initialized", "sync", false, "Local sync device is not initialized", None)
    })?;
    let now = now_unix_ms();
    let verification_code = format!("{:06}", (now as u64 ^ rand::random::<u64>()) % 1_000_000);
    let hint = payload
        .and_then(|item| item.peer_device_name_hint)
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty());
    let session = SyncPairingSessionRecord {
        session_id: Uuid::new_v4().to_string(),
        initiator_device_id: device.device_id,
        initiator_device_name: hint.unwrap_or(device.device_name),
        verification_code,
        status: "pending".to_string(),
        created_at: now,
        expires_at: now + 5 * 60 * 1000,
        verified_at: None,
    };
    state.pairing_sessions.push(session.clone());
    state.last_sync_at = Some(now);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "start pairing", err))?;
    Ok(SyncPairingSessionResponse {
        session_id: session.session_id,
        initiator_device_id: session.initiator_device_id,
        initiator_device_name: session.initiator_device_name,
        verification_code: session.verification_code,
        status: session.status,
        created_at: session.created_at,
        expires_at: session.expires_at,
    })
}

#[tauri::command]
pub fn sync_confirm_pairing(
    app: tauri::AppHandle,
    payload: SyncConfirmPairingRequest,
) -> Result<SyncTrustedPeer, String> {
    if payload.session_id.trim().is_empty() || payload.verification_code.trim().is_empty() {
        return Err(standard_error_payload(
            "validation_error", "sync", false, "sessionId and verificationCode are required", None,
        ));
    }
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "confirm pairing", err))?;
    let now = now_unix_ms();
    let session = state.pairing_sessions.iter_mut().find(|item| item.session_id == payload.session_id).ok_or_else(|| {
        standard_error_payload("not_found", "sync", false, "Pairing session not found", None)
    })?;
    if session.expires_at <= now {
        session.status = "expired".to_string();
        return Err(standard_error_payload("expired", "sync", false, "Pairing session expired", None));
    }
    if session.verification_code != payload.verification_code.trim() {
        return Err(standard_error_payload("verification_failed", "sync", false, "Verification code mismatch", None));
    }
    session.status = "verified".to_string();
    session.verified_at = Some(now);
    let peer_device_id = payload.peer_device_id
        .map(|item| item.trim().to_string()).filter(|item| !item.is_empty())
        .unwrap_or_else(|| format!("peer-{}", session.session_id));
    let peer_device_name = payload.peer_device_name
        .map(|item| item.trim().to_string()).filter(|item| !item.is_empty());
    let sync_secret = {
        use base64::Engine;
        let mut key = [0u8; 32];
        use rand::RngCore;
        rand::rng().fill_bytes(&mut key);
        base64::engine::general_purpose::STANDARD.encode(key)
    };
    let peer = SyncTrustedPeer {
        peer_device_id: peer_device_id.clone(),
        peer_device_name,
        verified_at: now,
        last_seen_at: now,
        source: "manual-code".to_string(),
        peer_endpoint: None,
        sync_secret: Some(sync_secret),
    };
    if let Some(existing) = state.trusted_peers.iter_mut().find(|item| item.peer_device_id == peer_device_id) {
        *existing = peer.clone();
    } else {
        state.trusted_peers.push(peer.clone());
    }
    state.last_sync_at = Some(now);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "confirm pairing", err))?;
    Ok(peer)
}

#[tauri::command]
pub fn sync_list_trusted_peers(app: tauri::AppHandle) -> Result<Vec<SyncTrustedPeer>, String> {
    let mut peers = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "list trusted peers", err))?
        .trusted_peers;
    peers.sort_by(|a, b| a.peer_device_id.cmp(&b.peer_device_id));
    Ok(peers)
}
