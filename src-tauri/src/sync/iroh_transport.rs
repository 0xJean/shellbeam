//! Built-in pure-Rust `iroh` P2P hole-punching + encrypted relay transport.
//!
//! Runs completely in user-space QUIC (no OS VPN slot, zero conflict with Clash/Surge/Shadowrocket,
//! zero external app or account signup required). Bridges incoming and outgoing `iroh` QUIC
//! bidirectional streams transparently onto local loopback `TcpStream`s so pairing, sync, and
//! Companion Bridge reuse the exact same encrypted protocols without modification.

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

use super::PeerRoute;

const ALPN: &[u8] = b"shellbeam/sync/1";
const IROH_KEY_FILENAME: &str = "iroh_node.key";

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("shellbeam-iroh")
        .build()
        .expect("build iroh tokio runtime")
});

#[derive(Default)]
struct ServerRuntimeState {
    endpoint_id: Option<String>,
    relay_url: Option<String>,
    endpoint: Option<Endpoint>,
    generation: u64,
}

static SERVER_STATE: LazyLock<Mutex<ServerRuntimeState>> =
    LazyLock::new(|| Mutex::new(ServerRuntimeState::default()));

static CLIENT_ENDPOINT: LazyLock<tokio::sync::Mutex<Option<Endpoint>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

static CUSTOM_RELAY_URL: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

pub fn get_custom_relay_url() -> Option<String> {
    CUSTOM_RELAY_URL.lock().ok().and_then(|g| g.clone())
}

#[allow(dead_code)]
pub fn set_custom_relay_url(url: Option<String>) -> Result<Option<String>, String> {
    let cleaned = url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(ref u) = cleaned {
        u.parse::<RelayUrl>()
            .map_err(|e| format!("Invalid relay URL: {e}"))?;
    }
    if let Ok(mut guard) = CUSTOM_RELAY_URL.lock() {
        *guard = cleaned.clone();
    }
    // Drop cached client endpoint so next dial uses the new relay map.
    RUNTIME.spawn(async {
        let mut guard = CLIENT_ENDPOINT.lock().await;
        if let Some(ep) = guard.take() {
            ep.close().await;
        }
    });
    Ok(cleaned)
}

fn active_relay_mode(override_url: Option<&str>) -> RelayMode {
    if let Some(raw) = override_url {
        if let Ok(url) = raw.trim().parse::<RelayUrl>() {
            return RelayMode::custom([url]);
        }
    }
    if let Some(raw) = get_custom_relay_url() {
        if let Ok(url) = raw.parse::<RelayUrl>() {
            return RelayMode::custom([url]);
        }
    }
    RelayMode::Default
}

fn key_file_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(IROH_KEY_FILENAME))
}

fn load_or_create_secret_key(app: &tauri::AppHandle) -> SecretKey {
    if let Some(path) = key_file_path(app) {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return SecretKey::from_bytes(&arr);
            }
        }
        let key = SecretKey::generate();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::write(&path, key.to_bytes()).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
        return key;
    }
    SecretKey::generate()
}

/// Start the embedded `iroh` listener and forward incoming QUIC bidi streams to the local
/// sync/companion TCP listener on `127.0.0.1:<tcp_port>`.
pub fn start_iroh_server(app: tauri::AppHandle, tcp_port: u16) {
    let secret_key = load_or_create_secret_key(&app);
    let my_gen = {
        let mut guard = SERVER_STATE.lock().unwrap_or_else(|e| e.into_inner());
        guard.generation = guard.generation.wrapping_add(1);
        if let Some(old) = guard.endpoint.take() {
            RUNTIME.spawn(async move {
                old.close().await;
            });
        }
        guard.endpoint_id = Some(secret_key.public().to_string());
        guard.relay_url = None;
        guard.generation
    };

    let relay_mode = active_relay_mode(None);
    RUNTIME.spawn(async move {
        let ep = match Endpoint::builder(presets::Minimal)
            .secret_key(secret_key)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(relay_mode)
            .bind()
            .await
        {
            Ok(ep) => ep,
            Err(err) => {
                log::warn!("[iroh] failed to bind endpoint: {err}");
                return;
            }
        };

        let id_str = ep.id().to_string();
        log::info!("[iroh] server bound: id={id_str}");
        let stale = {
            let mut guard = SERVER_STATE.lock().unwrap_or_else(|e| e.into_inner());
            if guard.generation != my_gen {
                true
            } else {
                guard.endpoint_id = Some(id_str.clone());
                guard.endpoint = Some(ep.clone());
                false
            }
        };
        if stale {
            ep.close().await;
            return;
        }

        // Wait briefly in a side task for home relay registration so QR codes get the exact RelayUrl.
        let ep_online = ep.clone();
        let app_online = app.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(8), ep_online.online()).await;
            let relay_str = ep_online.addr().relay_urls().next().map(|u| u.to_string());
            log::info!(
                "[iroh] server online: id={} relay={:?}",
                ep_online.id(),
                relay_str
            );
            {
                let mut guard = SERVER_STATE.lock().unwrap_or_else(|e| e.into_inner());
                if guard.generation == my_gen {
                    guard.relay_url = relay_str;
                }
            }
            let _ = app_online.emit("companion:endpoints-changed", ());
        });

        while let Some(incoming) = ep.accept().await {
            tokio::spawn(async move {
                let conn = match incoming.await {
                    Ok(c) => c,
                    Err(err) => {
                        log::debug!("[iroh] incoming accept failed: {err}");
                        return;
                    }
                };
                loop {
                    let (mut send, mut recv) = match conn.accept_bi().await {
                        Ok(streams) => streams,
                        Err(_) => break,
                    };
                    tokio::spawn(async move {
                        let Ok(tcp) = tokio::net::TcpStream::connect(("127.0.0.1", tcp_port)).await
                        else {
                            return;
                        };
                        let _ = tcp.set_nodelay(true);
                        let (mut tcp_r, mut tcp_w) = tcp.into_split();
                        let c2s = async {
                            let _ = tokio::io::copy(&mut recv, &mut tcp_w).await;
                            let _ = tokio::io::AsyncWriteExt::shutdown(&mut tcp_w).await;
                        };
                        let s2c = async {
                            let _ = tokio::io::copy(&mut tcp_r, &mut send).await;
                            let _ = send.finish();
                        };
                        tokio::join!(c2s, s2c);
                    });
                }
            });
        }
    });
}

pub fn stop_iroh_server() {
    let old = {
        let mut guard = SERVER_STATE.lock().unwrap_or_else(|e| e.into_inner());
        guard.generation = guard.generation.wrapping_add(1);
        guard.endpoint_id = None;
        guard.relay_url = None;
        guard.endpoint.take()
    };
    if let Some(ep) = old {
        RUNTIME.spawn(async move {
            ep.close().await;
        });
    }
}

/// Returns the desktop's active `iroh` route (with its home `RelayUrl` in `label`) when ready.
pub fn current_iroh_route() -> Option<PeerRoute> {
    let guard = SERVER_STATE.lock().ok()?;
    let id = guard.endpoint_id.clone()?;
    let relay = guard.relay_url.clone().or_else(|| {
        guard
            .endpoint
            .as_ref()
            .and_then(|ep| ep.addr().relay_urls().next().map(|u| u.to_string()))
    });
    Some(PeerRoute {
        kind: "iroh".to_string(),
        host: id,
        port: 1,
        label: relay,
        last_ok_at: None,
    })
}

/// Returns true if `s` is a valid 64-char hex iroh `EndpointId` (32-byte Ed25519 public key).
pub fn is_iroh_endpoint_id(s: &str) -> bool {
    let trimmed = s.trim();
    trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parse `iroh://<endpoint_id>[?relay=<encoded_url>][:port]` or a bare 64-char hex EndpointId.
pub fn parse_iroh_spec(raw: &str) -> Option<(String, Option<String>)> {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("iroh://") {
        // Strip optional trailing `:port` appended by `format!("{host}:{port}")`.
        let rest_no_port = if let Some(q_idx) = rest.find('?') {
            let (before_q, after_q) = rest.split_at(q_idx);
            let after_clean = strip_trailing_numeric_port(after_q);
            format!("{before_q}{after_clean}")
        } else {
            strip_trailing_numeric_port(rest).to_string()
        };
        let (id_part, query_part) = match rest_no_port.split_once('?') {
            Some((id, q)) => (id.trim_end_matches('/'), Some(q)),
            None => (rest_no_port.trim_end_matches('/'), None),
        };
        if !is_iroh_endpoint_id(id_part) {
            return None;
        }
        let relay = query_part.and_then(|q| {
            q.split('&').find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                if k == "relay" && !v.is_empty() {
                    urlencoding::decode(v).ok().map(|s| s.into_owned())
                } else {
                    None
                }
            })
        });
        return Some((id_part.to_string(), relay));
    }
    let bare = strip_trailing_numeric_port(trimmed);
    if is_iroh_endpoint_id(bare) {
        return Some((bare.to_string(), None));
    }
    None
}

fn strip_trailing_numeric_port(s: &str) -> &str {
    if let Some((prefix, suffix)) = s.rsplit_once(':') {
        if !suffix.is_empty()
            && suffix.len() <= 5
            && suffix.bytes().all(|b| b.is_ascii_digit())
            && !prefix.ends_with("http")
            && !prefix.ends_with("https")
        {
            return prefix;
        }
    }
    s
}

async fn get_or_init_client_endpoint() -> Result<Endpoint, String> {
    let mut guard = CLIENT_ENDPOINT.lock().await;
    if let Some(ep) = guard.as_ref() {
        return Ok(ep.clone());
    }
    let ep = Endpoint::builder(presets::Minimal)
        .relay_mode(active_relay_mode(None))
        .bind()
        .await
        .map_err(|e| format!("iroh client bind failed: {e}"))?;
    *guard = Some(ep.clone());
    Ok(ep)
}

/// Dial a remote ShellBeam device over `iroh` (relay-assisted + automatic UDP NAT hole-punching)
/// and expose the QUIC bidirectional stream as a standard local loopback `TcpStream`.
pub fn connect_iroh_route(
    endpoint_id_str: &str,
    relay_url: Option<&str>,
    timeout: Duration,
) -> Result<TcpStream, String> {
    let endpoint_id: EndpointId = endpoint_id_str
        .trim()
        .parse()
        .map_err(|e| format!("Invalid iroh endpoint id: {e}"))?;

    let mut addr = EndpointAddr::new(endpoint_id);
    let mut custom_relay_override: Option<String> = None;

    if let Some(raw_relay) = relay_url.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(parsed_url) = raw_relay.parse::<RelayUrl>() {
            let default_urls: Vec<RelayUrl> = RelayMode::Default.relay_map().urls();
            let in_default = default_urls.iter().any(|u| u == &parsed_url);
            if !in_default {
                custom_relay_override = Some(raw_relay.to_string());
            }
            addr = addr.with_relay_url(parsed_url);
        }
    } else {
        let default_urls: Vec<RelayUrl> = active_relay_mode(None).relay_map().urls();
        for url in default_urls {
            addr = addr.with_relay_url(url);
        }
    }

    let (send, recv, owned_ep) = RUNTIME.block_on(async move {
        let (ep, owned) = if let Some(custom) = custom_relay_override {
            let ep = Endpoint::builder(presets::Minimal)
                .relay_mode(active_relay_mode(Some(&custom)))
                .bind()
                .await
                .map_err(|e| format!("iroh custom-relay bind failed: {e}"))?;
            (ep, Some(true))
        } else {
            (get_or_init_client_endpoint().await?, None)
        };

        let conn = tokio::time::timeout(timeout, ep.connect(addr, ALPN))
            .await
            .map_err(|_| format!("Connect iroh://{endpoint_id_str} timed out"))?
            .map_err(|e| format!("Connect iroh://{endpoint_id_str} failed: {e}"))?;

        let (send, recv) = tokio::time::timeout(Duration::from_secs(5), conn.open_bi())
            .await
            .map_err(|_| "iroh open stream timed out".to_string())?
            .map_err(|e| format!("iroh open stream failed: {e}"))?;

        Ok::<_, String>((send, recv, if owned.is_some() { Some(ep) } else { None }))
    })?;

    // Bridge the QUIC bidi stream onto an ephemeral local loopback TCP socket pair.
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("iroh loopback bind failed: {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("iroh loopback addr failed: {e}"))?;
    let client_stream =
        TcpStream::connect(local_addr).map_err(|e| format!("iroh loopback connect failed: {e}"))?;
    let _ = client_stream.set_nodelay(true);
    let (bridge_std, _) = listener
        .accept()
        .map_err(|e| format!("iroh loopback accept failed: {e}"))?;
    let _ = bridge_std.set_nodelay(true);
    bridge_std
        .set_nonblocking(true)
        .map_err(|e| format!("iroh loopback nonblocking failed: {e}"))?;

    RUNTIME.spawn(async move {
        let Ok(bridge_tcp) = tokio::net::TcpStream::from_std(bridge_std) else {
            if let Some(ep) = owned_ep {
                ep.close().await;
            }
            return;
        };
        let (mut tcp_r, mut tcp_w) = bridge_tcp.into_split();
        let mut send = send;
        let mut recv = recv;
        let up = async {
            let _ = tokio::io::copy(&mut tcp_r, &mut send).await;
            let _ = send.finish();
        };
        let down = async {
            let _ = tokio::io::copy(&mut recv, &mut tcp_w).await;
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut tcp_w).await;
        };
        tokio::join!(up, down);
        if let Some(ep) = owned_ep {
            ep.close().await;
        }
    });

    Ok(client_stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iroh_spec_variants_with_and_without_relay_and_port() {
        let id = "a".repeat(64);
        assert_eq!(parse_iroh_spec(&id), Some((id.clone(), None)));
        assert_eq!(
            parse_iroh_spec(&format!("iroh://{id}")),
            Some((id.clone(), None))
        );
        assert_eq!(
            parse_iroh_spec(&format!("iroh://{id}:9123")),
            Some((id.clone(), None))
        );
        let relay = "https://aps1-1.relay.n0.iroh-canary.iroh.link./";
        let encoded = urlencoding::encode(relay);
        assert_eq!(
            parse_iroh_spec(&format!("iroh://{id}?relay={encoded}:1")),
            Some((id.clone(), Some(relay.to_string())))
        );
        assert_eq!(parse_iroh_spec("192.168.3.35:9123"), None);
    }
}
