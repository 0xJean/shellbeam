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
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(client_id, request_id));
      CREATE TABLE IF NOT EXISTS mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL,
        host_id TEXT, tool TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_probes (
        vault_id TEXT NOT NULL, host_id TEXT NOT NULL, identity TEXT NOT NULL,
        value_json TEXT NOT NULL, PRIMARY KEY(vault_id,host_id));",
    )
    .map_err(|e| e.to_string())
}

pub fn recover(app: &tauri::AppHandle) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE mcp_jobs SET status='unknown', updated_at=?1 WHERE status='running'",
            [now_unix_ms()],
        )
        .map_err(|e| e.to_string())?;
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
        "INSERT INTO mcp_jobs VALUES (?1,?2,?3,?4,?5,?6,'running',?7,?7)",
        params![id, client, host, request, hash, tool, now_unix_ms()],
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
    open(app)?.query_row("SELECT host_id,tool,status,created_at,updated_at FROM mcp_jobs WHERE id=?1 AND client_id=?2",
        params![id, client], |row| Ok(json!({
            "jobId": id, "hostId": row.get::<_, String>(0)?, "tool": row.get::<_, String>(1)?,
            "status": row.get::<_, String>(2)?, "createdAt": row.get::<_, i64>(3)?, "updatedAt": row.get::<_, i64>(4)?,
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
            "INSERT INTO mcp_jobs VALUES ('j','a','h','r','hash','run_command','running',0,0)",
            [],
        )
        .unwrap();
        assert!(db
            .execute(
                "INSERT INTO mcp_jobs VALUES ('j2','a','h','r','hash','run_command','running',0,0)",
                []
            )
            .is_err());
        db.execute(
            "INSERT INTO mcp_jobs VALUES ('j3','b','h','r','hash','run_command','running',0,0)",
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
}
