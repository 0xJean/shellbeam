//! Client-side Companion Bridge connector (runs on mobile or secondary desktop).
//! Connects to a paired desktop using Happy-Eyeballs route selection (LAN first with
//! 600ms head-start, then parallel Tailscale / Custom failover), verifies desktop identity
//! before sending any requests, syncs desktop's latest LAN + Tailscale endpoints silently,
//! maintains an encrypted HKDF/AES-256-GCM frame channel with keepalive pings, and
//! auto-reconnects seamlessly on network transitions (Wi-Fi ↔ 5G).

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

use super::protocol::{
    derive_session_ciphers, read_encrypted_frame, write_encrypted_frame, BridgeFrame,
    CliBackendInfo, Role,
};
use crate::storage::now_unix_ms;
use crate::sync::routes::{collect_candidate_routes, connect_tcp_route, upsert_peer_route};
use crate::sync::transport::{
    decrypt_message, encrypt_message, parse_response, parse_sync_secret, random_token,
    read_limited_line, unwrap_response, BRIDGE_UPGRADE_METHOD, CLIENT_NONCE_FIELD, HELLO_METHOD,
    MAX_ENCRYPTED_LINE_BYTES, MAX_PLAIN_LINE_BYTES, REPAIR_REQUIRED,
};
use crate::sync::{
    load_sync_state_for_transport, save_sync_state_for_transport, PeerBridgePermissions, PeerRoute,
};

const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(45);
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const CLIENT_PING_INTERVAL: Duration = Duration::from_secs(15);
const RPC_TIMEOUT: Duration = Duration::from_secs(20);
/// LAN gets a 600ms head-start before Tailscale / Custom routes are raced in parallel.
/// Same-Wi-Fi LAN connects in ~5-40ms and wins; off-LAN fails over to Tailscale in <1s.
const LAN_HEAD_START: Duration = Duration::from_millis(600);
const AUTO_RECONNECT_BACKOFF_MS: &[u64] = &[800, 1500, 2500, 4000, 6000, 8000];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionConnectionStatus {
    pub state: String, // "disconnected" | "connecting" | "connected" | "error"
    pub peer_device_id: Option<String>,
    pub peer_device_name: Option<String>,
    pub route_kind: Option<String>,
    pub route_endpoint: Option<String>,
    pub desktop_os: Option<String>,
    pub app_version: Option<String>,
    pub permissions: Option<PeerBridgePermissions>,
    pub cli_backends: Vec<CliBackendInfo>,
    pub error: Option<String>,
    pub connected_at: Option<i64>,
}

impl Default for CompanionConnectionStatus {
    fn default() -> Self {
        Self {
            state: "disconnected".to_string(),
            peer_device_id: None,
            peer_device_name: None,
            route_kind: None,
            route_endpoint: None,
            desktop_os: None,
            app_version: None,
            permissions: None,
            cli_backends: Vec::new(),
            error: None,
            connected_at: None,
        }
    }
}

struct ActiveConnection {
    tx: mpsc::Sender<BridgeFrame>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<serde_json::Value, String>>>>>,
    shutdown: Arc<AtomicBool>,
    stream: TcpStream,
}

#[derive(Default)]
pub struct CompanionClientState {
    status: Mutex<CompanionConnectionStatus>,
    active: Mutex<Option<ActiveConnection>>,
    desired_peer_id: Mutex<Option<String>>,
    session_gen: AtomicU64,
}

type DialSuccess = (
    PeerRoute,
    TcpStream,
    BufReader<TcpStream>,
    super::protocol::BridgeCiphers,
    String,
);

impl CompanionClientState {
    pub fn status(&self) -> CompanionConnectionStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn set_status(&self, app: &tauri::AppHandle, next: CompanionConnectionStatus) {
        if let Ok(mut guard) = self.status.lock() {
            *guard = next.clone();
        }
        let _ = app.emit("companion:status", next);
    }

    fn close_active_stream(&self) {
        if let Ok(mut guard) = self.active.lock() {
            if let Some(conn) = guard.take() {
                conn.shutdown.store(true, Ordering::Release);
                let _ = conn.stream.shutdown(Shutdown::Both);
                if let Ok(mut pending) = conn.pending.lock() {
                    for (_, tx) in pending.drain() {
                        let _ = tx.send(Err("Disconnected".to_string()));
                    }
                }
            }
        }
    }

    pub fn disconnect(&self, app: &tauri::AppHandle) {
        // Explicit user disconnect cancels any background auto-reconnect loop.
        self.session_gen.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut desired) = self.desired_peer_id.lock() {
            *desired = None;
        }
        self.close_active_stream();
        self.set_status(app, CompanionConnectionStatus::default());
    }

    pub fn connect(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        peer_device_id: &str,
    ) -> Result<CompanionConnectionStatus, String> {
        let generation = self.session_gen.fetch_add(1, Ordering::AcqRel) + 1;
        if let Ok(mut desired) = self.desired_peer_id.lock() {
            *desired = Some(peer_device_id.to_string());
        }
        self.close_active_stream();
        self.connect_with_gen(app, peer_device_id, generation, true)
    }

    fn connect_with_gen(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        peer_device_id: &str,
        expected_gen: u64,
        report_error: bool,
    ) -> Result<CompanionConnectionStatus, String> {
        if self.session_gen.load(Ordering::Acquire) != expected_gen {
            return Err("Cancelled".to_string());
        }

        let state = load_sync_state_for_transport(app)?;
        let peer = state
            .trusted_peers
            .iter()
            .find(|p| p.peer_device_id == peer_device_id)
            .cloned()
            .ok_or_else(|| "Trusted desktop peer not found".to_string())?;
        let sync_key =
            parse_sync_secret(&peer.sync_secret).ok_or_else(|| REPAIR_REQUIRED.to_string())?;
        let candidates = collect_candidate_routes(&peer);
        if candidates.is_empty() {
            return Err("No routes configured for this desktop peer".to_string());
        }

        self.set_status(
            app,
            CompanionConnectionStatus {
                state: "connecting".to_string(),
                peer_device_id: Some(peer.peer_device_id.clone()),
                peer_device_name: peer.peer_device_name.clone(),
                ..Default::default()
            },
        );

        let dialed = dial_best_route(&candidates, sync_key, &peer.peer_device_id);
        if self.session_gen.load(Ordering::Acquire) != expected_gen {
            if let Ok((_, stream, _, _, _)) = dialed {
                let _ = stream.shutdown(Shutdown::Both);
            }
            return Err("Cancelled".to_string());
        }

        let (winning_route, mut writer_stream, mut reader, ciphers, remote_name) = match dialed {
            Ok(ok) => ok,
            Err(last_err) => {
                if report_error {
                    let err_status = CompanionConnectionStatus {
                        state: "error".to_string(),
                        peer_device_id: Some(peer.peer_device_id),
                        peer_device_name: peer.peer_device_name,
                        error: Some(last_err.clone()),
                        ..Default::default()
                    };
                    self.set_status(app, err_status);
                }
                return Err(last_err);
            }
        };

        let _ = writer_stream.set_read_timeout(Some(CLIENT_READ_TIMEOUT));
        let _ = writer_stream.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
        let _ = reader.get_ref().set_read_timeout(Some(CLIENT_READ_TIMEOUT));

        // Read the server's Hello frame immediately so status reflects capabilities, CLI backends,
        // and the desktop's latest LAN + Tailscale endpoints.
        let mut tx_cipher = ciphers.tx;
        let mut rx_cipher = ciphers.rx;
        let hello = read_encrypted_frame(&mut reader, &mut rx_cipher).map_err(|e| {
            if report_error {
                let err_status = CompanionConnectionStatus {
                    state: "error".to_string(),
                    peer_device_id: Some(peer.peer_device_id.clone()),
                    peer_device_name: peer.peer_device_name.clone(),
                    error: Some(e.clone()),
                    ..Default::default()
                };
                self.set_status(app, err_status);
            }
            e
        })?;

        let (desktop_name, desktop_os, app_version, permissions, cli_backends, desktop_endpoints) =
            match hello {
                BridgeFrame::Hello {
                    device_name,
                    os,
                    app_version,
                    permissions,
                    cli_backends,
                    endpoints,
                    ..
                } => (
                    device_name,
                    Some(os),
                    Some(app_version),
                    Some(permissions),
                    cli_backends,
                    endpoints,
                ),
                _ => {
                    return Err("Unexpected first frame from desktop bridge".to_string());
                }
            };

        // Persist the winning route's `last_ok_at` AND silently merge desktop's latest LAN +
        // Tailscale endpoints so future switches between Wi-Fi and 5G work with zero user config.
        if let Ok(mut sync_state) = load_sync_state_for_transport(app) {
            if let Some(p) = sync_state
                .trusted_peers
                .iter_mut()
                .find(|p| p.peer_device_id == peer_device_id)
            {
                let mut updated = winning_route.clone();
                updated.last_ok_at = Some(now_unix_ms());
                upsert_peer_route(p, updated);
                for ep in desktop_endpoints {
                    upsert_peer_route(p, ep);
                }
                p.last_seen_at = now_unix_ms();
                let _ = save_sync_state_for_transport(app, &sync_state);
            }
        }

        let shutdown = Arc::new(AtomicBool::new(false));
        let pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<serde_json::Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (tx_frame, rx_frame) = mpsc::channel::<BridgeFrame>();

        let stream_for_close = writer_stream
            .try_clone()
            .map_err(|e| format!("clone stream: {e}"))?;

        let writer_shutdown = shutdown.clone();
        thread::spawn(move || {
            while let Ok(frame) = rx_frame.recv() {
                if writer_shutdown.load(Ordering::Acquire) {
                    break;
                }
                if write_encrypted_frame(&mut writer_stream, &mut tx_cipher, &frame).is_err() {
                    break;
                }
            }
            let _ = writer_stream.shutdown(Shutdown::Both);
        });

        // Keepalive ping thread.
        let ping_tx = tx_frame.clone();
        let ping_shutdown = shutdown.clone();
        thread::spawn(move || {
            while !ping_shutdown.load(Ordering::Acquire) {
                for _ in 0..30 {
                    if ping_shutdown.load(Ordering::Acquire) {
                        return;
                    }
                    thread::sleep(CLIENT_PING_INTERVAL / 30);
                }
                if ping_tx
                    .send(BridgeFrame::Ping { ts: now_unix_ms() })
                    .is_err()
                {
                    break;
                }
            }
        });

        // Reader thread forwarding responses and live streaming events to frontend, and triggering
        // silent automatic LAN ↔ Tailscale failover reconnect on unexpected network drops.
        let reader_pending = pending.clone();
        let reader_shutdown = shutdown.clone();
        let reader_app = app.clone();
        let reader_self = Arc::clone(self);
        let reader_peer_id = peer.peer_device_id.clone();
        thread::spawn(move || {
            while !reader_shutdown.load(Ordering::Acquire) {
                let frame = match read_encrypted_frame(&mut reader, &mut rx_cipher) {
                    Ok(f) => f,
                    Err(_) => break,
                };
                match frame {
                    BridgeFrame::Res {
                        id,
                        ok,
                        data,
                        error,
                    } => {
                        if let Ok(mut map) = reader_pending.lock() {
                            if let Some(waiter) = map.remove(&id) {
                                let res = if ok {
                                    Ok(data.unwrap_or(serde_json::Value::Null))
                                } else {
                                    Err(error.unwrap_or_else(|| "Unknown error".to_string()))
                                };
                                let _ = waiter.send(res);
                            }
                        }
                    }
                    BridgeFrame::Event { topic, payload } => {
                        let event_name = match topic.as_str() {
                            "terminal" => "companion:terminal-event",
                            "sessions" => "companion:sessions",
                            "ai_state" => "companion:ai-state",
                            "ai_cli" => "companion:ai-cli-event",
                            _ => "companion:event",
                        };
                        let _ = reader_app.emit(event_name, payload);
                    }
                    BridgeFrame::Ping { ts } => {
                        if let Ok(guard) = reader_self.active.lock() {
                            if let Some(conn) = guard.as_ref() {
                                let _ = conn.tx.send(BridgeFrame::Pong { ts });
                            }
                        }
                    }
                    BridgeFrame::Pong { .. }
                    | BridgeFrame::Hello { .. }
                    | BridgeFrame::Req { .. }
                    | BridgeFrame::Cancel { .. } => {}
                }
            }

            let was_active = {
                if let Ok(mut guard) = reader_self.active.lock() {
                    let matches_current = guard
                        .as_ref()
                        .map(|c| Arc::ptr_eq(&c.shutdown, &reader_shutdown))
                        .unwrap_or(false);
                    if matches_current {
                        guard.take();
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            };
            reader_shutdown.store(true, Ordering::Release);
            if let Ok(mut map) = reader_pending.lock() {
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err("Connection closed".to_string()));
                }
            }
            if was_active {
                let still_desired = reader_self.session_gen.load(Ordering::Acquire) == expected_gen
                    && reader_self
                        .desired_peer_id
                        .lock()
                        .ok()
                        .and_then(|g| g.clone())
                        .as_deref()
                        == Some(reader_peer_id.as_str());
                if still_desired {
                    reader_self.spawn_auto_reconnect(&reader_app, reader_peer_id, expected_gen);
                } else {
                    reader_self.set_status(&reader_app, CompanionConnectionStatus::default());
                }
            }
        });

        let connected_status = CompanionConnectionStatus {
            state: "connected".to_string(),
            peer_device_id: Some(peer.peer_device_id),
            peer_device_name: Some(if desktop_name.is_empty() {
                remote_name
            } else {
                desktop_name
            }),
            route_kind: Some(winning_route.kind),
            route_endpoint: Some(format!("{}:{}", winning_route.host, winning_route.port)),
            desktop_os,
            app_version,
            permissions,
            cli_backends,
            error: None,
            connected_at: Some(now_unix_ms()),
        };

        if let Ok(mut guard) = self.active.lock() {
            *guard = Some(ActiveConnection {
                tx: tx_frame,
                pending,
                shutdown,
                stream: stream_for_close,
            });
        }
        self.set_status(app, connected_status.clone());
        Ok(connected_status)
    }

    fn spawn_auto_reconnect(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        peer_device_id: String,
        expected_gen: u64,
    ) {
        let client = Arc::clone(self);
        let app_handle = app.clone();
        thread::spawn(move || {
            for &delay_ms in AUTO_RECONNECT_BACKOFF_MS {
                if client.session_gen.load(Ordering::Acquire) != expected_gen {
                    return;
                }
                client.set_status(
                    &app_handle,
                    CompanionConnectionStatus {
                        state: "connecting".to_string(),
                        peer_device_id: Some(peer_device_id.clone()),
                        ..Default::default()
                    },
                );
                thread::sleep(Duration::from_millis(delay_ms));
                if client.session_gen.load(Ordering::Acquire) != expected_gen {
                    return;
                }
                match client.connect_with_gen(&app_handle, &peer_device_id, expected_gen, false) {
                    Ok(_) => return,
                    Err(err) if is_fatal_bridge_error(&err) => {
                        if let Ok(mut desired) = client.desired_peer_id.lock() {
                            *desired = None;
                        }
                        client.set_status(
                            &app_handle,
                            CompanionConnectionStatus {
                                state: "error".to_string(),
                                peer_device_id: Some(peer_device_id),
                                error: Some(err),
                                ..Default::default()
                            },
                        );
                        return;
                    }
                    Err(_) => continue,
                }
            }
            if client.session_gen.load(Ordering::Acquire) == expected_gen {
                client.set_status(&app_handle, CompanionConnectionStatus::default());
            }
        });
    }

    pub fn call_rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (res_tx, res_rx) = mpsc::channel();
        let pending_ref = {
            let guard = self.active.lock().map_err(|_| "Bridge lock poisoned")?;
            let conn = guard
                .as_ref()
                .ok_or_else(|| "Not connected to a desktop companion".to_string())?;
            if let Ok(mut map) = conn.pending.lock() {
                map.insert(id.clone(), res_tx);
            }
            conn.tx
                .send(BridgeFrame::Req {
                    id: id.clone(),
                    method: method.to_string(),
                    params,
                })
                .map_err(|_| "Companion connection closed".to_string())?;
            conn.pending.clone()
        };

        match res_rx.recv_timeout(RPC_TIMEOUT) {
            Ok(res) => res,
            Err(_) => {
                if let Ok(mut map) = pending_ref.lock() {
                    map.remove(&id);
                }
                Err("Companion RPC timed out".to_string())
            }
        }
    }

    pub fn send_cancel(&self, id: &str) -> Result<(), String> {
        let guard = self.active.lock().map_err(|_| "Bridge lock poisoned")?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "Not connected to a desktop companion".to_string())?;
        conn.tx
            .send(BridgeFrame::Cancel { id: id.to_string() })
            .map_err(|_| "Companion connection closed".to_string())
    }
}

fn is_fatal_bridge_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("older pairing")
        || lower.contains("not paired")
        || lower.contains("bridge is disabled on desktop")
        || lower.contains("identity mismatch")
        || lower.contains("trusted desktop peer not found")
        || lower.contains("trusted peer not found")
}

/// Happy-Eyeballs route dialer:
/// - Always tries LAN routes immediately (same Wi-Fi wins in ~5-40ms).
/// - If LAN doesn't answer within `LAN_HEAD_START` (600ms) or fails fast, races Tailscale /
///   Custom routes in parallel so cross-network switches happen invisibly in <1s.
fn dial_best_route(
    candidates: &[PeerRoute],
    sync_key: [u8; 32],
    expected_device_id: &str,
) -> Result<DialSuccess, String> {
    if candidates.len() == 1 {
        let route = &candidates[0];
        return dial_and_upgrade(route, &sync_key, expected_device_id)
            .map_err(|err| format!("{}:{} ({}) — {err}", route.host, route.port, route.kind));
    }

    let (lan_routes, fallback_routes): (Vec<PeerRoute>, Vec<PeerRoute>) =
        candidates.iter().cloned().partition(|r| r.kind == "lan");

    let (tx, rx) = mpsc::channel::<Result<DialSuccess, String>>();
    let won = Arc::new(AtomicBool::new(false));
    let mut in_flight = 0usize;

    let spawn_batch = |batch: Vec<PeerRoute>,
                       tx: &mpsc::Sender<Result<DialSuccess, String>>,
                       won: &Arc<AtomicBool>|
     -> usize {
        let count = batch.len();
        for route in batch {
            let tx = tx.clone();
            let won = Arc::clone(won);
            let expected = expected_device_id.to_string();
            thread::spawn(move || {
                let res = dial_and_upgrade(&route, &sync_key, &expected).map_err(|err| {
                    format!("{}:{} ({}) — {err}", route.host, route.port, route.kind)
                });
                match res {
                    Ok(ok) => {
                        if won.swap(true, Ordering::AcqRel) {
                            let _ = ok.1.shutdown(Shutdown::Both);
                        } else {
                            let _ = tx.send(Ok(ok));
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(Err(err));
                    }
                }
            });
        }
        count
    };

    let mut last_err = String::new();

    if !lan_routes.is_empty() {
        in_flight += spawn_batch(lan_routes, &tx, &won);
        // Wait up to LAN_HEAD_START for a LAN route to win before racing Tailscale/Custom.
        let deadline = std::time::Instant::now() + LAN_HEAD_START;
        while in_flight > 0 {
            let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
                break;
            };
            match rx.recv_timeout(remaining) {
                Ok(Ok(ok)) => return Ok(ok),
                Ok(Err(err)) => {
                    in_flight -= 1;
                    last_err = err;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    if !fallback_routes.is_empty() {
        in_flight += spawn_batch(fallback_routes, &tx, &won);
    }

    while in_flight > 0 {
        match rx.recv() {
            Ok(Ok(ok)) => return Ok(ok),
            Ok(Err(err)) => {
                in_flight -= 1;
                last_err = err;
            }
            Err(_) => break,
        }
    }

    Err(if last_err.is_empty() {
        "Unable to reach desktop on any route".to_string()
    } else {
        last_err
    })
}

fn dial_and_upgrade(
    route: &PeerRoute,
    sync_key: &[u8; 32],
    expected_device_id: &str,
) -> Result<DialSuccess, String> {
    let stream = connect_tcp_route(route)?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);

    // 1. Challenge handshake (`sync_hello`).
    let hello = serde_json::json!({ "method": HELLO_METHOD });
    writeln!(writer, "{hello}").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    let hello_resp = parse_response(read_limited_line(&mut reader, MAX_PLAIN_LINE_BYTES)?.trim())?;
    let challenge = hello_resp
        .get("challenge")
        .and_then(|v| v.as_str())
        .ok_or("Missing challenge in response")?
        .to_string();

    // 2. Encrypted `bridge_open` request.
    let client_nonce = random_token();
    let req = serde_json::json!({
        "method": BRIDGE_UPGRADE_METHOD,
        "params": {},
        "challenge": challenge,
        "client_nonce": client_nonce,
    });
    let encrypted = encrypt_message(sync_key, req.to_string().as_bytes())?;
    writeln!(writer, "{encrypted}").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;

    // 3. Verify encrypted ACK + server identity (`deviceId == expected_device_id`).
    let ack_line = read_limited_line(&mut reader, MAX_ENCRYPTED_LINE_BYTES)?;
    let decrypted =
        decrypt_message(sync_key, ack_line.trim()).map_err(|_| REPAIR_REQUIRED.to_string())?;
    let resp: serde_json::Value =
        serde_json::from_slice(&decrypted).map_err(|e| format!("Parse ACK failed: {e}"))?;
    if resp.get(CLIENT_NONCE_FIELD).and_then(|v| v.as_str()) != Some(client_nonce.as_str()) {
        return Err("Bridge ACK nonce mismatch".to_string());
    }
    let data = unwrap_response(&resp)?;
    let remote_id = data.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
    if remote_id != expected_device_id {
        return Err(format!(
            "Desktop identity mismatch: expected {expected_device_id}, got {remote_id}"
        ));
    }
    let remote_name = data
        .get("deviceName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 4. Derive directional HKDF session ciphers.
    let ciphers = derive_session_ciphers(sync_key, &challenge, &client_nonce, Role::Client)?;
    Ok((route.clone(), writer, reader, ciphers, remote_name))
}
