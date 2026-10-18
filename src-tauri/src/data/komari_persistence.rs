//! Durable, local storage for the read-only Komari observations.
//!
//! Komari's API is intentionally kept out of this module.  The web layer
//! fetches and validates the wire response, then stores canonical ProbeSnapshot
//! JSON here.  Keeping the cache in the app database means a host view can be
//! rendered while Komari is unavailable and makes the cache survive restarts.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::{data_file_path, now_unix_ms};

const KOMARI_DB: &str = "workspace_inventory.sqlite3";
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariSnapshot {
    pub integration_id: String,
    pub node_id: String,
    pub host_id: String,
    pub snapshot: Value,
    pub sampled_at: i64,
    pub received_at: i64,
    pub expires_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariSnapshotPayload {
    pub integration_id: String,
    pub node_id: String,
    pub host_id: String,
    pub snapshot: Value,
    pub sampled_at: i64,
    pub received_at: i64,
    pub expires_at: i64,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariMapping {
    pub integration_id: String,
    pub host_id: String,
    pub node_id: String,
    pub source: String,
    pub confidence: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariMappingPayload {
    pub integration_id: String,
    pub host_id: String,
    pub node_id: String,
    pub source: String,
    pub confidence: String,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariMappingSetPayload {
    pub integration_id: String,
    pub mappings: Vec<KomariMappingPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariPersistencePayload {
    pub integration_id: String,
    pub snapshots: Vec<KomariSnapshotPayload>,
    pub mappings: Vec<KomariMappingPayload>,
    pub last_synced_at: Option<i64>,
    pub ttl_ms: Option<i64>,
    pub alert_summary: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariSyncState {
    pub integration_id: String,
    pub last_synced_at: i64,
    pub ttl_ms: i64,
    pub alert_summary: Option<Value>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariSyncStatePayload {
    pub integration_id: String,
    pub last_synced_at: i64,
    pub ttl_ms: i64,
    pub alert_summary: Option<Value>,
    pub updated_at: Option<i64>,
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(data_file_path(app, KOMARI_DB)?)
        .map_err(|err| format!("Open Komari persistence db failed: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| format!("Configure Komari persistence db failed: {err}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS komari_snapshots (
          integration_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          sampled_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (integration_id, node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_komari_snapshots_host_updated_at
          ON komari_snapshots(host_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_komari_snapshots_integration_updated_at
          ON komari_snapshots(integration_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS komari_mappings (
          integration_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          source TEXT NOT NULL,
          confidence TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (integration_id, host_id)
        );
        CREATE INDEX IF NOT EXISTS idx_komari_mappings_integration_node
          ON komari_mappings(integration_id, node_id);
        CREATE INDEX IF NOT EXISTS idx_komari_mappings_host
          ON komari_mappings(host_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS komari_sync_state (
          integration_id TEXT PRIMARY KEY NOT NULL,
          last_synced_at INTEGER NOT NULL,
          ttl_ms INTEGER NOT NULL,
          alert_summary_json TEXT,
          updated_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|err| format!("Initialize Komari persistence db failed: {err}"))?;
    Ok(conn)
}

fn id(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Komari {field} is required"));
    }
    if value.len() > 240 || value.chars().any(char::is_control) {
        return Err(format!("Komari {field} is invalid"));
    }
    Ok(value.to_string())
}

fn normalize_integration_id(value: &str) -> Result<String, String> {
    id(value, "integration id")
}

fn snapshot_json(snapshot: &Value) -> Result<String, String> {
    let json = serde_json::to_string(snapshot)
        .map_err(|err| format!("Serialize Komari snapshot failed: {err}"))?;
    if json.len() > MAX_JSON_BYTES {
        return Err("Komari snapshot is too large".into());
    }
    Ok(json)
}

fn read_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<KomariSnapshot> {
    let raw: String = row.get(3)?;
    let snapshot = serde_json::from_str::<Value>(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(err))
    })?;
    Ok(KomariSnapshot {
        integration_id: row.get(0)?,
        node_id: row.get(1)?,
        host_id: row.get(2)?,
        snapshot,
        sampled_at: row.get(4)?,
        received_at: row.get(5)?,
        expires_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn read_mapping(row: &rusqlite::Row<'_>) -> rusqlite::Result<KomariMapping> {
    Ok(KomariMapping {
        integration_id: row.get(0)?,
        host_id: row.get(1)?,
        node_id: row.get(2)?,
        source: row.get(3)?,
        confidence: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn read_sync_state(row: &rusqlite::Row<'_>) -> rusqlite::Result<KomariSyncState> {
    let raw: Option<String> = row.get(3)?;
    let alert_summary = raw
        .map(|value| {
            serde_json::from_str::<Value>(&value).map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(err),
                )
            })
        })
        .transpose()?;
    Ok(KomariSyncState {
        integration_id: row.get(0)?,
        last_synced_at: row.get(1)?,
        ttl_ms: row.get(2)?,
        alert_summary,
        updated_at: row.get(4)?,
    })
}

fn sync_state_values(payload: &KomariSyncStatePayload) -> Result<(String, String, i64), String> {
    let integration_id = normalize_integration_id(&payload.integration_id)?;
    if payload.last_synced_at < 0 {
        return Err("Komari last synced timestamp is invalid".into());
    }
    if payload.ttl_ms <= 0 {
        return Err("Komari sync TTL must be positive".into());
    }
    let alert_summary = payload
        .alert_summary
        .as_ref()
        .map(snapshot_json)
        .transpose()?
        .unwrap_or_default();
    Ok((
        integration_id,
        alert_summary,
        payload.updated_at.unwrap_or_else(now_unix_ms),
    ))
}

fn insert_sync_state(tx: &Transaction<'_>, payload: &KomariSyncStatePayload) -> Result<(), String> {
    let (integration_id, alert_summary, updated_at) = sync_state_values(payload)?;
    tx.execute(
        r#"
        INSERT INTO komari_sync_state
          (integration_id, last_synced_at, ttl_ms, alert_summary_json, updated_at)
        VALUES (?1, ?2, ?3, NULLIF(?4, ''), ?5)
        ON CONFLICT(integration_id) DO UPDATE SET
          last_synced_at = excluded.last_synced_at,
          ttl_ms = excluded.ttl_ms,
          alert_summary_json = excluded.alert_summary_json,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= komari_sync_state.updated_at
        "#,
        params![
            integration_id,
            payload.last_synced_at,
            payload.ttl_ms,
            alert_summary,
            updated_at,
        ],
    )
    .map_err(|err| format!("Save Komari sync state failed: {err}"))?;
    Ok(())
}

fn validate_mapping(
    payload: &KomariMappingPayload,
) -> Result<(String, String, String, String, String, i64), String> {
    let integration_id = normalize_integration_id(&payload.integration_id)?;
    let host_id = id(&payload.host_id, "host id")?;
    let node_id = id(&payload.node_id, "node id")?;
    let source = id(&payload.source, "mapping source")?;
    let confidence = id(&payload.confidence, "mapping confidence")?;
    Ok((
        integration_id,
        host_id,
        node_id,
        source,
        confidence,
        payload.updated_at.unwrap_or_else(now_unix_ms),
    ))
}

fn insert_mapping(tx: &Transaction<'_>, payload: &KomariMappingPayload) -> Result<(), String> {
    let (integration_id, host_id, node_id, source, confidence, updated_at) =
        validate_mapping(payload)?;
    tx.execute(
        r#"
        INSERT INTO komari_mappings
          (integration_id, host_id, node_id, source, confidence, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(integration_id, host_id) DO UPDATE SET
          node_id = excluded.node_id,
          source = excluded.source,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= komari_mappings.updated_at
        "#,
        params![
            integration_id,
            host_id,
            node_id,
            source,
            confidence,
            updated_at
        ],
    )
    .map_err(|err| format!("Save Komari mapping failed: {err}"))?;
    Ok(())
}

fn insert_snapshot(tx: &Transaction<'_>, payload: &KomariSnapshotPayload) -> Result<(), String> {
    let integration_id = normalize_integration_id(&payload.integration_id)?;
    let node_id = id(&payload.node_id, "node id")?;
    let host_id = id(&payload.host_id, "host id")?;
    let json = snapshot_json(&payload.snapshot)?;
    let updated_at = payload.updated_at.unwrap_or(payload.received_at);
    tx.execute(
        r#"
        INSERT INTO komari_snapshots
          (integration_id, node_id, host_id, snapshot_json, sampled_at, received_at, expires_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(integration_id, node_id) DO UPDATE SET
          host_id = excluded.host_id,
          snapshot_json = excluded.snapshot_json,
          sampled_at = excluded.sampled_at,
          received_at = excluded.received_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= komari_snapshots.updated_at AND excluded.sampled_at >= komari_snapshots.sampled_at
        "#,
        params![
            integration_id,
            node_id,
            host_id,
            json,
            payload.sampled_at,
            payload.received_at,
            payload.expires_at,
            updated_at,
        ],
    )
    .map_err(|err| format!("Save Komari snapshot failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_komari_snapshots(
    app: tauri::AppHandle,
    integration_id: Option<String>,
) -> Result<Vec<KomariSnapshot>, String> {
    let integration_id = integration_id
        .as_deref()
        .map(normalize_integration_id)
        .transpose()?;
    let conn = open(&app)?;
    let mut snapshots = Vec::new();
    if let Some(integration_id) = integration_id {
        let mut stmt = conn
            .prepare(
                "SELECT integration_id, node_id, host_id, snapshot_json, sampled_at, received_at, expires_at, updated_at
                 FROM komari_snapshots WHERE integration_id = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|err| format!("Prepare Komari snapshot query failed: {err}"))?;
        let rows = stmt
            .query_map(params![integration_id], read_snapshot)
            .map_err(|err| format!("Query Komari snapshots failed: {err}"))?;
        for row in rows {
            snapshots.push(row.map_err(|err| format!("Read Komari snapshot failed: {err}"))?);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT integration_id, node_id, host_id, snapshot_json, sampled_at, received_at, expires_at, updated_at
                 FROM komari_snapshots ORDER BY updated_at DESC",
            )
            .map_err(|err| format!("Prepare Komari snapshot query failed: {err}"))?;
        let rows = stmt
            .query_map([], read_snapshot)
            .map_err(|err| format!("Query Komari snapshots failed: {err}"))?;
        for row in rows {
            snapshots.push(row.map_err(|err| format!("Read Komari snapshot failed: {err}"))?);
        }
    }
    Ok(snapshots)
}

#[tauri::command]
pub fn upsert_komari_snapshot(
    app: tauri::AppHandle,
    payload: KomariSnapshotPayload,
) -> Result<(), String> {
    let mut conn = open(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin Komari snapshot transaction failed: {err}"))?;
    insert_snapshot(&tx, &payload)?;
    tx.commit()
        .map_err(|err| format!("Commit Komari snapshot failed: {err}"))
}

#[tauri::command]
pub fn list_komari_mappings(
    app: tauri::AppHandle,
    integration_id: Option<String>,
) -> Result<Vec<KomariMapping>, String> {
    let integration_id = integration_id
        .as_deref()
        .map(normalize_integration_id)
        .transpose()?;
    let conn = open(&app)?;
    let mut mappings = Vec::new();
    if let Some(integration_id) = integration_id {
        let mut stmt = conn
            .prepare(
                "SELECT integration_id, host_id, node_id, source, confidence, updated_at
                 FROM komari_mappings WHERE integration_id = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|err| format!("Prepare Komari mapping query failed: {err}"))?;
        let rows = stmt
            .query_map(params![integration_id], read_mapping)
            .map_err(|err| format!("Query Komari mappings failed: {err}"))?;
        for row in rows {
            mappings.push(row.map_err(|err| format!("Read Komari mapping failed: {err}"))?);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT integration_id, host_id, node_id, source, confidence, updated_at
                 FROM komari_mappings ORDER BY updated_at DESC",
            )
            .map_err(|err| format!("Prepare Komari mapping query failed: {err}"))?;
        let rows = stmt
            .query_map([], read_mapping)
            .map_err(|err| format!("Query Komari mappings failed: {err}"))?;
        for row in rows {
            mappings.push(row.map_err(|err| format!("Read Komari mapping failed: {err}"))?);
        }
    }
    Ok(mappings)
}

#[tauri::command]
pub fn upsert_komari_mapping(
    app: tauri::AppHandle,
    payload: KomariMappingPayload,
) -> Result<(), String> {
    let mut conn = open(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin Komari mapping transaction failed: {err}"))?;
    insert_mapping(&tx, &payload)?;
    tx.commit()
        .map_err(|err| format!("Commit Komari mapping failed: {err}"))
}

/// Replace the mapping set for one integration in a single transaction. This
/// removes stale mappings after a node is deleted or renamed in Komari.
#[tauri::command]
pub fn replace_komari_mappings(
    app: tauri::AppHandle,
    payload: KomariMappingSetPayload,
) -> Result<(), String> {
    let integration_id = normalize_integration_id(&payload.integration_id)?;
    let mut conn = open(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin Komari mapping replacement failed: {err}"))?;
    tx.execute(
        "DELETE FROM komari_mappings WHERE integration_id = ?1",
        params![integration_id],
    )
    .map_err(|err| format!("Clear Komari mappings failed: {err}"))?;
    for mapping in &payload.mappings {
        if mapping.integration_id.trim() != integration_id {
            return Err("Komari mapping integration does not match the set".into());
        }
        insert_mapping(&tx, mapping)?;
    }
    tx.commit()
        .map_err(|err| format!("Commit Komari mapping replacement failed: {err}"))
}

/// Persist one completed sync atomically. Callers can use this command after
/// collecting all snapshots so a host view never observes half a sync.
#[tauri::command]
pub fn persist_komari_sync(
    app: tauri::AppHandle,
    payload: KomariPersistencePayload,
) -> Result<(), String> {
    let integration_id = normalize_integration_id(&payload.integration_id)?;
    let mut conn = open(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin Komari sync persistence failed: {err}"))?;
    for snapshot in &payload.snapshots {
        if snapshot.integration_id.trim() != integration_id {
            return Err("Komari snapshot integration does not match the sync".into());
        }
        insert_snapshot(&tx, snapshot)?;
    }
    tx.execute(
        "DELETE FROM komari_mappings WHERE integration_id = ?1",
        params![integration_id],
    )
    .map_err(|err| format!("Clear Komari mappings before sync failed: {err}"))?;
    for mapping in &payload.mappings {
        if mapping.integration_id.trim() != integration_id {
            return Err("Komari mapping integration does not match the sync".into());
        }
        insert_mapping(&tx, mapping)?;
    }
    if let Some(last_synced_at) = payload.last_synced_at {
        insert_sync_state(
            &tx,
            &KomariSyncStatePayload {
                integration_id: integration_id.clone(),
                last_synced_at,
                ttl_ms: payload.ttl_ms.unwrap_or(60_000),
                alert_summary: payload.alert_summary.clone(),
                updated_at: Some(last_synced_at),
            },
        )?;
    }
    tx.commit()
        .map_err(|err| format!("Commit Komari sync persistence failed: {err}"))
}

#[tauri::command]
pub fn get_komari_sync_state(
    app: tauri::AppHandle,
    integration_id: String,
) -> Result<Option<KomariSyncState>, String> {
    let integration_id = normalize_integration_id(&integration_id)?;
    let conn = open(&app)?;
    conn.query_row(
        "SELECT integration_id, last_synced_at, ttl_ms, alert_summary_json, updated_at
         FROM komari_sync_state WHERE integration_id = ?1",
        params![integration_id],
        read_sync_state,
    )
    .optional()
    .map_err(|err| format!("Read Komari sync state failed: {err}"))
}

#[tauri::command]
pub fn upsert_komari_sync_state(
    app: tauri::AppHandle,
    payload: KomariSyncStatePayload,
) -> Result<(), String> {
    let mut conn = open(&app)?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("Begin Komari sync state transaction failed: {err}"))?;
    insert_sync_state(&tx, &payload)?;
    tx.commit()
        .map_err(|err| format!("Commit Komari sync state failed: {err}"))
}

#[tauri::command]
pub fn clear_komari_persistence(
    app: tauri::AppHandle,
    integration_id: Option<String>,
) -> Result<(), String> {
    let integration_id = integration_id
        .as_deref()
        .map(normalize_integration_id)
        .transpose()?;
    let conn = open(&app)?;
    if let Some(integration_id) = integration_id {
        conn.execute(
            "DELETE FROM komari_snapshots WHERE integration_id = ?1",
            params![integration_id],
        )
        .map_err(|err| format!("Clear Komari snapshots failed: {err}"))?;
        conn.execute(
            "DELETE FROM komari_mappings WHERE integration_id = ?1",
            params![integration_id],
        )
        .map_err(|err| format!("Clear Komari mappings failed: {err}"))?;
        conn.execute(
            "DELETE FROM komari_sync_state WHERE integration_id = ?1",
            params![integration_id],
        )
        .map_err(|err| format!("Clear Komari sync state failed: {err}"))?;
    } else {
        conn.execute("DELETE FROM komari_snapshots", [])
            .map_err(|err| format!("Clear Komari snapshots failed: {err}"))?;
        conn.execute("DELETE FROM komari_mappings", [])
            .map_err(|err| format!("Clear Komari mappings failed: {err}"))?;
        conn.execute("DELETE FROM komari_sync_state", [])
            .map_err(|err| format!("Clear Komari sync state failed: {err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{id, snapshot_json};
    use serde_json::json;

    #[test]
    fn ids_reject_empty_and_control_characters() {
        assert!(id("", "host id").is_err());
        assert!(id("host\n1", "host id").is_err());
        assert_eq!(id(" host-1 ", "host id").expect("valid id"), "host-1");
    }

    #[test]
    fn snapshot_json_is_canonical_json() {
        assert_eq!(
            snapshot_json(&json!({"health": "online"})).expect("json"),
            r#"{"health":"online"}"#
        );
    }
    #[test]
    fn newer_sync_does_not_replace_a_newer_metric_with_old_backfill() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE komari_snapshots(integration_id TEXT NOT NULL,node_id TEXT NOT NULL,host_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,sampled_at INTEGER NOT NULL,received_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(integration_id,node_id));").unwrap();
        let tx = conn.transaction().unwrap();
        let mut value = super::KomariSnapshotPayload {
            integration_id: "integration".into(),
            node_id: "node".into(),
            host_id: "host".into(),
            snapshot: json!({"metrics":{"data":{"cpuPercent":20}}}),
            sampled_at: 200,
            received_at: 300,
            expires_at: 1200,
            updated_at: Some(300),
        };
        super::insert_snapshot(&tx, &value).unwrap();
        value.sampled_at = 100;
        value.updated_at = Some(400);
        value.snapshot = json!({"metrics":{"data":{"cpuPercent":99}}});
        super::insert_snapshot(&tx, &value).unwrap();
        let sampled: i64 = tx
            .query_row("SELECT sampled_at FROM komari_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(sampled, 200);
    }
}
