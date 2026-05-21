use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::storage::{data_file_path, now_unix_ms, read_json_or_default};
use crate::vaults_meta;

const SHELLBEAM_DATA_DB: &str = "workspace_inventory.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub auth_type: String,
    pub secret_key_ref: Option<String>,
    pub password_key_ref: Option<String>,
    pub private_key_ref: Option<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_user: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfileDraft {
    name: String,
    address: String,
    port: u16,
    username: String,
    group: Option<String>,
    auth_type: String,
    secret_key_ref: Option<String>,
    password_key_ref: Option<String>,
    private_key_ref: Option<String>,
    tags: Option<Vec<String>>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
}

fn hosts_file_name(vault_id: Option<&str>) -> String {
    let suffix = vaults_meta::vault_storage_suffix(vault_id);
    format!("hosts{suffix}.json")
}

fn normalized_vault_id(vault_id: Option<&str>) -> String {
    vault_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(vaults_meta::DEFAULT_VAULT_ID)
        .to_string()
}

fn open_hosts_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = data_file_path(app, SHELLBEAM_DATA_DB)?;
    let conn = Connection::open(path).map_err(|err| format!("Open hosts db failed: {err}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS workspace_hosts (
          vault_id TEXT NOT NULL,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          address TEXT NOT NULL,
          port INTEGER NOT NULL,
          username TEXT NOT NULL,
          host_group TEXT NOT NULL,
          auth_type TEXT NOT NULL,
          secret_key_ref TEXT,
          password_key_ref TEXT,
          private_key_ref TEXT,
          tags_json TEXT NOT NULL,
          jump_host TEXT,
          jump_port INTEGER,
          jump_user TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (vault_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_hosts_vault_updated_at
          ON workspace_hosts(vault_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS workspace_host_profile_migrations (
          vault_id TEXT PRIMARY KEY NOT NULL,
          migrated_at INTEGER NOT NULL
        );
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
        "#,
    )
    .map_err(|err| format!("Initialize hosts db failed: {err}"))?;
    Ok(conn)
}

fn read_legacy_hosts(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Vec<HostProfile>, String> {
    let file = hosts_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    read_json_or_default::<Vec<HostProfile>>(&path)
}

fn has_hosts_migration_marker(conn: &Connection, vault_id: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workspace_host_profile_migrations WHERE vault_id = ?1",
            params![vault_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("Read hosts migration marker failed: {err}"))?;
    Ok(count > 0)
}

fn insert_host_row(conn: &Connection, vault_id: &str, host: &HostProfile) -> Result<(), String> {
    let tags_json = serde_json::to_string(&host.tags)
        .map_err(|err| format!("Serialize host tags failed: {err}"))?;
    conn.execute(
        r#"
        INSERT INTO workspace_hosts
          (vault_id, id, name, address, port, username, host_group, auth_type,
           secret_key_ref, password_key_ref, private_key_ref, tags_json,
           jump_host, jump_port, jump_user, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(vault_id, id) DO UPDATE SET
          name = excluded.name,
          address = excluded.address,
          port = excluded.port,
          username = excluded.username,
          host_group = excluded.host_group,
          auth_type = excluded.auth_type,
          secret_key_ref = excluded.secret_key_ref,
          password_key_ref = excluded.password_key_ref,
          private_key_ref = excluded.private_key_ref,
          tags_json = excluded.tags_json,
          jump_host = excluded.jump_host,
          jump_port = excluded.jump_port,
          jump_user = excluded.jump_user,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
        "#,
        params![
            vault_id,
            host.id,
            host.name,
            host.address,
            host.port,
            host.username,
            host.group,
            host.auth_type,
            host.secret_key_ref,
            host.password_key_ref,
            host.private_key_ref,
            tags_json,
            host.jump_host,
            host.jump_port,
            host.jump_user,
            host.created_at,
            host.updated_at,
        ],
    )
    .map_err(|err| format!("Save host profile failed: {err}"))?;
    Ok(())
}

fn host_inventory_key(host: &HostProfile) -> String {
    if !host.id.trim().is_empty() {
        host.id.clone()
    } else {
        format!("{}@{}:{}", host.username, host.address, host.port)
    }
}

fn delete_host_inventory_data(app: &tauri::AppHandle, host: &HostProfile) -> Result<(), String> {
    let conn = open_hosts_db(app)?;
    let host_key = host_inventory_key(host);
    conn.execute(
        "DELETE FROM workspace_inventory_snapshots WHERE host_key = ?1",
        params![host_key],
    )
    .map_err(|err| format!("Delete host inventory snapshot failed: {err}"))?;
    conn.execute(
        "DELETE FROM workspace_inventory_host_states WHERE host_key = ?1",
        params![host_inventory_key(host)],
    )
    .map_err(|err| format!("Delete host inventory state failed: {err}"))?;
    conn.execute(
        "DELETE FROM workspace_tool_statuses WHERE host_key = ?1",
        params![host_inventory_key(host)],
    )
    .map_err(|err| format!("Delete host tool statuses failed: {err}"))?;
    Ok(())
}

fn mark_hosts_migrated(conn: &Connection, vault_id: &str) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO workspace_host_profile_migrations (vault_id, migrated_at)
        VALUES (?1, ?2)
        ON CONFLICT(vault_id) DO UPDATE SET migrated_at = excluded.migrated_at
        "#,
        params![vault_id, now_unix_ms()],
    )
    .map_err(|err| format!("Save hosts migration marker failed: {err}"))?;
    Ok(())
}

fn migrate_legacy_hosts(
    app: &tauri::AppHandle,
    conn: &mut Connection,
    vault_id: &str,
    raw_vault_id: Option<&str>,
) -> Result<(), String> {
    if has_hosts_migration_marker(conn, vault_id)? {
        return Ok(());
    }

    let hosts = read_legacy_hosts(app, raw_vault_id)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Start hosts migration failed: {err}"))?;
    for host in &hosts {
        insert_host_row(&tx, vault_id, host)?;
    }
    mark_hosts_migrated(&tx, vault_id)?;
    tx.commit()
        .map_err(|err| format!("Commit hosts migration failed: {err}"))?;
    Ok(())
}

fn host_from_row(row: &rusqlite::Row<'_>) -> Result<HostProfile, rusqlite::Error> {
    let port_raw: i64 = row.get(3)?;
    let jump_port_raw: Option<i64> = row.get(12)?;
    let tags_json: String = row.get(10)?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();

    Ok(HostProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        address: row.get(2)?,
        port: u16::try_from(port_raw).unwrap_or(22),
        username: row.get(4)?,
        group: row.get(5)?,
        auth_type: row.get(6)?,
        secret_key_ref: row.get(7)?,
        password_key_ref: row.get(8)?,
        private_key_ref: row.get(9)?,
        tags,
        jump_host: row.get(11)?,
        jump_port: jump_port_raw.and_then(|value| u16::try_from(value).ok()),
        jump_user: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

pub fn load_hosts(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Vec<HostProfile>, String> {
    let normalized_vault_id = normalized_vault_id(vault_id);
    let mut conn = open_hosts_db(app)?;
    migrate_legacy_hosts(app, &mut conn, &normalized_vault_id, vault_id)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, name, address, port, username, host_group, auth_type,
                   secret_key_ref, password_key_ref, private_key_ref, tags_json,
                   jump_host, jump_port, jump_user, created_at, updated_at
            FROM workspace_hosts
            WHERE vault_id = ?1
            ORDER BY created_at ASC, updated_at ASC
            "#,
        )
        .map_err(|err| format!("Prepare hosts query failed: {err}"))?;
    let rows = stmt
        .query_map(params![normalized_vault_id], host_from_row)
        .map_err(|err| format!("Query hosts failed: {err}"))?;
    let mut hosts = Vec::new();
    for row in rows {
        hosts.push(row.map_err(|err| format!("Read host profile failed: {err}"))?);
    }
    Ok(hosts)
}

pub fn save_hosts(
    app: &tauri::AppHandle,
    hosts: &[HostProfile],
    vault_id: Option<&str>,
) -> Result<(), String> {
    let normalized_vault_id = normalized_vault_id(vault_id);
    let mut conn = open_hosts_db(app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Start hosts save failed: {err}"))?;
    tx.execute(
        "DELETE FROM workspace_hosts WHERE vault_id = ?1",
        params![normalized_vault_id],
    )
    .map_err(|err| format!("Clear host profiles failed: {err}"))?;
    for host in hosts {
        insert_host_row(&tx, &normalized_vault_id, host)?;
    }
    mark_hosts_migrated(&tx, &normalized_vault_id)?;
    tx.commit()
        .map_err(|err| format!("Commit hosts save failed: {err}"))
}

#[tauri::command]
pub fn list_hosts(
    app: tauri::AppHandle,
    vault_id: Option<String>,
) -> Result<Vec<HostProfile>, String> {
    load_hosts(&app, vault_id.as_deref())
}

#[tauri::command]
pub fn create_host(
    app: tauri::AppHandle,
    payload: HostProfileDraft,
    vault_id: Option<String>,
) -> Result<HostProfile, String> {
    let vid = vault_id.as_deref();
    let now = now_unix_ms();
    let mut hosts = load_hosts(&app, vid)?;
    let host = HostProfile {
        id: Uuid::new_v4().to_string(),
        name: payload.name.trim().to_string(),
        address: payload.address.trim().to_string(),
        port: payload.port,
        username: payload.username.trim().to_string(),
        group: payload.group.unwrap_or_else(|| "Custom".to_string()),
        auth_type: payload.auth_type,
        secret_key_ref: payload
            .secret_key_ref
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        password_key_ref: payload
            .password_key_ref
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        private_key_ref: payload
            .private_key_ref
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        tags: payload.tags.unwrap_or_default(),
        jump_host: payload
            .jump_host
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        jump_port: payload.jump_port,
        jump_user: payload
            .jump_user
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        created_at: now,
        updated_at: now,
    };
    hosts.push(host.clone());
    save_hosts(&app, &hosts, vid)?;
    Ok(host)
}

#[tauri::command]
pub fn update_host(
    app: tauri::AppHandle,
    payload: HostProfile,
    vault_id: Option<String>,
) -> Result<HostProfile, String> {
    let vid = vault_id.as_deref();
    let mut hosts = load_hosts(&app, vid)?;
    let idx = hosts
        .iter()
        .position(|host| host.id == payload.id)
        .ok_or_else(|| "Host not found".to_string())?;
    let mut updated = payload;
    updated.name = updated.name.trim().to_string();
    updated.address = updated.address.trim().to_string();
    updated.username = updated.username.trim().to_string();
    updated.secret_key_ref = updated
        .secret_key_ref
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    updated.password_key_ref = updated
        .password_key_ref
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    updated.private_key_ref = updated
        .private_key_ref
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    updated.updated_at = now_unix_ms();
    hosts[idx] = updated.clone();
    save_hosts(&app, &hosts, vid)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_host(
    app: tauri::AppHandle,
    id: String,
    vault_id: Option<String>,
) -> Result<(), String> {
    let vid = vault_id.as_deref();
    let mut hosts = load_hosts(&app, vid)?;
    let before_len = hosts.len();
    let deleted_host = hosts.iter().find(|host| host.id == id).cloned();
    hosts.retain(|host| host.id != id);
    if hosts.len() == before_len {
        return Err("Host not found".to_string());
    }
    save_hosts(&app, &hosts, vid)?;
    if let Some(host) = deleted_host {
        delete_host_inventory_data(&app, &host)?;
    }
    Ok(())
}
