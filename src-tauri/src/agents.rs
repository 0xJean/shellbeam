//! Unified registry of local AI Agents shared by AI Assistant CLIs and MCP auto-configuration.
//!
//! Each entry declares a single source of truth for an agent's identity, optional AI CLI backend,
//! and local MCP configuration file path & format so ShellBeam can auto-detect installed agents
//! and safely merge/remove only its own `shellbeam` entry without touching other user config.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::ai_cli::{self, Backend};
use crate::mcp::policy::Settings as McpSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpConfigFormat {
    /// Standard JSON `{ "mcpServers": { "shellbeam": { command, args, env } } }`.
    JsonMcpServers,
    /// Claude Code JSON `{ "mcpServers": { "shellbeam": { type: "stdio", command, args, env } } }`.
    JsonMcpServersStdio,
    /// Codex TOML `[mcp_servers.shellbeam]` + `[mcp_servers.shellbeam.env]`.
    CodexToml,
    /// OpenCode JSON `{ "mcp": { "shellbeam": { type: "local", command: [...], environment: {...}, enabled: true } } }`.
    OpenCodeJson,
}

#[derive(Clone, Copy)]
pub struct LocalAgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub cli_backend: Option<Backend>,
    pub mcp_format: McpConfigFormat,
}

/// Canonical order of supported local agents. Both AI CLI probing and MCP auto-setup read from here.
pub const LOCAL_AGENTS: &[LocalAgentSpec] = &[
    LocalAgentSpec {
        id: "claude-code",
        name: "Claude Code",
        cli_backend: Some(Backend::ClaudeCode),
        mcp_format: McpConfigFormat::JsonMcpServersStdio,
    },
    LocalAgentSpec {
        id: "codex-cli",
        name: "Codex",
        cli_backend: Some(Backend::CodexCli),
        mcp_format: McpConfigFormat::CodexToml,
    },
    LocalAgentSpec {
        id: "antigravity",
        name: "Antigravity",
        cli_backend: None,
        mcp_format: McpConfigFormat::JsonMcpServers,
    },
    LocalAgentSpec {
        id: "cursor-cli",
        name: "Cursor",
        cli_backend: Some(Backend::CursorCli),
        mcp_format: McpConfigFormat::JsonMcpServers,
    },
    LocalAgentSpec {
        id: "gemini-cli",
        name: "Gemini CLI",
        cli_backend: Some(Backend::GeminiCli),
        mcp_format: McpConfigFormat::JsonMcpServers,
    },
    LocalAgentSpec {
        id: "opencode-cli",
        name: "OpenCode",
        cli_backend: Some(Backend::OpencodeCli),
        mcp_format: McpConfigFormat::OpenCodeJson,
    },
    LocalAgentSpec {
        id: "devin-cli",
        name: "Devin CLI",
        cli_backend: Some(Backend::DevinCli),
        mcp_format: McpConfigFormat::JsonMcpServers,
    },
    LocalAgentSpec {
        id: "claude-desktop",
        name: "Claude Desktop",
        cli_backend: None,
        mcp_format: McpConfigFormat::JsonMcpServers,
    },
];

pub fn find_agent(id: &str) -> Option<&'static LocalAgentSpec> {
    LOCAL_AGENTS.iter().find(|spec| spec.id == id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedLocalAgent {
    pub id: String,
    pub name: String,
    pub supports_ai_cli: bool,
    pub mcp_format: McpConfigFormat,
    pub installed: bool,
    pub config_path: Option<String>,
    pub mcp_configured: bool,
    pub configured_client_id: Option<String>,
    pub active_client_id: Option<String>,
}

pub fn resolve_config_path(agent_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    match agent_id {
        "claude-code" => Some(home.join(".claude.json")),
        "codex-cli" => {
            if let Ok(codex_home) = std::env::var("CODEX_HOME") {
                let trimmed = codex_home.trim();
                if !trimmed.is_empty() {
                    return Some(PathBuf::from(trimmed).join("config.toml"));
                }
            }
            Some(home.join(".codex").join("config.toml"))
        }
        "antigravity" => Some(
            home.join(".gemini")
                .join("antigravity")
                .join("mcp_config.json"),
        ),
        "cursor-cli" => Some(home.join(".cursor").join("mcp.json")),
        "gemini-cli" => Some(home.join(".gemini").join("settings.json")),
        "opencode-cli" => Some(home.join(".config").join("opencode").join("opencode.json")),
        "devin-cli" => Some(home.join(".config").join("devin").join("mcp.json")),
        "claude-desktop" => {
            dirs::config_dir().map(|dir| dir.join("Claude").join("claude_desktop_config.json"))
        }
        _ => None,
    }
}

fn config_dir_exists(agent_id: &str, config_path: &Path) -> bool {
    if config_path.exists() {
        return true;
    }
    match agent_id {
        // `~/.claude.json` lives directly in `$HOME`, so check `~/.claude` instead of `$HOME`.
        "claude-code" => dirs::home_dir().is_some_and(|h| h.join(".claude").is_dir()),
        _ => config_path.parent().is_some_and(Path::is_dir),
    }
}

pub fn detect_local_agents(settings: &McpSettings) -> Vec<DetectedLocalAgent> {
    LOCAL_AGENTS
        .iter()
        .map(|spec| {
            let path = resolve_config_path(spec.id);
            let has_binary = spec.cli_backend.is_some_and(ai_cli::has_cli_binary);
            let has_dir_or_file = path
                .as_deref()
                .is_some_and(|p| config_dir_exists(spec.id, p));
            let (mcp_configured, configured_client_id) = path
                .as_deref()
                .map(|p| inspect_configured_entry(p, spec.mcp_format))
                .unwrap_or((false, None));
            let active_client_id = settings
                .clients
                .iter()
                .find(|c| {
                    c.agent_id.as_deref() == Some(spec.id)
                        || configured_client_id
                            .as_deref()
                            .is_some_and(|cid| cid == c.id)
                })
                .map(|c| c.id.clone());

            DetectedLocalAgent {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                supports_ai_cli: spec.cli_backend.is_some(),
                mcp_format: spec.mcp_format,
                installed: has_binary || has_dir_or_file,
                config_path: path.map(|p| p.to_string_lossy().into_owned()),
                mcp_configured,
                configured_client_id,
                active_client_id,
            }
        })
        .collect()
}

fn inspect_configured_entry(path: &Path, format: McpConfigFormat) -> (bool, Option<String>) {
    let Ok(raw) = fs::read_to_string(path) else {
        return (false, None);
    };
    if raw.trim().is_empty() {
        return (false, None);
    }
    match format {
        McpConfigFormat::JsonMcpServers | McpConfigFormat::JsonMcpServersStdio => {
            let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&raw) else {
                return (false, None);
            };
            let Some(entry) = root
                .get("mcpServers")
                .and_then(Value::as_object)
                .and_then(|m| m.get("shellbeam"))
            else {
                return (false, None);
            };
            (true, extract_client_id_from_json_entry(entry))
        }
        McpConfigFormat::OpenCodeJson => {
            let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&raw) else {
                return (false, None);
            };
            let Some(entry) = root
                .get("mcp")
                .and_then(Value::as_object)
                .and_then(|m| m.get("shellbeam"))
            else {
                return (false, None);
            };
            (true, extract_client_id_from_opencode_entry(entry))
        }
        McpConfigFormat::CodexToml => inspect_codex_toml_entry(&raw),
    }
}

fn extract_client_id_from_args_array(arr: &[Value]) -> Option<String> {
    let idx = arr.iter().position(|v| v.as_str() == Some("--mcp-stdio"))?;
    arr.get(idx + 2).and_then(Value::as_str).map(String::from)
}

fn extract_client_id_from_json_entry(entry: &Value) -> Option<String> {
    let args = entry.get("args").and_then(Value::as_array)?;
    extract_client_id_from_args_array(args)
}

fn extract_client_id_from_opencode_entry(entry: &Value) -> Option<String> {
    let cmd = entry.get("command").and_then(Value::as_array)?;
    extract_client_id_from_args_array(cmd)
}

fn inspect_codex_toml_entry(raw: &str) -> (bool, Option<String>) {
    let mut in_section = false;
    let mut found = false;
    let mut client_id = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_section = trimmed == "[mcp_servers.shellbeam]";
            if in_section {
                found = true;
            }
            continue;
        }
        if in_section {
            if let Some(rest) = trimmed.strip_prefix("args") {
                if let Some((_, val)) = rest.split_once('=') {
                    if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(val.trim()) {
                        client_id = extract_client_id_from_args_array(&arr);
                    }
                }
            }
        }
    }
    (found, client_id)
}

/// Safely merges ONLY the `shellbeam` MCP server entry into the target agent's config file.
/// Returns the resolved config path written.
pub fn install_mcp_config(
    agent_id: &str,
    command: &str,
    args: &[String],
    token: &str,
) -> Result<String, String> {
    let spec = find_agent(agent_id).ok_or_else(|| format!("UNKNOWN_AGENT: {agent_id}"))?;
    let path = resolve_config_path(agent_id)
        .ok_or_else(|| format!("CONFIG_PATH_UNAVAILABLE: {agent_id}"))?;
    install_mcp_config_at_path(&path, spec.mcp_format, command, args, token)?;
    Ok(path.to_string_lossy().into_owned())
}

fn install_mcp_config_at_path(
    path: &Path,
    format: McpConfigFormat,
    command: &str,
    args: &[String],
    token: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("CREATE_CONFIG_DIR_FAILED: {e}"))?;
    }
    let existing = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("READ_CONFIG_FAILED: {e}")),
    };

    let updated = match format {
        McpConfigFormat::JsonMcpServers | McpConfigFormat::JsonMcpServersStdio => {
            merge_json_mcp_servers(
                &existing,
                command,
                args,
                token,
                format == McpConfigFormat::JsonMcpServersStdio,
            )?
        }
        McpConfigFormat::OpenCodeJson => merge_opencode_json(&existing, command, args, token)?,
        McpConfigFormat::CodexToml => merge_codex_toml(&existing, command, args, token),
    };

    write_atomic_preserving_mode(path, updated.as_bytes())
}

/// Safely removes ONLY the `shellbeam` MCP server entry from the target agent's config file.
/// If `expected_client_id` is `Some`, only removes when the file's entry still references that client.
pub fn uninstall_mcp_config(
    agent_id: &str,
    expected_client_id: Option<&str>,
) -> Result<bool, String> {
    let Some(spec) = find_agent(agent_id) else {
        return Ok(false);
    };
    let Some(path) = resolve_config_path(agent_id) else {
        return Ok(false);
    };
    uninstall_mcp_config_at_path(&path, spec.mcp_format, expected_client_id)
}

fn uninstall_mcp_config_at_path(
    path: &Path,
    format: McpConfigFormat,
    expected_client_id: Option<&str>,
) -> Result<bool, String> {
    let existing = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("READ_CONFIG_FAILED: {e}")),
    };
    if existing.trim().is_empty() {
        return Ok(false);
    }
    if let Some(expected) = expected_client_id {
        let (configured, current_id) = inspect_configured_entry(path, format);
        if !configured {
            return Ok(false);
        }
        if let Some(cid) = current_id.as_deref() {
            if cid != expected {
                return Ok(false);
            }
        }
    }

    let (updated, changed) = match format {
        McpConfigFormat::JsonMcpServers | McpConfigFormat::JsonMcpServersStdio => {
            remove_json_key(&existing, "mcpServers")?
        }
        McpConfigFormat::OpenCodeJson => remove_json_key(&existing, "mcp")?,
        McpConfigFormat::CodexToml => remove_codex_toml(&existing),
    };
    if !changed {
        return Ok(false);
    }
    write_atomic_preserving_mode(path, updated.as_bytes())?;
    Ok(true)
}

fn parse_json_object_or_empty(raw: &str) -> Result<Map<String, Value>, String> {
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("INVALID_AGENT_CONFIG: root JSON must be an object".into()),
        Err(e) => Err(format!("INVALID_AGENT_CONFIG: {e}")),
    }
}

fn merge_json_mcp_servers(
    existing: &str,
    command: &str,
    args: &[String],
    token: &str,
    include_stdio_type: bool,
) -> Result<String, String> {
    let mut root = parse_json_object_or_empty(existing)?;
    let servers = match root.get_mut("mcpServers") {
        Some(Value::Object(map)) => map,
        None => {
            root.insert("mcpServers".to_string(), Value::Object(Map::new()));
            root.get_mut("mcpServers")
                .and_then(Value::as_object_mut)
                .ok_or("INVALID_AGENT_CONFIG")?
        }
        Some(_) => return Err("INVALID_AGENT_CONFIG: mcpServers must be an object".into()),
    };

    let mut entry = Map::new();
    if include_stdio_type {
        entry.insert("type".to_string(), json!("stdio"));
    }
    entry.insert("command".to_string(), json!(command));
    entry.insert("args".to_string(), json!(args));
    entry.insert("env".to_string(), json!({ "SHELLBEAM_MCP_TOKEN": token }));
    servers.insert("shellbeam".to_string(), Value::Object(entry));

    let mut out = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("SERIALIZE_CONFIG_FAILED: {e}"))?;
    out.push('\n');
    Ok(out)
}

fn merge_opencode_json(
    existing: &str,
    command: &str,
    args: &[String],
    token: &str,
) -> Result<String, String> {
    let mut root = parse_json_object_or_empty(existing)?;
    let mcp = match root.get_mut("mcp") {
        Some(Value::Object(map)) => map,
        None => {
            root.insert("mcp".to_string(), Value::Object(Map::new()));
            root.get_mut("mcp")
                .and_then(Value::as_object_mut)
                .ok_or("INVALID_AGENT_CONFIG")?
        }
        Some(_) => return Err("INVALID_AGENT_CONFIG: mcp must be an object".into()),
    };

    let mut full_cmd = Vec::with_capacity(1 + args.len());
    full_cmd.push(command.to_string());
    full_cmd.extend(args.iter().cloned());

    mcp.insert(
        "shellbeam".to_string(),
        json!({
            "type": "local",
            "command": full_cmd,
            "environment": { "SHELLBEAM_MCP_TOKEN": token },
            "enabled": true,
        }),
    );

    let mut out = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("SERIALIZE_CONFIG_FAILED: {e}"))?;
    out.push('\n');
    Ok(out)
}

fn remove_json_key(existing: &str, container_key: &str) -> Result<(String, bool), String> {
    let mut root = parse_json_object_or_empty(existing)?;
    let removed = root
        .get_mut(container_key)
        .and_then(Value::as_object_mut)
        .and_then(|map| map.remove("shellbeam"))
        .is_some();
    if !removed {
        return Ok((existing.to_string(), false));
    }
    let mut out = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("SERIALIZE_CONFIG_FAILED: {e}"))?;
    out.push('\n');
    Ok((out, true))
}

fn is_shellbeam_toml_header(trimmed: &str) -> bool {
    trimmed == "[mcp_servers.shellbeam]" || trimmed == "[mcp_servers.shellbeam.env]"
}

fn strip_codex_shellbeam_sections(existing: &str) -> (String, bool) {
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    let mut removed = false;

    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if is_shellbeam_toml_header(trimmed) {
                skipping = true;
                removed = true;
                continue;
            }
            skipping = false;
        }
        if !skipping {
            kept.push(line);
        }
    }

    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    (out, removed)
}

fn merge_codex_toml(existing: &str, command: &str, args: &[String], token: &str) -> String {
    let (mut base, _) = strip_codex_shellbeam_sections(existing);
    if !base.is_empty() {
        base.push('\n');
    }
    let cmd_str = serde_json::to_string(command).unwrap_or_else(|_| "\"\"".to_string());
    let args_str = serde_json::to_string(args).unwrap_or_else(|_| "[]".to_string());
    let token_str = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    base.push_str(&format!(
        "[mcp_servers.shellbeam]\ncommand = {cmd_str}\nargs = {args_str}\n\n[mcp_servers.shellbeam.env]\nSHELLBEAM_MCP_TOKEN = {token_str}\n"
    ));
    base
}

fn remove_codex_toml(existing: &str) -> (String, bool) {
    strip_codex_shellbeam_sections(existing)
}

fn write_atomic_preserving_mode(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("INVALID_CONFIG_PATH")?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("mcp_config");
    let tmp_path = parent.join(format!(
        ".{file_name}.shellbeam-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));

    #[cfg(unix)]
    let existing_mode = fs::metadata(path).ok().map(|m| {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode()
    });

    fs::write(&tmp_path, bytes).map_err(|e| format!("WRITE_CONFIG_FAILED: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Default to owner-only 0600 because the config contains a secret MCP token.
        let mode = existing_mode.unwrap_or(0o600) & 0o777;
        let safe_mode = mode & 0o600;
        let final_mode = if safe_mode == 0 { 0o600 } else { safe_mode };
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(final_mode));
    }

    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("RENAME_CONFIG_FAILED: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shellbeam-agents-test-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn merges_and_removes_json_mcp_servers_preserving_siblings() {
        let dir = temp_dir("json");
        let path = dir.join("mcp.json");
        fs::write(
            &path,
            r#"{ "theme": "dark", "mcpServers": { "other": { "command": "foo" } } }"#,
        )
        .unwrap();

        let args = vec![
            "--mcp-stdio".into(),
            "/tmp/endpoint.json".into(),
            "client-123".into(),
        ];
        install_mcp_config_at_path(
            &path,
            McpConfigFormat::JsonMcpServersStdio,
            "/Applications/ShellBeam.app/Contents/MacOS/shellbeam",
            &args,
            "tok-secret",
        )
        .unwrap();

        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcpServers"]["other"]["command"], "foo");
        assert_eq!(parsed["mcpServers"]["shellbeam"]["type"], "stdio");
        assert_eq!(
            parsed["mcpServers"]["shellbeam"]["env"]["SHELLBEAM_MCP_TOKEN"],
            "tok-secret"
        );
        assert_eq!(
            inspect_configured_entry(&path, McpConfigFormat::JsonMcpServersStdio),
            (true, Some("client-123".into()))
        );

        // Mismatched expected_client_id does NOT remove a newer entry.
        assert!(!uninstall_mcp_config_at_path(
            &path,
            McpConfigFormat::JsonMcpServersStdio,
            Some("other-client")
        )
        .unwrap());
        assert!(uninstall_mcp_config_at_path(
            &path,
            McpConfigFormat::JsonMcpServersStdio,
            Some("client-123")
        )
        .unwrap());

        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["mcpServers"]["other"]["command"], "foo");
        assert!(after["mcpServers"].get("shellbeam").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn handles_empty_zero_byte_json_file_like_antigravity() {
        let dir = temp_dir("empty");
        let path = dir.join("mcp_config.json");
        fs::write(&path, "").unwrap();
        let args = vec!["--mcp-stdio".into(), "/tmp/ep.json".into(), "cid-ag".into()];
        install_mcp_config_at_path(&path, McpConfigFormat::JsonMcpServers, "/app", &args, "tok")
            .unwrap();
        assert_eq!(
            inspect_configured_entry(&path, McpConfigFormat::JsonMcpServers),
            (true, Some("cid-ag".into()))
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_malformed_json_without_clobbering_file() {
        let dir = temp_dir("badjson");
        let path = dir.join("settings.json");
        fs::write(&path, "{ broken json").unwrap();
        let res =
            install_mcp_config_at_path(&path, McpConfigFormat::JsonMcpServers, "/app", &[], "tok");
        assert!(res.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ broken json");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merges_and_removes_opencode_mcp_schema() {
        let dir = temp_dir("opencode");
        let path = dir.join("opencode.json");
        fs::write(
            &path,
            r#"{ "$schema": "https://opencode.ai/config.json", "mcp": { "pencil": { "type": "local", "command": ["p"] } } }"#,
        )
        .unwrap();
        let args = vec!["--mcp-stdio".into(), "/tmp/ep.json".into(), "cid-oc".into()];
        install_mcp_config_at_path(&path, McpConfigFormat::OpenCodeJson, "/app", &args, "tok")
            .unwrap();

        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["mcp"]["pencil"]["type"], "local");
        assert_eq!(parsed["mcp"]["shellbeam"]["type"], "local");
        assert_eq!(parsed["mcp"]["shellbeam"]["enabled"], true);
        assert_eq!(
            parsed["mcp"]["shellbeam"]["command"],
            json!(["/app", "--mcp-stdio", "/tmp/ep.json", "cid-oc"])
        );
        assert_eq!(
            parsed["mcp"]["shellbeam"]["environment"]["SHELLBEAM_MCP_TOKEN"],
            "tok"
        );
        assert_eq!(
            inspect_configured_entry(&path, McpConfigFormat::OpenCodeJson),
            (true, Some("cid-oc".into()))
        );

        assert!(
            uninstall_mcp_config_at_path(&path, McpConfigFormat::OpenCodeJson, Some("cid-oc"))
                .unwrap()
        );
        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(after["mcp"].get("shellbeam").is_none());
        assert!(after["mcp"].get("pencil").is_some());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merges_and_removes_codex_toml_preserving_comments_and_other_tables() {
        let dir = temp_dir("codex");
        let path = dir.join("config.toml");
        let initial = "# User Codex config\nmodel = \"gpt-5\"\n\n[mcp_servers.pencil]\ncommand = \"pencil\"\n\n[mcp_servers.shellbeam]\ncommand = \"old\"\nargs = [\"old\"]\n\n[mcp_servers.shellbeam.env]\nSHELLBEAM_MCP_TOKEN = \"oldtok\"\n\n[mcp_servers.other]\ncommand = \"other\"\n";
        fs::write(&path, initial).unwrap();

        let args = vec!["--mcp-stdio".into(), "/tmp/ep.json".into(), "cid-cx".into()];
        install_mcp_config_at_path(
            &path,
            McpConfigFormat::CodexToml,
            "/new/app",
            &args,
            "newtok",
        )
        .unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("# User Codex config"));
        assert!(content.contains("[mcp_servers.pencil]"));
        assert!(content.contains("[mcp_servers.other]"));
        assert!(!content.contains("oldtok"));
        assert!(content.contains("SHELLBEAM_MCP_TOKEN = \"newtok\""));
        assert_eq!(
            inspect_configured_entry(&path, McpConfigFormat::CodexToml),
            (true, Some("cid-cx".into()))
        );

        assert!(
            uninstall_mcp_config_at_path(&path, McpConfigFormat::CodexToml, Some("cid-cx"))
                .unwrap()
        );
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.contains("# User Codex config"));
        assert!(after.contains("[mcp_servers.pencil]"));
        assert!(after.contains("[mcp_servers.other]"));
        assert!(!after.contains("[mcp_servers.shellbeam]"));
        let _ = fs::remove_dir_all(dir);
    }
}
