use serde_json::Value;
use std::collections::HashSet;
fn text(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty() && s.encode_utf16().count() <= max && !s.chars().any(char::is_control)
    })
}
fn id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 80
            && !["__proto__", "constructor", "prototype"].contains(&s)
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    })
}
fn integer(v: &Value, min: u64, max: u64) -> bool {
    v.as_u64().is_some_and(|n| n >= min && n <= max)
}
pub fn validate(value: &Value) -> Result<(), String> {
    let invalid = || "MONITORING_INVALID_EDIT".to_string();
    if !text(&value["extension_identity"], 128)
        || !integer(&value["revision"], 1, 9_007_199_254_740_991)
    {
        return Err(invalid());
    }
    let rules = value["rules"]
        .as_array()
        .filter(|r| r.len() <= 64)
        .ok_or_else(invalid)?;
    let silences = value["silences"]
        .as_array()
        .filter(|r| r.len() <= 64)
        .ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    for r in rules {
        let threshold = r["threshold"].as_f64().ok_or_else(invalid)?;
        let recovery = r["recovery"].as_f64().ok_or_else(invalid)?;
        if !id(&r["id"])
            || !ids.insert(r["id"].as_str().unwrap())
            || !text(&r["name"], 120)
            || !id(&r["nodeId"])
            || !text(&r["nodeCreatedAt"], 120)
            || !matches!(
                r["metric"].as_str(),
                Some("cpu" | "memory" | "disk" | "load1")
            )
            || !r["enabled"].is_boolean()
            || threshold <= 0.0
            || threshold
                > if r["metric"] == "load1" {
                    100000.0
                } else {
                    100.0
                }
            || recovery < 0.0
            || recovery >= threshold
            || !integer(&r["durationSeconds"], 0, 86400)
            || !integer(&r["recoverySeconds"], 0, 86400)
        {
            return Err(invalid());
        }
    }
    let mut silence_ids = HashSet::new();
    for s in silences {
        let selected = s["ruleIds"].as_array().ok_or_else(invalid)?;
        let selected_ids: HashSet<_> = selected.iter().filter_map(Value::as_str).collect();
        if !id(&s["id"])
            || !silence_ids.insert(s["id"].as_str().unwrap())
            || !text(&s["name"], 120)
            || !s["enabled"].is_boolean()
            || selected_ids.len() != selected.len()
            || selected_ids.iter().any(|i| !ids.contains(i))
        {
            return Err(invalid());
        }
        match s["kind"].as_str() {
            Some("once") => {
                let start = s["startAt"].as_u64().ok_or_else(invalid)?;
                let end = s["endAt"].as_u64().ok_or_else(invalid)?;
                if start == 0
                    || end <= start
                    || end > 8_640_000_000_000_000
                    || end - start > 366 * 86400000
                {
                    return Err(invalid());
                }
            }
            Some("weekly") => {
                let days = s["days"]
                    .as_array()
                    .filter(|d| !d.is_empty() && d.len() <= 7)
                    .ok_or_else(invalid)?;
                let unique: HashSet<_> = days.iter().filter_map(Value::as_u64).collect();
                if unique.len() != days.len()
                    || unique.iter().any(|d| *d > 6)
                    || !integer(&s["startMinute"], 0, 1439)
                    || !integer(&s["endMinute"], 0, 1439)
                    || s["startMinute"] == s["endMinute"]
                    || s["timezone"] != "UTC"
                {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn policy_validates_identity_windows_targets_and_bounds() {
        let mut v =
            json!({"extension_identity":"server-original","revision":1,"rules":[],"silences":[]});
        validate(&v).unwrap();
        v["silences"] = json!([{"id":"s","name":"night","enabled":true,"ruleIds":[],"kind":"weekly","timezone":"UTC","days":[4],"startMinute":1380,"endMinute":60}]);
        validate(&v).unwrap();
        v["silences"][0]["ruleIds"] = json!(["missing"]);
        assert!(validate(&v).is_err());
        v["silences"][0]["ruleIds"] = json!([]);
        v["silences"][0]["days"] = json!([4, 4]);
        assert!(validate(&v).is_err());
        v["silences"] = json!([]);
        v["revision"] = json!(0);
        assert!(validate(&v).is_err());
    }
}
