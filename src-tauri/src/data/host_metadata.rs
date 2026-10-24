//! Durable, opt-in metadata synchronization. No secret values or raw provider
//! payloads are stored here. Host edits and their outbox intent commit in the same database.
use crate::storage::{data_file_path, now_unix_ms};
use crate::vault::secrets::VaultState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::Manager;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
fn err(_: impl std::fmt::Display) -> String {
    "METADATA_STORE_FAILED".into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub name: String,
    pub group: String,
    pub tags: Vec<String>,
}
impl Metadata {
    fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || self.name.chars().count() > 100
            || self.group.chars().count() > 100
            || self.tags.len() > 50
            || self
                .tags
                .iter()
                .any(|v| v.is_empty() || v.len() > 100 || v.contains(';'))
            || std::iter::once(&self.name)
                .chain(std::iter::once(&self.group))
                .chain(self.tags.iter())
                .any(|v| v.chars().any(char::is_control))
        {
            return Err("METADATA_INVALID_FIELDS".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteMetadata {
    pub identity: String,
    pub values: Metadata,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataBinding {
    pub id: String,
    pub vault_id: String,
    pub host_id: String,
    pub integration_id: String,
    pub node_id: String,
    pub endpoint: String,
    pub credential_ref: String,
    pub integration_version: i64,
    pub mapping_revision: i64,
    pub identity: String,
    pub baseline: Option<Metadata>,
    pub desired: Metadata,
    pub remote: Metadata,
    pub status: String,
    pub version: i64,
    pub attempts: u32,
    pub next_attempt_at: i64,
    pub error_code: Option<String>,
    pub conflicts: Vec<String>,
    pub job_id: String,
    pub updated_at: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalEvent {
    #[serde(default)]
    action: Option<String>,
    id: String,
    job_id: String,
    vault_id: String,
    host_id: String,
    status: String,
    detail: String,
}

pub(crate) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS host_metadata_bindings (
        id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, host_id TEXT NOT NULL,
        integration_id TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE(vault_id,host_id,integration_id));
        CREATE TABLE IF NOT EXISTS host_metadata_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS host_metadata_write_guard(vault_id TEXT PRIMARY KEY);
        CREATE TRIGGER IF NOT EXISTS protect_metadata_update BEFORE UPDATE OF name,host_group,tags_json ON workspace_hosts
        WHEN EXISTS(SELECT 1 FROM host_metadata_bindings WHERE vault_id=OLD.vault_id AND host_id=OLD.id AND json_extract(body,'$.status')!='disabled')
        AND NOT EXISTS(SELECT 1 FROM host_metadata_write_guard WHERE vault_id=OLD.vault_id)
        BEGIN SELECT RAISE(ABORT,'METADATA_CLIENT_UPGRADE_REQUIRED'); END;
        CREATE TRIGGER IF NOT EXISTS protect_metadata_delete BEFORE DELETE ON workspace_hosts
        WHEN EXISTS(SELECT 1 FROM host_metadata_bindings WHERE vault_id=OLD.vault_id AND host_id=OLD.id AND json_extract(body,'$.status')!='disabled')
        AND NOT EXISTS(SELECT 1 FROM host_metadata_write_guard WHERE vault_id=OLD.vault_id)
        BEGIN SELECT RAISE(ABORT,'METADATA_CLIENT_UPGRADE_REQUIRED'); END;") .map_err(err)
}
fn open(app: &tauri::AppHandle) -> Result<Connection> {
    let db = super::hosts::open_hosts_db(app)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(err)?;
    initialize(&db)?;
    Ok(db)
}
fn rows(db: &Connection, vault: &str) -> Result<Vec<MetadataBinding>> {
    let mut stmt = db
        .prepare("SELECT body FROM host_metadata_bindings WHERE vault_id=?1 ORDER BY id")
        .map_err(err)?;
    let raw = stmt
        .query_map([vault], |r| r.get::<_, String>(0))
        .map_err(err)?;
    raw.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
        .collect()
}
fn save(db: &Connection, row: &mut MetadataBinding) -> Result<()> {
    row.version += 1;
    row.updated_at = now_unix_ms();
    db.execute("INSERT INTO host_metadata_bindings(id,vault_id,host_id,integration_id,body) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![row.id,row.vault_id,row.host_id,row.integration_id,serde_json::to_string(row).map_err(err)?]).map_err(err)?;
    Ok(())
}
fn host_metadata(db: &Connection, vault: &str, host: &str) -> Result<Option<Metadata>> {
    db.query_row(
        "SELECT name,host_group,tags_json FROM workspace_hosts WHERE vault_id=?1 AND id=?2",
        params![vault, host],
        |r| {
            let tags: String = r.get(2)?;
            Ok(Metadata {
                name: r.get(0)?,
                group: r.get(1)?,
                tags: serde_json::from_str(&tags).unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(err)
}
pub(crate) fn begin_host_write(db: &Connection, vault: &str) -> Result<()> {
    if db.is_autocommit() {
        return Err("METADATA_TRANSACTION_REQUIRED".into());
    }
    initialize(db)?;
    db.execute(
        "INSERT OR IGNORE INTO host_metadata_write_guard(vault_id) VALUES(?1)",
        [vault],
    )
    .map_err(err)?;
    Ok(())
}
pub(crate) fn end_host_write(db: &Connection, vault: &str) -> Result<()> {
    db.execute(
        "DELETE FROM host_metadata_write_guard WHERE vault_id=?1",
        [vault],
    )
    .map_err(err)?;
    Ok(())
}
fn write_host(db: &Connection, row: &MetadataBinding) -> Result<()> {
    begin_host_write(db, &row.vault_id)?;
    db.execute("UPDATE workspace_hosts SET name=?1,host_group=?2,tags_json=?3,updated_at=MAX(updated_at+1,?4)
        WHERE vault_id=?5 AND id=?6",params![row.desired.name,row.desired.group,serde_json::to_string(&row.desired.tags).map_err(err)?,now_unix_ms(),row.vault_id,row.host_id]).map_err(err)?;
    end_host_write(db, &row.vault_id)
}
fn scope(db: &Connection, row: &MetadataBinding) -> Result<bool> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM komari_integrations i
        JOIN komari_mappings m ON m.integration_id=i.id
        JOIN workspace_hosts h ON h.id=m.host_id AND h.vault_id=i.vault_id
        WHERE i.id=?1 AND i.vault_id=?2 AND i.enabled=1 AND i.endpoint=?3 AND i.credential_ref=?4
        AND i.updated_at=?5 AND m.host_id=?6 AND m.node_id=?7
        AND COALESCE((SELECT revision FROM komari_mapping_revisions WHERE integration_id=i.id),0)=?8)",
        params![row.integration_id,row.vault_id,row.endpoint,row.credential_ref,row.integration_version,row.host_id,row.node_id,row.mapping_revision],|r|r.get(0)).map_err(err)?;
    Ok(exists)
}
fn event(db: &Connection, row: &MetadataBinding, detail: &str) -> Result<()> {
    let related: Vec<_> = rows(db, &row.vault_id)?
        .into_iter()
        .filter(|r| r.job_id == row.job_id)
        .collect();
    let status = if related.iter().any(|r| r.status == "disabled") {
        "unknown"
    } else if related.iter().all(|r| r.status == "synced") {
        "completed"
    } else {
        "running"
    };
    let e = JournalEvent {
        action: None,
        id: Uuid::new_v4().to_string(),
        job_id: row.job_id.clone(),
        vault_id: row.vault_id.clone(),
        host_id: row.host_id.clone(),
        status: status.into(),
        detail: detail.into(),
    };
    db.execute(
        "INSERT INTO host_metadata_events(body) VALUES(?1)",
        [serde_json::to_string(&e).map_err(err)?],
    )
    .map_err(err)?;
    Ok(())
}
/// Directory changes share the durable, idempotent OperationJob outbox.
pub(crate) fn record_directory_edit(
    db: &Connection,
    vault: &str,
    host: &str,
    action: &str,
) -> Result<()> {
    initialize(db)?;
    let event = JournalEvent {
        action: Some(action.into()),
        id: Uuid::new_v4().to_string(),
        job_id: Uuid::new_v4().to_string(),
        vault_id: vault.into(),
        host_id: host.into(),
        status: "completed".into(),
        detail: "Host directory saved locally; existing credentials and history retained".into(),
    };
    db.execute(
        "INSERT INTO host_metadata_events(body) VALUES(?1)",
        [serde_json::to_string(&event).map_err(err)?],
    )
    .map_err(err)?;
    Ok(())
}
/// Notification intent shares the same transactional audit outbox and receipts.
pub(crate) fn record_rule_event(
    db: &Connection,
    vault: &str,
    host: &str,
    job: &str,
    status: &str,
    detail: &str,
) -> Result<()> {
    initialize(db)?;
    let event = JournalEvent {
        action: Some("host.notification-rule.update".into()),
        id: Uuid::new_v4().to_string(),
        job_id: job.into(),
        vault_id: vault.into(),
        host_id: host.into(),
        status: status.into(),
        detail: detail.into(),
    };
    db.execute(
        "INSERT INTO host_metadata_events(body) VALUES(?1)",
        [serde_json::to_string(&event).map_err(err)?],
    )
    .map_err(err)?;
    Ok(())
}

/// Called inside the host transaction, including device imports. A deleted
/// host disables its old queue; a newly reused ID cannot revive that queue.
pub(crate) fn hosts_changed(db: &Connection, vault: &str) -> Result<()> {
    hosts_changed_with_job(db, vault, None)
}
fn hosts_changed_with_job(
    db: &Connection,
    vault: &str,
    origin: Option<(&str, &str)>,
) -> Result<()> {
    initialize(db)?;
    let mut jobs = BTreeMap::new();
    if let Some((host, job)) = origin {
        jobs.insert(host.to_string(), job.to_string());
    }
    for mut row in rows(db, vault)? {
        if row.status == "disabled" {
            continue;
        }
        match host_metadata(db, vault, &row.host_id)? {
            None => {
                row.status = "disabled".into();
                row.error_code = Some("host-removed".into());
                save(db, &mut row)?;
                event(db, &row, "host-removed")?;
            }
            Some(values) if values != row.desired => {
                values.validate()?;
                // Preserve the prior intent and its audit before superseding it.
                if row.status != "synced" {
                    row.status = "disabled".into();
                    save(db, &mut row)?;
                    event(
                        db,
                        &row,
                        "superseded; remote outcome may require reconciliation",
                    )?;
                }
                row.desired = values;
                row.job_id = jobs
                    .entry(row.host_id.clone())
                    .or_insert_with(|| Uuid::new_v4().to_string())
                    .clone();
                row.status = "pending".into();
                row.attempts = 0;
                row.next_attempt_at = 0;
                row.error_code = None;
                row.conflicts.clear();
                save(db, &mut row)?;
                event(db, &row, "metadata edit queued")?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Three-way field merge. A missing baseline means initial differences need a
/// user decision. Device clocks never decide which side wins.
fn merge(base: Option<&Metadata>, local: &Metadata, remote: &Metadata) -> (Metadata, Vec<String>) {
    fn field<T: Clone + Eq>(
        base: Option<&T>,
        local: &T,
        remote: &T,
        key: &str,
        conflicts: &mut Vec<String>,
    ) -> T {
        if local == remote || base == Some(remote) {
            local.clone()
        } else if base == Some(local) {
            remote.clone()
        } else {
            conflicts.push(key.into());
            local.clone()
        }
    }
    let mut conflicts = vec![];
    let merged = Metadata {
        name: field(
            base.map(|v| &v.name),
            &local.name,
            &remote.name,
            "name",
            &mut conflicts,
        ),
        group: field(
            base.map(|v| &v.group),
            &local.group,
            &remote.group,
            "group",
            &mut conflicts,
        ),
        tags: field(
            base.map(|v| &v.tags),
            &local.tags,
            &remote.tags,
            "tags",
            &mut conflicts,
        ),
    };
    (merged, conflicts)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnableMetadata {
    pub session: u64,
    pub vault_id: String,
    pub host_id: String,
    pub integration_id: String,
    pub node_id: String,
    pub expected_mapping_revision: i64,
    pub expected_integration_version: i64,
    pub expected_endpoint: String,
    pub expected_host_updated_at: i64,
    pub remote: RemoteMetadata,
}
fn enable(db: &Connection, input: EnableMetadata) -> Result<MetadataBinding> {
    input.remote.values.validate()?;
    if input.remote.identity.is_empty() || input.remote.identity.len() > 160 {
        return Err("METADATA_INVALID_IDENTITY".into());
    }
    let current_at: i64 = db
        .query_row(
            "SELECT updated_at FROM workspace_hosts WHERE vault_id=?1 AND id=?2",
            params![input.vault_id, input.host_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if current_at != input.expected_host_updated_at {
        return Err("METADATA_STALE_EDIT".into());
    }
    let (endpoint,credential_ref,integration_version):(String,String,i64)=db.query_row("SELECT endpoint,credential_ref,updated_at FROM komari_integrations WHERE id=?1 AND vault_id=?2",params![input.integration_id,input.vault_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(err)?;
    if integration_version != input.expected_integration_version
        || endpoint != input.expected_endpoint
    {
        return Err("METADATA_SCOPE_CHANGED".into());
    }
    let old = rows(db, &input.vault_id)?
        .into_iter()
        .find(|r| r.host_id == input.host_id && r.integration_id == input.integration_id);
    if old.as_ref().is_some_and(|r| r.status != "disabled") {
        return Err("METADATA_ALREADY_ENABLED".into());
    }
    let desired =
        host_metadata(db, &input.vault_id, &input.host_id)?.ok_or("METADATA_HOST_REMOVED")?;
    desired.validate()?;
    let mut row = MetadataBinding {
        id: old
            .as_ref()
            .map(|r| r.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        vault_id: input.vault_id,
        host_id: input.host_id,
        integration_id: input.integration_id,
        node_id: input.node_id,
        endpoint,
        credential_ref,
        integration_version,
        mapping_revision: input.expected_mapping_revision,
        identity: input.remote.identity,
        baseline: None,
        desired,
        remote: input.remote.values,
        status: "pending".into(),
        version: old.map(|r| r.version).unwrap_or(0),
        attempts: 0,
        next_attempt_at: 0,
        error_code: None,
        conflicts: vec![],
        job_id: Uuid::new_v4().to_string(),
        updated_at: now_unix_ms(),
    };
    if !scope(db, &row)? {
        return Err("METADATA_SCOPE_CHANGED".into());
    }
    let (merged, conflicts) = merge(None, &row.desired, &row.remote);
    row.desired = merged;
    row.conflicts = conflicts;
    if row.conflicts.is_empty() {
        row.baseline = Some(row.remote.clone());
        row.status = "synced".into();
    } else {
        row.status = "conflict".into();
    }
    save(db, &mut row)?;
    event(db, &row, "metadata synchronization enabled")?;
    Ok(row)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataAction {
    pub session: u64,
    pub vault_id: String,
    pub id: String,
    pub expected_version: i64,
    pub action: String,
    pub remote: Option<RemoteMetadata>,
    pub choices: Option<BTreeMap<String, String>>,
    pub error_code: Option<String>,
}
fn action(db: &Connection, input: MetadataAction) -> Result<MetadataBinding> {
    let mut row = rows(db, &input.vault_id)?
        .into_iter()
        .find(|r| r.id == input.id)
        .ok_or("METADATA_NOT_FOUND")?;
    if row.version != input.expected_version {
        return Err("METADATA_STALE_EDIT".into());
    }
    if input.action == "disable" || !scope(db, &row)? {
        if row.status == "synced" {
            row.job_id = Uuid::new_v4().to_string();
        }
        row.status = "disabled".into();
        row.error_code = Some(
            if input.action == "disable" {
                "stopped-by-user"
            } else {
                "scope-changed"
            }
            .into(),
        );
        save(db, &mut row)?;
        event(
            db,
            &row,
            "sync disabled; sent requests may have completed remotely",
        )?;
        return Ok(row);
    }
    if row.status == "disabled" {
        return Err("METADATA_DISABLED".into());
    }
    // Local edits from old clients/imports must never be overwritten by a pull.
    if host_metadata(db, &row.vault_id, &row.host_id)?.as_ref() != Some(&row.desired) {
        return Err("METADATA_STALE_EDIT".into());
    }
    let before = row.desired.clone();
    let was_synced = row.status == "synced";
    let old_status = row.status.clone();
    match input.action.as_str() {
        "observe" => {
            let remote = input.remote.ok_or("METADATA_INVALID_OBSERVATION")?;
            remote.values.validate()?;
            if remote.identity != row.identity {
                row.status = "failed".into();
                row.error_code = Some("identity-changed".into());
            } else {
                let (desired, conflicts) =
                    merge(row.baseline.as_ref(), &row.desired, &remote.values);
                row.remote = remote.values;
                row.desired = desired;
                row.conflicts = conflicts;
                row.error_code = None;
                row.status = if !row.conflicts.is_empty() {
                    "conflict"
                } else if row.desired == row.remote {
                    "synced"
                } else {
                    "pending"
                }
                .into();
                if row.status == "synced" {
                    row.baseline = Some(row.remote.clone());
                    row.attempts = 0;
                }
                if row.status == "pending" && row.attempts >= 5 {
                    row.status = "failed".into();
                    row.error_code = Some("retry-exhausted".into());
                }
                row.next_attempt_at = now_unix_ms() + 60_000;
            }
        }
        "sending" => {
            if row.status != "pending" || row.attempts >= 5 {
                return Err("METADATA_NOT_READY".into());
            }
            row.status = "applying".into();
            row.attempts += 1;
            row.next_attempt_at = now_unix_ms() + 60_000;
        }
        "error" => {
            let code = input.error_code.unwrap_or_else(|| "unavailable".into());
            if ![
                "unavailable",
                "permission",
                "endpoint-version",
                "rate-limited",
                "identity-changed",
                "invalid-response",
                "readback-mismatch",
            ]
            .contains(&code.as_str())
            {
                return Err("METADATA_INVALID_ERROR".into());
            }
            // Read failures count too, so disconnected services cannot spin forever.
            if row.status != "applying" {
                row.attempts += 1;
            }
            row.status = if row.attempts >= 5
                || [
                    "permission",
                    "endpoint-version",
                    "identity-changed",
                    "invalid-response",
                ]
                .contains(&code.as_str())
            {
                "failed"
            } else {
                "retry"
            }
            .into();
            row.error_code = Some(code);
            row.next_attempt_at = now_unix_ms() + 30_000 * (1i64 << row.attempts.min(5));
        }
        "retry" => {
            if row.error_code.as_deref() == Some("identity-changed") {
                return Err("METADATA_REBIND_REQUIRED".into());
            }
            row.status = "pending".into();
            row.attempts = 0;
            row.next_attempt_at = 0;
            row.error_code = None;
        }
        "resolve" => {
            if row.status != "conflict" {
                return Err("METADATA_NOT_CONFLICTED".into());
            }
            let choices = input.choices.ok_or("METADATA_INVALID_CHOICES")?;
            if choices.len() != row.conflicts.len() {
                return Err("METADATA_INVALID_CHOICES".into());
            }
            for key in &row.conflicts {
                match choices.get(key).map(String::as_str) {
                    Some("remote") => match key.as_str() {
                        "name" => row.desired.name = row.remote.name.clone(),
                        "group" => row.desired.group = row.remote.group.clone(),
                        "tags" => row.desired.tags = row.remote.tags.clone(),
                        _ => return Err("METADATA_INVALID_CHOICES".into()),
                    },
                    Some("local") => {}
                    _ => return Err("METADATA_INVALID_CHOICES".into()),
                }
            }
            row.baseline = Some(row.remote.clone());
            row.conflicts.clear();
            row.status = "pending".into();
            row.attempts = 0;
            row.next_attempt_at = 0;
        }
        _ => return Err("METADATA_INVALID_ACTION".into()),
    }
    if before != row.desired {
        // An external edit after a completed operation gets its own logical job.
        if was_synced {
            row.job_id = Uuid::new_v4().to_string();
        }
        write_host(db, &row)?;
    }
    if before == row.desired && was_synced && row.status != "synced" {
        row.job_id = Uuid::new_v4().to_string();
    }
    save(db, &mut row)?;
    // Add every affected target before aggregating completion of this job.
    hosts_changed_with_job(db, &row.vault_id, Some((&row.host_id, &row.job_id)))?;
    if before != row.desired || old_status != row.status || input.action != "observe" {
        event(
            db,
            &row,
            &format!("metadata {}: {}", input.action, row.status),
        )?;
    }
    Ok(row)
}

/// Audit is an idempotent projection of the transactional outbox. A crash
/// between databases is repaired using immutable event receipts, never a new
/// OperationJob identity. A projection failure does not discard saved intent.
pub(crate) fn project(app: &tauri::AppHandle, db: &Connection) -> Result<()> {
    let mut audit =
        super::operation_jobs::open_database(&data_file_path(app, "operation_jobs.sqlite3")?)?;
    project_on(db, &mut audit)
}
fn project_on(db: &Connection, audit: &mut Connection) -> Result<()> {
    audit
        .execute_batch("CREATE TABLE IF NOT EXISTS host_metadata_receipts(id TEXT PRIMARY KEY)")
        .map_err(err)?;
    let mut stmt = db
        .prepare(
            "SELECT seq,body FROM host_metadata_events WHERE projected=0 ORDER BY seq LIMIT 500",
        )
        .map_err(err)?;
    let events = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    for (seq, body) in events {
        let e: JournalEvent = serde_json::from_str(&body).map_err(err)?;
        let directory = e
            .action
            .as_deref()
            .is_some_and(|action| action.starts_with("host.directory."));
        let rule = e.action.as_deref() == Some("host.notification-rule.update");
        let tx = audit.transaction().map_err(err)?;
        let done: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM host_metadata_receipts WHERE id=?1)",
                [&e.id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !done {
            use super::operation_jobs::*;
            if get_on(&tx, &e.job_id)?.is_none() {
                create_on_with_id(
                    &tx,
                    CreateOperationJobRequest {
                        host_id: Some(e.host_id.clone()),
                        vault_id: Some(e.vault_id),
                        host_name: None,
                        host_address: None,
                        username: None,
                        source: "workspace".into(),
                        actor: Some(
                            if directory {
                                "host-directory"
                            } else if rule {
                                "monitoring-rule"
                            } else {
                                "metadata-sync"
                            }
                            .into(),
                        ),
                        action: e
                            .action
                            .clone()
                            .unwrap_or_else(|| "host.metadata.sync".into()),
                        target: e.host_id,
                        risk: "low".into(),
                        provider: Some(
                            if directory {
                                "host-directory"
                            } else {
                                "komari"
                            }
                            .into(),
                        ),
                        transport: Some(if directory { "local" } else { "api" }.into()),
                        params_summary: Some(
                            if directory {
                                "Host directory; no credential values"
                            } else if rule {
                                "Offline rule: enabled, grace period; no credential values"
                            } else {
                                "Shared fields: name, group, tags"
                            }
                            .into(),
                        ),
                        confirmation_required: false,
                        request_id: Some(e.job_id.clone()),
                    },
                    &e.job_id,
                )?;
            }
            let current = get_on(&tx, &e.job_id)?.ok_or("METADATA_AUDIT_FAILED")?;
            if ["queued", "running"].contains(&current.status.as_str()) {
                let update = |status: &str| UpdateOperationJobRequest {
                    job_id: e.job_id.clone(),
                    status: status.into(),
                    confirmation_status: None,
                    confirmed_by: None,
                    result_summary: Some(e.detail.clone()),
                    error_code: None,
                    error_summary: None,
                    actor: Some(
                        if directory {
                            "host-directory"
                        } else if rule {
                            "monitoring-rule"
                        } else {
                            "metadata-sync"
                        }
                        .into(),
                    ),
                };
                if current.status == "queued" {
                    update_on(&tx, update("running"))?;
                }
                update_on(&tx, update(&e.status))?;
            }
            tx.execute("INSERT INTO host_metadata_receipts(id) VALUES(?1)", [&e.id])
                .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        db.execute(
            "UPDATE host_metadata_events SET projected=1 WHERE seq=?1",
            [seq],
        )
        .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_host_metadata_sync(
    app: tauri::AppHandle,
    vault_id: String,
) -> Result<Vec<MetadataBinding>> {
    let state = app.state::<VaultState>();
    state.while_unlocked(&vault_id, || {
        let mut db = open(&app)?;
        let tx = db.transaction().map_err(err)?;
        for mut row in rows(&tx, &vault_id)? {
            if row.status != "disabled" && !scope(&tx, &row)? {
                if row.status == "synced" {
                    row.job_id = Uuid::new_v4().to_string();
                }
                row.status = "disabled".into();
                row.error_code = Some("scope-changed".into());
                save(&tx, &mut row)?;
                event(&tx, &row, "binding scope invalidated")?;
            }
        }
        hosts_changed(&tx, &vault_id)?;
        tx.commit().map_err(err)?;
        project(&app, &db)?;
        rows(&db, &vault_id)
    })
}
#[tauri::command]
pub fn enable_host_metadata_sync(
    app: tauri::AppHandle,
    input: EnableMetadata,
) -> Result<MetadataBinding> {
    let vault = input.vault_id.clone();
    let state = app.state::<VaultState>();
    state.while_unlocked(&vault, || {
        if state.session_generation() != input.session {
            return Err("METADATA_SESSION_CHANGED".into());
        }
        let mut db = open(&app)?;
        let tx = db.transaction().map_err(err)?;
        let row = enable(&tx, input)?;
        tx.commit().map_err(err)?;
        Ok(row)
    })
}
#[tauri::command]
pub fn host_metadata_sync_action(
    app: tauri::AppHandle,
    input: MetadataAction,
) -> Result<MetadataBinding> {
    let vault = input.vault_id.clone();
    let state = app.state::<VaultState>();
    state.while_unlocked(&vault, || {
        if state.session_generation() != input.session {
            return Err("METADATA_SESSION_CHANGED".into());
        }
        let mut db = open(&app)?;
        let tx = db.transaction().map_err(err)?;
        let row = action(&tx, input)?;
        tx.commit().map_err(err)?;
        Ok(row)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn values(name: &str, group: &str) -> Metadata {
        Metadata {
            name: name.into(),
            group: group.into(),
            tags: vec!["web".into()],
        }
    }
    fn setup() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE workspace_hosts(vault_id TEXT,id TEXT,name TEXT,host_group TEXT,tags_json TEXT,updated_at INTEGER,password_key_ref TEXT,PRIMARY KEY(vault_id,id));
          INSERT INTO workspace_hosts VALUES('v','h','WEB','prod','[\"web\"]',1,'keep-secret-ref'),('other','h','OTHER','dev','[]',1,'other-ref');
          CREATE TABLE komari_integrations(id TEXT PRIMARY KEY,vault_id TEXT,endpoint TEXT,credential_ref TEXT,updated_at INTEGER,enabled INTEGER);
          INSERT INTO komari_integrations VALUES('i','v','https://monitor.example','keep-api-ref',1,1);
          CREATE TABLE komari_mappings(integration_id TEXT,host_id TEXT,node_id TEXT);
          INSERT INTO komari_mappings VALUES('i','h','node');
          CREATE TABLE komari_mapping_revisions(integration_id TEXT,revision INTEGER);
          INSERT INTO komari_mapping_revisions VALUES('i',1);").unwrap();
        initialize(&db).unwrap();
        db
    }
    fn enabled(db: &mut Connection, remote: Metadata) -> MetadataBinding {
        let tx = db.transaction().unwrap();
        let row = enable(
            &tx,
            EnableMetadata {
                session: 0,
                vault_id: "v".into(),
                host_id: "h".into(),
                integration_id: "i".into(),
                node_id: "node".into(),
                expected_mapping_revision: 1,
                expected_integration_version: 1,
                expected_endpoint: "https://monitor.example".into(),
                expected_host_updated_at: 1,
                remote: RemoteMetadata {
                    identity: "node:created".into(),
                    values: remote,
                },
            },
        )
        .unwrap();
        tx.commit().unwrap();
        row
    }
    fn perform(
        db: &mut Connection,
        row: &MetadataBinding,
        kind: &str,
        remote: Option<Metadata>,
    ) -> MetadataBinding {
        let tx = db.transaction().unwrap();
        let result = action(
            &tx,
            MetadataAction {
                session: 0,
                vault_id: "v".into(),
                id: row.id.clone(),
                expected_version: row.version,
                action: kind.into(),
                remote: remote.map(|values| RemoteMetadata {
                    identity: "node:created".into(),
                    values,
                }),
                choices: None,
                error_code: if kind == "error" {
                    Some("unavailable".into())
                } else {
                    None
                },
            },
        )
        .unwrap();
        tx.commit().unwrap();
        result
    }
    fn edit(db: &mut Connection, name: &str) -> MetadataBinding {
        let tx = db.transaction().unwrap();
        begin_host_write(&tx, "v").unwrap();
        tx.execute(
            "UPDATE workspace_hosts SET name=?1 WHERE vault_id='v' AND id='h'",
            [name],
        )
        .unwrap();
        hosts_changed(&tx, "v").unwrap();
        end_host_write(&tx, "v").unwrap();
        tx.commit().unwrap();
        rows(db, "v").unwrap().remove(0)
    }
    #[test]
    fn merges_disjoint_fields_without_using_clock_and_detects_overlapping_edits() {
        let base = values("WEB", "prod");
        let local = values("WEB renamed", "prod");
        let remote = values("WEB", "staging");
        assert_eq!(
            merge(Some(&base), &local, &remote),
            (values("WEB renamed", "staging"), vec![])
        );
        assert_eq!(
            merge(Some(&base), &local, &values("remote name", "prod")).1,
            vec!["name"]
        );
        assert_eq!(merge(None, &local, &base).1, vec!["name"]);
    }
    #[test]
    fn enable_never_overwrites_initial_differences_and_preserves_credentials() {
        let mut db = setup();
        let row = enabled(&mut db, values("server name", "prod"));
        assert_eq!(row.status, "conflict");
        assert!(row.baseline.is_none());
        assert_eq!(host_metadata(&db, "v", "h").unwrap().unwrap().name, "WEB");
        let secret: String = db
            .query_row(
                "SELECT password_key_ref FROM workspace_hosts WHERE vault_id='v'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(secret, "keep-secret-ref");
        assert!(!serde_json::to_string(&row)
            .unwrap()
            .contains("keep-secret-ref"));
    }
    #[test]
    fn host_edit_and_intent_rollback_together_and_older_clients_cannot_bypass_queue() {
        let mut db = setup();
        enabled(&mut db, values("WEB", "prod"));
        assert!(db
            .execute(
                "UPDATE workspace_hosts SET name='old client' WHERE vault_id='v'",
                []
            )
            .is_err());
        assert!(db
            .execute("DELETE FROM workspace_hosts WHERE vault_id='v'", [])
            .is_err());
        {
            let tx = db.transaction().unwrap();
            begin_host_write(&tx, "v").unwrap();
            tx.execute(
                "UPDATE workspace_hosts SET name='rolled back' WHERE vault_id='v'",
                [],
            )
            .unwrap();
            hosts_changed(&tx, "v").unwrap();
        }
        assert_eq!(host_metadata(&db, "v", "h").unwrap().unwrap().name, "WEB");
        assert_eq!(rows(&db, "v").unwrap()[0].desired.name, "WEB");
        assert_eq!(edit(&mut db, "new name").status, "pending");
    }
    #[test]
    fn response_loss_recovers_by_observing_desired_value_without_new_job() {
        let mut db = setup();
        enabled(&mut db, values("WEB", "prod"));
        let row = edit(&mut db, "renamed");
        let id = row.job_id.clone();
        let row = perform(&mut db, &row, "observe", Some(values("WEB", "prod")));
        let row = perform(&mut db, &row, "sending", None);
        // Rehydrate durable applying state as a restarted process would.
        let hydrated: MetadataBinding =
            serde_json::from_str(&serde_json::to_string(&row).unwrap()).unwrap();
        let row = perform(
            &mut db,
            &hydrated,
            "observe",
            Some(values("renamed", "prod")),
        );
        assert_eq!(row.status, "synced");
        assert_eq!(row.job_id, id);
        assert_eq!(row.attempts, 0);
    }
    #[test]
    fn remote_edit_updates_same_host_and_never_touches_another_vault() {
        let mut db = setup();
        let row = enabled(&mut db, values("WEB", "prod"));
        let old_job = row.job_id.clone();
        let row = perform(&mut db, &row, "observe", Some(values("external", "dev")));
        assert_eq!(row.status, "synced");
        assert_ne!(row.job_id, old_job);
        assert_eq!(
            host_metadata(&db, "v", "h").unwrap().unwrap(),
            values("external", "dev")
        );
        assert_eq!(
            host_metadata(&db, "other", "h").unwrap().unwrap().name,
            "OTHER"
        );
    }
    #[test]
    fn conflict_resolution_is_cas_and_rechecks_later_external_edits() {
        let mut db = setup();
        enabled(&mut db, values("WEB", "prod"));
        let row = edit(&mut db, "mine");
        let row = perform(&mut db, &row, "observe", Some(values("theirs", "prod")));
        assert_eq!(row.conflicts, vec!["name"]);
        let tx = db.transaction().unwrap();
        let resolved = action(
            &tx,
            MetadataAction {
                session: 0,
                vault_id: "v".into(),
                id: row.id.clone(),
                expected_version: row.version,
                action: "resolve".into(),
                remote: None,
                choices: Some(BTreeMap::from([("name".into(), "local".into())])),
                error_code: None,
            },
        )
        .unwrap();
        tx.commit().unwrap();
        let row = perform(
            &mut db,
            &resolved,
            "observe",
            Some(values("third edit", "prod")),
        );
        assert_eq!(row.status, "conflict");
        assert_eq!(row.desired.name, "mine");
        let tx = db.transaction().unwrap();
        assert_eq!(
            action(
                &tx,
                MetadataAction {
                    session: 0,
                    vault_id: "v".into(),
                    id: row.id,
                    expected_version: resolved.version,
                    action: "sending".into(),
                    remote: None,
                    choices: None,
                    error_code: None
                }
            )
            .unwrap_err(),
            "METADATA_STALE_EDIT"
        );
    }
    #[test]
    fn changed_mapping_or_endpoint_blocks_pending_writes() {
        for sql in [
            "DELETE FROM komari_mappings",
            "UPDATE komari_mapping_revisions SET revision=3",
            "UPDATE komari_integrations SET endpoint='https://different.example'",
        ] {
            let mut db = setup();
            enabled(&mut db, values("WEB", "prod"));
            let row = edit(&mut db, "queued");
            db.execute(sql, []).unwrap();
            let row = perform(&mut db, &row, "sending", None);
            assert_eq!(row.status, "disabled");
            assert_eq!(row.attempts, 0);
        }
    }
    #[test]
    fn retries_are_bounded_and_manual_retry_keeps_operation_identity() {
        let mut db = setup();
        let mut row = enabled(&mut db, values("WEB", "prod"));
        for _ in 0..5 {
            row = perform(&mut db, &row, "error", None);
        }
        assert_eq!(row.status, "failed");
        let job = row.job_id.clone();
        let row = perform(&mut db, &row, "retry", None);
        assert_eq!(row.job_id, job);
        assert_eq!(row.attempts, 0);
    }
    #[test]
    fn directory_edit_projects_once_and_retains_existing_sync_audit() {
        let mut db = setup();
        enabled(&mut db, values("WEB", "prod"));
        record_directory_edit(&db, "v", "h", "host.directory.edit").unwrap();
        let path = std::env::temp_dir().join(format!(
            "shellbeam-directory-audit-{}.sqlite",
            Uuid::new_v4()
        ));
        let mut audit = super::super::operation_jobs::open_database(&path).unwrap();
        project_on(&db, &mut audit).unwrap();
        let count: i64 = audit
            .query_row("SELECT count(*) FROM operation_audit", [], |r| r.get(0))
            .unwrap();
        let row: (String, String, String, String) = audit.query_row("SELECT status,provider,transport,actor FROM operation_jobs WHERE action='host.directory.edit'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(
            row,
            (
                "completed".into(),
                "host-directory".into(),
                "local".into(),
                "host-directory".into()
            )
        );
        let sync_count: i64 = audit
            .query_row(
                "SELECT count(*) FROM operation_jobs WHERE action='host.metadata.sync'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sync_count, 1);
        db.execute("UPDATE host_metadata_events SET projected=0", [])
            .unwrap();
        project_on(&db, &mut audit).unwrap();
        let after: i64 = audit
            .query_row("SELECT count(*) FROM operation_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, after);
        drop(audit);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn audit_projection_replays_once_after_cross_database_crash() {
        let mut db = setup();
        enabled(&mut db, values("WEB", "prod"));
        let row = edit(&mut db, "new name");
        let path = std::env::temp_dir().join(format!(
            "shellbeam-metadata-audit-{}.sqlite",
            Uuid::new_v4()
        ));
        let mut audit = super::super::operation_jobs::open_database(&path).unwrap();
        project_on(&db, &mut audit).unwrap();
        let count: i64 = audit
            .query_row("SELECT count(*) FROM operation_audit", [], |r| r.get(0))
            .unwrap();
        db.execute("UPDATE host_metadata_events SET projected=0", [])
            .unwrap();
        project_on(&db, &mut audit).unwrap();
        let count2: i64 = audit
            .query_row("SELECT count(*) FROM operation_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, count2);
        let row = perform(&mut db, &row, "observe", Some(values("new name", "prod")));
        project_on(&db, &mut audit).unwrap();
        assert_eq!(
            super::super::operation_jobs::get_on(&audit, &row.job_id)
                .unwrap()
                .unwrap()
                .status,
            "completed"
        );
        drop(audit);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn notification_rule_audit_is_recoverable_and_projected_once() {
        let db = setup();
        record_rule_event(
            &db,
            "v",
            "h",
            "rule-job",
            "running",
            "Offline rule pending; no delivery claim",
        )
        .unwrap();
        let path =
            std::env::temp_dir().join(format!("shellbeam-rule-audit-{}.sqlite", Uuid::new_v4()));
        let mut audit = super::super::operation_jobs::open_database(&path).unwrap();
        project_on(&db, &mut audit).unwrap();
        let job = super::super::operation_jobs::get_on(&audit, "rule-job")
            .unwrap()
            .unwrap();
        assert_eq!(job.action, "host.notification-rule.update");
        assert_eq!(job.actor, "monitoring-rule");
        assert_eq!(job.provider, "komari");
        assert_eq!(job.status, "running");
        let before: i64 = audit
            .query_row("SELECT count(*) FROM operation_audit", [], |r| r.get(0))
            .unwrap();
        drop(audit);
        let mut audit = super::super::operation_jobs::open_database(&path).unwrap();
        db.execute("UPDATE host_metadata_events SET projected=0", [])
            .unwrap();
        project_on(&db, &mut audit).unwrap();
        let after: i64 = audit
            .query_row("SELECT count(*) FROM operation_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
        record_rule_event(
            &db,
            "v",
            "h",
            "rule-job",
            "completed",
            "Offline rule read back; no delivery claim",
        )
        .unwrap();
        project_on(&db, &mut audit).unwrap();
        let job = super::super::operation_jobs::get_on(&audit, "rule-job")
            .unwrap()
            .unwrap();
        assert_eq!(job.status, "completed");
        assert_eq!(
            job.result_summary.as_deref(),
            Some("Offline rule read back; no delivery claim")
        );
        let wrong_actor: i64 = audit
            .query_row(
                "SELECT count(*) FROM operation_audit WHERE actor != 'monitoring-rule'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(wrong_actor, 0);
        drop(audit);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejected_enable_cannot_attach_observation_from_a_previous_endpoint() {
        let mut db = setup();
        db.execute(
            "UPDATE komari_integrations SET endpoint='https://replacement.example',updated_at=2",
            [],
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        let input = serde_json::from_value(serde_json::json!({
            "session": 0, "vaultId": "v", "hostId": "h", "integrationId": "i", "nodeId": "node",
            "expectedMappingRevision": 1, "expectedIntegrationVersion": 1,
            "expectedEndpoint": "https://monitor.example", "expectedHostUpdatedAt": 1,
            "remote": { "identity": "node:created", "values": values("WEB", "prod") }
        }))
        .unwrap();
        assert_eq!(enable(&tx, input).unwrap_err(), "METADATA_SCOPE_CHANGED");
        assert!(rows(&tx, "v").unwrap().is_empty());
    }

    #[test]
    fn disk_restart_recovers_final_interrupted_attempt_without_an_infinite_pending_loop() {
        let mut db = setup();
        enabled(&mut db, values("WEB", "prod"));
        let mut row = edit(&mut db, "new name");
        for attempt in 1..=5 {
            row = perform(&mut db, &row, "observe", Some(values("WEB", "prod")));
            row = perform(&mut db, &row, "sending", None);
            if attempt < 5 {
                row = perform(&mut db, &row, "error", None);
            }
        }
        let path = std::env::temp_dir().join(format!("metadata-restart-{}.sqlite", Uuid::new_v4()));
        db.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        drop(db);
        let mut reopened = Connection::open(&path).unwrap();
        let recovered = rows(&reopened, "v").unwrap().remove(0);
        assert_eq!(recovered.status, "applying");
        assert_eq!(recovered.job_id, row.job_id);
        let failed = perform(
            &mut reopened,
            &recovered,
            "observe",
            Some(values("WEB", "prod")),
        );
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error_code.as_deref(), Some("retry-exhausted"));
        // A later verified response still completes the same durable operation.
        let verified = perform(
            &mut reopened,
            &failed,
            "observe",
            Some(values("new name", "prod")),
        );
        assert_eq!(verified.status, "synced");
        assert_eq!(verified.job_id, row.job_id);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn deleting_and_reusing_a_host_id_does_not_revive_a_write_authorization() {
        let mut db = setup();
        enabled(&mut db, values("WEB", "prod"));
        let old = edit(&mut db, "new name");
        let tx = db.transaction().unwrap();
        begin_host_write(&tx, "v").unwrap();
        tx.execute("DELETE FROM workspace_hosts WHERE vault_id='v'", [])
            .unwrap();
        hosts_changed(&tx, "v").unwrap();
        tx.execute("INSERT INTO workspace_hosts VALUES('v','h','replacement','prod','[]',2,'replacement-ref')", []).unwrap();
        hosts_changed(&tx, "v").unwrap();
        end_host_write(&tx, "v").unwrap();
        tx.commit().unwrap();
        let row = rows(&db, "v").unwrap().remove(0);
        assert_eq!(row.status, "disabled");
        assert_eq!(row.job_id, old.job_id);
        assert_eq!(row.error_code.as_deref(), Some("host-removed"));
    }

    #[test]
    fn all_enabled_targets_share_one_job_and_partial_success_cannot_complete_it() {
        let mut db = setup();
        let first = enabled(&mut db, values("WEB", "prod"));
        db.execute_batch("INSERT INTO komari_integrations VALUES('i2','v','https://monitor.example','keep-api-ref',1,1);
          INSERT INTO komari_mappings VALUES('i2','h','node'); INSERT INTO komari_mapping_revisions VALUES('i2',1);").unwrap();
        let mut second = first.clone();
        second.id = "second-binding".into();
        second.integration_id = "i2".into();
        save(&db, &mut second).unwrap();
        let first = perform(&mut db, &first, "observe", Some(values("external", "prod")));
        let second = rows(&db, "v")
            .unwrap()
            .into_iter()
            .find(|r| r.id == second.id)
            .unwrap();
        assert_eq!(first.job_id, second.job_id);
        assert_eq!(second.status, "pending");
        let status = || {
            db.query_row("SELECT json_extract(body,'$.status') FROM host_metadata_events ORDER BY seq DESC LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap()
        };
        assert_eq!(status(), "running");
        let second = perform(&mut db, &second, "error", None);
        assert_eq!(second.job_id, first.job_id);
        perform(
            &mut db,
            &second,
            "observe",
            Some(values("external", "prod")),
        );
        let result: String = db.query_row("SELECT json_extract(body,'$.status') FROM host_metadata_events ORDER BY seq DESC LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(result, "completed");
    }
}

#[tauri::command]
pub fn host_metadata_session(app: tauri::AppHandle, vault_id: String) -> Result<u64> {
    let state = app.state::<VaultState>();
    state.while_unlocked(&vault_id, || Ok(state.session_generation()))
}
