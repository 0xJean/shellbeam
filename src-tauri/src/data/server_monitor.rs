use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::data_file_path;

const SERVER_MONITOR_DB: &str = "workspace_inventory.sqlite3";
const HISTORY_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMonitorLatest {
    pub host_key: String,
    pub host_id: String,
    pub host_name: String,
    pub host_address: String,
    pub username: String,
    pub port: u16,
    pub status: String,
    pub snapshot: Option<Value>,
    pub last_attempt_at: i64,
    pub last_success_at: Option<i64>,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMonitorResultPayload {
    pub latest: ServerMonitorLatest,
    pub history: Option<ServerMonitorHistoryPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMonitorHistoryPoint {
    pub host_key: String,
    pub sampled_at: i64,
    pub snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMonitorHistoryQuery {
    pub host_key: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
}

fn open_server_monitor_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = data_file_path(app, SERVER_MONITOR_DB)?;
    let conn =
        Connection::open(path).map_err(|err| format!("Open server monitor db failed: {err}"))?;

    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS server_monitor_latest (
          host_key TEXT PRIMARY KEY NOT NULL,
          host_id TEXT NOT NULL,
          host_name TEXT NOT NULL,
          host_address TEXT NOT NULL,
          username TEXT NOT NULL,
          port INTEGER NOT NULL,
          status TEXT NOT NULL,
          snapshot_json TEXT,
          last_attempt_at INTEGER NOT NULL,
          last_success_at INTEGER,
          error TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_server_monitor_latest_updated_at
          ON server_monitor_latest(updated_at DESC);
        CREATE TABLE IF NOT EXISTS server_monitor_history (
          host_key TEXT NOT NULL,
          sampled_at INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (host_key, sampled_at)
        );
        CREATE INDEX IF NOT EXISTS idx_server_monitor_history_host_sampled_at
          ON server_monitor_history(host_key, sampled_at DESC);
        "#,
    )
    .map_err(|err| format!("Initialize server monitor db failed: {err}"))?;

    Ok(conn)
}

fn parse_snapshot(raw: Option<String>) -> Result<Option<Value>, String> {
    raw.map(|value| {
        serde_json::from_str::<Value>(&value)
            .map_err(|err| format!("Parse server monitor snapshot failed: {err}"))
    })
    .transpose()
}

#[tauri::command]
pub fn list_server_monitor_latest(
    app: tauri::AppHandle,
) -> Result<Vec<ServerMonitorLatest>, String> {
    let conn = open_server_monitor_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT host_key, host_id, host_name, host_address, username, port,
                   status, snapshot_json, last_attempt_at, last_success_at, error, updated_at
            FROM server_monitor_latest
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|err| format!("Prepare server monitor latest query failed: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            let port_raw: i64 = row.get(5)?;
            let snapshot_json: Option<String> = row.get(7)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                u16::try_from(port_raw).unwrap_or(22),
                row.get::<_, String>(6)?,
                snapshot_json,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, i64>(11)?,
            ))
        })
        .map_err(|err| format!("Query server monitor latest failed: {err}"))?;

    let mut latest = Vec::new();
    for row in rows {
        let (
            host_key,
            host_id,
            host_name,
            host_address,
            username,
            port,
            status,
            snapshot_json,
            last_attempt_at,
            last_success_at,
            error,
            updated_at,
        ) = row.map_err(|err| format!("Read server monitor latest failed: {err}"))?;
        latest.push(ServerMonitorLatest {
            host_key,
            host_id,
            host_name,
            host_address,
            username,
            port,
            status,
            snapshot: parse_snapshot(snapshot_json)?,
            last_attempt_at,
            last_success_at,
            error,
            updated_at,
        });
    }

    Ok(latest)
}

#[tauri::command]
pub fn list_server_monitor_history(
    app: tauri::AppHandle,
    query: ServerMonitorHistoryQuery,
) -> Result<Vec<ServerMonitorHistoryPoint>, String> {
    let conn = open_server_monitor_db(&app)?;
    let from = query.from.unwrap_or(0);
    let to = query.to.unwrap_or(i64::MAX);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT host_key, sampled_at, snapshot_json
            FROM server_monitor_history
            WHERE host_key = ?1 AND sampled_at >= ?2 AND sampled_at <= ?3
            ORDER BY sampled_at ASC
            "#,
        )
        .map_err(|err| format!("Prepare server monitor history query failed: {err}"))?;

    let rows = stmt
        .query_map(params![query.host_key, from, to], |row| {
            let snapshot_json: String = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                snapshot_json,
            ))
        })
        .map_err(|err| format!("Query server monitor history failed: {err}"))?;

    let mut history = Vec::new();
    for row in rows {
        let (host_key, sampled_at, snapshot_json) =
            row.map_err(|err| format!("Read server monitor history failed: {err}"))?;
        let snapshot = serde_json::from_str::<Value>(&snapshot_json)
            .map_err(|err| format!("Parse server monitor history snapshot failed: {err}"))?;
        history.push(ServerMonitorHistoryPoint {
            host_key,
            sampled_at,
            snapshot,
        });
    }

    Ok(history)
}

#[tauri::command]
pub fn save_server_monitor_result(
    app: tauri::AppHandle,
    payload: ServerMonitorResultPayload,
) -> Result<(), String> {
    let mut conn = open_server_monitor_db(&app)?;
    persist_result(&mut conn, payload)
}

fn persist_result(
    conn: &mut Connection,
    payload: ServerMonitorResultPayload,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin server monitor transaction failed: {err}"))?;
    let mut payload = payload;
    // A scheduled request can fail after an on-demand MCP sample has succeeded.
    // Keep the newer successful data while recording the newer failure attempt.
    let previous: Option<(Option<String>, Option<i64>)> = tx.query_row(
        "SELECT snapshot_json,last_success_at FROM server_monitor_latest WHERE host_key=?1 AND host_address=?2 AND username=?3 AND port=?4",
        params![payload.latest.host_key,payload.latest.host_address,payload.latest.username,payload.latest.port],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(|err| format!("Read previous monitor sample failed: {err}"))?;
    if let Some((snapshot, Some(success_at))) = previous {
        if success_at > payload.latest.last_success_at.unwrap_or(i64::MIN) {
            payload.latest.snapshot = snapshot
                .map(|raw| serde_json::from_str(&raw))
                .transpose()
                .map_err(|err| format!("Read previous monitor snapshot failed: {err}"))?;
            payload.latest.last_success_at = Some(success_at);
            if payload.latest.status == "offline"
                && payload.latest.updated_at.saturating_sub(success_at) <= 300_000
            {
                payload.latest.status = "stale".into();
            }
        }
    }
    let snapshot_json = payload
        .latest
        .snapshot
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| format!("Serialize server monitor snapshot failed: {err}"))?;

    tx.execute(
        r#"
        INSERT INTO server_monitor_latest
          (host_key, host_id, host_name, host_address, username, port, status,
           snapshot_json, last_attempt_at, last_success_at, error, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(host_key) DO UPDATE SET
          host_id = excluded.host_id,
          host_name = excluded.host_name,
          host_address = excluded.host_address,
          username = excluded.username,
          port = excluded.port,
          status = excluded.status,
          snapshot_json = excluded.snapshot_json,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          error = excluded.error,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= server_monitor_latest.updated_at
        "#,
        params![
            payload.latest.host_key,
            payload.latest.host_id,
            payload.latest.host_name,
            payload.latest.host_address,
            payload.latest.username,
            payload.latest.port,
            payload.latest.status,
            snapshot_json,
            payload.latest.last_attempt_at,
            payload.latest.last_success_at,
            payload.latest.error,
            payload.latest.updated_at,
        ],
    )
    .map_err(|err| format!("Save server monitor latest failed: {err}"))?;

    if let Some(history) = payload.history {
        let history_snapshot = serde_json::to_string(&history.snapshot)
            .map_err(|err| format!("Serialize server monitor history failed: {err}"))?;
        tx.execute(
            r#"
            INSERT INTO server_monitor_history (host_key, sampled_at, snapshot_json)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(host_key, sampled_at) DO UPDATE SET
              snapshot_json = excluded.snapshot_json
            "#,
            params![history.host_key, history.sampled_at, history_snapshot],
        )
        .map_err(|err| format!("Save server monitor history failed: {err}"))?;
    }

    let cutoff = payload.latest.updated_at - HISTORY_RETENTION_MS;
    tx.execute(
        "DELETE FROM server_monitor_history WHERE sampled_at < ?1",
        params![cutoff],
    )
    .map_err(|err| format!("Prune server monitor history failed: {err}"))?;

    tx.commit()
        .map_err(|err| format!("Commit server monitor transaction failed: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn late_sampler_cannot_replace_newer_mcp_metrics_and_history_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE server_monitor_latest (
            host_key TEXT PRIMARY KEY,host_id TEXT,host_name TEXT,host_address TEXT,
            username TEXT,port INTEGER,status TEXT,snapshot_json TEXT,last_attempt_at INTEGER,
            last_success_at INTEGER,error TEXT,updated_at INTEGER);
            CREATE TABLE server_monitor_history (host_key TEXT,sampled_at INTEGER,snapshot_json TEXT,
            PRIMARY KEY(host_key,sampled_at));").unwrap();
        let payload = |time, cpu| ServerMonitorResultPayload {
            latest: ServerMonitorLatest {
                host_key: "h".into(),
                host_id: "h".into(),
                host_name: "dev".into(),
                host_address: "192.0.2.1".into(),
                username: "deploy".into(),
                port: 22,
                status: "online".into(),
                snapshot: Some(json!({"cpuPercent":cpu})),
                last_attempt_at: time,
                last_success_at: Some(time),
                error: None,
                updated_at: time,
            },
            history: Some(ServerMonitorHistoryPoint {
                host_key: "h".into(),
                sampled_at: time,
                snapshot: json!({"cpuPercent":cpu}),
            }),
        };
        persist_result(&mut conn, payload(200, 20)).unwrap();
        persist_result(&mut conn, payload(100, 10)).unwrap();
        persist_result(&mut conn, payload(100, 10)).unwrap();
        let (time, raw): (i64, String) = conn
            .query_row(
                "SELECT updated_at,snapshot_json FROM server_monitor_latest",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(time, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["cpuPercent"],
            20
        );
        let count: i64 = conn
            .query_row("SELECT count(*) FROM server_monitor_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        let mut failure = payload(300, 10);
        failure.latest.last_success_at = Some(100);
        failure.latest.status = "offline".into();
        failure.history = None;
        persist_result(&mut conn, failure).unwrap();
        let (status, success, raw): (String, i64, String) = conn
            .query_row(
                "SELECT status,last_success_at,snapshot_json FROM server_monitor_latest",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "stale");
        assert_eq!(success, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["cpuPercent"],
            20
        );
    }
}

#[tauri::command]
pub fn delete_server_monitor_data(app: tauri::AppHandle, host_key: String) -> Result<(), String> {
    let mut conn = open_server_monitor_db(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin delete server monitor transaction failed: {err}"))?;
    tx.execute(
        "DELETE FROM server_monitor_latest WHERE host_key = ?1",
        params![host_key],
    )
    .map_err(|err| format!("Delete server monitor latest failed: {err}"))?;
    tx.execute(
        "DELETE FROM server_monitor_history WHERE host_key = ?1",
        params![host_key],
    )
    .map_err(|err| format!("Delete server monitor history failed: {err}"))?;
    tx.commit()
        .map_err(|err| format!("Commit delete server monitor transaction failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn clear_server_monitor_data(app: tauri::AppHandle) -> Result<(), String> {
    let mut conn = open_server_monitor_db(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin clear server monitor transaction failed: {err}"))?;
    tx.execute("DELETE FROM server_monitor_latest", [])
        .map_err(|err| format!("Clear server monitor latest failed: {err}"))?;
    tx.execute("DELETE FROM server_monitor_history", [])
        .map_err(|err| format!("Clear server monitor history failed: {err}"))?;
    tx.commit()
        .map_err(|err| format!("Commit clear server monitor transaction failed: {err}"))?;
    Ok(())
}
