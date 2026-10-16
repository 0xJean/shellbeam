use crate::data::operation_jobs;
use crate::storage::{data_file_path, now_unix_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub const RUNTIME_LOCK_FILE: &str = "mcp_runtime.sqlite3";

fn runtime_lock(path: &std::path::Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::ZERO)
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;")
        .map_err(|_| "MCP_ALREADY_RUNNING: close other ShellBeam instances and restart this one")?;
    Ok(db)
}

pub fn acquire_runtime(app: &tauri::AppHandle) -> Result<Connection, String> {
    runtime_lock(&data_file_path(app, RUNTIME_LOCK_FILE)?)
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db = Connection::open(data_file_path(app, "mcp.sqlite3")?).map_err(|e| e.to_string())?;
    initialize(&db)?;
    Ok(db)
}

fn initialize(db: &Connection) -> Result<(), String> {
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS mcp_jobs (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, host_id TEXT NOT NULL,
        request_id TEXT NOT NULL, request_hash TEXT NOT NULL, tool TEXT NOT NULL,
        operation_job_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(client_id, request_id));
      CREATE TABLE IF NOT EXISTS mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL,
        host_id TEXT, tool TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_probes (
        vault_id TEXT NOT NULL, host_id TEXT NOT NULL, identity TEXT NOT NULL,
        value_json TEXT NOT NULL, PRIMARY KEY(vault_id,host_id));",
    )
    .map_err(|e| e.to_string())?;
    let mut columns = db
        .prepare("PRAGMA table_info(mcp_jobs)")
        .map_err(|e| e.to_string())?;
    let has_operation_job_id = columns
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|column| column == "operation_job_id");
    drop(columns);
    if !has_operation_job_id {
        db.execute("ALTER TABLE mcp_jobs ADD COLUMN operation_job_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn recovered_mcp_status(operation_status: Option<&str>) -> &'static str {
    match operation_status {
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("cancelled") => "cancelled",
        Some("unknown") | Some("queued") | Some("running") | None => "unknown",
        Some(_) => "unknown",
    }
}

pub fn recover(app: &tauri::AppHandle) -> Result<(), String> {
    let db = open(app)?;
    let mut statement = db
        .prepare("SELECT id,operation_job_id FROM mcp_jobs WHERE status='running'")
        .map_err(|e| e.to_string())?;
    let jobs = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(statement);

    for (mcp_job_id, operation_job_id) in jobs {
        let operation_job = operation_job_id.as_deref().and_then(|id| {
            match operation_jobs::operation_job_get(app.clone(), id.to_string()) {
                Ok(job) => job,
                Err(error) => {
                    log::error!("MCP OperationJob recovery lookup failed: {error}");
                    None
                }
            }
        });

        let status = recovered_mcp_status(operation_job.as_ref().map(|job| job.status.as_str()));
        if operation_job
            .as_ref()
            .is_some_and(|job| matches!(job.status.as_str(), "queued" | "running"))
        {
            if let Some(operation_job_id) = operation_job_id {
                if let Err(error) = operation_jobs::operation_job_update(
                    app.clone(),
                    operation_jobs::UpdateOperationJobRequest {
                        job_id: operation_job_id,
                        status: "unknown".to_string(),
                        confirmation_status: None,
                        confirmed_by: None,
                        result_summary: Some(
                            "MCP worker interrupted; reconcile remote state before retrying".into(),
                        ),
                        error_code: Some("mcp_app_restarted".into()),
                        error_summary: Some(
                            "The app restarted before the MCP operation completed".into(),
                        ),
                        actor: Some("system".into()),
                    },
                ) {
                    log::error!("MCP OperationJob recovery update failed: {error}");
                }
            }
        }

        db.execute(
            "UPDATE mcp_jobs SET status=?1, updated_at=?2 WHERE id=?3",
            params![status, now_unix_ms(), mcp_job_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn save_probe(
    app: &tauri::AppHandle,
    vault: &str,
    host: &str,
    identity: &str,
    value: &Value,
) -> Result<(), String> {
    open(app)?.execute("INSERT INTO mcp_probes VALUES (?1,?2,?3,?4) ON CONFLICT(vault_id,host_id) DO UPDATE SET identity=excluded.identity,value_json=excluded.value_json",
        params![vault,host,identity,value.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn read_probe(
    app: &tauri::AppHandle,
    vault: &str,
    host: &str,
    identity: &str,
) -> Result<Option<Value>, String> {
    let raw: Option<String> = open(app)?
        .query_row(
            "SELECT value_json FROM mcp_probes WHERE vault_id=?1 AND host_id=?2 AND identity=?3",
            params![vault, host, identity],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
        .transpose()
}

pub fn existing(
    app: &tauri::AppHandle,
    client: &str,
    request: &str,
) -> Result<Option<(String, String)>, String> {
    open(app)?
        .query_row(
            "SELECT id,request_hash FROM mcp_jobs WHERE client_id=?1 AND request_id=?2",
            params![client, request],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())
}

pub fn create_job(
    app: &tauri::AppHandle,
    id: &str,
    client: &str,
    host: &str,
    request: &str,
    hash: &str,
    tool: &str,
    operation_job_id: Option<&str>,
) -> Result<(), String> {
    let db = open(app)?;
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM mcp_jobs WHERE client_id=?1",
            [client],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 10_000 {
        return Err("JOB_LIMIT_REACHED: revoke this client and authorize a new one".into());
    }
    db.execute(
        "INSERT INTO mcp_jobs
         (id,client_id,host_id,request_id,request_hash,tool,operation_job_id,status,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'running',?8,?8)",
        params![
            id,
            client,
            host,
            request,
            hash,
            tool,
            operation_job_id,
            now_unix_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn finish(app: &tauri::AppHandle, id: &str, status: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE mcp_jobs SET status=?1, updated_at=?2 WHERE id=?3",
            params![status, now_unix_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn job(app: &tauri::AppHandle, client: &str, id: &str) -> Result<Value, String> {
    open(app)?.query_row("SELECT host_id,tool,operation_job_id,status,created_at,updated_at FROM mcp_jobs WHERE id=?1 AND client_id=?2",
        params![id, client], |row| Ok(json!({
            "jobId": id, "hostId": row.get::<_, String>(0)?, "tool": row.get::<_, String>(1)?,
            "operationJobId": row.get::<_, Option<String>>(2)?, "status": row.get::<_, String>(3)?,
            "createdAt": row.get::<_, i64>(4)?, "updatedAt": row.get::<_, i64>(5)?,
            "outputAvailable": false,
            "notice": "Outputs are memory-only. After restart, verify remote state before retrying any operation."
        }))).optional().map_err(|e| e.to_string())?.ok_or_else(|| "JOB_NOT_FOUND".into())
}

pub fn audit(
    app: &tauri::AppHandle,
    client: &str,
    host: Option<&str>,
    tool: &str,
    outcome: &str,
) -> Result<(), String> {
    let mut db = open(app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    // Deliberately omit commands, paths, credentials and output from durable audit records.
    tx.execute(
        "INSERT INTO mcp_audit(client_id,host_id,tool,outcome,at) VALUES (?1,?2,?3,?4,?5)",
        params![client, host, tool, outcome, now_unix_ms()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM mcp_audit WHERE id NOT IN (SELECT id FROM mcp_audit ORDER BY id DESC LIMIT 2000)", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn list_audit(app: &tauri::AppHandle) -> Result<Vec<Value>, String> {
    let db = open(app)?;
    let mut statement = db
        .prepare(
            "SELECT client_id,host_id,tool,outcome,at FROM mcp_audit ORDER BY id DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({"clientId":row.get::<_, String>(0)?,
        "hostId":row.get::<_, Option<String>>(1)?, "tool":row.get::<_, String>(2)?,
        "outcome":row.get::<_, String>(3)?, "at":row.get::<_, i64>(4)?}))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovered_mcp_status_prefers_terminal_operation_outcomes() {
        assert_eq!(recovered_mcp_status(Some("completed")), "completed");
        assert_eq!(recovered_mcp_status(Some("failed")), "failed");
        assert_eq!(recovered_mcp_status(Some("cancelled")), "cancelled");
        assert_eq!(recovered_mcp_status(Some("unknown")), "unknown");
        assert_eq!(recovered_mcp_status(Some("running")), "unknown");
        assert_eq!(recovered_mcp_status(None), "unknown");
    }
    #[test]
    fn only_one_application_can_own_mcp_and_recover_jobs() {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-mcp-owner-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let owner = runtime_lock(&path).unwrap();
        assert!(runtime_lock(&path).is_err());
        drop(owner);
        let replacement = runtime_lock(&path).unwrap();
        drop(replacement);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn idempotency_is_per_client_and_recovery_does_not_retry() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db.execute(
            "INSERT INTO mcp_jobs (id,client_id,host_id,request_id,request_hash,tool,status,created_at,updated_at) VALUES ('j','a','h','r','hash','run_command','running',0,0)",
            [],
        )
        .unwrap();
        assert!(db
            .execute(
                "INSERT INTO mcp_jobs (id,client_id,host_id,request_id,request_hash,tool,status,created_at,updated_at) VALUES ('j2','a','h','r','hash','run_command','running',0,0)",
                []
            )
            .is_err());
        db.execute(
            "INSERT INTO mcp_jobs (id,client_id,host_id,request_id,request_hash,tool,status,created_at,updated_at) VALUES ('j3','b','h','r','hash','run_command','running',0,0)",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE mcp_jobs SET status='unknown' WHERE status='running'",
            [],
        )
        .unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM mcp_jobs WHERE status='unknown'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }
    #[test]
    fn legacy_mcp_jobs_schema_is_migrated_with_operation_job_link() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE mcp_jobs (
               id TEXT PRIMARY KEY, client_id TEXT NOT NULL, host_id TEXT NOT NULL,
               request_id TEXT NOT NULL, request_hash TEXT NOT NULL, tool TEXT NOT NULL,
               status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               UNIQUE(client_id, request_id)
             );",
        )
        .unwrap();
        initialize(&db).unwrap();

        let has_link: bool = db
            .prepare("PRAGMA table_info(mcp_jobs)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .any(|name| name == "operation_job_id");
        assert!(has_link);

        db.execute(
            "INSERT INTO mcp_jobs
             (id,client_id,host_id,request_id,request_hash,tool,status,created_at,updated_at)
             VALUES ('legacy','client','host','request','hash','run_command','running',0,0)",
            [],
        )
        .unwrap();
        let link: Option<String> = db
            .query_row(
                "SELECT operation_job_id FROM mcp_jobs WHERE id='legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(link.is_none());
    }


    #[test]
    fn mcp_job_link_is_stored_without_durable_command_or_output_columns() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db.execute(
            "INSERT INTO mcp_jobs
             (id,client_id,host_id,request_id,request_hash,tool,operation_job_id,status,created_at,updated_at)
             VALUES ('job','client','host','request','hash','run_command','operation','running',0,0)",
            [],
        )
        .unwrap();
        let operation_job_id: String = db
            .query_row(
                "SELECT operation_job_id FROM mcp_jobs WHERE id='job'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(operation_job_id, "operation");

        let columns = db
            .prepare("PRAGMA table_info(mcp_audit)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert!(!columns.iter().any(|column| column == "command"));
        assert!(!columns.iter().any(|column| column == "output"));
        assert!(!columns.iter().any(|column| column == "stdout"));
        assert!(!columns.iter().any(|column| column == "stderr"));
    }
}
