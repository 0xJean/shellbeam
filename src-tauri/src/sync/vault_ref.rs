//! Vault references carried by device-sync requests.
//!
//! Vault ids are random per device (except the default "personal"), so every
//! request that moves data names its vault as `"vault": {"id", "name"}` and the
//! receiving side maps it onto a local vault with `resolve_peer_vault`. Requests
//! from older app versions carry no `vault` param and keep using Personal.

use serde_json::Value;

use crate::vault::meta::{find_vault, resolve_peer_vault, DEFAULT_VAULT_ID};

/// Param / payload key holding the vault reference.
pub(crate) const VAULT_PARAM: &str = "vault";

/// Trimmed vault id, falling back to Personal when missing or blank.
pub(crate) fn normalize_vault_id(vault_id: Option<&str>) -> String {
    vault_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_VAULT_ID)
        .to_string()
}

/// `(id, name)` of the vault named in request params; Personal when absent.
pub(crate) fn vault_ref_from_params(params: Option<&Value>) -> (String, String) {
    let vault = params.and_then(|p| p.get(VAULT_PARAM));
    let field = |key: &str| {
        vault
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    let id = normalize_vault_id(Some(&field("id")));
    let name = if id == DEFAULT_VAULT_ID {
        String::new()
    } else {
        field("name")
    };
    (id, name)
}

pub(crate) fn vault_ref_json(id: &str, name: &str) -> Value {
    serde_json::json!({ "id": id, "name": name })
}

/// Look up a local vault for an outgoing request; errors if the id is unknown.
pub(crate) fn local_vault_ref(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<(String, String), String> {
    let id = normalize_vault_id(vault_id);
    match find_vault(app, &id)? {
        Some(meta) => Ok((meta.id, meta.name)),
        None if id == DEFAULT_VAULT_ID => Ok((id, "Personal".to_string())),
        None => Err(format!("Vault \"{id}\" not found")),
    }
}

/// Map the vault named in request params onto a local vault id.
/// When it is missing and `create` is off, the error names the other device,
/// since the message travels back to the device that asked.
pub(crate) fn resolve_vault_param(
    app: &tauri::AppHandle,
    params: Option<&Value>,
    create: bool,
) -> Result<String, String> {
    let (id, name) = vault_ref_from_params(params);
    resolve_peer_vault(app, &id, &name, create).map_err(|e| {
        if !create && e.contains("does not exist") {
            let label = if name.is_empty() { &id } else { &name };
            format!("Vault \"{label}\" does not exist on the other device")
        } else {
            e
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_vault_param_falls_back_to_personal() {
        assert_eq!(
            vault_ref_from_params(None),
            ("personal".to_string(), String::new())
        );
        let params = serde_json::json!({ "includeHosts": true });
        assert_eq!(
            vault_ref_from_params(Some(&params)),
            ("personal".to_string(), String::new())
        );
        let params = serde_json::json!({ "vault": { "id": "  ", "name": "Work" } });
        assert_eq!(vault_ref_from_params(Some(&params)).0, "personal");
        let params = serde_json::json!({ "vault": "not-an-object" });
        assert_eq!(vault_ref_from_params(Some(&params)).0, "personal");
    }

    #[test]
    fn vault_param_is_read_and_trimmed() {
        let params = serde_json::json!({ "vault": { "id": " abc-123 ", "name": " Work " } });
        assert_eq!(
            vault_ref_from_params(Some(&params)),
            ("abc-123".to_string(), "Work".to_string())
        );
        let params = serde_json::json!({ "vault": { "id": "abc-123" } });
        assert_eq!(
            vault_ref_from_params(Some(&params)),
            ("abc-123".to_string(), String::new())
        );
    }

    #[test]
    fn vault_ref_json_round_trips() {
        let params = serde_json::json!({ "vault": vault_ref_json("abc", "Team") });
        assert_eq!(
            vault_ref_from_params(Some(&params)),
            ("abc".to_string(), "Team".to_string())
        );
    }

    #[test]
    fn normalize_vault_id_defaults_to_personal() {
        assert_eq!(normalize_vault_id(None), "personal");
        assert_eq!(normalize_vault_id(Some("")), "personal");
        assert_eq!(normalize_vault_id(Some(" x ")), "x");
    }
}
