//! Durable host-scoped notification intent. Interrupted writes are read back,
//! never automatically replayed. Only explicit user retry authorizes a new POST.
use super::{host_metadata, hosts};
use crate::vault::secrets::VaultState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
fn err(_: impl std::fmt::Display) -> String {
    "HOST_RULE_STORE_FAILED".into()
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub enabled: bool,
    pub grace_period: u32,
}
impl Rule {
    fn validate(&self) -> Result<()> {
        if self.grace_period == 0 || self.grace_period > 86400 {
            Err("HOST_RULE_INVALID".into())
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub identity: String,
    pub rule: Option<Rule>,
}
impl Observation {
    fn validate(&self, node: &str) -> Result<()> {
        if !self.identity.starts_with(&format!("{node}:")) || self.identity.len() > 300 {
            return Err("HOST_RULE_IDENTITY_CHANGED".into());
        }
        if let Some(rule) = &self.rule {
            rule.validate()?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleIntent {
    pub id: String,
    pub vault_id: String,
    pub host_id: String,
    pub integration_id: String,
    pub node_id: String,
    pub endpoint: String,
    pub credential_ref: String,
    pub integration_version: i64,
    pub mapping_revision: i64,
    #[serde(default)]
    pub host_created_at: i64,
    pub baseline: Observation,
    pub remote: Observation,
    pub desired: Rule,
    pub status: String,
    pub version: i64,
    pub job_id: String,
    pub error_code: Option<String>,
    pub updated_at: i64,
    pub observed_at: i64,
}
fn initialize(db: &Connection) -> Result<()> {
    host_metadata::initialize(db)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS host_notification_rules(id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,host_id TEXT NOT NULL,integration_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(vault_id,host_id,integration_id))").map_err(err)
}
fn open(app: &tauri::AppHandle) -> Result<Connection> {
    let db = hosts::open_hosts_db(app)?;
    initialize(&db)?;
    Ok(db)
}
fn rows(db: &Connection, vault: &str) -> Result<Vec<RuleIntent>> {
    let mut s = db
        .prepare("SELECT body FROM host_notification_rules WHERE vault_id=?1 ORDER BY id")
        .map_err(err)?;
    let values = s
        .query_map([vault], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    values
        .into_iter()
        .map(|v| serde_json::from_str(&v).map_err(err))
        .collect()
}
fn save(db: &Connection, row: &mut RuleIntent) -> Result<()> {
    row.version += 1;
    row.updated_at = now();
    db.execute("INSERT INTO host_notification_rules(id,vault_id,host_id,integration_id,body) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![row.id,row.vault_id,row.host_id,row.integration_id,serde_json::to_string(row).map_err(err)?]).map_err(err)?;
    Ok(())
}
fn scope(db: &Connection, row: &RuleIntent) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM komari_integrations i JOIN komari_mappings m ON m.integration_id=i.id JOIN workspace_hosts h ON h.vault_id=i.vault_id AND h.id=m.host_id WHERE i.vault_id=?1 AND i.id=?2 AND i.enabled=1 AND i.endpoint=?3 AND i.credential_ref=?4 AND i.updated_at=?5 AND m.host_id=?6 AND m.node_id=?7 AND m.source='manual' AND h.created_at=?9 AND COALESCE((SELECT revision FROM komari_mapping_revisions WHERE integration_id=i.id),0)=?8)",params![row.vault_id,row.integration_id,row.endpoint,row.credential_ref,row.integration_version,row.host_id,row.node_id,row.mapping_revision,row.host_created_at],|r|r.get(0)).map_err(err)
}
fn event(db: &Connection, row: &RuleIntent, status: &str) -> Result<()> {
    host_metadata::record_rule_event(
        db,
        &row.vault_id,
        &row.host_id,
        &row.job_id,
        status,
        &format!(
            "Offline notification rule: {}; desired enabled={}, grace={}s; observed={:?}; no delivery claim",
            row.status, row.desired.enabled, row.desired.grace_period, row.remote.rule
        ),
    )
}
fn invalidate(db: &Connection, row: &mut RuleIntent, code: &str) -> Result<()> {
    row.status = "disabled".into();
    row.error_code = Some(code.into());
    save(db, row)?;
    event(db, row, "unknown")
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRule {
    pub session: u64,
    pub vault_id: String,
    pub host_id: String,
    pub integration_id: String,
    pub node_id: String,
    pub expected_version: i64,
    pub expected_integration_version: i64,
    pub expected_mapping_revision: i64,
    pub remote: Observation,
    pub desired: Rule,
}
fn prepare(db: &Connection, input: SaveRule) -> Result<RuleIntent> {
    input.desired.validate()?;
    input.remote.validate(&input.node_id)?;
    let old = rows(db, &input.vault_id)?
        .into_iter()
        .find(|r| r.host_id == input.host_id && r.integration_id == input.integration_id);
    if old.as_ref().map(|r| r.version).unwrap_or(0) != input.expected_version {
        return Err("HOST_RULE_STALE_EDIT".into());
    }
    if old.as_ref().is_some_and(|r| r.status == "applying") {
        return Err("HOST_RULE_BUSY".into());
    }
    let (endpoint,credential_ref,version):(String,String,i64)=db.query_row("SELECT endpoint,credential_ref,updated_at FROM komari_integrations WHERE vault_id=?1 AND id=?2",params![input.vault_id,input.integration_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"HOST_RULE_SCOPE_CHANGED")?;
    if version != input.expected_integration_version {
        return Err("HOST_RULE_SCOPE_CHANGED".into());
    }
    let host_created_at = db
        .query_row(
            "SELECT created_at FROM workspace_hosts WHERE vault_id=?1 AND id=?2",
            params![input.vault_id, input.host_id],
            |r| r.get(0),
        )
        .map_err(|_| "HOST_RULE_SCOPE_CHANGED")?;
    let mut row = RuleIntent {
        id: old
            .as_ref()
            .map(|r| r.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        vault_id: input.vault_id,
        host_id: input.host_id,
        integration_id: input.integration_id,
        node_id: input.node_id,
        endpoint,
        credential_ref,
        integration_version: version,
        mapping_revision: input.expected_mapping_revision,
        host_created_at,
        baseline: input.remote.clone(),
        remote: input.remote,
        desired: input.desired,
        status: "pending".into(),
        version: input.expected_version,
        job_id: Uuid::new_v4().to_string(),
        error_code: None,
        updated_at: 0,
        observed_at: 0,
    };
    if !scope(db, &row)? {
        return Err("HOST_RULE_SCOPE_CHANGED".into());
    }
    if let Some(old) = old {
        event(db, &old, "cancelled")?;
    }
    // Even an unchanged form requires a fresh service read before verification.
    save(db, &mut row)?;
    event(
        db,
        &row,
        if row.status == "synced" {
            "completed"
        } else {
            "running"
        },
    )?;
    Ok(row)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleAction {
    pub session: u64,
    pub vault_id: String,
    pub id: String,
    pub expected_version: i64,
    pub action: String,
    pub remote: Option<Observation>,
    pub error_code: Option<String>,
}
fn action(db: &Connection, input: RuleAction) -> Result<RuleIntent> {
    let mut row = rows(db, &input.vault_id)?
        .into_iter()
        .find(|r| r.id == input.id)
        .ok_or("HOST_RULE_NOT_FOUND")?;
    if row.version != input.expected_version {
        return Err("HOST_RULE_STALE_EDIT".into());
    }
    if row.status == "disabled" {
        return Err("HOST_RULE_SCOPE_CHANGED".into());
    }
    if !scope(db, &row)? {
        invalidate(db, &mut row, "scope-changed")?;
        return Ok(row);
    }
    let previous_status = row.status.clone();
    let previous_error = row.error_code.clone();
    match input.action.as_str() {
        "observe" => {
            let remote = input.remote.ok_or("HOST_RULE_INVALID")?;
            remote.validate(&row.node_id)?;
            if remote.identity != row.baseline.identity {
                invalidate(db, &mut row, "identity-changed")?;
                return Ok(row);
            }
            row.remote = remote;
            row.observed_at = now();
            if row.remote.rule.as_ref() == Some(&row.desired) {
                row.status = "synced".into();
                row.error_code = None;
            } else if row.status == "synced" {
                // Keep the previous verified job immutable; subsequent external
                // edits have a separate reconciliation record.
                row.job_id = Uuid::new_v4().to_string();
                row.status = "conflict".into();
                row.error_code = Some("external-change".into());
            } else if row.remote != row.baseline {
                row.status = "conflict".into();
                row.error_code = Some("external-change".into());
            } else if row.status == "applying" {
                row.status = "failed".into();
                row.error_code = Some("readback-mismatch".into());
            }
        }
        "sending" => {
            if row.status != "pending" || row.remote != row.baseline {
                return Err("HOST_RULE_STALE_EDIT".into());
            }
            row.status = "applying".into();
            row.error_code = None;
        }
        "error" => {
            row.status = "failed".into();
            row.error_code = Some(
                match input.error_code.as_deref() {
                    Some("permission") => "permission",
                    Some("endpoint-version") => "endpoint-version",
                    Some("invalid-response") => "invalid-response",
                    _ => "unavailable",
                }
                .into(),
            );
        }
        "retry" => {
            if row.status != "failed" || row.remote != row.baseline {
                return Err("HOST_RULE_STALE_EDIT".into());
            }
            row.status = "pending".into();
            row.error_code = None;
        }
        // Explicit conflict resolution always starts a fresh preflight before POST.
        "keep-local" => {
            if row.status != "conflict" {
                return Err("HOST_RULE_STALE_EDIT".into());
            }
            // The previous job may already have completed before an external edit.
            event(db, &row, "cancelled")?;
            row.job_id = Uuid::new_v4().to_string();
            row.baseline = row.remote.clone();
            row.status = "pending".into();
            row.error_code = None;
        }
        "use-remote" | "cancel" => {
            row.status = "disabled".into();
            row.error_code = Some("dismissed".into());
            save(db, &mut row)?;
            event(db, &row, "cancelled")?;
            return Ok(row);
        }
        _ => return Err("HOST_RULE_INVALID".into()),
    }
    save(db, &mut row)?;
    if input.action != "observe" && input.action != "error"
        || row.status != previous_status
        || row.error_code != previous_error
    {
        event(
            db,
            &row,
            if row.status == "synced" {
                "completed"
            } else {
                "running"
            },
        )?;
    }
    Ok(row)
}
#[tauri::command]
pub fn save_host_notification_rule(app: tauri::AppHandle, input: SaveRule) -> Result<RuleIntent> {
    let state = app.state::<VaultState>();
    let vault = input.vault_id.clone();
    state.while_unlocked(&vault, || {
        if state.session_generation() != input.session {
            return Err("HOST_RULE_SCOPE_CHANGED".into());
        }
        let mut db = open(&app)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let row = prepare(&tx, input)?;
        tx.commit().map_err(err)?;
        host_metadata::project(&app, &db)?;
        Ok(row)
    })
}
#[tauri::command]
pub fn host_notification_rule_action(
    app: tauri::AppHandle,
    input: RuleAction,
) -> Result<RuleIntent> {
    let state = app.state::<VaultState>();
    let vault = input.vault_id.clone();
    state.while_unlocked(&vault, || {
        if state.session_generation() != input.session {
            return Err("HOST_RULE_SCOPE_CHANGED".into());
        }
        let mut db = open(&app)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let row = action(&tx, input)?;
        tx.commit().map_err(err)?;
        host_metadata::project(&app, &db)?;
        Ok(row)
    })
}
#[tauri::command]
pub fn list_host_notification_rules(
    app: tauri::AppHandle,
    vault_id: String,
) -> Result<Vec<RuleIntent>> {
    let state = app.state::<VaultState>();
    state.while_unlocked(&vault_id, || {
        let mut db = open(&app)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let mut values = rows(&tx, &vault_id)?;
        for row in &mut values {
            if row.status != "disabled" && !scope(&tx, row)? {
                invalidate(&tx, row, "scope-changed")?;
            }
        }
        tx.commit().map_err(err)?;
        host_metadata::project(&app, &db)?;
        Ok(values)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        hosts::initialize_host_schema(&db).unwrap();
        super::super::komari_persistence::initialize(&db).unwrap();
        initialize(&db).unwrap();
        db.execute_batch("CREATE TABLE komari_integrations(id TEXT PRIMARY KEY,vault_id TEXT,endpoint TEXT,credential_ref TEXT,updated_at INTEGER,enabled INTEGER);INSERT INTO komari_integrations VALUES('i','v','https://monitor.test','keep-reference',1,1);INSERT INTO workspace_hosts(vault_id,id,name,address,port,username,host_group,auth_type,tags_json,created_at,updated_at) VALUES('v','h','WEB','',0,'','prod','password','[]',1,1);INSERT INTO komari_mappings VALUES('i','h','n','manual','explicit',1);INSERT INTO komari_mapping_revisions VALUES('i',2);").unwrap();
        db
    }
    fn observation(enabled: bool, period: u32) -> Observation {
        Observation {
            identity: "n:created-once".into(),
            rule: Some(Rule {
                enabled,
                grace_period: period,
            }),
        }
    }
    fn input() -> SaveRule {
        SaveRule {
            session: 0,
            vault_id: "v".into(),
            host_id: "h".into(),
            integration_id: "i".into(),
            node_id: "n".into(),
            expected_version: 0,
            expected_integration_version: 1,
            expected_mapping_revision: 2,
            remote: observation(false, 180),
            desired: Rule {
                enabled: true,
                grace_period: 120,
            },
        }
    }
    fn apply(
        db: &Connection,
        row: &RuleIntent,
        verb: &str,
        remote: Option<Observation>,
    ) -> Result<RuleIntent> {
        action(
            db,
            RuleAction {
                session: 0,
                vault_id: row.vault_id.clone(),
                id: row.id.clone(),
                expected_version: row.version,
                action: verb.into(),
                remote,
                error_code: None,
            },
        )
    }
    #[test]
    fn persists_intent_and_verifies_only_observed_rules_without_delivery_claims() {
        let db = db();
        let mut row = prepare(&db, input()).unwrap();
        let job = row.job_id.clone();
        assert_eq!(row.status, "pending");
        assert_eq!(rows(&db, "v").unwrap()[0].desired, row.desired);
        row = apply(&db, &row, "observe", Some(observation(false, 180))).unwrap();
        row = apply(&db, &row, "sending", None).unwrap();
        assert_eq!(row.status, "applying");
        row = apply(&db, &row, "observe", Some(observation(true, 120))).unwrap();
        assert_eq!(row.status, "synced");
        assert_eq!(job, row.job_id);
        assert!(apply(&db, &row, "sending", None).is_err());
        let body: String = db
            .query_row(
                "SELECT body FROM host_metadata_events ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(body.contains("completed"));
        assert!(!body.contains("keep-reference"));
        assert!(!body.contains("https://"));
    }
    #[test]
    fn unchanged_input_still_requires_new_observation_and_read_polls_do_not_duplicate_audit() {
        let db = db();
        let mut unchanged = input();
        unchanged.desired = unchanged.remote.rule.clone().unwrap();
        let row = prepare(&db, unchanged).unwrap();
        assert_eq!(row.status, "pending");
        let row = apply(&db, &row, "observe", Some(observation(false, 180))).unwrap();
        assert_eq!(row.status, "synced");
        let count: i64 = db
            .query_row("SELECT count(*) FROM host_metadata_events", [], |r| {
                r.get(0)
            })
            .unwrap();
        apply(&db, &row, "observe", Some(observation(false, 180))).unwrap();
        let after: i64 = db
            .query_row("SELECT count(*) FROM host_metadata_events", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, after);
        let current = rows(&db, "v").unwrap().remove(0);
        let external = apply(&db, &current, "observe", Some(observation(true, 60))).unwrap();
        assert_eq!(external.status, "conflict");
        assert_ne!(external.job_id, row.job_id);
    }

    #[test]
    fn response_loss_reads_back_without_replay_and_mismatch_needs_explicit_retry() {
        let db = db();
        let row = prepare(&db, input()).unwrap();
        let row = apply(&db, &row, "sending", None).unwrap();
        let recovered = apply(&db, &row, "observe", Some(observation(false, 180))).unwrap();
        assert_eq!(recovered.status, "failed");
        assert!(apply(&db, &recovered, "sending", None).is_err());
        let retry = apply(&db, &recovered, "retry", None).unwrap();
        assert_eq!(retry.job_id, row.job_id);
        assert_eq!(retry.status, "pending");
        let sent = apply(&db, &retry, "sending", None).unwrap();
        let failed = apply(&db, &sent, "error", None).unwrap();
        let verified = apply(&db, &failed, "observe", Some(observation(true, 120))).unwrap();
        assert_eq!(verified.status, "synced");
        assert_eq!(verified.job_id, row.job_id);
    }
    #[test]
    fn conflicts_preserve_both_values_and_require_explicit_resolution() {
        let db = db();
        let row = prepare(&db, input()).unwrap();
        let changed = observation(false, 60);
        let conflict = apply(&db, &row, "observe", Some(changed.clone())).unwrap();
        assert_eq!(conflict.status, "conflict");
        assert_eq!(conflict.desired.grace_period, 120);
        assert_eq!(conflict.remote, changed);
        assert!(apply(&db, &conflict, "retry", None).is_err());
        assert!(apply(&db, &conflict, "sending", None).is_err());
        let resolved = apply(&db, &conflict, "keep-local", None).unwrap();
        assert_eq!(resolved.baseline, changed);
        assert_eq!(resolved.status, "pending");
        assert_ne!(resolved.job_id, conflict.job_id);
        let stale = apply(&db, &conflict, "keep-local", None).unwrap_err();
        assert_eq!(stale, "HOST_RULE_STALE_EDIT");
        let cancelled = apply(&db, &resolved, "cancel", None).unwrap();
        assert_eq!(cancelled.status, "disabled");
        assert!(apply(&db, &cancelled, "sending", None).is_err());
    }
    #[test]
    fn scope_identity_and_manual_binding_are_required_for_every_dispatch() {
        for change in [
            "UPDATE komari_integrations SET endpoint='https://other.test'",
            "UPDATE komari_integrations SET enabled=0",
            "UPDATE komari_mapping_revisions SET revision=3",
            "UPDATE komari_mappings SET source='address'",
            "DELETE FROM workspace_hosts",
            "UPDATE workspace_hosts SET created_at=2",
        ] {
            let db = db();
            let row = prepare(&db, input()).unwrap();
            db.execute(change, []).unwrap();
            let stopped = apply(&db, &row, "sending", None).unwrap();
            assert_eq!(stopped.status, "disabled");
            assert_eq!(stopped.error_code.as_deref(), Some("scope-changed"));
        }
        let db = db();
        let row = prepare(&db, input()).unwrap();
        let mut changed = observation(false, 180);
        changed.identity = "n:reinstalled".into();
        assert_eq!(
            apply(&db, &row, "observe", Some(changed)).unwrap().status,
            "disabled"
        );
        let mut foreign = input();
        foreign.vault_id = "other".into();
        assert!(prepare(&db, foreign).is_err());
        let mut stale = input();
        stale.expected_version = 0;
        assert_eq!(prepare(&db, stale).unwrap_err(), "HOST_RULE_STALE_EDIT");
    }
    #[test]
    fn failed_audit_rolls_back_rule_and_disk_reopen_retains_intent() {
        let mut db = db();
        db.execute_batch("CREATE TRIGGER reject_rule_audit BEFORE INSERT ON host_metadata_events BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        {
            let tx = db.transaction().unwrap();
            assert!(prepare(&tx, input()).is_err());
        }
        assert!(rows(&db, "v").unwrap().is_empty());
        db.execute("DROP TRIGGER reject_rule_audit", []).unwrap();
        let row = prepare(&db, input()).unwrap();
        let path = std::env::temp_dir().join(format!("shellbeam-rule-{}.sqlite", Uuid::new_v4()));
        db.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        let reopened = Connection::open(&path).unwrap();
        assert_eq!(rows(&reopened, "v").unwrap()[0].job_id, row.job_id);
        assert_eq!(rows(&reopened, "v").unwrap()[0].desired, row.desired);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn invalid_period_and_duplicate_versions_do_not_overwrite_intent() {
        let db = db();
        let mut invalid = input();
        invalid.desired.grace_period = 0;
        assert!(prepare(&db, invalid).is_err());
        assert!(rows(&db, "v").unwrap().is_empty());
        let row = prepare(&db, input()).unwrap();
        let mut duplicate = input();
        duplicate.desired.grace_period = 90;
        assert_eq!(prepare(&db, duplicate).unwrap_err(), "HOST_RULE_STALE_EDIT");
        assert_eq!(rows(&db, "v").unwrap()[0].desired, row.desired);
    }
}
