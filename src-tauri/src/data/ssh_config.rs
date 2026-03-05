use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    pub alias: String,
    pub host_name: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

fn expand_home(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]);
        }
    }
    PathBuf::from(path)
}

fn ssh_config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh").join("config")
}

fn parse_config_content(content: &str) -> Vec<SshConfigEntry> {
    let mut entries = Vec::new();
    let mut current: Option<HashMap<String, String>> = None;
    let mut current_alias = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (key, value) = match trimmed.split_once(char::is_whitespace) {
            Some((k, v)) => (k.trim().to_lowercase(), v.trim().to_string()),
            None => continue,
        };

        if key == "host" {
            if let Some(fields) = current.take() {
                if !current_alias.contains('*') && !current_alias.contains('?') {
                    entries.push(build_entry(&current_alias, &fields));
                }
            }
            current_alias = value.clone();
            current = Some(HashMap::new());
        } else if let Some(ref mut fields) = current {
            fields.insert(key, value);
        }
    }

    if let Some(fields) = current {
        if !current_alias.contains('*') && !current_alias.contains('?') {
            entries.push(build_entry(&current_alias, &fields));
        }
    }

    entries
}

fn build_entry(alias: &str, fields: &HashMap<String, String>) -> SshConfigEntry {
    SshConfigEntry {
        alias: alias.to_string(),
        host_name: fields.get("hostname").cloned(),
        port: fields.get("port").and_then(|p| p.parse().ok()),
        user: fields.get("user").cloned(),
        identity_file: fields.get("identityfile").map(|p| {
            expand_home(p).to_string_lossy().to_string()
        }),
        proxy_jump: fields.get("proxyjump").cloned(),
    }
}

#[tauri::command]
pub fn parse_ssh_config() -> Result<Vec<SshConfigEntry>, String> {
    let path = ssh_config_path();
    if !path.exists() {
        return Err("SSH config file not found (~/.ssh/config)".to_string());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read SSH config: {e}"))?;
    Ok(parse_config_content(&content))
}
