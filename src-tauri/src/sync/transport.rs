//! A2-2: Minimal LAN P2P sync transport.
//! TCP server accepts connections; client connects to peer endpoint.
//! Protocol: newline-delimited JSON request/response with AES-256-GCM encryption.
//! Request handling logic is in transport_handler.rs.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use mdns_sd::ServiceDaemon;
use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use super::transport_handler::SyncResponse;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

pub(crate) fn encrypt_message(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("encrypt: {e}"))?;
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(&out))
}

pub(crate) fn decrypt_message(key: &[u8; 32], encoded: &str) -> Result<Vec<u8>, String> {
    let data = B64
        .decode(encoded.trim())
        .map_err(|e| format!("b64 decode: {e}"))?;
    if data.len() < 12 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt: {e}"))
}

pub(crate) fn parse_sync_secret(secret: &Option<String>) -> Option<[u8; 32]> {
    secret.as_ref().and_then(|s| {
        B64.decode(s).ok().and_then(|v| {
            if v.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&v);
                Some(arr)
            } else {
                None
            }
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
pub(crate) struct SyncRequestRaw {
    pub method: String,
    pub params: Option<serde_json::Value>,
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

    let (json_str, enc_key) = if let Ok(_req) = serde_json::from_str::<SyncRequestRaw>(line.trim())
    {
        (line.trim().to_string(), None)
    } else if let Some((decrypted, key)) = try_decrypt_with_any_peer(&app, line.trim()) {
        (decrypted, Some(key))
    } else {
        (line.trim().to_string(), None)
    };

    let req: SyncRequestRaw = match serde_json::from_str(&json_str) {
        Ok(r) => r,
        Err(e) => {
            let resp = SyncResponse::Err {
                error: format!("Parse request failed: {e}"),
            };
            let _ = writeln!(
                writer,
                "{}",
                serde_json::to_string(&resp).unwrap_or_default()
            );
            return;
        }
    };
    let result =
        super::transport_handler::handle_request(&app, &req.method, req.params, remote_addr);
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
    let addr: std::net::SocketAddr = endpoint
        .parse()
        .map_err(|e| format!("Invalid endpoint {endpoint}: {e}"))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("Connect to {endpoint} failed: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(READ_TIMEOUT_SECS)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(WRITE_TIMEOUT_SECS)))
        .ok();
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
    let is_ok = resp
        .get("ok")
        .map(|v| v.as_bool() == Some(true) || v.as_str() == Some("true"))
        .unwrap_or(false);
    if is_ok {
        resp.get("data")
            .cloned()
            .ok_or_else(|| "Missing data in response".to_string())
    } else {
        let err = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        Err(err.to_string())
    }
}
