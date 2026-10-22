//! One verified route for terminal, commands, SFTP, forwarding and MCP.
//! Credentials stay in memory. A jump opens direct-tcpip after its own host
//! key has been verified, then the target performs an independent handshake.
use ssh2::{Channel, Session};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::Manager;

use crate::data::hosts::{load_hosts, HostProfile};
use crate::vault::secrets::{get_secret_value, VaultState};

#[derive(Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub secret: String,
    pub passphrase: Option<String>,
}

#[derive(Clone)]
pub struct Route {
    pub target: Endpoint,
    pub jump: Option<Endpoint>,
}

pub struct TunnelLease {
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Drop for TunnelLease {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedHostKey {
    pub stage: String,
    pub host: String,
    pub port: u16,
    pub fingerprint_sha256: String,
    pub key_type: String,
}
fn verified_key(session: &Session, endpoint: &Endpoint, stage: &str) -> VerifiedHostKey {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (bytes, kind) = session
        .host_key()
        .expect("verified SSH handshake has a host key");
    VerifiedHostKey {
        stage: stage.into(),
        host: endpoint.host.clone(),
        port: endpoint.port,
        fingerprint_sha256: base64::engine::general_purpose::STANDARD.encode(Sha256::digest(bytes)),
        key_type: format!("{kind:?}"),
    }
}

pub struct Connection {
    pub verified_host_keys: Vec<VerifiedHostKey>,
    pub session: Session,
    pub tunnel: Option<Arc<TunnelLease>>,
}

/// Recheck after a potentially slow handshake and before sending an action.
pub fn ensure_vault_unlocked(app: &tauri::AppHandle, vault_id: Option<&str>) -> Result<(), String> {
    if vault_id.is_some_and(|id| !app.state::<VaultState>().is_unlocked(id)) {
        return Err("VAULT_LOCKED".into());
    }
    Ok(())
}

fn endpoint_for(
    app: &tauri::AppHandle,
    vault_id: &str,
    host: &HostProfile,
) -> Result<Endpoint, String> {
    if !crate::data::host_connections::supports_ssh(host) {
        return Err("HOST_CONNECTION_REQUIRED".into());
    }
    let state = app.state::<VaultState>();
    if !state.is_unlocked(vault_id) {
        return Err("VAULT_LOCKED".into());
    }
    let key = match host.auth_type.as_str() {
        "password" => host.password_key_ref.as_deref(),
        "privateKey" => host.private_key_ref.as_deref(),
        _ => return Err("UNSUPPORTED_AUTH_TYPE".into()),
    }
    .filter(|key| !key.trim().is_empty())
    .or(host.secret_key_ref.as_deref())
    .ok_or("MISSING_CREDENTIAL")?;
    let secret = get_secret_value(app, &state, vault_id, key)?.ok_or("MISSING_CREDENTIAL")?;
    Ok(Endpoint {
        host: host.address.clone(),
        port: host.port,
        username: host.username.clone(),
        auth_type: host.auth_type.clone(),
        secret,
        passphrase: None,
    })
}

/// References are resolved inside the selected vault; missing/ambiguous hosts
/// fail closed rather than reusing a credential from another vault.
pub fn resolve_host_route(
    app: &tauri::AppHandle,
    vault_id: &str,
    host_id: &str,
) -> Result<Route, String> {
    resolve_host_route_with_identity(app, vault_id, host_id).map(|(route, _)| route)
}

pub fn resolve_host_route_with_identity(
    app: &tauri::AppHandle,
    vault_id: &str,
    host_id: &str,
) -> Result<(Route, serde_json::Value), String> {
    let hosts = load_hosts(app, Some(vault_id))?;
    let host = hosts
        .iter()
        .find(|host| host.id == host_id)
        .ok_or("HOST_NOT_FOUND")?;
    let route = route_for_host(app, vault_id, host, &hosts)?;
    let identity = route_identity(&route, &host.id, host.jump_host_id.as_deref());
    Ok((route, identity))
}

/// Safe metadata from the endpoints actually selected by the native resolver.
/// Never serialize Endpoint itself: it also holds in-memory credentials.
pub fn route_identity(
    route: &Route,
    host_id: &str,
    jump_host_id: Option<&str>,
) -> serde_json::Value {
    let mut identity = serde_json::json!({"hostId":host_id,"address":route.target.host,"port":route.target.port,"username":route.target.username});
    if let Some(jump) = &route.jump {
        identity["jump"] =
            serde_json::json!({"address":jump.host,"port":jump.port,"username":jump.username});
        if let Some(id) = jump_host_id {
            identity["jump"]["hostId"] = id.into();
        }
    }
    identity
}

pub fn route_for_host(
    app: &tauri::AppHandle,
    vault_id: &str,
    host: &HostProfile,
    hosts: &[HostProfile],
) -> Result<Route, String> {
    let target = endpoint_for(app, vault_id, host).map_err(|error| {
        if error.contains("VAULT") {
            error
        } else {
            failure("target", "credential_unavailable", error)
        }
    })?;
    let jump = if let Some(id) = host
        .jump_host_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    {
        let jump_host = hosts
            .iter()
            .find(|candidate| candidate.id == id)
            .ok_or("JUMP_HOST_NOT_FOUND")?;
        if jump_host.id == host.id
            || jump_host.jump_host_id.is_some()
            || jump_host
                .jump_host
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            return Err("JUMP_CHAIN_UNSUPPORTED".into());
        }
        Some(endpoint_for(app, vault_id, jump_host).map_err(|error| {
            if error.contains("VAULT") {
                error
            } else {
                failure("jump", "credential_unavailable", error)
            }
        })?)
    } else {
        host.jump_host
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|address| Endpoint {
                host: address.trim().into(),
                port: host.jump_port.unwrap_or(22),
                username: host
                    .jump_user
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(&host.username)
                    .into(),
                auth_type: target.auth_type.clone(),
                secret: target.secret.clone(),
                passphrase: None,
            })
    };
    Ok(Route { target, jump })
}

pub fn legacy_route(
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&str>,
    jump_port: Option<u16>,
    jump_user: Option<&str>,
) -> Route {
    let target = Endpoint {
        host: host.into(),
        port,
        username: username.into(),
        auth_type: auth_type.into(),
        secret: if auth_type == "password" {
            password
        } else {
            private_key
        }
        .unwrap_or_default()
        .into(),
        passphrase: passphrase.map(str::to_owned),
    };
    let jump = jump_host
        .filter(|host| !host.trim().is_empty())
        .map(|host| Endpoint {
            host: host.trim().into(),
            port: jump_port.unwrap_or(22),
            username: jump_user
                .filter(|user| !user.trim().is_empty())
                .unwrap_or(username)
                .into(),
            ..target.clone()
        });
    Route { target, jump }
}

fn failure(stage: &str, operation: &str, error: impl std::fmt::Display) -> String {
    let text = error.to_string();
    // Preserve structured key errors so the existing trust dialog can render
    // the actual endpoint fingerprint. Include the route stage in the JSON.
    if let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(&text) {
        if payload
            .get("code")
            .and_then(|v| v.as_str())
            .is_some_and(|code| code.starts_with("host_key_"))
        {
            payload["routeStage"] = stage.into();
            return payload.to_string();
        }
    }
    crate::error::standard_error_payload(
        &format!("{stage}_{operation}"),
        stage,
        operation == "unreachable" || operation == "timeout",
        &format!("SSH {stage} {operation}"),
        None,
    )
}

fn handshake(
    tcp: TcpStream,
    endpoint: &Endpoint,
    stage: &str,
    verify: &mut dyn FnMut(&Session, &Endpoint) -> Result<(), String>,
) -> Result<Session, String> {
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();
    let mut session = Session::new().map_err(|error| failure(stage, "session_failed", error))?;
    session.set_timeout(15_000);
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| failure(stage, "handshake_failed", error))?;
    verify(&session, endpoint).map_err(|error| failure(stage, "host_key_failed", error))?;
    super::authenticate_session(
        &mut session,
        &endpoint.username,
        &endpoint.auth_type,
        (endpoint.auth_type == "password").then_some(endpoint.secret.as_str()),
        (endpoint.auth_type == "privateKey").then_some(endpoint.secret.as_str()),
        endpoint.passphrase.as_deref(),
    )
    .map_err(|error| failure(stage, "auth_failed", error))?;
    Ok(session)
}

fn dial(endpoint: &Endpoint, stage: &str) -> Result<TcpStream, String> {
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|error| failure(stage, "unreachable", error))?;
    let mut error = None;
    for address in addresses.take(4) {
        match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            Ok(tcp) => return Ok(tcp),
            Err(cause) => error = Some(cause),
        }
    }
    Err(failure(
        stage,
        "unreachable",
        error.map(|value| value.to_string()).unwrap_or_default(),
    ))
}

pub fn connect(app: &tauri::AppHandle, route: &Route) -> Result<Connection, String> {
    connect_with_verifier(route, &mut |session, endpoint| {
        super::verify_host_key(session, app, &endpoint.host, endpoint.port, false)
    })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyAcceptance {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}
impl HostKeyAcceptance {
    fn matches(&self, endpoint: &Endpoint, payload: &serde_json::Value) -> bool {
        self.host == endpoint.host
            && self.port == endpoint.port
            && payload["code"] == "host_key_unknown"
            && payload["fingerprint"].as_str() == Some(self.fingerprint.as_str())
    }
}

/// A user decision authorizes exactly the fingerprint shown in the trust
/// dialog. A retry can encounter the other hop and must prompt separately.
pub fn connect_accepting_fingerprint(
    app: &tauri::AppHandle,
    route: &Route,
    accepted: Option<&HostKeyAcceptance>,
) -> Result<Connection, String> {
    let mut decision_used = false;
    connect_with_verifier(
        route,
        &mut |session, endpoint| match super::verify_host_key(
            session,
            app,
            &endpoint.host,
            endpoint.port,
            false,
        ) {
            Err(error) => {
                let payload = serde_json::from_str::<serde_json::Value>(&error).ok();
                let allowed = !decision_used
                    && payload.as_ref().is_some_and(|value| {
                        accepted.is_some_and(|decision| decision.matches(endpoint, value))
                    });
                if allowed {
                    decision_used = true;
                    super::verify_host_key(session, app, &endpoint.host, endpoint.port, true)
                } else {
                    Err(error)
                }
            }
            Ok(()) => Ok(()),
        },
    )
}

pub fn connect_with_verifier(
    route: &Route,
    verify: &mut dyn FnMut(&Session, &Endpoint) -> Result<(), String>,
) -> Result<Connection, String> {
    let Some(jump) = &route.jump else {
        return handshake(
            dial(&route.target, "target")?,
            &route.target,
            "target",
            verify,
        )
        .map(|session| Connection {
            verified_host_keys: vec![verified_key(&session, &route.target, "target")],
            session,
            tunnel: None,
        });
    };
    let jump_session = handshake(dial(jump, "jump")?, jump, "jump", verify)?;
    let channel = jump_session
        .channel_direct_tcpip(&route.target.host, route.target.port, None)
        .map_err(|error| failure("target", "unreachable", error))?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| failure("jump", "tunnel_failed", error))?;
    let client = TcpStream::connect(
        listener
            .local_addr()
            .map_err(|error| failure("jump", "tunnel_failed", error))?,
    )
    .map_err(|error| failure("jump", "tunnel_failed", error))?;
    let (server, _) = listener
        .accept()
        .map_err(|error| failure("jump", "tunnel_failed", error))?;
    drop(listener);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let jump_key = verified_key(&jump_session, jump, "jump");
    let worker = thread::spawn(move || bridge(jump_session, channel, server, worker_stop));
    let tunnel = Arc::new(TunnelLease {
        stop,
        worker: Mutex::new(Some(worker)),
    });
    let session = handshake(client, &route.target, "target", verify)?;
    Ok(Connection {
        verified_host_keys: vec![jump_key, verified_key(&session, &route.target, "target")],
        session,
        tunnel: Some(tunnel),
    })
}

fn would_block(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
}
pub(crate) fn bridge(session: Session, channel: Channel, socket: TcpStream, stop: Arc<AtomicBool>) {
    bridge_with_prefix(session, channel, socket, stop, Vec::new());
}

pub(crate) fn bridge_with_prefix(
    session: Session,
    mut channel: Channel,
    mut socket: TcpStream,
    stop: Arc<AtomicBool>,
    prefix: Vec<u8>,
) {
    session.set_blocking(false);
    if socket.set_nonblocking(true).is_err() {
        return;
    }
    let mut to_remote = prefix;
    let mut to_local = Vec::<u8>::new();
    let mut local_eof = false;
    let mut remote_eof = false;
    let mut remote_half_closed = false;
    let mut eof_sent = false;
    let mut buffer = [0u8; 16_384];
    while !stop.load(Ordering::Relaxed) {
        if !local_eof && to_remote.len() < 65_536 {
            match socket.read(&mut buffer) {
                Ok(0) => local_eof = true,
                Ok(n) => to_remote.extend_from_slice(&buffer[..n]),
                Err(error) if would_block(&error) => {}
                Err(_) => break,
            }
        }
        if !to_remote.is_empty() {
            match channel.write(&to_remote) {
                Ok(n) => {
                    to_remote.drain(..n);
                }
                Err(error) if would_block(&error) => {}
                Err(_) => break,
            }
        }
        if local_eof && to_remote.is_empty() && !eof_sent {
            eof_sent = channel.send_eof().is_ok();
        }
        if !remote_eof && to_local.len() < 65_536 {
            match channel.read(&mut buffer) {
                Ok(0) => remote_eof = true,
                Ok(n) => to_local.extend_from_slice(&buffer[..n]),
                Err(error) if would_block(&error) => {}
                Err(_) => break,
            }
        }
        if !to_local.is_empty() {
            match socket.write(&to_local) {
                Ok(n) => {
                    to_local.drain(..n);
                }
                Err(error) if would_block(&error) => {}
                Err(_) => break,
            }
        }
        if remote_eof && to_local.is_empty() && !remote_half_closed {
            let _ = socket.shutdown(std::net::Shutdown::Write);
            remote_half_closed = true;
        }
        if local_eof && to_remote.is_empty() && eof_sent && remote_eof && to_local.is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    let _ = socket.shutdown(std::net::Shutdown::Both);
    let _ = channel.close();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    use super::super::test_fixture::{server, trusted};

    #[test]
    fn real_native_probe_helper_streams_beyond_exec_packet_limit() {
        let Some(target) = server() else { return };
        let Some(jump) = server() else { return };
        for jump_endpoint in [None, Some(jump.endpoint.clone())] {
            let route = Route {
                target: target.endpoint.clone(),
                jump: jump_endpoint,
            };
            let connection =
                connect_with_verifier(&route, &mut trusted(&[&target, &jump])).unwrap();
            let mut channel = connection.session.channel_session().unwrap();
            let command = crate::data::komari_agent::remote_command();
            assert!(command.len() < 1024);
            let request = serde_json::json!({"deployment":uuid::Uuid::new_v4().to_string(),"action":"invalid-fixture-action","synthetic":"quotes '\" and Unicode 测试","padding":"x".repeat(40_000)});
            let input = crate::data::komari_agent::remote_input(&request).unwrap();
            assert!(input.len() > 35_000);
            channel.exec(&command).unwrap();
            channel.write_all(&input).unwrap();
            channel.send_eof().unwrap();
            let mut output = String::new();
            channel.read_to_string(&mut output).unwrap();
            channel.wait_close().unwrap();
            assert_eq!(channel.exit_status().unwrap(), 0);
            let response: serde_json::Value = serde_json::from_str(&output).unwrap();
            assert_eq!(response["ok"], false);
            assert_eq!(
                response["code"],
                if cfg!(target_os = "linux") {
                    "invalid_action"
                } else {
                    "linux_required"
                }
            );
        }
    }

    #[test]
    fn real_direct_and_single_jump_commands_and_sftp_use_independent_keys() {
        let Some(target) = server() else {
            return;
        };
        let Some(jump) = server() else {
            return;
        };
        let direct = Route {
            target: target.endpoint.clone(),
            jump: None,
        };
        let peers = [&target, &jump];
        let connection = connect_with_verifier(&direct, &mut trusted(&peers)).unwrap();
        let result = super::super::commands::execute(
            connection,
            "printf direct-ok",
            Instant::now(),
            Duration::from_secs(10),
        );
        assert_eq!(result.stdout, "direct-ok");
        assert_eq!(result.exit_code, 0);
        let route = Route {
            target: target.endpoint.clone(),
            jump: Some(jump.endpoint.clone()),
        };
        let connection = connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let result = super::super::commands::execute(
            connection,
            "printf jump-ok",
            Instant::now(),
            Duration::from_secs(10),
        );
        assert_eq!(result.stdout, "jump-ok");
        assert_eq!(result.exit_code, 0);
        let connection = connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let sftp = connection.session.sftp().unwrap();
        let path = target.directory.join("sftp-roundtrip");
        sftp.create(&path).unwrap().write_all(b"verified").unwrap();
        let mut contents = String::new();
        sftp.open(&path)
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert_eq!(contents, "verified");
        sftp.unlink(&path).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn real_mcp_structured_process_observations_and_rejected_log_queries() {
        let Some(target) = server() else {
            panic!("MCP Linux observations require the SSH fixture")
        };
        let Some(jump) = server() else {
            panic!("MCP Linux observations require the jump fixture")
        };
        for jump_endpoint in [None, Some(jump.endpoint.clone())] {
            let route = Route {
                target: target.endpoint.clone(),
                jump: jump_endpoint,
            };
            let connection =
                connect_with_verifier(&route, &mut trusted(&[&target, &jump])).unwrap();
            let started = crate::storage::now_unix_ms();
            let result = crate::mcp::test_remote_diagnostics(
                &connection.session,
                &serde_json::json!({"kind":"processes","limit":2}),
            )
            .unwrap();
            assert_eq!(result["status"], "completed");
            assert_eq!(result["entries"].as_array().unwrap().len(), 2);
            assert!(result["observedAt"].as_i64().unwrap() >= started);
            for row in result["entries"].as_array().unwrap() {
                assert!(row["pid"].as_u64().unwrap() > 0);
                assert!(row["name"].is_string());
                assert!(row.get("command").is_none());
                assert!(row.get("environment").is_none());
            }
            let denied = crate::mcp::test_remote_diagnostics(
                &connection.session,
                &serde_json::json!({"kind":"logs","unit":"x'; printf injected; #"}),
            )
            .unwrap();
            assert_eq!(denied["status"], "failed");
            assert_eq!(denied["reason"], "invalid-log-query");
        }
    }

    #[test]
    fn real_mcp_directory_pages_and_symlink_metadata_work_direct_and_via_jump() {
        let Some(target) = server() else { return };
        let Some(jump) = server() else { return };
        let directory = target.directory.join("mcp-directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("first"),
            b"not returned in directory metadata",
        )
        .unwrap();
        std::fs::create_dir(directory.join("nested")).unwrap();
        std::os::unix::fs::symlink(directory.join("first"), directory.join("link")).unwrap();
        for jump_endpoint in [None, Some(jump.endpoint.clone())] {
            let route = Route {
                target: target.endpoint.clone(),
                jump: jump_endpoint,
            };
            let connection =
                connect_with_verifier(&route, &mut trusted(&[&target, &jump])).unwrap();
            let query = serde_json::json!({"path":directory,"limit":2});
            let first = crate::mcp::test_remote_browse(
                &connection.session,
                "list_remote_directory",
                &query,
            )
            .unwrap();
            assert_eq!(first["entries"].as_array().unwrap().len(), 2);
            assert_eq!(first["nextOffset"], 2);
            let second = crate::mcp::test_remote_browse(
                &connection.session,
                "list_remote_directory",
                &serde_json::json!({"path":directory,"limit":2,"offset":2}),
            )
            .unwrap();
            assert_eq!(second["entries"].as_array().unwrap().len(), 1);
            assert_eq!(second["nextOffset"], serde_json::Value::Null);
            let names: std::collections::HashSet<_> = first["entries"]
                .as_array()
                .unwrap()
                .iter()
                .chain(second["entries"].as_array().unwrap())
                .map(|e| e["name"].as_str().unwrap())
                .collect();
            assert_eq!(
                names,
                std::collections::HashSet::from(["first", "nested", "link"])
            );
            assert!(!first.to_string().contains("not returned"));
            let link = crate::mcp::test_remote_browse(
                &connection.session,
                "stat_remote_path",
                &serde_json::json!({"path":directory.join("link")}),
            )
            .unwrap();
            assert_eq!(link["entry"]["type"], "symlink");
            assert_eq!(link["followsSymlinks"], false);
            let empty = crate::mcp::test_remote_browse(
                &connection.session,
                "list_remote_directory",
                &serde_json::json!({"path":directory.join("nested")}),
            )
            .unwrap();
            assert_eq!(empty["entries"], serde_json::json!([]));
            assert!(crate::mcp::test_remote_browse(
                &connection.session,
                "list_remote_directory",
                &serde_json::json!({"path":directory.join("missing")})
            )
            .is_err());
            assert!(crate::mcp::test_remote_browse(
                &connection.session,
                "stat_remote_path",
                &serde_json::json!({"path":"/../etc"})
            )
            .is_err());
        }
    }

    #[test]
    fn real_jump_auth_and_host_key_failures_remain_distinct() {
        let Some(target) = server() else {
            return;
        };
        let Some(jump) = server() else {
            return;
        };
        let peers = [&target, &jump];
        let mut route = Route {
            target: target.endpoint.clone(),
            jump: Some(jump.endpoint.clone()),
        };
        route.jump.as_mut().unwrap().secret = target.endpoint.secret.clone();
        let error = connect_with_verifier(&route, &mut trusted(&peers))
            .err()
            .unwrap();
        assert!(error.contains("jump_auth_failed"));
        route.jump = Some(jump.endpoint.clone());
        let error = connect_with_verifier(&route, &mut |_, endpoint| {
            if endpoint.port == target.endpoint.port {
                Err(crate::error::host_key_mismatch_payload(
                    &endpoint.host,
                    endpoint.port,
                    "changed",
                    "RSA",
                ))
            } else {
                Ok(())
            }
        })
        .err()
        .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&error).unwrap();
        assert_eq!(payload["code"], "host_key_mismatch");
        assert_eq!(payload["routeStage"], "target");
    }

    #[test]
    fn real_remote_timeout_is_an_unknown_outcome() {
        let Some(target) = server() else {
            return;
        };
        let peers = [&target];
        let route = Route {
            target: target.endpoint.clone(),
            jump: None,
        };
        let connection = connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let result = super::super::commands::execute(
            connection,
            "sleep 5",
            Instant::now(),
            Duration::from_millis(80),
        );
        assert_eq!(result.error_code.as_deref(), Some("target_timeout"));
        assert!(result.stderr.contains("unknown"));
    }
    #[test]
    fn real_single_jump_local_remote_and_socks_forwarding_roundtrips() {
        let Some(target) = server() else {
            return;
        };
        let Some(jump) = server() else {
            return;
        };
        let echo = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_worker = thread::spawn(move || {
            for _ in 0..3 {
                let (mut socket, _) = echo.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut data = [0u8; 4];
                socket.read_exact(&mut data).unwrap();
                socket.write_all(&data).unwrap();
            }
        });
        let peers = [&target, &jump];
        let route = Route {
            target: target.endpoint.clone(),
            jump: Some(jump.endpoint.clone()),
        };
        let connect = || connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let local = super::super::forward::start(
            connect(),
            "127.0.0.1",
            0,
            super::super::forward::ForwardKind::Local {
                host: "127.0.0.1".into(),
                port: echo_port,
            },
        )
        .unwrap();
        let socks = super::super::forward::start(
            connect(),
            "127.0.0.1",
            0,
            super::super::forward::ForwardKind::Socks,
        )
        .unwrap();
        let remote = super::super::forward::start(
            connect(),
            "127.0.0.1",
            0,
            super::super::forward::ForwardKind::Remote {
                host: "127.0.0.1".into(),
                port: echo_port,
            },
        )
        .unwrap();
        for (port, proxy) in [
            (local.port, false),
            (socks.port, true),
            (remote.port, false),
        ] {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            if proxy {
                stream.write_all(&[5, 1, 0]).unwrap();
                let mut auth = [0u8; 2];
                stream.read_exact(&mut auth).unwrap();
                assert_eq!(auth, [5, 0]);
                let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
                request.extend_from_slice(&echo_port.to_be_bytes());
                stream.write_all(&request).unwrap();
                let mut response = [0u8; 10];
                stream.read_exact(&mut response).unwrap();
                assert_eq!(response[1], 0);
            }
            stream.write_all(b"ping").unwrap();
            let mut output = [0u8; 4];
            stream.read_exact(&mut output).unwrap();
            assert_eq!(&output, b"ping");
        }
        echo_worker.join().unwrap();
    }
    #[test]
    fn real_single_jump_http_proxy_preserves_connect_and_post_bytes() {
        let Some(target) = server() else {
            return;
        };
        let Some(jump) = server() else {
            return;
        };
        let peers = [&target, &jump];
        let route = Route {
            target: target.endpoint.clone(),
            jump: Some(jump.endpoint.clone()),
        };
        let echo = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut socket, _) = echo.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = [0u8; 4];
            socket.read_exact(&mut bytes).unwrap();
            socket.write_all(&bytes).unwrap();
        });
        let connection = connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let lease = super::super::forward::start(
            connection,
            "127.0.0.1",
            0,
            super::super::forward::ForwardKind::Http,
        )
        .unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", lease.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        socket
            .write_all(
                format!("CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\nHost: local\r\n\r\nping")
                    .as_bytes(),
            )
            .unwrap();
        let mut response = vec![0u8; b"HTTP/1.1 200 Connection Established\r\n\r\n".len() + 4];
        socket.read_exact(&mut response).unwrap();
        assert!(response.ends_with(b"ping"));
        worker.join().unwrap();
        let origin = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let origin_worker = thread::spawn(move || {
            let (mut socket, _) = origin.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 2048];
            while !bytes.ends_with(b"\r\n\r\nbody") {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0 && bytes.len() < 70_000);
                bytes.extend_from_slice(&chunk[..count]);
            }
            assert!(bytes.starts_with(b"POST /test HTTP/1.1\r\n"));
            assert!(!String::from_utf8_lossy(&bytes).contains("private-proxy-token"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndone")
                .unwrap();
        });
        let mut socket = TcpStream::connect(("127.0.0.1", lease.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        socket.write_all(format!("POST http://127.0.0.1:{origin_port}/test HTTP/1.1\r\nHost: local\r\nProxy-Authorization: private-proxy-token\r\nContent-Length: 4\r\n\r\nbody").as_bytes()).unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        assert!(response.ends_with("done"));
        origin_worker.join().unwrap();
        let port = lease.port;
        drop(lease);
        let deadline = Instant::now() + Duration::from_secs(2);
        while TcpStream::connect(("127.0.0.1", port)).is_ok() {
            assert!(
                Instant::now() < deadline,
                "dropping lease must stop listener"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn real_signaled_command_is_not_reported_as_success() {
        let Some(target) = server() else {
            return;
        };
        let peers = [&target];
        let route = Route {
            target: target.endpoint.clone(),
            jump: None,
        };
        let connection = connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let result = super::super::commands::execute(
            connection,
            "kill -KILL $$",
            Instant::now(),
            Duration::from_secs(5),
        );
        assert_eq!(result.error_code.as_deref(), Some("remote_state_unknown"));
        assert_ne!(result.exit_code, 0);
    }
    #[test]
    fn trust_decision_is_bound_to_endpoint_and_rejects_changed_keys() {
        let decision = HostKeyAcceptance {
            host: "jump".into(),
            port: 22,
            fingerprint: "shared-key".into(),
        };
        let mut endpoint = Endpoint {
            host: "jump".into(),
            port: 22,
            username: "ops".into(),
            auth_type: "password".into(),
            secret: "unused".into(),
            passphrase: None,
        };
        let unknown = serde_json::json!({"code":"host_key_unknown","fingerprint":"shared-key"});
        assert!(decision.matches(&endpoint, &unknown));
        endpoint.host = "target".into();
        assert!(!decision.matches(&endpoint, &unknown));
        endpoint.host = "jump".into();
        endpoint.port = 2222;
        assert!(!decision.matches(&endpoint, &unknown));
        endpoint.port = 22;
        assert!(!decision.matches(
            &endpoint,
            &serde_json::json!({"code":"host_key_mismatch","fingerprint":"shared-key"})
        ));
    }

    #[test]
    fn real_remote_output_limit_keeps_an_uncertain_bounded_result() {
        let Some(target) = server() else {
            return;
        };
        let peers = [&target];
        let route = Route {
            target: target.endpoint.clone(),
            jump: None,
        };
        let connection = connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let result = super::super::commands::execute(
            connection,
            "awk 'BEGIN { for (i=0; i<300000; i++) printf \"x\" }'",
            Instant::now(),
            Duration::from_secs(5),
        );
        assert_eq!(result.error_code.as_deref(), Some("output_limit"));
        assert_ne!(result.exit_code, 0);
        assert!(
            result.stdout.len() + result.stderr.len()
                < super::super::commands::remote_output_limit()
        );
    }
    #[test]
    fn elapsed_command_budget_never_sends_a_write() {
        let Some(target) = server() else {
            return;
        };
        let peers = [&target];
        let path = target.directory.join("must-not-exist");
        let route = Route {
            target: target.endpoint.clone(),
            jump: None,
        };
        let connection = connect_with_verifier(&route, &mut trusted(&peers)).unwrap();
        let result = super::super::commands::execute(
            connection,
            &format!("touch '{}'", path.display()),
            Instant::now(),
            Duration::ZERO,
        );
        assert_eq!(
            result.error_code.as_deref(),
            Some("target_timeout_before_execution")
        );
        assert!(!path.exists());
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn route_identity_uses_resolved_endpoints_without_credentials() {
        let target = Endpoint {
            host: "target.internal".into(),
            port: 2222,
            username: "ops".into(),
            auth_type: "password".into(),
            secret: "target-secret".into(),
            passphrase: Some("phrase".into()),
        };
        let jump = Endpoint {
            host: "edited-bastion.internal".into(),
            port: 2200,
            username: "new-jump-user".into(),
            auth_type: "privateKey".into(),
            secret: "jump-private-key".into(),
            passphrase: None,
        };
        let route = Route {
            target,
            jump: Some(jump),
        };
        let identity = route_identity(&route, "host-1", Some("jump-1"));
        assert_eq!(
            identity["jump"],
            serde_json::json!({"hostId":"jump-1","address":"edited-bastion.internal","port":2200,"username":"new-jump-user"})
        );
        assert_eq!(identity["port"], 2222);
        let serialized = identity.to_string();
        for secret in [
            "target-secret",
            "phrase",
            "jump-private-key",
            "authType",
            "passphrase",
        ] {
            assert!(!serialized.contains(secret));
        }
    }
}
