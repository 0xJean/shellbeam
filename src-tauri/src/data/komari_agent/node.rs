//! Creates a monitoring node on the linked ShellBeam Server for a host that has
//! none yet, then records the host ↔ node link through the same revision-checked
//! mapping edit the settings panel uses. Nothing is installed on the host.
use super::{hosts, komari, komari_persistence, service};
use crate::vault::VaultState;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNode {
    vault_id: String,
    integration_id: String,
    host_id: String,
    expected_revision: i64,
}

#[tauri::command]
pub async fn komari_agent_create_node(
    app: tauri::AppHandle,
    input: CreateNode,
) -> Result<komari_persistence::KomariMappingState, String> {
    tauri::async_runtime::spawn_blocking(move || create_node(&app, input))
        .await
        .map_err(|_| "KOMARI_AGENT_INTERNAL")?
}

fn admin_rpc(
    remote: &service::Remote,
    token: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    remote.call(
        "/api/rpc2",
        Some(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})),
        Some(token),
        None,
    )
}

/// Node names are display labels on the Server; keep them short and printable.
pub(super) fn node_name(host_name: &str) -> String {
    let name: String = host_name
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "ShellBeam host".into()
    } else {
        name.into()
    }
}

fn create_node(
    app: &tauri::AppHandle,
    input: CreateNode,
) -> Result<komari_persistence::KomariMappingState, String> {
    if !app.state::<VaultState>().is_unlocked(&input.vault_id) {
        return Err("KOMARI_AGENT_SCOPE_CHANGED".into());
    }
    let host = hosts::load_hosts(app, Some(&input.vault_id))?
        .into_iter()
        .find(|h| h.id == input.host_id)
        .ok_or("KOMARI_AGENT_HOST_CHANGED")?;
    // The mapping edit enforces this too; checking first avoids creating a node it would refuse.
    super::super::host_monitoring::require_server(&host)?;
    let integration = komari::list_komari_integrations(app.clone(), input.vault_id.clone())?
        .into_iter()
        .find(|s| s.id == input.integration_id && s.enabled)
        .ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
    let state = komari_persistence::get_komari_mapping_state(
        app.clone(),
        input.vault_id.clone(),
        input.integration_id.clone(),
    )?;
    if state.revision != input.expected_revision {
        return Err("KOMARI_MAPPING_CONFLICT".into());
    }
    if state.mappings.iter().any(|m| m.host_id == host.id) {
        return Err("KOMARI_MAPPING_HOST_ALREADY_BOUND".into());
    }

    let scope = service::monitoring_service_context(app.clone(), integration)?;
    let remote = service::Remote::new(app, &scope)?;
    let token = service::secret(app, &scope)?;
    remote.version(Some(&token))?;
    let created = admin_rpc(
        &remote,
        &token,
        "admin:addClient",
        json!({ "name": node_name(&host.name) }),
    )?;
    let node = created["uuid"]
        .as_str()
        .ok_or("KOMARI_AGENT_NODE_INVALID")?
        .to_string();
    Uuid::parse_str(&node).map_err(|_| "KOMARI_AGENT_NODE_INVALID")?;

    let saved = komari_persistence::edit_komari_mapping(
        app.clone(),
        komari_persistence::KomariMappingEdit {
            vault_id: input.vault_id,
            integration_id: input.integration_id,
            node_id: node.clone(),
            host_id: Some(host.id),
            expected_revision: input.expected_revision,
        },
    );
    if saved.is_err() {
        // Do not leave an unlinked node behind when the link could not be recorded.
        let _ = admin_rpc(
            &remote,
            &token,
            "admin:removeClient",
            json!({ "uuid": node }),
        );
    }
    saved
}

#[cfg(test)]
mod node_name_tests {
    use super::node_name;

    #[test]
    fn keeps_printable_names_and_falls_back_when_empty() {
        assert_eq!(node_name("redis-cache"), "redis-cache");
        assert_eq!(node_name("  \n\t "), "ShellBeam host");
        assert_eq!(node_name(&"x".repeat(100)).len(), 64);
        assert_eq!(node_name("a\u{7}b"), "ab");
    }
}
