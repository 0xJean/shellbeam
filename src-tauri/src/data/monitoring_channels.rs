//! Schema-bound channel editing. Unknown fields are retained, never rendered as
//! HTML, and cannot be changed without a supported declaration from the server.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const IDENTITY: &str = "__shellbeam_channel_identity";
pub const SCHEMA: &str = "__shellbeam_channel_schema";
pub fn channel_id(target: &str) -> Result<&str, String> {
    let id = target
        .strip_prefix("channel:")
        .ok_or("MONITORING_UNSUPPORTED")?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        return Err("MONITORING_UNSUPPORTED".into());
    }
    Ok(id)
}
pub fn read(id: &str, response: Value) -> Result<Value, String> {
    let schema = response
        .get("configuration")
        .filter(|v| v.is_object())
        .ok_or("MONITORING_INVALID_RESPONSE")?;
    let mut data = response["data"]
        .as_object()
        .cloned()
        .ok_or("MONITORING_INVALID_RESPONSE")?;
    if data.contains_key(IDENTITY) || data.contains_key(SCHEMA) {
        return Err("MONITORING_UNSUPPORTED".into());
    }
    let hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([id, schema])).map_err(|_| "MONITORING_INVALID_RESPONSE")?
        )
    );
    data.insert(IDENTITY.into(), json!(hash));
    data.insert(SCHEMA.into(), schema.clone());
    Ok(Value::Object(data))
}
pub fn validate(baseline: &Value, desired: &Value) -> Result<(), String> {
    if baseline[IDENTITY] != desired[IDENTITY]
        || baseline[SCHEMA] != desired[SCHEMA]
        || !baseline[IDENTITY].is_string()
    {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    let schema = &baseline[SCHEMA];
    if !matches!(schema["type"].as_str(), None | Some("" | "managed")) {
        return Err("MONITORING_UNSUPPORTED".into());
    }
    let fields = schema["data"]
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or("MONITORING_UNSUPPORTED")?;
    let before = baseline.as_object().ok_or("MONITORING_INVALID_EDIT")?;
    let after = desired.as_object().ok_or("MONITORING_INVALID_EDIT")?;
    if before.keys().any(|k| !after.contains_key(k)) {
        return Err("MONITORING_INVALID_EDIT".into());
    }
    for (key, value) in after {
        if before.get(key) == Some(value) {
            continue;
        }
        let declarations: Vec<_> = fields
            .iter()
            .filter(|f| f["key"].as_str() == Some(key))
            .collect();
        if declarations.len() != 1 {
            return Err("MONITORING_INVALID_EDIT".into());
        }
        let field = declarations[0];
        let valid = match field["type"].as_str() {
            Some("string" | "textbox" | "richtext") => value.as_str().is_some_and(|s| {
                s.len() <= 32768 && (field["required"] != true || !s.trim().is_empty())
            }),
            Some("number") => value.as_f64().is_some_and(f64::is_finite),
            Some("switch") => value.is_boolean(),
            Some("select") => value.as_str().is_some_and(|v| {
                field["options"]
                    .as_str()
                    .is_some_and(|s| s.split(',').any(|x| x.trim() == v))
            }),
            Some("nodes") => value.as_array().is_some_and(|rows| {
                rows.len() <= 256
                    && rows.iter().all(|v| {
                        v.as_str().is_some_and(|s| {
                            s.len() <= 80
                                && !s.is_empty()
                                && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                        })
                    })
            }),
            Some("pingtasks") => value.as_array().is_some_and(|rows| {
                rows.len() <= 256 && rows.iter().all(|v| v.as_u64().is_some_and(|n| n > 0))
            }),
            _ => false,
        };
        if !valid {
            return Err("MONITORING_INVALID_EDIT".into());
        }
    }
    Ok(())
}
pub fn payload(values: &Value) -> Result<Value, String> {
    let mut data = values
        .as_object()
        .cloned()
        .ok_or("MONITORING_INVALID_EDIT")?;
    let schema = data.remove(SCHEMA).ok_or("MONITORING_SCOPE_CHANGED")?;
    data.remove(IDENTITY);
    // Upstream resolves selector JSON strings on reads, but expects JSON strings
    // in storage. Encode them on write; leaving arrays would erase selections.
    if let Some(fields) = schema["data"].as_array() {
        for field in fields {
            if matches!(field["type"].as_str(), Some("nodes" | "pingtasks")) {
                if let Some(key) = field["key"].as_str() {
                    if let Some(value) = data.get_mut(key) {
                        if value.is_array() {
                            *value = json!(value.to_string());
                        }
                    }
                }
            }
        }
    }
    Ok(Value::Object(data))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value {
        read("mail", json!({"configuration":{"type":"managed","data":[{"key":"token","type":"string","required":true},{"key":"mode","type":"select","options":"email,telegram"},{"key":"nodes","type":"nodes"}]},"data":{"token":"old","mode":"email","nodes":["node-a"],"extra":{"preserved":true}}})).unwrap()
    }
    #[test]
    fn schema_bound_edit_keeps_unknown_values_and_encodes_selectors() {
        let base = config();
        let mut next = base.clone();
        next["token"] = json!("new");
        validate(&base, &next).unwrap();
        let wire = payload(&next).unwrap();
        assert_eq!(wire["extra"], base["extra"]);
        assert_eq!(wire["nodes"], "[\"node-a\"]");
        assert!(wire.get(IDENTITY).is_none());
        next["extra"] = json!({});
        assert!(validate(&base, &next).is_err());
    }
    #[test]
    fn rejects_schema_tampering_unknown_types_and_invalid_options() {
        let base = config();
        let mut next = base.clone();
        next["mode"] = json!("invalid");
        assert!(validate(&base, &next).is_err());
        next = base.clone();
        next[SCHEMA]["data"][0]["type"] = json!("raw");
        assert!(validate(&base, &next).is_err());
        assert!(channel_id("channel:mail?other=x").is_err());
        assert!(read(
            "mail",
            json!({"configuration":{},"data":{IDENTITY:"collision"}})
        )
        .is_err());
    }
}
