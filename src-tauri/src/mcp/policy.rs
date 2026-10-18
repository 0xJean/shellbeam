use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::data::hosts::HostProfile;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    pub execute: bool,
    pub read_files: bool,
    pub write_files: bool,
    pub refresh: bool,
    /// Allow local Komari, service/check and ProbeProvider lifecycle mutations.
    /// This never grants a remote API/SSH call; it only updates ShellBeam's
    /// persisted alert metadata and creates an OperationJob audit row.
    #[serde(default)]
    pub manage_alerts: bool,
    #[serde(default)]
    pub record_deployments: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGrant {
    pub id: String,
    pub identity: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: String,
    pub name: String,
    pub vault_id: String,
    pub hosts: Vec<HostGrant>,
    pub permissions: Permissions,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub clients: Vec<Client>,
}

pub fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

pub fn identity(host: &HostProfile) -> String {
    // Keep identities of legacy/direct profiles stable. Selecting an
    // independently authenticated jump profile changes the authorized route.
    let mut fields = vec![
        serde_json::json!(host.address),
        serde_json::json!(host.port),
        serde_json::json!(host.username),
        serde_json::json!(host.auth_type),
        serde_json::json!(host.password_key_ref),
        serde_json::json!(host.private_key_ref),
        serde_json::json!(host.secret_key_ref),
        serde_json::json!(host.jump_host),
        serde_json::json!(host.jump_port),
        serde_json::json!(host.jump_user),
    ];
    if let Some(id) = &host.jump_host_id {
        fields.push(serde_json::json!(id));
    }
    digest(serde_json::to_vec(&fields).expect("serialize host identity"))
}

impl Client {
    pub fn public(&self) -> Self {
        let mut client = self.clone();
        client.token_hash = None;
        client
    }

    pub fn authorize_host(&self, host: &HostProfile) -> Result<(), String> {
        let grant = self
            .hosts
            .iter()
            .find(|entry| entry.id == host.id)
            .ok_or("HOST_NOT_AUTHORIZED")?;
        if grant.identity != identity(host) {
            return Err("HOST_CHANGED: re-authorize this server in ShellBeam".into());
        }
        Ok(())
    }

    pub fn allows(&self, tool: &str) -> bool {
        match tool {
            "list_servers"
            | "get_workspace_snapshot"
            | "list_project_deployments"
            | "get_server_inventory"
            | "get_server_probe_state"
            | "get_server_alerts"
            | "get_server_metrics"
            | "get_server_operations"
            | "get_command_result" => true,
            "acknowledge_server_alert" | "close_server_alert" => self.permissions.manage_alerts,
            "refresh_server_info" => self.permissions.refresh,
            "run_command" => self.permissions.execute,
            "read_remote_file" => self.permissions.read_files,
            "write_remote_file" | "upload_file" => self.permissions.write_files,
            "record_project_deployment" => self.permissions.record_deployments,
            _ => false,
        }
    }
}

pub fn authenticate(settings: &Settings, id: &str, token: &str) -> Result<Client, String> {
    if !settings.enabled {
        return Err("MCP_DISABLED".into());
    }
    if token.len() != 64 {
        return Err("UNAUTHORIZED".into());
    }
    let hash = digest(token);
    let client = settings
        .clients
        .iter()
        .find(|client| client.id == id)
        .ok_or("UNAUTHORIZED")?;
    let expected = client.token_hash.as_deref().unwrap_or("");
    // Compare fixed-length hashes without an early-exit prefix comparison.
    let difference = expected
        .bytes()
        .zip(hash.bytes())
        .fold(0u8, |v, (a, b)| v | (a ^ b));
    if expected.len() != hash.len() || difference != 0 {
        return Err("UNAUTHORIZED".into());
    }
    Ok(client.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> Client {
        Client {
            id: "a".into(),
            name: "Agent".into(),
            vault_id: "default".into(),
            hosts: vec![],
            permissions: Permissions::default(),
            created_at: 0,
            token_hash: Some(digest("a".repeat(64))),
        }
    }

    #[test]
    fn disabled_and_wrong_credentials_fail_closed() {
        let mut settings = Settings {
            enabled: false,
            clients: vec![client()],
        };
        assert!(authenticate(&settings, "a", &"a".repeat(64)).is_err());
        settings.enabled = true;
        assert!(authenticate(&settings, "a", &"a".repeat(64)).is_ok());
        assert!(authenticate(&settings, "a", &"b".repeat(64)).is_err());
        assert!(authenticate(&settings, "b", &"a".repeat(64)).is_err());
    }

    #[test]
    fn defaults_are_cached_information_only_and_never_expose_token_hash() {
        let client = client();
        assert!(client.allows("list_servers"));
        assert!(client.allows("get_server_operations"));
        assert!(client.allows("get_server_probe_state"));
        assert!(client.allows("get_server_alerts"));
        assert!(!client.allows("acknowledge_server_alert"));
        assert!(!client.allows("close_server_alert"));
        for tool in [
            "run_command",
            "refresh_server_info",
            "read_remote_file",
            "write_remote_file",
            "upload_file",
            "vault_get_secret",
        ] {
            assert!(!client.allows(tool));
        }
        assert!(serde_json::to_value(client.public())
            .unwrap()
            .get("tokenHash")
            .is_none());
    }

    #[test]
    fn grants_bind_connection_identity_but_allow_label_changes() {
        let mut host: HostProfile = serde_json::from_value(serde_json::json!({
            "id":"h","name":"Dev","address":"192.0.2.1","port":22,"username":"deploy",
            "group":"Development","authType":"password","passwordKeyRef":"secret-a",
            "tags":[],"createdAt":0,"updatedAt":0
        }))
        .unwrap();
        let mut client = client();
        assert!(client.authorize_host(&host).is_err());
        client.hosts.push(HostGrant {
            id: host.id.clone(),
            identity: identity(&host),
        });
        assert!(client.authorize_host(&host).is_ok());
        host.name = "Renamed".into();
        assert!(client.authorize_host(&host).is_ok());
        host.address = "192.0.2.2".into();
        assert!(client.authorize_host(&host).is_err());
        host.address = "192.0.2.1".into();
        host.password_key_ref = Some("secret-b".into());
        assert!(client.authorize_host(&host).is_err());
    }

    #[test]
    fn file_and_command_permissions_are_distinct() {
        let mut client = client();
        assert!(!client.allows("record_project_deployment"));
        client.permissions.record_deployments = true;
        assert!(client.allows("record_project_deployment"));
        client.permissions.read_files = true;
        assert!(client.allows("read_remote_file"));
        assert!(!client.allows("run_command"));
        assert!(!client.allows("write_remote_file"));
        client.permissions.write_files = true;
        assert!(client.allows("upload_file"));
        assert!(!client.allows("run_command"));
    }

    #[test]
    fn manage_alerts_is_local_lifecycle_capability() {
        let mut client = client();
        client.permissions.manage_alerts = true;
        assert!(client.allows("acknowledge_server_alert"));
        assert!(client.allows("close_server_alert"));
        assert!(!client.allows("run_command"));
    }
}
