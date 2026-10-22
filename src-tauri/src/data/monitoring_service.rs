//! Native monitoring administration. Only verified 1.6 contracts are exposed;
//! remote responses and secret-bearing configuration never enter the audit.
use super::{
    komari::{self, KomariIntegration},
    monitoring_channels as channels,
    operation_jobs::{self as jobs, CreateOperationJobRequest, UpdateOperationJobRequest},
};
use crate::{
    storage::{data_file_path, now_unix_ms},
    vault::{self, VaultState},
};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::Manager;
use uuid::Uuid;

const SETTINGS: &[&str] = &[
    "sitename",
    "description",
    "private_site",
    "notification_enabled",
    "notification_method",
    "notification_template",
    "login_notification",
    "expire_notification_enabled",
    "expire_notification_lead_days",
    "traffic_limit_percentage",
];
const WEBHOOK: &[&str] = &[
    "url",
    "method",
    "content_type",
    "headers",
    "body",
    "username",
    "password",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub vault_id: String,
    pub integration_id: String,
    pub config_version: i64,
    pub session: u64,
    pub context_id: String,
    pub configuration_identity: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub scope: Scope,
    pub action: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub id: String,
    pub revision: Option<i64>,
    pub baseline: Option<Value>,
    pub desired: Option<Value>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub two_factor: Option<String>,
    pub metric_dsn: Option<String>,
    #[serde(default)]
    pub confirmed: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    id: String,
    scope: Scope,
    target: String,
    revision: i64,
    status: String,
    job_id: String,
    updated_at: i64,
    observed_at: i64,
    error_code: Option<String>,
    #[serde(skip)]
    sealed: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Edit {
    baseline: Value,
    desired: Value,
    observed: Value,
}

fn err(_: impl std::fmt::Display) -> String {
    "MONITORING_STORAGE".into()
}
fn db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db = jobs::open_database(&data_file_path(app, "operation_jobs.sqlite3")?)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(err)?;
    initialize(&db)?;
    Ok(db)
}
fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS monitoring_service_intents (
        id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, integration_id TEXT NOT NULL,
        body TEXT NOT NULL, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS monitoring_service_scope ON monitoring_service_intents(vault_id,integration_id,updated_at);").map_err(err)?;
    Ok(())
}
static CONTEXTS: OnceLock<Mutex<HashMap<String, (String, String, i64, u64, i64, String)>>> =
    OnceLock::new();
#[tauri::command]
pub fn monitoring_service_context(
    app: tauri::AppHandle,
    expected: KomariIntegration,
) -> Result<Scope, String> {
    let vault_id = expected.vault_id.clone();
    let integration_id = expected.id.clone();
    let config_version = expected.updated_at;
    let configuration_identity = configuration_identity(&expected)?;
    let state = app.state::<VaultState>();
    if !state.is_unlocked(&vault_id) {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    let context_id = Uuid::new_v4().to_string();
    let session = state.session_generation();
    let scope = Scope {
        vault_id,
        integration_id,
        config_version,
        session,
        context_id: context_id.clone(),
        configuration_identity: configuration_identity.clone(),
    };
    let mut contexts = CONTEXTS.get_or_init(Default::default).lock().map_err(err)?;
    contexts.retain(|_, v| v.4 > now_unix_ms());
    if contexts.len() >= 256 {
        return Err("MONITORING_BUSY".into());
    }
    contexts.insert(
        context_id,
        (
            scope.vault_id.clone(),
            scope.integration_id.clone(),
            config_version,
            session,
            now_unix_ms() + 300_000,
            configuration_identity,
        ),
    );
    drop(contexts);
    if let Err(error) = check(&app, &scope) {
        monitoring_service_cancel_context(scope.context_id.clone())?;
        return Err(error);
    }
    Ok(scope)
}
#[tauri::command]
pub fn monitoring_service_cancel_context(context_id: String) -> Result<(), String> {
    CONTEXTS
        .get_or_init(Default::default)
        .lock()
        .map_err(err)?
        .remove(&context_id);
    Ok(())
}
fn configuration_identity(service: &KomariIntegration) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(service).map_err(err)?)
    ))
}
pub(crate) fn check(app: &tauri::AppHandle, scope: &Scope) -> Result<KomariIntegration, String> {
    let valid = CONTEXTS
        .get_or_init(Default::default)
        .lock()
        .map_err(err)?
        .get(&scope.context_id)
        .is_some_and(|v| {
            v.0 == scope.vault_id
                && v.1 == scope.integration_id
                && v.2 == scope.config_version
                && v.3 == scope.session
                && v.4 > now_unix_ms()
                && v.5 == scope.configuration_identity
        });
    if !valid {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    let state = app.state::<VaultState>();
    if !state.is_unlocked(&scope.vault_id) || state.session_generation() != scope.session {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    komari::list_komari_integrations(app.clone(), scope.vault_id.clone())?
        .into_iter()
        .find(|v| {
            v.id == scope.integration_id
                && v.updated_at == scope.config_version
                && configuration_identity(v).ok().as_deref()
                    == Some(scope.configuration_identity.as_str())
        })
        .ok_or_else(|| "MONITORING_SCOPE_CHANGED".into())
}
pub(crate) fn secret(app: &tauri::AppHandle, scope: &Scope) -> Result<String, String> {
    let integration = check(app, scope)?;
    vault::get_secret_value(
        app,
        &app.state::<VaultState>(),
        &scope.vault_id,
        &integration.credential_ref,
    )?
    .filter(|s| !s.trim().is_empty())
    .ok_or_else(|| "MONITORING_AUTH_REQUIRED".into())
}
fn exchange(
    client: &Client,
    endpoint: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
    cookie: Option<&str>,
) -> Result<Value, String> {
    let url = format!("{}{path}", endpoint);
    let mut req = if body.is_some() {
        client.post(url)
    } else {
        client.get(url)
    };
    req = req.header("Accept", "application/json");
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    if let Some(cookie) = cookie {
        req = req.header("Cookie", cookie);
    }
    if let Some(body) = body {
        req = req
            .header("Content-Type", "application/json")
            .body(body.to_string());
    }
    let response = req.send().map_err(|_| "MONITORING_NETWORK")?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(match status {
            401 | 403 => "MONITORING_PERMISSION",
            404 => "MONITORING_UNSUPPORTED",
            409 => "MONITORING_CONFLICT",
            _ => "MONITORING_REQUEST_FAILED",
        }
        .into());
    }
    let mut bytes = Vec::new();
    response
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "MONITORING_NETWORK")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("MONITORING_INVALID_RESPONSE".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "MONITORING_INVALID_RESPONSE")?;
    if value.get("error").is_some_and(|e| !e.is_null())
        || value.get("status").and_then(Value::as_str) == Some("error")
    {
        return Err("MONITORING_REQUEST_FAILED".into());
    }
    Ok(value
        .get("data")
        .or_else(|| value.get("result"))
        .cloned()
        .unwrap_or(value))
}
pub(crate) struct Remote<'a> {
    pub(super) app: &'a tauri::AppHandle,
    pub(super) scope: &'a Scope,
    pub(super) endpoint: String,
    pub(super) client: Client,
}
impl<'a> Remote<'a> {
    pub(crate) fn new(app: &'a tauri::AppHandle, scope: &'a Scope) -> Result<Self, String> {
        let integration = check(app, scope)?;
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "MONITORING_NETWORK")?;
        Ok(Self {
            app,
            scope,
            endpoint: integration.endpoint,
            client,
        })
    }
    pub(crate) fn call(
        &self,
        path: &str,
        body: Option<&Value>,
        token: Option<&str>,
        cookie: Option<&str>,
    ) -> Result<Value, String> {
        check(self.app, self.scope)?;
        let result = exchange(&self.client, &self.endpoint, path, body, token, cookie);
        check(self.app, self.scope)?;
        result
    }
    pub(crate) fn version(&self, token: Option<&str>) -> Result<(), String> {
        let v = self.call("/api/version", None, token, None)?;
        let v = v["version"].as_str().unwrap_or("").trim_start_matches('v');
        if !v.starts_with("1.6.")
            || !v[4..]
                .split(['-', '+'])
                .next()
                .unwrap_or("")
                .chars()
                .all(|c| c.is_ascii_digit())
            || v.len() <= 4
        {
            return Err("MONITORING_UNSUPPORTED".into());
        }
        Ok(())
    }
    fn read(&self, target: &str, token: &str) -> Result<Value, String> {
        match target {
            "settings" => {
                let v = self.call("/api/admin/settings/", None, Some(token), None)?;
                let mut out = serde_json::Map::new();
                for k in SETTINGS {
                    if let Some(x) = v.get(*k) {
                        out.insert(k.to_string(), x.clone());
                    }
                }
                Ok(Value::Object(out))
            }
            "webhook" => {
                let v = self.call(
                    "/api/admin/notification/channel/configuration?id=webhook",
                    None,
                    Some(token),
                    None,
                )?;
                v.get("data")
                    .filter(|v| v.is_object())
                    .cloned()
                    .ok_or_else(|| "MONITORING_INVALID_RESPONSE".into())
            }
            target if target.starts_with("channel:") => {
                let id = channels::channel_id(target)?;
                let response = self.call(
                    &format!(
                        "/api/admin/notification/channel/configuration?id={}",
                        urlencoding::encode(id)
                    ),
                    None,
                    Some(token),
                    None,
                )?;
                channels::read(id, response)
            }
            "extension" => self.extension_status(token),
            "load-policy" => {
                self.require_extension(token)?;
                self.call("/api/shellbeam-alerts/v1/policy", None, Some(token), None)
            }
            target if target.starts_with("retention:") => {
                let name = &target[10..];
                let definitions=self.call("/api/rpc2",Some(&json!({"jsonrpc":"2.0","id":1,"method":"admin:listMetricDefinitions","params":{}})),Some(token),None)?;
                let metric = definitions
                    .as_array()
                    .and_then(|rows| rows.iter().find(|row| row["name"].as_str() == Some(name)))
                    .ok_or("MONITORING_UNSUPPORTED")?;
                let created = metric["created_at"]
                    .as_str()
                    .ok_or("MONITORING_INVALID_RESPONSE")?;
                Ok(
                    json!({"retention_days":metric["retention_days"],"metric_identity":format!("{name}:{created}")}),
                )
            }
            _ => Err("MONITORING_UNSUPPORTED".into()),
        }
    }
    fn write(&self, target: &str, value: &Value, token: &str) -> Result<(), String> {
        if target == "extension" {
            return self.enable_extension(token);
        }
        let (path, body) = match target {
            "settings" => ("/api/admin/settings/", value.clone()),
            "webhook" => (
                "/api/admin/notification/channel/configuration",
                json!({"id":"webhook","data":value}),
            ),
            target if target.starts_with("channel:") => (
                "/api/admin/notification/channel/configuration",
                json!({"id":channels::channel_id(target)?, "data":channels::payload(value)?}),
            ),
            "load-policy" => ("/api/shellbeam-alerts/v1/policy", value.clone()),
            target if target.starts_with("retention:") => (
                "/api/rpc2",
                json!({"jsonrpc":"2.0","id":1,"method":"admin:updateMetricDefinition","params":{"name":&target[10..],"retention_days":value["retention_days"]}}),
            ),
            _ => return Err("MONITORING_UNSUPPORTED".into()),
        };
        self.call(path, Some(&body), Some(token), None).map(|_| ())
    }
}
fn changed(edit: &Edit) -> Vec<String> {
    edit.desired
        .as_object()
        .into_iter()
        .flat_map(|o| o.keys())
        .filter(|k| edit.baseline.get(*k) != edit.desired.get(*k))
        .cloned()
        .collect()
}
fn same_object(a: &Value, b: &Value) -> bool {
    [
        "metric_identity",
        channels::IDENTITY,
        channels::SCHEMA,
        "extension_identity",
    ]
    .iter()
    .all(|k| a.get(*k) == b.get(*k))
}
fn matches_desired(edit: &Edit, remote: &Value) -> bool {
    if !same_object(&edit.baseline, remote) {
        return false;
    }
    changed(edit)
        .iter()
        .all(|k| remote.get(k) == edit.desired.get(k))
}
fn merge(edit: &Edit, remote: &Value) -> Result<Value, String> {
    if !same_object(&edit.baseline, remote) {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    let mut next = remote
        .as_object()
        .cloned()
        .ok_or("MONITORING_INVALID_RESPONSE")?;
    for k in changed(edit) {
        if remote.get(&k) != edit.baseline.get(&k) && remote.get(&k) != edit.desired.get(&k) {
            return Err("MONITORING_CONFLICT".into());
        }
        next.insert(k.clone(), edit.desired[&k].clone());
    }
    Ok(Value::Object(next))
}
fn validate(target: &str, edit: &Edit) -> Result<(), String> {
    if !edit.baseline.is_object()
        || !edit.desired.is_object()
        || edit.desired.to_string().len() > 65536
    {
        return Err("MONITORING_INVALID_EDIT".into());
    }
    if target.starts_with("channel:") {
        channels::channel_id(target)?;
        channels::validate(&edit.baseline, &edit.desired)?;
        return if changed(edit).is_empty() {
            Err("MONITORING_NO_CHANGES".into())
        } else {
            Ok(())
        };
    }
    if target == "load-policy" {
        super::monitoring_load_policy::validate(&edit.desired)?;
    }
    let allowed = match target {
        "settings" => SETTINGS,
        "webhook" => WEBHOOK,
        "load-policy" => &["rules", "silences"],
        "extension" => &["installed", "enabled"],
        name if name.starts_with("retention:")
            && name.len() <= 200
            && name[10..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            && name.len() > 10 =>
        {
            &["retention_days"]
        }
        _ => return Err("MONITORING_UNSUPPORTED".into()),
    };
    if edit
        .baseline
        .as_object()
        .unwrap()
        .keys()
        .any(|k| !edit.desired.as_object().unwrap().contains_key(k))
    {
        return Err("MONITORING_INVALID_EDIT".into());
    }
    for k in changed(edit) {
        if !allowed.contains(&k.as_str()) {
            return Err("MONITORING_INVALID_EDIT".into());
        }
        let v = &edit.desired[&k];
        let valid = match k.as_str() {
            "installed" | "enabled" => v == true,
            "rules" | "silences" => v.as_array().is_some_and(|r| r.len() <= 64),
            "private_site"
            | "notification_enabled"
            | "login_notification"
            | "expire_notification_enabled" => v.is_boolean(),
            "retention_days" => v.as_u64().is_some_and(|n| (1..=3650).contains(&n)),
            "expire_notification_lead_days" => v.as_u64().is_some_and(|n| n <= 365),
            "traffic_limit_percentage" => v.as_f64().is_some_and(|n| n > 0.0 && n <= 100.0),
            "method" => matches!(v.as_str(), Some("POST" | "GET")),
            "url" => v
                .as_str()
                .and_then(|v| url::Url::parse(v).ok())
                .is_some_and(|u| {
                    matches!(u.scheme(), "http" | "https")
                        && u.username().is_empty()
                        && u.password().is_none()
                }),
            "headers" => v.as_str().is_some_and(|s| {
                s.is_empty()
                    || serde_json::from_str::<Value>(s)
                        .ok()
                        .and_then(|v| v.as_object().cloned())
                        .is_some_and(|o| o.values().all(Value::is_string))
            }),
            _ => v.as_str().is_some_and(|s| s.len() <= 32768),
        };
        if !valid {
            return Err("MONITORING_INVALID_EDIT".into());
        }
    }
    if changed(edit).is_empty() {
        return Err("MONITORING_NO_CHANGES".into());
    }
    Ok(())
}
fn load(conn: &Connection, id: &str, scope: &Scope) -> Result<Intent, String> {
    let row:Option<(String,String)>=conn.query_row("SELECT body,sealed FROM monitoring_service_intents WHERE id=?1 AND vault_id=?2 AND integration_id=?3",params![id,scope.vault_id,scope.integration_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    let (body, sealed) = row.ok_or("MONITORING_INTENT_MISSING")?;
    let mut row: Intent = serde_json::from_str(&body).map_err(err)?;
    row.sealed = sealed;
    Ok(row)
}
fn store(conn: &Connection, row: &Intent) -> Result<(), String> {
    conn.execute("INSERT INTO monitoring_service_intents(id,vault_id,integration_id,body,sealed,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET body=excluded.body,sealed=excluded.sealed,updated_at=excluded.updated_at",params![row.id,row.scope.vault_id,row.scope.integration_id,serde_json::to_string(row).map_err(err)?,row.sealed,row.updated_at]).map_err(err)?;
    Ok(())
}
fn create_job(
    conn: &Connection,
    scope: &Scope,
    target: &str,
    action: &str,
    risk: &str,
) -> Result<String, String> {
    let confirmation_required = matches!(
        action,
        "monitoring.service.update"
            | "monitoring.service.initialize"
            | "monitoring.notification.test"
    );
    let job = jobs::create_on(
        conn,
        CreateOperationJobRequest {
            host_id: None,
            vault_id: Some(scope.vault_id.clone()),
            host_name: None,
            host_address: None,
            username: None,
            source: "monitor".into(),
            actor: Some("monitoring-service".into()),
            action: action.into(),
            target: format!("{}:{target}", scope.integration_id),
            risk: risk.into(),
            provider: Some("komari".into()),
            transport: Some("monitoring-api".into()),
            params_summary: Some("Native monitoring service operation; values encrypted".into()),
            confirmation_required,
            request_id: None,
        },
    )?;
    if confirmation_required {
        jobs::update_on(
            conn,
            UpdateOperationJobRequest {
                job_id: job.job_id.clone(),
                status: "queued".into(),
                confirmation_status: Some("confirmed".into()),
                confirmed_by: Some("user".into()),
                result_summary: Some("User confirmed the native service operation".into()),
                error_code: None,
                error_summary: None,
                actor: Some("user".into()),
            },
        )?;
    }
    Ok(job.job_id)
}
fn job_status(conn: &Connection, id: &str, status: &str, summary: &str) -> Result<(), String> {
    jobs::update_on(
        conn,
        UpdateOperationJobRequest {
            job_id: id.into(),
            status: status.into(),
            confirmation_status: None,
            confirmed_by: None,
            result_summary: Some(summary.into()),
            error_code: None,
            error_summary: None,
            actor: Some("monitoring-service".into()),
        },
    )
    .map(|_| ())
}
fn seal(app: &tauri::AppHandle, scope: &Scope, edit: &Edit) -> Result<String, String> {
    vault::seal_operation_value(
        &app.state::<VaultState>(),
        &scope.vault_id,
        &serde_json::to_string(edit).map_err(err)?,
    )
}
fn decode(app: &tauri::AppHandle, row: &Intent) -> Result<Edit, String> {
    serde_json::from_str(&vault::open_operation_value(
        &app.state::<VaultState>(),
        &row.scope.vault_id,
        &row.sealed,
    )?)
    .map_err(err)
}
fn view(row: &Intent, edit: &Edit) -> Value {
    json!({"intent":row,"baseline":edit.baseline,"desired":edit.desired,"observed":edit.observed})
}
fn transaction<T>(
    app: &tauri::AppHandle,
    scope: &Scope,
    operation: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    check(app, scope)?;
    let state = app.state::<VaultState>();
    state.while_unlocked(&scope.vault_id, || {
        if state.session_generation() != scope.session {
            return Err("MONITORING_SCOPE_CHANGED".into());
        }
        let mut conn = db(app)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let result = operation(&tx)?;
        tx.commit().map_err(err)?;
        Ok(result)
    })
}
fn prepare(
    app: &tauri::AppHandle,
    scope: &Scope,
    target: &str,
    edit: Edit,
) -> Result<Value, String> {
    validate(target, &edit)?;
    let sealed = seal(app, scope, &edit)?;
    transaction(app, scope, |conn| {
        let count:i64=conn.query_row("SELECT count(*) FROM monitoring_service_intents WHERE vault_id=?1 AND integration_id=?2",params![scope.vault_id,scope.integration_id],|r|r.get(0)).map_err(err)?;
        if count >= 2000 {
            return Err("MONITORING_HISTORY_LIMIT".into());
        }
        let pending:i64=conn.query_row("SELECT count(*) FROM monitoring_service_intents WHERE vault_id=?1 AND integration_id=?2 AND json_extract(body,'$.target')=?3 AND json_extract(body,'$.scope.configurationIdentity')=?4 AND json_extract(body,'$.status') NOT IN ('verified','cancelled')",params![scope.vault_id,scope.integration_id,target,scope.configuration_identity],|r|r.get(0)).map_err(err)?;
        if pending > 0 {
            return Err("MONITORING_PENDING_EDIT".into());
        }
        let row = Intent {
            id: Uuid::new_v4().to_string(),
            scope: scope.clone(),
            target: target.into(),
            revision: 1,
            status: "prepared".into(),
            job_id: create_job(
                conn,
                scope,
                target,
                "monitoring.service.update",
                if target.starts_with("retention:")
                    || target.starts_with("channel:")
                    || target == "load-policy"
                    || target == "extension"
                    || (edit.baseline["private_site"] == true
                        && edit.desired["private_site"] == false)
                {
                    "high"
                } else {
                    "low"
                },
            )?,
            updated_at: now_unix_ms(),
            observed_at: 0,
            error_code: None,
            sealed,
        };
        store(conn, &row)?;
        Ok(view(&row, &edit))
    })
}
fn finish(
    app: &tauri::AppHandle,
    scope: &Scope,
    row: &mut Intent,
    edit: &Edit,
    status: &str,
    code: Option<&str>,
) -> Result<(), String> {
    let sealed = seal(app, scope, edit)?;
    transaction(app, scope, |conn| {
        let current = load(conn, &row.id, scope)?;
        if current.revision != row.revision {
            return Err("MONITORING_STALE_EDIT".into());
        }
        let job = jobs::get_on(conn, &row.job_id)?.ok_or("MONITORING_INTENT_MISSING")?;
        if !matches!(job.status.as_str(), "queued" | "running") {
            row.job_id = create_job(
                conn,
                scope,
                &row.target,
                "monitoring.service.reconcile",
                "read-only",
            )?;
        }
        let job = jobs::get_on(conn, &row.job_id)?.ok_or("MONITORING_INTENT_MISSING")?;
        if job.status == "queued" {
            job_status(conn, &row.job_id, "running", "Checking remote state")?;
        }
        job_status(
            conn,
            &row.job_id,
            match status {
                "verified" => "completed",
                "cancelled" => "cancelled",
                "uncertain" => "unknown",
                _ => "failed",
            },
            match status {
                "verified" => "Remote values read back and verified",
                "cancelled" => "Pending edit abandoned; already dispatched effects may remain",
                "conflict" => "Remote values differ; explicit conflict choice required",
                "retry" => "Remote edit not verified; explicit retry required",
                _ => "Remote outcome uncertain; read-only recovery required",
            },
        )?;
        row.revision += 1;
        row.status = status.into();
        row.error_code = code.map(str::to_string);
        row.updated_at = now_unix_ms();
        row.sealed = sealed;
        store(conn, row)
    })
}
fn edit_action(
    app: &tauri::AppHandle,
    input: &Request,
    remote: &Remote,
    token: &str,
) -> Result<Value, String> {
    let scope = &input.scope;
    let mut row = load(&db(app)?, &input.id, scope)?;
    if input.revision != Some(row.revision) {
        return Err("MONITORING_STALE_EDIT".into());
    }
    let mut edit = decode(app, &row)?;
    if input.action == "cancel" {
        if !matches!(row.status.as_str(), "verified" | "cancelled") {
            finish(app, scope, &mut row, &edit, "cancelled", None)?;
        }
        return Ok(view(&row, &edit));
    }
    if row.scope.config_version != scope.config_version
        || row.scope.configuration_identity != scope.configuration_identity
    {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    if matches!(row.status.as_str(), "verified" | "cancelled") {
        return Ok(view(&row, &edit));
    }
    remote.version(Some(token))?;
    let observed = remote.read(&row.target, token)?;
    edit.observed = observed.clone();
    row.observed_at = now_unix_ms();
    if matches_desired(&edit, &observed) {
        finish(app, scope, &mut row, &edit, "verified", None)?;
        return Ok(view(&row, &edit));
    }
    if !same_object(&edit.baseline, &observed) {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    if input.action == "retry" {
        // A new explicit authorization creates a new immutable audit job. Only
        // fields changed by this intent are reapplied to the fresh remote base.
        let mut desired = observed.clone();
        for k in changed(&edit) {
            desired[&k] = edit.desired[&k].clone();
        }
        finish(app, scope, &mut row, &edit, "cancelled", None)?;
        return prepare(
            app,
            scope,
            &row.target,
            Edit {
                baseline: observed.clone(),
                desired,
                observed,
            },
        );
    }
    let merged = match merge(&edit, &observed) {
        Ok(v) => v,
        Err(_) => {
            finish(
                app,
                scope,
                &mut row,
                &edit,
                "conflict",
                Some("MONITORING_CONFLICT"),
            )?;
            return Ok(view(&row, &edit));
        }
    };
    if input.action != "apply" || row.status != "prepared" {
        if !matches!(row.status.as_str(), "retry" | "conflict") {
            finish(app, scope, &mut row, &edit, "retry", None)?;
        }
        return Ok(view(&row, &edit));
    }
    // Revalidate against the fresh server declaration, not a schema supplied by UI.
    validate(
        &row.target,
        &Edit {
            baseline: observed.clone(),
            desired: merged.clone(),
            observed: observed.clone(),
        },
    )?;
    // Persist the dispatch boundary before the only write. On crash, subsequent
    // calls can read/reconcile but cannot automatically re-enter this branch.
    let sealed = seal(app, scope, &edit)?;
    transaction(app, scope, |conn| {
        let latest = load(conn, &row.id, scope)?;
        if latest.revision != row.revision || latest.status != "prepared" {
            return Err("MONITORING_STALE_EDIT".into());
        }
        row.status = "applying".into();
        row.revision += 1;
        row.sealed = sealed;
        row.updated_at = now_unix_ms();
        job_status(
            conn,
            &row.job_id,
            "running",
            "Authorized remote write dispatched",
        )?;
        store(conn, &row)
    })?;
    let write = if row.target == "settings" {
        let patch: serde_json::Map<String, Value> = changed(&edit)
            .into_iter()
            .map(|k| (k.clone(), merged[&k].clone()))
            .collect();
        remote.write(&row.target, &Value::Object(patch), token)
    } else {
        remote.write(&row.target, &merged, token)
    };
    // Even a rejected/lost response may follow a committed write. Read back;
    // never send another POST in recovery.
    let readback = remote.read(&row.target, token);
    match readback {
        Ok(v) => {
            edit.observed = v;
            row.observed_at = now_unix_ms();
            let status = if matches_desired(&edit, &edit.observed) {
                "verified"
            } else if merge(&edit, &edit.observed).is_err() {
                "conflict"
            } else {
                "retry"
            };
            finish(
                app,
                scope,
                &mut row,
                &edit,
                status,
                write.as_ref().err().map(String::as_str),
            )?;
        }
        Err(_) => finish(
            app,
            scope,
            &mut row,
            &edit,
            "uncertain",
            Some("MONITORING_READBACK_REQUIRED"),
        )?,
    }
    Ok(view(&row, &edit))
}
fn authorize(app: &tauri::AppHandle, input: &Request, remote: &Remote) -> Result<Value, String> {
    let scope = &input.scope;
    let username = input.username.as_deref().unwrap_or("");
    let password = input.password.as_deref().unwrap_or("");
    if username.is_empty()
        || username.len() > 64
        || password.is_empty()
        || (input.action == "initialize" && password.len() < 8)
        || password.len() > 256
    {
        return Err("MONITORING_INVALID_LOGIN".into());
    }
    let job = transaction(app, scope, |conn| {
        let id = create_job(
            conn,
            scope,
            "authorization",
            if input.action == "initialize" {
                "monitoring.service.initialize"
            } else {
                "monitoring.service.authorize"
            },
            if input.action == "initialize" {
                "high"
            } else {
                "low"
            },
        )?;
        job_status(
            conn,
            &id,
            "running",
            "User requested native service authorization",
        )?;
        Ok(id)
    })?;
    let mut cookie = None;
    let result = (|| {
        if input.action == "initialize" {
            let status = remote.call("/api/install/status", None, None, None)?;
            if status["required"] != true {
                return Err("MONITORING_ALREADY_INITIALIZED".into());
            }
            let dsn = input.metric_dsn.as_deref().unwrap_or("");
            if dsn.trim().is_empty() || dsn.len() > 2048 {
                return Err("MONITORING_INVALID_DATABASE".into());
            }
            remote.call("/api/install/complete",Some(&json!({"username":username,"password":password,"sitename":check(app,scope)?.name,"description":"","metric_dsn":dsn})),None,None)?;
            // A new service switches from its install router asynchronously.
            // Bounded reads are safe; installation itself is never replayed.
            for _ in 0..20 {
                if remote.version(None).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        remote.version(None)?;
        let login=remote.call("/api/login",Some(&json!({"username":username,"password":password,"2fa_code":input.two_factor.as_deref().unwrap_or("")})),None,None)?;
        let session = login["set-cookie"]["session_token"]
            .as_str()
            .filter(|s| !s.is_empty() && !s.contains(['\n', '\r', ';']))
            .ok_or("MONITORING_INVALID_RESPONSE")?;
        cookie = Some(format!("session_token={session}"));
        let settings = remote.call("/api/admin/settings/", None, None, cookie.as_deref())?;
        let existing = settings["api_key"].as_str().unwrap_or("");
        let key = if existing.is_empty() {
            let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            remote.call(
                "/api/admin/settings/",
                Some(&json!({"api_key":key})),
                None,
                cookie.as_deref(),
            )?;
            key
        } else {
            existing.to_string()
        };
        remote.call("/api/admin/client/list", None, Some(&key), None)?;
        let integration = check(app, scope)?;
        // Never return the key to the UI; existing server keys are reused, not
        // rotated. A failed Vault write can be retried by logging in again.
        vault::set_secret_in_session(
            app,
            &app.state::<VaultState>(),
            &scope.vault_id,
            &integration.credential_ref,
            &key,
            scope.session,
        )?;
        check(app, scope)?;
        Ok(json!({"authorized":true}))
    })();
    if let Some(cookie) = cookie {
        let _ = remote
            .client
            .get(format!("{}/api/logout", remote.endpoint))
            .header("Cookie", cookie)
            .send();
    }
    // Audit contains only outcome codes, even if the remote embeds secrets in errors.
    let conn = db(app)?;
    job_status(
        &conn,
        &job,
        if result.is_ok() {
            "completed"
        } else {
            "unknown"
        },
        if result.is_ok() {
            "Protected API verified; access saved in Vault"
        } else {
            "Authorization incomplete; retry login to reconcile without rotating the key"
        },
    )?;
    result
}
fn require_confirmation(action: &str, confirmed: bool) -> Result<(), String> {
    if matches!(action, "prepare" | "retry" | "test" | "initialize") && !confirmed {
        return Err("MONITORING_CONFIRMATION_REQUIRED".into());
    }
    Ok(())
}
fn run(app: &tauri::AppHandle, input: Request) -> Result<Value, String> {
    let scope = &input.scope;
    check(app, scope)?;
    require_confirmation(&input.action, input.confirmed)?;
    let remote = Remote::new(app, scope)?;
    if matches!(input.action.as_str(), "authorize" | "initialize") {
        return authorize(app, &input, &remote);
    }
    if input.action == "prepare" {
        let baseline = input.baseline.ok_or("MONITORING_INVALID_EDIT")?;
        let desired = input.desired.ok_or("MONITORING_INVALID_EDIT")?;
        return prepare(
            app,
            scope,
            &input.target,
            Edit {
                observed: baseline.clone(),
                baseline,
                desired,
            },
        );
    }
    if input.action == "list" {
        let conn = db(app)?;
        let mut stmt=conn.prepare("SELECT id FROM monitoring_service_intents WHERE vault_id=?1 AND integration_id=?2 ORDER BY CASE WHEN json_extract(body,'$.status') IN ('verified','cancelled') THEN 1 ELSE 0 END, updated_at DESC LIMIT 100").map_err(err)?;
        let ids = stmt
            .query_map(params![scope.vault_id, scope.integration_id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        let mut out = Vec::new();
        for id in ids {
            let row = load(&conn, &id, scope)?;
            let edit = decode(app, &row)?;
            out.push(view(&row, &edit));
        }
        check(app, scope)?;
        return Ok(Value::Array(out));
    }
    if input.action == "cancel" {
        return edit_action(app, &input, &remote, "");
    }
    let token = secret(app, scope)?;
    if matches!(
        input.action.as_str(),
        "apply" | "reconcile" | "retry" | "cancel"
    ) {
        return edit_action(app, &input, &remote, &token);
    }
    remote.version(Some(&token))?;
    match input.action.as_str() {
        "read" => remote.read(&input.target, &token),
        "load-status" => {
            remote.require_extension(&token)?;
            remote.call("/api/shellbeam-alerts/v1/status", None, Some(&token), None)
        }
        "channel-nodes" => {
            let rows = remote.call("/api/admin/client/list", None, Some(&token), None)?;
            Ok(json!(rows
                .as_array()
                .ok_or("MONITORING_INVALID_RESPONSE")?
                .iter()
                .filter_map(|r| Some(json!({"id":r["uuid"].as_str()?,"name":r["name"].as_str().unwrap_or(""),"createdAt":r["created_at"].as_str()?})))
                .collect::<Vec<_>>()))
        }
        "channel-pingtasks" => {
            let rows = remote.call(
                "/api/rpc2",
                Some(&json!({"jsonrpc":"2.0","id":1,"method":"admin:getAllPingTasks","params":{}})),
                Some(&token),
                None,
            )?;
            Ok(json!(rows
                .as_array()
                .ok_or("MONITORING_INVALID_RESPONSE")?
                .iter()
                .filter_map(|r| Some(
                    json!({"id":r["id"].as_u64()?,"name":r["name"].as_str().unwrap_or("")})
                ))
                .collect::<Vec<_>>()))
        }
        "metrics" => remote.call(
            "/api/rpc2",
            Some(
                &json!({"jsonrpc":"2.0","id":1,"method":"admin:listMetricDefinitions","params":{}}),
            ),
            Some(&token),
            None,
        ),
        "channels" => remote.call("/api/admin/notification/channels", None, Some(&token), None),
        "test" => {
            let settings = remote.read("settings", &token)?;
            if settings["notification_enabled"] != true
                || matches!(
                    settings["notification_method"].as_str(),
                    None | Some("" | "none")
                )
            {
                return Err("MONITORING_CHANNEL_DISABLED".into());
            }
            let job = transaction(app, scope, |conn| {
                let id = create_job(
                    conn,
                    scope,
                    "notification-test",
                    "monitoring.notification.test",
                    "low",
                )?;
                job_status(
                    conn,
                    &id,
                    "running",
                    "User requested one server notification test",
                )?;
                Ok(id)
            })?;
            let result = remote.call(
                "/api/admin/test/sendMessage",
                Some(&json!({})),
                Some(&token),
                None,
            );
            job_status(
                &db(app)?,
                &job,
                if result.is_ok() {
                    "completed"
                } else {
                    "unknown"
                },
                if result.is_ok() {
                    "Server accepted send; recipient receipt is not available"
                } else {
                    "Delivery unknown; test was not replayed"
                },
            )?;
            result.map(|_| json!({"jobId":job,"accepted":true,"recipientReceipt":false}))
        }
        _ => Err("MONITORING_UNSUPPORTED".into()),
    }
}
static BUSY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
struct Lease(String);
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut active) = BUSY.get_or_init(Default::default).lock() {
            active.remove(&self.0);
        }
    }
}
#[tauri::command]
pub async fn monitoring_service(app: tauri::AppHandle, input: Request) -> Result<Value, String> {
    // Serialize per saved service, including late requests from another window.
    let key = format!("{}:{}", input.scope.vault_id, input.scope.integration_id);
    {
        let mut busy = BUSY.get_or_init(Default::default).lock().map_err(err)?;
        if !busy.insert(key.clone()) {
            return Err("MONITORING_BUSY".into());
        }
    }
    let lease = Lease(key);
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        run(&app, input)
    })
    .await
    .map_err(|_| "MONITORING_REQUEST_FAILED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edit() -> Edit {
        Edit {
            baseline: json!({"sitename":"Before","private_site":false}),
            desired: json!({"sitename":"After","private_site":false}),
            observed: Value::Null,
        }
    }
    #[test]
    fn load_policy_rebases_revision_but_rejects_recreated_extension_and_same_field_conflicts() {
        let base = json!({"extension_identity":"original","revision":1,"rules":[],"silences":[]});
        let mut e = Edit {
            baseline: base.clone(),
            desired: base.clone(),
            observed: Value::Null,
        };
        e.desired["silences"] = json!([{"id":"night","name":"Night","enabled":true,"ruleIds":[],"kind":"weekly","timezone":"UTC","days":[1],"startMinute":1320,"endMinute":420}]);
        validate("load-policy", &e).unwrap();
        let mut remote = base.clone();
        remote["revision"] = json!(2);
        assert_eq!(merge(&e, &remote).unwrap()["revision"], 2);
        remote["silences"] = json!([{"id":"external"}]);
        assert_eq!(merge(&e, &remote).unwrap_err(), "MONITORING_CONFLICT");
        remote = e.desired.clone();
        remote["extension_identity"] = json!("recreated");
        assert!(!matches_desired(&e, &remote));
        assert_eq!(merge(&e, &remote).unwrap_err(), "MONITORING_SCOPE_CHANGED");
        e.desired["revision"] = json!(99);
        assert!(validate("load-policy", &e).is_err());
    }
    #[test]
    fn channel_schema_change_is_never_treated_as_verified_or_rebased() {
        let base = channels::read("mail", json!({"configuration":{"type":"managed","data":[{"key":"token","type":"string"}]},"data":{"token":"synthetic"}})).unwrap();
        let mut e = Edit {
            baseline: base.clone(),
            desired: base.clone(),
            observed: Value::Null,
        };
        e.desired["token"] = json!("changed");
        validate("channel:mail", &e).unwrap();
        let mut remote = e.desired.clone();
        remote[channels::IDENTITY] = json!("different-schema");
        assert!(!matches_desired(&e, &remote));
        assert!(merge(&e, &remote).is_err());
    }
    #[test]
    fn merges_disjoint_remote_change_without_overwriting_it() {
        assert_eq!(
            merge(&edit(), &json!({"sitename":"Before","private_site":true})).unwrap(),
            json!({"sitename":"After","private_site":true})
        );
    }
    #[test]
    fn same_field_conflict_is_explicit() {
        assert_eq!(
            merge(
                &edit(),
                &json!({"sitename":"External","private_site":false})
            )
            .unwrap_err(),
            "MONITORING_CONFLICT"
        );
    }
    #[test]
    fn unchanged_fields_do_not_block_readback() {
        assert!(matches_desired(
            &edit(),
            &json!({"sitename":"After","private_site":true})
        ));
    }
    #[test]
    fn privileged_and_unknown_fields_are_not_writable() {
        let mut e = edit();
        e.desired["api_key"] = json!("secret");
        assert!(validate("settings", &e).is_err());
        e.desired = json!({"sitename":"After"});
        assert!(validate("settings", &e).is_err());
    }
    #[test]
    fn validates_webhook_without_dropping_plugin_fields() {
        let e = Edit {
            baseline: json!({"url":"https://old.test","custom":"keep"}),
            desired: json!({"url":"https://new.test","custom":"keep"}),
            observed: Value::Null,
        };
        assert!(validate("webhook", &e).is_ok());
        let mut bad = e.clone();
        bad.desired["custom"] = json!("lose");
        assert!(validate("webhook", &bad).is_err());
        bad.desired = json!({"url":"https://user:pass@new.test","custom":"keep"});
        assert!(validate("webhook", &bad).is_err());
    }
    #[test]
    fn types_and_limits_are_checked() {
        let mut e = edit();
        e.desired["private_site"] = json!("false");
        assert!(validate("settings", &e).is_err());
        e.desired = e.baseline.clone();
        assert!(validate("settings", &e).is_err());
    }
    #[test]
    fn mutations_require_explicit_confirmation_but_recovery_remains_read_only() {
        for action in ["prepare", "retry", "test", "initialize"] {
            assert_eq!(
                require_confirmation(action, false).unwrap_err(),
                "MONITORING_CONFIRMATION_REQUIRED"
            );
            assert!(require_confirmation(action, true).is_ok());
        }
        for action in ["list", "read", "reconcile", "cancel", "authorize"] {
            assert!(require_confirmation(action, false).is_ok());
        }
    }
    #[test]
    fn retention_changes_never_clear_history_or_cross_recreated_metrics() {
        let mut edit = Edit {
            baseline: json!({"retention_days":30,"metric_identity":"cpu:original"}),
            desired: json!({"retention_days":7,"metric_identity":"cpu:original"}),
            observed: Value::Null,
        };
        assert!(validate("retention:cpu", &edit).is_ok());
        for days in [0, -1, 3651] {
            edit.desired["retention_days"] = json!(days);
            assert!(validate("retention:cpu", &edit).is_err());
        }
        edit.desired["retention_days"] = json!(7);
        let recreated = json!({"retention_days":7,"metric_identity":"cpu:recreated"});
        assert!(!matches_desired(&edit, &recreated));
        assert_eq!(
            merge(&edit, &recreated).unwrap_err(),
            "MONITORING_SCOPE_CHANGED"
        );
    }
    #[test]
    fn intent_and_audit_rollback_together_and_sealed_values_survive_reload() {
        let path =
            std::env::temp_dir().join(format!("shellbeam-service-test-{}.db", Uuid::new_v4()));
        let mut conn = jobs::open_database(&path).unwrap();
        initialize(&conn).unwrap();
        let scope = Scope {
            vault_id: "test-vault".into(),
            integration_id: "service".into(),
            config_version: 1,
            session: 1,
            context_id: "test-context".into(),
            configuration_identity: "synthetic-config".into(),
        };
        {
            let tx = conn.transaction().unwrap();
            let job =
                create_job(&tx, &scope, "settings", "monitoring.service.update", "low").unwrap();
            let intent = Intent {
                id: "rolled-back".into(),
                scope: scope.clone(),
                target: "settings".into(),
                revision: 1,
                status: "prepared".into(),
                job_id: job,
                updated_at: 1,
                observed_at: 0,
                error_code: None,
                sealed: "opaque-encrypted-value".into(),
            };
            store(&tx, &intent).unwrap();
        }
        assert_eq!(
            conn.query_row("SELECT count(*) FROM operation_jobs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM monitoring_service_intents", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let tx = conn.transaction().unwrap();
        let job = create_job(&tx, &scope, "webhook", "monitoring.service.update", "low").unwrap();
        let confirmed_job = jobs::get_on(&tx, &job).unwrap().unwrap();
        assert!(confirmed_job.confirmation_required);
        assert_eq!(confirmed_job.confirmation_status, "confirmed");
        assert_eq!(confirmed_job.confirmed_by.as_deref(), Some("user"));
        let intent = Intent {
            id: "committed".into(),
            scope: scope.clone(),
            target: "webhook".into(),
            revision: 1,
            status: "prepared".into(),
            job_id: job,
            updated_at: 1,
            observed_at: 0,
            error_code: None,
            sealed: "opaque-encrypted-value".into(),
        };
        store(&tx, &intent).unwrap();
        tx.commit().unwrap();
        drop(conn);
        let conn = jobs::open_database(&path).unwrap();
        let loaded = load(&conn, "committed", &scope).unwrap();
        assert_eq!(loaded.sealed, "opaque-encrypted-value");
        assert!(!serde_json::to_string(&loaded).unwrap().contains("opaque"));
        let mut other = scope.clone();
        other.vault_id = "other".into();
        assert!(load(&conn, "committed", &other).is_err());
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cancelled_context_is_revoked_without_touching_credentials() {
        let id = Uuid::new_v4().to_string();
        CONTEXTS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
                id.clone(),
                (
                    "v".into(),
                    "s".into(),
                    1,
                    1,
                    now_unix_ms() + 60000,
                    "config".into(),
                ),
            );
        monitoring_service_cancel_context(id.clone()).unwrap();
        assert!(!CONTEXTS.get().unwrap().lock().unwrap().contains_key(&id));
        monitoring_service_cancel_context(id).unwrap();
    }

    #[test]
    fn wire_rejects_redirects_and_never_returns_secret_bearing_errors() {
        use std::io::{Read, Write};
        for status in [302, 401, 500] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0; 2048];
                socket.read(&mut request).unwrap();
                let body = "synthetic-private-response";
                write!(socket,"HTTP/1.1 {status} Error\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
            });
            let client = Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            let result = exchange(
                &client,
                &format!("http://{address}"),
                "/api/admin/settings/",
                None,
                Some("synthetic-key"),
                None,
            )
            .unwrap_err();
            assert!(!result.contains("synthetic"));
            assert_eq!(
                result,
                if status == 401 {
                    "MONITORING_PERMISSION"
                } else {
                    "MONITORING_REQUEST_FAILED"
                }
            );
            worker.join().unwrap();
        }
    }

    #[test]
    #[ignore = "Explicit isolated official Komari binary required"]
    fn official_service_wire_contract() {
        use std::io::{Read, Write};
        use std::process::{Command, Stdio};
        let binary = std::env::var("SHELLBEAM_KOMARI_TEST_BINARY")
            .expect("set the isolated official binary path");
        let root = std::env::temp_dir().join(format!("shellbeam-native-komari-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        struct Cleanup {
            child: std::process::Child,
            root: std::path::PathBuf,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
        let child = Command::new(binary)
            .args([
                "server",
                "--listen",
                &address.to_string(),
                "--database",
                root.join("primary.db").to_str().unwrap(),
            ])
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let _cleanup = Cleanup {
            child,
            root: root.clone(),
        };
        let endpoint = format!("http://{address}");
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let call = |path: &str, body: Option<&Value>, token: Option<&str>, cookie: Option<&str>| {
            exchange(&client, &endpoint, path, body, token, cookie)
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            if call("/api/install/status", None, None, None).is_ok_and(|v| v["required"] == true) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "server startup timeout"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        let username = "shellbeam-native-test";
        let password = format!("Sb1{}", Uuid::new_v4().simple());
        assert!(call("/api/install/complete",Some(&json!({"username":username,"password":password,"sitename":"Native contract","description":"","metric_dsn":root.join("metrics.db").to_str().unwrap()})),None,None).is_ok());
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if call("/api/version", None, None, None).is_ok_and(|v| v["version"] == "1.6.0") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "server initialization timeout"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        let login = call(
            "/api/login",
            Some(&json!({"username":username,"password":password,"2fa_code":""})),
            None,
            None,
        )
        .unwrap();
        let cookie = format!(
            "session_token={}",
            login["set-cookie"]["session_token"]
                .as_str()
                .expect("login session")
        );
        let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        assert!(call(
            "/api/admin/settings/",
            Some(&json!({"api_key":key,"login_notification":false})),
            None,
            Some(&cookie)
        )
        .is_ok());
        assert!(call("/api/admin/client/list", None, Some(&key), None).is_ok());
        let settings = call("/api/admin/settings/", None, None, Some(&cookie)).unwrap();
        assert!(settings["api_key"].as_str() == Some(&key));
        let receiver = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        receiver.set_nonblocking(true).unwrap();
        let receiver_address = receiver.local_addr().unwrap();
        let receive = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            loop {
                if let Ok((mut socket, _)) = receiver.accept() {
                    socket
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut buf = [0; 2048];
                    loop {
                        let n = socket.read(&mut buf).unwrap();
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&bytes);
                        if let Some(end) = text.find("\r\n\r\n") {
                            let len = text[..end]
                                .lines()
                                .find_map(|l| {
                                    l.to_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + len {
                                break;
                            }
                        }
                    }
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                        .unwrap();
                    return String::from_utf8(bytes).unwrap();
                }
                assert!(std::time::Instant::now() < deadline, "webhook not received");
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let original = call(
            "/api/admin/notification/channel/configuration?id=webhook",
            None,
            Some(&key),
            None,
        )
        .unwrap();
        let mut data = original["data"].clone();
        assert!(data.is_object());
        data["url"] = json!(format!("http://{receiver_address}/receipt"));
        data["method"] = json!("POST");
        data["headers"] = json!("{\"X-ShellBeam-Test\":\"native\"}");
        data["body"] = json!("{\"message\":\"{{message}}\",\"title\":\"{{title}}\"}");
        assert!(call(
            "/api/admin/notification/channel/configuration",
            Some(&json!({"id":"webhook","data":data})),
            Some(&key),
            None
        )
        .is_ok());
        let actual = call(
            "/api/admin/notification/channel/configuration?id=webhook",
            None,
            Some(&key),
            None,
        )
        .unwrap();
        assert!(actual["data"] == data, "channel readback mismatch");
        assert!(call(
            "/api/admin/settings/",
            Some(&json!({"notification_enabled":true,"notification_method":"webhook"})),
            Some(&key),
            None
        )
        .is_ok());
        assert!(call(
            "/api/admin/test/sendMessage",
            Some(&json!({})),
            Some(&key),
            None
        )
        .is_ok());
        let receipt = receive.join().unwrap();
        assert!(receipt.starts_with("POST /receipt "));
        assert!(receipt.contains("This is a test message from Komari."));
        assert!(call(
            "/api/admin/settings/",
            Some(&json!({"notification_enabled":false})),
            Some(&key),
            None
        )
        .is_ok());
        assert_eq!(
            call("/api/admin/settings/", None, Some(&key), None).unwrap()["notification_enabled"],
            false
        );
        let _ = client
            .get(format!("{endpoint}/api/logout"))
            .header("Cookie", cookie)
            .send();
        assert!(call(
            "/api/admin/settings/",
            None,
            Some("invalid-synthetic-key"),
            None
        )
        .is_err());
    }
}
