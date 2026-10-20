//! Compatibility projections over the existing Komari alert ledger.
//! Keep member IDs and audit facts intact, including when MCP is the first
//! reader after an upgrade (before the frontend normalizes the old ledger).

use serde_json::{json, Value};

fn same_scope(left: &Value, right: &Value) -> bool {
    ["integrationId", "nodeId", "hostId"]
        .iter()
        .all(|key| left[*key] == right[*key])
}

fn incident_key(alert: &Value) -> Option<&str> {
    alert["incidentKey"]
        .as_str()
        .filter(|key| !key.trim().is_empty() && key.chars().count() <= 200)
}

fn legacy_empty_retry(title: &str) -> bool {
    let Some(tail) =
        title.strip_prefix("Komari Probe provider error: Probe recovery failed after ")
    else {
        return false;
    };
    let Some((attempts, suffix)) = tail.split_once(' ') else {
        return false;
    };
    !attempts.is_empty()
        && attempts.bytes().all(|byte| byte.is_ascii_digit())
        && matches!(
            suffix,
            "retry: Komari returned no dated metric observations"
                | "retries: Komari returned no dated metric observations"
        )
}

pub(super) fn normalize(alerts: &mut [Value]) {
    for alert in alerts.iter_mut() {
        let independent_provider_failure = incident_key(alert)
            .is_some_and(|key| key.starts_with("komari-missing-observations:"))
            && alert["kind"] == "probe-error:provider"
            && matches!(alert["status"].as_str(), Some("active" | "acknowledged"))
            && !alert["title"].as_str().is_some_and(legacy_empty_retry);
        if incident_key(alert).is_none() || independent_provider_failure {
            if let Some(record) = alert.as_object_mut() {
                record.remove("incidentKey");
            }
        }
    }
    for index in 0..alerts.len() {
        let metrics = &alerts[index];
        if metrics["kind"] != "probe-error:metrics" || incident_key(metrics).is_some() {
            continue;
        }
        let missing = metrics["title"]
            .as_str()
            .is_some_and(|title| title.contains("Komari returned no dated metric observations"))
            || metrics["probeTelemetry"]["lastErrorCode"] == "empty";
        let Some(id) = metrics["alertId"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        if !missing {
            continue;
        }
        let key = format!("komari-missing-observations:{id}");
        let metrics = metrics.clone();
        alerts[index]["incidentKey"] = json!(key);
        for other in alerts.iter_mut() {
            if incident_key(other).is_some()
                || !same_scope(other, &metrics)
                || other["firstSeenAt"] != metrics["firstSeenAt"]
            {
                continue;
            }
            let unknown = other["kind"] == "probe-unknown"
                && other["title"] == "Komari Probe health is unknown";
            let retry = other["kind"] == "probe-error:provider"
                && other["title"].as_str().is_some_and(legacy_empty_retry);
            if unknown || retry {
                other["incidentKey"] = json!(key);
            }
        }
    }
}

/// The caller must authorize the initiating alert before expanding members.
/// A corrupt/imported shared key cannot cross host/node/integration identity.
pub(super) fn member_indices(alerts: &[Value], selected: usize) -> Vec<usize> {
    let Some(primary) = alerts.get(selected) else {
        return Vec::new();
    };
    alerts
        .iter()
        .enumerate()
        .filter(|(index, alert)| {
            *index == selected
                || (incident_key(primary).is_some()
                    && incident_key(primary) == incident_key(alert)
                    && same_scope(primary, alert))
        })
        .map(|(index, _)| index)
        .collect()
}

pub(super) fn project(input: &[Value]) -> Vec<Value> {
    let mut alerts = input.to_vec();
    normalize(&mut alerts);
    let mut visited = vec![false; alerts.len()];
    let mut incidents = Vec::new();
    for selected in 0..alerts.len() {
        if visited[selected] {
            continue;
        }
        let mut members = member_indices(&alerts, selected);
        for index in &members {
            visited[*index] = true;
        }
        members.sort_by(|left, right| {
            let left = &alerts[*left];
            let right = &alerts[*right];
            (right["kind"] == "probe-error:metrics")
                .cmp(&(left["kind"] == "probe-error:metrics"))
                .then_with(|| {
                    left["firstSeenAt"]
                        .as_i64()
                        .unwrap_or_default()
                        .cmp(&right["firstSeenAt"].as_i64().unwrap_or_default())
                })
                .then_with(|| left["alertId"].as_str().cmp(&right["alertId"].as_str()))
        });
        let mut incident = alerts[members[0]].clone();
        if !incident.is_object() {
            continue;
        }
        if let Some(status) = ["active", "acknowledged", "resolved", "closed"]
            .iter()
            .find(|value| {
                members
                    .iter()
                    .any(|index| alerts[*index]["status"] == **value)
            })
        {
            incident["status"] = json!(status);
        }
        // Suppress only the old retry symptom's inflated severity. A later real
        // outage remains critical, even when it shares a historical incident key.
        if let Some(severity) = ["critical", "warning", "info"].iter().find(|value| {
            members.iter().any(|index| {
                let member = &alerts[*index];
                let legacy_retry = incident_key(member)
                    .is_some_and(|key| key.starts_with("komari-missing-observations:"))
                    && member["kind"] == "probe-error:provider"
                    && member["title"].as_str().is_some_and(legacy_empty_retry);
                if legacy_retry {
                    **value == "warning"
                } else {
                    member["severity"] == **value
                }
            })
        }) {
            incident["severity"] = json!(severity);
        }
        if members.len() > 1 {
            incident["count"] = json!(1);
        }
        incident["firstSeenAt"] = json!(members
            .iter()
            .filter_map(|i| alerts[*i]["firstSeenAt"].as_i64())
            .min());
        incident["lastSeenAt"] = json!(members
            .iter()
            .filter_map(|i| alerts[*i]["lastSeenAt"].as_i64())
            .max());
        incident["memberAlertIds"] = json!(members
            .iter()
            .map(|i| &alerts[*i]["alertId"])
            .collect::<Vec<_>>());
        incidents.push(incident);
    }
    incidents
}

/// Returns audit rows only for actual state changes; repeated old member IDs
/// are still addressable without re-appending a lifecycle transition.
pub(super) fn apply_action(
    alerts: &mut [Value],
    selected: usize,
    action: &str,
    actor: &str,
    job_id: &str,
    now: i64,
) -> (Vec<String>, Vec<Value>) {
    normalize(alerts);
    let indices = member_indices(alerts, selected);
    let mut ids = Vec::new();
    let mut audit = Vec::new();
    for index in indices {
        let alert = &mut alerts[index];
        let id = alert["alertId"].as_str().unwrap_or_default().to_string();
        ids.push(id.clone());
        let changed = match action {
            "acknowledge" => alert["status"] == "active",
            "close" => alert["status"] != "closed",
            _ => false,
        };
        if !changed {
            continue;
        }
        if action == "acknowledge" {
            alert["status"] = json!("acknowledged");
            alert["acknowledgedAt"] = json!(now);
            alert["acknowledgedBy"] = json!(actor);
        } else {
            alert["status"] = json!("closed");
            alert["closedAt"] = json!(now);
        }
        if alert["relatedOperationJobId"].is_null() {
            alert["relatedOperationJobId"] = json!(job_id);
        }
        audit.push(json!({
            "auditId": format!("komari-{}-{}", action, uuid::Uuid::new_v4()),
            "alertId": id,
            "fingerprint": alert["fingerprint"],
            "event": if action == "acknowledge" { "acknowledged" } else { "closed" },
            "status": alert["status"],
            "actor": actor,
            "operationJobId": job_id,
            "at": now,
        }));
    }
    (ids, audit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy() -> Vec<Value> {
        [
            ("unknown", "probe-unknown", "Komari Probe health is unknown"),
            ("metrics", "probe-error:metrics", "Komari Probe metrics error: Komari returned no dated metric observations"),
            ("retry", "probe-error:provider", "Komari Probe provider error: Probe recovery failed after 2 retries: Komari returned no dated metric observations"),
        ].into_iter().map(|(id, kind, title)| json!({
            "alertId": id, "fingerprint": format!("old-{id}"),
            "integrationId": "integration", "nodeId": "node", "hostId": "host",
            "kind": kind, "title": title, "status": "active",
            "severity": if id == "retry" { "critical" } else { "warning" },
            "firstSeenAt": 100, "lastSeenAt": 120, "relatedOperationJobId": "previous-job",
        })).collect()
    }

    #[test]
    fn legacy_projection_preserves_ids_and_does_not_mutate_history() {
        let alerts = legacy();
        let original = alerts.clone();
        let incidents = project(&alerts);
        assert_eq!(alerts, original);
        assert_eq!(incidents.len(), 1);
        assert_eq!(incidents[0]["alertId"], "metrics");
        assert_eq!(incidents[0]["severity"], "warning");
        assert_eq!(incidents[0]["memberAlertIds"].as_array().unwrap().len(), 3);
        assert_eq!(incidents[0]["relatedOperationJobId"], "previous-job");
    }

    #[test]
    fn member_actions_have_one_job_and_are_idempotent_across_old_ids() {
        let mut alerts = legacy();
        let (ids, audit) = apply_action(&mut alerts, 0, "acknowledge", "mcp:1", "job", 200);
        assert_eq!(ids.len(), 3);
        assert_eq!(audit.len(), 3);
        assert!(audit.iter().all(|row| row["operationJobId"] == "job"));
        assert!(alerts.iter().all(|row| row["status"] == "acknowledged"));
        assert!(alerts
            .iter()
            .all(|row| row["relatedOperationJobId"] == "previous-job"));
        assert!(
            apply_action(&mut alerts, 2, "acknowledge", "mcp:1", "retry", 210)
                .1
                .is_empty()
        );
        let (_, closed) = apply_action(&mut alerts, 1, "close", "mcp:1", "close-job", 220);
        assert_eq!(closed.len(), 3);
        assert!(alerts
            .iter()
            .all(|row| row["status"] == "closed" && row["resolvedAt"].is_null()));
        assert!(apply_action(&mut alerts, 0, "close", "mcp:1", "retry", 230)
            .1
            .is_empty());
    }

    #[test]
    fn grouping_cannot_cross_scope_timestamp_or_independent_inventory_failure() {
        let mut alerts = legacy();
        let mut other_node = alerts[0].clone();
        other_node["nodeId"] = json!("other");
        let mut other_time = alerts[0].clone();
        other_time["firstSeenAt"] = json!(99);
        let mut inventory = alerts[1].clone();
        inventory["kind"] = json!("probe-error:inventory");
        inventory["alertId"] = json!("inventory");
        alerts.extend([other_node, other_time, inventory]);
        assert_eq!(project(&alerts).len(), 4);
        normalize(&mut alerts);
        alerts[3]["incidentKey"] = alerts[1]["incidentKey"].clone();
        assert_eq!(member_indices(&alerts, 1).len(), 3);
        let (_, audit) = apply_action(&mut alerts, 0, "close", "mcp", "job", 200);
        assert_eq!(audit.len(), 3);
        assert!(alerts[3..].iter().all(|row| row["status"] == "active"));
    }

    #[test]
    fn historical_missing_report_group_preserves_later_real_critical_failure() {
        let mut alerts = legacy();
        normalize(&mut alerts);
        alerts[1]["title"] = json!("Komari Probe metrics error: Host is offline");
        alerts[1]["severity"] = json!("critical");
        let incidents = project(&alerts);
        assert_eq!(incidents.len(), 1);
        assert_eq!(incidents[0]["severity"], "critical");
        assert_eq!(incidents[0]["memberAlertIds"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn independent_provider_fault_detaches_without_changing_old_identity() {
        let mut alerts = legacy();
        normalize(&mut alerts);
        alerts[2]["title"] = json!("Komari Probe provider error: Authentication failed");
        let original = alerts[2].clone();
        let incidents = project(&alerts);
        assert_eq!(incidents.len(), 2);
        assert_eq!(incidents[1]["severity"], "critical");
        let (ids, audit) = apply_action(&mut alerts, 0, "close", "mcp", "job", 200);
        assert_eq!(ids.len(), 2);
        assert_eq!(audit.len(), 2);
        assert_eq!(alerts[2]["status"], "active");
        assert_eq!(alerts[2]["alertId"], original["alertId"]);
        assert_eq!(
            alerts[2]["relatedOperationJobId"],
            original["relatedOperationJobId"]
        );
        assert!(alerts[2].get("incidentKey").is_none());
    }

    #[test]
    fn recovered_or_closed_provider_keeps_historical_incident_membership() {
        for status in ["resolved", "closed"] {
            let mut alerts = legacy();
            normalize(&mut alerts);
            for alert in &mut alerts {
                alert["status"] = json!(status);
                alert["title"] = json!("Komari monitoring data recovered");
            }
            let incidents = project(&alerts);
            assert_eq!(incidents.len(), 1);
            assert_eq!(incidents[0]["status"], status);
            assert_eq!(incidents[0]["memberAlertIds"].as_array().unwrap().len(), 3);
        }
    }
}
