//! Durable cache for canonical ProbeProvider observations.
//!
//! Probe providers are process agnostic: the scheduler may be recreated after
//! a window reload or an application restart.  This table stores the
//! provider envelope (including ProxyJump transport and alert metadata) so a
//! caller can render the last known state and make the expiry explicit while
//! a fresh probe is attempted.

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::{data_file_path, now_unix_ms};

const PROBE_DB: &str = "workspace_inventory.sqlite3";
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSnapshotRecord {
    pub vault_id: String,
    pub provider_kind: String,
    pub provider_id: String,
    pub host_id: String,
    pub snapshot: Value,
    pub sampled_at: i64,
    pub received_at: i64,
    pub expires_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSnapshotPayload {
    pub vault_id: String,
    pub provider_kind: String,
    pub provider_id: String,
    pub host_id: String,
    pub snapshot: Value,
    pub sampled_at: i64,
    pub received_at: i64,
    pub expires_at: i64,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSnapshotQuery {
    pub vault_id: Option<String>,
    pub provider_kind: Option<String>,
    pub provider_id: Option<String>,
    pub host_id: Option<String>,
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(data_file_path(app, PROBE_DB)?)
        .map_err(|err| format!("Open probe persistence db failed: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| format!("Configure probe persistence db failed: {err}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS probe_snapshots (
          vault_id TEXT NOT NULL,
          provider_kind TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          sampled_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (vault_id, provider_kind, provider_id, host_id)
        );
        CREATE INDEX IF NOT EXISTS idx_probe_snapshots_host_updated_at
          ON probe_snapshots(vault_id, host_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_probe_snapshots_provider_updated_at
          ON probe_snapshots(vault_id, provider_kind, provider_id, updated_at DESC);
        "#,
    )
    .map_err(|err| format!("Initialize probe persistence db failed: {err}"))?;
    Ok(conn)
}

fn id(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Probe {field} is required"));
    }
    if value.len() > 240 || value.chars().any(char::is_control) {
        return Err(format!("Probe {field} is invalid"));
    }
    Ok(value.to_owned())
}

fn json(value: &Value) -> Result<String, String> {
    let raw = serde_json::to_string(value)
        .map_err(|err| format!("Serialize probe snapshot failed: {err}"))?;
    if raw.len() > MAX_JSON_BYTES {
        return Err("Probe snapshot is too large".into());
    }
    Ok(raw)
}

fn payload_values(
    payload: &ProbeSnapshotPayload,
) -> Result<(String, String, String, String, String, i64), String> {
    let vault = id(&payload.vault_id, "vault id")?;
    let kind = id(&payload.provider_kind, "provider kind")?;
    let provider = id(&payload.provider_id, "provider id")?;
    let host = id(&payload.host_id, "host id")?;
    let raw = json(&payload.snapshot)?;
    let updated = payload.updated_at.unwrap_or_else(now_unix_ms);
    if payload.sampled_at < 0 || payload.received_at < 0 || payload.expires_at < 0 || updated < 0 {
        return Err("Probe snapshot timestamp is invalid".into());
    }
    Ok((vault, kind, provider, host, raw, updated))
}

fn insert_snapshot(tx: &Transaction<'_>, payload: &ProbeSnapshotPayload) -> Result<(), String> {
    let (vault, kind, provider, host, raw, updated) = payload_values(payload)?;
    tx.execute(
        r#"
        INSERT INTO probe_snapshots
          (vault_id, provider_kind, provider_id, host_id, snapshot_json, sampled_at, received_at, expires_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(vault_id, provider_kind, provider_id, host_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json,
          sampled_at = excluded.sampled_at,
          received_at = excluded.received_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= probe_snapshots.updated_at
        "#,
        params![
            vault,
            kind,
            provider,
            host,
            raw,
            payload.sampled_at,
            payload.received_at,
            payload.expires_at,
            updated,
        ],
    )
    .map_err(|err| format!("Save probe snapshot failed: {err}"))?;
    Ok(())
}

fn read_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProbeSnapshotRecord> {
    let raw: String = row.get(4)?;
    let snapshot = serde_json::from_str::<Value>(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(err))
    })?;
    Ok(ProbeSnapshotRecord {
        vault_id: row.get(0)?,
        provider_kind: row.get(1)?,
        provider_id: row.get(2)?,
        host_id: row.get(3)?,
        snapshot,
        sampled_at: row.get(5)?,
        received_at: row.get(6)?,
        expires_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn normalize_optional(value: Option<String>, field: &str) -> Result<Option<String>, String> {
    value.as_deref().map(|value| id(value, field)).transpose()
}

#[tauri::command]
pub fn list_probe_snapshots(
    app: tauri::AppHandle,
    query: Option<ProbeSnapshotQuery>,
) -> Result<Vec<ProbeSnapshotRecord>, String> {
    let query = query.ok_or_else(|| "Probe vault id is required".to_string())?;
    let vault_id = normalize_optional(query.vault_id, "vault id")?
        .ok_or_else(|| "Probe vault id is required".to_string())?;
    let provider_kind = normalize_optional(query.provider_kind, "provider kind")?;
    let provider_id = normalize_optional(query.provider_id, "provider id")?;
    let host_id = normalize_optional(query.host_id, "host id")?;
    let conn = open(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT vault_id, provider_kind, provider_id, host_id, snapshot_json, sampled_at, received_at, expires_at, updated_at
             FROM probe_snapshots
             WHERE (?1 IS NULL OR vault_id = ?1)
               AND (?2 IS NULL OR provider_kind = ?2)
               AND (?3 IS NULL OR provider_id = ?3)
               AND (?4 IS NULL OR host_id = ?4)
             ORDER BY updated_at DESC",
        )
        .map_err(|err| format!("Prepare probe snapshot query failed: {err}"))?;
    let rows = stmt
        .query_map(
            params![vault_id, provider_kind, provider_id, host_id],
            read_snapshot,
        )
        .map_err(|err| format!("Query probe snapshots failed: {err}"))?;
    rows.map(|row| row.map_err(|err| format!("Read probe snapshot failed: {err}")))
        .collect()
}

#[tauri::command]
pub fn upsert_probe_snapshot(
    app: tauri::AppHandle,
    payload: ProbeSnapshotPayload,
) -> Result<(), String> {
    let mut conn = open(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin probe snapshot transaction failed: {err}"))?;
    insert_snapshot(&tx, &payload)?;
    tx.commit()
        .map_err(|err| format!("Commit probe snapshot failed: {err}"))
}

#[tauri::command]
pub fn delete_probe_snapshots(
    app: tauri::AppHandle,
    query: Option<ProbeSnapshotQuery>,
) -> Result<(), String> {
    let query = query.ok_or_else(|| "Probe vault id is required".to_string())?;
    let vault_id = normalize_optional(query.vault_id, "vault id")?
        .ok_or_else(|| "Probe vault id is required".to_string())?;
    let provider_kind = normalize_optional(query.provider_kind, "provider kind")?;
    let provider_id = normalize_optional(query.provider_id, "provider id")?;
    let host_id = normalize_optional(query.host_id, "host id")?;
    let conn = open(&app)?;
    conn.execute(
        "DELETE FROM probe_snapshots
         WHERE (?1 IS NULL OR vault_id = ?1)
           AND (?2 IS NULL OR provider_kind = ?2)
           AND (?3 IS NULL OR provider_id = ?3)
           AND (?4 IS NULL OR host_id = ?4)",
        params![vault_id, provider_kind, provider_id, host_id],
    )
    .map_err(|err| format!("Delete probe snapshots failed: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_empty_provider_identity() {
        let payload = ProbeSnapshotPayload {
            vault_id: "vault".into(),
            provider_kind: " ".into(),
            provider_id: "id".into(),
            host_id: "host".into(),
            snapshot: json!({}),
            sampled_at: 1,
            received_at: 1,
            expires_at: 2,
            updated_at: None,
        };
        assert!(payload_values(&payload).is_err());
    }

    #[test]
    fn bounds_snapshot_size() {
        let payload = ProbeSnapshotPayload {
            vault_id: "vault".into(),
            provider_kind: "ssh-agentless".into(),
            provider_id: "ssh-agentless".into(),
            host_id: "host".into(),
            snapshot: json!("x".repeat(MAX_JSON_BYTES + 1)),
            sampled_at: 1,
            received_at: 1,
            expires_at: 2,
            updated_at: None,
        };
        assert!(payload_values(&payload).is_err());
    }
}
