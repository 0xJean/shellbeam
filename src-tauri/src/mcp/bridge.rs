use super::{policy, protocol, McpState};
use crate::storage::{data_file_path, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::Manager;

const MAX_FRAME: usize = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    instance: String,
}

fn write_frame(stream: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FRAME {
        return Err("MCP_MESSAGE_TOO_LARGE".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

fn read_frame(stream: &mut impl Read) -> Result<Value, String> {
    let mut size = [0u8; 4];
    stream.read_exact(&mut size).map_err(|e| e.to_string())?;
    let size = u32::from_be_bytes(size) as usize;
    if size > MAX_FRAME {
        return Err("MCP_MESSAGE_TOO_LARGE".into());
    }
    let mut data = vec![0; size];
    stream.read_exact(&mut data).map_err(|e| e.to_string())?;
    serde_json::from_slice(&data).map_err(|_| "INVALID_IPC_FRAME".into())
}

pub(super) fn start(app: &tauri::AppHandle) -> Result<(), String> {
    if cfg!(mobile) {
        return Err("MCP_DESKTOP_ONLY".into());
    }
    let state = app.state::<McpState>();
    let mut runtime = state.listener.lock().map_err(|_| "MCP_STATE_UNAVAILABLE")?;
    if runtime.is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let endpoint = Endpoint {
        port: listener.local_addr().map_err(|e| e.to_string())?.port(),
        instance: uuid::Uuid::new_v4().to_string(),
    };
    write_json(&data_file_path(app, "mcp_endpoint.json")?, &endpoint)?;
    let stop = Arc::new(AtomicBool::new(false));
    *runtime = Some(stop.clone());
    let app = app.clone();
    let connections = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, address)) => {
                    if !address.ip().is_loopback() || connections.load(Ordering::SeqCst) >= 16 {
                        continue;
                    }
                    connections.fetch_add(1, Ordering::SeqCst);
                    let (app, instance, connections, stop) = (
                        app.clone(),
                        endpoint.instance.clone(),
                        connections.clone(),
                        stop.clone(),
                    );
                    std::thread::spawn(move || {
                        let _guard = ConnectionGuard(connections);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                        let Ok(envelope) = read_frame(&mut stream) else {
                            return;
                        };
                        let id = envelope["request"]
                            .get("id")
                            .cloned()
                            .unwrap_or(Value::Null);
                        let result =
                            if stop.load(Ordering::SeqCst) || envelope["instance"] != instance {
                                protocol::error(id, -32001, "MCP_INSTANCE_EXPIRED")
                            } else {
                                let state = app.state::<McpState>();
                                let auth = state
                                    .settings
                                    .lock()
                                    .map_err(|_| "MCP_STATE_UNAVAILABLE".to_string())
                                    .and_then(|settings| {
                                        policy::authenticate(
                                            &settings,
                                            envelope["clientId"].as_str().unwrap_or(""),
                                            envelope["token"].as_str().unwrap_or(""),
                                        )
                                    });
                                match auth {
                                    Ok(client) => {
                                        super::dispatch(&app, &client, envelope["request"].clone())
                                            .unwrap_or(Value::Null)
                                    }
                                    Err(error) => protocol::error(id, -32001, &error),
                                }
                            };
                        let _ = write_frame(&mut stream, &result);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
    });
    Ok(())
}

struct ConnectionGuard(Arc<AtomicUsize>);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn forward(
    endpoint_path: &str,
    client_id: &str,
    token: &str,
    request: &Value,
) -> Result<Value, String> {
    let content = std::fs::read(endpoint_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "SHELLBEAM_NOT_RUNNING: open ShellBeam and enable MCP".to_string()
        } else {
            "SHELLBEAM_ENDPOINT_UNREADABLE: check ShellBeam MCP data".to_string()
        }
    })?;
    if content.len() > 4096 {
        return Err("INVALID_ENDPOINT_FILE".into());
    }
    let endpoint: Endpoint =
        serde_json::from_slice(&content).map_err(|_| "INVALID_ENDPOINT_FILE")?;
    // The discovery file can specify a port, never an arbitrary destination host.
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port);
    let mut stream =
        TcpStream::connect_timeout(&address.into(), Duration::from_secs(3)).map_err(|error| {
            match error.kind() {
                std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut => {
                    "SHELLBEAM_NOT_RUNNING: open ShellBeam and enable MCP".to_string()
                }
                _ => "SHELLBEAM_UNAVAILABLE: open ShellBeam and enable MCP".to_string(),
            }
        })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    write_frame(
        &mut stream,
        &json!({"instance":endpoint.instance,"clientId":client_id,"token":token,"request":request}),
    )?;
    read_frame(&mut stream)
}

/// Tests the authenticated local transport, never a remote host or an external client's settings.
pub(super) fn test_connection(
    endpoint_path: &str,
    client_id: &str,
    token: &str,
) -> Result<usize, String> {
    let initialized = forward(
        endpoint_path,
        client_id,
        token,
        &json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"protocolVersion":protocol::VERSION,"capabilities":{},
            "clientInfo":{"name":"shellbeam-local-check","version":env!("CARGO_PKG_VERSION")}}
        }),
    )?;
    check_diagnostic_response(&initialized, 1)?;
    if initialized["result"]["serverInfo"]["name"] != "shellbeam" {
        return Err("MCP_INVALID_HANDSHAKE".into());
    }
    let tools = forward(
        endpoint_path,
        client_id,
        token,
        &json!({
            "jsonrpc":"2.0", "id":2, "method":"tools/list"
        }),
    )?;
    check_diagnostic_response(&tools, 2)?;
    tools["result"]["tools"]
        .as_array()
        .map(Vec::len)
        .ok_or("MCP_INVALID_TOOL_LIST".into())
}

fn check_diagnostic_response(response: &Value, id: u64) -> Result<(), String> {
    if let Some(error) = response.get("error") {
        // Report only known diagnostics, never arbitrary transport response contents.
        return Err(match error["message"].as_str().unwrap_or("") {
            "MCP_DISABLED" => "MCP_DISABLED",
            message if message.starts_with("SHELLBEAM_NOT_RUNNING") => "SHELLBEAM_UNAVAILABLE",
            "CLIENT_REVOKED" | "UNAUTHORIZED" => "MCP_AUTHENTICATION_FAILED",
            "MCP_INSTANCE_EXPIRED" => "MCP_INSTANCE_EXPIRED",
            _ => "MCP_CONNECTION_REJECTED",
        }
        .into());
    }
    if response["jsonrpc"] != "2.0" || response["id"] != id || !response["result"].is_object() {
        return Err("MCP_INVALID_RESPONSE".into());
    }
    Ok(())
}

#[derive(Default)]
struct Lifecycle {
    initialized: bool,
    ready: bool,
}
impl Lifecycle {
    fn check(&mut self, request: &Value) -> Result<bool, &'static str> {
        match request["method"].as_str().unwrap_or("") {
            "initialize" if !self.initialized && request.get("id").is_some() => Ok(true),
            "initialize" => Err("Already initialized"),
            "notifications/initialized" if self.initialized && request.get("id").is_none() => {
                self.ready = true;
                Ok(false)
            }
            "ping" => Ok(true),
            _ if !self.ready => Err("Initialize the MCP connection first"),
            _ => Ok(request.get("id").is_some()),
        }
    }
}

/// A separate invocation of the installed app acts only as a stdio bridge, without a WebView.
pub fn run_stdio(endpoint_path: &str, client_id: &str) -> Result<(), String> {
    let token =
        std::env::var("SHELLBEAM_MCP_TOKEN").map_err(|_| "SHELLBEAM_MCP_TOKEN is required")?;
    let mut lifecycle = Lifecycle::default();
    let mut input = BufReader::new(std::io::stdin());
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = Vec::new();
        let count = input
            .by_ref()
            .take((MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if line.len() > MAX_FRAME {
            return Err("MCP_MESSAGE_TOO_LARGE".into());
        }
        let request = match serde_json::from_slice::<Value>(&line) {
            Ok(request) => request,
            Err(_) => {
                writeln!(
                    output,
                    "{}",
                    protocol::error(Value::Null, -32700, "Parse error")
                )
                .map_err(|e| e.to_string())?;
                output.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let result = if let Err(error) = protocol::validate_request(&request) {
            protocol::error(id, -32600, &error)
        } else {
            match lifecycle.check(&request) {
                Ok(false) => continue,
                Err(error) if request.get("id").is_some() => protocol::error(id, -32600, error),
                Err(_) => continue,
                Ok(true) => match forward(endpoint_path, client_id, &token, &request) {
                    Ok(response) => {
                        if request["method"] == "initialize" && response.get("result").is_some() {
                            lifecycle.initialized = true;
                        }
                        response
                    }
                    Err(error) => protocol::error(id, -32000, &error),
                },
            }
        };
        if !result.is_null() {
            writeln!(output, "{result}").map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_diagnostic_only_initializes_and_lists_tools() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = Endpoint {
            port: listener.local_addr().unwrap().port(),
            instance: "test-instance".into(),
        };
        let path =
            std::env::temp_dir().join(format!("shellbeam-mcp-test-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, serde_json::to_vec(&endpoint).unwrap()).unwrap();
        let server = std::thread::spawn(move || {
            let mut methods = Vec::new();
            for id in 1..=2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let envelope = read_frame(&mut stream).unwrap();
                assert_eq!(envelope["instance"], "test-instance");
                assert_eq!(envelope["clientId"], "test-client");
                assert_eq!(envelope["token"], "test-token");
                let request = &envelope["request"];
                protocol::validate_request(request).unwrap();
                methods.push(request["method"].as_str().unwrap().to_string());
                let result = if id == 1 {
                    json!({"serverInfo":{"name":"shellbeam"}})
                } else {
                    json!({"tools":[{"name":"list_servers"}]})
                };
                write_frame(&mut stream, &protocol::response(json!(id), result)).unwrap();
            }
            methods
        });
        let result = test_connection(&path.to_string_lossy(), "test-client", "test-token");
        std::fs::remove_file(path).unwrap();
        assert_eq!(result.unwrap(), 1);
        assert_eq!(server.join().unwrap(), ["initialize", "tools/list"]);
    }

    #[test]
    fn diagnostic_responses_require_matching_ids_and_hide_untrusted_errors() {
        assert!(check_diagnostic_response(&json!({"jsonrpc":"2.0","id":1,"result":{}}), 1).is_ok());
        assert!(
            check_diagnostic_response(&json!({"jsonrpc":"2.0","id":2,"result":{}}), 1).is_err()
        );
        assert!(
            check_diagnostic_response(&json!({"jsonrpc":"2.0","id":1,"result":null}), 1).is_err()
        );
        assert_eq!(
            check_diagnostic_response(&json!({"error":{"message":"secret token"}}), 1).unwrap_err(),
            "MCP_CONNECTION_REJECTED"
        );
        assert_eq!(
            check_diagnostic_response(&json!({"error":{"message":"MCP_DISABLED"}}), 1).unwrap_err(),
            "MCP_DISABLED"
        );
    }
    #[test]
    fn framing_rejects_oversized_messages_before_allocation() {
        let mut oversized = std::io::Cursor::new(((MAX_FRAME + 1) as u32).to_be_bytes());
        assert!(read_frame(&mut oversized).is_err());
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({"message":"hello\nworld"})).unwrap();
        assert_eq!(
            read_frame(&mut std::io::Cursor::new(bytes)).unwrap()["message"],
            "hello\nworld"
        );
    }
    #[test]
    fn handshake_is_required_before_tool_calls() {
        let mut state = Lifecycle::default();
        assert!(state.check(&json!({"method":"tools/call","id":1})).is_err());
        assert!(state.check(&json!({"method":"initialize","id":1})).unwrap());
        state.initialized = true;
        assert!(!state
            .check(&json!({"method":"notifications/initialized"}))
            .unwrap());
        assert!(state.check(&json!({"method":"tools/list","id":2})).unwrap());
        assert!(state.check(&json!({"method":"initialize","id":3})).is_err());
    }
}
