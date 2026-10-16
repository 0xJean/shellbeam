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
        value_json TEXT NOT NULL, PRIMARY KEY(vault_id,host_id));
      CREATE TABLE IF NOT EXISTS mcp_project_deployments (
        deployment_id TEXT NOT NULL, client_id TEXT NOT NULL, vault_id TEXT NOT NULL,
        host_id TEXT NOT NULL, name TEXT NOT NULL, deployment_path TEXT NOT NULL,
        project_kind TEXT NOT NULL, status TEXT NOT NULL, source_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL, components_json TEXT NOT NULL, runtime_json TEXT NOT NULL,
        notes TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_verified_at INTEGER, PRIMARY KEY(deployment_id, client_id));
      CREATE INDEX IF NOT EXISTS idx_mcp_project_deployments_client_host
        ON mcp_project_deployments(client_id,host_id,updated_at DESC);",
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

fn json_column(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

fn deployment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let source: String = row.get(8)?;
    let dependencies: String = row.get(9)?;
    let components: String = row.get(10)?;
    let runtime: String = row.get(11)?;
    Ok(json!({
        "deploymentId": row.get::<_, String>(0)?,
        "clientId": row.get::<_, String>(1)?,
        "vaultId": row.get::<_, String>(2)?,
        "hostId": row.get::<_, String>(3)?,
        "name": row.get::<_, String>(4)?,
        "deploymentPath": row.get::<_, String>(5)?,
        "projectKind": row.get::<_, String>(6)?,
        "status": row.get::<_, String>(7)?,
        "source": json_column(source),
        "dependencies": json_column(dependencies),
        "components": json_column(components),
        "runtime": json_column(runtime),
        "notes": row.get::<_, String>(12)?,
        "createdAt": row.get::<_, i64>(13)?,
        "updatedAt": row.get::<_, i64>(14)?,
        "lastVerifiedAt": row.get::<_, Option<i64>>(15)?,
    }))
}

pub fn upsert_project_deployment(
    app: &tauri::AppHandle,
    client_id: &str,
    vault_id: &str,
    payload: &Value,
) -> Result<Value, String> {
    let db = open(app)?;
    upsert_project_deployment_db(&db, client_id, vault_id, payload)
}

fn upsert_project_deployment_db(
    db: &Connection,
    client_id: &str,
    vault_id: &str,
    payload: &Value,
) -> Result<Value, String> {
    let deployment_id = payload["deploymentId"]
        .as_str()
        .ok_or("INVALID_DEPLOYMENT: deploymentId")?;
    let host_id = payload["hostId"]
        .as_str()
        .ok_or("INVALID_DEPLOYMENT: hostId")?;
    let now = now_unix_ms();
    let created_at = db
        .query_row(
            "SELECT created_at FROM mcp_project_deployments WHERE deployment_id=?1 AND client_id=?2",
            params![deployment_id, client_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(now);
    let text = |key: &str| payload[key].as_str().unwrap_or("");
    let json_text = |key: &str| payload.get(key).cloned().unwrap_or(Value::Null).to_string();
    db.execute(
        "INSERT INTO mcp_project_deployments
        (deployment_id,client_id,vault_id,host_id,name,deployment_path,project_kind,status,source_json,
         dependencies_json,components_json,runtime_json,notes,created_at,updated_at,last_verified_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
        ON CONFLICT(deployment_id,client_id) DO UPDATE SET
          vault_id=excluded.vault_id,host_id=excluded.host_id,name=excluded.name,
          deployment_path=excluded.deployment_path,project_kind=excluded.project_kind,status=excluded.status,
          source_json=excluded.source_json,dependencies_json=excluded.dependencies_json,
          components_json=excluded.components_json,runtime_json=excluded.runtime_json,notes=excluded.notes,
          updated_at=excluded.updated_at,last_verified_at=excluded.last_verified_at",
        params![
            deployment_id,
            client_id,
            vault_id,
            host_id,
            text("name"),
            text("deploymentPath"),
            text("projectKind"),
            text("status"),
            json_text("source"),
            json_text("dependencies"),
            json_text("components"),
            json_text("runtime"),
            text("notes"),
            created_at,
            now,
            payload["lastVerifiedAt"].as_i64(),
        ],
    )
    .map_err(|e| format!("Save project deployment failed: {e}"))?;
    db.query_row(
        "SELECT deployment_id,client_id,vault_id,host_id,name,deployment_path,project_kind,status,
                source_json,dependencies_json,components_json,runtime_json,notes,created_at,updated_at,last_verified_at
         FROM mcp_project_deployments WHERE deployment_id=?1 AND client_id=?2",
        params![deployment_id, client_id],
        deployment_row,
    )
    .map_err(|e| format!("Read project deployment failed: {e}"))
}

pub fn list_project_deployments(
    app: &tauri::AppHandle,
    client_id: &str,
    host_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let db = open(app)?;
    list_project_deployments_db(&db, client_id, host_id)
}

fn list_project_deployments_db(
    db: &Connection,
    client_id: &str,
    host_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut deployments = Vec::new();
    if let Some(host_id) = host_id {
        let mut statement = db
            .prepare(
                "SELECT deployment_id,client_id,vault_id,host_id,name,deployment_path,project_kind,status,
                        source_json,dependencies_json,components_json,runtime_json,notes,created_at,updated_at,last_verified_at
                 FROM mcp_project_deployments WHERE client_id=?1 AND host_id=?2 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![client_id, host_id], deployment_row)
            .map_err(|e| e.to_string())?;
        for row in rows {
            deployments.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let mut statement = db
            .prepare(
                "SELECT deployment_id,client_id,vault_id,host_id,name,deployment_path,project_kind,status,
                        source_json,dependencies_json,components_json,runtime_json,notes,created_at,updated_at,last_verified_at
                 FROM mcp_project_deployments WHERE client_id=?1 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![client_id], deployment_row)
            .map_err(|e| e.to_string())?;
        for row in rows {
            deployments.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(deployments)
}

pub fn list_project_deployments_for_vault(
    app: &tauri::AppHandle,
    vault_id: &str,
    host_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let db = open(app)?;
    list_project_deployments_for_vault_db(&db, vault_id, host_id)
}

fn list_project_deployments_for_vault_db(
    db: &Connection,
    vault_id: &str,
    host_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut deployments = Vec::new();
    let sql = if host_id.is_some() {
        "SELECT deployment_id,client_id,vault_id,host_id,name,deployment_path,project_kind,status,
                source_json,dependencies_json,components_json,runtime_json,notes,created_at,updated_at,last_verified_at
         FROM mcp_project_deployments WHERE vault_id=?1 AND host_id=?2 ORDER BY updated_at DESC"
    } else {
        "SELECT deployment_id,client_id,vault_id,host_id,name,deployment_path,project_kind,status,
                source_json,dependencies_json,components_json,runtime_json,notes,created_at,updated_at,last_verified_at
         FROM mcp_project_deployments WHERE vault_id=?1 ORDER BY updated_at DESC"
    };
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = match host_id {
        Some(host_id) => statement.query_map(params![vault_id, host_id], deployment_row),
        None => statement.query_map(params![vault_id], deployment_row),
    }
    .map_err(|e| e.to_string())?;
    for row in rows {
        deployments.push(row.map_err(|e| e.to_string())?);
    }
    Ok(deployments)
}

pub fn delete_project_deployments_for_host(
    app: &tauri::AppHandle,
    vault_id: &str,
    host_id: &str,
) -> Result<(), String> {
    delete_project_deployments_for_host_db(&open(app)?, vault_id, host_id)
}

fn delete_project_deployments_for_host_db(
    db: &Connection,
    vault_id: &str,
    host_id: &str,
) -> Result<(), String> {
    db.execute(
        "DELETE FROM mcp_project_deployments WHERE vault_id=?1 AND host_id=?2",
        params![vault_id, host_id],
    )
    .map_err(|e| format!("Delete project deployments failed: {e}"))?;
    Ok(())
}

/// Return the durable MCP result state that should be visible after a process
/// restart. In-memory worker output is intentionally discarded, so the linked
/// OperationJob is the source of truth whenever it exists. A queued/running
/// job cannot be proven to have stopped and therefore becomes `unknown`.
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
                    // A missing/corrupt canonical record must not prevent the
                    // MCP store from recovering the rest of its jobs. The
                    // result remains unknown and can be reconciled manually.
                    log::error!("MCP OperationJob recovery lookup failed: {error}");
                    None
                }
            }
        });

        let status = recovered_mcp_status(operation_job.as_ref().map(|job| job.status.as_str()));
        let operation_job_id_for_update = operation_job_id.clone();
        if operation_job
            .as_ref()
            .is_some_and(|job| matches!(job.status.as_str(), "queued" | "running"))
        {
            if let Some(operation_job_id) = operation_job_id_for_update {
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

        // Keep the MCP idempotency/result row aligned with the canonical
        // OperationJob. This matters when the previous process committed the
        // OperationJob terminal state just before it stopped, leaving mcp_jobs
        // at running. Subsequent sessions can then answer from either store.
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

    fn deployment(id: &str, host: &str, name: &str) -> Value {
        json!({
            "deploymentId": id,
            "hostId": host,
            "name": name,
            "deploymentPath": "/srv/api",
            "projectKind": "node",
            "status": "deployed",
            "source": {"repository": "https://example.invalid/api", "ref": "main"},
            "dependencies": [{"name": "node", "version": "22", "kind": "runtime"}],
            "components": [{"name": "api", "type": "service", "version": "1.0.0"}],
            "runtime": {"language": "node", "version": "22", "packageManager": "pnpm"},
            "notes": "recorded by agent",
            "lastVerifiedAt": 1234,
        })
    }

    #[test]
    fn deployment_records_upsert_without_losing_creation_time() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();

        let first = upsert_project_deployment_db(
            &db,
            "client-a",
            "vault-a",
            &deployment("deploy-1", "host-a", "API"),
        )
        .unwrap();
        let created_at = first["createdAt"].as_i64().unwrap();
        assert_eq!(first["name"], "API");
        assert_eq!(first["source"]["ref"], "main");
        assert_eq!(first["dependencies"][0]["version"], "22");

        let mut updated = deployment("deploy-1", "host-a", "API v2");
        updated["status"] = json!("failed");
        updated["lastVerifiedAt"] = json!(5678);
        let second = upsert_project_deployment_db(&db, "client-a", "vault-a", &updated).unwrap();
        assert_eq!(second["createdAt"], created_at);
        assert!(second["updatedAt"].as_i64().unwrap() >= created_at);
        assert_eq!(second["name"], "API v2");
        assert_eq!(second["status"], "failed");
        assert_eq!(second["lastVerifiedAt"], 5678);

        let rows = list_project_deployments_db(&db, "client-a", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["deploymentId"], "deploy-1");
    }

    #[test]
    fn deployment_records_are_scoped_by_client_vault_and_host() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        upsert_project_deployment_db(
            &db,
            "client-a",
            "vault-a",
            &deployment("same-id", "host-a", "A"),
        )
        .unwrap();
        upsert_project_deployment_db(
            &db,
            "client-b",
            "vault-a",
            &deployment("same-id", "host-a", "B"),
        )
        .unwrap();
        upsert_project_deployment_db(
            &db,
            "client-c",
            "vault-b",
            &deployment("other-id", "host-a", "C"),
        )
        .unwrap();
        upsert_project_deployment_db(
            &db,
            "client-a",
            "vault-a",
            &deployment("host-b-id", "host-b", "Other host"),
        )
        .unwrap();

        assert_eq!(
            list_project_deployments_db(&db, "client-a", None)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            list_project_deployments_db(&db, "client-a", Some("host-a"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_project_deployments_for_vault_db(&db, "vault-a", None)
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            list_project_deployments_for_vault_db(&db, "vault-a", Some("host-a"))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            list_project_deployments_for_vault_db(&db, "vault-b", None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn deleting_a_host_removes_only_that_vault_scope() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        upsert_project_deployment_db(&db, "client-a", "vault-a", &deployment("a", "host-a", "A"))
            .unwrap();
        upsert_project_deployment_db(&db, "client-b", "vault-b", &deployment("b", "host-a", "B"))
            .unwrap();
        upsert_project_deployment_db(&db, "client-c", "vault-a", &deployment("c", "host-b", "C"))
            .unwrap();

        delete_project_deployments_for_host_db(&db, "vault-a", "host-a").unwrap();
        assert_eq!(
            list_project_deployments_for_vault_db(&db, "vault-a", None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_project_deployments_for_vault_db(&db, "vault-a", None).unwrap()[0]["hostId"],
            "host-b"
        );
        assert_eq!(
            list_project_deployments_for_vault_db(&db, "vault-b", None)
                .unwrap()
                .len(),
            1
        );
    }

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
            "INSERT INTO mcp_jobs
             (id,client_id,host_id,request_id,request_hash,tool,status,created_at,updated_at)
             VALUES ('j','a','h','r','hash','run_command','running',0,0)",
            [],
        )
        .unwrap();
        assert!(db
            .execute(
                "INSERT INTO mcp_jobs
                 (id,client_id,host_id,request_id,request_hash,tool,status,created_at,updated_at)
                 VALUES ('j2','a','h','r','hash','run_command','running',0,0)",
                []
            )
            .is_err());
        db.execute(
            "INSERT INTO mcp_jobs
             (id,client_id,host_id,request_id,request_hash,tool,status,created_at,updated_at)
             VALUES ('j3','b','h','r','hash','run_command','running',0,0)",
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
