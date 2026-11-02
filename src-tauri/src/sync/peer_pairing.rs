use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Emitter;

use super::pairing_crypto::{
    commitment, confirmation_proof, derive_secrets, generate_keypair, verify_confirmation, KeyPair,
    PairingDevice, PairingSecrets,
};
use super::{
    load_sync_state, save_sync_state, SyncPairingSessionResponse, SyncTrustedPeer,
    CURRENT_PAIRING_VERSION,
};
use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::storage::now_unix_ms;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;
const PAIRING_TTL_MS: i64 = 5 * 60 * 1000;
const POLL_INTERVAL_SECS: u64 = 2;
const MAX_INCOMING_PAIRINGS: usize = 16;
const MAX_DEVICE_FIELD_CHARS: usize = 128;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResolveOutgoingPairPayload {
    pub session_id: String,
    pub accepted: bool,
}

/// Responder side of a pairing. Key material stays in memory and ends with the session.
struct IncomingPairing {
    commitment: [u8; 32],
    initiator_device_id: String,
    initiator_device_name: String,
    keypair: KeyPair,
    secrets: Option<PairingSecrets>,
    accepted: bool,
    expires_at: i64,
}

static INCOMING_PAIRINGS: Mutex<Option<HashMap<String, IncomingPairing>>> = Mutex::new(None);
/// Initiator side: session id → whether this device's user confirmed the code.
static OUTGOING_PAIRINGS: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

fn decode_key(value: Option<&serde_json::Value>, field: &str) -> Result<[u8; 32], String> {
    value
        .and_then(|v| v.as_str())
        .and_then(|s| B64.decode(s).ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| format!("{field} must be 32 base64-encoded bytes"))
}

fn device_field(params: &serde_json::Value, field: &str) -> Result<String, String> {
    let value = params.get(field).and_then(|v| v.as_str()).unwrap_or("");
    if value.is_empty() || value.chars().count() > MAX_DEVICE_FIELD_CHARS {
        return Err(format!("{field} is required and must be short"));
    }
    Ok(value.to_string())
}

fn handle_pair_request(
    app: &tauri::AppHandle,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let initiator_device_id = device_field(&params, "device_id")?;
    let initiator_device_name = device_field(&params, "device_name")?;
    let commitment = decode_key(params.get("commitment"), "commitment")?;
    let state = super::load_sync_state_for_transport(app)?;
    let local = state.local_device.ok_or("Device is not initialized")?;

    let keypair = generate_keypair();
    let public_key = B64.encode(keypair.public);
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = now_unix_ms();
    let mut guard = INCOMING_PAIRINGS.lock().unwrap();
    let sessions = guard.get_or_insert_with(HashMap::new);
    sessions.retain(|_, session| session.expires_at > now);
    if sessions.len() >= MAX_INCOMING_PAIRINGS {
        return Err("Too many pairing requests".to_string());
    }
    sessions.insert(
        session_id.clone(),
        IncomingPairing {
            commitment,
            initiator_device_id,
            initiator_device_name,
            keypair,
            secrets: None,
            accepted: false,
            expires_at: now + PAIRING_TTL_MS,
        },
    );
    Ok(serde_json::json!({
        "session_id": session_id,
        "device_id": local.device_id,
        "device_name": local.device_name,
        "public_key": public_key,
    }))
}

fn handle_pair_reveal(
    app: &tauri::AppHandle,
    params: serde_json::Value,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<serde_json::Value, String> {
    let session_id = device_field(&params, "session_id")?;
    let initiator_public = decode_key(params.get("public_key"), "public_key")?;
    let mut state = super::load_sync_state_for_transport(app)?;
    let local = state
        .local_device
        .clone()
        .ok_or("Device is not initialized")?;
    let now = now_unix_ms();

    let (initiator_device_id, initiator_device_name, code) = {
        let mut guard = INCOMING_PAIRINGS.lock().unwrap();
        let session = guard
            .get_or_insert_with(HashMap::new)
            .get_mut(&session_id)
            .filter(|session| session.expires_at > now)
            .ok_or("Pairing session not found")?;
        if session.secrets.is_some() {
            return Err("Pairing session already revealed".to_string());
        }
        if commitment(&initiator_public) != session.commitment {
            return Err("Pairing commitment mismatch".to_string());
        }
        let secrets = derive_secrets(
            &session.keypair,
            &initiator_public,
            &PairingDevice {
                id: &session.initiator_device_id,
                name: &session.initiator_device_name,
                public: &initiator_public,
            },
            &PairingDevice {
                id: &local.device_id,
                name: &local.device_name,
                public: &session.keypair.public,
            },
        )?;
        let code = secrets.code.clone();
        session.secrets = Some(secrets);
        (
            session.initiator_device_id.clone(),
            session.initiator_device_name.clone(),
            code,
        )
    };

    state
        .pairing_sessions
        .push(super::SyncPairingSessionRecord {
            session_id: session_id.clone(),
            initiator_device_id: initiator_device_id.clone(),
            initiator_device_name: initiator_device_name.clone(),
            verification_code: code.clone(),
            status: "pending".to_string(),
            created_at: now,
            expires_at: now + PAIRING_TTL_MS,
            verified_at: None,
        });
    state.last_sync_at = Some(now);
    super::save_sync_state_for_transport(app, &state)?;

    let peer_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    let _ = app.emit(
        "pair-request-received",
        serde_json::json!({
            "sessionId": session_id,
            "peerDeviceId": initiator_device_id,
            "peerDeviceName": initiator_device_name,
            "peerHost": peer_ip,
            "verificationCode": code,
        }),
    );
    log::info!(
        "[pair] incoming pair request from {} ({}) ip={}",
        initiator_device_name,
        initiator_device_id,
        peer_ip
    );
    Ok(serde_json::json!({ "status": "pending" }))
}

fn handle_pair_check(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let session_id = device_field(&params, "session_id")?;
    let now = now_unix_ms();
    let guard = INCOMING_PAIRINGS.lock().unwrap();
    let session = guard
        .as_ref()
        .and_then(|sessions| sessions.get(&session_id))
        .filter(|session| session.expires_at > now)
        .ok_or("Pairing session not found")?;
    match session.secrets.as_ref().filter(|_| session.accepted) {
        Some(secrets) => Ok(serde_json::json!({
            "status": "confirmed",
            "proof": B64.encode(confirmation_proof(secrets, &session_id)),
        })),
        None => Ok(serde_json::json!({ "status": "pending" })),
    }
}

/// The only requests a device that is not yet trusted can make.
pub(crate) fn handle_pairing_request(
    app: &tauri::AppHandle,
    method: &str,
    params: Option<serde_json::Value>,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<serde_json::Value, String> {
    let params = params.ok_or("params required")?;
    match method {
        "pair_request" => handle_pair_request(app, params),
        "pair_reveal" => handle_pair_reveal(app, params, remote_addr),
        "pair_check" => handle_pair_check(params),
        _ => Err(format!("Unknown method: {method}")),
    }
}

fn trust_peer(
    state: &mut super::SyncStateFile,
    peer: SyncTrustedPeer,
    session_filter: impl Fn(&str) -> bool,
) {
    let now = peer.verified_at;
    if let Some(existing) = state
        .trusted_peers
        .iter_mut()
        .find(|p| p.peer_device_id == peer.peer_device_id)
    {
        *existing = peer;
    } else {
        state.trusted_peers.push(peer);
    }
    for s in state.pairing_sessions.iter_mut() {
        if s.status == "pending" && session_filter(&s.session_id) {
            s.status = "verified".to_string();
            s.verified_at = Some(now);
        }
    }
    state.last_sync_at = Some(now);
}

struct OutgoingContext {
    app: tauri::AppHandle,
    endpoint: String,
    local_session_id: String,
    remote_session_id: String,
    peer_device_id: String,
    peer_device_name: String,
    secrets: PairingSecrets,
}

fn outgoing_confirmation(session_id: &str) -> Option<bool> {
    let guard = OUTGOING_PAIRINGS.lock().unwrap();
    guard.as_ref().and_then(|m| m.get(session_id).copied())
}

/// Trust the peer only after both users approved: this device's user compared the
/// code, and the peer proved that its user accepted. An attacker who answers the
/// pairing in the peer's place can produce the proof but not get the first.
fn wait_for_outgoing_confirmation(context: OutgoingContext) {
    let attempts = PAIRING_TTL_MS as u64 / 1000 / POLL_INTERVAL_SECS;
    let mut peer_accepted = false;
    for attempt in 0..attempts {
        std::thread::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS));
        let Some(user_confirmed) = outgoing_confirmation(&context.local_session_id) else {
            return;
        };
        if !peer_accepted {
            let result = super::transport::sync_request_pairing(
                &context.endpoint,
                "pair_check",
                serde_json::json!({ "session_id": context.remote_session_id }),
            );
            match result {
                Ok(resp) if resp.get("status").and_then(|v| v.as_str()) == Some("confirmed") => {
                    let proof = resp
                        .get("proof")
                        .and_then(|v| v.as_str())
                        .and_then(|s| B64.decode(s).ok())
                        .unwrap_or_default();
                    if !verify_confirmation(&context.secrets, &context.remote_session_id, &proof) {
                        log::warn!("[pair] invalid confirmation from {}", context.endpoint);
                        break;
                    }
                    peer_accepted = true;
                }
                Ok(_) => {}
                Err(e) => log::debug!("[pair] poll attempt {} failed: {}", attempt + 1, e),
            }
        }
        if peer_accepted && user_confirmed {
            complete_outgoing(&context);
            break;
        }
    }
    if let Some(sessions) = OUTGOING_PAIRINGS.lock().unwrap().as_mut() {
        sessions.remove(&context.local_session_id);
    }
}

fn complete_outgoing(context: &OutgoingContext) {
    let Ok(mut state) = super::load_sync_state_for_transport(&context.app) else {
        return;
    };
    let now = now_unix_ms();
    trust_peer(
        &mut state,
        SyncTrustedPeer {
            peer_device_id: context.peer_device_id.clone(),
            peer_device_name: Some(context.peer_device_name.clone()),
            verified_at: now,
            last_seen_at: now,
            source: "network-pair".to_string(),
            peer_endpoint: Some(context.endpoint.clone()),
            sync_secret: Some(B64.encode(context.secrets.sync_key)),
            pairing_version: CURRENT_PAIRING_VERSION,
        },
        |id| id == context.local_session_id,
    );
    if let Err(e) = super::save_sync_state_for_transport(&context.app, &state) {
        log::warn!("[pair] save trusted peer failed: {e}");
        return;
    }
    let _ = context.app.emit(
        "pair-confirmed",
        serde_json::json!({
            "peerDeviceId": context.peer_device_id,
            "peerDeviceName": context.peer_device_name,
        }),
    );
    log::info!("[pair] peer {} trusted", context.peer_device_id);
}

/// Start pairing with a remote device's sync server. Called by the initiator
/// (Device A) when clicking on Device B. Both devices then show the same code,
/// and each user approves it on their own device.
#[tauri::command]
pub async fn sync_send_pair_request(
    app: tauri::AppHandle,
    payload: SyncSendPairRequestPayload,
) -> Result<SyncPairingSessionResponse, String> {
    let state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "send pair request", err))?;
    let device = state.local_device.clone().ok_or_else(|| {
        standard_error_payload(
            "not_initialized",
            "sync",
            false,
            "Local sync device is not initialized",
            None,
        )
    })?;

    let endpoint = format!("{}:{}", payload.peer_host, payload.peer_port);
    let now = now_unix_ms();

    // Run the exchange in a background thread so the UI doesn't freeze
    let endpoint_clone = endpoint.clone();
    let device_id = device.device_id.clone();
    let device_name = device.device_name.clone();
    let (remote_session_id, peer_device_id, peer_device_name, secrets) =
        tauri::async_runtime::spawn_blocking(move || {
            exchange_keys(&endpoint_clone, &device_id, &device_name)
        })
        .await
        .map_err(|e| standard_error_from_raw("sync", "send pair request", format!("{e}")))?
        .map_err(|e| standard_error_from_raw("sync", "send pair request", e))?;

    // Also create a local session record so the UI can track it
    let local_session_id = uuid::Uuid::new_v4().to_string();
    let session = super::SyncPairingSessionRecord {
        session_id: local_session_id.clone(),
        initiator_device_id: device.device_id.clone(),
        initiator_device_name: payload
            .peer_name
            .clone()
            .unwrap_or_else(|| peer_device_name.clone()),
        verification_code: secrets.code.clone(),
        status: "pending".to_string(),
        created_at: now,
        expires_at: now + PAIRING_TTL_MS,
        verified_at: None,
    };
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "send pair request", err))?;
    state.pairing_sessions.push(session.clone());
    state.last_sync_at = Some(now);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "send pair request", err))?;

    log::info!(
        "[pair] exchanged pairing keys with {} — remote session={}",
        endpoint,
        remote_session_id
    );

    OUTGOING_PAIRINGS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(local_session_id.clone(), false);

    // Polls the receiver, because it may not be able to connect back to us
    // (common on Android where inbound TCP is often blocked).
    let verification_code = secrets.code.clone();
    let context = OutgoingContext {
        app: app.clone(),
        endpoint,
        local_session_id: local_session_id.clone(),
        remote_session_id,
        peer_device_id,
        peer_device_name,
        secrets,
    };
    tauri::async_runtime::spawn_blocking(move || wait_for_outgoing_confirmation(context));

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

fn exchange_keys(
    endpoint: &str,
    device_id: &str,
    device_name: &str,
) -> Result<(String, String, String, PairingSecrets), String> {
    let keypair = generate_keypair();
    let resp = super::transport::sync_request_pairing(
        endpoint,
        "pair_request",
        serde_json::json!({
            "device_id": device_id,
            "device_name": device_name,
            "commitment": B64.encode(commitment(&keypair.public)),
        }),
    )?;
    let session_id = device_field(&resp, "session_id")?;
    let peer_device_id = device_field(&resp, "device_id")?;
    let peer_device_name = device_field(&resp, "device_name")?;
    let peer_public = decode_key(resp.get("public_key"), "public_key")?;
    let secrets = derive_secrets(
        &keypair,
        &peer_public,
        &PairingDevice {
            id: device_id,
            name: device_name,
            public: &keypair.public,
        },
        &PairingDevice {
            id: &peer_device_id,
            name: &peer_device_name,
            public: &peer_public,
        },
    )?;
    super::transport::sync_request_pairing(
        endpoint,
        "pair_reveal",
        serde_json::json!({
            "session_id": session_id,
            "public_key": B64.encode(keypair.public),
        }),
    )?;
    Ok((session_id, peer_device_id, peer_device_name, secrets))
}

/// Records whether this device's user saw the same code as the other device.
#[tauri::command]
pub fn sync_resolve_outgoing_pair(payload: SyncResolveOutgoingPairPayload) -> Result<(), String> {
    let mut guard = OUTGOING_PAIRINGS.lock().unwrap();
    let sessions = guard.get_or_insert_with(HashMap::new);
    if payload.accepted {
        let Some(confirmed) = sessions.get_mut(&payload.session_id) else {
            return Err(standard_error_payload(
                "not_found",
                "sync",
                false,
                "Pairing session not found",
                None,
            ));
        };
        *confirmed = true;
    } else {
        sessions.remove(&payload.session_id);
    }
    Ok(())
}

/// Accept an incoming pair request. Called by the receiver (Device B) after the
/// user compares the code. The initiator learns about it by polling `pair_check`.
#[tauri::command]
pub async fn sync_accept_pair(
    app: tauri::AppHandle,
    payload: SyncAcceptPairPayload,
) -> Result<SyncTrustedPeer, String> {
    let now = now_unix_ms();
    let not_found = || {
        standard_error_payload(
            "not_found",
            "sync",
            false,
            "Pairing session not found",
            None,
        )
    };
    let (peer_device_id, peer_device_name, sync_key) = {
        let guard = INCOMING_PAIRINGS.lock().unwrap();
        let session = guard
            .as_ref()
            .and_then(|sessions| sessions.get(&payload.session_id))
            .filter(|session| session.expires_at > now)
            .ok_or_else(not_found)?;
        let secrets = session.secrets.as_ref().ok_or_else(not_found)?;
        (
            session.initiator_device_id.clone(),
            session.initiator_device_name.clone(),
            secrets.sync_key,
        )
    };

    let peer = SyncTrustedPeer {
        peer_device_id,
        peer_device_name: Some(peer_device_name),
        verified_at: now,
        last_seen_at: now,
        source: "network-pair".to_string(),
        peer_endpoint: Some(format!("{}:{}", payload.peer_host, payload.peer_port)),
        sync_secret: Some(B64.encode(sync_key)),
        pairing_version: CURRENT_PAIRING_VERSION,
    };
    let mut state =
        load_sync_state(&app).map_err(|err| standard_error_from_raw("sync", "accept pair", err))?;
    trust_peer(&mut state, peer.clone(), |id| id == payload.session_id);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "accept pair", err))?;

    if let Some(session) = INCOMING_PAIRINGS
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|sessions| sessions.get_mut(&payload.session_id))
    {
        session.accepted = true;
    }

    Ok(SyncTrustedPeer {
        sync_secret: None,
        ..peer
    })
}

#[tauri::command]
pub fn sync_list_pairing_sessions(
    app: tauri::AppHandle,
) -> Result<Vec<SyncPairingSessionResponse>, String> {
    let mut state = load_sync_state(&app)
        .map_err(|err| standard_error_from_raw("sync", "list pairing sessions", err))?;
    let now = now_unix_ms();
    state
        .pairing_sessions
        .retain(|item| item.status != "pending" || item.expires_at > now);
    save_sync_state(&app, &state)
        .map_err(|err| standard_error_from_raw("sync", "list pairing sessions", err))?;
    let mut sessions: Vec<_> = state
        .pairing_sessions
        .into_iter()
        .map(|item| SyncPairingSessionResponse {
            session_id: item.session_id,
            initiator_device_id: item.initiator_device_id,
            initiator_device_name: item.initiator_device_name,
            verification_code: item.verification_code,
            status: item.status,
            created_at: item.created_at,
            expires_at: item.expires_at,
        })
        .collect();
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(sessions)
}
