//! A2-2: Minimal LAN P2P sync transport.
//! TCP server accepts connections; client connects to peer endpoint.
//! Protocol: newline-delimited JSON. Pairing is plaintext; all other requests use
//! AES-256-GCM with the key derived during pairing (see pairing_crypto.rs).
//! Request handling logic is in transport_handler.rs.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use mdns_sd::ServiceDaemon;
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
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
const MAX_PLAIN_LINE_BYTES: u64 = 64 * 1024;
const MAX_ENCRYPTED_LINE_BYTES: u64 = 64 * 1024 * 1024;
const HELLO_METHOD: &str = "sync_hello";
const CLIENT_NONCE_FIELD: &str = "client_nonce";
const PAIRING_METHODS: [&str; 3] = ["pair_request", "pair_reveal", "pair_check"];
pub(crate) const REPAIR_REQUIRED: &str =
    "This device is not paired or is using an older pairing. Update both devices and pair them again.";

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

#[derive(Debug, Deserialize)]
struct EncryptedRequest {
    method: String,
    params: Option<serde_json::Value>,
    challenge: String,
    client_nonce: String,
}

/// Unauthenticated connections may only pair. Everything else must go through
/// `HELLO_METHOD` and an encrypted request that echoes the server's challenge, so
/// a captured request cannot be replayed or reflected back at its sender.
pub(crate) enum InboundRequest {
    Pairing {
        method: String,
        params: Option<serde_json::Value>,
    },
    Peer {
        peer_device_id: String,
        method: String,
        params: Option<serde_json::Value>,
    },
}

fn read_limited_line<R: BufRead>(reader: &mut R, max: u64) -> Result<String, String> {
    let mut line = String::new();
    reader
        .by_ref()
        .take(max)
        .read_line(&mut line)
        .map_err(|e| format!("read: {e}"))?;
    if line.is_empty() {
        return Err("Connection closed".to_string());
    }
    if !line.ends_with('\n') && line.len() as u64 >= max {
        return Err("Message too large".to_string());
    }
    Ok(line)
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    B64.encode(bytes)
}

fn response_value(result: Result<serde_json::Value, String>) -> serde_json::Value {
    let resp = match result {
        Ok(data) => SyncResponse::Ok { data },
        Err(error) => SyncResponse::Err { error },
    };
    serde_json::to_value(&resp).unwrap_or_default()
}

fn write_plain(writer: &mut TcpStream, result: Result<serde_json::Value, String>) {
    let _ = writeln!(writer, "{}", response_value(result));
}

fn trusted_peer_keys(app: &tauri::AppHandle) -> Vec<(String, [u8; 32])> {
    let Ok(state) = super::load_sync_state_for_transport(app) else {
        return Vec::new();
    };
    state
        .trusted_peers
        .iter()
        .filter_map(|peer| {
            Some((
                peer.peer_device_id.clone(),
                parse_sync_secret(&peer.sync_secret)?,
            ))
        })
        .collect()
}

pub(crate) fn serve_connection(app: tauri::AppHandle, stream: TcpStream) {
    let remote_addr = stream.peer_addr().ok();
    serve_stream(
        stream,
        || trusted_peer_keys(&app),
        |request| match request {
            InboundRequest::Pairing { method, params } => {
                super::peer_pairing::handle_pairing_request(&app, &method, params, remote_addr)
            }
            InboundRequest::Peer {
                peer_device_id,
                method,
                params,
            } => super::transport_handler::handle_request(&app, &method, params, &peer_device_id),
        },
    );
}

fn serve_stream<K, H>(stream: TcpStream, peer_keys: K, handle: H)
where
    K: Fn() -> Vec<(String, [u8; 32])>,
    H: Fn(InboundRequest) -> Result<serde_json::Value, String>,
{
    let _ = stream.set_read_timeout(Some(Duration::from_secs(READ_TIMEOUT_SECS)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(WRITE_TIMEOUT_SECS)));
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(_) => return,
    };
    let mut writer = stream;
    let Ok(line) = read_limited_line(&mut reader, MAX_PLAIN_LINE_BYTES) else {
        return;
    };
    let req: SyncRequestRaw = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(_) => return write_plain(&mut writer, Err(REPAIR_REQUIRED.to_string())),
    };
    if PAIRING_METHODS.contains(&req.method.as_str()) {
        let result = handle(InboundRequest::Pairing {
            method: req.method,
            params: req.params,
        });
        return write_plain(&mut writer, result);
    }
    if req.method != HELLO_METHOD {
        return write_plain(&mut writer, Err(REPAIR_REQUIRED.to_string()));
    }

    let challenge = random_token();
    write_plain(
        &mut writer,
        Ok(serde_json::json!({ "challenge": challenge })),
    );
    let Ok(line) = read_limited_line(&mut reader, MAX_ENCRYPTED_LINE_BYTES) else {
        return;
    };
    let decrypted = peer_keys().into_iter().find_map(|(peer_device_id, key)| {
        let plaintext = decrypt_message(&key, line.trim()).ok()?;
        Some((peer_device_id, key, plaintext))
    });
    let Some((peer_device_id, key, plaintext)) = decrypted else {
        return write_plain(&mut writer, Err(REPAIR_REQUIRED.to_string()));
    };
    let req: EncryptedRequest = match serde_json::from_slice(&plaintext) {
        Ok(r) => r,
        Err(e) => return write_plain(&mut writer, Err(format!("Parse request failed: {e}"))),
    };
    if req.challenge != challenge {
        return write_plain(&mut writer, Err("Invalid request challenge".to_string()));
    }
    let mut resp = response_value(handle(InboundRequest::Peer {
        peer_device_id,
        method: req.method,
        params: req.params,
    }));
    resp[CLIENT_NONCE_FIELD] = serde_json::Value::String(req.client_nonce);
    if let Ok(encrypted) = encrypt_message(&key, resp.to_string().as_bytes()) {
        let _ = writeln!(writer, "{encrypted}");
    }
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

fn connect_peer(endpoint: &str) -> Result<TcpStream, String> {
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
    Ok(stream)
}

fn parse_response(resp_str: &str) -> Result<serde_json::Value, String> {
    let resp: serde_json::Value =
        serde_json::from_str(resp_str).map_err(|e| format!("Parse response failed: {e}"))?;
    unwrap_response(&resp)
}

fn unwrap_response(resp: &serde_json::Value) -> Result<serde_json::Value, String> {
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

/// One unencrypted request. Only the pairing exchange uses this, and its values
/// are authenticated afterwards by the code the users compare.
pub(crate) fn sync_request_pairing(
    endpoint: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let stream = connect_peer(endpoint)?;
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    let req = serde_json::json!({ "method": method, "params": params });
    writeln!(writer, "{req}").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    parse_response(read_limited_line(&mut reader, MAX_PLAIN_LINE_BYTES)?.trim())
}

/// A request to a trusted peer. There is no plaintext fallback: a peer without a
/// key has to be paired again.
pub fn sync_request_peer_encrypted(
    endpoint: &str,
    method: &str,
    params: serde_json::Value,
    secret: Option<&[u8; 32]>,
) -> Result<serde_json::Value, String> {
    let key = secret.ok_or_else(|| REPAIR_REQUIRED.to_string())?;
    let stream = connect_peer(endpoint)?;
    if method == "get_full_backup"
        && params.get("includeVault").and_then(|v| v.as_bool()) == Some(true)
    {
        // The other device waits for a person to answer before it replies.
        let wait = super::vault_approval::APPROVAL_TIMEOUT + Duration::from_secs(READ_TIMEOUT_SECS);
        stream.set_read_timeout(Some(wait)).ok();
    }
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);

    let hello = serde_json::json!({ "method": HELLO_METHOD });
    writeln!(writer, "{hello}").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    let hello_resp = parse_response(read_limited_line(&mut reader, MAX_PLAIN_LINE_BYTES)?.trim())?;
    let challenge = hello_resp
        .get("challenge")
        .and_then(|v| v.as_str())
        .ok_or("Missing challenge in response")?;

    let client_nonce = random_token();
    let req = serde_json::json!({
        "method": method,
        "params": params,
        "challenge": challenge,
        "client_nonce": client_nonce,
    });
    let encrypted = encrypt_message(key, req.to_string().as_bytes())?;
    writeln!(writer, "{encrypted}").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;

    let line = read_limited_line(&mut reader, MAX_ENCRYPTED_LINE_BYTES)?;
    // A rejected request gets a plaintext error, which proves nothing about the peer.
    let decrypted = decrypt_message(key, line.trim()).map_err(|_| REPAIR_REQUIRED.to_string())?;
    let resp: serde_json::Value =
        serde_json::from_slice(&decrypted).map_err(|e| format!("Parse response failed: {e}"))?;
    if resp.get(CLIENT_NONCE_FIELD).and_then(|v| v.as_str()) != Some(client_nonce.as_str()) {
        return Err("Response does not match the request".to_string());
    }
    unwrap_response(&resp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const KEY: [u8; 32] = [7u8; 32];

    fn start_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        thread::spawn(move || {
            for stream in listener.incoming() {
                serve_stream(
                    stream.unwrap(),
                    || vec![("peer-1".to_string(), KEY)],
                    |request| match request {
                        InboundRequest::Pairing { method, .. } => {
                            Ok(serde_json::json!({ "pairing": method }))
                        }
                        InboundRequest::Peer {
                            peer_device_id,
                            method,
                            ..
                        } => Ok(serde_json::json!({ "peer": peer_device_id, "method": method })),
                    },
                );
            }
        });
        endpoint
    }

    fn exchange(endpoint: &str, lines: &[&str]) -> String {
        let stream = connect_peer(endpoint).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut last = String::new();
        for line in lines {
            writeln!(writer, "{line}").unwrap();
            last.clear();
            reader.read_line(&mut last).unwrap();
        }
        last
    }

    #[test]
    fn a_trusted_peer_is_identified_by_its_key() {
        let endpoint = start_server();
        let data = sync_request_peer_encrypted(
            &endpoint,
            "get_full_backup",
            serde_json::json!({}),
            Some(&KEY),
        )
        .unwrap();
        assert_eq!(data["peer"], "peer-1");
        assert_eq!(data["method"], "get_full_backup");
    }

    #[test]
    fn plaintext_requests_are_refused_except_for_pairing() {
        let endpoint = start_server();
        for method in [
            "get_full_backup",
            "push_full_backup",
            "get_bootstrap",
            "notify_pull",
            "claim_pending_push",
            "pair_confirm",
        ] {
            let resp = exchange(&endpoint, &[&format!(r#"{{"method":"{method}"}}"#)]);
            assert!(resp.contains(REPAIR_REQUIRED), "{method}: {resp}");
        }
        let data = sync_request_pairing(&endpoint, "pair_request", serde_json::json!({})).unwrap();
        assert_eq!(data["pairing"], "pair_request");
    }

    #[test]
    fn a_wrong_key_is_refused() {
        let endpoint = start_server();
        let err = sync_request_peer_encrypted(
            &endpoint,
            "get_full_backup",
            serde_json::json!({}),
            Some(&[9u8; 32]),
        )
        .unwrap_err();
        assert_eq!(err, REPAIR_REQUIRED);
    }

    #[test]
    fn a_missing_key_never_falls_back_to_plaintext() {
        let err = sync_request_peer_encrypted(
            "127.0.0.1:1",
            "get_full_backup",
            serde_json::json!({}),
            None,
        )
        .unwrap_err();
        assert_eq!(err, REPAIR_REQUIRED);
    }

    #[test]
    fn a_captured_request_cannot_be_replayed() {
        let endpoint = start_server();
        let captured = encrypt_message(
            &KEY,
            serde_json::json!({
                "method": "get_full_backup",
                "challenge": "captured-challenge",
                "client_nonce": "nonce",
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        let resp = exchange(&endpoint, &[r#"{"method":"sync_hello"}"#, &captured]);
        assert!(resp.contains("Invalid request challenge"), "{resp}");
    }

    #[test]
    fn an_encrypted_line_without_a_challenge_is_refused() {
        let endpoint = start_server();
        let legacy = encrypt_message(&KEY, br#"{"method":"get_full_backup"}"#).unwrap();
        let resp = exchange(&endpoint, &[&legacy]);
        assert!(resp.contains(REPAIR_REQUIRED), "{resp}");
    }

    #[test]
    fn an_oversized_line_is_refused() {
        let mut reader = BufReader::new(&b"0123456789"[..]);
        assert!(read_limited_line(&mut reader, 4).is_err());
    }
}
