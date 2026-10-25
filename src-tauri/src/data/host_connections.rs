//! Stable host identity with optional SSH profiles. Legacy columns are a
//! projection of the default connection, never a second editable directory.
use super::hosts::HostProfile;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionProfile {
    pub id: String,
    pub label: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub secret_key_ref: Option<String>,
    pub password_key_ref: Option<String>,
    pub private_key_ref: Option<String>,
    pub jump_host_id: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
}

pub(crate) fn initialize(db: &Connection) -> Result<(), String> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
    let columns = tx
        .prepare("PRAGMA table_info(workspace_hosts)")
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
    for column in [
        "connections_json",
        "default_connection_id",
        "monitoring_mode",
    ] {
        if !columns.iter().any(|c| c == column) {
            tx.execute(
                &format!("ALTER TABLE workspace_hosts ADD COLUMN {column} TEXT"),
                [],
            )
            .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
        }
    }
    tx.commit()
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED".into())
}

/// Connection identity contains references only, never credential values.
pub(crate) fn connection_key(host: &HostProfile) -> String {
    serde_json::json!([
        host.default_connection_id
            .as_deref()
            .or_else(|| host.connections.is_none().then_some(host.id.as_str())),
        host.address,
        host.port,
        host.username,
        host.auth_type,
        host.secret_key_ref,
        host.password_key_ref,
        host.private_key_ref,
        host.jump_host_id,
        host.jump_host,
        host.jump_port,
        host.jump_user
    ])
    .to_string()
}
pub(crate) fn require_connection_key(
    host: &HostProfile,
    expected: Option<&str>,
) -> Result<(), String> {
    if expected.is_some_and(|key| key != connection_key(host)) {
        return Err("HOST_CONNECTION_CHANGED".into());
    }
    Ok(())
}

pub fn supports_ssh(host: &HostProfile) -> bool {
    !host.connections.as_ref().is_some_and(Vec::is_empty)
        && !host.address.trim().is_empty()
        && !host.username.trim().is_empty()
        && host.port > 0
}

pub(crate) fn normalize(host: &mut HostProfile) -> Result<(), String> {
    if host.name.trim().is_empty() {
        return Err("HOST_NAME_REQUIRED".into());
    }
    let Some(connections) = &mut host.connections else {
        return Ok(());
    };
    if connections.len() > 16 {
        return Err("HOST_CONNECTION_LIMIT".into());
    }
    let mut ids = std::collections::HashSet::new();
    for c in connections.iter_mut() {
        c.address = c.address.trim().to_string();
        c.username = c.username.trim().to_string();
        c.label = c.label.trim().to_string();
        for reference in [
            &mut c.secret_key_ref,
            &mut c.password_key_ref,
            &mut c.private_key_ref,
            &mut c.jump_host_id,
            &mut c.jump_host,
            &mut c.jump_user,
        ] {
            *reference = reference
                .take()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
        }
        if c.id.is_empty()
            || c.id.len() > 128
            || !ids.insert(c.id.clone())
            || c.label.is_empty()
            || c.label.len() > 100
            || c.address.is_empty()
            || c.username.is_empty()
            || c.port == 0
            || !["password", "privateKey"].contains(&c.auth_type.as_str())
            || c.jump_host_id.as_ref() == Some(&host.id)
        {
            return Err("HOST_CONNECTION_INVALID".into());
        }
    }
    let selected = connections
        .iter()
        .find(|c| Some(&c.id) == host.default_connection_id.as_ref());
    if !connections.is_empty() && selected.is_none() {
        return Err("HOST_DEFAULT_CONNECTION_REQUIRED".into());
    }
    host.address = selected.map(|c| c.address.clone()).unwrap_or_default();
    host.username = selected.map(|c| c.username.clone()).unwrap_or_default();
    host.port = selected.map(|c| c.port).unwrap_or(0);
    host.auth_type = selected
        .map(|c| c.auth_type.clone())
        .unwrap_or_else(|| "password".into());
    host.secret_key_ref = selected.and_then(|c| c.secret_key_ref.clone());
    host.password_key_ref = selected.and_then(|c| c.password_key_ref.clone());
    host.private_key_ref = selected.and_then(|c| c.private_key_ref.clone());
    host.jump_host_id = selected.and_then(|c| c.jump_host_id.clone());
    host.jump_host = selected.and_then(|c| c.jump_host.clone());
    host.jump_port = selected.and_then(|c| c.jump_port);
    host.jump_user = selected.and_then(|c| c.jump_user.clone());
    if selected.is_none() {
        host.default_connection_id = None;
    }
    Ok(())
}

pub(crate) fn validate_registry_import(
    db: &Connection,
    vault: &str,
    hosts: &[HostProfile],
) -> Result<(), String> {
    let existing: Vec<String> = db
        .prepare(
            "SELECT id FROM workspace_hosts WHERE vault_id=?1 AND connections_json IS NOT NULL",
        )
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?
        .query_map([vault], |r| r.get(0))
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?
        .collect::<Result<_, _>>()
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
    if existing.iter().any(|id| !hosts.iter().any(|h| &h.id == id)) {
        return Err("HOST_DIRECTORY_EXPLICIT_DELETE_REQUIRED".into());
    }
    for host in hosts {
        let stored: Option<Option<String>> = db
            .query_row(
                "SELECT connections_json FROM workspace_hosts WHERE vault_id=?1 AND id=?2",
                params![vault, host.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
        if stored.flatten().is_some() && host.connections.is_none() {
            return Err("HOST_DIRECTORY_CLIENT_UPGRADE_REQUIRED".into());
        }
        let mut copy = host.clone();
        normalize(&mut copy)?;
        if copy.address != host.address
            || copy.username != host.username
            || copy.port != host.port
            || copy.password_key_ref != host.password_key_ref
            || copy.private_key_ref != host.private_key_ref
            || copy.secret_key_ref != host.secret_key_ref
            || copy.auth_type != host.auth_type
            || copy.jump_host_id != host.jump_host_id
            || copy.jump_host != host.jump_host
            || copy.jump_port != host.jump_port
            || copy.jump_user != host.jump_user
            || copy.default_connection_id != host.default_connection_id
        {
            return Err("HOST_CONNECTION_PROJECTION_MISMATCH".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn legacy() -> HostProfile {
        serde_json::from_value(serde_json::json!({"id":"stable","name":"WEB","address":"original","port":2222,"username":"ops","authType":"privateKey","privateKeyRef":"keep-key","group":"prod","tags":["keep"],"createdAt":1,"updatedAt":1})).unwrap()
    }
    fn connection(id: &str) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({"id":id,"label":id,"address":format!("{id}.test"),"port":22,"username":"ops","authType":"privateKey","privateKeyRef":format!("{id}-key")})).unwrap()
    }
    #[test]
    fn reconnect_cannot_silently_use_a_new_connection() {
        let mut host = legacy();
        let key = connection_key(&host);
        require_connection_key(&host, Some(&key)).unwrap();
        host.connections = Some(vec![serde_json::from_value(serde_json::json!({"id":"stable","label":"SSH","address":"original","port":2222,"username":"ops","authType":"privateKey","privateKeyRef":"keep-key"})).unwrap()]);
        host.default_connection_id = Some("stable".into());
        host.name = "Renamed".into();
        normalize(&mut host).unwrap();
        require_connection_key(&host, Some(&key)).unwrap();
        host.private_key_ref = Some("changed-key".into());
        assert_eq!(
            require_connection_key(&host, Some(&key)).unwrap_err(),
            "HOST_CONNECTION_CHANGED"
        );
        require_connection_key(&host, None).unwrap();
    }
    #[test]
    fn monitoring_to_multiple_connections_keeps_identity_and_projects_only_the_default() {
        let mut host = legacy();
        host.connections = Some(vec![]);
        normalize(&mut host).unwrap();
        assert!(!supports_ssh(&host));
        assert_eq!(host.port, 0);
        assert!(host.address.is_empty());
        assert!(host.private_key_ref.is_none());
        host.connections = Some(vec![connection("one"), connection("two")]);
        host.default_connection_id = Some("two".into());
        normalize(&mut host).unwrap();
        assert!(supports_ssh(&host));
        assert_eq!(host.id, "stable");
        assert_eq!(host.created_at, 1);
        assert_eq!(host.address, "two.test");
        assert_eq!(host.private_key_ref.as_deref(), Some("two-key"));
        assert_eq!(
            host.connections.as_ref().unwrap()[0]
                .private_key_ref
                .as_deref(),
            Some("one-key")
        );
        host.default_connection_id = Some("missing".into());
        assert_eq!(
            normalize(&mut host).unwrap_err(),
            "HOST_DEFAULT_CONNECTION_REQUIRED"
        );
        host.connections = Some(vec![connection("same"), connection("same")]);
        assert_eq!(normalize(&mut host).unwrap_err(), "HOST_CONNECTION_INVALID");
    }
    #[test]
    fn disk_migration_and_registry_import_preserve_legacy_refs_and_reject_lossy_clients() {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-directory-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let db = Connection::open(&path).unwrap();
            super::super::hosts::initialize_host_schema(&db).unwrap();
            let old = legacy();
            super::super::hosts::insert_host_row(&db, "a", &old).unwrap();
            initialize(&db).unwrap();
            let row: (Option<String>, String) = db
                .query_row(
                    "SELECT connections_json,private_key_ref FROM workspace_hosts",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(row, (None, "keep-key".into()));
            let mut rich = old.clone();
            rich.connections = Some(vec![connection("primary"), connection("secondary")]);
            rich.default_connection_id = Some("primary".into());
            normalize(&mut rich).unwrap();
            super::super::hosts::insert_host_row(&db, "a", &rich).unwrap();
            assert_eq!(
                validate_registry_import(&db, "a", &[old.clone()]).unwrap_err(),
                "HOST_DIRECTORY_CLIENT_UPGRADE_REQUIRED"
            );
            assert_eq!(
                validate_registry_import(&db, "a", &[]).unwrap_err(),
                "HOST_DIRECTORY_EXPLICIT_DELETE_REQUIRED"
            );
            assert!(validate_registry_import(&db, "b", &[old]).is_ok());
            assert!(validate_registry_import(&db, "a", &[rich.clone()]).is_ok());
            let mut stale = rich.clone();
            stale.jump_host_id = Some("different-jump".into());
            assert_eq!(
                validate_registry_import(&db, "a", &[stale]).unwrap_err(),
                "HOST_CONNECTION_PROJECTION_MISMATCH"
            );
            let mut stale = rich;
            stale.secret_key_ref = Some("unexpected-reference".into());
            assert_eq!(
                validate_registry_import(&db, "a", &[stale]).unwrap_err(),
                "HOST_CONNECTION_PROJECTION_MISMATCH"
            );
        }
        let db = Connection::open(&path).unwrap();
        super::super::hosts::initialize_host_schema(&db).unwrap();
        let saved: String = db
            .query_row(
                "SELECT connections_json FROM workspace_hosts WHERE vault_id='a' AND id='stable'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let rows: Vec<ConnectionProfile> = serde_json::from_str(&saved).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].private_key_ref.as_deref(), Some("secondary-key"));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
