//! Bounded, vault/host/provider/node scoped metric history. This stores only a
//! whitelisted metric observation, never API responses, credentials or commands.
use crate::collection_limits::limits;
use crate::storage::{data_file_path, now_unix_ms};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

const MAX_SAFE_CURSOR: i64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportLimits {
    schema_version: u32,
    page_bytes: usize,
    max_points: usize,
}
fn import_limits() -> &'static ImportLimits {
    static VALUE: std::sync::OnceLock<ImportLimits> = std::sync::OnceLock::new();
    VALUE.get_or_init(|| {
        let value: ImportLimits =
            serde_json::from_str(include_str!("../../../agent/history-protocol-limits.json"))
                .expect("checked-in Agent history protocol limits");
        assert_eq!(value.schema_version, 1);
        assert!(value.page_bytes > 0 && value.max_points > 0);
        value
    })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricHistoryPoint {
    pub provider_kind: String,
    pub provider_id: String,
    pub host_id: String,
    #[serde(default)]
    pub node_id: String,
    pub sampled_at: i64,
    pub received_at: i64,
    pub expires_at: i64,
    pub metrics: Value,
    #[serde(default = "partial")]
    pub confidence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_partial: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_series: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_before: Option<Vec<String>>,
}
fn partial() -> String {
    "partial".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricHistoryBatch {
    pub vault_id: String,
    pub points: Vec<MetricHistoryPoint>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricHistoryQuery {
    pub vault_id: String,
    pub host_id: String,
    pub provider_id: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCursorScope {
    pub vault_id: String,
    pub host_id: String,
    pub provider_kind: String,
    pub provider_id: String,
    pub node_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImportPage {
    #[serde(flatten)]
    pub scope: HistoryCursorScope,
    pub expected_revision: i64,
    pub expected_cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub points: Vec<MetricHistoryPoint>,
    pub exhausted: bool,
}

/// Cursor state is independent of metric rows and status snapshots. Its reason
/// comes only from fixed local classifications, never a remote command output.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCursorState {
    pub cursor: Option<String>,
    pub revision: i64,
    pub updated_at: Option<i64>,
    pub exhausted: bool,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImportResult {
    #[serde(flatten)]
    pub state: HistoryCursorState,
    pub appended: usize,
}
fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS provider_metric_history(vault_id TEXT NOT NULL,provider_kind TEXT NOT NULL,provider_id TEXT NOT NULL,host_id TEXT NOT NULL,node_id TEXT NOT NULL,sampled_at INTEGER NOT NULL,received_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,metrics_json TEXT NOT NULL,confidence TEXT NOT NULL,PRIMARY KEY(vault_id,provider_kind,provider_id,host_id,node_id,sampled_at)); CREATE INDEX IF NOT EXISTS idx_provider_history_host_time ON provider_metric_history(vault_id,host_id,sampled_at);
      CREATE TABLE IF NOT EXISTS provider_history_import_cursors(vault_id TEXT NOT NULL,host_id TEXT NOT NULL,provider_kind TEXT NOT NULL,provider_id TEXT NOT NULL,node_id TEXT NOT NULL,cursor TEXT,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,exhausted INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(vault_id,host_id,provider_kind,provider_id,node_id));").map_err(|_|"history_schema_failed".into())
}
fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(data_file_path(app, "workspace_inventory.sqlite3")?)
        .map_err(|_| "history_open_failed")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "history_open_failed")?;
    schema(&conn)?;
    Ok(conn)
}
fn id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
        Err("history_scope_invalid".into())
    } else {
        Ok(value.into())
    }
}
fn metrics(value: &Value, sampled_at: i64) -> Result<Value, String> {
    let object = value.as_object().ok_or("history_metrics_invalid")?;
    let mut safe = serde_json::Map::new();
    for field in ["hostname", "os", "kernel"] {
        safe.insert(
            field.into(),
            json!(object
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .filter(|v| !v.is_control())
                .take(240)
                .collect::<String>()),
        );
    }
    for field in [
        "uptimeSeconds",
        "cpuPercent",
        "load1",
        "load5",
        "load15",
        "memoryUsedBytes",
        "memoryTotalBytes",
        "memoryPercent",
        "diskUsedBytes",
        "diskTotalBytes",
        "diskPercent",
        "networkRxBytesPerSec",
        "networkTxBytesPerSec",
        "latencyMs",
    ] {
        let value = object
            .get(field)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0 && (!field.ends_with("Percent") || *v <= 100.0));
        safe.insert(field.into(), value.map_or(Value::Null, |v| json!(v)));
    }
    safe.insert("sampledAt".into(), json!(sampled_at));
    Ok(Value::Object(safe))
}

fn cursor_scope(value: &HistoryCursorScope) -> Result<HistoryCursorScope, String> {
    let scope = HistoryCursorScope {
        vault_id: id(&value.vault_id)?,
        host_id: id(&value.host_id)?,
        provider_kind: id(&value.provider_kind)?,
        provider_id: id(&value.provider_id)?,
        node_id: id(&value.node_id)?,
    };
    if scope.provider_kind != "shellbeam-agent" {
        return Err("history_import_provider_invalid".into());
    }
    Ok(scope)
}

fn cursor_number(cursor: Option<&str>) -> Result<i64, String> {
    match cursor {
        None => Ok(0),
        Some(value) => {
            // The Agent's paging token is a canonical decimal millisecond
            // watermark. Never retain arbitrary opaque strings or raw output.
            let parsed = value.parse::<i64>().map_err(|_| "history_cursor_invalid")?;
            if parsed <= 0 || parsed > MAX_SAFE_CURSOR || parsed.to_string() != value {
                return Err("history_cursor_invalid".into());
            }
            Ok(parsed)
        }
    }
}

fn import_cursor(
    conn: &Connection,
    scope: &HistoryCursorScope,
) -> Result<HistoryCursorState, String> {
    let scope = cursor_scope(scope)?;
    let state = conn.query_row(
        "SELECT cursor,revision,updated_at,exhausted,reason FROM provider_history_import_cursors WHERE vault_id=?1 AND host_id=?2 AND provider_kind=?3 AND provider_id=?4 AND node_id=?5",
        params![scope.vault_id,scope.host_id,scope.provider_kind,scope.provider_id,scope.node_id],
        |row| Ok(HistoryCursorState { cursor:row.get(0)?, revision:row.get(1)?, updated_at:Some(row.get(2)?), exhausted:row.get::<_,i64>(3)? != 0, reason:row.get(4)? }),
    ).optional().map_err(|_| "history_cursor_read_failed")?.unwrap_or(HistoryCursorState {
        cursor:None, revision:0, updated_at:None, exhausted:false, reason:"not-started".into(),
    });
    cursor_number(state.cursor.as_deref())?;
    if state.revision < 0
        || state.revision > MAX_SAFE_CURSOR
        || state.updated_at.is_some_and(|value| value < 0)
        || !["not-started", "page-imported", "complete", "empty"].contains(&state.reason.as_str())
    {
        return Err("history_cursor_invalid".into());
    }
    Ok(state)
}

fn import_page(
    conn: &mut Connection,
    payload: &HistoryImportPage,
    now: i64,
) -> Result<HistoryImportResult, String> {
    let scope = cursor_scope(&payload.scope)?;
    let previous = cursor_number(payload.expected_cursor.as_deref())?;
    let next = cursor_number(payload.next_cursor.as_deref())?;
    if payload.expected_revision < 0 || payload.expected_revision >= MAX_SAFE_CURSOR {
        return Err("history_cursor_invalid".into());
    }
    if payload.points.len()
        > import_limits()
            .max_points
            .min(limits().history.max_batch_points)
    {
        return Err("history_batch_too_large".into());
    }
    if serde_json::to_vec(payload)
        .map_err(|_| "history_page_invalid")?
        .len()
        > import_limits().page_bytes
    {
        return Err("history_page_too_large".into());
    }
    if payload.points.is_empty() {
        if next != previous || !payload.exhausted {
            return Err("history_cursor_page_invalid".into());
        }
    } else {
        let maximum = payload
            .points
            .iter()
            .map(|point| point.sampled_at)
            .max()
            .unwrap();
        if next != maximum || next <= previous {
            return Err("history_cursor_page_invalid".into());
        }
        for point in &payload.points {
            if point.host_id != scope.host_id
                || point.provider_kind != scope.provider_kind
                || point.provider_id != scope.provider_id
                || point.node_id != scope.node_id
            {
                return Err("history_import_scope_mismatch".into());
            }
            if point.sampled_at <= previous
                || point.sampled_at > now
                || point.sampled_at > MAX_SAFE_CURSOR
                || point.received_at < point.sampled_at
                || point.received_at > now
                || point.expires_at < point.sampled_at
                || point.expires_at > MAX_SAFE_CURSOR
                || point.metrics["sampledAt"].as_i64() != Some(point.sampled_at)
            {
                return Err("history_timestamp_invalid".into());
            }
        }
    }
    // BEGIN IMMEDIATE prevents two windows from accepting the same revision.
    // Metric inserts and the watermark commit or roll back together.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "history_transaction_failed")?;
    let current = import_cursor(&tx, &scope)?;
    if current.revision != payload.expected_revision || current.cursor != payload.expected_cursor {
        return Err("history_cursor_conflict".into());
    }
    let appended = append_points(
        &tx,
        &MetricHistoryBatch {
            vault_id: scope.vault_id.clone(),
            points: payload.points.clone(),
        },
        now,
        true,
    )?;
    let reason = if payload.points.is_empty() {
        "empty"
    } else if payload.exhausted {
        "complete"
    } else {
        "page-imported"
    };
    let state = HistoryCursorState {
        cursor: payload.next_cursor.clone(),
        revision: current.revision + 1,
        updated_at: Some(now),
        exhausted: payload.exhausted,
        reason: reason.into(),
    };
    tx.execute(
        "INSERT INTO provider_history_import_cursors(vault_id,host_id,provider_kind,provider_id,node_id,cursor,revision,updated_at,exhausted,reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(vault_id,host_id,provider_kind,provider_id,node_id) DO UPDATE SET cursor=excluded.cursor,revision=excluded.revision,updated_at=excluded.updated_at,exhausted=excluded.exhausted,reason=excluded.reason",
        params![scope.vault_id,scope.host_id,scope.provider_kind,scope.provider_id,scope.node_id,state.cursor,state.revision,now,state.exhausted as i64,state.reason],
    ).map_err(|_| "history_cursor_write_failed")?;
    tx.commit().map_err(|_| "history_commit_failed")?;
    Ok(HistoryImportResult { state, appended })
}

fn import_page_unlocked(
    state: &crate::vault::secrets::VaultState,
    conn: &mut Connection,
    payload: &HistoryImportPage,
    now: i64,
) -> Result<HistoryImportResult, String> {
    let scope = cursor_scope(&payload.scope)?;
    state.while_unlocked(&scope.vault_id, || import_page(conn, payload, now))
}

fn append(conn: &mut Connection, payload: &MetricHistoryBatch, now: i64) -> Result<(), String> {
    id(&payload.vault_id)?;
    if payload.points.len() > limits().history.max_batch_points {
        return Err("history_batch_too_large".into());
    }
    let tx = conn
        .transaction()
        .map_err(|_| "history_transaction_failed")?;
    append_points(&tx, payload, now, false)?;
    tx.commit().map_err(|_| "history_commit_failed".into())
}

fn append_points(
    tx: &Transaction<'_>,
    payload: &MetricHistoryBatch,
    now: i64,
    ignore_existing: bool,
) -> Result<usize, String> {
    let vault = id(&payload.vault_id)?;
    let mut appended = 0;
    for point in &payload.points {
        let host = id(&point.host_id)?;
        let provider = id(&point.provider_id)?;
        if !["komari", "ssh-agentless", "shellbeam-agent"].contains(&point.provider_kind.as_str())
            || point.node_id.len() > 160
            || point.node_id.chars().any(char::is_control)
        {
            return Err("history_provider_invalid".into());
        }
        if point.sampled_at <= 0
            || point.received_at <= 0
            || point.sampled_at > now.saturating_add(300000)
            || point.expires_at < point.sampled_at
        {
            return Err("history_timestamp_invalid".into());
        }
        if point.sampled_at < now.saturating_sub(limits().history.retention_ms) {
            continue;
        }
        let safe = metrics(&point.metrics, point.sampled_at)?;
        let confidence = if point.confidence == "observed" {
            "observed"
        } else {
            "partial"
        };
        let sql = if ignore_existing {
            "INSERT OR IGNORE INTO provider_metric_history(vault_id,provider_kind,provider_id,host_id,node_id,sampled_at,received_at,expires_at,metrics_json,confidence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
        } else {
            "INSERT INTO provider_metric_history(vault_id,provider_kind,provider_id,host_id,node_id,sampled_at,received_at,expires_at,metrics_json,confidence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(vault_id,provider_kind,provider_id,host_id,node_id,sampled_at) DO UPDATE SET received_at=excluded.received_at,expires_at=excluded.expires_at,metrics_json=excluded.metrics_json,confidence=excluded.confidence WHERE excluded.received_at>=provider_metric_history.received_at"
        };
        appended += tx
            .execute(
                sql,
                params![
                    vault,
                    point.provider_kind,
                    provider,
                    host,
                    point.node_id,
                    point.sampled_at,
                    point.received_at,
                    point.expires_at,
                    safe.to_string(),
                    confidence
                ],
            )
            .map_err(|_| "history_write_failed")?;
    }
    tx.execute(
        "DELETE FROM provider_metric_history WHERE sampled_at<?1",
        params![now.saturating_sub(limits().history.retention_ms)],
    )
    .map_err(|_| "history_retention_failed")?;
    // Retention is global as well as per series, so a large fleet cannot grow this cache indefinitely.
    tx.execute("DELETE FROM provider_metric_history WHERE rowid IN (SELECT rowid FROM (SELECT rowid,ROW_NUMBER() OVER (PARTITION BY vault_id,provider_kind,provider_id,host_id,node_id ORDER BY sampled_at DESC) AS rank FROM provider_metric_history) WHERE rank>?1)",params![limits().history.max_series_points]).map_err(|_|"history_retention_failed")?;
    tx.execute("DELETE FROM provider_metric_history WHERE rowid IN (SELECT rowid FROM provider_metric_history ORDER BY sampled_at DESC LIMIT -1 OFFSET ?1)",params![limits().history.max_total_points]).map_err(|_|"history_retention_failed")?;
    Ok(appended)
}
fn list(
    conn: &Connection,
    query: &MetricHistoryQuery,
    now: i64,
) -> Result<Vec<MetricHistoryPoint>, String> {
    let vault = id(&query.vault_id)?;
    let host = id(&query.host_id)?;
    let provider = query.provider_id.as_deref().map(id).transpose()?;
    let to = query.to.unwrap_or(now).min(now.saturating_add(300000));
    let from = query
        .from
        .unwrap_or(to.saturating_sub(limits().history.default_query_range_ms))
        .max(now.saturating_sub(limits().history.retention_ms));
    if from > to {
        return Err("history_range_invalid".into());
    }
    let limit = query
        .limit
        .unwrap_or(limits().history.default_query_points)
        .clamp(2, limits().history.max_query_points);
    // Read a bounded host slice ordered across the requested window, then
    // evenly downsample each source to preserve coverage and null gaps.
    let mut statement=conn.prepare("SELECT provider_kind,provider_id,host_id,node_id,sampled_at,received_at,expires_at,metrics_json,confidence FROM provider_metric_history WHERE vault_id=?1 AND host_id=?2 AND (?3 IS NULL OR provider_id=?3) AND sampled_at>=?4 AND sampled_at<=?5 ORDER BY sampled_at ASC LIMIT ?6").map_err(|_|"history_query_failed")?;
    let rows = statement
        .query_map(
            params![
                vault,
                host,
                provider,
                from,
                to,
                limits().history.max_total_points
            ],
            |row| {
                Ok(MetricHistoryPoint {
                    provider_kind: row.get(0)?,
                    provider_id: row.get(1)?,
                    host_id: row.get(2)?,
                    node_id: row.get(3)?,
                    sampled_at: row.get(4)?,
                    received_at: row.get(5)?,
                    expires_at: row.get(6)?,
                    metrics: serde_json::from_str(&row.get::<_, String>(7)?)
                        .unwrap_or_else(|_| json!({})),
                    confidence: row.get(8)?,
                    history_partial: None,
                    total_series: None,
                    gap_before: None,
                })
            },
        )
        .map_err(|_| "history_query_failed")?;
    let mut series =
        std::collections::BTreeMap::<(String, String, String), Vec<MetricHistoryPoint>>::new();
    for row in rows {
        let point = row.map_err(|_| "history_read_failed")?;
        series
            .entry((
                point.provider_kind.clone(),
                point.provider_id.clone(),
                point.node_id.clone(),
            ))
            .or_default()
            .push(point);
    }
    let total_series = series.len();
    let mut source_rows: Vec<_> = series.into_values().collect();
    source_rows.sort_by(|left, right| {
        right
            .last()
            .map(|point| point.sampled_at)
            .cmp(&left.last().map(|point| point.sampled_at))
    });
    // Each selected source retains its first and last observation. Bound
    // source count too; otherwise a fleet of single-point sources can bypass
    // a per-series cap. Truncation is explicit in the result metadata.
    source_rows.truncate((limit / 2).max(1));
    let selected_series = source_rows.len();
    let per_series = limit / selected_series.max(1);
    let mut output = Vec::new();
    for (source_index, points) in source_rows.into_iter().enumerate() {
        let budget = per_series + usize::from(source_index < limit % selected_series.max(1));
        let selected: Vec<usize> = if points.len() <= budget {
            (0..points.len()).collect()
        } else {
            (0..budget)
                .map(|index| index * (points.len() - 1) / (budget - 1))
                .collect()
        };
        let mut previous: Option<usize> = None;
        for index in selected {
            let mut point = points[index].clone();
            if let Some(before) = previous {
                let fields = ["cpuPercent", "memoryPercent", "diskPercent"];
                let gaps: Vec<String> = fields
                    .into_iter()
                    .filter(|field| {
                        points[before..=index]
                            .iter()
                            .any(|point| !point.metrics[*field].is_number())
                            || points[before..=index]
                                .windows(2)
                                .any(|pair| pair[1].sampled_at > pair[0].expires_at)
                    })
                    .map(str::to_string)
                    .collect();
                if !gaps.is_empty() {
                    point.gap_before = Some(gaps);
                }
            }
            previous = Some(index);
            output.push(point);
        }
    }
    if selected_series < total_series {
        for point in &mut output {
            point.history_partial = Some(true);
            point.total_series = Some(total_series);
        }
    }
    output.sort_by_key(|point| point.sampled_at);
    Ok(output)
}
#[tauri::command]
pub fn get_provider_history_cursor(
    app: tauri::AppHandle,
    query: HistoryCursorScope,
) -> Result<HistoryCursorState, String> {
    import_cursor(&open(&app)?, &query)
}

#[tauri::command]
pub fn append_provider_history_page(
    app: tauri::AppHandle,
    payload: HistoryImportPage,
) -> Result<HistoryImportResult, String> {
    let state = app.state::<crate::vault::secrets::VaultState>();
    import_page_unlocked(&state, &mut open(&app)?, &payload, now_unix_ms())
}

#[tauri::command]
pub fn append_provider_metric_history(
    app: tauri::AppHandle,
    payload: MetricHistoryBatch,
) -> Result<(), String> {
    append(&mut open(&app)?, &payload, now_unix_ms())
}
#[tauri::command]
pub fn list_provider_metric_history(
    app: tauri::AppHandle,
    query: MetricHistoryQuery,
) -> Result<Vec<MetricHistoryPoint>, String> {
    list(&open(&app)?, &query, now_unix_ms())
}
#[tauri::command]
pub fn clear_provider_metric_history(
    app: tauri::AppHandle,
    query: MetricHistoryQuery,
) -> Result<(), String> {
    clear(&mut open(&app)?, &query)
}

fn clear(conn: &mut Connection, query: &MetricHistoryQuery) -> Result<(), String> {
    let vault = id(&query.vault_id)?;
    let host = id(&query.host_id)?;
    let provider = query.provider_id.as_deref().map(id).transpose()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "history_transaction_failed")?;
    tx.execute("DELETE FROM provider_metric_history WHERE vault_id=?1 AND host_id=?2 AND (?3 IS NULL OR provider_id=?3)",params![vault,host,provider]).map_err(|_|"history_clear_failed")?;
    tx.execute("DELETE FROM provider_history_import_cursors WHERE vault_id=?1 AND host_id=?2 AND (?3 IS NULL OR provider_id=?3)",params![vault,host,provider]).map_err(|_|"history_clear_failed")?;
    tx.commit().map_err(|_| "history_commit_failed".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn point(at: i64) -> MetricHistoryPoint {
        MetricHistoryPoint {
            provider_kind: "komari".into(),
            provider_id: "source-1".into(),
            host_id: "host-1".into(),
            node_id: "node-1".into(),
            sampled_at: at,
            received_at: 100000,
            expires_at: at + 1000,
            metrics: json!({"cpuPercent":25,"memoryPercent":null,"token":"must not persist"}),
            confidence: "partial".into(),
            history_partial: None,
            total_series: None,
            gap_before: None,
        }
    }
    fn query(vault: &str) -> MetricHistoryQuery {
        MetricHistoryQuery {
            vault_id: vault.into(),
            host_id: "host-1".into(),
            provider_id: None,
            from: Some(1),
            to: Some(100000),
            limit: Some(100),
        }
    }

    fn import_scope() -> HistoryCursorScope {
        HistoryCursorScope {
            vault_id: "vault-a".into(),
            host_id: "host-1".into(),
            provider_kind: "shellbeam-agent".into(),
            provider_id: "shellbeam-agent".into(),
            node_id: "agent-one".into(),
        }
    }

    fn import_point(at: i64, scope: &HistoryCursorScope) -> MetricHistoryPoint {
        let mut point = point(at);
        point.host_id = scope.host_id.clone();
        point.provider_kind = scope.provider_kind.clone();
        point.provider_id = scope.provider_id.clone();
        point.node_id = scope.node_id.clone();
        point.metrics["sampledAt"] = json!(at);
        point
    }

    fn page(scope: HistoryCursorScope, times: &[i64]) -> HistoryImportPage {
        HistoryImportPage {
            points: times.iter().map(|at| import_point(*at, &scope)).collect(),
            scope,
            expected_revision: 0,
            expected_cursor: None,
            next_cursor: times.iter().max().map(ToString::to_string),
            exhausted: false,
        }
    }

    #[test]
    fn history_import_watermark_is_independent_of_current_status_and_existing_points() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let scope = import_scope();
        let mut already_observed = import_point(200, &scope);
        already_observed.metrics["cpuPercent"] = json!(90);
        append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: scope.vault_id.clone(),
                points: vec![already_observed, import_point(900, &scope)],
            },
            100000,
        )
        .unwrap();
        assert_eq!(import_cursor(&conn, &scope).unwrap().cursor, None);
        let result = import_page(&mut conn, &page(scope.clone(), &[100, 200]), 100000).unwrap();
        assert_eq!(result.appended, 1);
        assert_eq!(result.state.cursor.as_deref(), Some("200"));
        assert_eq!(result.state.revision, 1);
        let values = list(&conn, &query("vault-a"), 100000).unwrap();
        assert_eq!(values.len(), 3);
        assert_eq!(
            values
                .iter()
                .find(|point| point.sampled_at == 200)
                .unwrap()
                .metrics["cpuPercent"],
            json!(90.0)
        );
        assert!(values
            .iter()
            .all(|point| point.metrics.get("token").is_none()));
        append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: scope.vault_id.clone(),
                points: vec![import_point(1000, &scope)],
            },
            100000,
        )
        .unwrap();
        assert_eq!(import_cursor(&conn, &scope).unwrap(), result.state);
    }

    #[test]
    fn history_import_cursor_is_scoped_to_vault_host_provider_and_agent_identity() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let base = import_scope();
        let mut scopes = vec![base.clone()];
        let mut next = base.clone();
        next.vault_id = "vault-b".into();
        scopes.push(next);
        let mut next = base.clone();
        next.host_id = "host-2".into();
        scopes.push(next);
        let mut next = base.clone();
        next.provider_id = "agent-source-two".into();
        scopes.push(next);
        let mut next = base.clone();
        next.node_id = "agent-reinstalled".into();
        scopes.push(next);
        for (index, scope) in scopes.iter().enumerate() {
            assert_eq!(import_cursor(&conn, scope).unwrap().revision, 0);
            import_page(
                &mut conn,
                &page(scope.clone(), &[100 + index as i64]),
                100000,
            )
            .unwrap();
        }
        for (index, scope) in scopes.iter().enumerate() {
            assert_eq!(
                import_cursor(&conn, scope).unwrap().cursor,
                Some((100 + index as i64).to_string())
            );
        }
    }

    #[test]
    fn history_import_rejects_invalid_pages_and_rolls_back_points_if_checkpoint_write_fails() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let scope = import_scope();
        let mut invalid = page(scope.clone(), &[100, 200]);
        invalid.next_cursor = Some("300".into());
        assert_eq!(
            import_page(&mut conn, &invalid, 100000).unwrap_err(),
            "history_cursor_page_invalid"
        );
        invalid = page(scope.clone(), &[100, 200]);
        invalid.points[1].node_id = "foreign-node".into();
        assert_eq!(
            import_page(&mut conn, &invalid, 100000).unwrap_err(),
            "history_import_scope_mismatch"
        );
        invalid = page(scope.clone(), &[100001]);
        assert_eq!(
            import_page(&mut conn, &invalid, 100000).unwrap_err(),
            "history_timestamp_invalid"
        );
        assert_eq!(import_cursor(&conn, &scope).unwrap().revision, 0);
        assert!(list(&conn, &query("vault-a"), 100000).unwrap().is_empty());
        conn.execute_batch("CREATE TRIGGER fail_import_cursor BEFORE INSERT ON provider_history_import_cursors BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert_eq!(
            import_page(&mut conn, &page(scope.clone(), &[100, 200]), 100000).unwrap_err(),
            "history_cursor_write_failed"
        );
        assert!(list(&conn, &query("vault-a"), 100000).unwrap().is_empty());
        assert_eq!(import_cursor(&conn, &scope).unwrap().revision, 0);
    }

    #[test]
    fn locked_vault_never_inserts_points_or_advances_an_import_cursor() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let scope = import_scope();
        let payload = page(scope.clone(), &[100, 200]);
        assert_eq!(
            import_page_unlocked(
                &crate::vault::secrets::VaultState::default(),
                &mut conn,
                &payload,
                100000
            )
            .unwrap_err(),
            "VAULT_LOCKED"
        );
        assert!(list(&conn, &query("vault-a"), 100000).unwrap().is_empty());
        assert_eq!(import_cursor(&conn, &scope).unwrap().revision, 0);
    }

    #[test]
    fn empty_history_page_does_not_advance_to_a_latest_status_or_window_end() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let scope = import_scope();
        let mut empty = page(scope.clone(), &[]);
        empty.exhausted = true;
        let result = import_page(&mut conn, &empty, 100000).unwrap();
        assert_eq!(result.state.cursor, None);
        assert_eq!(result.state.reason, "empty");
        assert_eq!(result.appended, 0);
        empty.expected_revision = result.state.revision;
        empty.next_cursor = Some("100000".into());
        assert_eq!(
            import_page(&mut conn, &empty, 100000).unwrap_err(),
            "history_cursor_page_invalid"
        );
        assert_eq!(import_cursor(&conn, &scope).unwrap(), result.state);
        let mut next = page(scope.clone(), &[100]);
        next.expected_revision = result.state.revision;
        import_page(&mut conn, &next, 100000).unwrap();
        let mut replay = page(scope, &[100, 200]);
        replay.expected_revision = 2;
        replay.expected_cursor = Some("100".into());
        assert_eq!(
            import_page(&mut conn, &replay, 100000).unwrap_err(),
            "history_timestamp_invalid"
        );
    }

    struct ImportDirectory(std::path::PathBuf);
    impl Drop for ImportDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn competing_sessions_commit_one_page_and_reopen_the_same_durable_watermark() {
        let directory = ImportDirectory(
            std::env::temp_dir().join(format!("shellbeam-history-cas-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0).unwrap();
        let path = directory.0.join("history.sqlite3");
        let initial = Connection::open(&path).unwrap();
        schema(&initial).unwrap();
        drop(initial);
        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    let mut conn = Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    gate.wait();
                    import_page(&mut conn, &page(import_scope(), &[100, 200]), 100000)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .collect::<Vec<_>>(),
            vec!["history_cursor_conflict"]
        );
        let reopened = Connection::open(path).unwrap();
        schema(&reopened).unwrap();
        let state = import_cursor(&reopened, &import_scope()).unwrap();
        assert_eq!(state.cursor.as_deref(), Some("200"));
        assert_eq!(state.revision, 1);
        assert_eq!(list(&reopened, &query("vault-a"), 100000).unwrap().len(), 2);
    }
    #[test]
    fn clearing_history_resets_only_the_same_scope_cursor_and_allows_backfill_again() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let base = import_scope();
        let mut sibling_node = base.clone();
        sibling_node.node_id = "agent-two".into();
        let mut other_provider = base.clone();
        other_provider.provider_id = "other-provider".into();
        let mut other_vault = base.clone();
        other_vault.vault_id = "vault-b".into();
        let mut other_host = base.clone();
        other_host.host_id = "host-2".into();
        for scope in [
            &base,
            &sibling_node,
            &other_provider,
            &other_vault,
            &other_host,
        ] {
            import_page(&mut conn, &page(scope.clone(), &[100]), 100000).unwrap();
        }
        let mut selection = query("vault-a");
        selection.provider_id = Some(base.provider_id.clone());
        clear(&mut conn, &selection).unwrap();
        assert!(list(&conn, &selection, 100000).unwrap().is_empty());
        assert_eq!(import_cursor(&conn, &base).unwrap().revision, 0);
        assert_eq!(import_cursor(&conn, &sibling_node).unwrap().revision, 0);
        for untouched in [&other_provider, &other_vault, &other_host] {
            assert_eq!(import_cursor(&conn, untouched).unwrap().revision, 1);
        }
        let result = import_page(&mut conn, &page(base, &[100]), 100000).unwrap();
        assert_eq!(result.appended, 1);
        assert_eq!(list(&conn, &selection, 100000).unwrap().len(), 1);
    }

    #[test]
    fn history_clear_rolls_back_metric_deletion_if_cursor_deletion_fails() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let scope = import_scope();
        let imported = import_page(&mut conn, &page(scope.clone(), &[100]), 100000).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_clear_cursor BEFORE DELETE ON provider_history_import_cursors BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert_eq!(
            clear(&mut conn, &query("vault-a")).unwrap_err(),
            "history_clear_failed"
        );
        assert_eq!(list(&conn, &query("vault-a"), 100000).unwrap().len(), 1);
        assert_eq!(import_cursor(&conn, &scope).unwrap(), imported.state);
    }

    #[test]
    fn history_page_budget_and_cursor_encoding_fail_without_persisting_output() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let scope = import_scope();
        let times: Vec<_> = (1..=import_limits().max_points as i64 + 1).collect();
        assert_eq!(
            import_page(&mut conn, &page(scope.clone(), &times), 100000).unwrap_err(),
            "history_batch_too_large"
        );
        let mut large = page(scope.clone(), &[100]);
        large.points[0].metrics["rawOutput"] = json!("x".repeat(import_limits().page_bytes));
        assert_eq!(
            import_page(&mut conn, &large, 100000).unwrap_err(),
            "history_page_too_large"
        );
        for raw in [
            "token=do-not-save",
            "00100",
            "0",
            "-1",
            "NaN",
            "9007199254740992",
        ] {
            assert_eq!(
                cursor_number(Some(raw)).unwrap_err(),
                "history_cursor_invalid"
            );
        }
        let payload: HistoryImportPage = serde_json::from_value(json!({
            "vaultId":"vault-a","hostId":"host-1","providerKind":"shellbeam-agent","providerId":"shellbeam-agent","nodeId":"agent-one",
            "expectedRevision":0,"expectedCursor":null,"nextCursor":null,"points":[],"exhausted":true,"reason":"token=do-not-save"
        })).unwrap();
        let result = import_page(&mut conn, &payload, 100000).unwrap();
        assert_eq!(result.state.reason, "empty");
        let stored = import_cursor(&conn, &scope).unwrap();
        assert_eq!(stored.reason, "empty");
        assert!(!serde_json::to_string(&stored)
            .unwrap()
            .contains("do-not-save"));
        assert!(list(&conn, &query("vault-a"), 100000).unwrap().is_empty());
    }

    #[test]
    fn isolates_vault_host_provider_node_and_retains_original_nulls() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        for vault in ["vault-a", "vault-b"] {
            append(
                &mut conn,
                &MetricHistoryBatch {
                    vault_id: vault.into(),
                    points: vec![point(100), point(200)],
                },
                100000,
            )
            .unwrap();
        }
        let rows = list(&conn, &query("vault-a"), 100000).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].metrics["memoryPercent"].is_null());
        assert!(rows[0].metrics.get("token").is_none());
        let mut other = query("vault-a");
        other.host_id = "host-2".into();
        assert!(list(&conn, &other, 100000).unwrap().is_empty());
        other = query("vault-a");
        other.provider_id = Some("source-2".into());
        assert!(list(&conn, &other, 100000).unwrap().is_empty());
    }
    #[test]
    fn deduplicates_out_of_order_imports_and_downsamples_full_range() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let points = (1..=50).rev().map(point).collect();
        append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: "v".into(),
                points,
            },
            100000,
        )
        .unwrap();
        append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: "v".into(),
                points: vec![point(25)],
            },
            100000,
        )
        .unwrap();
        let mut q = query("v");
        q.limit = Some(4);
        let rows = list(&conn, &q, 100000).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].sampled_at, 1);
        assert_eq!(rows[3].sampled_at, 50);
    }
    #[test]
    fn retention_and_future_timestamps_are_enforced() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let now = limits().history.retention_ms + 100000;
        let old = point(1);
        let mut recent = point(now - 100);
        recent.received_at = now;
        append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: "v".into(),
                points: vec![old, recent],
            },
            now,
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM provider_metric_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        let mut future = point(now + 300001);
        future.received_at = now;
        assert!(append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: "v".into(),
                points: vec![future]
            },
            now
        )
        .is_err());
    }
    #[test]
    fn global_query_limit_bounds_many_sources_and_reports_truncation() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let points = (1..=30)
            .map(|index| {
                let mut value = point(index);
                value.node_id = format!("node-{index}");
                value
            })
            .collect();
        append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: "v".into(),
                points,
            },
            100000,
        )
        .unwrap();
        let mut q = query("v");
        q.limit = Some(4);
        let values = list(&conn, &q, 100000).unwrap();
        assert!(values.len() <= 4);
        assert!(values.iter().any(|point| point.sampled_at == 30));
        assert!(values
            .iter()
            .all(|point| point.history_partial == Some(true) && point.total_series == Some(30)));
    }
    #[test]
    fn downsampling_keeps_unknown_and_expired_intervals_as_gap_metadata() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let mut points: Vec<_> = (1..=50)
            .map(|at| {
                let mut value = point(at);
                value.metrics = json!({"cpuPercent":25,"memoryPercent":40,"diskPercent":60});
                value
            })
            .collect();
        points[5].metrics["cpuPercent"] = Value::Null;
        points[35].expires_at = 36;
        append(
            &mut conn,
            &MetricHistoryBatch {
                vault_id: "v".into(),
                points,
            },
            100000,
        )
        .unwrap();
        let mut q = query("v");
        q.limit = Some(4);
        let values = list(&conn, &q, 100000).unwrap();
        assert_eq!(values.len(), 4);
        assert!(values[1]
            .gap_before
            .as_ref()
            .unwrap()
            .contains(&"cpuPercent".into()));
        assert!(!values[1]
            .gap_before
            .as_ref()
            .unwrap()
            .contains(&"memoryPercent".into()));
        assert!(values[3]
            .gap_before
            .as_ref()
            .unwrap()
            .contains(&"diskPercent".into()));
    }
}
