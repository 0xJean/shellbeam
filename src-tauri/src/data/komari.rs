use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::storage::{data_file_path, now_unix_ms};

const KOMARI_DB: &str = "workspace_inventory.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariIntegration {
    pub id: String,
    pub vault_id: String,
    pub name: String,
    pub endpoint: String,
    pub credential_ref: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KomariIntegrationInput {
    pub id: Option<String>,
    pub vault_id: String,
    pub name: String,
    pub endpoint: String,
    pub credential_ref: String,
    pub enabled: bool,
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(data_file_path(app, KOMARI_DB)?)
        .map_err(|err| format!("Open Komari db failed: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| format!("Configure Komari db failed: {err}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS komari_integrations (
          id TEXT PRIMARY KEY NOT NULL,
          vault_id TEXT NOT NULL,
          name TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_komari_integrations_vault_updated_at
          ON komari_integrations(vault_id, updated_at DESC);
        "#,
    )
    .map_err(|err| format!("Initialize Komari db failed: {err}"))?;
    Ok(conn)
}

fn normalized_vault_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Komari vault id is required".into());
    }
    Ok(value.to_string())
}

fn normalize_endpoint(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "Komari endpoint must be a valid URL")?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Komari endpoint must use HTTP or HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Komari endpoint must not contain credentials".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn validate(input: &KomariIntegrationInput) -> Result<(String, String, String, String), String> {
    let vault_id = normalized_vault_id(&input.vault_id)?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Komari integration name is required".into());
    }
    let endpoint = normalize_endpoint(&input.endpoint)?;
    let credential_ref = input.credential_ref.trim().to_string();
    if credential_ref.is_empty() || credential_ref.len() > 240 {
        return Err("Komari credential reference is required".into());
    }
    if credential_ref.contains('\n') || credential_ref.contains('\r') {
        return Err("Komari credential reference is invalid".into());
    }
    Ok((vault_id, name, endpoint, credential_ref))
}

fn row_to_integration(row: &rusqlite::Row<'_>) -> rusqlite::Result<KomariIntegration> {
    Ok(KomariIntegration {
        id: row.get(0)?,
        vault_id: row.get(1)?,
        name: row.get(2)?,
        endpoint: row.get(3)?,
        credential_ref: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[tauri::command]
pub fn list_komari_integrations(
    app: tauri::AppHandle,
    vault_id: String,
) -> Result<Vec<KomariIntegration>, String> {
    let vault_id = normalized_vault_id(&vault_id)?;
    let conn = open(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, vault_id, name, endpoint, credential_ref, enabled, created_at, updated_at
             FROM komari_integrations WHERE vault_id = ?1 ORDER BY updated_at DESC",
        )
        .map_err(|err| format!("Prepare Komari integration query failed: {err}"))?;
    let rows = stmt
        .query_map(params![vault_id], row_to_integration)
        .map_err(|err| format!("Query Komari integrations failed: {err}"))?;
    rows.map(|row| row.map_err(|err| format!("Read Komari integration failed: {err}")))
        .collect()
}

#[tauri::command]
pub fn upsert_komari_integration(
    app: tauri::AppHandle,
    input: KomariIntegrationInput,
) -> Result<KomariIntegration, String> {
    let (vault_id, name, endpoint, credential_ref) = validate(&input)?;
    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_unix_ms();
    let conn = open(&app)?;
    let existing_vault: Option<String> = conn
        .query_row(
            "SELECT vault_id FROM komari_integrations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("Read existing Komari integration scope failed: {err}"))?;
    if let Some(existing_vault) = existing_vault {
        if existing_vault != vault_id {
            return Err("Komari integration belongs to another Vault".into());
        }
    }
    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM komari_integrations WHERE id = ?1 AND vault_id = ?2",
            params![id, vault_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("Read Komari integration metadata failed: {err}"))?
        .unwrap_or(now);
    conn.execute(
        "INSERT INTO komari_integrations
           (id, vault_id, name, endpoint, credential_ref, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           vault_id = excluded.vault_id,
           name = excluded.name,
           endpoint = excluded.endpoint,
           credential_ref = excluded.credential_ref,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at",
        params![
            id,
            vault_id,
            name,
            endpoint,
            credential_ref,
            input.enabled as i64,
            created_at,
            now
        ],
    )
    .map_err(|err| format!("Save Komari integration failed: {err}"))?;
    conn.query_row(
        "SELECT id, vault_id, name, endpoint, credential_ref, enabled, created_at, updated_at
         FROM komari_integrations WHERE id = ?1",
        params![id],
        row_to_integration,
    )
    .map_err(|err| format!("Read saved Komari integration failed: {err}"))
}

#[tauri::command]
pub fn delete_komari_integration(
    app: tauri::AppHandle,
    id: String,
    vault_id: String,
) -> Result<(), String> {
    let vault_id = normalized_vault_id(&vault_id)?;
    let id = id.trim();
    if id.is_empty() {
        return Err("Komari integration id is required".into());
    }
    let conn = open(&app)?;
    conn.execute(
        "DELETE FROM komari_integrations WHERE id = ?1 AND vault_id = ?2",
        params![id, vault_id],
    )
    .map_err(|err| format!("Delete Komari integration failed: {err}"))?;
    Ok(())
}
