//! Fixed, reviewed extension packages only. A durable encrypted checkpoint is
//! required before replacing/deleting any code or state. Recovery is read-only.
use super::monitoring_service::Remote;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};

pub const SHORT: &str = "shellbeam-alerts";
pub const CURRENT: &str = "0.2.0";
const PACKAGE: &[u8] = include_bytes!("../../resources/monitoring-extension.zip");
const NAMES: [&str; 3] = ["komari-plugin.json", "policy.cjs", "server.cjs"];
const CURRENT_FILES: [&[u8]; 3] = [
    include_bytes!("../../../monitoring-extension/komari-plugin.json"),
    include_bytes!("../../../monitoring-extension/policy.cjs"),
    include_bytes!("../../../monitoring-extension/server.cjs"),
];
const OLD_FILES: [&[u8]; 3] = [
    include_bytes!("../../../monitoring-extension/releases/0.1.0/komari-plugin.json"),
    include_bytes!("../../../monitoring-extension/releases/0.1.0/policy.cjs"),
    include_bytes!("../../../monitoring-extension/releases/0.1.0/server.cjs"),
];
const LIMIT: usize = 1024 * 1024;
fn failure() -> String {
    "MONITORING_EXTENSION_MISMATCH".into()
}
pub fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn files(version: &str) -> Result<[&'static [u8]; 3], String> {
    match version {
        CURRENT => Ok(CURRENT_FILES),
        "0.1.0" => Ok(OLD_FILES),
        _ => Err(failure()),
    }
}
pub trait Transport {
    fn call(&self, path: &str, body: Option<&Value>) -> Result<Value, String>;
    fn file(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
    fn install(&self, bytes: Vec<u8>, expected: Option<&Snapshot>) -> Result<(), String>;
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: String,
    pub state: Value,
    pub configuration: Value,
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub operation: String,
    pub nonce: String,
    pub stage: String,
    pub baseline: Value,
    pub backup: Option<Snapshot>,
    #[serde(default)]
    pub previous_nonce: Option<String>,
}
pub fn validate_state(state: &Value) -> Result<(), String> {
    if state.to_string().len() > LIMIT
        || state["version"] != 1
        || !state["identity"]
            .as_str()
            .is_some_and(|s| s.len() == 48 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        || !state["revision"].as_u64().is_some_and(|n| n > 0)
        || !state["evaluations"].is_object()
        || !state["policy"].is_object()
        || !state["events"].as_array().is_some_and(|a| a.len() <= 500)
        || !state["receipts"].as_array().is_some_and(|a| a.len() <= 500)
    {
        return Err(failure());
    }
    let mut policy = state["policy"].clone();
    policy["extension_identity"] = state["identity"].clone();
    policy["revision"] = state["revision"].clone();
    super::monitoring_load_policy::validate(&policy).map_err(|_| failure())
}
fn json_file(io: &impl Transport, name: &str) -> Result<Option<Value>, String> {
    io.file(name)?
        .map(|b| serde_json::from_slice(&b).map_err(|_| failure()))
        .transpose()
}
fn known(io: &impl Transport) -> Result<String, String> {
    let mut got = Vec::new();
    for name in NAMES {
        got.push(io.file(name)?.ok_or_else(failure)?);
    }
    for version in [CURRENT, "0.1.0"] {
        if got.iter().zip(files(version)?).all(|(a, b)| a == b) {
            return Ok(version.into());
        }
    }
    Err(failure())
}
pub fn inspect(io: &impl Transport) -> Result<Value, String> {
    let version = io.call("/api/version", None)?;
    if version["version"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        != "1.6.0"
    {
        return Err("MONITORING_UNSUPPORTED".into());
    }
    let list = io.call("/api/admin/plugin/list", None)?;
    let entries: Vec<_> = list
        .as_array()
        .ok_or_else(failure)?
        .iter()
        .filter(|r| r["short"] == SHORT)
        .collect();
    if entries.is_empty() {
        return Ok(json!({"installed":false,"enabled":false,"running":false}));
    }
    if entries.len() != 1 {
        return Err(failure());
    }
    let version = known(io)?;
    let state = json_file(io, "state.json")?.ok_or_else(failure)?;
    validate_state(&state)?;
    let info = entries[0];
    Ok(
        json!({"installed":true,"version":version,"enabled":info["enabled"] == true,"running":info["running"] == true,
        "identity":state["identity"],"revision":state["revision"],"stateHash":hash(&state)}),
    )
}
fn bound(a: &Value, b: &Value) -> bool {
    ["installed", "version", "identity", "revision"]
        .iter()
        .all(|k| a[*k] == b[*k])
}
fn config(io: &impl Transport) -> Result<Value, String> {
    let v = io.call(
        &format!("/api/admin/plugin/configuration?short={SHORT}"),
        None,
    )?;
    v.get("data")
        .filter(|v| v.is_object() && v.to_string().len() <= 65536)
        .cloned()
        .ok_or_else(failure)
}
fn stopped(io: &impl Transport, snapshot: &Snapshot) -> Result<(), String> {
    let current = inspect(io)?;
    if current["version"] != snapshot.version
        || current["identity"] != snapshot.state["identity"]
        || current["enabled"] != false
        || current["running"] != false
        || current["stateHash"] != hash(&snapshot.state)
        || config(io)? != snapshot.configuration
    {
        return Err("MONITORING_CONFLICT".into());
    }
    Ok(())
}
fn enabled(io: &impl Transport, value: bool) -> Result<(), String> {
    io.call(
        "/api/admin/plugin/enabled",
        Some(&json!({"short":SHORT,"enabled":value,"approved":true})),
    )
    .map(|_| ())
}
/// Receipt is local operation provenance, never a remote action authorization.
fn receipt(io: &impl Transport, nonce: &str) -> Result<bool, String> {
    Ok(json_file(io, "shellbeam-lifecycle.json")?.is_some_and(|v| v["nonce"] == nonce))
}
pub fn archive(snapshot: &Snapshot, version: &str, nonce: &str) -> Result<Vec<u8>, String> {
    validate_state(&snapshot.state)?;
    if nonce.len() != 36 || !nonce.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(failure());
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let option = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o600);
    let sources = files(version)?;
    let state = snapshot.state.to_string();
    let proof = json!({"nonce":nonce,"stateHash":hash(&snapshot.state)}).to_string();
    for (name, bytes) in NAMES.into_iter().zip(sources).chain([
        ("state.json", state.as_bytes()),
        ("shellbeam-lifecycle.json", proof.as_bytes()),
    ]) {
        zip.start_file(name, option).map_err(|_| failure())?;
        zip.write_all(bytes).map_err(|_| failure())?;
    }
    Ok(zip.finish().map_err(|_| failure())?.into_inner())
}
pub fn prepare(io: &impl Transport, operation: &str) -> Result<Checkpoint, String> {
    if !matches!(operation, "upgrade" | "uninstall") {
        return Err("MONITORING_UNSUPPORTED".into());
    }
    let baseline = inspect(io)?;
    if baseline["installed"] != true {
        return Err("MONITORING_EXTENSION_REQUIRED".into());
    }
    if operation == "upgrade" && baseline["version"] == CURRENT {
        return Err("MONITORING_NO_CHANGES".into());
    }
    Ok(Checkpoint {
        operation: operation.into(),
        nonce: uuid::Uuid::new_v4().to_string(),
        stage: "prepared".into(),
        baseline,
        backup: None,
        previous_nonce: None,
    })
}
pub fn restore(original: &Checkpoint) -> Result<Checkpoint, String> {
    let backup = original
        .backup
        .clone()
        .ok_or("MONITORING_BACKUP_REQUIRED")?;
    validate_state(&backup.state)?;
    files(&backup.version)?;
    Ok(Checkpoint {
        operation: "restore".into(),
        nonce: uuid::Uuid::new_v4().to_string(),
        stage: "prepared".into(),
        baseline: original.baseline.clone(),
        backup: Some(backup),
        previous_nonce: Some(original.nonce.clone()),
    })
}
/// Called only from a freshly authorized prepared intent. save() must commit
/// encrypted backup and an audit dispatch boundary before each remote mutation.
pub fn apply(
    io: &impl Transport,
    cp: &mut Checkpoint,
    mut save: impl FnMut(&Checkpoint) -> Result<(), String>,
) -> Result<(), String> {
    if cp.backup.is_none() {
        let current = inspect(io)?;
        if !bound(&cp.baseline, &current)
            || (cp.stage == "prepared"
                && (current["enabled"] != cp.baseline["enabled"]
                    || current["running"] != cp.baseline["running"]))
        {
            return Err("MONITORING_SCOPE_CHANGED".into());
        }
        cp.stage = "stop-dispatched".into();
        save(cp)?;
        enabled(io, false)?;
        let after = inspect(io)?;
        if !bound(&cp.baseline, &after) || after["enabled"] != false || after["running"] != false {
            return Err("MONITORING_CONFLICT".into());
        }
        let state = json_file(io, "state.json")?.ok_or_else(failure)?;
        validate_state(&state)?;
        let snapshot = Snapshot {
            version: after["version"].as_str().ok_or_else(failure)?.into(),
            state,
            configuration: config(io)?,
            enabled: cp.baseline["enabled"] == true,
        };
        stopped(io, &snapshot)?;
        cp.backup = Some(snapshot);
        cp.stage = "backed-up".into();
        save(cp)?;
    }
    let backup = cp
        .backup
        .as_ref()
        .ok_or("MONITORING_BACKUP_REQUIRED")?
        .clone();
    validate_state(&backup.state)?;
    let current = inspect(io)?;
    if cp.operation == "uninstall" {
        stopped(io, &backup)?;
        cp.stage = "delete-dispatched".into();
        save(cp)?;
        io.call("/api/admin/plugin/delete", Some(&json!({"short":SHORT})))?;
        if inspect(io)?["installed"] != false {
            return Err("MONITORING_READBACK_REQUIRED".into());
        }
        return Ok(());
    }
    let target = if cp.operation == "restore" {
        backup.version.as_str()
    } else {
        CURRENT
    };
    let own_target =
        current["installed"] == true && current["version"] == target && receipt(io, &cp.nonce)?;
    if !own_target {
        let expected = if current["installed"] == true {
            // Restoration only replaces an unchanged, stopped operation result.
            // Never overwrite newer observations or third-party configuration.
            let mut expected = backup.clone();
            if cp.operation == "restore" && current["version"] != backup.version {
                if !receipt(io, cp.previous_nonce.as_deref().unwrap_or(""))? {
                    return Err("MONITORING_CONFLICT".into());
                }
                expected.version = current["version"].as_str().ok_or_else(failure)?.into();
            }
            stopped(io, &expected)?;
            Some(expected)
        } else {
            None
        };
        // A disappeared source during upgrade is not permission to recreate it;
        // an explicitly confirmed restore is required.
        if expected.is_none() && cp.operation != "restore" {
            return Err("MONITORING_SCOPE_CHANGED".into());
        }
        let bytes = archive(&backup, target, &cp.nonce)?;
        cp.stage = "replace-dispatched".into();
        save(cp)?;
        io.install(bytes, expected.as_ref())?;
    }
    let after = inspect(io)?;
    if after["version"] != target
        || after["identity"] != backup.state["identity"]
        || !receipt(io, &cp.nonce)?
    {
        return Err(failure());
    }
    if after["enabled"] == false {
        if after["stateHash"] != hash(&backup.state) {
            return Err("MONITORING_CONFLICT".into());
        }
        cp.stage = "configuration-dispatched".into();
        save(cp)?;
        io.call(
            "/api/admin/plugin/configuration",
            Some(&json!({"short":SHORT,"data":backup.configuration})),
        )?;
        if config(io)? != backup.configuration {
            return Err("MONITORING_READBACK_REQUIRED".into());
        }
        cp.stage = "start-dispatched".into();
        save(cp)?;
        enabled(io, backup.enabled)?;
    }
    if !verified(io, cp)? {
        return Err("MONITORING_READBACK_REQUIRED".into());
    }
    Ok(())
}
pub fn verified(io: &impl Transport, cp: &Checkpoint) -> Result<bool, String> {
    let current = inspect(io)?;
    if cp.operation == "uninstall" {
        return Ok(cp.stage == "delete-dispatched"
            && cp.backup.is_some()
            && current["installed"] == false);
    }
    let Some(backup) = &cp.backup else {
        return Ok(false);
    };
    let target = if cp.operation == "restore" {
        backup.version.as_str()
    } else {
        CURRENT
    };
    if current["version"] != target
        || current["identity"] != backup.state["identity"]
        || !receipt(io, &cp.nonce)?
        || current["enabled"] != backup.enabled
        || current["running"] != backup.enabled
        || config(io)? != backup.configuration
    {
        return Ok(false);
    }
    if backup.enabled && target == CURRENT {
        let runtime = io.call("/api/shellbeam-alerts/v1/lifecycle", None)?;
        if runtime["version"] != target || runtime["identity"] != backup.state["identity"] {
            return Ok(false);
        }
    }
    Ok(true)
}

pub struct Connection<'a, 'b> {
    pub remote: &'a Remote<'b>,
    pub token: &'a str,
}
pub(super) struct Wire<'a> {
    pub client: &'a reqwest::blocking::Client,
    pub endpoint: &'a str,
    pub token: &'a str,
    pub guard: &'a dyn Fn() -> Result<(), String>,
}
impl Connection<'_, '_> {
    fn with<T>(&self, action: impl FnOnce(&Wire) -> Result<T, String>) -> Result<T, String> {
        let guard =
            || super::monitoring_service::check(self.remote.app, self.remote.scope).map(|_| ());
        action(&Wire {
            client: &self.remote.client,
            endpoint: &self.remote.endpoint,
            token: self.token,
            guard: &guard,
        })
    }
}
impl Transport for Connection<'_, '_> {
    fn call(&self, path: &str, body: Option<&Value>) -> Result<Value, String> {
        self.with(|io| io.call(path, body))
    }
    fn file(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        self.with(|io| io.file(name))
    }
    fn install(&self, bytes: Vec<u8>, expected: Option<&Snapshot>) -> Result<(), String> {
        self.with(|io| io.install(bytes, expected))
    }
}
impl Transport for Wire<'_> {
    fn call(&self, path: &str, body: Option<&Value>) -> Result<Value, String> {
        (self.guard)()?;
        let result = super::monitoring_service::exchange(
            self.client,
            self.endpoint,
            path,
            body,
            Some(self.token),
            None,
        );
        (self.guard)()?;
        result
    }
    fn file(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        if !NAMES.contains(&name) && !["state.json", "shellbeam-lifecycle.json"].contains(&name) {
            return Err(failure());
        }
        (self.guard)()?;
        let response = self
            .client
            .get(format!("{}/api/admin/plugin/{SHORT}/{name}", self.endpoint))
            .bearer_auth(self.token)
            .send()
            .map_err(|_| "MONITORING_NETWORK")?;
        (self.guard)()?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if response.status().as_u16() != 200 {
            return Err("MONITORING_PERMISSION".into());
        }
        let mut bytes = Vec::new();
        response
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "MONITORING_NETWORK")?;
        (self.guard)()?;
        if bytes.len() > LIMIT {
            return Err(failure());
        }
        Ok(Some(bytes))
    }
    fn install(&self, bytes: Vec<u8>, expected: Option<&Snapshot>) -> Result<(), String> {
        let upload = self.call(
            "/api/admin/upload/init",
            Some(&json!({"purpose":"plugin","filename":"shellbeam-alerts.zip","size":bytes.len()})),
        )?;
        let id = upload["upload_id"]
            .as_str()
            .filter(|s| {
                s.len() <= 64
                    && !s.is_empty()
                    && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            .ok_or_else(failure)?;
        let result = (|| {
            let boundary = "shellbeam-monitoring-extension-archive";
            let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"upload_id\"\r\n\r\n{id}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"chunk_index\"\r\n\r\n0\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"chunk_data\"; filename=\"shellbeam-alerts.zip\"\r\nContent-Type: application/zip\r\n\r\n").into_bytes();
            body.extend(bytes);
            body.extend(format!("\r\n--{boundary}--\r\n").bytes());
            (self.guard)()?;
            let response = self
                .client
                .post(format!("{}/api/admin/upload/chunk", self.endpoint))
                .bearer_auth(self.token)
                .header(
                    "Content-Type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(body)
                .send()
                .map_err(|_| "MONITORING_NETWORK")?;
            if response.status().as_u16() != 200 {
                return Err("MONITORING_REQUEST_FAILED".into());
            }
            if let Some(snapshot) = expected {
                stopped(self, snapshot)?;
            } else {
                let list = self.call("/api/admin/plugin/list", None)?;
                if list
                    .as_array()
                    .ok_or_else(failure)?
                    .iter()
                    .any(|r| r["short"] == SHORT)
                {
                    return Err("MONITORING_CONFLICT".into());
                }
            }
            self.call("/api/admin/upload/merge", Some(&json!({"upload_id":id})))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = self.call("/api/admin/upload/cancel", Some(&json!({"upload_id":id})));
        }
        result
    }
}
impl Remote<'_> {
    pub(super) fn extension_status(&self, token: &str) -> Result<Value, String> {
        let io = Connection {
            remote: self,
            token,
        };
        let version = io.call("/api/version", None)?;
        if version["version"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches('v')
            != "1.6.0"
        {
            return Err("MONITORING_UNSUPPORTED".into());
        }
        let list = io.call("/api/admin/plugin/list", None)?;
        if let Some(info) = list
            .as_array()
            .ok_or_else(failure)?
            .iter()
            .find(|r| r["short"] == SHORT)
        {
            known(&io)?;
            Ok(
                json!({"installed":true,"enabled":info["enabled"] == true && info["running"] == true}),
            )
        } else {
            Ok(json!({"installed":false,"enabled":false}))
        }
    }

    pub(super) fn require_extension(&self, token: &str) -> Result<(), String> {
        if self.extension_status(token)?["enabled"] != true {
            return Err("MONITORING_EXTENSION_REQUIRED".into());
        }
        Ok(())
    }
    pub(super) fn enable_extension(&self, token: &str) -> Result<(), String> {
        let io = Connection {
            remote: self,
            token,
        };
        let version = io.call("/api/version", None)?;
        if version["version"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches('v')
            != "1.6.0"
        {
            return Err("MONITORING_UNSUPPORTED".into());
        }
        let list = io.call("/api/admin/plugin/list", None)?;
        if !list
            .as_array()
            .ok_or_else(failure)?
            .iter()
            .any(|r| r["short"] == SHORT)
        {
            io.install(PACKAGE.to_vec(), None)?;
        }
        known(&io)?;
        enabled(&io, true)
    }
}

#[cfg(test)]
#[path = "monitoring_extension_tests.rs"]
pub(super) mod tests;
