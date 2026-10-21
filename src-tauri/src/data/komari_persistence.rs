//! Durable, local storage for the read-only Komari observations.
//!
//! Komari's API is intentionally kept out of this module.  The web layer
//! fetches and validates the wire response, then stores canonical ProbeSnapshot
//! JSON here.  Keeping the cache in the app database means a host view can be
//! rendered while Komari is unavailable and makes the cache survive restarts.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

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
    pub vault_id: Option<String>,
    pub expected_mapping_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariMappingState {
    pub mappings: Vec<KomariMapping>,
    pub revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariMappingEdit {
    pub vault_id: String,
    pub integration_id: String,
    pub node_id: String,
    /// None removes the manual choice. Address matches remain suggestions only.
    pub host_id: Option<String>,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariSyncState {
    pub integration_id: String,
    /// Compatibility scheduling metadata, not proof of a successful sync.
    pub last_synced_at: i64,
    #[serde(default)]
    pub last_successful_sync_at: Option<i64>,
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
    initialize(&conn)?;
    Ok(conn)
}

fn initialize(conn: &Connection) -> Result<(), String> {
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
        CREATE TABLE IF NOT EXISTS komari_mapping_revisions (
          integration_id TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS komari_sync_state (
          integration_id TEXT PRIMARY KEY NOT NULL,
          last_synced_at INTEGER NOT NULL,
          ttl_ms INTEGER NOT NULL,
          alert_summary_json TEXT,
          updated_at INTEGER NOT NULL,
          last_successful_sync_at INTEGER
        );
        "#,
    )
    .map_err(|err| format!("Initialize Komari persistence db failed: {err}"))?;
    // Old last_synced_at values may have come from a local alert/cache write.
    // Never backfill provenance from them. Serialize the nullable migration so
    // two windows opening the old database cannot both ALTER the same column.
    if !has_successful_sync_column(conn)? {
        let tx = Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Begin Komari sync provenance migration failed")?;
        if !has_successful_sync_column(&tx)? {
            tx.execute(
                "ALTER TABLE komari_sync_state ADD COLUMN last_successful_sync_at INTEGER",
                [],
            )
            .map_err(|_| "Migrate Komari sync provenance failed")?;
        }
        tx.commit()
            .map_err(|_| "Commit Komari sync provenance migration failed")?;
    }
    super::probe_persistence::initialize(&conn)?;
    Ok(())
}

fn has_successful_sync_column(conn: &Connection) -> Result<bool, String> {
    let mut statement = conn
        .prepare("PRAGMA table_info(komari_sync_state)")
        .map_err(|_| "Read Komari sync schema failed")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| "Read Komari sync schema failed")?;
    for column in columns {
        if column.map_err(|_| "Read Komari sync schema failed")? == "last_successful_sync_at" {
            return Ok(true);
        }
    }
    Ok(false)
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
        last_successful_sync_at: row.get(5)?,
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
    if !matches!(
        (source.as_str(), confidence.as_str()),
        ("manual", "explicit") | ("address", "matched")
    ) {
        return Err("Komari mapping source is invalid".into());
    }
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

fn mapping_state(conn: &Connection, integration_id: &str) -> Result<KomariMappingState, String> {
    let revision = conn
        .query_row(
            "SELECT revision FROM komari_mapping_revisions WHERE integration_id=?1",
            params![integration_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "KOMARI_MAPPING_READ_FAILED")?
        .unwrap_or(0);
    let mut statement = conn.prepare("SELECT integration_id,host_id,node_id,source,confidence,updated_at FROM komari_mappings WHERE integration_id=?1 ORDER BY host_id").map_err(|_| "KOMARI_MAPPING_READ_FAILED")?;
    let mappings = statement
        .query_map(params![integration_id], read_mapping)
        .map_err(|_| "KOMARI_MAPPING_READ_FAILED")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "KOMARI_MAPPING_READ_FAILED")?;
    Ok(KomariMappingState { mappings, revision })
}

fn require_integration_scope(
    conn: &Connection,
    integration_id: &str,
    vault_id: &str,
) -> Result<(), String> {
    let found: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM komari_integrations WHERE id=?1 AND vault_id=?2)",
            params![integration_id, vault_id],
            |row| row.get(0),
        )
        .map_err(|_| "KOMARI_MAPPING_SCOPE_MISMATCH")?;
    if !found {
        return Err("KOMARI_MAPPING_SCOPE_MISMATCH".into());
    }
    Ok(())
}

fn bump_mapping_revision(tx: &Transaction<'_>, integration_id: &str) -> Result<(), String> {
    tx.execute("INSERT INTO komari_mapping_revisions(integration_id,revision) VALUES(?1,1) ON CONFLICT(integration_id) DO UPDATE SET revision=revision+1", params![integration_id]).map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    Ok(())
}

fn edit_mapping(
    conn: &mut Connection,
    payload: &KomariMappingEdit,
) -> Result<KomariMappingState, String> {
    let integration = normalize_integration_id(&payload.integration_id)?;
    let vault = id(&payload.vault_id, "vault id")?;
    let node = id(&payload.node_id, "node id")?;
    let host = payload
        .host_id
        .as_deref()
        .map(|value| id(value, "host id"))
        .transpose()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    require_integration_scope(&tx, &integration, &vault)?;
    let current = mapping_state(&tx, &integration)?;
    if current.revision != payload.expected_revision {
        return Err("KOMARI_MAPPING_CONFLICT".into());
    }
    if let Some(host) = &host {
        let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM komari_mappings m JOIN komari_integrations i ON i.id=m.integration_id JOIN komari_integrations current ON current.id=?1 WHERE i.vault_id=?2 AND i.endpoint=current.endpoint AND m.node_id=?3 AND m.host_id!=?4 AND m.integration_id!=?1)", params![integration,vault,node,host], |r|r.get(0)).map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
        if duplicate {
            return Err("KOMARI_NODE_ALREADY_BOUND".into());
        }
        let found: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_hosts WHERE vault_id=?1 AND id=?2)",
                params![vault, host],
                |row| row.get(0),
            )
            .map_err(|_| "KOMARI_MAPPING_HOST_UNAVAILABLE")?;
        if !found {
            return Err("KOMARI_MAPPING_HOST_UNAVAILABLE".into());
        }
        if current.mappings.iter().any(|mapping| {
            mapping.source == "manual" && mapping.host_id == *host && mapping.node_id != node
        }) {
            return Err("KOMARI_MAPPING_HOST_ALREADY_BOUND".into());
        }
    }
    tx.execute("DELETE FROM komari_mappings WHERE integration_id=?1 AND (node_id=?2 OR (?3 IS NOT NULL AND host_id=?3))", params![integration, node, host]).map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    if let Some(host) = &host {
        insert_mapping(
            &tx,
            &KomariMappingPayload {
                integration_id: integration.clone(),
                host_id: host.clone(),
                node_id: node,
                source: "manual".into(),
                confidence: "explicit".into(),
                updated_at: Some(now_unix_ms()),
            },
        )?;
    }
    // A cached observation is tied to the old host/node association. History
    // remains intact, but no latest health may survive a manual reassignment.
    tx.execute(
        "DELETE FROM komari_snapshots WHERE integration_id=?1",
        params![integration],
    )
    .map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    let has_probe: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='probe_snapshots')", [], |row| row.get(0)).map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    if has_probe {
        tx.execute("DELETE FROM probe_snapshots WHERE vault_id=?1 AND provider_kind='komari' AND provider_id=?2", params![vault, integration]).map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    }
    tx.execute(
        "UPDATE komari_sync_state SET last_synced_at=0,last_successful_sync_at=NULL WHERE integration_id=?1",
        params![integration],
    )
    .map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    bump_mapping_revision(&tx, &integration)?;
    let saved = mapping_state(&tx, &integration)?;
    tx.commit().map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    Ok(saved)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMonitoringHost {
    pub vault_id: String,
    pub integration_id: String,
    pub node_id: String,
    pub expected_revision: i64,
    pub expected_integration_version: i64,
    pub name: String,
    pub group: String,
    pub tags: Vec<String>,
}

fn import_monitoring_host_on(
    conn: &mut Connection,
    p: &ImportMonitoringHost,
) -> Result<super::hosts::HostProfile, String> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
    require_integration_scope(&tx, &p.integration_id, &p.vault_id)?;
    let (version, endpoint): (i64, String) = tx
        .query_row(
            "SELECT updated_at,endpoint FROM komari_integrations WHERE id=?1 AND vault_id=?2",
            params![p.integration_id, p.vault_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "KOMARI_MAPPING_SCOPE_MISMATCH")?;
    if version != p.expected_integration_version
        || mapping_state(&tx, &p.integration_id)?.revision != p.expected_revision
    {
        return Err("KOMARI_MAPPING_CONFLICT".into());
    }
    id(&p.node_id, "node id")?;
    if p.name.trim().is_empty()
        || p.name.len() > 400
        || p.group.len() > 400
        || p.tags.len() > 50
        || p.tags.iter().any(|t| t.len() > 100)
    {
        return Err("HOST_NAME_REQUIRED".into());
    }
    // The same endpoint/node imported through another saved integration is
    // still the same directory entry within this Vault. Never infer from IP/name.
    let occupied: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM komari_mappings m JOIN komari_integrations i ON i.id=m.integration_id WHERE i.vault_id=?1 AND i.endpoint=?2 AND m.node_id=?3)", params![p.vault_id,endpoint,p.node_id], |r|r.get(0)).map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
    if occupied {
        return Err("KOMARI_NODE_ALREADY_BOUND".into());
    }
    let now = now_unix_ms();
    let host = super::hosts::HostProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: p.name.trim().into(),
        group: p.group.clone(),
        tags: p.tags.clone(),
        connections: Some(vec![]),
        default_connection_id: None,
        address: String::new(),
        username: String::new(),
        port: 0,
        auth_type: "password".into(),
        secret_key_ref: None,
        password_key_ref: None,
        private_key_ref: None,
        jump_host_id: None,
        jump_host: None,
        jump_port: None,
        jump_user: None,
        created_at: now,
        updated_at: now,
    };
    super::hosts::insert_host_row(&tx, &p.vault_id, &host)?;
    insert_mapping(
        &tx,
        &KomariMappingPayload {
            integration_id: p.integration_id.clone(),
            host_id: host.id.clone(),
            node_id: p.node_id.clone(),
            source: "manual".into(),
            confidence: "explicit".into(),
            updated_at: Some(now),
        },
    )?;
    bump_mapping_revision(&tx, &p.integration_id)?;
    tx.execute("UPDATE komari_sync_state SET last_synced_at=0,last_successful_sync_at=NULL WHERE integration_id=?1", [&p.integration_id]).map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
    super::host_metadata::record_directory_edit(
        &tx,
        &p.vault_id,
        &host.id,
        "host.directory.import",
    )?;
    tx.commit().map_err(|_| "HOST_DIRECTORY_STORE_FAILED")?;
    Ok(host)
}

#[tauri::command]
pub fn import_monitoring_host(
    app: tauri::AppHandle,
    payload: ImportMonitoringHost,
) -> Result<super::hosts::HostProfile, String> {
    app.state::<crate::vault::secrets::VaultState>()
        .while_unlocked(&payload.vault_id, || {
            super::hosts::load_hosts(&app, Some(&payload.vault_id))?;
            import_monitoring_host_on(&mut open(&app)?, &payload)
        })
}

#[tauri::command]
pub fn get_komari_mapping_state(
    app: tauri::AppHandle,
    vault_id: String,
    integration_id: String,
) -> Result<KomariMappingState, String> {
    let integration = normalize_integration_id(&integration_id)?;
    let vault = id(&vault_id, "vault id")?;
    let conn = open(&app)?;
    require_integration_scope(&conn, &integration, &vault)?;
    mapping_state(&conn, &integration)
}

#[tauri::command]
pub fn edit_komari_mapping(
    app: tauri::AppHandle,
    payload: KomariMappingEdit,
) -> Result<KomariMappingState, String> {
    let state = app.state::<crate::vault::secrets::VaultState>();
    let vault = id(&payload.vault_id, "vault id")?;
    state.while_unlocked(&vault, || {
        // Ensure legacy profiles are migrated before validating the same-Vault
        // host inside the atomic edit transaction.
        super::hosts::load_hosts(&app, Some(&vault))?;
        edit_mapping(&mut open(&app)?, &payload)
    })
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
    bump_mapping_revision(&tx, &payload.integration_id)?;
    tx.commit()
        .map_err(|err| format!("Commit Komari mapping failed: {err}"))
}

/// Validate sync mappings without authorizing new address-based associations.
/// Manual bindings are changed through the revision-checked edit command.
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
    replace_sync_mappings(&tx, &integration_id, &payload.mappings, None)?;
    bump_mapping_revision(&tx, &integration_id)?;
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
    let state = app.state::<crate::vault::secrets::VaultState>();
    if let Some(vault) = payload.vault_id.as_deref() {
        let vault = id(vault, "vault id")?;
        return state.while_unlocked(&vault, || persist_sync(&mut open(&app)?, &payload));
    }
    persist_sync(&mut open(&app)?, &payload)
}

fn replace_sync_mappings(
    tx: &Transaction<'_>,
    integration: &str,
    mappings: &[KomariMappingPayload],
    expected_revision: Option<i64>,
) -> Result<(), String> {
    let saved = mapping_state(tx, integration)?;
    if expected_revision.is_some_and(|revision| revision != saved.revision) {
        return Err("KOMARI_MAPPING_CONFLICT".into());
    }
    let manual = saved
        .mappings
        .iter()
        .filter(|mapping| mapping.source == "manual")
        .collect::<Vec<_>>();
    for mapping in mappings {
        if mapping.integration_id.trim() != integration {
            return Err("Komari mapping integration does not match the sync".into());
        }
        validate_mapping(mapping)?;
        if mapping.source == "manual" {
            if !manual
                .iter()
                .any(|saved| saved.host_id == mapping.host_id && saved.node_id == mapping.node_id)
            {
                return Err("KOMARI_MAPPING_CONFLICT".into());
            }
        } else if !saved.mappings.iter().any(|old| {
            old.host_id == mapping.host_id
                && old.node_id == mapping.node_id
                && old.source == mapping.source
        }) {
            return Err("KOMARI_MAPPING_CONFIRMATION_REQUIRED".into());
        } else if manual
            .iter()
            .any(|saved| saved.host_id == mapping.host_id || saved.node_id == mapping.node_id)
        {
            return Err("KOMARI_MAPPING_CONFLICT".into());
        }
    }
    // Retain legacy suggestions and history; only explicit edits change bindings.
    Ok(())
}

fn persist_sync(conn: &mut Connection, payload: &KomariPersistencePayload) -> Result<(), String> {
    let integration_id = normalize_integration_id(&payload.integration_id)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("Begin Komari sync persistence failed: {err}"))?;
    if let Some(vault) = payload.vault_id.as_deref() {
        let vault = id(vault, "vault id")?;
        require_integration_scope(&tx, &integration_id, &vault)?;
        for mapping in &payload.mappings {
            let found: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspace_hosts WHERE vault_id=?1 AND id=?2)",
                    params![vault, mapping.host_id],
                    |row| row.get(0),
                )
                .map_err(|_| "KOMARI_MAPPING_HOST_UNAVAILABLE")?;
            if !found {
                return Err("KOMARI_MAPPING_HOST_UNAVAILABLE".into());
            }
        }
    }
    replace_sync_mappings(
        &tx,
        &integration_id,
        &payload.mappings,
        payload.expected_mapping_revision,
    )?;
    for snapshot in &payload.snapshots {
        if snapshot.integration_id.trim() != integration_id {
            return Err("Komari snapshot integration does not match the sync".into());
        }
        let mapped: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM komari_mappings WHERE integration_id=?1 AND host_id=?2 AND node_id=?3)", params![integration_id, snapshot.host_id, snapshot.node_id], |row| row.get(0)).map_err(|_| "KOMARI_MAPPING_READ_FAILED")?;
        if !mapped {
            return Err("KOMARI_MAPPING_CONFLICT".into());
        }
        insert_snapshot(&tx, snapshot)?;
        if let Some(vault) = payload.vault_id.as_deref() {
            // The incoming observation may be older backfill. Project the row
            // actually retained by the dedicated monotonic-sample upsert, not
            // the rejected incoming payload, into the canonical provider cache.
            let retained = tx.query_row("SELECT integration_id,node_id,host_id,snapshot_json,sampled_at,received_at,expires_at,updated_at FROM komari_snapshots WHERE integration_id=?1 AND node_id=?2", params![integration_id, snapshot.node_id], read_snapshot).map_err(|_| "KOMARI_MAPPING_READ_FAILED")?;
            super::probe_persistence::insert_snapshot(
                &tx,
                &super::probe_persistence::ProbeSnapshotPayload {
                    vault_id: vault.to_string(),
                    provider_kind: "komari".into(),
                    provider_id: integration_id.clone(),
                    host_id: retained.host_id,
                    snapshot: retained.snapshot,
                    sampled_at: retained.sampled_at,
                    received_at: retained.received_at,
                    expires_at: retained.expires_at,
                    updated_at: Some(retained.updated_at),
                },
            )?;
        }
    }
    tx.execute("DELETE FROM komari_snapshots WHERE integration_id=?1 AND NOT EXISTS(SELECT 1 FROM komari_mappings m WHERE m.integration_id=komari_snapshots.integration_id AND m.host_id=komari_snapshots.host_id AND m.node_id=komari_snapshots.node_id)", params![integration_id]).map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
    if let Some(vault) = payload.vault_id.as_deref() {
        tx.execute("DELETE FROM probe_snapshots WHERE vault_id=?1 AND provider_kind='komari' AND provider_id=?2 AND NOT EXISTS(SELECT 1 FROM komari_mappings m WHERE m.integration_id=probe_snapshots.provider_id AND m.host_id=probe_snapshots.host_id AND m.node_id=json_extract(probe_snapshots.snapshot_json,'$.provider.nodeId'))", params![vault, integration_id]).map_err(|_| "KOMARI_MAPPING_SAVE_FAILED")?;
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
        // Only this complete-sync transaction may establish provenance. Keep
        // it independent of alert updated_at ordering: a local acknowledgement
        // during an in-flight sync must not prevent recording that real sync.
        // Ordinary sync-state upserts deliberately never write this column.
        if last_synced_at > 0 && last_synced_at <= now_unix_ms() {
            tx.execute(
                "UPDATE komari_sync_state SET last_successful_sync_at=MAX(COALESCE(last_successful_sync_at,0),?1) WHERE integration_id=?2",
                params![last_synced_at, integration_id],
            )
            .map_err(|_| "Save Komari successful sync provenance failed")?;
        }
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
        "SELECT integration_id, last_synced_at, ttl_ms, alert_summary_json, updated_at, last_successful_sync_at
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

    fn mapping_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        prepare_mapping_db(&conn);
        conn
    }

    fn prepare_mapping_db(conn: &rusqlite::Connection) {
        super::initialize(conn).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS komari_integrations(id TEXT PRIMARY KEY,vault_id TEXT,endpoint TEXT,updated_at INTEGER); CREATE TABLE IF NOT EXISTS workspace_hosts(vault_id TEXT,id TEXT,PRIMARY KEY(vault_id,id)); INSERT OR IGNORE INTO komari_integrations VALUES('server','vault-a','https://monitor.test',1); INSERT OR IGNORE INTO workspace_hosts VALUES('vault-a','one'),('vault-a','two'),('vault-b','foreign'); INSERT OR IGNORE INTO komari_mappings VALUES('server','one','node','address','matched',1);").unwrap();
    }

    fn edit(node: &str, host: Option<&str>, revision: i64) -> super::KomariMappingEdit {
        super::KomariMappingEdit {
            vault_id: "vault-a".into(),
            integration_id: "server".into(),
            node_id: node.into(),
            host_id: host.map(str::to_string),
            expected_revision: revision,
        }
    }

    fn sync(revision: i64, host: &str, source: &str) -> super::KomariPersistencePayload {
        super::KomariPersistencePayload {
            integration_id: "server".into(),
            vault_id: Some("vault-a".into()),
            expected_mapping_revision: Some(revision),
            mappings: vec![super::KomariMappingPayload {
                integration_id: "server".into(),
                host_id: host.into(),
                node_id: "node".into(),
                source: source.into(),
                confidence: if source == "manual" {
                    "explicit"
                } else {
                    "matched"
                }
                .into(),
                updated_at: Some(1_000),
            }],
            snapshots: vec![super::KomariSnapshotPayload {
                integration_id: "server".into(),
                host_id: host.into(),
                node_id: "node".into(),
                snapshot: json!({"host":{"hostId":host},"provider":{"kind":"komari","id":"server","nodeId":"node"},"health":"online"}),
                sampled_at: 900,
                received_at: 1000,
                expires_at: 61_000,
                updated_at: Some(1_000),
            }],
            last_synced_at: Some(1_000),
            ttl_ms: Some(60_000),
            alert_summary: None,
        }
    }

    fn sync_state(conn: &rusqlite::Connection) -> super::KomariSyncState {
        conn.query_row("SELECT integration_id,last_synced_at,ttl_ms,alert_summary_json,updated_at,last_successful_sync_at FROM komari_sync_state WHERE integration_id='server'", [], super::read_sync_state).unwrap()
    }

    #[test]
    fn legacy_alert_timestamps_never_gain_provenance_and_real_sync_survives_local_write_ordering() {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-komari-provenance-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let mut conn = rusqlite::Connection::open(&path).unwrap();
            // Simulate an existing database, including a timestamp once created
            // by an alert write. Migration must not infer success from it.
            conn.execute_batch("CREATE TABLE komari_sync_state(integration_id TEXT PRIMARY KEY NOT NULL,last_synced_at INTEGER NOT NULL,ttl_ms INTEGER NOT NULL,alert_summary_json TEXT,updated_at INTEGER NOT NULL); INSERT INTO komari_sync_state VALUES('server',1300,60000,NULL,1400);").unwrap();
            prepare_mapping_db(&conn);
            assert_eq!(sync_state(&conn).last_successful_sync_at, None);
            assert_eq!(sync_state(&conn).last_synced_at, 1300);

            // Even a caller attempting to send the new field cannot set it via
            // the generic alert payload. It is not a deserializable input field.
            let alert: super::KomariSyncStatePayload = serde_json::from_value(json!({"integrationId":"server","lastSyncedAt":1500,"lastSuccessfulSyncAt":1500,"ttlMs":60000,"updatedAt":1600})).unwrap();
            let tx = conn.transaction().unwrap();
            super::insert_sync_state(&tx, &alert).unwrap();
            tx.commit().unwrap();
            assert_eq!(sync_state(&conn).last_successful_sync_at, None);

            // A real sync begun before that local alert write still establishes
            // provenance, without replacing the newer legacy scheduling row.
            super::persist_sync(&mut conn, &sync(0, "one", "address")).unwrap();
            assert_eq!(sync_state(&conn).last_successful_sync_at, Some(1000));
            assert_eq!(sync_state(&conn).last_synced_at, 1500);
            let tx = conn.transaction().unwrap();
            super::insert_sync_state(&tx, &alert).unwrap();
            tx.commit().unwrap();
            assert_eq!(sync_state(&conn).last_successful_sync_at, Some(1000));
        }
        {
            let mut conn = rusqlite::Connection::open(&path).unwrap();
            super::initialize(&conn).unwrap();
            assert_eq!(sync_state(&conn).last_successful_sync_at, Some(1000));
            super::edit_mapping(&mut conn, &edit("node", Some("two"), 0)).unwrap();
            assert_eq!(sync_state(&conn).last_successful_sync_at, None);
            assert_eq!(sync_state(&conn).last_synced_at, 0);
            // A superseded mapping's failed transaction cannot restore it.
            assert_eq!(
                super::persist_sync(&mut conn, &sync(0, "one", "address")).unwrap_err(),
                "KOMARI_MAPPING_CONFLICT"
            );
            assert_eq!(sync_state(&conn).last_successful_sync_at, None);
            super::persist_sync(&mut conn, &sync(1, "two", "manual")).unwrap();
            assert_eq!(sync_state(&conn).last_successful_sync_at, Some(1000));
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_old_database_opens_migrate_nullable_provenance_once_without_backfill() {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-komari-provenance-migration-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE komari_sync_state(integration_id TEXT PRIMARY KEY NOT NULL,last_synced_at INTEGER NOT NULL,ttl_ms INTEGER NOT NULL,alert_summary_json TEXT,updated_at INTEGER NOT NULL); INSERT INTO komari_sync_state VALUES('server',1300,60000,NULL,1400);").unwrap();
        }
        let ready = std::sync::Arc::new(std::sync::Barrier::new(4));
        let threads = (0..4)
            .map(|_| {
                let path = path.clone();
                let ready = ready.clone();
                std::thread::spawn(move || {
                    let conn = rusqlite::Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    ready.wait();
                    super::initialize(&conn).unwrap();
                    assert_eq!(sync_state(&conn).last_successful_sync_at, None);
                    assert_eq!(sync_state(&conn).last_synced_at, 1300);
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_alert_and_sync_writers_preserve_real_provenance_and_legacy_ttl_metadata() {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-komari-provenance-writers-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            prepare_mapping_db(&conn);
        }
        let ready = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads = [false, true]
            .into_iter()
            .map(|is_sync| {
                let path = path.clone();
                let ready = ready.clone();
                std::thread::spawn(move || {
                    let mut conn = rusqlite::Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    ready.wait();
                    if is_sync {
                        super::persist_sync(&mut conn, &sync(0, "one", "address")).unwrap();
                    } else {
                        let tx = conn.transaction().unwrap();
                        super::insert_sync_state(
                            &tx,
                            &super::KomariSyncStatePayload {
                                integration_id: "server".into(),
                                last_synced_at: 2000,
                                ttl_ms: 60_000,
                                alert_summary: None,
                                updated_at: Some(2000),
                            },
                        )
                        .unwrap();
                        tx.commit().unwrap();
                    }
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            assert_eq!(sync_state(&conn).last_successful_sync_at, Some(1000));
            assert_eq!(sync_state(&conn).last_synced_at, 2000);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn manual_mapping_survives_reopen_and_sync_then_release_requires_new_confirmation() {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-komari-mapping-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let mut conn = rusqlite::Connection::open(&path).unwrap();
            prepare_mapping_db(&conn);
            let saved = super::edit_mapping(&mut conn, &edit("node", Some("two"), 0)).unwrap();
            assert_eq!(saved.revision, 1);
        }
        {
            let mut conn = rusqlite::Connection::open(&path).unwrap();
            super::initialize(&conn).unwrap();
            assert_eq!(
                super::mapping_state(&conn, "server").unwrap().mappings[0].host_id,
                "two"
            );
            super::persist_sync(&mut conn, &sync(1, "two", "manual")).unwrap();
            assert_eq!(
                super::mapping_state(&conn, "server").unwrap().mappings[0].source,
                "manual"
            );
            let canonical: String = conn.query_row("SELECT host_id FROM probe_snapshots WHERE vault_id='vault-a' AND provider_id='server'", [], |row| row.get(0)).unwrap();
            assert_eq!(canonical, "two");
            // A missing node's empty sync preserves its manual intent.
            let mut absent = sync(1, "two", "manual");
            absent.snapshots.clear();
            absent.mappings.clear();
            super::persist_sync(&mut conn, &absent).unwrap();
            assert_eq!(
                super::mapping_state(&conn, "server")
                    .unwrap()
                    .mappings
                    .len(),
                1
            );
            super::edit_mapping(&mut conn, &edit("node", None, 1)).unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM probe_snapshots", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 0);
            assert_eq!(
                super::persist_sync(&mut conn, &sync(2, "one", "address")).unwrap_err(),
                "KOMARI_MAPPING_CONFIRMATION_REQUIRED"
            );
            super::edit_mapping(&mut conn, &edit("node", Some("one"), 2)).unwrap();
            let mapping = super::mapping_state(&conn, "server").unwrap();
            assert_eq!(mapping.mappings[0].host_id, "one");
            assert_eq!(mapping.mappings[0].source, "manual");
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_sync_or_edit_and_foreign_host_never_reassign_or_publish_snapshots() {
        let mut conn = mapping_db();
        super::persist_sync(&mut conn, &sync(0, "one", "address")).unwrap();
        super::edit_mapping(&mut conn, &edit("node", Some("two"), 0)).unwrap();
        assert_eq!(
            super::persist_sync(&mut conn, &sync(0, "one", "address")).unwrap_err(),
            "KOMARI_MAPPING_CONFLICT"
        );
        assert_eq!(
            super::edit_mapping(&mut conn, &edit("node", Some("one"), 0)).unwrap_err(),
            "KOMARI_MAPPING_CONFLICT"
        );
        assert_eq!(
            super::edit_mapping(&mut conn, &edit("other", Some("foreign"), 1)).unwrap_err(),
            "KOMARI_MAPPING_HOST_UNAVAILABLE"
        );
        let mut foreign = edit("other", Some("one"), 1);
        foreign.vault_id = "vault-b".into();
        assert_eq!(
            super::edit_mapping(&mut conn, &foreign).unwrap_err(),
            "KOMARI_MAPPING_SCOPE_MISMATCH"
        );
        assert_eq!(
            super::edit_mapping(&mut conn, &edit("other", Some("two"), 1)).unwrap_err(),
            "KOMARI_MAPPING_HOST_ALREADY_BOUND"
        );
        assert_eq!(super::mapping_state(&conn, "server").unwrap().revision, 1);
        for table in ["komari_snapshots", "probe_snapshots"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn whole_sync_projects_the_retained_newest_sample_to_both_provider_caches() {
        let mut conn = mapping_db();
        let mut latest = sync(0, "one", "address");
        latest.snapshots[0].sampled_at = 200;
        latest.snapshots[0].updated_at = Some(300);
        latest.snapshots[0].snapshot["health"] = json!("newer");
        super::persist_sync(&mut conn, &latest).unwrap();
        let mut old_backfill = sync(0, "one", "address");
        old_backfill.snapshots[0].sampled_at = 100;
        old_backfill.snapshots[0].updated_at = Some(400);
        old_backfill.snapshots[0].snapshot["health"] = json!("older");
        super::persist_sync(&mut conn, &old_backfill).unwrap();
        for table in ["komari_snapshots", "probe_snapshots"] {
            let row: (i64, i64, String) = conn
                .query_row(
                    &format!("SELECT sampled_at,updated_at,snapshot_json FROM {table}"),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!((row.0, row.1), (200, 300));
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&row.2).unwrap()["health"],
                "newer"
            );
        }
    }

    #[test]
    fn automatic_reassignment_requires_confirmation_and_retains_legacy_history() {
        let mut conn = mapping_db();
        conn.execute_batch("CREATE TABLE provider_metric_history(host_id TEXT,node_id TEXT); INSERT INTO provider_metric_history VALUES('one','node'); INSERT OR IGNORE INTO komari_mappings VALUES('server','one','node','address','matched',1);").unwrap();
        super::persist_sync(&mut conn, &sync(0, "one", "address")).unwrap();
        assert_eq!(
            super::persist_sync(&mut conn, &sync(0, "two", "address")).unwrap_err(),
            "KOMARI_MAPPING_CONFIRMATION_REQUIRED"
        );
        assert_eq!(
            super::mapping_state(&conn, "server").unwrap().mappings[0].host_id,
            "one"
        );
        assert_eq!(
            conn.query_row("SELECT host_id FROM provider_metric_history", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "one"
        );
    }

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

#[cfg(test)]
mod directory_import_tests {
    use super::*;
    fn payload() -> ImportMonitoringHost {
        ImportMonitoringHost {
            vault_id: "a".into(),
            integration_id: "source".into(),
            node_id: "stable-node".into(),
            expected_revision: 0,
            expected_integration_version: 1,
            name: "WEB".into(),
            group: "prod".into(),
            tags: vec!["web".into()],
        }
    }
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        super::super::hosts::initialize_host_schema(&db).unwrap();
        initialize(&db).unwrap();
        db.execute_batch("CREATE TABLE komari_integrations(id TEXT PRIMARY KEY,vault_id TEXT,endpoint TEXT,updated_at INTEGER); INSERT INTO komari_integrations VALUES('source','a','https://monitor.test',1),('alias','a','https://monitor.test',1),('foreign','b','https://monitor.test',1);").unwrap();
        db
    }
    #[test]
    fn import_is_atomic_scoped_and_deduplicates_endpoint_node_without_addresses() {
        let mut db = db();
        let p = payload();
        let host = import_monitoring_host_on(&mut db, &p).unwrap();
        assert!(host.address.is_empty());
        assert_eq!(host.connections.as_ref().unwrap().len(), 0);
        assert_eq!(host.port, 0);
        assert_eq!(
            mapping_state(&db, "source").unwrap().mappings[0].host_id,
            host.id
        );
        let mut stale = payload();
        stale.expected_revision = 0;
        assert_eq!(
            import_monitoring_host_on(&mut db, &stale).unwrap_err(),
            "KOMARI_MAPPING_CONFLICT"
        );
        stale.expected_revision = 1;
        assert_eq!(
            import_monitoring_host_on(&mut db, &stale).unwrap_err(),
            "KOMARI_NODE_ALREADY_BOUND"
        );
        let mut alias = payload();
        alias.integration_id = "alias".into();
        assert_eq!(
            import_monitoring_host_on(&mut db, &alias).unwrap_err(),
            "KOMARI_NODE_ALREADY_BOUND"
        );
        let mut foreign = payload();
        foreign.integration_id = "foreign".into();
        assert_eq!(
            import_monitoring_host_on(&mut db, &foreign).unwrap_err(),
            "KOMARI_MAPPING_SCOPE_MISMATCH"
        );
        foreign.vault_id = "b".into();
        let other = import_monitoring_host_on(&mut db, &foreign).unwrap();
        assert_ne!(host.id, other.id);
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM workspace_hosts WHERE vault_id='a'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let body: String = db
            .query_row(
                "SELECT body FROM host_metadata_events ORDER BY seq LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(body.contains("host.directory.import"));
        assert!(body.contains(&host.id));
        assert!(!body.contains("password"));
    }
    #[test]
    fn stale_discovery_and_failed_audit_cannot_leave_an_unbound_host() {
        let mut db = db();
        let mut p = payload();
        p.expected_integration_version = 0;
        assert_eq!(
            import_monitoring_host_on(&mut db, &p).unwrap_err(),
            "KOMARI_MAPPING_CONFLICT"
        );
        p.expected_integration_version = 1;
        super::super::host_metadata::initialize(&db).unwrap();
        db.execute_batch("CREATE TRIGGER reject_directory_audit BEFORE INSERT ON host_metadata_events BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(import_monitoring_host_on(&mut db, &p).is_err());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM workspace_hosts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(mapping_state(&db, "source").unwrap().mappings.is_empty());
        assert_eq!(mapping_state(&db, "source").unwrap().revision, 0);
    }
}
