use super::policy::{self, Client, ConnectionGrant};
use crate::data::hosts::HostProfile;
use serde_json::{json, Value};

pub fn default_id(host: &HostProfile) -> Option<&str> {
    host.default_connection_id
        .as_deref()
        .or_else(|| host.connections.is_none().then_some(host.id.as_str()))
}

pub fn project(host: &HostProfile, id: Option<&str>) -> Result<HostProfile, String> {
    let id = id
        .or_else(|| default_id(host))
        .ok_or("CONNECTION_REQUIRED")?;
    let mut selected = host.clone();
    if let Some(connections) = &host.connections {
        let c = connections
            .iter()
            .find(|c| c.id == id)
            .ok_or("CONNECTION_NOT_FOUND")?;
        selected.address = c.address.clone();
        selected.port = c.port;
        selected.username = c.username.clone();
        selected.auth_type = c.auth_type.clone();
        selected.secret_key_ref = c.secret_key_ref.clone();
        selected.password_key_ref = c.password_key_ref.clone();
        selected.private_key_ref = c.private_key_ref.clone();
        selected.jump_host_id = c.jump_host_id.clone();
        selected.jump_host = c.jump_host.clone();
        selected.jump_port = c.jump_port;
        selected.jump_user = c.jump_user.clone();
        selected.default_connection_id = Some(c.id.clone());
        selected.connections = Some(vec![c.clone()]);
    } else if id != host.id {
        return Err("CONNECTION_NOT_FOUND".into());
    }
    if !crate::data::host_connections::supports_ssh(&selected) {
        return Err("SSH_CONNECTION_UNAVAILABLE".into());
    }
    Ok(selected)
}

// Re-evaluate when an observation completes: a default/account edit while SSH
// was in flight must not replace the current host's shared observation.
pub fn is_current_default(selected: &HostProfile, hosts: &[HostProfile]) -> bool {
    hosts.iter().any(|host| {
        host.id == selected.id
            && host.created_at == selected.created_at
            && default_id(host) == default_id(selected)
            && policy::identity(host) == policy::identity(selected)
    })
}

pub fn identity(host: &HostProfile, hosts: &[HostProfile]) -> Result<String, String> {
    let jump = host
        .jump_host_id
        .as_ref()
        .map(|id| {
            let jump = hosts
                .iter()
                .find(|h| &h.id == id)
                .ok_or("JUMP_HOST_NOT_FOUND")?;
            Ok::<_, String>(json!([jump.id, jump.created_at, policy::identity(jump)]))
        })
        .transpose()?;
    Ok(policy::digest(
        json!([
            host.created_at,
            default_id(host),
            policy::identity(host),
            jump
        ])
        .to_string(),
    ))
}

pub fn grant(
    host: &HostProfile,
    id: &str,
    hosts: &[HostProfile],
) -> Result<ConnectionGrant, String> {
    let selected = project(host, Some(id))?;
    Ok(ConnectionGrant {
        id: id.into(),
        identity: identity(&selected, hosts)?,
    })
}

pub fn select(
    client: &Client,
    host: &HostProfile,
    id: Option<&str>,
    hosts: &[HostProfile],
) -> Result<HostProfile, String> {
    client.authorize_host(host)?;
    let selected = project(host, id)?;
    let grant = client
        .hosts
        .iter()
        .find(|g| g.id == host.id)
        .ok_or("HOST_NOT_AUTHORIZED")?;
    if let Some(connections) = &grant.connections {
        let authorized = connections
            .iter()
            .find(|g| Some(g.id.as_str()) == default_id(&selected))
            .ok_or("CONNECTION_NOT_AUTHORIZED")?;
        if authorized.identity != identity(&selected, hosts)? {
            return Err("CONNECTION_CHANGED: re-authorize in ShellBeam".into());
        }
    } else if default_id(&selected) != default_id(host)
        || policy::identity(&selected) != policy::identity(host)
    {
        return Err(
            "CONNECTION_NOT_AUTHORIZED: legacy clients may only use the original default".into(),
        );
    }
    Ok(selected)
}

pub fn list(client: &Client, host: &HostProfile, hosts: &[HostProfile]) -> Value {
    let ids: Vec<_> = host
        .connections
        .as_ref()
        .map(|rows| rows.iter().map(|c| c.id.as_str()).collect())
        .unwrap_or_else(|| vec![host.id.as_str()]);
    let rows: Vec<_> = ids.into_iter().filter_map(|id| {
        let selected = select(client, host, Some(id), hosts).ok()?;
        let label = host.connections.as_ref().and_then(|rows| rows.iter().find(|c| c.id == id)).map(|c| c.label.as_str()).unwrap_or("SSH");
        Some(json!({"connectionId":id,"label":label,"address":selected.address,"port":selected.port,"username":selected.username,
            "isDefault":Some(id)==default_id(host),"transport":super::mcp_operation_transport(&selected)}))
    }).collect();
    json!({"hostId":host.id,"connections":rows,"defaultConnectionId":default_id(host),"notice":"Only currently authorized connections are listed. No credential references or values are returned. Selecting a connection never changes the host default."})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (HostProfile, Client) {
        let mut host:HostProfile=serde_json::from_value(json!({"id":"h","name":"Host","address":"192.0.2.1","port":22,"username":"ops","authType":"password","passwordKeyRef":"private-reference","group":"Custom","tags":[],"createdAt":1,"updatedAt":1})).unwrap();
        host.connections=Some(serde_json::from_value(json!([
            {"id":"default","label":"Ops","address":"192.0.2.1","port":22,"username":"ops","authType":"password","passwordKeyRef":"private-reference"},
            {"id":"admin","label":"Admin","address":"192.0.2.1","port":2222,"username":"admin","authType":"privateKey","privateKeyRef":"admin-private-reference"}
        ])).unwrap());
        host.default_connection_id = Some("default".into());
        let client:Client=serde_json::from_value(json!({"id":"client","name":"Agent","vaultId":"vault","hosts":[{"id":"h","identity":policy::identity(&host)}],
            "permissions":{"execute":false,"refresh":false,"readFiles":false,"writeFiles":false},"createdAt":1})).unwrap();
        (host, client)
    }
    #[test]
    fn legacy_grants_never_expand_to_other_accounts() {
        let (host, client) = fixture();
        let hosts = vec![host.clone()];
        assert!(select(&client, &host, None, &hosts).is_ok());
        assert!(select(&client, &host, Some("admin"), &hosts).is_err());
        assert_eq!(
            list(&client, &host, &hosts)["connections"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(!list(&client, &host, &hosts)
            .to_string()
            .contains("private-reference"));
        assert!(client.snippets.is_empty());
        assert!(!client.permissions.inspect);
    }
    #[test]
    fn explicit_grants_select_without_changing_default_and_reject_changed_credentials() {
        let (mut host, mut client) = fixture();
        let hosts = vec![host.clone()];
        client.hosts[0].connections = Some(vec![grant(&host, "admin", &hosts).unwrap()]);
        assert!(select(&client, &host, None, &hosts).is_err());
        let selected = select(&client, &host, Some("admin"), &hosts).unwrap();
        assert_eq!(selected.username, "admin");
        assert_eq!(selected.port, 2222);
        assert_eq!(default_id(&host), Some("default"));
        host.connections.as_mut().unwrap()[1].label = "Renamed".into();
        assert!(select(&client, &host, Some("admin"), &[host.clone()]).is_ok());
        host.connections.as_mut().unwrap()[1].private_key_ref = Some("changed".into());
        assert!(select(&client, &host, Some("admin"), &[host.clone()]).is_err());
    }
    #[test]
    fn only_the_still_current_default_can_publish_shared_observations() {
        let (mut host, _) = fixture();
        let selected = project(&host, None).unwrap();
        assert!(is_current_default(&selected, &[host.clone()]));
        assert!(!is_current_default(
            &project(&host, Some("admin")).unwrap(),
            &[host.clone()]
        ));
        host.default_connection_id = Some("admin".into());
        assert!(!is_current_default(&selected, &[host.clone()]));
        host.default_connection_id = Some("default".into());
        host.created_at = 2;
        assert!(!is_current_default(&selected, &[host]));
        assert!(!is_current_default(&selected, &[]));
    }

    #[test]
    fn jump_route_and_host_creation_identity_are_pinned() {
        let (mut host, mut client) = fixture();
        let mut jump = host.clone();
        jump.id = "jump".into();
        jump.connections = None;
        jump.default_connection_id = None;
        host.connections.as_mut().unwrap()[1].jump_host_id = Some(jump.id.clone());
        let hosts = vec![host.clone(), jump.clone()];
        client.hosts[0].connections = Some(vec![grant(&host, "admin", &hosts).unwrap()]);
        assert!(select(&client, &host, Some("admin"), &hosts).is_ok());
        jump.username = "other-account".into();
        assert!(select(&client, &host, Some("admin"), &[host.clone(), jump]).is_err());
        host.created_at = 2;
        assert!(select(&client, &host, Some("admin"), &hosts).is_err());
    }
}
