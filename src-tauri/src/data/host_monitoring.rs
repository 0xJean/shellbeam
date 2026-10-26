//! Explicit local monitoring preference. NULL preserves legacy bindings; changing
//! this preference never deletes a binding, stops a remote service or edits secrets.
use rusqlite::{params, Connection};

pub(crate) fn validate(mode: Option<&str>) -> Result<(), String> {
    match mode {
        None | Some("ssh" | "server") => Ok(()),
        _ => Err("HOST_MONITORING_MODE_INVALID".into()),
    }
}

pub(crate) fn require_server(host: &super::hosts::HostProfile) -> Result<(), String> {
    if host.monitoring_mode.as_deref() != Some("server") {
        Err("HOST_MONITORING_SERVER_REQUIRED".into())
    } else {
        Ok(())
    }
}

/// Called for legacy rows only, without writing or migrating their state.
pub(crate) fn legacy_mode(db: &Connection, vault: &str, host: &str) -> Result<String, String> {
    for table in ["komari_mappings", "komari_agent_deployments"] {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|_| "HOST_MONITORING_READ_FAILED")?;
        if !exists {
            continue;
        }
        let sql = if table == "komari_mappings" {
            "SELECT EXISTS(SELECT 1 FROM komari_mappings m JOIN komari_integrations i ON i.id=m.integration_id WHERE i.vault_id=?1 AND m.host_id=?2)"
        } else {
            "SELECT EXISTS(SELECT 1 FROM komari_agent_deployments WHERE vault_id=?1 AND host_id=?2)"
        };
        let linked: bool = db
            .query_row(sql, params![vault, host], |r| r.get(0))
            .map_err(|_| "HOST_MONITORING_READ_FAILED")?;
        if linked {
            return Ok("server".into());
        }
    }
    Ok("ssh".into())
}

/// Fail closed when a new binding or a late sync would override an SSH choice.
pub(crate) fn require_server_row(db: &Connection, vault: &str, host: &str) -> Result<(), String> {
    let mode: Option<String> = db
        .query_row(
            "SELECT monitoring_mode FROM workspace_hosts WHERE vault_id=?1 AND id=?2",
            params![vault, host],
            |r| r.get(0),
        )
        .map_err(|_| "HOST_MONITORING_READ_FAILED")?;
    if mode.as_deref() == Some("ssh") || mode.is_none() && legacy_mode(db, vault, host)? != "server"
    {
        return Err("HOST_MONITORING_SERVER_REQUIRED".into());
    }
    validate(mode.as_deref())
}

/// In-flight syncs must re-read the preference; retain all mappings and history.
pub(crate) fn invalidate_sync(db: &Connection, vault: &str, host: &str) -> Result<(), String> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='komari_mapping_revisions')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "HOST_MONITORING_READ_FAILED")?;
    if exists {
        db.execute("INSERT INTO komari_mapping_revisions(integration_id,revision) SELECT DISTINCT m.integration_id,1 FROM komari_mappings m JOIN komari_integrations i ON i.id=m.integration_id WHERE i.vault_id=?1 AND m.host_id=?2 ON CONFLICT(integration_id) DO UPDATE SET revision=revision+1", params![vault,host]).map_err(|_| "HOST_MONITORING_SAVE_FAILED")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::hosts::{initialize_host_schema, insert_host_row, HostProfile};
    fn host(mode: Option<&str>) -> HostProfile {
        serde_json::from_value(serde_json::json!({"id":"h","name":"WEB","address":"fixture.invalid","port":22,"username":"ops","group":"prod","authType":"privateKey","privateKeyRef":"keep-ref","tags":["keep"],"createdAt":1,"updatedAt":2,"monitoringMode":mode})).unwrap()
    }
    #[test]
    fn old_rows_and_vaults_retain_their_own_monitoring_without_any_writes() {
        let db = Connection::open_in_memory().unwrap();
        initialize_host_schema(&db).unwrap();
        insert_host_row(&db, "v", &host(None)).unwrap();
        insert_host_row(&db, "other", &host(None)).unwrap();
        assert_eq!(legacy_mode(&db, "v", "h").unwrap(), "ssh");
        db.execute_batch("CREATE TABLE komari_integrations(id TEXT PRIMARY KEY,vault_id TEXT); CREATE TABLE komari_mappings(integration_id TEXT,host_id TEXT); CREATE TABLE komari_mapping_revisions(integration_id TEXT PRIMARY KEY,revision INTEGER); INSERT INTO komari_integrations VALUES('s','v'),('foreign','other'); INSERT INTO komari_mappings VALUES('s','h');").unwrap();
        let changes = db.total_changes();
        assert_eq!(legacy_mode(&db, "v", "h").unwrap(), "server");
        assert_eq!(legacy_mode(&db, "other", "h").unwrap(), "ssh");
        assert_eq!(db.total_changes(), changes);
        require_server_row(&db, "v", "h").unwrap();
        assert!(require_server_row(&db, "other", "h").is_err());
        insert_host_row(&db, "v", &host(Some("ssh"))).unwrap();
        assert!(require_server_row(&db, "v", "h").is_err());
        invalidate_sync(&db, "v", "h").unwrap();
        assert_eq!(
            db.query_row(
                "SELECT revision FROM komari_mapping_revisions WHERE integration_id='s'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM komari_mappings", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn choice_survives_reopen_and_old_client_upsert_without_losing_credentials_or_audit() {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-monitoring-choice-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let db = Connection::open(&path).unwrap();
            initialize_host_schema(&db).unwrap();
            insert_host_row(&db, "v", &host(Some("server"))).unwrap();
            crate::data::host_metadata::record_directory_edit(
                &db,
                "v",
                "h",
                "host.directory.monitoring.server",
            )
            .unwrap();
        }
        {
            let db = Connection::open(&path).unwrap();
            initialize_host_schema(&db).unwrap();
            insert_host_row(&db, "v", &host(None)).unwrap();
            let (mode,key,tags): (String,String,String) = db.query_row("SELECT monitoring_mode,private_key_ref,tags_json FROM workspace_hosts WHERE vault_id='v' AND id='h'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
            assert_eq!(
                (mode.as_str(), key.as_str(), tags.as_str()),
                ("server", "keep-ref", "[\"keep\"]")
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM host_metadata_events", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert!(insert_host_row(&db, "v", &host(Some("automatic-install"))).is_err());
            require_server_row(&db, "v", "h").unwrap();
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn install_admission_requires_explicit_server_choice() {
        assert!(require_server(&host(Some("ssh"))).is_err());
        assert!(require_server(&host(None)).is_err());
        assert!(require_server(&host(Some("server"))).is_ok());
    }
}
