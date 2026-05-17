use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::data_file_path;

const WORKSPACE_INVENTORY_DB: &str = "workspace_inventory.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInventorySnapshot {
    pub host_key: String,
    pub host_id: String,
    pub host_name: String,
    pub host_address: String,
    pub username: String,
    pub port: u16,
    pub inventory: Value,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInventorySnapshotPayload {
    pub host_key: String,
    pub host_id: String,
    pub host_name: String,
    pub host_address: String,
    pub username: String,
    pub port: u16,
    pub inventory: Value,
    pub updated_at: i64,
}

fn open_workspace_inventory_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = data_file_path(app, WORKSPACE_INVENTORY_DB)?;
    let conn = Connection::open(path).map_err(|err| format!("Open workspace inventory db failed: {err}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS workspace_inventory_snapshots (
          host_key TEXT PRIMARY KEY NOT NULL,
          host_id TEXT NOT NULL,
          host_name TEXT NOT NULL,
          host_address TEXT NOT NULL,
          username TEXT NOT NULL,
          port INTEGER NOT NULL,
          inventory_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_inventory_snapshots_updated_at
          ON workspace_inventory_snapshots(updated_at DESC);
        "#,
    )
    .map_err(|err| format!("Initialize workspace inventory db failed: {err}"))?;
    Ok(conn)
}

#[tauri::command]
pub fn list_workspace_inventory_snapshots(
    app: tauri::AppHandle,
) -> Result<Vec<WorkspaceInventorySnapshot>, String> {
    let conn = open_workspace_inventory_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT host_key, host_id, host_name, host_address, username, port, inventory_json, updated_at
            FROM workspace_inventory_snapshots
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|err| format!("Prepare workspace inventory snapshot query failed: {err}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|err| format!("Query workspace inventory snapshots failed: {err}"))?;
    let mut snapshots = Vec::new();

    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Read workspace inventory snapshot failed: {err}"))?
    {
        let inventory_json: String = row
            .get(6)
            .map_err(|err| format!("Read workspace inventory json failed: {err}"))?;
        let inventory = serde_json::from_str::<Value>(&inventory_json)
            .map_err(|err| format!("Parse workspace inventory json failed: {err}"))?;
        let port_raw: i64 = row
            .get(5)
            .map_err(|err| format!("Read workspace inventory port failed: {err}"))?;
        let port = u16::try_from(port_raw).unwrap_or(22);

        snapshots.push(WorkspaceInventorySnapshot {
            host_key: row
                .get(0)
                .map_err(|err| format!("Read workspace inventory host key failed: {err}"))?,
            host_id: row
                .get(1)
                .map_err(|err| format!("Read workspace inventory host id failed: {err}"))?,
            host_name: row
                .get(2)
                .map_err(|err| format!("Read workspace inventory host name failed: {err}"))?,
            host_address: row
                .get(3)
                .map_err(|err| format!("Read workspace inventory host address failed: {err}"))?,
            username: row
                .get(4)
                .map_err(|err| format!("Read workspace inventory username failed: {err}"))?,
            port,
            inventory,
            updated_at: row
                .get(7)
                .map_err(|err| format!("Read workspace inventory updated_at failed: {err}"))?,
        });
    }

    Ok(snapshots)
}

#[tauri::command]
pub fn upsert_workspace_inventory_snapshot(
    app: tauri::AppHandle,
    payload: WorkspaceInventorySnapshotPayload,
) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    let inventory_json = serde_json::to_string(&payload.inventory)
        .map_err(|err| format!("Serialize workspace inventory failed: {err}"))?;

    conn.execute(
        r#"
        INSERT INTO workspace_inventory_snapshots
          (host_key, host_id, host_name, host_address, username, port, inventory_json, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(host_key) DO UPDATE SET
          host_id = excluded.host_id,
          host_name = excluded.host_name,
          host_address = excluded.host_address,
          username = excluded.username,
          port = excluded.port,
          inventory_json = excluded.inventory_json,
          updated_at = excluded.updated_at
        "#,
        params![
            payload.host_key,
            payload.host_id,
            payload.host_name,
            payload.host_address,
            payload.username,
            payload.port,
            inventory_json,
            payload.updated_at,
        ],
    )
    .map_err(|err| format!("Save workspace inventory snapshot failed: {err}"))?;

    Ok(())
}

#[tauri::command]
pub fn delete_workspace_inventory_snapshot(
    app: tauri::AppHandle,
    host_key: String,
) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    conn.execute(
        "DELETE FROM workspace_inventory_snapshots WHERE host_key = ?1",
        params![host_key],
    )
    .map_err(|err| format!("Delete workspace inventory snapshot failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn clear_workspace_inventory_snapshots(app: tauri::AppHandle) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    conn.execute("DELETE FROM workspace_inventory_snapshots", [])
        .map_err(|err| format!("Clear workspace inventory snapshots failed: {err}"))?;
    Ok(())
}
