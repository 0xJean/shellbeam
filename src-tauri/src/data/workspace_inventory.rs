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
    pub vault_id: String,
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
    pub vault_id: String,
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
    vault_ids: Option<Vec<String>>,
) -> Result<Vec<WorkspaceInventorySnapshot>, String> {
    let vault_ids = vault_ids.unwrap_or_default();
    if vault_ids.is_empty() {
        return Ok(Vec::new());
    }
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
        let scope_key: String = row.get(0).map_err(|error| error.to_string())?;
        let scope_host: String = row.get(1).map_err(|error| error.to_string())?;
        if !super::server_monitor::observation_matches_vaults(&scope_key, &scope_host, &vault_ids) {
            continue;
        }
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
    if super::server_monitor::scoped_host_vault(&payload.host_key, &payload.host_id).is_none() {
        return Err("OBSERVATION_VAULT_SCOPE_REQUIRED".into());
    }
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
    vault_ids: Option<Vec<String>>,
) -> Result<Vec<WorkspaceInventoryHostStateSnapshot>, String> {
    let vault_ids = vault_ids.unwrap_or_default();
    if vault_ids.is_empty() {
        return Ok(Vec::new());
    }
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
        let scope_key: String = row.get(0).map_err(|error| error.to_string())?;
        let scope_host: String = row.get(1).map_err(|error| error.to_string())?;
        if !super::server_monitor::observation_matches_vaults(&scope_key, &scope_host, &vault_ids) {
            continue;
        }
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
    if super::server_monitor::scoped_host_vault(&payload.host_key, &payload.host_id).is_none() {
        return Err("OBSERVATION_VAULT_SCOPE_REQUIRED".into());
    }
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
    vault_id: String,
    host_id: String,
) -> Result<Vec<WorkspaceToolStatusSnapshot>, String> {
    let host = tool_status_scope(&app, &vault_id, &host_id)?;
    let conn = open_workspace_inventory_db(&app)?;
    let mut rows = list_scoped_tool_statuses(&conn, &vault_id, &host_id)?;
    rows.retain(|row| {
        row.host_address == host.address && row.port == host.port && row.username == host.username
    });
    Ok(rows)
}

fn initialize_scoped_tool_statuses(conn: &Connection) -> Result<(), String> {
    // Legacy host-key-only rows have ambiguous ownership and are never claimed
    // by a newly opened vault. Fresh observations populate this scoped table.
    conn.execute_batch("CREATE TABLE IF NOT EXISTS workspace_tool_statuses_scoped(vault_id TEXT NOT NULL,host_id TEXT NOT NULL,tool_id TEXT NOT NULL,host_key TEXT NOT NULL,host_name TEXT NOT NULL,host_address TEXT NOT NULL,username TEXT NOT NULL,port INTEGER NOT NULL,tool_name TEXT NOT NULL,status_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(vault_id,host_id,tool_id));")
        .map_err(|_| "tool_status_schema_failed".to_string())
}

fn valid_tool_scope(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 240
        || value.chars().any(char::is_control)
    {
        return Err("tool_status_scope_invalid".into());
    }
    Ok(())
}

fn tool_status_scope(
    app: &tauri::AppHandle,
    vault: &str,
    host: &str,
) -> Result<super::hosts::HostProfile, String> {
    valid_tool_scope(vault)?;
    valid_tool_scope(host)?;
    super::hosts::load_hosts(app, Some(vault))?
        .into_iter()
        .find(|row| row.id == host)
        .ok_or_else(|| "tool_status_host_not_found".into())
}

fn list_scoped_tool_statuses(
    conn: &Connection,
    vault: &str,
    host: &str,
) -> Result<Vec<WorkspaceToolStatusSnapshot>, String> {
    valid_tool_scope(vault)?;
    valid_tool_scope(host)?;
    initialize_scoped_tool_statuses(conn)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT host_key, host_id, host_name, host_address, username, port,
                   tool_id, tool_name, status_json, updated_at
            FROM workspace_tool_statuses_scoped WHERE vault_id=?1 AND host_id=?2
            ORDER BY updated_at DESC
            LIMIT 256
            "#,
        )
        .map_err(|err| format!("Prepare workspace tool statuses query failed: {err}"))?;
    let mut rows = stmt
        .query(params![vault, host])
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
            vault_id: vault.to_string(),
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
    mut payload: WorkspaceToolStatusPayload,
) -> Result<(), String> {
    let host = tool_status_scope(&app, &payload.vault_id, &payload.host_id)?;
    // Connection metadata is resolved from the exact saved host, never accepted
    // from another vault's in-flight renderer state.
    payload.host_name = host.name;
    payload.host_address = host.address;
    payload.username = host.username;
    payload.port = host.port;
    let conn = open_workspace_inventory_db(&app)?;
    write_scoped_tool_status(&conn, &payload)
}

fn normalized_tool_status(status: &Value) -> Result<Value, String> {
    let object = status.as_object().ok_or("tool_status_invalid")?;
    let installed = object.get("installed").ok_or("tool_status_invalid")?;
    if !installed.is_boolean() && !installed.is_null() {
        return Err("tool_status_invalid".into());
    }
    let mut safe = serde_json::Map::new();
    safe.insert("installed".into(), installed.clone());
    for (key, limit) in [
        ("path", 1024),
        ("version", 512),
        ("serviceActive", 64),
        ("serviceEnabled", 64),
        ("checkedAt", 64),
    ] {
        if let Some(value) = object.get(key) {
            let text = value.as_str().ok_or("tool_status_invalid")?;
            safe.insert(
                key.into(),
                Value::String(
                    text.chars()
                        .filter(|character| !character.is_control())
                        .take(limit)
                        .collect(),
                ),
            );
        }
    }
    if let Some(value) = object.get("checkedAtMs") {
        if value.as_i64().map_or(true, |at| at < 0) {
            return Err("tool_status_invalid".into());
        }
        safe.insert("checkedAtMs".into(), value.clone());
    }
    Ok(Value::Object(safe))
}

fn write_scoped_tool_status(
    conn: &Connection,
    payload: &WorkspaceToolStatusPayload,
) -> Result<(), String> {
    valid_tool_scope(&payload.vault_id)?;
    valid_tool_scope(&payload.host_id)?;
    valid_tool_scope(&payload.tool_id)?;
    initialize_scoped_tool_statuses(conn)?;
    let status_json = serde_json::to_string(&normalized_tool_status(&payload.status)?)
        .map_err(|err| format!("Serialize workspace tool status failed: {err}"))?;

    conn.execute(
        r#"
        INSERT INTO workspace_tool_statuses_scoped
          (vault_id, host_key, tool_id, host_id, host_name, host_address, username, port,
           tool_name, status_json, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(vault_id,host_id,tool_id) DO UPDATE SET
          host_name = excluded.host_name,
          host_address = excluded.host_address,
          username = excluded.username,
          port = excluded.port,
          tool_name = excluded.tool_name,
          status_json = excluded.status_json,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= workspace_tool_statuses_scoped.updated_at
        "#,
        params![
            payload.vault_id,
            super::server_monitor::scoped_host_key(&payload.vault_id, &payload.host_id),
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
pub fn clear_workspace_tool_statuses(
    app: tauri::AppHandle,
    vault_id: String,
    host_id: String,
) -> Result<(), String> {
    tool_status_scope(&app, &vault_id, &host_id)?;
    let conn = open_workspace_inventory_db(&app)?;
    clear_scoped_tool_statuses(&conn, &vault_id, &host_id)
}

fn clear_scoped_tool_statuses(conn: &Connection, vault: &str, host: &str) -> Result<(), String> {
    valid_tool_scope(vault)?;
    valid_tool_scope(host)?;
    initialize_scoped_tool_statuses(conn)?;
    conn.execute(
        "DELETE FROM workspace_tool_statuses_scoped WHERE vault_id=?1 AND host_id=?2",
        params![vault, host],
    )
    .map_err(|err| format!("Clear workspace tool statuses failed: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tool_status_scope_tests {
    use super::*;
    use serde_json::json;

    fn payload(vault: &str, host: &str, installed: bool, at: i64) -> WorkspaceToolStatusPayload {
        WorkspaceToolStatusPayload {
            vault_id: vault.into(),
            host_id: host.into(),
            host_name: "edge".into(),
            host_address: "192.0.2.1".into(),
            username: "ops".into(),
            port: 22,
            tool_id: "nginx".into(),
            tool_name: "Nginx".into(),
            status: json!({"installed":installed,"checkedAtMs":at,"stdout":"private-output","token":"secret"}),
            updated_at: at,
        }
    }

    #[test]
    fn same_host_id_and_tool_are_isolated_by_vault_including_clear() {
        let conn = Connection::open_in_memory().unwrap();
        write_scoped_tool_status(&conn, &payload("a", "same-host", true, 100)).unwrap();
        write_scoped_tool_status(&conn, &payload("b", "same-host", false, 200)).unwrap();
        write_scoped_tool_status(&conn, &payload("a", "other-host", false, 200)).unwrap();
        let a = list_scoped_tool_statuses(&conn, "a", "same-host").unwrap();
        let b = list_scoped_tool_statuses(&conn, "b", "same-host").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].status["installed"], true);
        assert_eq!(b[0].status["installed"], false);
        assert_eq!(a[0].vault_id, "a");
        assert_eq!(a[0].host_key, "vault:[\"a\",\"same-host\"]");
        clear_scoped_tool_statuses(&conn, "a", "same-host").unwrap();
        assert!(list_scoped_tool_statuses(&conn, "a", "same-host")
            .unwrap()
            .is_empty());
        assert_eq!(
            list_scoped_tool_statuses(&conn, "b", "same-host")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_scoped_tool_statuses(&conn, "a", "other-host")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn stale_tool_observations_cannot_overwrite_newer_scoped_results() {
        let conn = Connection::open_in_memory().unwrap();
        write_scoped_tool_status(&conn, &payload("a", "h", true, 200)).unwrap();
        write_scoped_tool_status(&conn, &payload("a", "h", false, 100)).unwrap();
        let rows = list_scoped_tool_statuses(&conn, "a", "h").unwrap();
        assert_eq!(rows[0].status["installed"], true);
        assert_eq!(rows[0].updated_at, 200);
        assert!(rows[0].status.get("stdout").is_none());
        assert!(rows[0].status.get("token").is_none());
    }

    #[test]
    fn legacy_unscoped_rows_are_not_silently_adopted_and_empty_scopes_are_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE workspace_tool_statuses(host_key TEXT,tool_id TEXT); INSERT INTO workspace_tool_statuses VALUES('h','nginx');").unwrap();
        assert!(list_scoped_tool_statuses(&conn, "new-vault", "h")
            .unwrap()
            .is_empty());
        assert!(list_scoped_tool_statuses(&conn, "", "h").is_err());
        assert!(clear_scoped_tool_statuses(&conn, "a", "").is_err());
        assert!(write_scoped_tool_status(&conn, &payload("", "h", true, 1)).is_err());
    }
}
