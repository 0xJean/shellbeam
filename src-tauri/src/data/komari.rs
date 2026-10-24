use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use url::Url;
use uuid::Uuid;

use crate::storage::{data_file_path, now_unix_ms};

const KOMARI_DB: &str = "workspace_inventory.sqlite3";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    initialize(&conn)?;
    Ok(conn)
}

fn initialize(conn: &Connection) -> Result<(), String> {
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
    .map_err(|err| format!("Initialize Komari db failed: {err}"))
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
pub async fn upsert_komari_integration(
    app: tauri::AppHandle,
    input: KomariIntegrationInput,
) -> Result<KomariIntegration, String> {
    let session = app.state::<crate::vault::VaultState>().session_generation();
    tauri::async_runtime::spawn_blocking(move || {
        let vault_id = input.vault_id.trim().to_string();
        let state = app.state::<crate::vault::VaultState>();
        if !state.is_unlocked(&vault_id) || state.session_generation() != session {
            return Err("MONITORING_SCOPE_CHANGED".into());
        }
        let mut conn = open(&app)?;
        let pending =
            prepare_integration(&conn, input, super::monitoring_identity::verify_endpoint)?;
        state.while_unlocked(&vault_id, || {
            if state.session_generation() != session {
                return Err("MONITORING_SCOPE_CHANGED".into());
            }
            persist_integration(&mut conn, pending)
        })
    })
    .await
    .map_err(|_| "MONITORING_IDENTITY_UNAVAILABLE".to_string())?
}

fn read_existing(conn: &Connection, id: &str) -> Result<Option<KomariIntegration>, String> {
    conn.query_row(
        "SELECT id, vault_id, name, endpoint, credential_ref, enabled, created_at, updated_at FROM komari_integrations WHERE id = ?1",
        params![id], row_to_integration,
    ).optional().map_err(|err| format!("Read existing Komari integration scope failed: {err}"))
}

struct PendingIntegration {
    existing: Option<KomariIntegration>,
    next: KomariIntegration,
}

fn prepare_integration(
    conn: &Connection,
    input: KomariIntegrationInput,
    verify_destination: impl FnOnce(&str) -> Result<(), String>,
) -> Result<PendingIntegration, String> {
    let (vault_id, name, endpoint, credential_ref) = validate(&input)?;
    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let existing = read_existing(conn, &id)?;
    if existing.as_ref().is_some_and(|v| v.vault_id != vault_id) {
        return Err("Komari integration belongs to another Vault".into());
    }
    // Retained destinations keep migration/recovery access. New or changed
    // destinations must identify our server before metadata/credential writes.
    if existing.as_ref().is_none_or(|v| v.endpoint != endpoint) {
        verify_destination(&endpoint)?;
    }
    let now = now_unix_ms();
    let created_at = existing.as_ref().map(|v| v.created_at).unwrap_or(now);
    Ok(PendingIntegration {
        existing,
        next: KomariIntegration {
            id,
            vault_id,
            name,
            endpoint,
            credential_ref,
            enabled: input.enabled,
            created_at,
            updated_at: now,
        },
    })
}

fn persist_integration(
    conn: &mut Connection,
    pending: PendingIntegration,
) -> Result<KomariIntegration, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("Save Komari integration failed: {err}"))?;
    let next = pending.next;
    if read_existing(&tx, &next.id)? != pending.existing {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    tx.execute(
        "INSERT INTO komari_integrations
           (id, vault_id, name, endpoint, credential_ref, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           vault_id = excluded.vault_id, name = excluded.name, endpoint = excluded.endpoint,
           credential_ref = excluded.credential_ref, enabled = excluded.enabled, updated_at = excluded.updated_at",
        params![next.id, next.vault_id, next.name, next.endpoint, next.credential_ref, next.enabled as i64, next.created_at, next.updated_at],
    ).map_err(|err| format!("Save Komari integration failed: {err}"))?;
    tx.commit()
        .map_err(|err| format!("Save Komari integration failed: {err}"))?;
    Ok(next)
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

#[cfg(test)]
mod admission_tests {
    use super::*;
    fn input() -> KomariIntegrationInput {
        KomariIntegrationInput {
            id: Some("service".into()),
            vault_id: "vault".into(),
            name: "Retained service".into(),
            endpoint: "https://monitor.example".into(),
            credential_ref: "secret-reference".into(),
            enabled: true,
        }
    }
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        conn
    }
    fn seed(conn: &mut Connection) -> KomariIntegration {
        let pending = prepare_integration(conn, input(), |_| Ok(())).unwrap();
        persist_integration(conn, pending).unwrap()
    }
    #[test]
    fn rejected_new_destination_has_no_saved_metadata() {
        let conn = database();
        assert!(prepare_integration(&conn, input(), |_| Err(
            "MONITORING_SHELLBEAM_REQUIRED".into()
        ))
        .is_err());
        assert!(read_existing(&conn, "service").unwrap().is_none());
    }
    #[test]
    fn rejected_endpoint_change_retains_original_record_and_credential_reference() {
        let mut conn = database();
        let old = seed(&mut conn);
        let mut next = input();
        next.endpoint = "https://upstream.example".into();
        next.credential_ref = "other-reference".into();
        assert!(
            prepare_integration(&conn, next, |_| Err("MONITORING_SHELLBEAM_REQUIRED".into()))
                .is_err()
        );
        assert_eq!(read_existing(&conn, "service").unwrap(), Some(old));
    }
    #[test]
    fn retained_legacy_destination_can_be_disabled_offline_without_data_migration() {
        let mut conn = database();
        let old = seed(&mut conn);
        let mut next = input();
        next.enabled = false;
        next.name = "Archived service".into();
        let pending = prepare_integration(&conn, next, |_| {
            panic!("unchanged destination must remain recoverable offline")
        })
        .unwrap();
        let saved = persist_integration(&mut conn, pending).unwrap();
        assert_eq!(saved.id, old.id);
        assert_eq!(saved.created_at, old.created_at);
        assert_eq!(saved.credential_ref, old.credential_ref);
        assert_eq!(saved.endpoint, old.endpoint);
        assert!(!saved.enabled);
    }
    #[test]
    fn concurrent_changes_are_not_overwritten_after_network_preflight() {
        let mut conn = database();
        seed(&mut conn);
        let mut next = input();
        next.endpoint = "https://new.example".into();
        let pending = prepare_integration(&conn, next, |_| Ok(())).unwrap();
        conn.execute(
            "UPDATE komari_integrations SET name='Concurrent edit' WHERE id='service'",
            [],
        )
        .unwrap();
        assert_eq!(
            persist_integration(&mut conn, pending).unwrap_err(),
            "MONITORING_SCOPE_CHANGED"
        );
        let saved = read_existing(&conn, "service").unwrap().unwrap();
        assert_eq!(saved.name, "Concurrent edit");
        assert_eq!(saved.endpoint, "https://monitor.example");
    }
    #[test]
    fn other_vault_is_rejected_before_network_preflight() {
        let mut conn = database();
        let old = seed(&mut conn);
        let mut next = input();
        next.vault_id = "different".into();
        assert!(
            prepare_integration(&conn, next, |_| panic!("cross-Vault network access")).is_err()
        );
        assert_eq!(read_existing(&conn, "service").unwrap(), Some(old));
    }
}
