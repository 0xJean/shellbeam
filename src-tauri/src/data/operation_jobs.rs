use crate::storage::{data_file_path, now_unix_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const OPERATION_DB: &str = "operation_jobs.sqlite3";
const HOST_DB: &str = "workspace_inventory.sqlite3";
const MAX_SUMMARY_LEN: usize = 256;
const MAX_ROWS: i64 = 5_000;
const MAX_AUDIT_ROWS: i64 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJob {
    pub job_id: String,
    pub audit_id: String,
    pub host_id: Option<String>,
    pub vault_id: Option<String>,
    pub host_name: Option<String>,
    pub host_address: Option<String>,
    pub username: Option<String>,
    pub source: String,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub risk: String,
    pub provider: String,
    pub transport: String,
    pub params_summary: Option<String>,
    pub status: String,
    #[serde(default)]
    pub confirmation_required: bool,
    pub confirmation_status: String,
    pub confirmed_at: Option<i64>,
    pub confirmed_by: Option<String>,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub updated_at: i64,
    pub duration_ms: Option<i64>,
    pub result_summary: Option<String>,
    pub error_code: Option<String>,
    pub error_summary: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOperationJobRequest {
    pub host_id: Option<String>,
    pub vault_id: Option<String>,
    pub host_name: Option<String>,
    pub host_address: Option<String>,
    pub username: Option<String>,
    pub source: String,
    pub actor: Option<String>,
    pub action: String,
    pub target: String,
    pub risk: String,
    pub provider: Option<String>,
    pub transport: Option<String>,
    pub params_summary: Option<String>,
    #[serde(default)]
    pub confirmation_required: bool,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOperationJobRequest {
    pub job_id: String,
    pub status: String,
    pub confirmation_status: Option<String>,
    pub confirmed_by: Option<String>,
    pub result_summary: Option<String>,
    pub error_code: Option<String>,
    pub error_summary: Option<String>,
    pub actor: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistoryCursor {
    pub timestamp: i64,
    pub id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJobListQuery {
    pub host_id: Option<String>,
    pub vault_id: Option<String>,
    pub status: Option<String>,
    pub action: Option<String>,
    pub source: Option<String>,
    pub limit: Option<u32>,
    pub before: Option<OperationHistoryCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAudit {
    pub audit_id: String,
    pub job_id: String,
    pub event: String,
    pub status: String,
    pub confirmation_status: String,
    pub source: String,
    pub actor: String,
    pub host_id: Option<String>,
    pub host_name: Option<String>,
    pub host_address: Option<String>,
    /// Vault scope is returned with every audit row so consumers can keep
    /// host history separated when the same host id is reused in another
    /// vault. It is joined from the canonical OperationJob record.
    pub vault_id: Option<String>,
    pub action: String,
    pub target: String,
    pub risk: String,
    pub provider: String,
    pub transport: String,
    pub params_summary: Option<String>,
    pub result_summary: Option<String>,
    pub error_code: Option<String>,
    pub error_summary: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAuditListQuery {
    pub job_id: Option<String>,
    pub host_id: Option<String>,
    pub vault_id: Option<String>,
    pub source: Option<String>,
    pub status: Option<String>,
    pub limit: Option<u32>,
    pub before: Option<OperationHistoryCursor>,
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_database(&data_file_path(app, OPERATION_DB)?)
}

/// The desktop commands and opt-in live fixture use the same schema and store.
/// The caller owns path selection; this does not resolve hosts or credentials.
pub(crate) fn open_database(path: &std::path::Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| format!("Open operation jobs db failed: {e}"))?;
    initialize(&db)?;
    Ok(db)
}

/// Older Workspace callers did not send a vault id with an operation request.
/// Recover it only when the host id maps to exactly one vault; an ambiguous
/// host remains unscoped so MCP never guesses across vault boundaries.
fn infer_vault_id(app: &tauri::AppHandle, host_id: Option<&str>) -> Option<String> {
    let host_id = host_id?.trim();
    if host_id.is_empty() {
        return None;
    }
    let path = data_file_path(app, HOST_DB).ok()?;
    let db = Connection::open(path).ok()?;
    let mut statement = db
        .prepare("SELECT DISTINCT vault_id FROM workspace_hosts WHERE id=?1 LIMIT 2")
        .ok()?;
    let rows = statement
        .query_map([host_id], |row| row.get::<_, String>(0))
        .ok()?;
    let vaults = rows.filter_map(Result::ok).collect::<Vec<_>>();
    (vaults.len() == 1).then(|| vaults[0].clone())
}

fn initialize(db: &Connection) -> Result<(), String> {
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS operation_jobs (
           job_id TEXT PRIMARY KEY NOT NULL,
           audit_id TEXT NOT NULL,
           host_id TEXT,
           vault_id TEXT,
           host_name TEXT,
           host_address TEXT,
           username TEXT,
           source TEXT NOT NULL,
           actor TEXT NOT NULL,
           action TEXT NOT NULL,
           target TEXT NOT NULL,
           risk TEXT NOT NULL,
           provider TEXT NOT NULL,
           transport TEXT NOT NULL,
           params_summary TEXT,
           status TEXT NOT NULL,
           confirmation_required INTEGER NOT NULL,
           confirmation_status TEXT NOT NULL,
           confirmed_at INTEGER,
           confirmed_by TEXT,
           queued_at INTEGER NOT NULL,
           started_at INTEGER,
           finished_at INTEGER,
           updated_at INTEGER NOT NULL,
           duration_ms INTEGER,
           result_summary TEXT,
           error_code TEXT,
           error_summary TEXT,
           request_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_operation_jobs_updated_at
           ON operation_jobs(updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_operation_jobs_history
           ON operation_jobs(updated_at DESC, job_id DESC);
         CREATE INDEX IF NOT EXISTS idx_operation_jobs_host_id
           ON operation_jobs(host_id, updated_at DESC);
         CREATE TABLE IF NOT EXISTS operation_audit (
           audit_id TEXT PRIMARY KEY NOT NULL,
           job_id TEXT NOT NULL,
           event TEXT NOT NULL,
           status TEXT NOT NULL,
           confirmation_status TEXT NOT NULL,
           source TEXT NOT NULL,
           actor TEXT NOT NULL,
           host_id TEXT,
           host_name TEXT,
           host_address TEXT,
           action TEXT NOT NULL,
           target TEXT NOT NULL,
           risk TEXT NOT NULL,
           provider TEXT NOT NULL,
           transport TEXT NOT NULL,
           params_summary TEXT,
           result_summary TEXT,
           error_code TEXT,
           error_summary TEXT,
           at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_operation_audit_at
           ON operation_audit(at DESC);
         CREATE INDEX IF NOT EXISTS idx_operation_audit_history
           ON operation_audit(at DESC, audit_id DESC);
         CREATE INDEX IF NOT EXISTS idx_operation_audit_job_id
           ON operation_audit(job_id, at DESC);",
    )
    .map_err(|e| format!("Initialize operation jobs db failed: {e}"))
}

fn bounded_limit(raw: Option<u32>, fallback: u32, max: u32) -> u32 {
    raw.unwrap_or(fallback).clamp(1, max)
}

fn validate_history_query(
    status: Option<&str>,
    source: Option<&str>,
    before: Option<&OperationHistoryCursor>,
) -> Result<(), String> {
    if status.is_some_and(|value| {
        !matches!(
            value,
            "queued" | "running" | "completed" | "failed" | "unknown" | "cancelled"
        )
    }) {
        return Err("INVALID_OPERATION: unknown history status".into());
    }
    if source.is_some_and(|value| !matches!(value, "terminal" | "workspace" | "mcp" | "monitor")) {
        return Err("INVALID_OPERATION: unknown history source".into());
    }
    if let Some(cursor) = before {
        // Cursors cross JavaScript/native boundaries; reject unsafe numeric
        // values and incomplete boundaries rather than skipping tied rows.
        if !(0..=9_007_199_254_740_991).contains(&cursor.timestamp)
            || cursor.id.is_empty()
            || cursor.id.len() > 128
            || cursor.id.chars().any(char::is_control)
        {
            return Err("INVALID_OPERATION: invalid history cursor".into());
        }
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, required: bool) -> Result<(), String> {
    let trimmed = value.trim();
    if required && trimmed.is_empty() {
        return Err(format!("INVALID_OPERATION: {label} is required"));
    }
    if trimmed.len() > 512 {
        return Err(format!("INVALID_OPERATION: {label} is too long"));
    }
    if value
        .chars()
        .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(format!(
            "INVALID_OPERATION: {label} contains control characters"
        ));
    }
    Ok(())
}

/// Keep audit data useful without retaining credentials, private key material or output.
pub fn sanitize_summary(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let mut redacted = value
        .chars()
        .map(|ch| {
            if ch == '\n' || ch == '\r' || ch == '\t' {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    let sensitive = [
        "password",
        "passwd",
        "private_key",
        "private-key",
        "secret",
        "token",
        "credential",
        "authorization",
        "bearer",
    ];
    let mut parts = Vec::new();
    for part in redacted.split_whitespace() {
        let lower = part.to_ascii_lowercase();
        if sensitive.iter().any(|needle| lower.contains(needle)) {
            parts.push("<redacted>".to_string());
        } else {
            parts.push(part.to_string());
        }
    }
    redacted = parts.join(" ");
    if redacted.len() > MAX_SUMMARY_LEN {
        let mut end = MAX_SUMMARY_LEN.saturating_sub('…'.len_utf8());
        while !redacted.is_char_boundary(end) {
            end -= 1;
        }
        redacted.truncate(end);
        redacted.push('…');
    }
    Some(redacted)
}

fn validate_request(request: &CreateOperationJobRequest) -> Result<(), String> {
    validate_text("source", &request.source, true)?;
    validate_text("action", &request.action, true)?;
    validate_text("target", &request.target, true)?;
    validate_text("risk", &request.risk, true)?;
    if !matches!(request.risk.as_str(), "read-only" | "low" | "high") {
        return Err("INVALID_OPERATION: risk must be read-only, low or high".to_string());
    }
    if request.source != "terminal"
        && request.source != "workspace"
        && request.source != "mcp"
        && request.source != "monitor"
    {
        return Err("INVALID_OPERATION: unsupported source".to_string());
    }
    if request.action.len() > 96
        || request
            .action
            .chars()
            .any(|ch| !ch.is_ascii_alphanumeric() && !matches!(ch, '.' | '_' | ':' | '-'))
    {
        return Err("INVALID_OPERATION: action must be a short namespaced identifier".to_string());
    }
    for (label, value) in [
        ("actor", request.actor.as_deref()),
        ("provider", request.provider.as_deref()),
        ("transport", request.transport.as_deref()),
        ("requestId", request.request_id.as_deref()),
        ("hostId", request.host_id.as_deref()),
        ("vaultId", request.vault_id.as_deref()),
        ("hostName", request.host_name.as_deref()),
        ("hostAddress", request.host_address.as_deref()),
        ("username", request.username.as_deref()),
    ] {
        if let Some(value) = value {
            validate_text(label, value, false)?;
        }
    }
    Ok(())
}

fn job_from_row(row: &Row<'_>) -> rusqlite::Result<OperationJob> {
    Ok(OperationJob {
        job_id: row.get(0)?,
        audit_id: row.get(1)?,
        host_id: row.get(2)?,
        vault_id: row.get(3)?,
        host_name: row.get(4)?,
        host_address: row.get(5)?,
        username: row.get(6)?,
        source: row.get(7)?,
        actor: row.get(8)?,
        action: row.get(9)?,
        target: row.get(10)?,
        risk: row.get(11)?,
        provider: row.get(12)?,
        transport: row.get(13)?,
        params_summary: row.get(14)?,
        status: row.get(15)?,
        confirmation_required: row.get::<_, i64>(16)? != 0,
        confirmation_status: row.get(17)?,
        confirmed_at: row.get(18)?,
        confirmed_by: row.get(19)?,
        queued_at: row.get(20)?,
        started_at: row.get(21)?,
        finished_at: row.get(22)?,
        updated_at: row.get(23)?,
        duration_ms: row.get(24)?,
        result_summary: row.get(25)?,
        error_code: row.get(26)?,
        error_summary: row.get(27)?,
        request_id: row.get(28)?,
    })
}

const JOB_COLUMNS: &str = "job_id,audit_id,host_id,vault_id,host_name,host_address,username,
    source,actor,action,target,risk,provider,transport,params_summary,status,
    confirmation_required,confirmation_status,confirmed_at,confirmed_by,queued_at,
    started_at,finished_at,updated_at,duration_ms,result_summary,error_code,error_summary,request_id";

fn load_job(db: &Connection, job_id: &str) -> Result<OperationJob, String> {
    db.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM operation_jobs WHERE job_id=?1"),
        [job_id],
        job_from_row,
    )
    .map_err(|e| format!("Read operation job failed: {e}"))
}

fn audit_insert(
    db: &Connection,
    job: &OperationJob,
    event: &str,
    actor: &str,
) -> Result<String, String> {
    let audit_id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO operation_audit
         (audit_id,job_id,event,status,confirmation_status,source,actor,host_id,host_name,host_address,
          action,target,risk,provider,transport,params_summary,result_summary,error_code,error_summary,at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![
            audit_id,
            job.job_id,
            event,
            job.status,
            job.confirmation_status,
            job.source,
            actor,
            job.host_id,
            job.host_name,
            job.host_address,
            job.action,
            job.target,
            job.risk,
            job.provider,
            job.transport,
            job.params_summary,
            job.result_summary,
            job.error_code,
            job.error_summary,
            now_unix_ms(),
        ],
    )
    .map_err(|e| format!("Write operation audit failed: {e}"))?;
    Ok(audit_id)
}

fn prune(db: &Connection) -> Result<(), String> {
    db.execute(
        "DELETE FROM operation_jobs WHERE job_id IN
         (SELECT job_id FROM operation_jobs ORDER BY updated_at DESC LIMIT -1 OFFSET ?1)",
        [MAX_ROWS],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM operation_audit WHERE audit_id IN
         (SELECT audit_id FROM operation_audit ORDER BY at DESC LIMIT -1 OFFSET ?1)",
        [MAX_AUDIT_ROWS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn operation_job_create(
    app: tauri::AppHandle,
    request: CreateOperationJobRequest,
) -> Result<OperationJob, String> {
    validate_request(&request)?;
    let db = open(&app)?;
    let mut request = request;
    request.vault_id = request
        .vault_id
        .clone()
        .or_else(|| infer_vault_id(&app, request.host_id.as_deref()));
    create_on(&db, request)
}

pub(crate) fn create_on(
    db: &Connection,
    request: CreateOperationJobRequest,
) -> Result<OperationJob, String> {
    validate_request(&request)?;
    let now = now_unix_ms();
    let job_id = Uuid::new_v4().to_string();
    let queued_audit_id = Uuid::new_v4().to_string();
    let actor = request
        .actor
        .clone()
        .unwrap_or_else(|| "local-user".to_string());
    let provider = request
        .provider
        .clone()
        .unwrap_or_else(|| "ssh-agentless".to_string());
    let transport = request
        .transport
        .clone()
        .unwrap_or_else(|| "direct".to_string());
    let action = sanitize_summary(Some(&request.action)).unwrap_or_else(|| "operation".to_string());
    let target = sanitize_summary(Some(&request.target)).unwrap_or_else(|| "target".to_string());
    let params_summary = sanitize_summary(request.params_summary.as_deref());
    let vault_id = request.vault_id.clone();
    let confirmation_status = if request.confirmation_required {
        "pending"
    } else {
        "not_required"
    };
    db.execute(
        "INSERT INTO operation_jobs
         (job_id,audit_id,host_id,vault_id,host_name,host_address,username,source,actor,action,target,
          risk,provider,transport,params_summary,status,confirmation_required,confirmation_status,
          queued_at,updated_at,request_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'queued',?16,?17,?18,?18,?19)",
        params![
            job_id,
            queued_audit_id,
            request.host_id,
            vault_id,
            request.host_name,
            request.host_address,
            request.username,
            request.source,
            actor,
            action,
            target,
            request.risk,
            provider,
            transport,
            params_summary,
            request.confirmation_required as i64,
            confirmation_status,
            now,
            request.request_id,
        ],
    )
    .map_err(|e| format!("Create operation job failed: {e}"))?;
    let job = load_job(db, &job_id)?;
    db.execute(
        "INSERT INTO operation_audit
         (audit_id,job_id,event,status,confirmation_status,source,actor,host_id,host_name,host_address,
          action,target,risk,provider,transport,params_summary,at)
         VALUES (?1,?2,'queued',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            queued_audit_id,
            job.job_id,
            job.status,
            job.confirmation_status,
            job.source,
            job.actor,
            job.host_id,
            job.host_name,
            job.host_address,
            job.action,
            job.target,
            job.risk,
            job.provider,
            job.transport,
            job.params_summary,
            now,
        ],
    )
    .map_err(|e| format!("Write operation audit failed: {e}"))?;
    prune(db)?;
    Ok(job)
}

fn legal_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("queued", "running")
            | ("queued", "cancelled")
            | ("queued", "failed")
            | ("queued", "unknown")
            | ("running", "completed")
            | ("running", "failed")
            | ("running", "unknown")
            | ("running", "cancelled")
    )
}

fn valid_status(value: &str) -> bool {
    matches!(
        value,
        "queued" | "running" | "completed" | "failed" | "unknown" | "cancelled"
    )
}

#[tauri::command]
pub fn operation_job_update(
    app: tauri::AppHandle,
    request: UpdateOperationJobRequest,
) -> Result<OperationJob, String> {
    if !valid_status(&request.status) {
        return Err("INVALID_OPERATION: unsupported status".to_string());
    }
    let db = open(&app)?;
    update_on(&db, request)
}

pub(crate) fn update_on(
    db: &Connection,
    request: UpdateOperationJobRequest,
) -> Result<OperationJob, String> {
    if !valid_status(&request.status) {
        return Err("INVALID_OPERATION: unsupported status".to_string());
    }
    let current = load_job(db, &request.job_id)?;
    if current.status != request.status && !legal_transition(&current.status, &request.status) {
        return Err(format!(
            "INVALID_OPERATION: illegal status transition {} -> {}",
            current.status, request.status
        ));
    }
    let confirmation_status = request
        .confirmation_status
        .as_deref()
        .unwrap_or(&current.confirmation_status);
    if !matches!(
        confirmation_status,
        "pending" | "confirmed" | "rejected" | "not_required"
    ) {
        return Err("INVALID_OPERATION: unsupported confirmation status".to_string());
    }
    if request.status == "running"
        && current.confirmation_required
        && confirmation_status != "confirmed"
    {
        return Err("OPERATION_CONFIRMATION_REQUIRED: confirm before running".to_string());
    }
    let actor = request
        .actor
        .as_deref()
        .unwrap_or(&current.actor)
        .to_string();
    validate_text("actor", &actor, true)?;
    let now = now_unix_ms();
    let started_at = if request.status == "running" {
        current.started_at.or(Some(now))
    } else {
        current.started_at
    };
    let finished_at = if matches!(
        request.status.as_str(),
        "completed" | "failed" | "unknown" | "cancelled"
    ) {
        current.finished_at.or(Some(now))
    } else {
        current.finished_at
    };
    let duration_ms =
        finished_at.and_then(|finished| started_at.map(|started| (finished - started).max(0)));
    let confirmed_at = if confirmation_status == "confirmed" {
        current.confirmed_at.or(Some(now))
    } else {
        current.confirmed_at
    };
    let confirmed_by = if confirmation_status == "confirmed" {
        request
            .confirmed_by
            .clone()
            .or(current.confirmed_by.clone())
            .or(Some(actor.clone()))
    } else {
        current.confirmed_by.clone()
    };
    let result_summary = request
        .result_summary
        .as_deref()
        .map(|value| sanitize_summary(Some(value)))
        .flatten()
        .or(current.result_summary.clone());
    let error_summary = request
        .error_summary
        .as_deref()
        .map(|value| sanitize_summary(Some(value)))
        .flatten()
        .or(current.error_summary.clone());
    db.execute(
        "UPDATE operation_jobs SET status=?1,confirmation_status=?2,confirmed_at=?3,confirmed_by=?4,
         started_at=?5,finished_at=?6,updated_at=?7,duration_ms=?8,result_summary=?9,error_code=?10,
         error_summary=?11,actor=?12 WHERE job_id=?13",
        params![
            request.status,
            confirmation_status,
            confirmed_at,
            confirmed_by,
            started_at,
            finished_at,
            now,
            duration_ms,
            result_summary,
            request
                .error_code
                .as_deref()
                .and_then(|value| sanitize_summary(Some(value))),
            error_summary,
            actor,
            request.job_id,
        ],
    )
    .map_err(|e| format!("Update operation job failed: {e}"))?;
    let updated = load_job(db, &request.job_id)?;
    let event = if current.status == updated.status {
        if current.confirmation_status != updated.confirmation_status {
            "confirmation"
        } else {
            "updated"
        }
    } else {
        updated.status.as_str()
    };
    let _ = audit_insert(db, &updated, event, &actor)?;
    prune(db)?;
    Ok(updated)
}

#[tauri::command]
pub fn operation_job_get(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<Option<OperationJob>, String> {
    validate_text("jobId", &job_id, true)?;
    let db = open(&app)?;
    get_on(&db, &job_id)
}

pub(crate) fn get_on(db: &Connection, job_id: &str) -> Result<Option<OperationJob>, String> {
    validate_text("jobId", job_id, true)?;
    db.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM operation_jobs WHERE job_id=?1"),
        [job_id],
        job_from_row,
    )
    .optional()
    .map_err(|e| format!("Read operation job failed: {e}"))
}

/// Find an existing operation by its MCP idempotency scope. This closes the
/// small crash window between creating the canonical OperationJob and linking
/// it from the MCP result table.
pub fn operation_job_find_by_request(
    app: tauri::AppHandle,
    vault_id: &str,
    host_id: &str,
    actor: &str,
    action: &str,
    request_id: &str,
) -> Result<Option<OperationJob>, String> {
    let db = open(&app)?;
    db.query_row(
        &format!(
            "SELECT {JOB_COLUMNS} FROM operation_jobs
             WHERE vault_id=?1 AND host_id=?2 AND source='mcp' AND actor=?3
               AND action=?4 AND request_id=?5
             ORDER BY queued_at DESC LIMIT 1"
        ),
        params![vault_id, host_id, actor, action, request_id],
        job_from_row,
    )
    .optional()
    .map_err(|e| format!("Find operation job failed: {e}"))
}

#[tauri::command]
pub fn operation_job_list(
    app: tauri::AppHandle,
    query: Option<OperationJobListQuery>,
) -> Result<Vec<OperationJob>, String> {
    let db = open(&app)?;
    list_on(&db, query.unwrap_or_default())
}

pub(crate) fn list_on(
    db: &Connection,
    query: OperationJobListQuery,
) -> Result<Vec<OperationJob>, String> {
    validate_history_query(
        query.status.as_deref(),
        query.source.as_deref(),
        query.before.as_ref(),
    )?;
    let limit = bounded_limit(query.limit, 100, 500);
    let mut statement = db
        .prepare(&format!(
            "SELECT {JOB_COLUMNS} FROM operation_jobs
             WHERE (?1 IS NULL OR host_id=?1)
               AND (?2 IS NULL OR vault_id=?2)
               AND (?3 IS NULL OR status=?3)
               AND (?4 IS NULL OR action=?4)
               AND (?5 IS NULL OR source=?5)
               AND (?6 IS NULL OR updated_at<?6 OR (updated_at=?6 AND job_id<?7))
             ORDER BY updated_at DESC, job_id DESC LIMIT ?8"
        ))
        .map_err(|e| format!("Prepare operation job query failed: {e}"))?;
    let rows = statement
        .query_map(
            params![
                query.host_id,
                query.vault_id,
                query.status,
                query.action,
                query.source,
                query.before.as_ref().map(|cursor| cursor.timestamp),
                query.before.as_ref().map(|cursor| cursor.id.as_str()),
                limit
            ],
            job_from_row,
        )
        .map_err(|e| format!("Query operation jobs failed: {e}"))?;
    rows.map(|row| row.map_err(|e| format!("Read operation job failed: {e}")))
        .collect()
}

fn audit_from_row(row: &Row<'_>) -> rusqlite::Result<OperationAudit> {
    Ok(OperationAudit {
        audit_id: row.get(0)?,
        job_id: row.get(1)?,
        event: row.get(2)?,
        status: row.get(3)?,
        confirmation_status: row.get(4)?,
        source: row.get(5)?,
        actor: row.get(6)?,
        host_id: row.get(7)?,
        host_name: row.get(8)?,
        host_address: row.get(9)?,
        vault_id: row.get(10)?,
        action: row.get(11)?,
        target: row.get(12)?,
        risk: row.get(13)?,
        provider: row.get(14)?,
        transport: row.get(15)?,
        params_summary: row.get(16)?,
        result_summary: row.get(17)?,
        error_code: row.get(18)?,
        error_summary: row.get(19)?,
        created_at: row.get(20)?,
    })
}

#[tauri::command]
pub fn operation_audit_list(
    app: tauri::AppHandle,
    query: Option<OperationAuditListQuery>,
) -> Result<Vec<OperationAudit>, String> {
    let db = open(&app)?;
    audit_list_on(&db, query.unwrap_or_default())
}

pub(crate) fn audit_list_on(
    db: &Connection,
    query: OperationAuditListQuery,
) -> Result<Vec<OperationAudit>, String> {
    validate_history_query(
        query.status.as_deref(),
        query.source.as_deref(),
        query.before.as_ref(),
    )?;
    let limit = bounded_limit(query.limit, 100, 500);
    let mut statement = db
        .prepare(
            "SELECT operation_audit.audit_id,operation_audit.job_id,operation_audit.event,
                    operation_audit.status,operation_audit.confirmation_status,operation_audit.source,
                    operation_audit.actor,operation_audit.host_id,operation_audit.host_name,
                    operation_audit.host_address,jobs.vault_id,operation_audit.action,
                    operation_audit.target,operation_audit.risk,operation_audit.provider,
                    operation_audit.transport,operation_audit.params_summary,operation_audit.result_summary,
                    operation_audit.error_code,operation_audit.error_summary,operation_audit.at
             FROM operation_audit
             LEFT JOIN operation_jobs jobs ON jobs.job_id=operation_audit.job_id
             WHERE (?1 IS NULL OR operation_audit.job_id=?1)
               AND (?2 IS NULL OR operation_audit.host_id=?2)
               AND (?3 IS NULL OR jobs.vault_id=?3)
               AND (?4 IS NULL OR operation_audit.source=?4)
               AND (?5 IS NULL OR operation_audit.status=?5)
               AND (?6 IS NULL OR operation_audit.at<?6 OR (operation_audit.at=?6 AND operation_audit.audit_id<?7))
             ORDER BY operation_audit.at DESC, operation_audit.audit_id DESC LIMIT ?8",
        )
        .map_err(|e| format!("Prepare operation audit query failed: {e}"))?;
    let rows = statement
        .query_map(
            params![
                query.job_id,
                query.host_id,
                query.vault_id,
                query.source,
                query.status,
                query.before.as_ref().map(|cursor| cursor.timestamp),
                query.before.as_ref().map(|cursor| cursor.id.as_str()),
                limit
            ],
            audit_from_row,
        )
        .map_err(|e| format!("Query operation audit failed: {e}"))?;
    rows.map(|row| row.map_err(|e| format!("Read operation audit failed: {e}")))
        .collect()
}

/// Recover jobs that were interrupted by an app restart. They remain unknown until reconciled.
pub fn recover(app: &tauri::AppHandle) -> Result<(), String> {
    let db = open(app)?;
    let mut statement = db
        .prepare("SELECT job_id FROM operation_jobs WHERE status IN ('queued','running')")
        .map_err(|e| e.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(statement);
    for job_id in ids {
        operation_job_update(
            app.clone(),
            UpdateOperationJobRequest {
                job_id,
                status: "unknown".to_string(),
                confirmation_status: None,
                confirmed_by: None,
                result_summary: Some(
                    "Interrupted before completion; reconcile remote state".to_string(),
                ),
                error_code: Some("app_restarted".to_string()),
                error_summary: Some("The app restarted before the operation completed".to_string()),
                actor: Some("system".to_string()),
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StoreDirectory(std::path::PathBuf);
    impl Drop for StoreDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn store_directory() -> StoreDirectory {
        let path = std::env::temp_dir().join(format!("shellbeam-job-store-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        StoreDirectory(path)
    }

    fn create_request(vault: &str) -> CreateOperationJobRequest {
        serde_json::from_value(serde_json::json!({
            "vaultId":vault,"hostId":"same-host","hostName":"Fixture",
            "hostAddress":"127.0.0.1","username":"fixture",
            "source":"workspace","action":"docker.start","target":"fixture",
            "risk":"high","confirmationRequired":true,
            "paramsSummary":"start fixture; token=private-fixture-token"
        }))
        .unwrap()
    }

    fn update_request(
        job_id: &str,
        status: &str,
        confirmation: Option<&str>,
    ) -> UpdateOperationJobRequest {
        serde_json::from_value(serde_json::json!({
            "jobId":job_id,"status":status,"confirmationStatus":confirmation,
            "resultSummary":"bounded status only"
        }))
        .unwrap()
    }

    #[test]
    fn canonical_sqlite_reopens_cancelled_and_unknown_jobs_with_scoped_audits() {
        let directory = store_directory();
        let path = directory.0.join("jobs.sqlite3");
        let db = open_database(&path).unwrap();
        let cancelled = create_on(&db, create_request("vault-a")).unwrap();
        let cancelled = update_on(
            &db,
            update_request(&cancelled.job_id, "cancelled", Some("rejected")),
        )
        .unwrap();
        let unknown = create_on(&db, create_request("vault-a")).unwrap();
        update_on(
            &db,
            update_request(&unknown.job_id, "running", Some("confirmed")),
        )
        .unwrap();
        let unknown = update_on(&db, update_request(&unknown.job_id, "unknown", None)).unwrap();
        // Same host id in another Vault must not enter either filtered result.
        create_on(&db, create_request("vault-b")).unwrap();
        drop(db);

        let reopened = open_database(&path).unwrap();
        let jobs = list_on(
            &reopened,
            OperationJobListQuery {
                host_id: Some("same-host".into()),
                vault_id: Some("vault-a".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().all(|job| job
            .params_summary
            .as_deref()
            .unwrap()
            .contains("<redacted>")));
        assert!(jobs.iter().all(|job| !job
            .params_summary
            .as_deref()
            .unwrap()
            .contains("private-fixture-token")));
        assert_eq!(
            get_on(&reopened, &cancelled.job_id)
                .unwrap()
                .unwrap()
                .confirmation_status,
            "rejected"
        );
        let restored_unknown = get_on(&reopened, &unknown.job_id).unwrap().unwrap();
        assert_eq!(restored_unknown.status, "unknown");
        assert_eq!(restored_unknown.confirmation_status, "confirmed");
        let audit = audit_list_on(
            &reopened,
            OperationAuditListQuery {
                vault_id: Some("vault-a".into()),
                host_id: Some("same-host".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(audit.len(), 5);
        assert!(audit
            .iter()
            .all(|entry| entry.vault_id.as_deref() == Some("vault-a")));
        assert!(audit.iter().any(|entry| entry.job_id == cancelled.job_id
            && entry.status == "cancelled"
            && entry.confirmation_status == "rejected"));
        assert!(audit
            .iter()
            .any(|entry| entry.job_id == unknown.job_id && entry.status == "unknown"));
    }

    #[test]
    fn history_keysets_page_tied_rows_after_reopen_without_cross_scope_or_newer_inserts() {
        let directory = store_directory();
        let path = directory.0.join("history.sqlite3");
        let db = open_database(&path).unwrap();
        for index in 0..9 {
            let mut request = create_request(if index == 5 { "vault-b" } else { "vault-a" });
            if index == 6 {
                request.host_id = Some("other-host".into());
            }
            if index == 7 {
                request.source = "monitor".into();
            }
            let job = create_on(&db, request).unwrap();
            if index != 8 {
                update_on(
                    &db,
                    update_request(&job.job_id, "cancelled", Some("rejected")),
                )
                .unwrap();
            }
        }
        // Real journal rows can share the same millisecond. Neither timestamps
        // alone nor OFFSET can safely identify the next page under new writes.
        db.execute("UPDATE operation_jobs SET updated_at=1000", [])
            .unwrap();
        db.execute("UPDATE operation_audit SET at=1000", [])
            .unwrap();
        drop(db);
        let db = open_database(&path).unwrap();
        let filters = serde_json::json!({"vaultId":"vault-a","hostId":"same-host","source":"workspace","status":"cancelled","limit":2});
        let expected_jobs = list_on(&db, serde_json::from_value(serde_json::json!({"vaultId":"vault-a","hostId":"same-host","source":"workspace","status":"cancelled","limit":500})).unwrap()).unwrap();
        let expected_audits = audit_list_on(&db, serde_json::from_value(serde_json::json!({"vaultId":"vault-a","hostId":"same-host","source":"workspace","status":"cancelled","limit":500})).unwrap()).unwrap();
        assert_eq!(expected_jobs.len(), 5);
        assert_eq!(expected_audits.len(), 5);
        assert!(expected_jobs
            .windows(2)
            .all(|pair| pair[0].job_id > pair[1].job_id));
        assert!(expected_audits
            .windows(2)
            .all(|pair| pair[0].audit_id > pair[1].audit_id));

        let first_jobs = list_on(&db, serde_json::from_value(filters.clone()).unwrap()).unwrap();
        let first_audits =
            audit_list_on(&db, serde_json::from_value(filters.clone()).unwrap()).unwrap();
        let newer = create_on(&db, create_request("vault-a")).unwrap();
        update_on(
            &db,
            update_request(&newer.job_id, "cancelled", Some("rejected")),
        )
        .unwrap();
        let mut job_ids = first_jobs
            .iter()
            .map(|row| row.job_id.clone())
            .collect::<Vec<_>>();
        let mut audit_ids = first_audits
            .iter()
            .map(|row| row.audit_id.clone())
            .collect::<Vec<_>>();
        let mut job_cursor = first_jobs
            .last()
            .map(|row| serde_json::json!({"timestamp":row.updated_at,"id":row.job_id}));
        let mut audit_cursor = first_audits
            .last()
            .map(|row| serde_json::json!({"timestamp":row.created_at,"id":row.audit_id}));
        for _ in 0..3 {
            let mut query = filters.clone();
            query["before"] = job_cursor.clone().unwrap();
            let page = list_on(&db, serde_json::from_value(query).unwrap()).unwrap();
            assert!(page.len() <= 2);
            if let Some(last) = page.last() {
                job_cursor =
                    Some(serde_json::json!({"timestamp":last.updated_at,"id":last.job_id}));
            }
            job_ids.extend(page.into_iter().map(|row| row.job_id));
            let mut query = filters.clone();
            query["before"] = audit_cursor.clone().unwrap();
            let page = audit_list_on(&db, serde_json::from_value(query).unwrap()).unwrap();
            assert!(page.len() <= 2);
            if let Some(last) = page.last() {
                audit_cursor =
                    Some(serde_json::json!({"timestamp":last.created_at,"id":last.audit_id}));
            }
            audit_ids.extend(page.into_iter().map(|row| row.audit_id));
        }
        assert_eq!(
            job_ids,
            expected_jobs
                .into_iter()
                .map(|row| row.job_id)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            audit_ids,
            expected_audits
                .into_iter()
                .map(|row| row.audit_id)
                .collect::<Vec<_>>()
        );
        assert!(!job_ids.contains(&newer.job_id));
        // Fresh reads expose the newly inserted job; paging never hides it forever.
        let latest = list_on(&db, serde_json::from_value(filters).unwrap()).unwrap();
        assert_eq!(latest[0].job_id, newer.job_id);
    }

    #[test]
    fn history_queries_reject_invalid_boundaries_and_filter_values() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        for query in [
            serde_json::json!({"before":{"timestamp":-1,"id":"a"}}),
            serde_json::json!({"before":{"timestamp":9_007_199_254_740_992_i64,"id":"a"}}),
            serde_json::json!({"before":{"timestamp":1,"id":""}}),
            serde_json::json!({"before":{"timestamp":1,"id":"bad\nline"}}),
            serde_json::json!({"before":{"timestamp":1,"id":"x".repeat(129)}}),
            serde_json::json!({"status":"not-a-status"}),
            serde_json::json!({"source":"not-a-source"}),
        ] {
            assert!(list_on(&db, serde_json::from_value(query.clone()).unwrap())
                .unwrap_err()
                .contains("INVALID_OPERATION"));
            assert!(audit_list_on(&db, serde_json::from_value(query).unwrap())
                .unwrap_err()
                .contains("INVALID_OPERATION"));
        }
    }

    #[test]
    fn shared_store_requires_confirmation_and_preserves_terminal_state() {
        let directory = store_directory();
        let db = open_database(&directory.0.join("jobs.sqlite3")).unwrap();
        let queued = create_on(&db, create_request("vault-a")).unwrap();
        assert!(
            update_on(&db, update_request(&queued.job_id, "running", None))
                .unwrap_err()
                .contains("OPERATION_CONFIRMATION_REQUIRED")
        );
        assert_eq!(
            get_on(&db, &queued.job_id).unwrap().unwrap().status,
            "queued"
        );
        update_on(
            &db,
            update_request(&queued.job_id, "cancelled", Some("rejected")),
        )
        .unwrap();
        assert!(update_on(
            &db,
            update_request(&queued.job_id, "running", Some("confirmed"))
        )
        .is_err());
        let audit = audit_list_on(
            &db,
            OperationAuditListQuery {
                job_id: Some(queued.job_id),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(audit.len(), 2);
        assert!(!audit.iter().any(|entry| entry.status == "running"));
    }

    #[test]
    fn summaries_are_redacted_and_bounded() {
        let value = sanitize_summary(Some("systemctl restart app password=top-secret\nextra"))
            .expect("summary");
        assert!(value.contains("<redacted>"));
        assert!(!value.contains("top-secret"));
        assert!(!value.contains('\n'));
    }

    #[test]
    fn chinese_and_emoji_summaries_do_not_panic_at_byte_boundaries() {
        for text in ["运".repeat(86), "🔐".repeat(100)] {
            let summary = sanitize_summary(Some(&text)).unwrap();
            assert!(summary.len() <= super::MAX_SUMMARY_LEN);
            assert!(summary.ends_with('…'));
        }
    }

    #[test]
    fn status_transitions_are_monotonic() {
        assert!(legal_transition("queued", "running"));
        assert!(legal_transition("running", "unknown"));
        assert!(!legal_transition("completed", "running"));
        assert!(!legal_transition("unknown", "completed"));
        assert!(valid_status("cancelled"));
        assert!(!valid_status("pending"));
    }

    #[test]
    fn queued_mcp_jobs_can_be_reconciled_as_unknown_after_restart() {
        assert!(legal_transition("queued", "unknown"));
        assert!(valid_status("unknown"));
    }
}
