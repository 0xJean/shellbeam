//! A narrow, native lifecycle for the optional monitoring runtime. Secrets only
//! travel from Vault / server to SSH stdin; never through previews or audit rows.
pub mod artifact;
mod official;
mod store;
#[cfg(test)]
mod tests;
pub mod transfer;
use super::{
    hosts::{self, HostProfile},
    komari, komari_persistence, monitoring_service as service,
};
use crate::{ssh::transport, storage::now_unix_ms, vault::VaultState};
use artifact::{fingerprint, Manifest, TrustedRelease};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use store::Record;
use tauri::Manager;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Identity {
    machine: String,
    uid: u32,
    root: String,
    architecture: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationIdentity {
    sha256: String,
    endpoint: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Legacy {
    unit: String,
    unit_sha256: String,
    executable: String,
    sha256: String,
    size_bytes: usize,
    version: String,
    config_path: Option<String>,
    config_sha256: String,
    endpoint: String,
    enabled: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    status: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    external_agent: bool,
    #[serde(default)]
    deployment: Option<String>,
    #[serde(default)]
    current: Option<Manifest>,
    #[serde(default)]
    previous: Option<Manifest>,
    #[serde(default)]
    config_sha256: Option<String>,
    #[serde(default)]
    job: Option<String>,
    #[serde(default)]
    legacy: Option<Legacy>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    previous_config_sha256: Option<String>,
    #[serde(default)]
    configuration_process_before: Option<String>,
    #[serde(default)]
    transfer: Option<TransferReceipt>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferReceipt {
    id: String,
    role: String,
    phase: String,
}
#[derive(Deserialize)]
struct RemoteResult {
    ok: bool,
    identity: Option<Identity>,
    state: Option<Observation>,
    rollback: Option<String>,
    error: Option<String>,
    code: Option<String>,
    #[serde(rename = "plannedConfig")]
    planned_config: Option<ConfigurationIdentity>,
    settings: Option<Value>,
}
#[derive(Clone)]
struct Plan {
    id: String,
    vault: String,
    session: u64,
    host: HostProfile,
    host_fingerprint: String,
    connection_id: Option<String>,
    keys: String,
    source: Option<service::Scope>,
    mapping_fingerprint: Option<String>,
    service_identity: String,
    integration: String,
    node: String,
    node_created: String,
    deployment: String,
    endpoint: String,
    identity: Identity,
    observed: Observation,
    baseline: Option<Record>,
    release: Option<TrustedRelease>,
    policy_fingerprint: Option<String>,
    action: String,
    watermark: i64,
    expires: i64,
    cancelled: Arc<AtomicBool>,
    legacy_unit: Option<String>,
    configuration: Option<ConfigurationIdentity>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    plan_id: String,
    action: String,
    host_name: String,
    node_id: String,
    endpoint: String,
    transport: String,
    account: String,
    service_scope: String,
    data_directory: String,
    artifact_bytes: Option<usize>,
    current_version: Option<String>,
    target_version: Option<String>,
    status: String,
    expires_at: i64,
    legacy_unit: Option<String>,
    previous_endpoint: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepare {
    vault_id: String,
    host_id: String,
    integration_id: String,
    action: String,
    endpoint: Option<String>,
    legacy_unit: Option<String>,
}
static PLANS: OnceLock<Mutex<HashMap<String, Plan>>> = OnceLock::new();
static BUSY: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
struct Lease(String, String);
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut set) = BUSY.get_or_init(Default::default).lock() {
            set.remove(&(self.0.clone(), self.1.clone()));
        }
    }
}
fn lease(vault: &str, host_id: &str) -> Result<Lease, String> {
    let mut set = BUSY
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "KOMARI_AGENT_BUSY")?;
    let key = (vault.to_owned(), host_id.to_owned());
    if set.len() >= 8
        || set.iter().filter(|(id, _)| id == vault).count() >= 2
        || !set.insert(key.clone())
    {
        return Err("KOMARI_AGENT_BUSY".into());
    }
    Ok(Lease(key.0, key.1))
}
fn host_connection(
    app: &tauri::AppHandle,
    vault: &str,
    id: &str,
    connection: Option<&str>,
) -> Result<(HostProfile, String), String> {
    let all = hosts::load_hosts(app, Some(vault))?;
    let h = all
        .iter()
        .find(|h| h.id == id)
        .ok_or("KOMARI_AGENT_HOST_CHANGED")?;
    let original = h;
    let mut h = h.clone();
    if let Some(id) = connection {
        if h.connections.is_none() {
            if id != h.id {
                return Err("KOMARI_AGENT_HOST_CHANGED".into());
            }
        } else {
            if !h.connections.as_ref().unwrap().iter().any(|c| c.id == id) {
                return Err("KOMARI_AGENT_HOST_CHANGED".into());
            }
            h.default_connection_id = Some(id.into());
            super::host_connections::normalize(&mut h)?;
        }
    }
    if !super::host_connections::supports_ssh(&h) {
        return Err("KOMARI_AGENT_SSH_CONNECTION".into());
    }
    let jump = h
        .jump_host_id
        .as_ref()
        .and_then(|id| all.iter().find(|h| &h.id == id));
    Ok((h.clone(), fingerprint(&(original, &h, jump))?))
}
fn mapping(
    app: &tauri::AppHandle,
    vault: &str,
    integration: &str,
    host: &str,
) -> Result<(String, String), String> {
    let state = komari_persistence::get_komari_mapping_state(
        app.clone(),
        vault.into(),
        integration.into(),
    )?;
    let m = state
        .mappings
        .iter()
        .find(|m| m.host_id == host)
        .ok_or("KOMARI_AGENT_MAPPING_REQUIRED")?;
    Uuid::parse_str(&m.node_id).map_err(|_| "KOMARI_AGENT_NODE_INVALID")?;
    Ok((m.node_id.clone(), fingerprint(&(state.revision, m))?))
}
fn check(app: &tauri::AppHandle, p: &Plan) -> Result<(), String> {
    if p.cancelled.load(Ordering::SeqCst)
        || now_unix_ms() > p.expires
        || !app.state::<VaultState>().is_unlocked(&p.vault)
        || app.state::<VaultState>().session_generation() != p.session
    {
        return Err("KOMARI_AGENT_SCOPE_CHANGED".into());
    }
    if host_connection(app, &p.vault, &p.host.id, p.connection_id.as_deref())?.1
        != p.host_fingerprint
    {
        return Err("KOMARI_AGENT_HOST_CHANGED".into());
    }
    if let Some(scope) = &p.source {
        service::check(app, scope)?;
        if mapping(app, &p.vault, &p.integration, &p.host.id)?
            != (
                p.node.clone(),
                p.mapping_fingerprint.clone().unwrap_or_default(),
            )
        {
            return Err("KOMARI_AGENT_MAPPING_CHANGED".into());
        }
    }
    if let Some(expected) = &p.policy_fingerprint {
        if fingerprint(&artifact::policy(app)?)? != *expected {
            return Err("KOMARI_AGENT_POLICY_CHANGED".into());
        }
    }
    Ok(())
}
fn rpc(remote: &service::Remote, token: &str, method: &str, node: &str) -> Result<Value, String> {
    remote.call(
        "/api/rpc2",
        Some(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":{"uuid":node}})),
        Some(token),
        None,
    )
}
fn node(remote: &service::Remote, token: &str, id: &str) -> Result<(String, String), String> {
    let v = rpc(remote, token, "admin:getClient", id)?;
    if v["uuid"].as_str() != Some(id) {
        return Err("KOMARI_AGENT_NODE_CHANGED".into());
    }
    let created = v["created_at"]
        .as_str()
        .filter(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok())
        .ok_or("KOMARI_AGENT_NODE_CHANGED")?;
    Ok((
        created.into(),
        v["version"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches('v')
            .into(),
    ))
}
fn sample(value: &Value, depth: usize) -> i64 {
    if depth > 5 {
        return 0;
    }
    if let Some(rows) = value.as_array() {
        return rows.iter().map(|r| sample(r, depth + 1)).max().unwrap_or(0);
    }
    if ["cpu", "ram", "memory", "disk", "network", "net", "load"]
        .iter()
        .any(|k| value.get(k).is_some())
    {
        return value
            .get("time")
            .or_else(|| value.get("updated_at"))
            .and_then(Value::as_str)
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
    }
    ["records", "reports", "data", "result"]
        .iter()
        .filter_map(|k| value.get(k))
        .map(|v| sample(v, depth + 1))
        .max()
        .unwrap_or(0)
}
fn recent(remote: &service::Remote, token: &str, id: &str) -> Result<i64, String> {
    Ok(sample(
        &remote.call(&format!("/api/recent/{id}"), None, Some(token), None)?,
        0,
    ))
}
fn fresh(value: i64, watermark: i64, started: i64, now: i64) -> bool {
    value > watermark && value >= started - 5_000 && value <= now + 5_000 && value >= now - 60_000
}
fn connect(app: &tauri::AppHandle, p: &Plan) -> Result<transport::Connection, String> {
    check(app, p)?;
    let route = transport::route_for_host(
        app,
        &p.vault,
        &p.host,
        &hosts::load_hosts(app, Some(&p.vault))?,
    )
    .map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    let c = transport::connect(app, &route).map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    check(app, p)?;
    if fingerprint(&c.verified_host_keys)? != p.keys {
        return Err("KOMARI_AGENT_SSH_IDENTITY_CHANGED".into());
    }
    Ok(c)
}
fn remote(
    c: &transport::Connection,
    request: &Value,
    guard: &dyn Fn() -> Result<(), String>,
) -> Result<RemoteResult, String> {
    let started = Instant::now();
    let current = || -> Result<(), String> {
        guard()?;
        if started.elapsed() > Duration::from_secs(90) {
            Err("KOMARI_AGENT_REMOTE_UNKNOWN".into())
        } else {
            Ok(())
        }
    };
    current()?;
    c.session.set_timeout(5_000);
    let mut ch = c
        .session
        .channel_session()
        .map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    // The command contains only a compiled-in helper. Credentials and artifact
    // bytes are stdin data, not shell words, process arguments or script logs.
    let code = include_str!("remote.py").replace('\'', "'\\''");
    ch.exec(&format!("python3 -I -c '{code}'"))
        .map_err(|_| "KOMARI_AGENT_REMOTE_UNKNOWN")?;
    let mut request = request.clone();
    request["legacyPins"] = legacy_pins();
    let input = serde_json::to_vec(&request).map_err(|_| "KOMARI_AGENT_REQUEST")?;
    let mut offset = 0;
    while offset < input.len() {
        current()?;
        match ch.write(&input[offset..(offset + 65536).min(input.len())]) {
            Ok(0) => return Err("KOMARI_AGENT_REMOTE_UNKNOWN".into()),
            Ok(n) => offset += n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Err("KOMARI_AGENT_REMOTE_UNKNOWN".into()),
        }
    }
    current()?;
    ch.send_eof().map_err(|_| "KOMARI_AGENT_REMOTE_UNKNOWN")?;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        current()?;
        match ch.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                bytes.extend_from_slice(&buffer[..n]);
                if bytes.len() > 131072 {
                    return Err("KOMARI_AGENT_REMOTE_UNKNOWN".into());
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Err("KOMARI_AGENT_REMOTE_UNKNOWN".into()),
        }
    }
    if bytes.len() > 131072 {
        return Err("KOMARI_AGENT_REMOTE_UNKNOWN".into());
    }
    let result: RemoteResult =
        serde_json::from_slice(&bytes).map_err(|_| "KOMARI_AGENT_REMOTE_UNKNOWN")?;
    ch.wait_close().map_err(|_| "KOMARI_AGENT_REMOTE_UNKNOWN")?;
    if ch.exit_status().unwrap_or(1) != 0 {
        return Err("KOMARI_AGENT_REMOTE_UNKNOWN".into());
    }
    if !result.ok {
        let code = match result.code.as_deref() {
            Some("external_agent_present") => "KOMARI_AGENT_EXTERNAL_AGENT",
            Some("user_manager_requires_linger") => "KOMARI_AGENT_LINGER_REQUIRED",
            Some("linux_required") => "KOMARI_AGENT_LINUX_REQUIRED",
            Some("remote_state_changed") => "KOMARI_AGENT_STATE_CHANGED",
            Some("unmanaged_service") => "KOMARI_AGENT_UNMANAGED_SERVICE",
            Some("legacy_binary_untrusted") => "KOMARI_AGENT_LEGACY_UNTRUSTED",
            Some("legacy_node_mismatch") => "KOMARI_AGENT_LEGACY_NODE_CHANGED",
            Some("legacy_state_changed" | "configuration_plan_changed") => {
                "KOMARI_AGENT_STATE_CHANGED"
            }
            Some(code) if code.starts_with("legacy_") => "KOMARI_AGENT_LEGACY_UNSUPPORTED",
            _ => "KOMARI_AGENT_REMOTE_UNKNOWN",
        };
        return Err(code.into());
    }
    Ok(result)
}
fn state(
    result: &RemoteResult,
    identity: Option<&Identity>,
) -> Result<(Identity, Observation), String> {
    let i = result
        .identity
        .clone()
        .ok_or("KOMARI_AGENT_REMOTE_UNKNOWN")?;
    let s = result.state.clone().ok_or("KOMARI_AGENT_REMOTE_UNKNOWN")?;
    if identity.is_some_and(|e| e != &i)
        || i.machine.len() != 32
        || !i.machine.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(i.architecture.as_str(), "amd64" | "arm64")
        || !matches!(
            s.status.as_str(),
            "absent"
                | "active"
                | "activating"
                | "retired"
                | "released"
                | "reserved"
                | "staged"
                | "paused"
        )
    {
        return Err("KOMARI_AGENT_IDENTITY_CHANGED".into());
    }
    if let Some(legacy) = &s.legacy {
        validate_legacy(legacy, &i.architecture)?;
    }
    Ok((i, s))
}
fn legacy_pins() -> Value {
    serde_json::from_str::<Value>(include_str!(
        "../../../../releases/compatible-probe-pins.json"
    ))
    .expect("reviewed probe pins")["versions"]
        .clone()
}
fn validate_legacy(value: &Legacy, architecture: &str) -> Result<(), String> {
    let pins = legacy_pins();
    let pin = &pins[&value.version][architecture];
    if pin["sha256"].as_str() != Some(&value.sha256)
        || pin["size"].as_u64() != Some(value.size_bytes as u64)
        || value.unit.len() > 104
        || !value.unit.ends_with(".service")
        || !value
            .unit
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        || value.unit.starts_with("shellbeam-")
        || !value.executable.starts_with('/')
        || value.executable.len() > 4096
        || [&value.unit_sha256, &value.config_sha256]
            .iter()
            .any(|v| v.len() != 64 || !v.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("KOMARI_AGENT_LEGACY_UNTRUSTED".into());
    }
    endpoint(&value.endpoint)?;
    Ok(())
}
fn inspection(p: &Plan) -> Value {
    json!({"action":"inspect", "deployment":p.deployment,"legacyUnit":p.legacy_unit})
}
fn endpoint(value: &str) -> Result<String, String> {
    let u = url::Url::parse(value).map_err(|_| "KOMARI_AGENT_ENDPOINT_INVALID")?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || value.len() > 2048
    {
        return Err("KOMARI_AGENT_ENDPOINT_INVALID".into());
    }
    Ok(value.trim_end_matches('/').into())
}
fn transport_name(h: &HostProfile) -> &str {
    if h.jump_host_id.is_some() || h.jump_host.as_ref().is_some_and(|v| !v.is_empty()) {
        "ssh-proxyjump"
    } else {
        "ssh-direct"
    }
}
#[tauri::command]
pub fn komari_agent_record(
    app: tauri::AppHandle,
    vault_id: String,
    host_id: String,
) -> Result<Option<Record>, String> {
    app.state::<VaultState>().while_unlocked(&vault_id, || {
        store::get(&store::open(&app)?, &vault_id, &host_id)
    })
}
#[tauri::command]
pub fn komari_agent_cancel(plan_id: String) -> Result<(), String> {
    transfer::cancel(&plan_id);
    if let Some(p) = PLANS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "KOMARI_AGENT_BUSY")?
        .remove(&plan_id)
    {
        p.cancelled.store(true, Ordering::SeqCst);
        if let Some(s) = p.source {
            service::monitoring_service_cancel_context(s.context_id)?;
        }
    }
    Ok(())
}
fn prepare(app: &tauri::AppHandle, input: Prepare) -> Result<Preview, String> {
    if !matches!(
        input.action.as_str(),
        "inspect"
            | "install"
            | "upgrade"
            | "rollback"
            | "uninstall"
            | "adopt"
            | "migrate"
            | "restore-config"
            | "restore-legacy"
    ) {
        return Err("KOMARI_AGENT_ACTION_INVALID".into());
    }
    let session = app.state::<VaultState>().session_generation();
    if !app.state::<VaultState>().is_unlocked(&input.vault_id) {
        return Err("KOMARI_AGENT_SCOPE_CHANGED".into());
    }
    transfer::unlocked(&store::open(app)?, &input.vault_id, &input.host_id)?;
    let baseline = store::get(&store::open(app)?, &input.vault_id, &input.host_id)?;
    if baseline.as_ref().is_some_and(|r| r.status == "migrated") {
        return Err("KOMARI_AGENT_TRANSFER_COMPLETED".into());
    }
    let connection_id = baseline.as_ref().and_then(|r| r.connection_id.clone());
    let (h, hf) = host_connection(
        app,
        &input.vault_id,
        &input.host_id,
        connection_id.as_deref(),
    )?;
    if baseline.as_ref().is_some_and(|r| {
        r.host_created_at != h.created_at || r.integration_id != input.integration_id
    }) {
        return Err("KOMARI_AGENT_IDENTITY_CHANGED".into());
    }
    if baseline
        .as_ref()
        .is_some_and(|r| matches!(r.status.as_str(), "dispatched" | "prepared" | "unknown"))
        && !matches!(
            input.action.as_str(),
            "inspect" | "uninstall" | "restore-legacy" | "restore-config"
        )
    {
        return Err("KOMARI_AGENT_READBACK_REQUIRED".into());
    }
    let deployment = baseline
        .as_ref()
        .map(|r| r.deployment.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let route = transport::route_for_host(
        app,
        &input.vault_id,
        &h,
        &hosts::load_hosts(app, Some(&input.vault_id))?,
    )
    .map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    let c = transport::connect(app, &route).map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    if !app.state::<VaultState>().is_unlocked(&input.vault_id)
        || app.state::<VaultState>().session_generation() != session
        || host_connection(app, &input.vault_id, &h.id, connection_id.as_deref())?.1 != hf
    {
        return Err("KOMARI_AGENT_SCOPE_CHANGED".into());
    }
    let keys = fingerprint(&c.verified_host_keys)?;
    if baseline.as_ref().is_some_and(|r| r.host_keys != keys) {
        return Err("KOMARI_AGENT_SSH_IDENTITY_CHANGED".into());
    }
    let legacy_unit = if input.action == "adopt" {
        Some(
            input
                .legacy_unit
                .clone()
                .unwrap_or_else(|| "komari-agent.service".into()),
        )
    } else {
        baseline
            .as_ref()
            .and_then(|r| r.observation.legacy.as_ref().map(|l| l.unit.clone()))
    };
    let target_endpoint = if input.action == "migrate" {
        Some(endpoint(
            input
                .endpoint
                .as_deref()
                .ok_or("KOMARI_AGENT_ENDPOINT_INVALID")?,
        )?)
    } else {
        None
    };
    let initial = remote(
        &c,
        &json!({"action":"inspect","deployment":deployment,"legacyUnit":legacy_unit,"targetEndpoint":target_endpoint,"restoreConfig":input.action=="restore-config"}),
        &|| {
            if app.state::<VaultState>().session_generation() != session
                || !app.state::<VaultState>().is_unlocked(&input.vault_id)
                || host_connection(app, &input.vault_id, &h.id, connection_id.as_deref())?.1 != hf
            {
                Err("KOMARI_AGENT_SCOPE_CHANGED".into())
            } else {
                Ok(())
            }
        },
    )?;
    let (identity, observed) = state(&initial, baseline.as_ref().map(|r| &r.identity))?;
    if observed.external_agent && !matches!(input.action.as_str(), "inspect" | "adopt") {
        return Err("KOMARI_AGENT_EXTERNAL_AGENT".into());
    }
    let mut p = Plan {
        id: Uuid::new_v4().to_string(),
        vault: input.vault_id,
        session,
        host: h,
        host_fingerprint: hf,
        connection_id,
        keys,
        source: None,
        mapping_fingerprint: None,
        service_identity: baseline
            .as_ref()
            .map(|r| r.service_identity.clone())
            .unwrap_or_default(),
        integration: input.integration_id,
        node: baseline
            .as_ref()
            .map(|r| r.node_id.clone())
            .unwrap_or_default(),
        node_created: baseline
            .as_ref()
            .map(|r| r.node_created_at.clone())
            .unwrap_or_default(),
        deployment,
        endpoint: baseline
            .as_ref()
            .map(|r| r.endpoint.clone())
            .unwrap_or_default(),
        identity,
        observed,
        baseline,
        release: None,
        policy_fingerprint: None,
        action: input.action,
        watermark: 0,
        expires: now_unix_ms() + 300_000,
        cancelled: Arc::new(AtomicBool::new(false)),
        legacy_unit,
        configuration: initial.planned_config.map(|mut c| {
            c.endpoint = c.endpoint.trim_end_matches('/').into();
            c
        }),
    };
    // Cleanup of an owned deployment must remain possible with the server down
    // or its source removed. Every other action rechecks the source and node.
    let result = (|| {
        if p.action != "uninstall" {
            let integration = komari::list_komari_integrations(app.clone(), p.vault.clone())?
                .into_iter()
                .find(|s| s.id == p.integration)
                .ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
            let source_identity = fingerprint(&(
                integration.id.clone(),
                integration.endpoint.clone(),
                integration.created_at,
            ))?;
            if p.baseline
                .as_ref()
                .is_some_and(|r| r.service_identity != source_identity)
            {
                return Err("KOMARI_AGENT_SOURCE_CHANGED".into());
            }
            let (node_id, mapping_id) = mapping(app, &p.vault, &p.integration, &p.host.id)?;
            p.source = Some(service::monitoring_service_context(
                app.clone(),
                integration.clone(),
            )?);
            p.mapping_fingerprint = Some(mapping_id);
            p.node = node_id;
            p.service_identity = source_identity;
            let s = p.source.as_ref().unwrap();
            let r = service::Remote::new(app, s)?;
            let token = service::secret(app, s)?;
            r.version(Some(&token))?;
            let (created, _) = node(&r, &token, &p.node)?;
            if p.baseline
                .as_ref()
                .is_some_and(|old| old.node_id != p.node || old.node_created_at != created)
            {
                return Err("KOMARI_AGENT_NODE_CHANGED".into());
            }
            p.node_created = created;
            p.watermark = recent(&r, &token, &p.node)?;
            if p.action == "install"
                && p.observed.status == "absent"
                && p.watermark >= now_unix_ms() - 60_000
            {
                return Err("KOMARI_AGENT_NODE_ALREADY_REPORTING".into());
            }
            if p.baseline.as_ref().is_none_or(|r| r.current.is_none()) {
                p.endpoint = endpoint(input.endpoint.as_deref().unwrap_or(&integration.endpoint))?;
            }
            if p.action == "adopt" {
                let config = p
                    .configuration
                    .as_ref()
                    .ok_or("KOMARI_AGENT_CONFIGURATION_CHANGED")?;
                if config.sha256.len() != 64
                    || !config.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                    || endpoint(&config.endpoint)? != p.endpoint
                {
                    return Err("KOMARI_AGENT_CONFIGURATION_CHANGED".into());
                }
                let legacy = p
                    .observed
                    .legacy
                    .as_ref()
                    .ok_or("KOMARI_AGENT_LEGACY_UNSUPPORTED")?;
                if !matches!(p.observed.status.as_str(), "absent" | "released")
                    || p.endpoint != legacy.endpoint
                {
                    return Err("KOMARI_AGENT_LEGACY_NODE_CHANGED".into());
                }
            }
        }
        if matches!(p.action.as_str(), "install" | "upgrade" | "adopt") {
            if p.action == "install" && !matches!(p.observed.status.as_str(), "absent" | "retired")
                || p.action == "upgrade"
                    && p.observed.status != "active"
                    && !(p.observed.status == "activating"
                        && p.observed.active
                        && p.baseline.as_ref().is_some_and(|r| r.status == "active"))
            {
                return Err("KOMARI_AGENT_STATE_CHANGED".into());
            }
            let policy = artifact::policy(app)?;
            p.policy_fingerprint = Some(fingerprint(&policy)?);
            let release = artifact::select(app, &policy, &p.identity.architecture)?;
            if p.action == "adopt"
                && p.observed.legacy.as_ref().is_some_and(|l| {
                    artifact::version(&l.version).unwrap_or(u64::MAX)
                        > artifact::version(&release.manifest.version).unwrap_or(0)
                })
            {
                return Err("KOMARI_AGENT_NO_UPGRADE".into());
            }
            if p.action == "upgrade"
                && p.observed.current.as_ref().is_none_or(|c| {
                    artifact::version(&c.version).unwrap_or(u64::MAX)
                        >= artifact::version(&release.manifest.version).unwrap_or(0)
                })
            {
                return Err("KOMARI_AGENT_NO_UPGRADE".into());
            }
            p.release = Some(release);
        } else if matches!(p.action.as_str(), "migrate" | "restore-config") {
            let config = p
                .configuration
                .as_ref()
                .ok_or("KOMARI_AGENT_CONFIGURATION_CHANGED")?;
            if config.sha256.len() != 64
                || !config.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || (p.action == "migrate" && !p.observed.active)
                || p.baseline.as_ref().is_none_or(|r| r.current.is_none())
                || endpoint(&config.endpoint)? == p.endpoint
            {
                return Err("KOMARI_AGENT_CONFIGURATION_CHANGED".into());
            }
            p.endpoint = endpoint(&config.endpoint)?;
        } else if p.action == "restore-legacy" {
            if p.observed.legacy.is_none()
                || matches!(p.observed.status.as_str(), "absent" | "released")
            {
                return Err("KOMARI_AGENT_LEGACY_UNSUPPORTED".into());
            }
            p.endpoint = p.observed.legacy.as_ref().unwrap().endpoint.clone();
        } else if p.action == "rollback" {
            let release = p
                .baseline
                .as_ref()
                .and_then(|r| r.previous.clone())
                .ok_or("KOMARI_AGENT_NO_ROLLBACK")?;
            artifact::verify(&release)?;
            if p.observed.previous.as_ref() != Some(&release.manifest) {
                return Err("KOMARI_AGENT_STATE_CHANGED".into());
            }
            p.release = Some(release);
        } else if p.action == "uninstall" && (p.baseline.is_none() || p.observed.status == "absent")
        {
            return Err("KOMARI_AGENT_NOT_MANAGED".into());
        }
        if let Some(old) = &p.baseline {
            validate_observation(old, &p.observed)?;
        }
        check(app, &p)?;
        Ok(())
    })();
    if let Err(e) = result {
        if let Some(s) = p.source {
            let _ = service::monitoring_service_cancel_context(s.context_id);
        }
        return Err(e);
    }
    let preview = Preview {
        plan_id: p.id.clone(),
        action: p.action.clone(),
        host_name: p.host.name.clone(),
        node_id: p.node.clone(),
        endpoint: p.endpoint.clone(),
        transport: transport_name(&p.host).into(),
        account: p.host.username.clone(),
        service_scope: if p.identity.uid == 0 {
            "system"
        } else {
            "user"
        }
        .into(),
        data_directory: p.identity.root.clone(),
        artifact_bytes: p.release.as_ref().map(|r| r.manifest.size_bytes),
        current_version: p
            .observed
            .current
            .as_ref()
            .map(|r| r.version.clone())
            .or_else(|| p.observed.legacy.as_ref().map(|l| l.version.clone())),
        target_version: if p.action == "restore-legacy" {
            p.observed.legacy.as_ref().map(|l| l.version.clone())
        } else {
            p.release
                .as_ref()
                .map(|r| r.manifest.version.clone())
                .or_else(|| p.observed.current.as_ref().map(|m| m.version.clone()))
        },
        status: p.observed.status.clone(),
        expires_at: p.expires,
        legacy_unit: p.observed.legacy.as_ref().map(|l| l.unit.clone()),
        previous_endpoint: p.baseline.as_ref().map(|r| r.endpoint.clone()),
    };
    let mut plans = PLANS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "KOMARI_AGENT_BUSY")?;
    plans.retain(|_, v| v.expires > now_unix_ms());
    if plans.len() >= 128 {
        return Err("KOMARI_AGENT_BUSY".into());
    }
    plans.insert(p.id.clone(), p);
    Ok(preview)
}
#[tauri::command]
pub async fn komari_agent_prepare(
    app: tauri::AppHandle,
    input: Prepare,
) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || prepare(&app, input))
        .await
        .map_err(|_| "KOMARI_AGENT_INTERNAL")?
}
fn known(record: &Record, manifest: &Manifest) -> Result<TrustedRelease, String> {
    let r = [&record.current, &record.previous, &record.requested]
        .into_iter()
        .flatten()
        .find(|r| &r.manifest == manifest)
        .ok_or("KOMARI_AGENT_UNTRUSTED_REMOTE_RELEASE")?;
    artifact::verify(r)?;
    Ok(r.clone())
}
fn validate_observation(record: &Record, state: &Observation) -> Result<(), String> {
    if state.status == "absent" {
        return if record.current.is_none() && record.observation.status == "absent" {
            Ok(())
        } else {
            Err("KOMARI_AGENT_MANAGED_STATE_MISSING".into())
        };
    }
    if state.deployment.as_deref() != Some(&record.deployment) {
        return Err("KOMARI_AGENT_IDENTITY_CHANGED".into());
    }
    if record.observation.legacy.is_some() && record.observation.legacy != state.legacy {
        return Err("KOMARI_AGENT_LEGACY_NODE_CHANGED".into());
    }
    if record.observation.config_sha256.is_some() && state.status != "released" {
        let sha = state
            .config_sha256
            .as_ref()
            .ok_or("KOMARI_AGENT_CONFIGURATION_CHANGED")?;
        let config =
            known_configuration(record, sha).ok_or("KOMARI_AGENT_CONFIGURATION_CHANGED")?;
        if state
            .endpoint
            .as_ref()
            .is_some_and(|e| endpoint(e).ok().as_deref() != Some(config.endpoint.as_str()))
        {
            return Err("KOMARI_AGENT_CONFIGURATION_CHANGED".into());
        }
    }
    for m in [&state.current, &state.previous].into_iter().flatten() {
        known(record, m)?;
    }
    Ok(())
}
fn known_configuration(record: &Record, sha: &str) -> Option<ConfigurationIdentity> {
    [
        &record.configuration,
        &record.previous_configuration,
        &record.requested_configuration,
    ]
    .into_iter()
    .flatten()
    .find(|c| c.sha256 == sha)
    .cloned()
    .or_else(|| {
        (record.observation.config_sha256.as_deref() == Some(sha)).then(|| ConfigurationIdentity {
            sha256: sha.into(),
            endpoint: record.endpoint.clone(),
        })
    })
}
fn apply_observation(record: &mut Record, state: Observation) -> Result<(), String> {
    validate_observation(record, &state)?;
    if state.status == "released" {
        record.endpoint = state
            .legacy
            .as_ref()
            .ok_or("KOMARI_AGENT_LEGACY_NODE_CHANGED")?
            .endpoint
            .clone();
    }
    if let Some(sha) = &state.config_sha256 {
        let config = known_configuration(record, sha).unwrap_or(ConfigurationIdentity {
            sha256: sha.clone(),
            endpoint: record.endpoint.clone(),
        });
        record.previous_configuration = state
            .previous_config_sha256
            .as_deref()
            .and_then(|s| known_configuration(record, s));
        record.endpoint = config.endpoint.clone();
        record.configuration = Some(config);
    }
    let current = state
        .current
        .as_ref()
        .map(|m| known(record, m))
        .transpose()?;
    let previous = state
        .previous
        .as_ref()
        .map(|m| known(record, m))
        .transpose()?;
    record.current = current;
    record.previous = previous;
    record.observation = state;
    Ok(())
}
fn same_activation(expected: &Observation, actual: &Observation) -> bool {
    let mut copy = expected.clone();
    copy.active = actual.active;
    copy == *actual
}
fn verify_report(
    app: &tauri::AppHandle,
    p: &Plan,
    connection: &transport::Connection,
    expected_state: &Observation,
    watermark: i64,
    started: i64,
) -> Result<i64, String> {
    let expected_version = if expected_state.status == "released" {
        &expected_state
            .legacy
            .as_ref()
            .ok_or("KOMARI_AGENT_REMOTE_UNKNOWN")?
            .version
    } else {
        &expected_state
            .current
            .as_ref()
            .ok_or("KOMARI_AGENT_REMOTE_UNKNOWN")?
            .version
    };
    let scope = p.source.as_ref().ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
    let api = service::Remote::new(app, scope)?;
    let token = service::secret(app, scope)?;
    let start = Instant::now();
    loop {
        check(app, p)?;
        let (created, version) = node(&api, &token, &p.node)?;
        if created != p.node_created {
            return Err("KOMARI_AGENT_NODE_CHANGED".into());
        }
        let observed = recent(&api, &token, &p.node)?;
        if &version == expected_version && fresh(observed, watermark, started, now_unix_ms()) {
            let result = remote(connection, &inspection(p), &|| check(app, p))?;
            let (_, latest) = state(&result, Some(&p.identity))?;
            if (latest.status != "released" && !latest.active)
                || !same_activation(expected_state, &latest)
            {
                return Err("KOMARI_AGENT_PROCESS_NOT_VERIFIED".into());
            }
            if fresh(observed, watermark, started, now_unix_ms()) {
                return Ok(observed);
            }
        }
        if start.elapsed() > Duration::from_secs(45) {
            return Err("KOMARI_AGENT_REPORT_NOT_VERIFIED".into());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
fn operate(app: &tauri::AppHandle, id: &str, confirmed: bool) -> Result<Record, String> {
    let p = PLANS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "KOMARI_AGENT_BUSY")?
        .get(id)
        .cloned()
        .ok_or("KOMARI_AGENT_SCOPE_CHANGED")?;
    if p.action != "inspect" && !confirmed {
        return Err("KOMARI_AGENT_CONFIRMATION_REQUIRED".into());
    }
    let _lease = lease(&p.vault, &p.host.id)?;
    transfer::unlocked(&store::open(app)?, &p.vault, &p.host.id)?;
    check(app, &p)?;
    let expected = p.baseline.as_ref().map_or(0, |r| r.revision);
    if store::get(&store::open(app)?, &p.vault, &p.host.id)?.map_or(0, |r| r.revision) != expected {
        return Err("KOMARI_AGENT_STATE_CHANGED".into());
    }
    let c = connect(app, &p)?;
    let (_, observed) = state(
        &remote(&c, &inspection(&p), &|| check(app, &p))?,
        Some(&p.identity),
    )?;
    if observed != p.observed {
        return Err("KOMARI_AGENT_STATE_CHANGED".into());
    }
    let mut record = p.baseline.clone().unwrap_or(Record {
        vault_id: p.vault.clone(),
        host_id: p.host.id.clone(),
        host_created_at: p.host.created_at,
        integration_id: p.integration.clone(),
        service_identity: p.service_identity.clone(),
        node_id: p.node.clone(),
        node_created_at: p.node_created.clone(),
        deployment: p.deployment.clone(),
        revision: 0,
        identity: p.identity.clone(),
        host_keys: p.keys.clone(),
        endpoint: p.endpoint.clone(),
        status: "prepared".into(),
        action: p.action.clone(),
        job_id: String::new(),
        current: None,
        previous: None,
        requested: None,
        observation: observed.clone(),
        watermark: p.watermark,
        observed_at: None,
        updated_at: now_unix_ms(),
        error_code: None,
        configuration: None,
        previous_configuration: None,
        requested_configuration: None,
        connection_id: p.connection_id.clone(),
    });
    if p.baseline.is_none() {
        record.endpoint = p.endpoint.clone();
    }
    if p.configuration.is_some() {
        record.requested_configuration = p.configuration.clone();
    }
    record.action = p.action.clone();
    record.status = "prepared".into();
    record.error_code = None;
    if p.release.is_some() {
        record.requested = p.release.clone();
    }
    check(app, &p)?;
    app.state::<VaultState>().while_unlocked(&p.vault, || {
        store::begin(
            &mut store::open(app)?,
            &mut record,
            &p.host,
            transport_name(&p.host),
            expected,
        )
    })?;
    let mut dispatched = false;
    let outcome = (|| {
        let mut response = None;
        if p.action != "inspect" {
            let bytes = if matches!(p.action.as_str(), "install" | "upgrade" | "adopt") {
                Some(artifact::download(
                    p.release.as_ref().unwrap(),
                    &artifact::policy(app)?,
                )?)
            } else {
                None
            };
            let mut configuration = Value::Null;
            let mut agent_token = String::new();
            let mut watermark = p.watermark;
            if let Some(s) = &p.source {
                let r = service::Remote::new(app, s)?;
                let token = service::secret(app, s)?;
                if node(&r, &token, &p.node)?.0 != p.node_created {
                    return Err("KOMARI_AGENT_NODE_CHANGED".into());
                }
                watermark = recent(&r, &token, &p.node)?;
                if (p.action == "install" && observed.status == "absent")
                    || matches!(p.action.as_str(), "adopt" | "migrate" | "restore-config")
                {
                    if p.action == "install" && watermark >= now_unix_ms() - 60_000 {
                        return Err("KOMARI_AGENT_NODE_ALREADY_REPORTING".into());
                    }
                    let v = rpc(&r, &token, "admin:getClientToken", &p.node)?;
                    agent_token = v["token"]
                        .as_str()
                        .filter(|v| !v.is_empty() && v.len() <= 4096)
                        .ok_or("KOMARI_AGENT_NODE_AUTH_REQUIRED")?
                        .to_owned();
                    configuration = json!({"endpoint":p.endpoint,"token":agent_token,"disable_auto_update":true,"disable_web_ssh":true,"interval":5,"info_report_interval":1,"month_rotate":0,"get_ip_addr_from_nic":true});
                }
            }
            let request = json!({"action":p.action,"deployment":p.deployment,"identity":p.identity,"expected":observed,"job":record.job_id,"release":p.release.as_ref().map(|r|&r.manifest),"bytes":bytes,"configuration":configuration,"legacyUnit":p.legacy_unit,"agentToken":agent_token,"plannedConfig":p.configuration,"targetEndpoint":if p.action=="migrate"{Some(&p.endpoint)}else{None},"restoreConfig":p.action=="restore-config"});
            check(app, &p)?;
            record.status = "dispatched".into();
            record.watermark = watermark;
            store::save(&mut store::open(app)?, &mut record, None)?;
            check(app, &p)?;
            dispatched = true;
            let result = remote(&c, &request, &|| check(app, &p))?;
            let (_, state) = state(&result, Some(&p.identity))?;
            apply_observation(&mut record, state)?;
            response = Some(result);
        } else if observed.status != "absent" {
            apply_observation(&mut record, observed)?;
        } else {
            record.observation = observed;
        }
        check(app, &p)?;
        if p.action == "uninstall" || record.observation.status == "retired" {
            if record.observation.status != "retired" || record.observation.active {
                return Err("KOMARI_AGENT_UNINSTALL_NOT_VERIFIED".into());
            }
            record.status = "retired".into();
            record.observed_at = Some(now_unix_ms());
        } else if record.observation.status == "absent" {
            record.status = "absent".into();
            record.observed_at = Some(now_unix_ms());
        } else {
            if !record.observation.active && record.observation.status != "released" {
                return Err("KOMARI_AGENT_PROCESS_NOT_VERIFIED".into());
            }
            let started = now_unix_ms();
            match verify_report(app, &p, &c, &record.observation, record.watermark, started) {
                Ok(time) => {
                    record.observed_at = Some(time);
                    record.status = if record.observation.status == "released" {
                        "released"
                    } else {
                        "active"
                    }
                    .into();
                }
                Err(error) => {
                    // A failed activation is compensated only on this still-valid
                    // context and exact remote journal. A lost scope never replays.
                    if matches!(
                        p.action.as_str(),
                        "install" | "upgrade" | "rollback" | "adopt" | "migrate" | "restore-config"
                    ) && response
                        .as_ref()
                        .is_some_and(|r| r.rollback.as_deref() == Some("not-needed"))
                    {
                        check(app, &p)?;
                        let latest = remote(&c, &inspection(&p), &|| check(app, &p))?;
                        let (_, latest) = state(&latest, Some(&p.identity))?;
                        if !same_activation(&record.observation, &latest) {
                            return Err("KOMARI_AGENT_STATE_CHANGED".into());
                        }
                        record.observation = latest;
                        let rollback = record.previous.clone();
                        let action = if p.action == "adopt" {
                            "restore-legacy"
                        } else if matches!(p.action.as_str(), "migrate" | "restore-config") {
                            "restore-config"
                        } else if rollback.is_some() && p.observed.status != "retired" {
                            "rollback"
                        } else {
                            "uninstall"
                        };
                        let restore_config = if action == "restore-config" {
                            Some(
                                record
                                    .previous_configuration
                                    .clone()
                                    .ok_or("KOMARI_AGENT_CONFIGURATION_CHANGED")?,
                            )
                        } else {
                            None
                        };
                        let token = if action == "restore-config" {
                            let s = p.source.as_ref().ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
                            let r = service::Remote::new(app, s)?;
                            let secret = service::secret(app, s)?;
                            rpc(&r, &secret, "admin:getClientToken", &p.node)?["token"]
                                .as_str()
                                .ok_or("KOMARI_AGENT_NODE_AUTH_REQUIRED")?
                                .to_owned()
                        } else {
                            String::new()
                        };
                        let result = remote(
                            &c,
                            &json!({"action":action,"deployment":p.deployment,"identity":p.identity,"expected":record.observation,"job":record.job_id,"release":rollback.as_ref().map(|r|&r.manifest),"restoreConfig":action=="restore-config","plannedConfig":restore_config,"agentToken":token}),
                            &|| check(app, &p),
                        )?;
                        let (_, s) = state(&result, Some(&p.identity))?;
                        apply_observation(&mut record, s)?;
                        if matches!(action, "rollback" | "restore-config" | "restore-legacy") {
                            record.observed_at = Some(verify_report(
                                app,
                                &p,
                                &c,
                                &record.observation,
                                record.watermark,
                                now_unix_ms(),
                            )?);
                        }
                        if action == "uninstall"
                            && (record.observation.active || record.observation.status != "retired")
                        {
                            return Err("KOMARI_AGENT_ROLLBACK_UNKNOWN".into());
                        }
                        record.status = "rolled-back".into();
                    }
                    return Err(error);
                }
            }
        }
        if response.as_ref().is_some_and(|r| r.error.is_some()) {
            record.status = "rolled-back".into();
            return Err("KOMARI_AGENT_ACTIVATION_FAILED".into());
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => store::save(&mut store::open(app)?, &mut record, Some("completed"))?,
        Err(code) => {
            record.error_code = Some(safe_error(&code));
            if record.status != "rolled-back" {
                record.status = if dispatched { "unknown" } else { "failed" }.into();
            }
            let status = if record.status == "unknown" {
                "unknown"
            } else {
                "failed"
            };
            store::save(&mut store::open(app)?, &mut record, Some(status))?;
        }
    }
    let _ = komari_agent_cancel(id.into());
    Ok(record)
}
fn safe_error(value: &str) -> String {
    if value.len() < 96 && value.bytes().all(|c| c.is_ascii_uppercase() || c == b'_') {
        value.into()
    } else {
        "KOMARI_AGENT_OPERATION_FAILED".into()
    }
}
#[tauri::command]
pub async fn komari_agent_operate(
    app: tauri::AppHandle,
    plan_id: String,
    confirmed: bool,
) -> Result<Record, String> {
    tauri::async_runtime::spawn_blocking(move || operate(&app, &plan_id, confirmed))
        .await
        .map_err(|_| "KOMARI_AGENT_INTERNAL")?
}
