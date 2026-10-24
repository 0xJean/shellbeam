//! Vault/host-scoped canonical local-rule and endpoint-check observations.
//! Shares the application observation database; revision checks prevent an old
//! renderer snapshot from overwriting a confirmed lifecycle action.
use crate::data::{hosts, operation_jobs};
use crate::storage::{data_file_path, now_unix_ms};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DB: &str = "workspace_inventory.sqlite3";
const KINDS: &[&str] = &[
    "alert-rules",
    "alert-state",
    "health-checks",
    "health-history",
    "scheduled-tasks",
];
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOpsDocument {
    pub vault_id: String,
    pub host_id: String,
    pub kind: String,
    pub payload: Value,
    pub revision: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalOpsQuery {
    pub vault_id: String,
    pub host_id: String,
    pub kind: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalOpsUpsert {
    pub vault_id: String,
    pub host_id: String,
    pub kind: String,
    pub payload: Value,
    pub expected_revision: i64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalOpsAlertAction {
    pub vault_id: String,
    pub host_id: String,
    pub rule_id: String,
    pub action: String,
    pub operation_job_id: String,
}
fn initialize(db: &Connection) -> Result<(), String> {
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS local_ops_documents(vault_id TEXT NOT NULL,host_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(vault_id,host_id,kind));").map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    Ok(())
}
fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_database(&data_file_path(app, DB)?)
}
pub(crate) fn open_database(path: &std::path::Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    initialize(&db)?;
    Ok(db)
}
fn identity(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 240 || value.chars().any(char::is_control) {
        return Err("LOCAL_OPS_INVALID_SCOPE".into());
    }
    Ok(())
}
fn scope(app: &tauri::AppHandle, vault: &str, host: &str) -> Result<(), String> {
    identity(vault)?;
    identity(host)?;
    if !hosts::load_hosts(app, Some(vault))?
        .iter()
        .any(|row| row.id == host)
    {
        return Err("LOCAL_OPS_HOST_NOT_FOUND".into());
    }
    Ok(())
}
fn object(value: &Value, keys: &[&str], required: &[&str]) -> Result<(), String> {
    let raw = value.as_object().ok_or("LOCAL_OPS_INVALID_DOCUMENT")?;
    if raw.keys().any(|key| !keys.contains(&key.as_str()))
        || required.iter().any(|key| !raw.contains_key(*key))
    {
        return Err("LOCAL_OPS_INVALID_DOCUMENT".into());
    }
    for item in raw.values() {
        if item.is_object() || item.is_array() {
            return Err("LOCAL_OPS_INVALID_DOCUMENT".into());
        }
        if let Some(text) = item.as_str() {
            if text.len() > 2_048 || text.chars().any(char::is_control) {
                return Err("LOCAL_OPS_INVALID_DOCUMENT".into());
            }
        }
    }
    Ok(())
}
fn rows<'a>(value: &'a Value, max: usize) -> Result<&'a Vec<Value>, String> {
    let rows = value.as_array().ok_or("LOCAL_OPS_INVALID_DOCUMENT")?;
    if rows.len() > max {
        return Err("LOCAL_OPS_DOCUMENT_TOO_LARGE".into());
    }
    Ok(rows)
}
fn own_host(row: &Value, host: &str) -> Result<(), String> {
    if row["hostId"].as_str() != Some(host) {
        return Err("LOCAL_OPS_HOST_MISMATCH".into());
    }
    Ok(())
}
fn enum_field(row: &Value, key: &str, values: &[&str]) -> Result<(), String> {
    if !row[key]
        .as_str()
        .is_some_and(|value| values.contains(&value))
    {
        return Err("LOCAL_OPS_INVALID_DOCUMENT".into());
    }
    Ok(())
}
fn validate_document(kind: &str, payload: &Value, host: &str) -> Result<(), String> {
    if !KINDS.contains(&kind) {
        return Err("LOCAL_OPS_INVALID_KIND".into());
    }
    if serde_json::to_vec(payload)
        .map_err(|_| "LOCAL_OPS_INVALID_DOCUMENT")?
        .len()
        > 1_048_576
    {
        return Err("LOCAL_OPS_DOCUMENT_TOO_LARGE".into());
    }
    match kind {
        "alert-state" => {
            let state = payload.as_object().ok_or("LOCAL_OPS_INVALID_DOCUMENT")?;
            if state
                .keys()
                .any(|key| !["version", "alerts", "evaluations", "audit"].contains(&key.as_str()))
                || payload["version"] != 1
            {
                return Err("LOCAL_OPS_INVALID_DOCUMENT".into());
            }
            for row in rows(&payload["alerts"], 100)? {
                object(
                    row,
                    &[
                        "ruleId",
                        "hostId",
                        "name",
                        "metric",
                        "status",
                        "severity",
                        "openedAt",
                        "updatedAt",
                        "resolvedAt",
                        "value",
                        "source",
                        "transport",
                        "operationJobId",
                    ],
                    &["ruleId", "hostId", "status", "metric", "severity"],
                )?;
                own_host(row, host)?;
                enum_field(
                    row,
                    "status",
                    &["active", "acknowledged", "resolved", "closed"],
                )?;
                enum_field(
                    row,
                    "metric",
                    &[
                        "cpu",
                        "memory",
                        "disk",
                        "service",
                        "health-check",
                        "probe-provider",
                    ],
                )?;
                enum_field(row, "severity", &["info", "warning", "critical"])?;
            }
            for row in rows(&payload["evaluations"], 100)? {
                object(
                    row,
                    &[
                        "ruleId",
                        "sampledAt",
                        "pendingSince",
                        "recoverySince",
                        "state",
                        "value",
                    ],
                    &["ruleId", "sampledAt", "state"],
                )?;
            }
            for row in rows(&payload["audit"], 500)? {
                object(
                    row,
                    &[
                        "id",
                        "ruleId",
                        "hostId",
                        "event",
                        "at",
                        "actor",
                        "status",
                        "name",
                        "severity",
                        "operationJobId",
                    ],
                    &["id", "ruleId", "hostId", "event", "at"],
                )?;
                own_host(row, host)?;
                enum_field(
                    row,
                    "event",
                    &["opened", "reopened", "resolved", "acknowledged", "closed"],
                )?;
            }
        }
        "health-history" => {
            for row in rows(payload, 500)? {
                object(
                    row,
                    &[
                        "checkId",
                        "hostId",
                        "status",
                        "checkedAt",
                        "durationMs",
                        "latencyMs",
                        "transport",
                        "provider",
                        "statusCode",
                        "errorCode",
                        "errorSummary",
                        "nextCheckAt",
                    ],
                    &["checkId", "hostId", "status", "checkedAt", "nextCheckAt"],
                )?;
                own_host(row, host)?;
                enum_field(row, "status", &["passing", "failing", "unknown"])?;
                // Do not permit arbitrary transport output in the diagnostics field.
                if let Some(summary) = row["errorSummary"].as_str() {
                    if ![
                        "invalid-target",
                        "timeout",
                        "jump-unavailable",
                        "auth",
                        "network",
                        "http-status",
                        "command",
                        "unknown",
                    ]
                    .contains(&summary)
                    {
                        return Err("LOCAL_OPS_UNSAFE_DIAGNOSTICS".into());
                    }
                }
            }
        }
        "alert-rules" => {
            for row in rows(payload, 32)? {
                object(
                    row,
                    &[
                        "id",
                        "hostId",
                        "name",
                        "metric",
                        "target",
                        "threshold",
                        "recoveryThreshold",
                        "durationMs",
                        "recoveryDurationMs",
                        "freshnessMs",
                        "severity",
                        "enabled",
                    ],
                    &["id", "hostId", "name", "metric"],
                )?;
                own_host(row, host)?;
                enum_field(
                    row,
                    "metric",
                    &[
                        "cpu",
                        "memory",
                        "disk",
                        "service",
                        "health-check",
                        "probe-provider",
                    ],
                )?;
                if row["metric"] == "probe-provider"
                    && row["target"]
                        .as_str()
                        .map_or(true, |target| target.trim().is_empty())
                {
                    return Err("LOCAL_OPS_INVALID_DOCUMENT".into());
                }
            }
        }
        "health-checks" => {
            for row in rows(payload, 32)? {
                object(
                    row,
                    &[
                        "id",
                        "hostId",
                        "name",
                        "kind",
                        "target",
                        "port",
                        "path",
                        "expectedStatus",
                        "timeoutMs",
                        "intervalMs",
                        "enabled",
                        "alertAfterMs",
                        "recoveryAfterMs",
                    ],
                    &["id", "hostId", "kind", "target"],
                )?;
                own_host(row, host)?;
                enum_field(row, "kind", &["tcp", "http"])?;
            }
        }
        "scheduled-tasks" => {
            for row in rows(payload, 32)? {
                object(
                    row,
                    &[
                        "id",
                        "hostId",
                        "name",
                        "command",
                        "intervalMinutes",
                        "enabled",
                        "lastRunAt",
                        "nextRunAt",
                        "lastStatus",
                        "lastResultSummary",
                        "lastErrorSummary",
                        "createdAt",
                        "updatedAt",
                        "authorizationJobId",
                        "pausedReason",
                    ],
                    &["id", "hostId", "name", "command"],
                )?;
                own_host(row, host)?;
            }
        }
        _ => return Err("LOCAL_OPS_INVALID_KIND".into()),
    }
    Ok(())
}
fn read(
    db: &Connection,
    vault: &str,
    host: &str,
    kind: &str,
) -> Result<Option<LocalOpsDocument>, String> {
    db.query_row("SELECT payload_json,revision,updated_at FROM local_ops_documents WHERE vault_id=?1 AND host_id=?2 AND kind=?3", params![vault,host,kind], |row| {
        let raw: String = row.get(0)?;
        Ok((raw,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?))
    }).optional().map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE".to_owned())?.map(|(raw, revision, updated_at)| Ok(LocalOpsDocument { vault_id: vault.into(),host_id: host.into(),kind: kind.into(),payload: serde_json::from_str(&raw).map_err(|_| "LOCAL_OPS_INVALID_DOCUMENT")?,revision,updated_at })).transpose()
}
fn upsert(db: &mut Connection, request: &LocalOpsUpsert) -> Result<LocalOpsDocument, String> {
    identity(&request.vault_id)?;
    identity(&request.host_id)?;
    validate_document(&request.kind, &request.payload, &request.host_id)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    let revision = read(&tx, &request.vault_id, &request.host_id, &request.kind)?
        .map_or(0, |row| row.revision);
    if request.expected_revision != revision {
        return Err("LOCAL_OPS_REVISION_CONFLICT".into());
    }
    let updated_at = now_unix_ms();
    let revision = revision + 1;
    tx.execute("INSERT INTO local_ops_documents(vault_id,host_id,kind,payload_json,revision,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(vault_id,host_id,kind) DO UPDATE SET payload_json=excluded.payload_json,revision=excluded.revision,updated_at=excluded.updated_at", params![request.vault_id,request.host_id,request.kind,request.payload.to_string(),revision,updated_at]).map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    tx.commit().map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    Ok(LocalOpsDocument {
        vault_id: request.vault_id.clone(),
        host_id: request.host_id.clone(),
        kind: request.kind.clone(),
        payload: request.payload.clone(),
        revision,
        updated_at,
    })
}
#[tauri::command]
pub fn local_ops_list(
    app: tauri::AppHandle,
    query: LocalOpsQuery,
) -> Result<Vec<LocalOpsDocument>, String> {
    scope(&app, &query.vault_id, &query.host_id)?;
    let db = open(&app)?;
    let kinds = query
        .kind
        .as_deref()
        .map_or_else(|| KINDS.to_vec(), |kind| vec![kind]);
    let mut result = Vec::new();
    for kind in kinds {
        if !KINDS.contains(&kind) {
            return Err("LOCAL_OPS_INVALID_KIND".into());
        }
        if let Some(row) = read(&db, &query.vault_id, &query.host_id, kind)? {
            result.push(row);
        }
    }
    Ok(result)
}
#[tauri::command]
pub fn local_ops_upsert(
    app: tauri::AppHandle,
    payload: LocalOpsUpsert,
) -> Result<LocalOpsDocument, String> {
    scope(&app, &payload.vault_id, &payload.host_id)?;
    upsert(&mut open(&app)?, &payload)
}
fn validate_action_job(
    job: &operation_jobs::OperationJob,
    request: &LocalOpsAlertAction,
) -> Result<(), String> {
    if job.job_id != request.operation_job_id
        || job.host_id.as_deref() != Some(&request.host_id)
        || job.vault_id.as_deref() != Some(&request.vault_id)
        || job.target != request.rule_id
        || job.action != format!("local-alert.{}", request.action)
        || job.status != "running"
        || job.confirmation_status != "confirmed"
        || !job.confirmation_required
    {
        return Err("LOCAL_OPS_CONFIRMED_JOB_REQUIRED".into());
    }
    Ok(())
}
#[tauri::command]
pub fn local_ops_alert_action(
    app: tauri::AppHandle,
    payload: LocalOpsAlertAction,
) -> Result<LocalOpsDocument, String> {
    scope(&app, &payload.vault_id, &payload.host_id)?;
    identity(&payload.rule_id)?;
    if payload.action != "acknowledge" && payload.action != "close" {
        return Err("LOCAL_OPS_INVALID_ACTION".into());
    }
    let job = operation_jobs::operation_job_get(app.clone(), payload.operation_job_id.clone())?
        .ok_or("LOCAL_OPS_CONFIRMED_JOB_REQUIRED")?;
    apply_alert_action_on(&mut open(&app)?, &payload, &job, now_unix_ms())
}
fn apply_alert_action_on(
    db: &mut Connection,
    payload: &LocalOpsAlertAction,
    job: &operation_jobs::OperationJob,
    now: i64,
) -> Result<LocalOpsDocument, String> {
    validate_action_job(job, payload)?;
    mutate_alert_on(db, payload, None, "local-user", now)
}

/// The authenticated MCP caller must hold its current permission/host grant
/// through this call. This is deliberately not a Tauri command: UI actions
/// continue to require their own confirmed, running OperationJob above.
pub(crate) fn apply_authorized_mcp_alert_action(
    app: &tauri::AppHandle,
    client_id: &str,
    payload: &LocalOpsAlertAction,
    expected_revision: i64,
) -> Result<LocalOpsDocument, String> {
    scope(app, &payload.vault_id, &payload.host_id)?;
    let job = operation_jobs::operation_job_get(app.clone(), payload.operation_job_id.clone())?
        .ok_or("LOCAL_OPS_AUTHORIZED_MCP_JOB_REQUIRED")?;
    apply_authorized_mcp_alert_action_on(
        &mut open(app)?,
        client_id,
        payload,
        &job,
        expected_revision,
        now_unix_ms(),
    )
}

pub(crate) fn apply_authorized_mcp_alert_action_on(
    db: &mut Connection,
    client_id: &str,
    payload: &LocalOpsAlertAction,
    job: &operation_jobs::OperationJob,
    expected_revision: i64,
    now: i64,
) -> Result<LocalOpsDocument, String> {
    identity(client_id)?;
    identity(&payload.rule_id)?;
    let tool = match payload.action.as_str() {
        "acknowledge" => "acknowledge_server_alert",
        "close" => "close_server_alert",
        _ => return Err("LOCAL_OPS_INVALID_ACTION".into()),
    };
    let actor = format!("mcp-client:{client_id}");
    if expected_revision < 0
        || job.job_id != payload.operation_job_id
        || job.host_id.as_deref() != Some(&payload.host_id)
        || job.vault_id.as_deref() != Some(&payload.vault_id)
        || job.source != "mcp"
        || job.actor != actor
        || job.action != format!("mcp.{tool}")
        || job.target != payload.rule_id
        || job.provider != "local-ops"
        || job.transport != "local"
        || job.status != "running"
        || job.confirmation_required
        || job.confirmation_status != "not_required"
        || job.request_id.as_deref().map_or(true, str::is_empty)
    {
        return Err("LOCAL_OPS_AUTHORIZED_MCP_JOB_REQUIRED".into());
    }
    mutate_alert_on(db, payload, Some(expected_revision), &actor, now)
}

fn mutate_alert_on(
    db: &mut Connection,
    payload: &LocalOpsAlertAction,
    expected_revision: Option<i64>,
    actor: &str,
    now: i64,
) -> Result<LocalOpsDocument, String> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    let mut document = read(&tx, &payload.vault_id, &payload.host_id, "alert-state")?
        .ok_or("LOCAL_OPS_ALERT_NOT_FOUND")?;
    if expected_revision.is_some_and(|revision| revision != document.revision) {
        return Err("LOCAL_OPS_REVISION_CONFLICT".into());
    }
    apply_alert_action(&mut document.payload, payload, now, actor)?;
    validate_document("alert-state", &document.payload, &payload.host_id)?;
    document.revision += 1;
    document.updated_at = now;
    tx.execute("UPDATE local_ops_documents SET payload_json=?1,revision=?2,updated_at=?3 WHERE vault_id=?4 AND host_id=?5 AND kind='alert-state'",params![document.payload.to_string(),document.revision,document.updated_at,payload.vault_id,payload.host_id]).map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    tx.commit().map_err(|_| "LOCAL_OPS_DATABASE_UNAVAILABLE")?;
    Ok(document)
}
fn apply_alert_action(
    state: &mut Value,
    request: &LocalOpsAlertAction,
    now: i64,
    actor: &str,
) -> Result<(), String> {
    let alerts = state["alerts"]
        .as_array_mut()
        .ok_or("LOCAL_OPS_INVALID_DOCUMENT")?;
    let alert = alerts
        .iter_mut()
        .find(|row| row["hostId"] == request.host_id && row["ruleId"] == request.rule_id)
        .ok_or("LOCAL_OPS_ALERT_NOT_FOUND")?;
    let status = if request.action == "acknowledge" {
        if alert["status"] != "active" {
            return Ok(());
        }
        "acknowledged"
    } else {
        if alert["status"] == "closed" {
            return Ok(());
        }
        "closed"
    };
    alert["status"] = json!(status);
    alert["updatedAt"] = json!(now);
    alert["operationJobId"] = json!(request.operation_job_id);
    let audit = json!({"id":uuid::Uuid::new_v4().to_string(),"hostId":request.host_id,"ruleId":request.rule_id,"event":status,"status":status,"at":now,"actor":actor,"name":alert["name"],"severity":alert["severity"],"operationJobId":request.operation_job_id});
    let audits = state["audit"]
        .as_array_mut()
        .ok_or("LOCAL_OPS_INVALID_DOCUMENT")?;
    audits.push(audit);
    if audits.len() > 500 {
        audits.drain(..audits.len() - 500);
    }
    Ok(())
}
/// Caller must already enforce MCP client/host grants. The exact vault+host
/// scope is checked again here; commands/configuration never leave this view.
pub fn read_for_mcp(app: &tauri::AppHandle, vault: &str, host: &str) -> Result<Value, String> {
    scope(app, vault, host)?;
    let db = open(app)?;
    let state = read(&db, vault, host, "alert-state")?;
    let history = read(&db, vault, host, "health-history")?;
    Ok(
        json!({"source":"local-ops","revision":state.as_ref().map(|row|row.revision),"alerts":state.as_ref().map(|row| &row.payload["alerts"]).unwrap_or(&Value::Null),"audit":state.as_ref().map(|row| &row.payload["audit"]).unwrap_or(&Value::Null),"healthCheckHistory":history.as_ref().map(|row| &row.payload).unwrap_or(&Value::Null),"updatedAt":state.as_ref().map_or(0,|row|row.updated_at).max(history.as_ref().map_or(0,|row|row.updated_at)),"observedAt":now_unix_ms(),"notice":"Cached observations only. Missing/stale data is unknown; no remote command or credentials are exposed. Local lifecycle writes require alertSource=local-ops, ruleId and this revision as expectedRevision."}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db
    }
    fn state() -> Value {
        json!({"version":1,"alerts":[{"ruleId":"cpu","hostId":"host","name":"CPU","metric":"cpu","status":"active","severity":"critical","openedAt":1,"updatedAt":1,"resolvedAt":null,"value":99,"source":"ssh-agentless","transport":"proxy-jump"}],"evaluations":[],"audit":[]})
    }
    const PROBE_RULE: &str = "probe:ssh-agentless:hash:metrics";
    fn probe_state() -> Value {
        json!({"version":1,"alerts":[{"ruleId":PROBE_RULE,"hostId":"host","name":"Probe collection unavailable","metric":"probe-provider","status":"active","severity":"warning","openedAt":1,"updatedAt":1,"resolvedAt":null,"value":1,"source":"ssh-agentless","transport":"proxy-jump"}],"evaluations":[{"ruleId":PROBE_RULE,"sampledAt":1,"pendingSince":null,"recoverySince":null,"state":"firing","value":1}],"audit":[{"id":"probe-opened","ruleId":PROBE_RULE,"hostId":"host","event":"opened","at":1,"actor":"local-ops-runtime","status":"active","name":"Probe collection unavailable","severity":"warning"}]})
    }
    struct StoreDirectory(std::path::PathBuf);
    impl Drop for StoreDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn stored_probe_job(db: &Connection, action: &str) -> operation_jobs::OperationJob {
        operation_jobs::create_on(
            db,
            serde_json::from_value(json!({
                "hostId":"host","vaultId":"vault","hostName":"Fixture",
                "hostAddress":"127.0.0.1","username":"ops","source":"workspace",
                "action":format!("local-alert.{action}"),"target":PROBE_RULE,
                "risk":"low","provider":"local-ops","transport":"proxy-jump",
                "confirmationRequired":true
            }))
            .unwrap(),
        )
        .unwrap()
    }
    fn update_stored_job(
        db: &Connection,
        job: &operation_jobs::OperationJob,
        status: &str,
    ) -> operation_jobs::OperationJob {
        operation_jobs::update_on(
            db,
            serde_json::from_value(json!({
                "jobId":job.job_id,"status":status,"confirmationStatus":"confirmed",
                "confirmedBy":"local-user","resultSummary":"local lifecycle persisted"
            }))
            .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn probe_rules_require_targets_without_relaxing_payload_allowlists() {
        let rules = json!([{"id":PROBE_RULE,"hostId":"host","name":"Probe unavailable","metric":"probe-provider","target":"ssh-agentless:hash:metrics","threshold":1,"recoveryThreshold":0}]);
        assert!(validate_document("alert-rules", &rules, "host").is_ok());
        for target in [Value::Null, json!(""), json!("   ")] {
            let mut invalid = rules.clone();
            invalid[0]["target"] = target;
            assert!(validate_document("alert-rules", &invalid, "host").is_err());
        }
        let mut unsafe_state = probe_state();
        unsafe_state["alerts"][0]["telemetry"] = json!({"output":"secret"});
        assert!(validate_document("alert-state", &unsafe_state, "host").is_err());
        assert!(validate_document("alert-state", &probe_state(), "other-host").is_err());
    }
    #[test]
    fn probe_lifecycle_reopens_sqlite_with_confirmed_canonical_job_links_and_cas() {
        let directory = StoreDirectory(std::env::temp_dir().join(format!(
            "shellbeam-probe-lifecycle-{}",
            uuid::Uuid::new_v4()
        )));
        std::fs::create_dir(&directory.0).unwrap();
        let state_path = directory.0.join("observations.sqlite3");
        let jobs_path = directory.0.join("operations.sqlite3");
        let original = LocalOpsUpsert {
            vault_id: "vault".into(),
            host_id: "host".into(),
            kind: "alert-state".into(),
            payload: probe_state(),
            expected_revision: 0,
        };
        {
            let mut db = Connection::open(&state_path).unwrap();
            initialize(&db).unwrap();
            upsert(&mut db, &original).unwrap();
            let other = LocalOpsUpsert {
                vault_id: "other-vault".into(),
                ..original.clone()
            };
            upsert(&mut db, &other).unwrap();
        }
        let mut db = Connection::open(&state_path).unwrap();
        initialize(&db).unwrap();
        assert_eq!(
            read(&db, "vault", "host", "alert-state")
                .unwrap()
                .unwrap()
                .payload,
            original.payload
        );
        let jobs = operation_jobs::open_database(&jobs_path).unwrap();
        let pending = stored_probe_job(&jobs, "acknowledge");
        let mut action = LocalOpsAlertAction {
            vault_id: "vault".into(),
            host_id: "host".into(),
            rule_id: PROBE_RULE.into(),
            action: "acknowledge".into(),
            operation_job_id: pending.job_id.clone(),
        };
        assert!(apply_alert_action_on(&mut db, &action, &pending, 2).is_err());
        let ack = update_stored_job(&jobs, &pending, "running");
        let mut mismatched = action.clone();
        mismatched.operation_job_id = "another-job".into();
        assert!(apply_alert_action_on(&mut db, &mismatched, &ack, 2).is_err());
        mismatched = action.clone();
        mismatched.vault_id = "other-vault".into();
        assert!(apply_alert_action_on(&mut db, &mismatched, &ack, 2).is_err());
        mismatched = action.clone();
        mismatched.rule_id = "probe:ssh-agentless:hash:inventory".into();
        assert!(apply_alert_action_on(&mut db, &mismatched, &ack, 2).is_err());
        let acked = apply_alert_action_on(&mut db, &action, &ack, 2).unwrap();
        assert_eq!(acked.revision, 2);
        assert_eq!(acked.payload["alerts"][0]["operationJobId"], ack.job_id);
        update_stored_job(&jobs, &ack, "completed");
        let close = stored_probe_job(&jobs, "close");
        let close = update_stored_job(&jobs, &close, "running");
        action.action = "close".into();
        action.operation_job_id = close.job_id.clone();
        let closed = apply_alert_action_on(&mut db, &action, &close, 3).unwrap();
        assert_eq!(closed.revision, 3);
        update_stored_job(&jobs, &close, "completed");
        let stale = LocalOpsUpsert {
            expected_revision: 1,
            ..original.clone()
        };
        assert!(upsert(&mut db, &stale)
            .unwrap_err()
            .contains("REVISION_CONFLICT"));
        drop(jobs);
        drop(db);
        let db = Connection::open(&state_path).unwrap();
        initialize(&db).unwrap();
        let restored = read(&db, "vault", "host", "alert-state").unwrap().unwrap();
        assert_eq!(restored.revision, 3);
        assert_eq!(restored.payload, closed.payload);
        let alert = &restored.payload["alerts"][0];
        assert_eq!(alert["metric"], "probe-provider");
        assert_eq!(alert["status"], "closed");
        assert_eq!(alert["source"], "ssh-agentless");
        assert_eq!(alert["transport"], "proxy-jump");
        assert_eq!(alert["operationJobId"], close.job_id);
        let audits = restored.payload["audit"].as_array().unwrap();
        assert_eq!(audits.len(), 3);
        assert_eq!(audits[1]["event"], "acknowledged");
        assert_eq!(audits[1]["operationJobId"], ack.job_id);
        assert_eq!(audits[2]["event"], "closed");
        assert_eq!(audits[2]["operationJobId"], close.job_id);
        assert_eq!(
            read(&db, "other-vault", "host", "alert-state")
                .unwrap()
                .unwrap()
                .payload,
            original.payload
        );
        assert!(read(&db, "vault", "other-host", "alert-state")
            .unwrap()
            .is_none());
        let jobs = operation_jobs::open_database(&jobs_path).unwrap();
        for job in [&ack, &close] {
            let restored = operation_jobs::get_on(&jobs, &job.job_id).unwrap().unwrap();
            assert_eq!(restored.status, "completed");
            assert_eq!(restored.confirmation_status, "confirmed");
            assert_eq!(restored.vault_id.as_deref(), Some("vault"));
            assert_eq!(restored.host_id.as_deref(), Some("host"));
            assert_eq!(restored.target, PROBE_RULE);
            assert_eq!(restored.transport, "proxy-jump");
        }
    }
    #[test]
    fn scopes_documents_and_rejects_stale_writes() {
        let mut db = db();
        let request = LocalOpsUpsert {
            vault_id: "vault".into(),
            host_id: "host".into(),
            kind: "alert-state".into(),
            payload: state(),
            expected_revision: 0,
        };
        assert_eq!(upsert(&mut db, &request).unwrap().revision, 1);
        assert!(upsert(&mut db, &request)
            .unwrap_err()
            .contains("REVISION_CONFLICT"));
        assert!(read(&db, "other", "host", "alert-state").unwrap().is_none());
        assert!(read(&db, "vault", "other", "alert-state")
            .unwrap()
            .is_none());
    }
    #[test]
    fn rejects_unknown_sensitive_fields_cross_host_rows_and_raw_output() {
        let mut payload = state();
        payload["alerts"][0]["password"] = json!("secret");
        assert!(validate_document("alert-state", &payload, "host").is_err());
        assert!(validate_document("alert-state", &state(), "other").is_err());
        let history = json!([{"hostId":"host","checkId":"check","status":"unknown","checkedAt":1,"nextCheckAt":2,"errorSummary":"token=secret"}]);
        assert!(validate_document("health-history", &history, "host").is_err());
    }
    #[test]
    fn confirmed_actions_keep_immutable_job_links_and_are_idempotent() {
        let mut state = state();
        let request = LocalOpsAlertAction {
            vault_id: "vault".into(),
            host_id: "host".into(),
            rule_id: "cpu".into(),
            action: "acknowledge".into(),
            operation_job_id: "job".into(),
        };
        apply_alert_action(&mut state, &request, 2, "local-user").unwrap();
        apply_alert_action(&mut state, &request, 3, "local-user").unwrap();
        assert_eq!(state["alerts"][0]["status"], "acknowledged");
        assert_eq!(state["audit"].as_array().unwrap().len(), 1);
        assert_eq!(state["audit"][0]["operationJobId"], "job");
        assert!(validate_document("alert-state", &state, "host").is_ok());
    }
    #[test]
    fn lifecycle_mutations_require_a_matching_confirmed_canonical_job() {
        let mut job: operation_jobs::OperationJob = serde_json::from_value(json!({
            "jobId":"job","auditId":"audit","hostId":"host","vaultId":"vault","source":"workspace","actor":"local-user","action":"local-alert.close","target":"cpu","risk":"low","provider":"local-ops","transport":"direct","status":"running","confirmationRequired":true,"confirmationStatus":"confirmed","queuedAt":1,"updatedAt":2
        })).unwrap();
        let request = LocalOpsAlertAction {
            vault_id: "vault".into(),
            host_id: "host".into(),
            rule_id: "cpu".into(),
            action: "close".into(),
            operation_job_id: "job".into(),
        };
        assert!(validate_action_job(&job, &request).is_ok());
        job.vault_id = Some("other".into());
        assert!(validate_action_job(&job, &request).is_err());
        job.vault_id = Some("vault".into());
        job.confirmation_status = "pending".into();
        assert!(validate_action_job(&job, &request).is_err());
        job.confirmation_status = "confirmed".into();
        job.target = "another-rule".into();
        assert!(validate_action_job(&job, &request).is_err());
        job.target = "cpu".into();
        job.status = "completed".into();
        assert!(validate_action_job(&job, &request).is_err());
    }

    #[test]
    fn authorized_mcp_mutation_keeps_ui_confirmation_strict_and_validates_job_scope_and_revision() {
        let mut db = db();
        upsert(
            &mut db,
            &LocalOpsUpsert {
                vault_id: "vault".into(),
                host_id: "host".into(),
                kind: "alert-state".into(),
                payload: probe_state(),
                expected_revision: 0,
            },
        )
        .unwrap();
        let jobs = operation_jobs::open_database(std::path::Path::new(":memory:")).unwrap();
        let queued = operation_jobs::create_on(&jobs, serde_json::from_value(json!({
            "hostId":"host","vaultId":"vault","source":"mcp","actor":"mcp-client:client",
            "action":"mcp.acknowledge_server_alert","target":PROBE_RULE,"risk":"low",
            "provider":"local-ops","transport":"local","confirmationRequired":false,"requestId":"request"
        })).unwrap()).unwrap();
        let request = LocalOpsAlertAction {
            vault_id: "vault".into(),
            host_id: "host".into(),
            rule_id: PROBE_RULE.into(),
            action: "acknowledge".into(),
            operation_job_id: queued.job_id.clone(),
        };
        assert!(
            apply_authorized_mcp_alert_action_on(&mut db, "client", &request, &queued, 1, 2)
                .is_err()
        );
        let running = operation_jobs::update_on(
            &jobs,
            serde_json::from_value(json!({"jobId":queued.job_id,"status":"running"})).unwrap(),
        )
        .unwrap();
        assert!(validate_action_job(&running, &request).is_err());
        for (field, value) in [
            ("source", json!("workspace")),
            ("actor", json!("mcp-client:another")),
            ("hostId", json!("other-host")),
            ("vaultId", json!("other-vault")),
            ("target", json!("probe:ssh-agentless:hash:inventory")),
            ("action", json!("mcp.close_server_alert")),
            ("status", json!("cancelled")),
            ("confirmationRequired", json!(true)),
            ("confirmationStatus", json!("confirmed")),
            ("requestId", Value::Null),
        ] {
            let mut invalid = serde_json::to_value(&running).unwrap();
            invalid[field] = value;
            let invalid = serde_json::from_value(invalid).unwrap();
            assert!(apply_authorized_mcp_alert_action_on(
                &mut db, "client", &request, &invalid, 1, 2
            )
            .is_err());
        }
        assert!(
            apply_authorized_mcp_alert_action_on(&mut db, "client", &request, &running, 0, 2)
                .unwrap_err()
                .contains("REVISION_CONFLICT")
        );
        assert_eq!(
            read(&db, "vault", "host", "alert-state")
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        let updated =
            apply_authorized_mcp_alert_action_on(&mut db, "client", &request, &running, 1, 2)
                .unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.payload["audit"][1]["actor"], "mcp-client:client");
        assert_eq!(
            updated.payload["alerts"][0]["operationJobId"],
            running.job_id
        );
    }
}
