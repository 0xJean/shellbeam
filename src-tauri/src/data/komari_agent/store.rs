use super::{artifact::TrustedRelease, ConfigurationIdentity, Identity, Observation};
use crate::{
    data::{
        hosts::HostProfile,
        operation_jobs::{self as jobs, CreateOperationJobRequest, UpdateOperationJobRequest},
    },
    storage::{data_file_path, now_unix_ms},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(default)]
    pub connection_id: Option<String>,
    pub vault_id: String,
    pub host_id: String,
    pub host_created_at: i64,
    pub integration_id: String,
    pub service_identity: String,
    pub node_id: String,
    pub node_created_at: String,
    pub deployment: String,
    pub revision: i64,
    pub identity: Identity,
    pub host_keys: String,
    pub endpoint: String,
    pub status: String,
    pub action: String,
    pub job_id: String,
    pub current: Option<TrustedRelease>,
    pub previous: Option<TrustedRelease>,
    pub requested: Option<TrustedRelease>,
    pub observation: Observation,
    pub watermark: i64,
    pub observed_at: Option<i64>,
    pub updated_at: i64,
    pub error_code: Option<String>,
    #[serde(default)]
    pub configuration: Option<ConfigurationIdentity>,
    #[serde(default)]
    pub previous_configuration: Option<ConfigurationIdentity>,
    #[serde(default)]
    pub requested_configuration: Option<ConfigurationIdentity>,
}
fn error(_: impl std::fmt::Display) -> String {
    "KOMARI_AGENT_STORAGE".into()
}
pub fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS komari_agent_deployments(vault_id TEXT NOT NULL,host_id TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(vault_id,host_id));").map_err(error)
}
pub fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db = jobs::open_database(&data_file_path(app, "operation_jobs.sqlite3")?)?;
    initialize(&db)?;
    Ok(db)
}
pub fn get(db: &Connection, vault: &str, host: &str) -> Result<Option<Record>, String> {
    let text: Option<String> = db
        .query_row(
            "SELECT body FROM komari_agent_deployments WHERE vault_id=?1 AND host_id=?2",
            params![vault, host],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    text.map(|v| serde_json::from_str(&v).map_err(error))
        .transpose()
}
pub(super) fn put(db: &Connection, record: &Record, expected: i64) -> Result<(), String> {
    let body = serde_json::to_string(record).map_err(error)?;
    let count=if expected==0 {db.execute("INSERT OR IGNORE INTO komari_agent_deployments(vault_id,host_id,body,revision) VALUES(?1,?2,?3,?4)",params![record.vault_id,record.host_id,body,record.revision])}else{db.execute("UPDATE komari_agent_deployments SET body=?3,revision=?4 WHERE vault_id=?1 AND host_id=?2 AND revision=?5",params![record.vault_id,record.host_id,body,record.revision,expected])}.map_err(error)?;
    if count != 1 {
        return Err("KOMARI_AGENT_STATE_CHANGED".into());
    }
    Ok(())
}
pub fn begin(
    db: &mut Connection,
    record: &mut Record,
    host: &HostProfile,
    transport: &str,
    expected: i64,
) -> Result<(), String> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(error)?;
    if get(&tx, &record.vault_id, &record.host_id)?.map_or(0, |r| r.revision) != expected {
        return Err("KOMARI_AGENT_STATE_CHANGED".into());
    }
    super::transfer::unlocked(&tx, &record.vault_id, &record.host_id)?;
    // A new readback is a new job. Never rewrite a terminal earlier outcome.
    if let Some(previous) = get(&tx, &record.vault_id, &record.host_id)? {
        if let Some(job) = jobs::get_on(&tx, &previous.job_id)? {
            if matches!(job.status.as_str(), "queued" | "running") {
                transition(
                    &tx,
                    &job.job_id,
                    "unknown",
                    "Interrupted operation; a separate readback will inspect without replay",
                    Some("KOMARI_AGENT_INTERRUPTED"),
                )?;
            }
        }
    }
    let read_only = record.action == "inspect";
    let destination = match record.action.as_str() {
        "adopt" | "migrate" | "restore-config" => record
            .requested_configuration
            .as_ref()
            .map(|c| c.endpoint.as_str()),
        "restore-legacy" => record
            .observation
            .legacy
            .as_ref()
            .map(|l| l.endpoint.as_str()),
        _ => None,
    }
    .unwrap_or(&record.endpoint);
    let summary = format!(
        "{}; original service: {}; address: {} -> {}; retain node, key, files and history",
        record.action,
        record
            .observation
            .legacy
            .as_ref()
            .map(|l| l.unit.as_str())
            .unwrap_or("none"),
        record.endpoint,
        destination
    );
    let job = jobs::create_on(
        &tx,
        CreateOperationJobRequest {
            host_id: Some(host.id.clone()),
            vault_id: Some(record.vault_id.clone()),
            host_name: Some(host.name.clone()),
            host_address: Some(host.address.clone()),
            username: Some(host.username.clone()),
            source: "workspace".into(),
            actor: Some("user".into()),
            action: format!("monitoring.agent.{}", record.action),
            target: record.deployment.clone(),
            risk: if read_only { "read-only" } else { "high" }.into(),
            provider: Some("komari".into()),
            transport: Some(transport.into()),
            params_summary: Some(summary),
            confirmation_required: !read_only,
            request_id: None,
        },
    )?;
    record.job_id = job.job_id;
    if !read_only {
        jobs::update_on(
            &tx,
            UpdateOperationJobRequest {
                job_id: record.job_id.clone(),
                status: "queued".into(),
                confirmation_status: Some("confirmed".into()),
                confirmed_by: Some("user".into()),
                result_summary: Some(
                    "User confirmed host, node, route, release and lifecycle action".into(),
                ),
                error_code: None,
                error_summary: None,
                actor: Some("user".into()),
            },
        )?;
    }
    transition(
        &tx,
        &record.job_id,
        "running",
        "Checking the managed deployment",
        None,
    )?;
    record.revision = expected + 1;
    record.updated_at = now_unix_ms();
    put(&tx, record, expected)?;
    tx.commit().map_err(error)
}
pub(super) fn transition(
    db: &Connection,
    id: &str,
    status: &str,
    summary: &str,
    code: Option<&str>,
) -> Result<(), String> {
    jobs::update_on(
        db,
        UpdateOperationJobRequest {
            job_id: id.into(),
            status: status.into(),
            confirmation_status: None,
            confirmed_by: None,
            result_summary: Some(summary.into()),
            error_code: code.map(str::to_owned),
            error_summary: code.map(str::to_owned),
            actor: Some("monitoring-agent".into()),
        },
    )
    .map(|_| ())
}
pub fn save(
    db: &mut Connection,
    record: &mut Record,
    job_status: Option<&str>,
) -> Result<(), String> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(error)?;
    let expected = record.revision;
    record.revision += 1;
    record.updated_at = now_unix_ms();
    put(&tx, record, expected)?;
    if let Some(status) = job_status {
        transition(
            &tx,
            &record.job_id,
            status,
            &format!("Compatible probe: {}", record.status),
            record.error_code.as_deref(),
        )?;
    }
    tx.commit().map_err(error)
}
