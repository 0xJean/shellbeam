//! Desktop-side Companion Bridge server.
//! Upgrades authenticated paired TCP connections (`bridge_open`) into persistent
//! HKDF/AES-256-GCM multiplexed streams serving:
//! - Remote AI CLI execution (`ai_cli.probe` / `ai_cli.start` / `ai_cli.cancel`)
//! - Live interactive terminal mirroring & input (`session.list` / `attach` / `detach` / `input` / `resize`)
//! - Live desktop AI conversation snapshots & remote command approval (`ai_session.list` / `subscribe` / `action`)

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};

use super::ai_hub::{CompanionAiActionEvent, CompanionAiHub};
use super::protocol::{
    derive_session_ciphers, read_encrypted_frame, write_encrypted_frame, BridgeFrame, Role,
    BRIDGE_PROTOCOL_VERSION,
};
use crate::ai_cli::{self, AiCliState};
use crate::ssh::interactive::InteractiveSessionState;
use crate::storage::now_unix_ms;
use crate::sync::transport::{encrypt_message, response_value, CLIENT_NONCE_FIELD};
use crate::sync::{load_sync_state_for_transport, PeerBridgePermissions};

const BRIDGE_READ_TIMEOUT: Duration = Duration::from_secs(45);
const BRIDGE_WRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedCompanionClient {
    pub conn_id: String,
    pub peer_device_id: String,
    pub peer_device_name: String,
    pub remote_addr: String,
    pub connected_at: i64,
}

struct ActiveClientEntry {
    info: ConnectedCompanionClient,
    stream: TcpStream,
    cancel_all: Arc<AtomicBool>,
}

pub struct CompanionServerState {
    enabled: AtomicBool,
    clients: Mutex<HashMap<String, ActiveClientEntry>>,
}

impl Default for CompanionServerState {
    fn default() -> Self {
        Self {
            // Only desktop OSes act as Companion Bridge hosts by default.
            // Mobile/tablet devices (including unfolded foldables and iPads) act as clients.
            enabled: AtomicBool::new(!cfg!(any(target_os = "android", target_os = "ios"))),
            clients: Mutex::new(HashMap::new()),
        }
    }
}

impl CompanionServerState {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn set_enabled(&self, app: &tauri::AppHandle, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
        if !enabled {
            self.kick_all(app);
        }
    }

    pub fn list_clients(&self) -> Vec<ConnectedCompanionClient> {
        self.clients
            .lock()
            .map(|map| map.values().map(|e| e.info.clone()).collect())
            .unwrap_or_default()
    }

    pub fn kick_client(&self, app: &tauri::AppHandle, conn_id: &str) -> bool {
        let removed = self
            .clients
            .lock()
            .ok()
            .and_then(|mut map| map.remove(conn_id));
        if let Some(entry) = removed {
            entry.cancel_all.store(true, Ordering::Release);
            let _ = entry.stream.shutdown(Shutdown::Both);
            self.emit_clients_changed(app);
            true
        } else {
            false
        }
    }

    pub fn kick_peer(&self, app: &tauri::AppHandle, peer_device_id: &str) {
        let ids: Vec<String> = self
            .clients
            .lock()
            .map(|map| {
                map.iter()
                    .filter(|(_, e)| e.info.peer_device_id == peer_device_id)
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            self.kick_client(app, &id);
        }
    }

    pub fn kick_all(&self, app: &tauri::AppHandle) {
        let entries: Vec<ActiveClientEntry> = self
            .clients
            .lock()
            .map(|mut map| map.drain().map(|(_, v)| v).collect())
            .unwrap_or_default();
        for entry in entries {
            entry.cancel_all.store(true, Ordering::Release);
            let _ = entry.stream.shutdown(Shutdown::Both);
        }
        self.emit_clients_changed(app);
    }

    fn register_client(
        &self,
        app: &tauri::AppHandle,
        info: ConnectedCompanionClient,
        stream: TcpStream,
        cancel_all: Arc<AtomicBool>,
    ) {
        if let Ok(mut map) = self.clients.lock() {
            map.insert(
                info.conn_id.clone(),
                ActiveClientEntry {
                    info,
                    stream,
                    cancel_all,
                },
            );
        }
        self.emit_clients_changed(app);
    }

    fn unregister_client(&self, app: &tauri::AppHandle, conn_id: &str) {
        let removed = self
            .clients
            .lock()
            .ok()
            .and_then(|mut map| map.remove(conn_id));
        if removed.is_some() {
            self.emit_clients_changed(app);
        }
    }

    fn emit_clients_changed(&self, app: &tauri::AppHandle) {
        let _ = app.emit("companion:clients-changed", self.list_clients());
    }
}

fn load_peer_permissions(
    app: &tauri::AppHandle,
    peer_device_id: &str,
) -> Option<(String, PeerBridgePermissions)> {
    let state = load_sync_state_for_transport(app).ok()?;
    let peer = state
        .trusted_peers
        .iter()
        .find(|p| p.peer_device_id == peer_device_id)?;
    Some((
        peer.peer_device_name
            .clone()
            .unwrap_or_else(|| peer_device_id.to_string()),
        peer.bridge_permissions.clone(),
    ))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_bridge_upgrade(
    app: tauri::AppHandle,
    peer_device_id: String,
    sync_key: [u8; 32],
    challenge: String,
    client_nonce: String,
    _params: Option<serde_json::Value>,
    mut writer_stream: TcpStream,
    mut reader: BufReader<TcpStream>,
    remote_addr: Option<SocketAddr>,
) {
    let server_state = app.state::<CompanionServerState>();
    if !server_state.is_enabled() {
        let mut resp = response_value(Err("Companion bridge is disabled on desktop".to_string()));
        resp[CLIENT_NONCE_FIELD] = serde_json::Value::String(client_nonce);
        if let Ok(enc) = encrypt_message(&sync_key, resp.to_string().as_bytes()) {
            let _ = writeln!(writer_stream, "{enc}");
        }
        return;
    }

    let Some((peer_name, permissions)) = load_peer_permissions(&app, &peer_device_id) else {
        let mut resp = response_value(Err("Trusted peer not found".to_string()));
        resp[CLIENT_NONCE_FIELD] = serde_json::Value::String(client_nonce);
        if let Ok(enc) = encrypt_message(&sync_key, resp.to_string().as_bytes()) {
            let _ = writeln!(writer_stream, "{enc}");
        }
        return;
    };

    let (local_device_id, local_device_name) = load_sync_state_for_transport(&app)
        .ok()
        .and_then(|s| s.local_device)
        .map(|d| (d.device_id, d.device_name))
        .unwrap_or_else(|| {
            (
                "desktop".to_string(),
                crate::sync::transport_mdns::native_device_name_public(),
            )
        });

    let ciphers = match derive_session_ciphers(&sync_key, &challenge, &client_nonce, Role::Server) {
        Ok(c) => c,
        Err(err) => {
            let mut resp = response_value(Err(err));
            resp[CLIENT_NONCE_FIELD] = serde_json::Value::String(client_nonce);
            if let Ok(enc) = encrypt_message(&sync_key, resp.to_string().as_bytes()) {
                let _ = writeln!(writer_stream, "{enc}");
            }
            return;
        }
    };

    // Send initial encrypted ACK with server device identity so client verifies identity before use.
    let mut ack = response_value(Ok(serde_json::json!({
        "bridgeVersion": BRIDGE_PROTOCOL_VERSION,
        "deviceId": local_device_id,
        "deviceName": local_device_name,
    })));
    ack[CLIENT_NONCE_FIELD] = serde_json::Value::String(client_nonce);
    if let Ok(enc) = encrypt_message(&sync_key, ack.to_string().as_bytes()) {
        if writeln!(writer_stream, "{enc}").is_err() || writer_stream.flush().is_err() {
            return;
        }
    } else {
        return;
    }

    let _ = writer_stream.set_read_timeout(Some(BRIDGE_READ_TIMEOUT));
    let _ = writer_stream.set_write_timeout(Some(BRIDGE_WRITE_TIMEOUT));
    let _ = writer_stream.set_nodelay(true);
    let _ = reader.get_ref().set_read_timeout(Some(BRIDGE_READ_TIMEOUT));

    let conn_id = uuid::Uuid::new_v4().to_string();
    let cancel_all = Arc::new(AtomicBool::new(false));
    if let Ok(stream_for_kick) = writer_stream.try_clone() {
        server_state.register_client(
            &app,
            ConnectedCompanionClient {
                conn_id: conn_id.clone(),
                peer_device_id: peer_device_id.clone(),
                peer_device_name: peer_name,
                remote_addr: remote_addr
                    .map(|a| a.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                connected_at: now_unix_ms(),
            },
            stream_for_kick,
            cancel_all.clone(),
        );
    }

    let (tx_frame, rx_frame) = mpsc::channel::<BridgeFrame>();
    let mut tx_cipher = ciphers.tx;
    let mut rx_cipher = ciphers.rx;
    let writer_thread = thread::spawn(move || {
        while let Ok(frame) = rx_frame.recv() {
            if write_encrypted_frame(&mut writer_stream, &mut tx_cipher, &frame).is_err() {
                break;
            }
        }
        let _ = writer_stream.shutdown(Shutdown::Both);
    });

    // Send Hello frame with capabilities, permissions, available local AI CLIs, and current
    // LAN + Tailscale endpoints so mobile clients silently refresh routes for zero-touch failover.
    let (_, active_port) = crate::sync::transport::sync_server_status();
    let listen_port = if active_port > 0 { active_port } else { 9123 };
    let _ = tx_frame.send(BridgeFrame::Hello {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        device_id: local_device_id,
        device_name: local_device_name,
        os: std::env::consts::OS.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        permissions: permissions.clone(),
        cli_backends: ai_cli::probe_available_backends(),
        endpoints: crate::sync::routes::detect_local_endpoints(listen_port),
    });

    // Track per-connection resources so everything cleans up on disconnect.
    let active_ai_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let attached_terminals: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let ai_hub_sub_id: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));

    // Automatically push desktop session list snapshots in real time so connected phones never
    // need a manual refresh when desktop tabs open, change status, or close.
    let session_list_sub_id: Option<u64> = match app
        .state::<InteractiveSessionState>()
        .subscribe_session_list()
    {
        Ok((sub_id, initial_sessions, rx)) => {
            if permissions.allow_terminal_view {
                if let Ok(payload) = serde_json::to_value(&initial_sessions) {
                    let _ = tx_frame.send(BridgeFrame::Event {
                        topic: "sessions".to_string(),
                        payload,
                    });
                }
            }
            let fwd_tx = tx_frame.clone();
            let fwd_cancel = cancel_all.clone();
            let fwd_app = app.clone();
            let fwd_peer = peer_device_id.clone();
            thread::spawn(move || {
                while let Ok(next_sessions) = rx.recv() {
                    if fwd_cancel.load(Ordering::Acquire) {
                        break;
                    }
                    let allowed = load_peer_permissions(&fwd_app, &fwd_peer)
                        .map(|(_, p)| p.allow_terminal_view)
                        .unwrap_or(false);
                    let list = if allowed { next_sessions } else { Vec::new() };
                    if let Ok(payload) = serde_json::to_value(list) {
                        if fwd_tx
                            .send(BridgeFrame::Event {
                                topic: "sessions".to_string(),
                                payload,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            });
            Some(sub_id)
        }
        Err(_) => None,
    };

    loop {
        if cancel_all.load(Ordering::Acquire) {
            break;
        }
        let frame = match read_encrypted_frame(&mut reader, &mut rx_cipher) {
            Ok(f) => f,
            Err(_) => break,
        };
        match frame {
            BridgeFrame::Ping { ts } => {
                if tx_frame.send(BridgeFrame::Pong { ts }).is_err() {
                    break;
                }
            }
            BridgeFrame::Pong { .. }
            | BridgeFrame::Hello { .. }
            | BridgeFrame::Res { .. }
            | BridgeFrame::Event { .. } => {}
            BridgeFrame::Cancel { id } => {
                if let Ok(jobs) = active_ai_jobs.lock() {
                    if let Some(flag) = jobs.get(&id) {
                        flag.store(true, Ordering::Release);
                    }
                }
                app.state::<AiCliState>().cancel_request(&id);
            }
            BridgeFrame::Req { id, method, params } => {
                let res = dispatch_rpc(
                    &app,
                    &peer_device_id,
                    &id,
                    &method,
                    params,
                    &tx_frame,
                    &cancel_all,
                    &active_ai_jobs,
                    &attached_terminals,
                    &ai_hub_sub_id,
                );
                let frame = match res {
                    Ok(data) => BridgeFrame::Res {
                        id,
                        ok: true,
                        data: Some(data),
                        error: None,
                    },
                    Err(error) => BridgeFrame::Res {
                        id,
                        ok: false,
                        data: None,
                        error: Some(error),
                    },
                };
                if tx_frame.send(frame).is_err() {
                    break;
                }
            }
        }
    }

    // Cleanup on disconnect: cancel all in-flight AI CLI jobs & detach all subscriptions.
    cancel_all.store(true, Ordering::Release);
    if let Ok(mut jobs) = active_ai_jobs.lock() {
        for (req_id, flag) in jobs.drain() {
            flag.store(true, Ordering::Release);
            app.state::<AiCliState>().cancel_request(&req_id);
        }
    }
    if let Ok(mut attached) = attached_terminals.lock() {
        let interactive = app.state::<InteractiveSessionState>();
        for (session_id, sub_id) in attached.drain() {
            interactive.detach_remote(&session_id, sub_id);
        }
    }
    if let Ok(mut sub) = ai_hub_sub_id.lock() {
        if let Some(sub_id) = sub.take() {
            app.state::<CompanionAiHub>().unsubscribe(sub_id);
        }
    }
    if let Some(sub_id) = session_list_sub_id {
        app.state::<InteractiveSessionState>()
            .unsubscribe_session_list(sub_id);
    }

    drop(tx_frame);
    let _ = writer_thread.join();
    app.state::<CompanionServerState>()
        .unregister_client(&app, &conn_id);
}

#[allow(clippy::too_many_arguments)]
fn dispatch_rpc(
    app: &tauri::AppHandle,
    peer_device_id: &str,
    _rpc_id: &str,
    method: &str,
    params: serde_json::Value,
    tx_frame: &mpsc::Sender<BridgeFrame>,
    conn_cancel: &Arc<AtomicBool>,
    active_ai_jobs: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    attached_terminals: &Arc<Mutex<HashMap<String, u64>>>,
    ai_hub_sub_id: &Arc<Mutex<Option<u64>>>,
) -> Result<serde_json::Value, String> {
    let (_, perms) = load_peer_permissions(app, peer_device_id)
        .ok_or_else(|| "Peer authorization revoked".to_string())?;

    match method {
        "ai_cli.probe" => {
            if !perms.allow_ai_cli {
                return Err("permission_denied:ai_cli".to_string());
            }
            Ok(serde_json::to_value(ai_cli::probe_available_backends())
                .map_err(|e| e.to_string())?)
        }
        "ai_cli.start" => {
            if !perms.allow_ai_cli {
                return Err("permission_denied:ai_cli".to_string());
            }
            let mut request: ai_cli::Request =
                serde_json::from_value(params).map_err(|e| format!("invalid_request: {e}"))?;
            // Never let a remote peer choose an arbitrary executable path on the desktop host.
            request.clear_executable();
            ai_cli::validate_request(&request)?;
            let req_id = serde_json::to_value(&request.request_id)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default();
            let job_cancel = Arc::new(AtomicBool::new(false));
            if let Ok(mut jobs) = active_ai_jobs.lock() {
                jobs.insert(req_id.clone(), job_cancel.clone());
            }
            let tx_clone = tx_frame.clone();
            let state_clone = app.state::<AiCliState>().inner().clone();
            let conn_cancel_clone = conn_cancel.clone();
            let jobs_clone = active_ai_jobs.clone();
            thread::spawn(move || {
                let effective_cancel = Arc::new(AtomicBool::new(false));
                let watch_job = job_cancel.clone();
                let watch_conn = conn_cancel_clone.clone();
                let watch_out = effective_cancel.clone();
                let done_flag = Arc::new(AtomicBool::new(false));
                let done_watcher = done_flag.clone();
                let watcher = thread::spawn(move || {
                    while !done_watcher.load(Ordering::Acquire) {
                        if watch_job.load(Ordering::Acquire) || watch_conn.load(Ordering::Acquire) {
                            watch_out.store(true, Ordering::Release);
                            break;
                        }
                        thread::sleep(Duration::from_millis(25));
                    }
                });

                let req_id_for_events = req_id.clone();
                let result = ai_cli::run_remote_generation(
                    &state_clone,
                    &request,
                    effective_cancel,
                    |event| {
                        tx_clone
                            .send(BridgeFrame::Event {
                                topic: "ai_cli".to_string(),
                                payload: serde_json::json!({
                                    "requestId": req_id_for_events,
                                    "event": event,
                                }),
                            })
                            .map_err(|_| "cancelled".to_string())
                    },
                );

                done_flag.store(true, Ordering::Release);
                let _ = watcher.join();
                if let Ok(mut jobs) = jobs_clone.lock() {
                    jobs.remove(&req_id);
                }

                let final_event = match result {
                    Ok(()) => ai_cli::Event::Done,
                    Err(code) => ai_cli::Event::Error { code },
                };
                let _ = tx_clone.send(BridgeFrame::Event {
                    topic: "ai_cli".to_string(),
                    payload: serde_json::json!({
                        "requestId": req_id,
                        "event": final_event,
                    }),
                });
            });
            Ok(serde_json::json!({ "started": true }))
        }
        "ai_cli.cancel" => {
            let request_id = params
                .get("requestId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "requestId required".to_string())?;
            if let Ok(jobs) = active_ai_jobs.lock() {
                if let Some(flag) = jobs.get(request_id) {
                    flag.store(true, Ordering::Release);
                }
            }
            app.state::<AiCliState>().cancel_request(request_id);
            Ok(serde_json::json!({ "cancelled": true }))
        }
        "session.list" => {
            if !perms.allow_terminal_view {
                return Err("permission_denied:terminal_view".to_string());
            }
            let sessions = app
                .state::<InteractiveSessionState>()
                .list_sessions_snapshot()?;
            let ai_snapshots = app.state::<CompanionAiHub>().list();
            Ok(serde_json::json!({
                "sessions": sessions,
                "aiSessions": ai_snapshots,
            }))
        }
        "session.attach" => {
            if !perms.allow_terminal_view {
                return Err("permission_denied:terminal_view".to_string());
            }
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "sessionId required".to_string())?
                .to_string();
            let after_seq = params.get("afterSeq").and_then(|v| v.as_u64()).unwrap_or(0);
            let interactive = app.state::<InteractiveSessionState>();

            // Detach any prior subscription for this same session on this connection.
            if let Ok(mut map) = attached_terminals.lock() {
                if let Some(old_sub) = map.remove(&session_id) {
                    interactive.detach_remote(&session_id, old_sub);
                }
            }

            let (sub_id, status, replay, rx) = interactive.attach_remote(&session_id, after_seq)?;
            if let Ok(mut map) = attached_terminals.lock() {
                map.insert(session_id.clone(), sub_id);
            }
            let tx_clone = tx_frame.clone();
            let conn_cancel_clone = conn_cancel.clone();
            thread::spawn(move || {
                while !conn_cancel_clone.load(Ordering::Acquire) {
                    match rx.recv_timeout(Duration::from_millis(250)) {
                        Ok(evt) => {
                            let payload = serde_json::to_value(evt).unwrap_or_default();
                            if tx_clone
                                .send(BridgeFrame::Event {
                                    topic: "terminal".to_string(),
                                    payload,
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            });
            let ai_snapshot = app.state::<CompanionAiHub>().get(&session_id);
            Ok(serde_json::json!({
                "sessionId": session_id,
                "status": status,
                "chunks": replay,
                "aiSession": ai_snapshot,
            }))
        }
        "session.detach" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "sessionId required".to_string())?;
            if let Ok(mut map) = attached_terminals.lock() {
                if let Some(sub_id) = map.remove(session_id) {
                    app.state::<InteractiveSessionState>()
                        .detach_remote(session_id, sub_id);
                }
            }
            Ok(serde_json::json!({ "detached": true }))
        }
        "session.input" => {
            if !perms.allow_terminal_control {
                return Err("permission_denied:terminal_control".to_string());
            }
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "sessionId required".to_string())?;
            let input = params
                .get("input")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "input required".to_string())?;
            if input.len() > 64 * 1024 {
                return Err("input_too_large".to_string());
            }
            app.state::<InteractiveSessionState>()
                .send_remote_input(session_id, input.to_string())?;
            Ok(serde_json::json!({ "sent": true }))
        }
        "session.resize" => {
            if !perms.allow_terminal_control {
                return Err("permission_denied:terminal_control".to_string());
            }
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "sessionId required".to_string())?;
            let cols = params
                .get("cols")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .ok_or_else(|| "cols required".to_string())?;
            let rows = params
                .get("rows")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .ok_or_else(|| "rows required".to_string())?;
            app.state::<InteractiveSessionState>().resize_remote(
                session_id,
                cols.clamp(20, 400),
                rows.clamp(5, 200),
            )?;
            Ok(serde_json::json!({ "resized": true }))
        }
        "ai_session.subscribe" => {
            if !perms.allow_terminal_view {
                return Err("permission_denied:terminal_view".to_string());
            }
            let hub = app.state::<CompanionAiHub>();
            if let Ok(mut current) = ai_hub_sub_id.lock() {
                if let Some(old_id) = current.take() {
                    hub.unsubscribe(old_id);
                }
                let (sub_id, rx) = hub.subscribe();
                *current = Some(sub_id);
                let tx_clone = tx_frame.clone();
                let conn_cancel_clone = conn_cancel.clone();
                thread::spawn(move || {
                    while !conn_cancel_clone.load(Ordering::Acquire) {
                        match rx.recv_timeout(Duration::from_millis(250)) {
                            Ok(snapshot) => {
                                let payload = serde_json::to_value(snapshot).unwrap_or_default();
                                if tx_clone
                                    .send(BridgeFrame::Event {
                                        topic: "ai_state".to_string(),
                                        payload,
                                    })
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                });
            }
            Ok(serde_json::to_value(hub.list()).map_err(|e| e.to_string())?)
        }
        "ai_session.action" => {
            if !perms.allow_terminal_control {
                return Err("permission_denied:terminal_control".to_string());
            }
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "sessionId required".to_string())?
                .to_string();
            let action = params
                .get("action")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "action required".to_string())?
                .to_string();
            if !matches!(
                action.as_str(),
                "run_pending" | "cancel" | "send_prompt" | "set_mode"
            ) {
                return Err("invalid_action".to_string());
            }
            let prompt = params
                .get("prompt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let message_id = params
                .get("messageId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mode = params
                .get("mode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            app.state::<CompanionAiHub>().dispatch_action(
                app,
                CompanionAiActionEvent {
                    session_id,
                    action,
                    prompt,
                    message_id,
                    mode,
                    peer_device_id: peer_device_id.to_string(),
                },
            )?;
            Ok(serde_json::json!({ "dispatched": true }))
        }
        other => Err(format!("Unknown bridge method: {other}")),
    }
}
