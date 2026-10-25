//! Two pinned SSH endpoints coordinated by a durable intent. No API or Agent
//! secrets are persisted. Unknown writes are never retried by a scheduler.
use super::*;
use crate::data::operation_jobs::{
    self as jobs, CreateOperationJobRequest, UpdateOperationJobRequest,
};
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bound {
    record: Record,
    host_fingerprint: String,
    mapping_fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    id: String,
    vault: String,
    status: String,
    revision: i64,
    job_id: String,
    #[serde(default)]
    target_job_id: Option<String>,
    source: Bound,
    target: Bound,
    target_previous: Option<Record>,
    source_state: Observation,
    target_state: Observation,
    updated_at: i64,
    error_code: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    vault_id: String,
    source_host_id: String,
    target_host_id: String,
    target_connection_id: Option<String>,
    target_integration_id: String,
    endpoint: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreview {
    plan_id: String,
    action: String,
    source: Preview,
    target: Preview,
}
#[derive(Clone)]
struct TransferPlan {
    row: Transfer,
    source: Plan,
    target: Plan,
    settings: Value,
    action: String,
}
static TRANSFERS: OnceLock<Mutex<HashMap<String, TransferPlan>>> = OnceLock::new();
fn storage(_: impl std::fmt::Display) -> String {
    "KOMARI_AGENT_STORAGE".into()
}
fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS komari_agent_transfers(id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,source_host TEXT NOT NULL,target_host TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS komari_agent_transfer_locks(vault_id TEXT NOT NULL,host_id TEXT NOT NULL,transfer_id TEXT NOT NULL,PRIMARY KEY(vault_id,host_id));").map_err(storage)
}
pub(super) fn unlocked(db: &Connection, vault: &str, host: &str) -> Result<(), String> {
    initialize(db)?;
    let locked: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM komari_agent_transfer_locks WHERE vault_id=?1 AND host_id=?2)", params![vault,host], |r| r.get(0)).map_err(storage)?;
    if locked {
        Err("KOMARI_AGENT_TRANSFER_READBACK_REQUIRED".into())
    } else {
        Ok(())
    }
}
fn read(db: &Connection, vault: &str, id: &str) -> Result<Transfer, String> {
    initialize(db)?;
    let body: String = db
        .query_row(
            "SELECT body FROM komari_agent_transfers WHERE vault_id=?1 AND id=?2",
            params![vault, id],
            |r| r.get(0),
        )
        .map_err(storage)?;
    serde_json::from_str(&body).map_err(storage)
}
fn put(db: &Connection, row: &mut Transfer, expected: i64) -> Result<(), String> {
    row.revision = expected + 1;
    row.updated_at = now_unix_ms();
    let body = serde_json::to_string(row).map_err(storage)?;
    let count = if expected == 0 {
        db.execute("INSERT OR IGNORE INTO komari_agent_transfers VALUES(?1,?2,?3,?4,?5,?6)",params![row.id,row.vault,row.source.record.host_id,row.target.record.host_id,body,row.revision])
    } else {
        db.execute("UPDATE komari_agent_transfers SET body=?3,revision=?4 WHERE vault_id=?1 AND id=?2 AND revision=?5", params![row.vault,row.id,body,row.revision,expected])
    }.map_err(storage)?;
    if count != 1 {
        return Err("KOMARI_AGENT_STATE_CHANGED".into());
    }
    Ok(())
}
fn persist(
    db: &mut Connection,
    row: &mut Transfer,
    job_status: Option<&str>,
) -> Result<(), String> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    let revision = row.revision;
    put(&tx, row, revision)?;
    if let Some(status) = job_status {
        for id in std::iter::once(&row.job_id).chain(row.target_job_id.iter()) {
            store::transition(
                &tx,
                id,
                status,
                &format!("Probe migration: {}", row.status),
                row.error_code.as_deref(),
            )?;
        }
    }
    tx.commit().map_err(storage)
}
fn start(db: &mut Connection, p: &mut TransferPlan) -> Result<(), String> {
    initialize(db)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    let row = &mut p.row;
    if row.revision == 0 {
        for r in [&row.source.record, &row.target.record] {
            unlocked(&tx, &row.vault, &r.host_id)?;
        }
        for (id, expected) in [
            (&row.source.record.host_id, row.source.record.revision),
            (
                &row.target.record.host_id,
                row.target_previous.as_ref().map_or(0, |r| r.revision),
            ),
        ] {
            if store::get(&tx, &row.vault, id)?.map_or(0, |r| r.revision) != expected {
                return Err("KOMARI_AGENT_STATE_CHANGED".into());
            }
            tx.execute(
                "INSERT OR IGNORE INTO komari_agent_transfer_locks VALUES(?1,?2,?3)",
                params![row.vault, id, row.id],
            )
            .map_err(storage)?;
        }
    } else {
        let old = read(&tx, &row.vault, &row.id)?;
        if old.revision != row.revision || matches!(old.status.as_str(), "completed" | "restored") {
            return Err("KOMARI_AGENT_STATE_CHANGED".into());
        }
        for id in std::iter::once(&old.job_id).chain(old.target_job_id.iter()) {
            if let Some(j) = jobs::get_on(&tx, id)? {
                if matches!(j.status.as_str(), "queued" | "running") {
                    store::transition(
                        &tx,
                        &j.job_id,
                        "unknown",
                        "Interrupted migration; separate readback does not replay",
                        Some("KOMARI_AGENT_INTERRUPTED"),
                    )?;
                }
            }
        }
    }
    let readonly = p.action == "inspect";
    row.target_job_id = None;
    for endpoint in [&p.source, &p.target] {
        if endpoint.host.id == p.source.host.id && endpoint.id == p.target.id {
            continue;
        }
        let j = jobs::create_on(
            &tx,
            CreateOperationJobRequest {
                host_id: Some(endpoint.host.id.clone()),
                vault_id: Some(row.vault.clone()),
                host_name: Some(endpoint.host.name.clone()),
                host_address: Some(endpoint.host.address.clone()),
                username: Some(endpoint.host.username.clone()),
                source: "workspace".into(),
                actor: Some("user".into()),
                action: format!("monitoring.agent.transfer.{}", p.action),
                target: row.id.clone(),
                risk: if readonly { "read-only" } else { "high" }.into(),
                provider: Some("komari".into()),
                transport: Some(format!(
                    "{} -> {}",
                    transport_name(&p.source.host),
                    transport_name(&p.target.host)
                )),
                params_summary: Some(format!(
                "{}@{} / {} -> {}@{} / {}; preserve both nodes, files, credentials and histories",
                p.source.host.username,
                p.source.host.name,
                p.source.node,
                p.target.host.username,
                p.target.host.name,
                p.target.node
            )),
                confirmation_required: !readonly,
                request_id: None,
            },
        )?;
        if endpoint.id == p.source.id {
            row.job_id = j.job_id.clone();
        } else {
            row.target_job_id = Some(j.job_id.clone());
        }
        if !readonly {
            jobs::update_on(
                &tx,
                UpdateOperationJobRequest {
                    job_id: j.job_id.clone(),
                    status: "queued".into(),
                    confirmation_status: Some("confirmed".into()),
                    confirmed_by: Some("user".into()),
                    result_summary: Some(
                        "Confirmed source, target, accounts, nodes, routes, release and recovery"
                            .into(),
                    ),
                    error_code: None,
                    error_summary: None,
                    actor: Some("user".into()),
                },
            )?;
        }
        store::transition(
            &tx,
            &j.job_id,
            "running",
            "Checking both migration endpoints",
            None,
        )?;
    }
    row.error_code = None;
    let revision = row.revision;
    put(&tx, row, revision)?;
    tx.commit().map_err(storage)
}
fn commit(
    db: &mut Connection,
    row: &mut Transfer,
    restored: bool,
    observed_at: i64,
) -> Result<(), String> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    let mut source = row.source.record.clone();
    let mut target = row.target.record.clone();
    let old_source = source.revision;
    source.observation = row.source_state.clone();
    source.status = if restored { "active" } else { "migrated" }.into();
    source.job_id = row.job_id.clone();
    source.action = "transfer".into();
    source.updated_at = now_unix_ms();
    source.revision += 1;
    if restored {
        source.observed_at = Some(observed_at);
    }
    // Same-host account/service migration replaces only the active deployment.
    // The complete original record is retained immutably inside this intent.
    if restored || source.host_id != target.host_id {
        store::put(&tx, &source, old_source)?;
    }
    if !restored {
        let expected = row.target_previous.as_ref().map_or(0, |r| r.revision);
        apply_observation(&mut target, row.target_state.clone())?;
        target.status = "active".into();
        target.action = "transfer".into();
        target.job_id = row
            .target_job_id
            .clone()
            .unwrap_or_else(|| row.job_id.clone());
        target.revision = expected + 1;
        target.updated_at = now_unix_ms();
        target.observed_at = Some(observed_at);
        store::put(&tx, &target, expected)?;
    }
    row.status = if restored { "restored" } else { "completed" }.into();
    row.error_code = None;
    let revision = row.revision;
    put(&tx, row, revision)?;
    for id in std::iter::once(&row.job_id).chain(row.target_job_id.iter()) {
        store::transition(
            &tx,
            id,
            "completed",
            if restored {
                "Source process and fresh report restored; target stopped"
            } else {
                "Target process and fresh report verified; source stopped; history retained"
            },
            None,
        )?;
    }
    tx.execute(
        "DELETE FROM komari_agent_transfer_locks WHERE vault_id=?1 AND transfer_id=?2",
        params![row.vault, row.id],
    )
    .map_err(storage)?;
    tx.commit().map_err(storage)
}
fn bind(app: &tauri::AppHandle, r: Record) -> Result<Plan, String> {
    // Recovery builds a fresh, explicitly reviewed scope. Metadata edits and
    // unrelated mapping revisions must not strand a durable intent. The stable
    // host/node creation IDs, selected connection, SSH keys and machine/account
    // identity are still checked before reading or writing either endpoint.
    let (h, hf) = host_connection(app, &r.vault_id, &r.host_id, r.connection_id.as_deref())?;
    if h.created_at != r.host_created_at {
        return Err("KOMARI_AGENT_HOST_CHANGED".into());
    }
    let integration = komari::list_komari_integrations(app.clone(), r.vault_id.clone())?
        .into_iter()
        .find(|i| i.id == r.integration_id)
        .ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
    if fingerprint(&(
        integration.id.clone(),
        integration.endpoint.clone(),
        integration.created_at,
    ))? != r.service_identity
    {
        return Err("KOMARI_AGENT_SOURCE_CHANGED".into());
    }
    let (n, m) = mapping(app, &r.vault_id, &r.integration_id, &r.host_id)?;
    if n != r.node_id {
        return Err("KOMARI_AGENT_MAPPING_CHANGED".into());
    }
    let scope = service::monitoring_service_context(app.clone(), integration)?;
    let api = service::Remote::new(app, &scope)?;
    let token = service::secret(app, &scope)?;
    api.version(Some(&token))?;
    if node(&api, &token, &r.node_id)?.0 != r.node_created_at {
        return Err("KOMARI_AGENT_NODE_CHANGED".into());
    }
    let p = Plan {
        id: Uuid::new_v4().to_string(),
        vault: r.vault_id.clone(),
        session: app.state::<VaultState>().session_generation(),
        host: h,
        host_fingerprint: hf,
        connection_id: r.connection_id.clone(),
        keys: r.host_keys.clone(),
        source: Some(scope),
        mapping_fingerprint: Some(m),
        service_identity: r.service_identity.clone(),
        integration: r.integration_id.clone(),
        node: r.node_id.clone(),
        node_created: r.node_created_at.clone(),
        deployment: r.deployment.clone(),
        endpoint: r.endpoint.clone(),
        identity: r.identity.clone(),
        observed: r.observation.clone(),
        baseline: Some(r.clone()),
        release: r.requested.clone().or(r.current.clone()),
        policy_fingerprint: None,
        action: "transfer".into(),
        watermark: r.watermark,
        expires: now_unix_ms() + 300_000,
        cancelled: Arc::new(AtomicBool::new(false)),
        legacy_unit: r.observation.legacy.as_ref().map(|l| l.unit.clone()),
        configuration: r.configuration.clone(),
    };
    check(app, &p)?;
    Ok(p)
}
fn bound(p: &Plan, r: Record) -> Bound {
    Bound {
        record: r,
        host_fingerprint: p.host_fingerprint.clone(),
        mapping_fingerprint: p.mapping_fingerprint.clone().unwrap_or_default(),
    }
}
fn agent_token(app: &tauri::AppHandle, p: &Plan) -> Result<String, String> {
    check(app, p)?;
    let s = p.source.as_ref().ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
    let api = service::Remote::new(app, s)?;
    let token = service::secret(app, s)?;
    if node(&api, &token, &p.node)?.0 != p.node_created {
        return Err("KOMARI_AGENT_NODE_CHANGED".into());
    }
    rpc(&api, &token, "admin:getClientToken", &p.node)?["token"]
        .as_str()
        .filter(|t| !t.is_empty() && t.len() <= 4096)
        .map(str::to_owned)
        .ok_or("KOMARI_AGENT_NODE_AUTH_REQUIRED".into())
}
fn watermark(app: &tauri::AppHandle, p: &Plan) -> Result<i64, String> {
    let s = p.source.as_ref().ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
    recent(
        &service::Remote::new(app, s)?,
        &service::secret(app, s)?,
        &p.node,
    )
}
fn preview(p: &Plan) -> Preview {
    Preview {
        plan_id: p.id.clone(),
        action: "transfer".into(),
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
        current_version: p.observed.current.as_ref().map(|m| m.version.clone()),
        target_version: p.release.as_ref().map(|r| r.manifest.version.clone()),
        current_artifact: p.observed.current.clone(),
        target_artifact: p.release.as_ref().map(|r| r.manifest.clone()),
        status: p.observed.status.clone(),
        expires_at: p.expires,
        legacy_unit: p.legacy_unit.clone(),
        previous_endpoint: None,
    }
}
fn cache(p: TransferPlan) -> Result<TransferPreview, String> {
    let result = TransferPreview {
        plan_id: p.source.id.clone(),
        action: p.action.clone(),
        source: preview(&p.source),
        target: preview(&p.target),
    };
    let mut plans = TRANSFERS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "KOMARI_AGENT_BUSY")?;
    plans.retain(|_, p| p.source.expires > now_unix_ms());
    if plans.len() >= 64 {
        return Err("KOMARI_AGENT_BUSY".into());
    }
    plans.insert(result.plan_id.clone(), p);
    Ok(result)
}
pub(super) fn cancel(id: &str) {
    if let Ok(mut plans) = TRANSFERS.get_or_init(Default::default).lock() {
        if let Some(p) = plans.remove(id) {
            for p in [p.source, p.target] {
                p.cancelled.store(true, Ordering::SeqCst);
                if let Some(s) = p.source {
                    let _ = service::monitoring_service_cancel_context(s.context_id);
                }
            }
        }
    }
}
fn configuration(settings: &Value, endpoint: &str, token: String) -> Result<Value, String> {
    let mut c = settings
        .as_object()
        .cloned()
        .ok_or("KOMARI_AGENT_CONFIGURATION_CHANGED")?;
    c.insert("endpoint".into(), json!(endpoint));
    c.insert("token".into(), json!(token));
    c.insert("disable_auto_update".into(), json!(true));
    c.insert("disable_web_ssh".into(), json!(true));
    Ok(Value::Object(c))
}
fn prepare_transfer(app: &tauri::AppHandle, input: Input) -> Result<TransferPreview, String> {
    let db = store::open(app)?;
    unlocked(&db, &input.vault_id, &input.source_host_id)?;
    unlocked(&db, &input.vault_id, &input.target_host_id)?;
    let source = store::get(&db, &input.vault_id, &input.source_host_id)?
        .ok_or("KOMARI_AGENT_NOT_MANAGED")?;
    if source.status != "active" {
        return Err("KOMARI_AGENT_READBACK_REQUIRED".into());
    }
    let source_plan = bind(app, source.clone())?;
    let source_conn = connect(app, &source_plan)?;
    let (_, source_state) = state(
        &remote(&source_conn, &inspection(&source_plan), &|| {
            check(app, &source_plan)
        })?,
        Some(&source.identity),
    )?;
    validate_observation(&source, &source_state)?;
    if source_state.status != "active" || !source_state.active {
        return Err("KOMARI_AGENT_PROCESS_NOT_VERIFIED".into());
    }
    let settings=remote(&source_conn,&json!({"action":"export-settings","deployment":source.deployment,"identity":source.identity,"expected":source_state,"agentToken":agent_token(app,&source_plan)?}),&||check(app,&source_plan))?.settings.ok_or("KOMARI_AGENT_CONFIGURATION_CHANGED")?;
    let previous = store::get(&db, &input.vault_id, &input.target_host_id)?;
    if input.source_host_id != input.target_host_id && previous.is_some() {
        return Err("KOMARI_AGENT_TRANSFER_TARGET_OCCUPIED".into());
    }
    let (h, hf) = host_connection(
        app,
        &input.vault_id,
        &input.target_host_id,
        input.target_connection_id.as_deref(),
    )?;
    super::super::host_monitoring::require_server(&h)?;
    let scope_generation = app.state::<VaultState>().session_generation();
    let guard = || {
        check(app, &source_plan)?;
        if app.state::<VaultState>().session_generation() != scope_generation
            || host_connection(
                app,
                &input.vault_id,
                &h.id,
                input.target_connection_id.as_deref(),
            )?
            .1 != hf
        {
            return Err("KOMARI_AGENT_HOST_CHANGED".into());
        }
        Ok(())
    };
    let route = transport::route_for_host(
        app,
        &input.vault_id,
        &h,
        &hosts::load_hosts(app, Some(&input.vault_id))?,
    )?;
    guard()?;
    let target_conn = transport::connect(app, &route).map_err(|_| "KOMARI_AGENT_SSH_CONNECTION")?;
    guard()?;
    let deployment = Uuid::new_v4().to_string();
    let (identity, target_state) = state(
        &remote(
            &target_conn,
            &json!({"action":"inspect","deployment":deployment}),
            &guard,
        )?,
        None,
    )?;
    let integration = komari::list_komari_integrations(app.clone(), input.vault_id.clone())?
        .into_iter()
        .find(|i| i.id == input.target_integration_id)
        .ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
    let (node_id, _) = mapping(app, &input.vault_id, &integration.id, &h.id)?;
    if source.identity.machine == identity.machine
        && source.identity.uid == identity.uid
        && source.integration_id == integration.id
        && source.node_id == node_id
    {
        return Err("KOMARI_AGENT_TRANSFER_NO_CHANGE".into());
    }
    let s = service::monitoring_service_context(app.clone(), integration.clone())?;
    let api = service::Remote::new(app, &s)?;
    super::super::monitoring_identity::require_shellbeam(&api.call(
        "/api/version",
        None,
        None,
        None,
    )?)?;
    let token = service::secret(app, &s)?;
    api.version(Some(&token))?;
    let (created, _) = node(&api, &token, &node_id)?;
    let mark = recent(&api, &token, &node_id)?;
    if !(source.integration_id == integration.id && source.node_id == node_id)
        && mark >= now_unix_ms() - 60_000
    {
        return Err("KOMARI_AGENT_NODE_ALREADY_REPORTING".into());
    }
    service::monitoring_service_cancel_context(s.context_id)?;
    let policy = artifact::policy(app)?;
    let release = artifact::select(app, &policy, &identity.architecture)?;
    artifact::require_shellbeam(&release)?;
    let target = Record {
        connection_id: Some(
            h.default_connection_id
                .clone()
                .unwrap_or_else(|| h.id.clone()),
        ),
        vault_id: input.vault_id.clone(),
        host_id: h.id.clone(),
        host_created_at: h.created_at,
        integration_id: integration.id.clone(),
        service_identity: fingerprint(&(
            integration.id,
            integration.endpoint.clone(),
            integration.created_at,
        ))?,
        node_id,
        node_created_at: created,
        deployment,
        revision: 0,
        identity,
        host_keys: fingerprint(&target_conn.verified_host_keys)?,
        endpoint: endpoint(input.endpoint.as_deref().unwrap_or(&integration.endpoint))?,
        status: "prepared".into(),
        action: "transfer".into(),
        job_id: String::new(),
        current: None,
        previous: None,
        requested: Some(release),
        observation: target_state.clone(),
        watermark: mark,
        observed_at: None,
        updated_at: now_unix_ms(),
        error_code: None,
        configuration: None,
        previous_configuration: None,
        requested_configuration: None,
    };
    let mut target_plan = bind(app, target.clone())?;
    target_plan.policy_fingerprint = Some(fingerprint(&policy)?);
    let config = configuration(&settings, &target.endpoint, agent_token(app, &target_plan)?)?;
    let mut target = target;
    target.configuration = Some(ConfigurationIdentity {
        sha256: fingerprint(&config)?,
        endpoint: target.endpoint.clone(),
    });
    target.observation.config_sha256 = Some(target.configuration.as_ref().unwrap().sha256.clone());
    let row = Transfer {
        id: Uuid::new_v4().to_string(),
        vault: input.vault_id,
        status: "prepared".into(),
        revision: 0,
        job_id: String::new(),
        target_job_id: None,
        source: bound(&source_plan, source),
        target: bound(&target_plan, target),
        target_previous: previous,
        source_state,
        target_state,
        updated_at: now_unix_ms(),
        error_code: None,
    };
    check(app, &source_plan)?;
    check(app, &target_plan)?;
    cache(TransferPlan {
        row,
        source: source_plan,
        target: target_plan,
        settings,
        action: "move".into(),
    })
}
#[tauri::command]
pub async fn komari_agent_transfer_prepare(
    app: tauri::AppHandle,
    input: Input,
) -> Result<TransferPreview, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_transfer(&app, input))
        .await
        .map_err(|_| "KOMARI_AGENT_INTERNAL")?
}
#[tauri::command]
pub fn komari_agent_transfer_record(
    app: tauri::AppHandle,
    vault_id: String,
    host_id: String,
) -> Result<Option<Transfer>, String> {
    app.state::<VaultState>().while_unlocked(&vault_id,|| {let db=store::open(&app)?;initialize(&db)?;let body:Option<String>=db.query_row("SELECT body FROM komari_agent_transfers WHERE vault_id=?1 AND (source_host=?2 OR target_host=?2) ORDER BY rowid DESC LIMIT 1",params![vault_id,host_id],|r|r.get(0)).optional().map_err(storage)?;body.map(|b|serde_json::from_str(&b).map_err(storage)).transpose()})
}
#[tauri::command]
pub async fn komari_agent_transfer_recover(
    app: tauri::AppHandle,
    vault_id: String,
    transfer_id: String,
    action: String,
) -> Result<TransferPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(action.as_str(), "inspect" | "restore" | "finish") {
            return Err("KOMARI_AGENT_ACTION_INVALID".into());
        }
        let row = app.state::<VaultState>().while_unlocked(&vault_id, || {
            read(&store::open(&app)?, &vault_id, &transfer_id)
        })?;
        if matches!(row.status.as_str(), "completed" | "restored") {
            return Err("KOMARI_AGENT_TRANSFER_COMPLETED".into());
        }
        let source = bind(&app, row.source.record.clone())?;
        let target = bind(&app, row.target.record.clone())?;
        cache(TransferPlan {
            row,
            source,
            target,
            settings: Value::Null,
            action,
        })
    })
    .await
    .map_err(|_| "KOMARI_AGENT_INTERNAL")?
}
fn read_end(
    app: &tauri::AppHandle,
    p: &Plan,
    c: &transport::Connection,
) -> Result<Observation, String> {
    state(
        &remote(c, &inspection(p), &|| check(app, p))?,
        Some(&p.identity),
    )
    .map(|(_, s)| s)
}
fn receipt(s: &Observation, id: &str, role: &str, phase: &str) -> bool {
    s.transfer
        .as_ref()
        .is_some_and(|r| r.id == id && r.role == role && r.phase == phase)
}
fn owned(row: &Transfer, source: bool, s: &Observation) -> Result<(), String> {
    let (b, initial, role) = if source {
        (&row.source, &row.source.record.observation, "source")
    } else {
        (&row.target, &row.target.record.observation, "target")
    };
    if !source && s.status == "absent" && s.transfer.is_none() {
        return Ok(());
    }
    validate_observation(&b.record, s)?;
    if !s
        .transfer
        .as_ref()
        .is_some_and(|r| r.id == row.id && r.role == role)
        && !(source && s == initial)
    {
        return Err("KOMARI_AGENT_TRANSFER_IDENTITY_CHANGED".into());
    }
    Ok(())
}
fn dispatch(
    app: &tauri::AppHandle,
    p: &TransferPlan,
    c: &transport::Connection,
    source: bool,
    action: &str,
    expected: &Observation,
    extra: Value,
) -> Result<Observation, String> {
    let end = if source { &p.source } else { &p.target };
    check(app, &p.source)?;
    check(app, &p.target)?;
    let mut request = json!({"action":action,"deployment":end.deployment,"identity":end.identity,"expected":expected,"job":p.row.job_id,"transferId":p.row.id});
    if let Some(extra) = extra.as_object() {
        for (k, v) in extra {
            request[k] = v.clone();
        }
    }
    let (_, s) = state(
        &remote(c, &request, &|| {
            check(app, &p.source)?;
            check(app, &p.target)
        })?,
        Some(&end.identity),
    )?;
    owned(&p.row, source, &s)?;
    Ok(s)
}
fn run(app: &tauri::AppHandle, id: &str, confirmed: bool) -> Result<Transfer, String> {
    let mut p = TRANSFERS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "KOMARI_AGENT_BUSY")?
        .get(id)
        .cloned()
        .ok_or("KOMARI_AGENT_SCOPE_CHANGED")?;
    if p.action != "inspect" && !confirmed {
        return Err("KOMARI_AGENT_CONFIRMATION_REQUIRED".into());
    }
    let _source_lease = lease(&p.row.vault, &p.source.host.id)?;
    let _target_lease = if p.source.host.id != p.target.host.id {
        Some(lease(&p.row.vault, &p.target.host.id)?)
    } else {
        None
    };
    check(app, &p.source)?;
    check(app, &p.target)?;
    let source = connect(app, &p.source)?;
    let target = connect(app, &p.target)?;
    let ss = read_end(app, &p.source, &source)?;
    let ts = read_end(app, &p.target, &target)?;
    if p.action == "move" {
        if ss != p.row.source_state || ts != p.row.target_state {
            return Err("KOMARI_AGENT_STATE_CHANGED".into());
        }
    } else {
        owned(&p.row, true, &ss)?;
        owned(&p.row, false, &ts)?;
    }
    p.row.source_state = ss;
    p.row.target_state = ts;
    app.state::<VaultState>()
        .while_unlocked(&p.row.vault.clone(), || {
            start(&mut store::open(app)?, &mut p)
        })?;
    let result = (|| {
        if p.action == "move" {
            artifact::require_shellbeam(
                p.target
                    .release
                    .as_ref()
                    .ok_or("KOMARI_AGENT_RELEASE_REQUIRED")?,
            )?;
            let scope = p
                .target
                .source
                .as_ref()
                .ok_or("KOMARI_AGENT_SOURCE_REQUIRED")?;
            let api = service::Remote::new(app, scope)?;
            super::super::monitoring_identity::require_shellbeam(&api.call(
                "/api/version",
                None,
                None,
                None,
            )?)?;
            let bytes = artifact::download(
                p.target
                    .release
                    .as_ref()
                    .ok_or("KOMARI_AGENT_RELEASE_REQUIRED")?,
                &artifact::policy(app)?,
            )?;
            let config = configuration(
                &p.settings,
                &p.target.endpoint,
                agent_token(app, &p.target)?,
            )?;
            if fingerprint(&config)? != p.row.target.record.configuration.as_ref().unwrap().sha256 {
                return Err("KOMARI_AGENT_CONFIGURATION_CHANGED".into());
            }
            // Recheck the source token and settings before stopping anything.
            let current=remote(&source,&json!({"action":"export-settings","deployment":p.source.deployment,"identity":p.source.identity,"expected":p.row.source_state,"agentToken":agent_token(app,&p.source)?}),&||check(app,&p.source))?.settings;
            if current.as_ref() != Some(&p.settings) {
                return Err("KOMARI_AGENT_CONFIGURATION_CHANGED".into());
            }
            if !(p.source.integration == p.target.integration && p.source.node == p.target.node)
                && watermark(app, &p.target)? >= now_unix_ms() - 60_000
            {
                return Err("KOMARI_AGENT_NODE_ALREADY_REPORTING".into());
            }
            verify_report(
                app,
                &p.source,
                &source,
                &p.row.source_state,
                watermark(app, &p.source)?,
                now_unix_ms(),
            )?;
            p.row.status = "dispatched".into();
            persist(&mut store::open(app)?, &mut p.row, None)?;
            p.row.source_state = dispatch(
                app,
                &p,
                &source,
                true,
                "transfer-reserve",
                &p.row.source_state,
                Value::Null,
            )?;
            persist(&mut store::open(app)?, &mut p.row, None)?;
            p.row.target_state = dispatch(
                app,
                &p,
                &target,
                false,
                "transfer-stage",
                &p.row.target_state,
                json!({"release":p.target.release.as_ref().map(|r|&r.manifest),"bytes":bytes,"configuration":config,"configSha256":p.row.target.record.configuration.as_ref().unwrap().sha256}),
            )?;
            persist(&mut store::open(app)?, &mut p.row, None)?;
            p.row.source_state = dispatch(
                app,
                &p,
                &source,
                true,
                "transfer-stop",
                &p.row.source_state,
                Value::Null,
            )?;
            if p.row.source_state.active {
                return Err("KOMARI_AGENT_PROCESS_NOT_VERIFIED".into());
            }
            persist(&mut store::open(app)?, &mut p.row, None)?;
            let mark = watermark(app, &p.target)?;
            let started = now_unix_ms();
            let retained = if p.source.identity.machine == p.target.identity.machine {
                p.row
                    .source
                    .record
                    .observation
                    .legacy
                    .as_ref()
                    .filter(|l| l.unit == "komari-agent.service")
                    .map(|l| {
                        if p.source.identity.uid == 0 {
                            format!("/etc/systemd/system/{}", l.unit)
                        } else {
                            format!(
                                "{}/.config/systemd/user/{}",
                                p.source
                                    .identity
                                    .root
                                    .split("/.local/share/shellbeam/")
                                    .next()
                                    .unwrap_or(""),
                                l.unit
                            )
                        }
                    })
            } else {
                None
            };
            p.row.target_state = dispatch(
                app,
                &p,
                &target,
                false,
                "transfer-activate",
                &p.row.target_state,
                json!({"retainedUnit":retained}),
            )?;
            persist(&mut store::open(app)?, &mut p.row, None)?;
            verify_report(app, &p.target, &target, &p.row.target_state, mark, started)?;
            let latest = read_end(app, &p.source, &source)?;
            if latest != p.row.source_state || latest.active {
                return Err("KOMARI_AGENT_STATE_CHANGED".into());
            }
        } else if p.action == "restore" {
            if receipt(&p.row.target_state, &p.row.id, "target", "completed")
                || receipt(&p.row.source_state, &p.row.id, "source", "completed")
            {
                return Err("KOMARI_AGENT_TRANSFER_READBACK_REQUIRED".into());
            }
            if p.row.target_state.status != "absent" {
                p.row.target_state = dispatch(
                    app,
                    &p,
                    &target,
                    false,
                    "transfer-abort",
                    &p.row.target_state,
                    Value::Null,
                )?;
                if p.row.target_state.active || p.row.target_state.status != "retired" {
                    return Err("KOMARI_AGENT_PROCESS_NOT_VERIFIED".into());
                }
                persist(&mut store::open(app)?, &mut p.row, None)?;
            }
            let mark = watermark(app, &p.source)?;
            let started = now_unix_ms();
            if p.row
                .source_state
                .transfer
                .as_ref()
                .is_some_and(|r| r.id == p.row.id)
            {
                p.row.source_state = dispatch(
                    app,
                    &p,
                    &source,
                    true,
                    "transfer-resume",
                    &p.row.source_state,
                    Value::Null,
                )?;
            }
            let time = verify_report(app, &p.source, &source, &p.row.source_state, mark, started)?;
            let ts = read_end(app, &p.target, &target)?;
            if ts != p.row.target_state || ts.active {
                return Err("KOMARI_AGENT_STATE_CHANGED".into());
            }
            commit(&mut store::open(app)?, &mut p.row, true, time)?;
            return Ok(());
        }
        // Explicit completion can finish a cutover interrupted between the two
        // receipt writes. Inspect never sends any remote mutation.
        if matches!(p.action.as_str(), "move" | "finish") {
            let ts = read_end(app, &p.target, &target)?;
            let ss = read_end(app, &p.source, &source)?;
            owned(&p.row, true, &ss)?;
            owned(&p.row, false, &ts)?;
            if !ts.active
                || ss.active
                || !(receipt(&ts, &p.row.id, "target", "activated")
                    || receipt(&ts, &p.row.id, "target", "completed"))
                || !(receipt(&ss, &p.row.id, "source", "stopped")
                    || receipt(&ss, &p.row.id, "source", "completed"))
            {
                return Err("KOMARI_AGENT_TRANSFER_READBACK_REQUIRED".into());
            }
            p.row.source_state = ss;
            p.row.target_state = ts;
            verify_report(
                app,
                &p.target,
                &target,
                &p.row.target_state,
                watermark(app, &p.target)?,
                now_unix_ms(),
            )?;
            if receipt(&p.row.target_state, &p.row.id, "target", "activated") {
                p.row.target_state = dispatch(
                    app,
                    &p,
                    &target,
                    false,
                    "transfer-complete",
                    &p.row.target_state,
                    Value::Null,
                )?;
                persist(&mut store::open(app)?, &mut p.row, None)?;
            }
            if receipt(&p.row.source_state, &p.row.id, "source", "stopped") {
                p.row.source_state = dispatch(
                    app,
                    &p,
                    &source,
                    true,
                    "transfer-complete",
                    &p.row.source_state,
                    Value::Null,
                )?;
                persist(&mut store::open(app)?, &mut p.row, None)?;
            }
        }
        // Interrupted rollback can also be committed by readback without replay.
        if p.action == "inspect"
            && receipt(&p.row.source_state, &p.row.id, "source", "rolled-back")
            && !p.row.target_state.active
            && (p.row.target_state.status == "absent"
                || receipt(&p.row.target_state, &p.row.id, "target", "rolled-back"))
        {
            let time = verify_report(
                app,
                &p.source,
                &source,
                &p.row.source_state,
                watermark(app, &p.source)?,
                now_unix_ms(),
            )?;
            commit(&mut store::open(app)?, &mut p.row, true, time)?;
            return Ok(());
        }
        if receipt(&p.row.target_state, &p.row.id, "target", "completed")
            && receipt(&p.row.source_state, &p.row.id, "source", "completed")
            && !p.row.source_state.active
        {
            let time = verify_report(
                app,
                &p.target,
                &target,
                &p.row.target_state,
                watermark(app, &p.target)?,
                now_unix_ms(),
            )?;
            if read_end(app, &p.source, &source)? != p.row.source_state {
                return Err("KOMARI_AGENT_STATE_CHANGED".into());
            }
            commit(&mut store::open(app)?, &mut p.row, false, time)?;
        } else if p.action == "inspect" {
            p.row.status = "needs-recovery".into();
            persist(&mut store::open(app)?, &mut p.row, Some("completed"))?;
        } else {
            return Err("KOMARI_AGENT_TRANSFER_READBACK_REQUIRED".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        p.row.status = "unknown".into();
        p.row.error_code = Some(error);
        persist(&mut store::open(app)?, &mut p.row, Some("unknown"))?;
    }
    Ok(p.row)
}
#[tauri::command]
pub async fn komari_agent_transfer_operate(
    app: tauri::AppHandle,
    plan_id: String,
    confirmed: bool,
) -> Result<Transfer, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app, &plan_id, confirmed))
        .await
        .map_err(|_| "KOMARI_AGENT_INTERNAL")?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    host_id: String,
    host_name: String,
    connection_id: String,
    connection_name: String,
    account: String,
    address: String,
    integration_id: String,
    service_name: String,
    node_id: String,
    endpoint: String,
}
#[tauri::command]
pub fn komari_agent_transfer_destinations(
    app: tauri::AppHandle,
    vault_id: String,
) -> Result<Vec<Destination>, String> {
    app.state::<VaultState>().while_unlocked(&vault_id, || {
        let hosts = hosts::load_hosts(&app, Some(&vault_id))?;
        let integrations = komari::list_komari_integrations(app.clone(), vault_id.clone())?;
        let mut result = Vec::new();
        for integration in integrations.into_iter().filter(|i| i.enabled) {
            let mappings = komari_persistence::get_komari_mapping_state(
                app.clone(),
                vault_id.clone(),
                integration.id.clone(),
            )?;
            for mapping in mappings.mappings {
                if let Some(h) = hosts.iter().find(|h| h.id == mapping.host_id) {
                    let ids: Vec<(String, String)> = h
                        .connections
                        .as_ref()
                        .map(|cs| cs.iter().map(|c| (c.id.clone(), c.label.clone())).collect())
                        .unwrap_or_else(|| vec![(h.id.clone(), h.name.clone())]);
                    for (id, label) in ids {
                        let (h, _) = host_connection(&app, &vault_id, &h.id, Some(&id))?;
                        result.push(Destination {
                            host_id: h.id,
                            host_name: h.name,
                            connection_id: id,
                            connection_name: label,
                            account: h.username,
                            address: h.address,
                            integration_id: integration.id.clone(),
                            service_name: integration.name.clone(),
                            node_id: mapping.node_id.clone(),
                            endpoint: integration.endpoint.clone(),
                        });
                    }
                }
            }
        }
        Ok(result)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan(r: &Record) -> Plan {
        let mut h = super::super::tests::host();
        h.id = r.host_id.clone();
        Plan {
            id: Uuid::new_v4().to_string(),
            vault: r.vault_id.clone(),
            session: 1,
            host: h,
            host_fingerprint: "host-pinned".into(),
            connection_id: r.connection_id.clone(),
            keys: r.host_keys.clone(),
            source: None,
            mapping_fingerprint: Some("mapping-pinned".into()),
            service_identity: r.service_identity.clone(),
            integration: r.integration_id.clone(),
            node: r.node_id.clone(),
            node_created: r.node_created_at.clone(),
            deployment: r.deployment.clone(),
            endpoint: r.endpoint.clone(),
            identity: r.identity.clone(),
            observed: r.observation.clone(),
            baseline: Some(r.clone()),
            release: r.requested.clone(),
            policy_fingerprint: None,
            action: "transfer".into(),
            watermark: 0,
            expires: i64::MAX,
            cancelled: Arc::new(AtomicBool::new(false)),
            legacy_unit: None,
            configuration: r.configuration.clone(),
        }
    }
    fn fixture(same_host: bool) -> (Connection, TransferPlan) {
        let db = jobs::open_database(&std::env::temp_dir().join(format!(
            "shellbeam-transfer-test-{}.sqlite3",
            Uuid::new_v4()
        )))
        .unwrap();
        store::initialize(&db).unwrap();
        initialize(&db).unwrap();
        let mut source = super::super::tests::record();
        source.revision = 1;
        source.status = "active".into();
        source.current = source.requested.clone();
        source.observation = Observation {
            status: "active".into(),
            deployment: Some(source.deployment.clone()),
            current: source.current.as_ref().map(|r| r.manifest.clone()),
            active: true,
            config_sha256: Some("a".repeat(64)),
            endpoint: Some(source.endpoint.clone()),
            ..Default::default()
        };
        source.configuration = Some(ConfigurationIdentity {
            sha256: "a".repeat(64),
            endpoint: source.endpoint.clone(),
        });
        store::put(&db, &source, 0).unwrap();
        let mut target = source.clone();
        target.deployment = Uuid::new_v4().to_string();
        target.revision = 0;
        target.integration_id = "target-service".into();
        target.host_id = if same_host {
            source.host_id.clone()
        } else {
            "target-host".into()
        };
        target.current = None;
        target.connection_id = Some("alternate-ssh".into());
        target.observation = Observation {
            status: "absent".into(),
            ..Default::default()
        };
        let sp = plan(&source);
        let tp = plan(&target);
        let row = Transfer {
            id: Uuid::new_v4().to_string(),
            vault: "vault".into(),
            status: "prepared".into(),
            revision: 0,
            job_id: String::new(),
            target_job_id: None,
            source: bound(&sp, source.clone()),
            target: bound(&tp, target.clone()),
            target_previous: same_host.then_some(source.clone()),
            source_state: source.observation.clone(),
            target_state: target.observation.clone(),
            updated_at: 1,
            error_code: None,
        };
        (
            db,
            TransferPlan {
                row,
                source: sp,
                target: tp,
                settings: json!({}),
                action: "move".into(),
            },
        )
    }
    #[test]
    fn two_host_locks_and_audit_are_atomic_and_stop_ordinary_lifecycle() {
        let (mut db, mut p) = fixture(false);
        start(&mut db, &mut p).unwrap();
        for h in ["host", "target-host"] {
            assert!(unlocked(&db, "vault", h).is_err());
        }
        assert!(unlocked(&db, "other-vault", "host").is_ok());
        let job = jobs::get_on(&db, &p.row.job_id).unwrap().unwrap();
        assert_eq!(job.confirmation_status, "confirmed");
        assert_eq!(job.status, "running");
        let mut r = p.row.source.record.clone();
        assert!(store::begin(&mut db, &mut r, &p.source.host, "ssh-direct", 1).is_err());
        let mut competing = p.clone();
        competing.row.revision = 0;
        competing.row.id = Uuid::new_v4().to_string();
        assert!(start(&mut db, &mut competing).is_err());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM operation_jobs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(p.row.target_job_id.is_some());
        assert_eq!(
            jobs::get_on(&db, p.row.target_job_id.as_ref().unwrap())
                .unwrap()
                .unwrap()
                .host_id
                .as_deref(),
            Some("target-host")
        );
        assert_eq!(read(&db, "vault", &p.row.id).unwrap().revision, 1);
        assert!(read(&db, "other-vault", &p.row.id).is_err());
    }
    #[test]
    fn target_revision_conflict_rolls_back_source_lock_and_job() {
        let (mut db, mut p) = fixture(false);
        let mut target = p.row.target.record.clone();
        target.revision = 1;
        store::put(&db, &target, 0).unwrap();
        assert!(start(&mut db, &mut p).is_err());
        assert!(unlocked(&db, "vault", "host").is_ok());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM operation_jobs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn readback_creates_separate_job_without_rewriting_unknown_outcome() {
        let (mut db, mut p) = fixture(false);
        start(&mut db, &mut p).unwrap();
        let original = p.row.job_id.clone();
        p.row.status = "unknown".into();
        persist(&mut db, &mut p.row, Some("unknown")).unwrap();
        let saved = read(&db, "vault", &p.row.id).unwrap();
        assert_eq!(saved.source.record.node_id, p.row.source.record.node_id);
        p.row = saved;
        p.action = "inspect".into();
        start(&mut db, &mut p).unwrap();
        assert_ne!(original, p.row.job_id);
        assert_eq!(
            jobs::get_on(&db, &original).unwrap().unwrap().status,
            "unknown"
        );
        let job = jobs::get_on(&db, &p.row.job_id).unwrap().unwrap();
        assert!(!job.confirmation_required);
        assert!(unlocked(&db, "vault", "target-host").is_err());
    }
    #[test]
    fn same_host_cutover_preserves_original_snapshot_and_selected_connection() {
        let (mut db, mut p) = fixture(true);
        let original = serde_json::to_value(&p.row.source.record).unwrap();
        start(&mut db, &mut p).unwrap();
        p.row.target_state = Observation {
            status: "active".into(),
            deployment: Some(p.row.target.record.deployment.clone()),
            active: true,
            current: p
                .row
                .target
                .record
                .requested
                .as_ref()
                .map(|r| r.manifest.clone()),
            config_sha256: Some("a".repeat(64)),
            endpoint: Some(p.row.target.record.endpoint.clone()),
            ..Default::default()
        };
        commit(&mut db, &mut p.row, false, 100).unwrap();
        let active = store::get(&db, "vault", "host").unwrap().unwrap();
        assert_eq!(active.integration_id, "target-service");
        assert_eq!(active.connection_id.as_deref(), Some("alternate-ssh"));
        assert_eq!(active.observed_at, Some(100));
        let saved = read(&db, "vault", &p.row.id).unwrap();
        assert_eq!(serde_json::to_value(saved.source.record).unwrap(), original);
        assert!(unlocked(&db, "vault", "host").is_ok());
        assert_eq!(
            jobs::get_on(&db, &p.row.job_id).unwrap().unwrap().status,
            "completed"
        );
    }
    #[test]
    fn interrupted_restore_releases_both_locks_and_keeps_target_files_in_intent() {
        let (mut db, mut p) = fixture(false);
        start(&mut db, &mut p).unwrap();
        p.action = "restore".into();
        start(&mut db, &mut p).unwrap();
        commit(&mut db, &mut p.row, true, 200).unwrap();
        assert_eq!(
            store::get(&db, "vault", "host")
                .unwrap()
                .unwrap()
                .observed_at,
            Some(200)
        );
        assert!(store::get(&db, "vault", "target-host").unwrap().is_none());
        assert_eq!(
            read(&db, "vault", &p.row.id)
                .unwrap()
                .target
                .record
                .connection_id
                .as_deref(),
            Some("alternate-ssh")
        );
        assert!(unlocked(&db, "vault", "host").is_ok());
        assert!(unlocked(&db, "vault", "target-host").is_ok());
    }
    #[test]
    fn wrong_receipts_and_changed_configuration_cannot_be_claimed_as_recovery() {
        let (_, p) = fixture(false);
        let mut s = p.row.source_state.clone();
        s.transfer = Some(TransferReceipt {
            id: Uuid::new_v4().to_string(),
            role: "source".into(),
            phase: "stopped".into(),
        });
        assert!(owned(&p.row, true, &s).is_err());
        s.transfer = Some(TransferReceipt {
            id: p.row.id.clone(),
            role: "source".into(),
            phase: "stopped".into(),
        });
        s.config_sha256 = Some("b".repeat(64));
        assert!(owned(&p.row, true, &s).is_err());
        assert!(owned(&p.row, true, &p.row.source_state).is_ok());
    }
}
