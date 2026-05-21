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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicIpLocationSnapshot {
    pub ip: String,
    pub location_label: String,
    pub country_code: Option<String>,
    pub country_name: Option<String>,
    pub provider: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicIpLocationPayload {
    pub ip: String,
    pub location_label: String,
    pub country_code: Option<String>,
    pub country_name: Option<String>,
    pub provider: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInventoryHostStateSnapshot {
    pub host_key: String,
    pub host_id: String,
    pub host_name: String,
    pub host_address: String,
    pub username: String,
    pub port: u16,
    pub host_group: String,
    pub tags: Vec<String>,
    pub auth_type: String,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInventoryHostStatePayload {
    pub host_key: String,
    pub host_id: String,
    pub host_name: String,
    pub host_address: String,
    pub username: String,
    pub port: u16,
    pub host_group: String,
    pub tags: Vec<String>,
    pub auth_type: String,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceToolStatusSnapshot {
    pub host_key: String,
    pub host_id: String,
    pub host_name: String,
    pub host_address: String,
    pub username: String,
    pub port: u16,
    pub tool_id: String,
    pub tool_name: String,
    pub status: Value,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceToolStatusPayload {
    pub host_key: String,
    pub host_id: String,
    pub host_name: String,
    pub host_address: String,
    pub username: String,
    pub port: u16,
    pub tool_id: String,
    pub tool_name: String,
    pub status: Value,
    pub updated_at: i64,
}

fn open_workspace_inventory_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = data_file_path(app, WORKSPACE_INVENTORY_DB)?;
    let conn = Connection::open(path)
        .map_err(|err| format!("Open workspace inventory db failed: {err}"))?;
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
        CREATE TABLE IF NOT EXISTS public_ip_locations (
          ip TEXT PRIMARY KEY NOT NULL,
          location_label TEXT NOT NULL,
          country_code TEXT,
          country_name TEXT,
          provider TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_public_ip_locations_updated_at
          ON public_ip_locations(updated_at DESC);
        CREATE TABLE IF NOT EXISTS workspace_inventory_host_states (
          host_key TEXT PRIMARY KEY NOT NULL,
          host_id TEXT NOT NULL,
          host_name TEXT NOT NULL,
          host_address TEXT NOT NULL,
          username TEXT NOT NULL,
          port INTEGER NOT NULL,
          host_group TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          auth_type TEXT NOT NULL,
          jump_host TEXT,
          jump_port INTEGER,
          jump_user TEXT,
          status TEXT NOT NULL,
          error TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_inventory_host_states_updated_at
          ON workspace_inventory_host_states(updated_at DESC);
        CREATE TABLE IF NOT EXISTS workspace_tool_statuses (
          host_key TEXT NOT NULL,
          tool_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          host_name TEXT NOT NULL,
          host_address TEXT NOT NULL,
          username TEXT NOT NULL,
          port INTEGER NOT NULL,
          tool_name TEXT NOT NULL,
          status_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (host_key, tool_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_tool_statuses_host_updated_at
          ON workspace_tool_statuses(host_key, updated_at DESC);
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

#[tauri::command]
pub fn list_public_ip_locations(
    app: tauri::AppHandle,
    ips: Vec<String>,
) -> Result<Vec<PublicIpLocationSnapshot>, String> {
    if ips.is_empty() {
        return Ok(Vec::new());
    }

    let conn = open_workspace_inventory_db(&app)?;
    let mut snapshots = Vec::new();

    for ip in ips {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT ip, location_label, country_code, country_name, provider, updated_at
                FROM public_ip_locations
                WHERE ip = ?1
                "#,
            )
            .map_err(|err| format!("Prepare public IP location query failed: {err}"))?;
        let mut rows = stmt
            .query(params![ip])
            .map_err(|err| format!("Query public IP location failed: {err}"))?;

        if let Some(row) = rows
            .next()
            .map_err(|err| format!("Read public IP location failed: {err}"))?
        {
            snapshots.push(PublicIpLocationSnapshot {
                ip: row
                    .get(0)
                    .map_err(|err| format!("Read public IP failed: {err}"))?,
                location_label: row
                    .get(1)
                    .map_err(|err| format!("Read public IP location label failed: {err}"))?,
                country_code: row
                    .get(2)
                    .map_err(|err| format!("Read public IP country code failed: {err}"))?,
                country_name: row
                    .get(3)
                    .map_err(|err| format!("Read public IP country name failed: {err}"))?,
                provider: row
                    .get(4)
                    .map_err(|err| format!("Read public IP location provider failed: {err}"))?,
                updated_at: row
                    .get(5)
                    .map_err(|err| format!("Read public IP location updated_at failed: {err}"))?,
            });
        }
    }

    Ok(snapshots)
}

#[tauri::command]
pub fn upsert_public_ip_location(
    app: tauri::AppHandle,
    payload: PublicIpLocationPayload,
) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;

    conn.execute(
        r#"
        INSERT INTO public_ip_locations
          (ip, location_label, country_code, country_name, provider, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(ip) DO UPDATE SET
          location_label = excluded.location_label,
          country_code = excluded.country_code,
          country_name = excluded.country_name,
          provider = excluded.provider,
          updated_at = excluded.updated_at
        "#,
        params![
            payload.ip,
            payload.location_label,
            payload.country_code,
            payload.country_name,
            payload.provider,
            payload.updated_at,
        ],
    )
    .map_err(|err| format!("Save public IP location failed: {err}"))?;

    Ok(())
}

#[tauri::command]
pub fn clear_public_ip_locations(app: tauri::AppHandle) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    conn.execute("DELETE FROM public_ip_locations", [])
        .map_err(|err| format!("Clear public IP locations failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_workspace_inventory_host_states(
    app: tauri::AppHandle,
) -> Result<Vec<WorkspaceInventoryHostStateSnapshot>, String> {
    let conn = open_workspace_inventory_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT host_key, host_id, host_name, host_address, username, port, host_group, tags_json,
                   auth_type, jump_host, jump_port, jump_user, status, error, updated_at
            FROM workspace_inventory_host_states
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|err| format!("Prepare workspace inventory host states query failed: {err}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|err| format!("Query workspace inventory host states failed: {err}"))?;
    let mut snapshots = Vec::new();

    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Read workspace inventory host state failed: {err}"))?
    {
        let tags_json: String = row
            .get(7)
            .map_err(|err| format!("Read workspace inventory host state tags failed: {err}"))?;
        let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
        let port_raw: i64 = row
            .get(5)
            .map_err(|err| format!("Read workspace inventory host state port failed: {err}"))?;
        let port = u16::try_from(port_raw).unwrap_or(22);
        let jump_port_raw: Option<i64> = row.get(10).map_err(|err| {
            format!("Read workspace inventory host state jump port failed: {err}")
        })?;
        let jump_port = jump_port_raw.and_then(|value| u16::try_from(value).ok());

        snapshots.push(WorkspaceInventoryHostStateSnapshot {
            host_key: row
                .get(0)
                .map_err(|err| format!("Read workspace inventory host state key failed: {err}"))?,
            host_id: row
                .get(1)
                .map_err(|err| format!("Read workspace inventory host state id failed: {err}"))?,
            host_name: row
                .get(2)
                .map_err(|err| format!("Read workspace inventory host state name failed: {err}"))?,
            host_address: row.get(3).map_err(|err| {
                format!("Read workspace inventory host state address failed: {err}")
            })?,
            username: row.get(4).map_err(|err| {
                format!("Read workspace inventory host state username failed: {err}")
            })?,
            port,
            host_group: row.get(6).map_err(|err| {
                format!("Read workspace inventory host state group failed: {err}")
            })?,
            tags,
            auth_type: row.get(8).map_err(|err| {
                format!("Read workspace inventory host state auth type failed: {err}")
            })?,
            jump_host: row.get(9).map_err(|err| {
                format!("Read workspace inventory host state jump host failed: {err}")
            })?,
            jump_port,
            jump_user: row.get(11).map_err(|err| {
                format!("Read workspace inventory host state jump user failed: {err}")
            })?,
            status: row.get(12).map_err(|err| {
                format!("Read workspace inventory host state status failed: {err}")
            })?,
            error: row.get(13).map_err(|err| {
                format!("Read workspace inventory host state error failed: {err}")
            })?,
            updated_at: row.get(14).map_err(|err| {
                format!("Read workspace inventory host state updated_at failed: {err}")
            })?,
        });
    }

    Ok(snapshots)
}

#[tauri::command]
pub fn upsert_workspace_inventory_host_state(
    app: tauri::AppHandle,
    payload: WorkspaceInventoryHostStatePayload,
) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    let tags_json = serde_json::to_string(&payload.tags)
        .map_err(|err| format!("Serialize workspace inventory host state tags failed: {err}"))?;

    conn.execute(
        r#"
        INSERT INTO workspace_inventory_host_states
          (host_key, host_id, host_name, host_address, username, port, host_group, tags_json,
           auth_type, jump_host, jump_port, jump_user, status, error, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(host_key) DO UPDATE SET
          host_id = excluded.host_id,
          host_name = excluded.host_name,
          host_address = excluded.host_address,
          username = excluded.username,
          port = excluded.port,
          host_group = excluded.host_group,
          tags_json = excluded.tags_json,
          auth_type = excluded.auth_type,
          jump_host = excluded.jump_host,
          jump_port = excluded.jump_port,
          jump_user = excluded.jump_user,
          status = excluded.status,
          error = excluded.error,
          updated_at = excluded.updated_at
        "#,
        params![
            payload.host_key,
            payload.host_id,
            payload.host_name,
            payload.host_address,
            payload.username,
            payload.port,
            payload.host_group,
            tags_json,
            payload.auth_type,
            payload.jump_host,
            payload.jump_port,
            payload.jump_user,
            payload.status,
            payload.error,
            payload.updated_at,
        ],
    )
    .map_err(|err| format!("Save workspace inventory host state failed: {err}"))?;

    Ok(())
}

#[tauri::command]
pub fn clear_workspace_inventory_host_states(app: tauri::AppHandle) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    conn.execute("DELETE FROM workspace_inventory_host_states", [])
        .map_err(|err| format!("Clear workspace inventory host states failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_workspace_tool_statuses(
    app: tauri::AppHandle,
) -> Result<Vec<WorkspaceToolStatusSnapshot>, String> {
    let conn = open_workspace_inventory_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT host_key, host_id, host_name, host_address, username, port,
                   tool_id, tool_name, status_json, updated_at
            FROM workspace_tool_statuses
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|err| format!("Prepare workspace tool statuses query failed: {err}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|err| format!("Query workspace tool statuses failed: {err}"))?;
    let mut snapshots = Vec::new();

    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Read workspace tool status failed: {err}"))?
    {
        let port_raw: i64 = row
            .get(5)
            .map_err(|err| format!("Read workspace tool status port failed: {err}"))?;
        let port = u16::try_from(port_raw).unwrap_or(22);
        let status_json: String = row
            .get(8)
            .map_err(|err| format!("Read workspace tool status json failed: {err}"))?;
        let status = serde_json::from_str::<Value>(&status_json)
            .map_err(|err| format!("Parse workspace tool status json failed: {err}"))?;

        snapshots.push(WorkspaceToolStatusSnapshot {
            host_key: row
                .get(0)
                .map_err(|err| format!("Read workspace tool status host key failed: {err}"))?,
            host_id: row
                .get(1)
                .map_err(|err| format!("Read workspace tool status host id failed: {err}"))?,
            host_name: row
                .get(2)
                .map_err(|err| format!("Read workspace tool status host name failed: {err}"))?,
            host_address: row
                .get(3)
                .map_err(|err| format!("Read workspace tool status host address failed: {err}"))?,
            username: row
                .get(4)
                .map_err(|err| format!("Read workspace tool status username failed: {err}"))?,
            port,
            tool_id: row
                .get(6)
                .map_err(|err| format!("Read workspace tool status tool id failed: {err}"))?,
            tool_name: row
                .get(7)
                .map_err(|err| format!("Read workspace tool status tool name failed: {err}"))?,
            status,
            updated_at: row
                .get(9)
                .map_err(|err| format!("Read workspace tool status updated_at failed: {err}"))?,
        });
    }

    Ok(snapshots)
}

#[tauri::command]
pub fn upsert_workspace_tool_status(
    app: tauri::AppHandle,
    payload: WorkspaceToolStatusPayload,
) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    let status_json = serde_json::to_string(&payload.status)
        .map_err(|err| format!("Serialize workspace tool status failed: {err}"))?;

    conn.execute(
        r#"
        INSERT INTO workspace_tool_statuses
          (host_key, tool_id, host_id, host_name, host_address, username, port,
           tool_name, status_json, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(host_key, tool_id) DO UPDATE SET
          host_id = excluded.host_id,
          host_name = excluded.host_name,
          host_address = excluded.host_address,
          username = excluded.username,
          port = excluded.port,
          tool_name = excluded.tool_name,
          status_json = excluded.status_json,
          updated_at = excluded.updated_at
        "#,
        params![
            payload.host_key,
            payload.tool_id,
            payload.host_id,
            payload.host_name,
            payload.host_address,
            payload.username,
            payload.port,
            payload.tool_name,
            status_json,
            payload.updated_at,
        ],
    )
    .map_err(|err| format!("Save workspace tool status failed: {err}"))?;

    Ok(())
}

#[tauri::command]
pub fn clear_workspace_tool_statuses(app: tauri::AppHandle) -> Result<(), String> {
    let conn = open_workspace_inventory_db(&app)?;
    conn.execute("DELETE FROM workspace_tool_statuses", [])
        .map_err(|err| format!("Clear workspace tool statuses failed: {err}"))?;
    Ok(())
}
