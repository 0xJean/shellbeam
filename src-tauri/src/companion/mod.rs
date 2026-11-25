//! Desktop Companion & Remote Bridge module.
//! Enables paired mobile/secondary devices to connect directly to a ShellBeam desktop over
//! LAN or Tailscale using the existing X25519 + AES-256-GCM pairing key.

pub mod ai_hub;
pub mod client;
pub mod protocol;
pub mod server;

use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

use self::ai_hub::{CompanionAiHub, DesktopAiSessionSnapshot};
use self::client::{CompanionClientState, CompanionConnectionStatus};
use self::server::{CompanionServerState, ConnectedCompanionClient};
use crate::error::standard_error_from_raw;
use crate::sync::routes::{classify_host, detect_local_endpoints, upsert_peer_route};
use crate::sync::transport::{sync_server_status, SYNC_DEFAULT_PORT};
use crate::sync::{
    load_sync_state_for_transport, save_sync_state_for_transport, PeerBridgePermissions, PeerRoute,
    SyncTrustedPeer,
};

pub struct CompanionClientHandle(pub Arc<CompanionClientState>);

impl Default for CompanionClientHandle {
    fn default() -> Self {
        Self(Arc::new(CompanionClientState::default()))
    }
}

#[tauri::command]
pub fn companion_local_endpoints() -> Vec<PeerRoute> {
    let (_, active_port) = sync_server_status();
    let port = if active_port == 0 {
        SYNC_DEFAULT_PORT
    } else {
        active_port
    };
    detect_local_endpoints(port)
}

#[tauri::command]
pub fn companion_local_cli_backends() -> Vec<protocol::CliBackendInfo> {
    crate::ai_cli::probe_available_backends()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPeerPermissionsPayload {
    pub peer_device_id: String,
    pub permissions: PeerBridgePermissions,
}

#[tauri::command]
pub fn companion_set_peer_permissions(
    app: tauri::AppHandle,
    server: State<'_, CompanionServerState>,
    payload: SetPeerPermissionsPayload,
) -> Result<SyncTrustedPeer, String> {
    let mut state = load_sync_state_for_transport(&app)
        .map_err(|e| standard_error_from_raw("companion", "set permissions", e))?;
    let peer = state
        .trusted_peers
        .iter_mut()
        .find(|p| p.peer_device_id == payload.peer_device_id)
        .ok_or_else(|| "Trusted peer not found".to_string())?;
    let prev = peer.bridge_permissions.clone();
    peer.bridge_permissions = payload.permissions.clone();
    let mut sanitized = peer.clone();
    sanitized.sync_secret = None;
    save_sync_state_for_transport(&app, &state)
        .map_err(|e| standard_error_from_raw("companion", "set permissions", e))?;
    let revoked = (prev.allow_ai_cli && !payload.permissions.allow_ai_cli)
        || (prev.allow_terminal_view && !payload.permissions.allow_terminal_view)
        || (prev.allow_terminal_control && !payload.permissions.allow_terminal_control);
    if revoked {
        server.kick_peer(&app, &payload.peer_device_id);
    }
    Ok(sanitized)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPeerRoutePayload {
    pub peer_device_id: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[tauri::command]
pub fn companion_add_peer_route(
    app: tauri::AppHandle,
    payload: AddPeerRoutePayload,
) -> Result<SyncTrustedPeer, String> {
    let host = payload.host.trim().to_string();
    if host.is_empty() || payload.port == 0 {
        return Err("host and port are required".to_string());
    }
    let mut state = load_sync_state_for_transport(&app)
        .map_err(|e| standard_error_from_raw("companion", "add route", e))?;
    let peer = state
        .trusted_peers
        .iter_mut()
        .find(|p| p.peer_device_id == payload.peer_device_id)
        .ok_or_else(|| "Trusted peer not found".to_string())?;
    let kind = payload
        .kind
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| classify_host(&host).to_string());
    upsert_peer_route(
        peer,
        PeerRoute {
            kind,
            host,
            port: payload.port,
            label: payload.label,
            last_ok_at: None,
        },
    );
    let mut sanitized = peer.clone();
    sanitized.sync_secret = None;
    save_sync_state_for_transport(&app, &state)
        .map_err(|e| standard_error_from_raw("companion", "add route", e))?;
    Ok(sanitized)
}

#[tauri::command]
pub fn companion_server_status(server: State<'_, CompanionServerState>) -> serde_json::Value {
    serde_json::json!({
        "enabled": server.is_enabled(),
        "clients": server.list_clients(),
    })
}

#[tauri::command]
pub fn companion_server_clients(
    server: State<'_, CompanionServerState>,
) -> Vec<ConnectedCompanionClient> {
    server.list_clients()
}

#[tauri::command]
pub fn companion_set_server_enabled(
    app: tauri::AppHandle,
    server: State<'_, CompanionServerState>,
    enabled: bool,
) -> bool {
    server.set_enabled(&app, enabled);
    server.is_enabled()
}

#[tauri::command]
pub fn companion_kick_client(
    app: tauri::AppHandle,
    server: State<'_, CompanionServerState>,
    conn_id: String,
) -> bool {
    server.kick_client(&app, &conn_id)
}

#[tauri::command]
pub fn companion_publish_ai_state(
    hub: State<'_, CompanionAiHub>,
    snapshot: DesktopAiSessionSnapshot,
) {
    hub.publish(snapshot);
}

#[tauri::command]
pub fn companion_remove_ai_state(hub: State<'_, CompanionAiHub>, session_id: String) {
    hub.remove_session(&session_id);
}

#[tauri::command]
pub async fn companion_connect(
    app: tauri::AppHandle,
    client: State<'_, CompanionClientHandle>,
    peer_device_id: String,
) -> Result<CompanionConnectionStatus, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || client.connect(&app, &peer_device_id))
        .await
        .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub fn companion_disconnect(app: tauri::AppHandle, client: State<'_, CompanionClientHandle>) {
    client.0.disconnect(&app);
}

#[tauri::command]
pub fn companion_status(client: State<'_, CompanionClientHandle>) -> CompanionConnectionStatus {
    client.0.status()
}

#[tauri::command]
pub async fn companion_remote_ai_cli_probe(
    client: State<'_, CompanionClientHandle>,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc("ai_cli.probe", serde_json::json!({}))
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub async fn companion_remote_ai_cli_start(
    client: State<'_, CompanionClientHandle>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || client.call_rpc("ai_cli.start", request))
        .await
        .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub fn companion_remote_ai_cli_cancel(
    client: State<'_, CompanionClientHandle>,
    request_id: String,
) -> Result<(), String> {
    client.0.send_cancel(&request_id)
}

#[tauri::command]
pub async fn companion_remote_list_sessions(
    client: State<'_, CompanionClientHandle>,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc("session.list", serde_json::json!({}))
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub async fn companion_remote_attach_session(
    client: State<'_, CompanionClientHandle>,
    session_id: String,
    after_seq: Option<u64>,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc(
            "session.attach",
            serde_json::json!({
                "sessionId": session_id,
                "afterSeq": after_seq.unwrap_or(0),
            }),
        )
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub async fn companion_remote_detach_session(
    client: State<'_, CompanionClientHandle>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc(
            "session.detach",
            serde_json::json!({ "sessionId": session_id }),
        )
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub async fn companion_remote_send_input(
    client: State<'_, CompanionClientHandle>,
    session_id: String,
    input: String,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc(
            "session.input",
            serde_json::json!({
                "sessionId": session_id,
                "input": input,
            }),
        )
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub async fn companion_remote_resize_session(
    client: State<'_, CompanionClientHandle>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc(
            "session.resize",
            serde_json::json!({
                "sessionId": session_id,
                "cols": cols,
                "rows": rows,
            }),
        )
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub async fn companion_remote_subscribe_ai(
    client: State<'_, CompanionClientHandle>,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc("ai_session.subscribe", serde_json::json!({}))
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

#[tauri::command]
pub async fn companion_remote_ai_action(
    client: State<'_, CompanionClientHandle>,
    session_id: String,
    action: String,
    prompt: Option<String>,
    message_id: Option<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = Arc::clone(&client.0);
    tauri::async_runtime::spawn_blocking(move || {
        client.call_rpc(
            "ai_session.action",
            serde_json::json!({
                "sessionId": session_id,
                "action": action,
                "prompt": prompt,
                "messageId": message_id,
                "mode": mode,
            }),
        )
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}
