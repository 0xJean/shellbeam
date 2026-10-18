use serde_json::{json, Value};

pub(super) fn expiry_reason(expired: bool) -> Value {
    if expired {
        json!("ttl-expired")
    } else {
        Value::Null
    }
}

pub(super) fn matches_scope(
    snapshot: &Value,
    kind: &str,
    provider_id: &str,
    host_id: &str,
) -> bool {
    snapshot["provider"]["kind"].as_str() == Some(kind)
        && snapshot["provider"]["id"].as_str() == Some(provider_id)
        && snapshot["host"]["hostId"].as_str() == Some(host_id)
}

pub(super) fn observation_freshness(sampled_at: i64, received_at: i64, ttl_ms: i64) -> Value {
    let expires_at = sampled_at.saturating_add(ttl_ms.max(0));
    let expired = received_at > expires_at;
    json!({"sampledAt": sampled_at, "receivedAt": received_at, "ttlMs": ttl_ms,
        "expiresAt": expires_at, "expired": expired, "expiryReason": expiry_reason(expired)})
}

pub(super) fn primary_deadline(snapshot: &Value) -> Option<i64> {
    snapshot
        .pointer("/metrics/freshness/expiresAt")
        .and_then(Value::as_i64)
        .or_else(|| {
            snapshot
                .pointer("/inventory/freshness/expiresAt")
                .and_then(Value::as_i64)
        })
}

/// Rehydrate legacy envelopes at read time. The row deadline can shorten the
/// primary observation's TTL, but never refresh an older sample. A provider
/// failure is kept in errors/telemetry; it is not an expiry reason.
pub(super) fn refresh_snapshot(snapshot: &mut Value, row_expires_at: i64, now: i64) -> bool {
    let primary = if snapshot["metrics"].is_object() {
        "metrics"
    } else {
        "inventory"
    };
    let provider = snapshot["provider"].clone();
    let mut expired = false;
    let mut available = false;
    for section in ["metrics", "inventory"] {
        let observation = &snapshot[section];
        if observation.is_null() {
            continue;
        }
        let stamp = &observation["freshness"];
        let times = stamp["sampledAt"]
            .as_i64()
            .zip(stamp["receivedAt"].as_i64())
            .zip(stamp["ttlMs"].as_i64())
            .zip(stamp["expiresAt"].as_i64());
        let source_valid = provider["id"]
            .as_str()
            .is_some_and(|id| !id.trim().is_empty())
            && provider["kind"]
                .as_str()
                .is_some_and(|kind| ["ssh-agentless", "komari", "shellbeam-agent"].contains(&kind))
            && observation["source"]["id"] == provider["id"]
            && observation["source"]["kind"] == provider["kind"];
        let valid = times.is_some_and(|(((sample, received), ttl), deadline)| {
            sample >= 0
                && received >= sample
                && now >= sample
                && ttl >= 0
                && deadline >= sample
                && (section != primary || row_expires_at >= sample)
        });
        if !source_valid || !valid {
            snapshot[section] = Value::Null;
            if !snapshot["errors"].is_array() {
                snapshot["errors"] = json!([]);
            }
            snapshot["errors"].as_array_mut().unwrap().push(json!({
                "section": section, "code": "observation_source_invalid",
                "message": "Observation source or original freshness is unavailable"
            }));
            continue;
        }
        let (((sample, received), ttl), deadline) = times.unwrap();
        let deadline = deadline.min(sample.saturating_add(ttl));
        let deadline = if section == primary {
            deadline.min(row_expires_at)
        } else {
            deadline
        };
        // A malformed row deadline must not turn an unidentified sample healthy.
        let section_expired = now > deadline;
        snapshot[section]["freshness"] = json!({"sampledAt":sample,"receivedAt":received,
            "ttlMs":ttl,"expiresAt":deadline,"expired":section_expired,
            "expiryReason":expiry_reason(section_expired)});
        available = true;
        expired |= section_expired;
    }
    if matches!(snapshot["health"].as_str(), Some("online" | "stale")) {
        if !available {
            snapshot["health"] = json!("unknown");
        } else if expired {
            snapshot["health"] = json!("stale");
        }
    }
    primary_deadline(snapshot).is_some_and(|deadline| now > deadline)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        json!({"provider":{"kind":"komari","id":"source"},"health":"online","errors":[],
            "metrics":{"source":{"kind":"komari","id":"source"},
            "freshness":{"sampledAt":100,"receivedAt":200,"ttlMs":1000,"expiresAt":1100,"expired":false}}})
    }

    #[test]
    fn legacy_inner_and_outer_expiry_agree_without_refreshing_sample_time() {
        let mut value = snapshot();
        assert!(!refresh_snapshot(&mut value, 1100, 1100));
        assert_eq!(value["metrics"]["freshness"]["expiryReason"], Value::Null);
        assert!(refresh_snapshot(&mut value, 1100, 1101));
        assert_eq!(value["health"], "stale");
        assert_eq!(value["metrics"]["freshness"]["expiryReason"], "ttl-expired");
        assert_eq!(value["metrics"]["freshness"]["sampledAt"], 100);
        assert_eq!(value["metrics"]["freshness"]["receivedAt"], 200);
    }

    #[test]
    fn row_and_sample_ttl_can_shorten_but_never_extend_deadline() {
        let mut value = snapshot();
        value["metrics"]["freshness"]["expiresAt"] = json!(9999);
        assert!(refresh_snapshot(&mut value, 9999, 1101));
        assert_eq!(value["metrics"]["freshness"]["expiresAt"], 1100);
        let mut value = snapshot();
        assert!(refresh_snapshot(&mut value, 250, 251));
        assert_eq!(value["metrics"]["freshness"]["expiresAt"], 250);
    }

    #[test]
    fn mismatched_sources_and_future_samples_are_unknown_not_expired_observations() {
        for future in [false, true] {
            let mut value = snapshot();
            if future {
                value["metrics"]["freshness"]["sampledAt"] = json!(201);
            } else {
                value["metrics"]["source"]["id"] = json!("different");
            }
            refresh_snapshot(&mut value, 1100, 200);
            assert!(value["metrics"].is_null());
            assert_eq!(value["health"], "unknown");
            assert_eq!(value["errors"][0]["code"], "observation_source_invalid");
        }
    }

    #[test]
    fn unavailable_provider_does_not_expire_valid_data_or_erase_original_error() {
        let mut value = snapshot();
        value["health"] = json!("stale");
        value["errors"] = json!([{"code":"stale-cache-fallback"}]);
        value["metrics"]["freshness"]["expiryReason"] = json!("ttl-expired");
        assert!(!refresh_snapshot(&mut value, 1100, 300));
        assert_eq!(value["metrics"]["freshness"]["expiryReason"], Value::Null);
        assert_eq!(value["errors"][0]["code"], "stale-cache-fallback");
    }

    #[test]
    fn primary_row_does_not_shorten_separately_sampled_inventory() {
        let mut value = snapshot();
        value["inventory"] = json!({"source":{"kind":"komari","id":"source"},
            "freshness":{"sampledAt":400,"receivedAt":450,"ttlMs":1000,"expiresAt":1400,"expired":false}});
        assert!(refresh_snapshot(&mut value, 200, 500));
        assert_eq!(value["inventory"]["freshness"]["expiresAt"], 1400);
        assert!(value["inventory"]["freshness"]["expiryReason"].is_null());
    }

    #[test]
    fn invalid_primary_does_not_apply_its_row_deadline_to_valid_inventory() {
        let mut value = snapshot();
        value["metrics"]["source"]["id"] = json!("foreign-source");
        value["inventory"] = json!({"source":{"kind":"komari","id":"source"},
            "freshness":{"sampledAt":400,"receivedAt":450,"ttlMs":1000,"expiresAt":1400,"expired":false}});
        assert!(!refresh_snapshot(&mut value, 200, 500));
        assert!(value["metrics"].is_null());
        assert_eq!(primary_deadline(&value), Some(1400));
        assert_eq!(value["health"], "online");
        assert!(value["inventory"]["freshness"]["expiryReason"].is_null());
        value["inventory"]["source"]["id"] = json!("also-invalid");
        assert!(!refresh_snapshot(&mut value, 200, 500));
        assert_eq!(primary_deadline(&value), None);
        assert_eq!(value["health"], "unknown");
    }

    #[test]
    fn missing_source_kind_is_not_an_observation_and_row_scope_must_match() {
        let mut value = snapshot();
        value["host"] = json!({"hostId":"host-a"});
        assert!(matches_scope(&value, "komari", "source", "host-a"));
        assert!(!matches_scope(&value, "komari", "source", "host-b"));
        value["provider"].as_object_mut().unwrap().remove("kind");
        value["metrics"]["source"]
            .as_object_mut()
            .unwrap()
            .remove("kind");
        assert!(!matches_scope(&value, "komari", "source", "host-a"));
        assert!(!refresh_snapshot(&mut value, 1100, 200));
        assert!(value["metrics"].is_null());
        assert_eq!(value["health"], "unknown");
    }
}
