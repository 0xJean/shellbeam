//! Shared Desktop/MCP collector, remote-execution and history budgets. The
//! checked-in JSON is compiled into the binary, not loaded from user input.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub schema_version: u32,
    pub remote: Remote,
    pub collector: Collector,
    pub scheduler: Scheduler,
    pub cadence: Cadence,
    pub history: History,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub output_bytes: usize,
    pub command_timeout_ms: u64,
    pub min_command_timeout_ms: u64,
    pub mcp_command_max_timeout_ms: u64,
    pub collector_timeout_ms: u64,
    pub mcp_file_timeout_ms: u32,
    pub mcp_file_default_read_bytes: u64,
    pub mcp_file_max_read_bytes: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collector {
    pub filesystem_rows: usize,
    pub port_rows: usize,
    pub tool_rows: usize,
    pub service_rows: usize,
    pub service_detail_rows: usize,
    pub container_rows: usize,
    pub project_rows: usize,
    pub pm2_rows: usize,
    pub project_depth: usize,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scheduler {
    pub concurrency: usize,
    pub default_retries: usize,
    pub max_retries: usize,
    pub retry_delay_ms: u64,
    pub max_retry_delay_ms: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cadence {
    pub monitor_interval_ms: i64,
    pub inventory_interval_ms: i64,
    pub metrics_ttl_ms: i64,
    pub inventory_ttl_ms: i64,
    pub mcp_probe_cache_ms: i64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub retention_ms: i64,
    pub monitor_retention_ms: i64,
    pub max_series_points: i64,
    pub max_total_points: i64,
    pub append_chunk_points: usize,
    pub max_batch_points: usize,
    pub default_query_points: usize,
    pub max_query_points: usize,
    pub default_query_range_ms: i64,
}
impl Limits {
    fn validate(&self) {
        assert_eq!(self.schema_version, 1);
        assert!(
            self.remote.min_command_timeout_ms > 0
                && self.remote.min_command_timeout_ms <= self.remote.collector_timeout_ms
        );
        assert!(self.remote.collector_timeout_ms <= self.remote.command_timeout_ms);
        assert!(self.remote.command_timeout_ms <= self.remote.mcp_command_max_timeout_ms);
        assert!(self.remote.mcp_file_default_read_bytes <= self.remote.mcp_file_max_read_bytes);
        assert!(self.cadence.monitor_interval_ms < self.cadence.metrics_ttl_ms);
        assert!(self.cadence.inventory_interval_ms < self.cadence.inventory_ttl_ms);
        assert!(self.history.monitor_retention_ms <= self.history.retention_ms);
        assert!(self.history.append_chunk_points <= self.history.max_batch_points);
        assert!(self.history.default_query_points <= self.history.max_query_points);
        assert!(self.scheduler.concurrency > 0);
        assert!(self.scheduler.default_retries <= self.scheduler.max_retries);
        assert!(self.scheduler.retry_delay_ms <= self.scheduler.max_retry_delay_ms);
    }
}
const SOURCE: &str = include_str!("../../shared/collection-limits.json");
pub fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        let limits: Limits = serde_json::from_str(SOURCE).expect("valid bundled collection limits");
        // Validate the relationships used by both languages before a remote
        // action. The JSON is bundled, so an invalid policy is a build defect.
        limits.validate();
        limits
    })
}
pub fn render_probe_collector() -> String {
    let source: serde_json::Value = serde_json::from_str(SOURCE).expect("valid bundled limits");
    let mut script = include_str!("../../shared/probe-collector.sh").to_owned();
    for (key, value) in source["collector"].as_object().expect("collector limits") {
        script = script.replace(&format!("__SB_LIMIT_{key}__"), &value.to_string());
    }
    assert!(
        !script.contains("__SB_LIMIT_"),
        "unresolved collector budget"
    );
    script
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn budgets_share_one_source_and_keep_distinct_workloads() {
        let limits = limits();
        assert_eq!(limits.schema_version, 1);
        assert!(limits.remote.collector_timeout_ms <= limits.remote.command_timeout_ms);
        assert!(limits.remote.command_timeout_ms <= limits.remote.mcp_command_max_timeout_ms);
        assert!(limits.remote.mcp_file_default_read_bytes <= limits.remote.mcp_file_max_read_bytes);
        assert!(limits.cadence.monitor_interval_ms < limits.cadence.metrics_ttl_ms);
        assert!(limits.cadence.inventory_interval_ms < limits.cadence.inventory_ttl_ms);
        assert!(limits.history.monitor_retention_ms <= limits.history.retention_ms);
        assert!(limits.history.append_chunk_points <= limits.history.max_batch_points);
        assert!(limits.history.default_query_points <= limits.history.max_query_points);
        assert!(limits.scheduler.concurrency > 0);
        assert!(limits.scheduler.default_retries <= limits.scheduler.max_retries);
        assert!(limits.scheduler.retry_delay_ms <= limits.scheduler.max_retry_delay_ms);
        assert!(render_probe_collector().contains("__SB_PROBE_SCHEMA=1"));
    }
}
