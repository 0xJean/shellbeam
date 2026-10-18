use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn installed_executable_bridges_stdio_without_opening_a_gui_or_exposing_token() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let directory =
        std::env::temp_dir().join(format!("shellbeam-mcp-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let endpoint = directory.join("endpoint.json");
    std::fs::write(
        &endpoint,
        json!({"port":listener.local_addr().unwrap().port(),"instance":"test-instance"})
            .to_string(),
    )
    .unwrap();
    let token = "a".repeat(64);
    let expected_token = token.clone();
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut seen = Vec::new();
        while seen.len() < 3 && started.elapsed() < Duration::from_secs(60) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("accept: {error}"),
            };
            // Match the production worker: accepted sockets may inherit the
            // listener's O_NONBLOCK on macOS, so configure blocking bounded IO.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut prefix = [0; 4];
            stream.read_exact(&mut prefix).unwrap();
            let mut data = vec![0; u32::from_be_bytes(prefix) as usize];
            stream.read_exact(&mut data).unwrap();
            let envelope: Value = serde_json::from_slice(&data).unwrap();
            assert_eq!(envelope["token"], expected_token);
            assert_eq!(envelope["clientId"], "client-a");
            assert_eq!(envelope["instance"], "test-instance");
            let request = &envelope["request"];
            seen.push(request["method"].as_str().unwrap().to_owned());
            let result = match request["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
                }
                "tools/list" => json!({"tools":[]}),
                "tools/call" => {
                    json!({"isError":false,"content":[{"type":"text","text":"fixture"}],"structuredContent":{"servers":[]}})
                }
                method => panic!("unexpected method {method}"),
            };
            let bytes = json!({"jsonrpc":"2.0","id":request["id"],"result":result})
                .to_string()
                .into_bytes();
            stream
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&bytes).unwrap();
        }
        seen
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_app"))
        .args(["--mcp-stdio", endpoint.to_str().unwrap(), "client-a"])
        .env("SHELLBEAM_MCP_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "not-json").unwrap();
        for message in [
            json!({"jsonrpc":"2.0","id":0,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}),
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}),
        ] {
            writeln!(input, "{message}").unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains(&token));
    let responses: Vec<Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 5);
    assert_eq!(responses[0]["error"]["code"], -32700);
    assert_eq!(responses[1]["error"]["code"], -32600);
    assert_eq!(responses[2]["id"], 1);
    assert_eq!(
        responses[4]["result"]["structuredContent"]["servers"],
        json!([]),
        "{stdout}"
    );
    assert_eq!(
        server.join().unwrap(),
        vec!["initialize", "tools/list", "tools/call"]
    );
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn unavailable_application_returns_a_protocol_error_instead_of_launching_gui() {
    let missing = std::env::temp_dir().join(format!("missing-mcp-{}.json", uuid::Uuid::new_v4()));
    let mut child = Command::new(env!("CARGO_BIN_EXE_app"))
        .args(["--mcp-stdio", missing.to_str().unwrap(), "client-a"])
        .env("SHELLBEAM_MCP_TOKEN", "a".repeat(64))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut input = child.stdin.take().unwrap();
        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["id"], "init");
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("SHELLBEAM_NOT_RUNNING"));
    assert_eq!(response["error"]["data"]["reason"], "shellbeam_unavailable");
    assert_eq!(response["error"]["data"]["retryable"], true);
}
