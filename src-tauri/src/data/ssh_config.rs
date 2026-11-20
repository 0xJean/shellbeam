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
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ssh")
        .join("config")
}

fn is_git_hosting_domain(domain: &str) -> bool {
    let d = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() {
        return false;
    }

    const KNOWN_GIT_DOMAINS: &[&str] = &[
        "github.com",
        "gitlab.com",
        "gitee.com",
        "bitbucket.org",
        "codeberg.org",
        "git.sr.ht",
        "sr.ht",
        "ssh.dev.azure.com",
        "vs-ssh.visualstudio.com",
        "hf.co",
        "huggingface.co",
    ];

    for &known in KNOWN_GIT_DOMAINS {
        if d == known || d.ends_with(&format!(".{known}")) {
            return true;
        }
    }

    if d.starts_with("git-codecommit.") && d.ends_with(".amazonaws.com") {
        return true;
    }

    false
}

fn is_git_hosting_entry(alias: &str, fields: &HashMap<String, String>) -> bool {
    let hostname = fields.get("hostname").map(|s| s.trim()).unwrap_or(alias);

    // 1. HostName or alias directly matches a known Git hosting domain
    if is_git_hosting_domain(hostname) || is_git_hosting_domain(alias) {
        return true;
    }

    // 2. Git user pattern with git repository service indicators
    let user = fields
        .get("user")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if user == "git" || user == "git-lfs" || user == "gitolite" {
        let host_lower = hostname.to_ascii_lowercase();
        let alias_lower = alias.to_ascii_lowercase();
        if host_lower.contains("github")
            || host_lower.contains("gitlab")
            || host_lower.contains("gitee")
            || host_lower.contains("bitbucket")
            || host_lower.contains("codeberg")
            || host_lower.contains("gitea")
            || host_lower.contains("gogs")
            || host_lower.contains("git-codecommit")
            || host_lower.starts_with("git.")
            || alias_lower.contains("github")
            || alias_lower.contains("gitlab")
            || alias_lower.contains("gitee")
            || alias_lower.contains("bitbucket")
            || alias_lower.contains("codeberg")
            || alias_lower.contains("gitea")
            || alias_lower.contains("gogs")
        {
            return true;
        }
    }

    false
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
                for alias in current_alias.split_whitespace() {
                    if !alias.contains('*')
                        && !alias.contains('?')
                        && !is_git_hosting_entry(alias, &fields)
                    {
                        entries.push(build_entry(alias, &fields));
                    }
                }
            }
            current_alias = value.clone();
            current = Some(HashMap::new());
        } else if let Some(ref mut fields) = current {
            fields.insert(key, value);
        }
    }

    if let Some(fields) = current {
        for alias in current_alias.split_whitespace() {
            if !alias.contains('*') && !alias.contains('?') && !is_git_hosting_entry(alias, &fields)
            {
                entries.push(build_entry(alias, &fields));
            }
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
        identity_file: fields
            .get("identityfile")
            .map(|p| expand_home(p).to_string_lossy().to_string()),
        proxy_jump: fields.get("proxyjump").cloned(),
    }
}

#[tauri::command]
pub fn parse_ssh_config() -> Result<Vec<SshConfigEntry>, String> {
    let path = ssh_config_path();
    if !path.exists() {
        return Err("SSH config file not found (~/.ssh/config)".to_string());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read SSH config: {e}"))?;
    Ok(parse_config_content(&content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filters_github_account_aliases() {
        let content = r#"
Host 0xJean
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_0xjean

Host UstarPay
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ustarpay

Host zorojean318
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_zorojean

Host prod-vps
    HostName 104.21.5.12
    User root
    Port 2222
"#;
        let entries = parse_config_content(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "prod-vps");
        assert_eq!(entries[0].host_name.as_deref(), Some("104.21.5.12"));
        assert_eq!(entries[0].user.as_deref(), Some("root"));
        assert_eq!(entries[0].port, Some(2222));
    }

    #[test]
    fn test_filters_known_git_hosting_services() {
        let content = r#"
Host github.com
    User git

Host gitlab.com
    User git

Host custom-gitlab
    HostName gitlab.company.org
    User git

Host gitee
    HostName gitee.com
    User git

Host bitbucket
    HostName bitbucket.org
    User git

Host codeberg
    HostName codeberg.org
    User git

Host azure-git
    HostName ssh.dev.azure.com
    User git

Host app-server
    HostName 192.168.1.10
    User ubuntu
"#;
        let entries = parse_config_content(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "app-server");
        assert_eq!(entries[0].host_name.as_deref(), Some("192.168.1.10"));
        assert_eq!(entries[0].user.as_deref(), Some("ubuntu"));
    }

    #[test]
    fn test_ignores_wildcards_and_keeps_valid_hosts() {
        let content = r#"
Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3

Host *.internal.corp
    User admin

Host jump-host
    HostName bastion.example.com
    User ops
    Port 22
    ProxyJump none

Host db-host
    HostName 10.0.1.5
    User postgres
    Port 5432
    ProxyJump ops@bastion.example.com:22
"#;
        let entries = parse_config_content(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].alias, "jump-host");
        assert_eq!(entries[1].alias, "db-host");
        assert_eq!(
            entries[1].proxy_jump.as_deref(),
            Some("ops@bastion.example.com:22")
        );
    }
}
