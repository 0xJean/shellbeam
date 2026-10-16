//! Local lifecycle state for the optional ShellBeam resident probe.
//!
//! This module deliberately stores observations about an agent, rather than
//! credentials, commands, or command output.  Installing or removing an
//! agent is still an explicit OperationJob in the web layer; this database is
//! only the durable state used by the host list and probe provider.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::to_string;

use crate::storage::{data_file_path, now_unix_ms};

const AGENT_DB: &str = "workspace_inventory.sqlite3";
const MAX_ID_LEN: usize = 240;
const MAX_TEXT_LEN: usize = 512;
const MAX_CAPABILITIES: usize = 32;
const MAX_CAPABILITY_LEN: usize = 96;
const MAX_CAPABILITIES_JSON_BYTES: usize = 16 * 1024;
const MAX_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_AGENT_ID: &str = "shellbeam-agent";
const DEFAULT_PROVIDER_KIND: &str = "shellbeam-agent";
const DEFAULT_SOURCE: &str = "shellbeam-agent";
const DEFAULT_TRANSPORT: &str = "direct";
const DEFAULT_HEALTH: &str = "unknown";
const DEFAULT_HEARTBEAT_TTL_MS: i64 = 5 * 60 * 1000;

/// Durable state for one optional resident probe on one host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellbeamAgentRecord {
    pub vault_id: String,
    pub host_id: String,
    pub agent_id: String,
    pub provider_kind: String,
    pub source: String,
    pub status: String,
    pub health: String,
    pub version: Option<String>,
    pub capabilities: Vec<String>,
    pub install_path: Option<String>,
    pub service_name: Option<String>,
    pub heartbeat_ttl_ms: i64,
    pub last_heartbeat_at: Option<i64>,
    pub last_checked_at: i64,
    pub installed_at: Option<i64>,
    pub updated_at: i64,
    pub last_error_code: Option<String>,
    pub last_error: Option<String>,
    pub transport: String,
}

/// Input used when the app learns or changes an agent's lifecycle state.
///
/// `updated_at` and default values are generated locally.  Callers can send
/// an optional agent id while the agent is not installed; it is normalized to
/// the stable default id so a host still has one deterministic record.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellbeamAgentInput {
    pub vault_id: String,
    pub host_id: String,
    #[serde(alias = "nodeId")]
    pub agent_id: Option<String>,
    pub provider_kind: Option<String>,
    pub source: Option<String>,
    pub status: String,
    pub health: Option<String>,
    pub version: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub install_path: Option<String>,
    pub service_name: Option<String>,
    pub heartbeat_ttl_ms: Option<i64>,
    #[serde(alias = "lastHeartbeat")]
    pub last_heartbeat_at: Option<i64>,
    #[serde(alias = "checkedAt")]
    pub last_checked_at: Option<i64>,
    pub installed_at: Option<i64>,
    #[serde(alias = "errorCode")]
    pub last_error_code: Option<String>,
    #[serde(alias = "errorSummary")]
    pub last_error: Option<String>,
    pub transport: Option<String>,
}

/// A heartbeat intentionally has no command or output field.  It can update
/// only observation metadata and leaves install paths and lifecycle metadata
/// from an existing record intact.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellbeamAgentHeartbeatInput {
    pub vault_id: String,
    pub host_id: String,
    #[serde(alias = "nodeId")]
    pub agent_id: Option<String>,
    pub provider_kind: Option<String>,
    pub source: Option<String>,
    pub status: Option<String>,
    pub health: Option<String>,
    pub version: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub heartbeat_ttl_ms: Option<i64>,
    #[serde(
        alias = "lastHeartbeat",
        alias = "lastHeartbeatAt",
        alias = "heartbeatAt"
    )]
    pub heartbeat_at: Option<i64>,
    #[serde(alias = "lastCheckedAt", alias = "checkedAt")]
    pub checked_at: Option<i64>,
    #[serde(alias = "errorCode", alias = "lastErrorCode")]
    pub last_error_code: Option<String>,
    #[serde(alias = "errorSummary", alias = "lastError")]
    pub last_error: Option<String>,
    pub transport: Option<String>,
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(data_file_path(app, AGENT_DB)?)
        .map_err(|err| format!("Open ShellBeam agent db failed: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| format!("Configure ShellBeam agent db failed: {err}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS shellbeam_agents (
          vault_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          provider_kind TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          health TEXT NOT NULL,
          version TEXT,
          capabilities_json TEXT NOT NULL,
          install_path TEXT,
          service_name TEXT,
          heartbeat_ttl_ms INTEGER NOT NULL,
          last_heartbeat_at INTEGER,
          last_checked_at INTEGER NOT NULL,
          installed_at INTEGER,
          updated_at INTEGER NOT NULL,
          last_error_code TEXT,
          last_error TEXT,
          transport TEXT NOT NULL,
          PRIMARY KEY (vault_id, host_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_shellbeam_agents_vault_updated_at
          ON shellbeam_agents(vault_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_shellbeam_agents_host_updated_at
          ON shellbeam_agents(host_id, updated_at DESC);
        "#,
    )
    .map_err(|err| format!("Initialize ShellBeam agent db failed: {err}"))?;
    Ok(conn)
}

fn normalize_text(value: &str, field: &str, max_len: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("ShellBeam agent {field} is required"));
    }
    if value.len() > max_len || value.chars().any(char::is_control) {
        return Err(format!("ShellBeam agent {field} is invalid"));
    }
    Ok(value.to_string())
}

fn normalize_id(value: &str, field: &str) -> Result<String, String> {
    normalize_text(value, field, MAX_ID_LEN)
}

fn normalize_optional_text(
    value: Option<&str>,
    field: &str,
    max_len: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| normalize_text(value, field, max_len))
        .transpose()
}

fn normalize_agent_id(value: Option<&str>) -> Result<String, String> {
    value
        .map(|value| normalize_id(value, "agent id"))
        .transpose()?
        .map_or_else(|| Ok(DEFAULT_AGENT_ID.to_string()), Ok)
}

fn normalize_status(value: &str) -> Result<String, String> {
    let value = normalize_text(value, "status", 32)?;
    if !matches!(
        value.as_str(),
        "uninstalled"
            | "not_installed"
            | "not-installed"
            | "installing"
            | "installed"
            | "upgrading"
            | "uninstalling"
            | "offline"
            | "failed"
            | "unknown"
            | "unsupported"
            | "retired"
    ) {
        return Err("ShellBeam agent status is unsupported".into());
    }
    Ok(value)
}

fn normalize_health(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or(DEFAULT_HEALTH);
    let value = normalize_text(value, "health", 32)?;
    if !matches!(
        value.as_str(),
        "online" | "stale" | "offline" | "paused" | "unsupported" | "unknown"
    ) {
        return Err("ShellBeam agent health is unsupported".into());
    }
    Ok(value)
}

fn normalize_provider(value: Option<&str>, field: &str, default: &str) -> Result<String, String> {
    let value = value.unwrap_or(default);
    let value = normalize_text(value, field, 64)?;
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
    {
        return Err(format!("ShellBeam agent {field} is invalid"));
    }
    Ok(value)
}

fn normalize_transport(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or(DEFAULT_TRANSPORT);
    let value = normalize_text(value, "transport", 32)?;
    if !matches!(value.as_str(), "direct" | "proxy-jump") {
        return Err("ShellBeam agent transport is unsupported".into());
    }
    Ok(value)
}

fn normalize_timestamp(value: Option<i64>, field: &str, fallback: i64) -> Result<i64, String> {
    let value = value.unwrap_or(fallback);
    if !(0..=i64::MAX / 2).contains(&value) {
        return Err(format!("ShellBeam agent {field} is invalid"));
    }
    Ok(value)
}

fn normalize_optional_timestamp(value: Option<i64>, field: &str) -> Result<Option<i64>, String> {
    value
        .map(|value| normalize_timestamp(Some(value), field, 0))
        .transpose()
}

fn normalize_ttl(value: Option<i64>) -> Result<i64, String> {
    let ttl = value.unwrap_or(DEFAULT_HEARTBEAT_TTL_MS);
    if !(1..=MAX_TTL_MS).contains(&ttl) {
        return Err("ShellBeam agent heartbeat TTL is invalid".into());
    }
    Ok(ttl)
}

fn normalize_capabilities(value: Option<&[String]>) -> Result<Vec<String>, String> {
    let mut capabilities = Vec::new();
    for item in value.unwrap_or(&[]) {
        let item = normalize_text(item, "capability", MAX_CAPABILITY_LEN)?;
        if !capabilities.iter().any(|known| known == &item) {
            capabilities.push(item);
        }
        if capabilities.len() > MAX_CAPABILITIES {
            return Err("ShellBeam agent capabilities are too many".into());
        }
    }
    let encoded = to_string(&capabilities)
        .map_err(|err| format!("Serialize ShellBeam agent capabilities failed: {err}"))?;
    if encoded.len() > MAX_CAPABILITIES_JSON_BYTES {
        return Err("ShellBeam agent capabilities are too large".into());
    }
    Ok(capabilities)
}

fn merged_heartbeat_health(
    health: Option<&str>,
    status: Option<&str>,
    existing_health: Option<&str>,
) -> Option<String> {
    if let Some(health) = health {
        return Some(health.to_string());
    }
    match status {
        Some("installed") => Some("online".to_string()),
        Some("offline") => Some("offline".to_string()),
        _ => existing_health.map(str::to_string),
    }
}

fn redact_summary(value: Option<&str>, field: &str) -> Result<Option<String>, String> {
    let value = match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value,
        None => return Ok(None),
    };
    if value.chars().any(|ch| ch.is_control() && ch != '\t') {
        return Err(format!("ShellBeam agent {field} is invalid"));
    }
    let mut parts = Vec::new();
    let mut redact_next = false;
    for part in value.split_whitespace() {
        let lower = part.to_ascii_lowercase();
        let sensitive = [
            "password",
            "passwd",
            "private_key",
            "private-key",
            "secret",
            "token",
            "credential",
            "authorization",
            "bearer",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
        if redact_next {
            parts.push("<redacted>".to_string());
            redact_next = false;
        } else if sensitive {
            parts.push("<redacted>".to_string());
        } else {
            parts.push(part.to_string());
        }
        if sensitive && !part.contains('=') {
            redact_next = true;
        }
    }
    let mut value = parts.join(" ");
    if value.len() > MAX_TEXT_LEN {
        value.truncate(MAX_TEXT_LEN);
        value.push('…');
    }
    Ok(Some(value))
}

fn validate_input(input: &ShellbeamAgentInput) -> Result<NormalizedAgent, String> {
    let now = now_unix_ms();
    let vault_id = normalize_id(&input.vault_id, "vault id")?;
    let host_id = normalize_id(&input.host_id, "host id")?;
    let agent_id = normalize_agent_id(input.agent_id.as_deref())?;
    let provider_kind = normalize_provider(
        input.provider_kind.as_deref(),
        "provider kind",
        DEFAULT_PROVIDER_KIND,
    )?;
    let source = normalize_provider(input.source.as_deref(), "source", DEFAULT_SOURCE)?;
    let status = normalize_status(&input.status)?;
    let health = normalize_health(input.health.as_deref())?;
    let version = normalize_optional_text(input.version.as_deref(), "version", MAX_TEXT_LEN)?;
    let capabilities = normalize_capabilities(input.capabilities.as_deref())?;
    let install_path =
        normalize_optional_text(input.install_path.as_deref(), "install path", MAX_TEXT_LEN)?;
    let service_name =
        normalize_optional_text(input.service_name.as_deref(), "service name", MAX_TEXT_LEN)?;
    let heartbeat_ttl_ms = normalize_ttl(input.heartbeat_ttl_ms)?;
    let last_heartbeat_at = normalize_optional_timestamp(input.last_heartbeat_at, "heartbeat")?;
    let last_checked_at = normalize_timestamp(input.last_checked_at, "checked timestamp", now)?;
    let installed_at = normalize_optional_timestamp(input.installed_at, "installed timestamp")?;
    let last_error_code =
        normalize_optional_text(input.last_error_code.as_deref(), "error code", 96)?;
    let last_error = redact_summary(input.last_error.as_deref(), "error")?;
    let transport = normalize_transport(input.transport.as_deref())?;
    Ok(NormalizedAgent {
        vault_id,
        host_id,
        agent_id,
        provider_kind,
        source,
        status,
        health,
        version,
        capabilities,
        install_path,
        service_name,
        heartbeat_ttl_ms,
        last_heartbeat_at,
        last_checked_at,
        installed_at,
        updated_at: now,
        last_error_code,
        last_error,
        transport,
    })
}

#[derive(Debug)]
struct NormalizedAgent {
    vault_id: String,
    host_id: String,
    agent_id: String,
    provider_kind: String,
    source: String,
    status: String,
    health: String,
    version: Option<String>,
    capabilities: Vec<String>,
    install_path: Option<String>,
    service_name: Option<String>,
    heartbeat_ttl_ms: i64,
    last_heartbeat_at: Option<i64>,
    last_checked_at: i64,
    installed_at: Option<i64>,
    updated_at: i64,
    last_error_code: Option<String>,
    last_error: Option<String>,
    transport: String,
}

fn read_record(row: &Row<'_>) -> rusqlite::Result<ShellbeamAgentRecord> {
    let raw: String = row.get(9)?;
    let capabilities = serde_json::from_str::<Vec<String>>(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(err))
    })?;
    Ok(ShellbeamAgentRecord {
        vault_id: row.get(0)?,
        host_id: row.get(1)?,
        agent_id: row.get(2)?,
        provider_kind: row.get(3)?,
        source: row.get(4)?,
        status: row.get(5)?,
        health: row.get(6)?,
        version: row.get(7)?,
        capabilities,
        install_path: row.get(8)?,
        service_name: row.get(10)?,
        heartbeat_ttl_ms: row.get(11)?,
        last_heartbeat_at: row.get(12)?,
        last_checked_at: row.get(13)?,
        installed_at: row.get(14)?,
        updated_at: row.get(15)?,
        last_error_code: row.get(16)?,
        last_error: row.get(17)?,
        transport: row.get(18)?,
    })
}

const RECORD_COLUMNS: &str = "vault_id,host_id,agent_id,provider_kind,source,status,health,version,install_path,capabilities_json,service_name,heartbeat_ttl_ms,last_heartbeat_at,last_checked_at,installed_at,updated_at,last_error_code,last_error,transport";

fn record_query(
    conn: &Connection,
    query: &str,
    values: &[&dyn rusqlite::ToSql],
) -> Result<Vec<ShellbeamAgentRecord>, String> {
    let mut stmt = conn
        .prepare(query)
        .map_err(|err| format!("Prepare ShellBeam agent query failed: {err}"))?;
    let rows = stmt
        .query_map(values, read_record)
        .map_err(|err| format!("Query ShellBeam agent records failed: {err}"))?;
    rows.map(|row| row.map_err(|err| format!("Read ShellBeam agent record failed: {err}")))
        .collect()
}

fn write_record(
    conn: &Connection,
    input: &ShellbeamAgentInput,
) -> Result<ShellbeamAgentRecord, String> {
    let normalized = validate_input(input)?;
    let capabilities_json = to_string(&normalized.capabilities)
        .map_err(|err| format!("Serialize ShellBeam agent capabilities failed: {err}"))?;
    conn.execute(
        &format!(
            "INSERT INTO shellbeam_agents ({RECORD_COLUMNS})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
             ON CONFLICT(vault_id,host_id,agent_id) DO UPDATE SET
               provider_kind=excluded.provider_kind, source=excluded.source,
               status=excluded.status, health=excluded.health, version=excluded.version,
               install_path=excluded.install_path, capabilities_json=excluded.capabilities_json,
               service_name=excluded.service_name, heartbeat_ttl_ms=excluded.heartbeat_ttl_ms,
               last_heartbeat_at=excluded.last_heartbeat_at, last_checked_at=excluded.last_checked_at,
               installed_at=excluded.installed_at, updated_at=excluded.updated_at,
               last_error_code=excluded.last_error_code, last_error=excluded.last_error,
               transport=excluded.transport
             WHERE excluded.updated_at >= shellbeam_agents.updated_at"
        ),
        params![
            normalized.vault_id,
            normalized.host_id,
            normalized.agent_id,
            normalized.provider_kind,
            normalized.source,
            normalized.status,
            normalized.health,
            normalized.version,
            normalized.install_path,
            capabilities_json,
            normalized.service_name,
            normalized.heartbeat_ttl_ms,
            normalized.last_heartbeat_at,
            normalized.last_checked_at,
            normalized.installed_at,
            normalized.updated_at,
            normalized.last_error_code,
            normalized.last_error,
            normalized.transport,
        ],
    )
    .map_err(|err| format!("Save ShellBeam agent record failed: {err}"))?;
    conn.query_row(
        &format!("SELECT {RECORD_COLUMNS} FROM shellbeam_agents WHERE vault_id=?1 AND host_id=?2 AND agent_id=?3"),
        params![normalized.vault_id, normalized.host_id, normalized.agent_id],
        read_record,
    )
    .map_err(|err| format!("Read saved ShellBeam agent record failed: {err}"))
}

#[tauri::command]
pub fn list_shellbeam_agents(
    app: tauri::AppHandle,
    vault_id: Option<String>,
    host_id: Option<String>,
) -> Result<Vec<ShellbeamAgentRecord>, String> {
    let vault_id = vault_id
        .as_deref()
        .map(|value| normalize_id(value, "vault id"))
        .transpose()?;
    let host_id = host_id
        .as_deref()
        .map(|value| normalize_id(value, "host id"))
        .transpose()?;
    let conn = open(&app)?;
    match (vault_id.as_deref(), host_id.as_deref()) {
        (Some(vault_id), Some(host_id)) => record_query(
            &conn,
            &format!("SELECT {RECORD_COLUMNS} FROM shellbeam_agents WHERE vault_id=?1 AND host_id=?2 ORDER BY updated_at DESC"),
            &[&vault_id, &host_id],
        ),
        (Some(vault_id), None) => record_query(
            &conn,
            &format!("SELECT {RECORD_COLUMNS} FROM shellbeam_agents WHERE vault_id=?1 ORDER BY updated_at DESC"),
            &[&vault_id],
        ),
        (None, Some(host_id)) => record_query(
            &conn,
            &format!("SELECT {RECORD_COLUMNS} FROM shellbeam_agents WHERE host_id=?1 ORDER BY updated_at DESC"),
            &[&host_id],
        ),
        (None, None) => record_query(
            &conn,
            &format!("SELECT {RECORD_COLUMNS} FROM shellbeam_agents ORDER BY updated_at DESC"),
            &[],
        ),
    }
}

#[tauri::command]
pub fn upsert_shellbeam_agent(
    app: tauri::AppHandle,
    input: ShellbeamAgentInput,
) -> Result<ShellbeamAgentRecord, String> {
    let conn = open(&app)?;
    write_record(&conn, &input)
}

#[tauri::command]
pub fn record_shellbeam_agent_heartbeat(
    app: tauri::AppHandle,
    input: ShellbeamAgentHeartbeatInput,
) -> Result<ShellbeamAgentRecord, String> {
    let vault_id = normalize_id(&input.vault_id, "vault id")?;
    let host_id = normalize_id(&input.host_id, "host id")?;
    let agent_id = normalize_agent_id(input.agent_id.as_deref())?;
    let conn = open(&app)?;
    let existing = conn
        .query_row(
            &format!("SELECT {RECORD_COLUMNS} FROM shellbeam_agents WHERE vault_id=?1 AND host_id=?2 AND agent_id=?3"),
            params![vault_id, host_id, agent_id],
            read_record,
        )
        .optional()
        .map_err(|err| format!("Read ShellBeam agent heartbeat record failed: {err}"))?;
    let now = now_unix_ms();
    let input_status = input.status.as_deref();
    let heartbeat_is_healthy = matches!(input.health.as_deref(), Some("online"))
        || matches!(input_status, Some("installed"));
    let merged = ShellbeamAgentInput {
        vault_id,
        host_id,
        agent_id: Some(agent_id),
        provider_kind: input
            .provider_kind
            .or_else(|| existing.as_ref().map(|record| record.provider_kind.clone())),
        source: input
            .source
            .or_else(|| existing.as_ref().map(|record| record.source.clone())),
        status: input
            .status
            .clone()
            .or_else(|| existing.as_ref().map(|record| record.status.clone()))
            .unwrap_or_else(|| "unknown".to_string()),
        health: merged_heartbeat_health(
            input.health.as_deref(),
            input_status,
            existing.as_ref().map(|record| record.health.as_str()),
        ),
        version: input
            .version
            .or_else(|| existing.as_ref().and_then(|record| record.version.clone())),
        capabilities: input
            .capabilities
            .or_else(|| existing.as_ref().map(|record| record.capabilities.clone())),
        install_path: existing
            .as_ref()
            .and_then(|record| record.install_path.clone()),
        service_name: existing
            .as_ref()
            .and_then(|record| record.service_name.clone()),
        heartbeat_ttl_ms: input
            .heartbeat_ttl_ms
            .or_else(|| existing.as_ref().map(|record| record.heartbeat_ttl_ms)),
        last_heartbeat_at: Some(input.heartbeat_at.unwrap_or(now)),
        last_checked_at: Some(input.checked_at.unwrap_or(now)),
        installed_at: existing.as_ref().and_then(|record| record.installed_at),
        last_error_code: input.last_error_code.or_else(|| {
            if heartbeat_is_healthy {
                None
            } else {
                existing
                    .as_ref()
                    .and_then(|record| record.last_error_code.clone())
            }
        }),
        last_error: input.last_error.or_else(|| {
            if heartbeat_is_healthy {
                None
            } else {
                existing
                    .as_ref()
                    .and_then(|record| record.last_error.clone())
            }
        }),
        transport: input
            .transport
            .or_else(|| existing.as_ref().map(|record| record.transport.clone())),
    };
    write_record(&conn, &merged)
}

#[tauri::command]
pub fn clear_shellbeam_agents(
    app: tauri::AppHandle,
    vault_id: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    let vault_id = vault_id
        .as_deref()
        .map(|value| normalize_id(value, "vault id"))
        .transpose()?;
    let host_id = host_id
        .as_deref()
        .map(|value| normalize_id(value, "host id"))
        .transpose()?;
    let conn = open(&app)?;
    match (vault_id, host_id) {
        (Some(vault_id), Some(host_id)) => conn
            .execute(
                "DELETE FROM shellbeam_agents WHERE vault_id=?1 AND host_id=?2",
                params![vault_id, host_id],
            )
            .map_err(|err| format!("Clear ShellBeam agent records failed: {err}"))?,
        (Some(vault_id), None) => conn
            .execute(
                "DELETE FROM shellbeam_agents WHERE vault_id=?1",
                params![vault_id],
            )
            .map_err(|err| format!("Clear ShellBeam agent records failed: {err}"))?,
        (None, Some(host_id)) => conn
            .execute(
                "DELETE FROM shellbeam_agents WHERE host_id=?1",
                params![host_id],
            )
            .map_err(|err| format!("Clear ShellBeam agent records failed: {err}"))?,
        (None, None) => conn
            .execute("DELETE FROM shellbeam_agents", [])
            .map_err(|err| format!("Clear ShellBeam agent records failed: {err}"))?,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        merged_heartbeat_health, normalize_agent_id, normalize_capabilities, normalize_health,
        normalize_status, redact_summary,
    };

    #[test]
    fn defaults_agent_id_and_rejects_control_characters() {
        assert_eq!(
            normalize_agent_id(None).expect("default"),
            "shellbeam-agent"
        );
        assert!(normalize_agent_id(Some("agent\n1")).is_err());
    }

    #[test]
    fn lifecycle_and_health_values_are_bounded() {
        assert!(normalize_status("installed").is_ok());
        assert!(normalize_status("not-installed").is_ok());
        assert!(normalize_status("retired").is_ok());
        assert!(normalize_status("running").is_err());
        assert!(normalize_health(Some("online")).is_ok());
        assert!(normalize_health(Some("running")).is_err());
    }

    #[test]
    fn capabilities_are_deduplicated_and_summaries_redact_secrets() {
        let capabilities = normalize_capabilities(Some(&[
            "metrics".to_string(),
            "metrics".to_string(),
            "inventory".to_string(),
        ]))
        .expect("capabilities");
        assert_eq!(capabilities, vec!["metrics", "inventory"]);
        assert_eq!(
            redact_summary(Some("token=secret-value failed"), "error").expect("summary"),
            Some("<redacted> failed".to_string())
        );
        assert_eq!(
            redact_summary(Some("Authorization Bearer private-value failed"), "error")
                .expect("authorization summary"),
            Some("<redacted> <redacted> <redacted> failed".to_string())
        );
    }

    #[test]
    fn heartbeat_status_refreshes_stale_health_without_overriding_explicit_health() {
        assert_eq!(
            merged_heartbeat_health(None, Some("installed"), Some("offline")),
            Some("online".to_string())
        );
        assert_eq!(
            merged_heartbeat_health(None, Some("offline"), Some("online")),
            Some("offline".to_string())
        );
        assert_eq!(
            merged_heartbeat_health(Some("stale"), Some("installed"), Some("offline")),
            Some("stale".to_string())
        );
    }
}
