//! Bounded, vault/host/provider/node scoped metric history. This stores only a
//! whitelisted metric observation, never API responses, credentials or commands.
use crate::collection_limits::limits;
use crate::storage::{data_file_path, now_unix_ms};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS provider_metric_history(vault_id TEXT NOT NULL,provider_kind TEXT NOT NULL,provider_id TEXT NOT NULL,host_id TEXT NOT NULL,node_id TEXT NOT NULL,sampled_at INTEGER NOT NULL,received_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,metrics_json TEXT NOT NULL,confidence TEXT NOT NULL,PRIMARY KEY(vault_id,provider_kind,provider_id,host_id,node_id,sampled_at)); CREATE INDEX IF NOT EXISTS idx_provider_history_host_time ON provider_metric_history(vault_id,host_id,sampled_at); ").map_err(|_|"history_schema_failed".into())
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
fn append(conn: &mut Connection, payload: &MetricHistoryBatch, now: i64) -> Result<(), String> {
    let vault = id(&payload.vault_id)?;
    if payload.points.len() > limits().history.max_batch_points {
        return Err("history_batch_too_large".into());
    }
    let tx = conn
        .transaction()
        .map_err(|_| "history_transaction_failed")?;
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
        tx.execute("INSERT INTO provider_metric_history(vault_id,provider_kind,provider_id,host_id,node_id,sampled_at,received_at,expires_at,metrics_json,confidence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(vault_id,provider_kind,provider_id,host_id,node_id,sampled_at) DO UPDATE SET received_at=excluded.received_at,expires_at=excluded.expires_at,metrics_json=excluded.metrics_json,confidence=excluded.confidence WHERE excluded.received_at>=provider_metric_history.received_at",params![vault,point.provider_kind,provider,host,point.node_id,point.sampled_at,point.received_at,point.expires_at,safe.to_string(),confidence]).map_err(|_|"history_write_failed")?;
    }
    tx.execute(
        "DELETE FROM provider_metric_history WHERE sampled_at<?1",
        params![now.saturating_sub(limits().history.retention_ms)],
    )
    .map_err(|_| "history_retention_failed")?;
    // Retention is global as well as per series, so a large fleet cannot grow this cache indefinitely.
    tx.execute("DELETE FROM provider_metric_history WHERE rowid IN (SELECT rowid FROM (SELECT rowid,ROW_NUMBER() OVER (PARTITION BY vault_id,provider_kind,provider_id,host_id,node_id ORDER BY sampled_at DESC) AS rank FROM provider_metric_history) WHERE rank>?1)",params![limits().history.max_series_points]).map_err(|_|"history_retention_failed")?;
    tx.execute("DELETE FROM provider_metric_history WHERE rowid IN (SELECT rowid FROM provider_metric_history ORDER BY sampled_at DESC LIMIT -1 OFFSET ?1)",params![limits().history.max_total_points]).map_err(|_|"history_retention_failed")?;
    tx.commit().map_err(|_| "history_commit_failed".into())
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
    let vault = id(&query.vault_id)?;
    let host = id(&query.host_id)?;
    let provider = query.provider_id.as_deref().map(id).transpose()?;
    open(&app)?.execute("DELETE FROM provider_metric_history WHERE vault_id=?1 AND host_id=?2 AND (?3 IS NULL OR provider_id=?3)",params![vault,host,provider]).map_err(|_|"history_clear_failed")?;
    Ok(())
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
