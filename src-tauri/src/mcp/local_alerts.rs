//! Authorized local lifecycle mutations. No SSH, provider or notification sink
//! is called here; the durable alert audit drives the existing UI/runtime.
use super::{policy, protocol, store, Client, McpState};
use crate::data::{hosts::HostProfile, local_ops, operation_jobs};
use crate::storage::{data_file_path, now_unix_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use tauri::Manager;

// The MCP runtime already has one process owner. Serialize local metadata
// requests through lookup/create/commit so simultaneous identical requests
// cannot create two canonical jobs before their persistent lookup sees one.
static ACTION_GATE: Mutex<()> = Mutex::new(());
pub(super) fn lock_actions() -> Result<MutexGuard<'static, ()>, String> {
    ACTION_GATE
        .lock()
        .map_err(|_| "MCP_STATE_UNAVAILABLE".into())
}

trait Repository {
    fn authorize(&self, client: &Client, host: &HostProfile, tool: &str) -> Result<(), String>;
    fn jobs(&self) -> Result<Connection, String>;
    fn audit(&self, client: &Client, host: &HostProfile, tool: &str) -> Result<(), String>;
    fn mutate(
        &self,
        client: &Client,
        host: &HostProfile,
        tool: &str,
        action: &local_ops::LocalOpsAlertAction,
        revision: i64,
    ) -> Result<local_ops::LocalOpsDocument, String>;
}

fn authorize_current(
    current: &Client,
    expected: &Client,
    current_host: &HostProfile,
    expected_host: &HostProfile,
    tool: &str,
) -> Result<(), String> {
    if current.id != expected.id || current.vault_id != expected.vault_id {
        return Err("CLIENT_REVOKED".into());
    }
    if !current.allows(tool) {
        return Err("PERMISSION_DENIED".into());
    }
    current.authorize_host(current_host)?;
    if current_host.id != expected_host.id
        || policy::identity(current_host) != policy::identity(expected_host)
    {
        return Err("HOST_CHANGED".into());
    }
    Ok(())
}

struct AppRepository<'a>(&'a tauri::AppHandle);
impl AppRepository<'_> {
    fn authorized<T>(
        &self,
        client: &Client,
        host: &HostProfile,
        tool: &str,
        work: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self.0.state::<McpState>();
        let settings = state.settings.lock().map_err(|_| "MCP_STATE_UNAVAILABLE")?;
        if !settings.enabled {
            return Err("MCP_DISABLED".into());
        }
        let current = settings
            .clients
            .iter()
            .find(|row| row.id == client.id)
            .ok_or("CLIENT_REVOKED")?;
        let hosts = crate::data::hosts::load_hosts(self.0, Some(&current.vault_id))?;
        let current_host = hosts
            .iter()
            .find(|row| row.id == host.id)
            .ok_or("HOST_NOT_FOUND")?;
        authorize_current(current, client, current_host, host, tool)?;
        // Keep the settings lock through the metadata transaction: revoking
        // manageAlerts/client/host grants cannot race the final permission check.
        work()
    }
}
impl Repository for AppRepository<'_> {
    fn authorize(&self, client: &Client, host: &HostProfile, tool: &str) -> Result<(), String> {
        self.authorized(client, host, tool, || Ok(()))
    }
    fn jobs(&self) -> Result<Connection, String> {
        operation_jobs::open_database(&data_file_path(self.0, "operation_jobs.sqlite3")?)
    }
    fn audit(&self, client: &Client, host: &HostProfile, tool: &str) -> Result<(), String> {
        store::audit(self.0, &client.id, Some(&host.id), tool, "starting")
    }
    fn mutate(
        &self,
        client: &Client,
        host: &HostProfile,
        tool: &str,
        action: &local_ops::LocalOpsAlertAction,
        revision: i64,
    ) -> Result<local_ops::LocalOpsDocument, String> {
        self.authorized(client, host, tool, || {
            local_ops::apply_authorized_mcp_alert_action(self.0, &client.id, action, revision)
        })
    }
}

fn existing_job(
    db: &Connection,
    actor: &str,
    request_id: &str,
) -> Result<Option<operation_jobs::OperationJob>, String> {
    let id = db.query_row(
        "SELECT job_id FROM operation_jobs WHERE source='mcp' AND actor=?1 AND request_id=?2 ORDER BY queued_at DESC LIMIT 1",
        params![actor, request_id], |row| row.get::<_, String>(0),
    ).optional().map_err(|_| "MCP_OPERATION_LOOKUP_FAILED")?;
    id.map(|id| operation_jobs::get_on(db, &id).and_then(|job| job.ok_or("JOB_NOT_FOUND".into())))
        .transpose()
}

fn job_result(job: &operation_jobs::OperationJob, deduplicated: bool) -> Result<Value, String> {
    Ok(json!({
        "jobId":job.job_id,"operationJobId":job.job_id,"operationAuditId":job.audit_id,
        "status":job.status,"operationJob":serde_json::to_value(job).map_err(|_| "OPERATION_JOB_SERIALIZATION_FAILED")?,
        "deduplicated":deduplicated,"localOnly":true,"alertSource":"local-ops"
    }))
}

fn finish(
    db: &Connection,
    job: &operation_jobs::OperationJob,
    status: &str,
    summary: Option<&str>,
    code: Option<&str>,
) -> Result<operation_jobs::OperationJob, String> {
    operation_jobs::update_on(
        db,
        operation_jobs::UpdateOperationJobRequest {
            job_id: job.job_id.clone(),
            status: status.into(),
            confirmation_status: None,
            confirmed_by: None,
            result_summary: summary.map(str::to_owned),
            error_code: code.map(str::to_owned),
            error_summary: code.map(str::to_owned),
            actor: Some(job.actor.clone()),
        },
    )
}

fn execute(
    repository: &impl Repository,
    client: &Client,
    host: &HostProfile,
    tool: &str,
    args: Value,
) -> Result<Value, String> {
    protocol::validate_arguments(tool, &args)?;
    if args["alertSource"] != "local-ops" {
        return Err("LOCAL_OPS_ALERT_SOURCE_REQUIRED".into());
    }
    let _guard = lock_actions()?;
    repository.authorize(client, host, tool)?;
    let request_id = args["requestId"].as_str().ok_or("REQUEST_ID_REQUIRED")?;
    let rule_id = args["ruleId"].as_str().ok_or("LOCAL_OPS_RULE_REQUIRED")?;
    let revision = args["expectedRevision"]
        .as_i64()
        .ok_or("LOCAL_OPS_REVISION_REQUIRED")?;
    let action = match tool {
        "acknowledge_server_alert" => "acknowledge",
        "close_server_alert" => "close",
        _ => return Err("UNKNOWN_TOOL".into()),
    };
    let actor = format!("mcp-client:{}", client.id);
    let operation_action = format!("mcp.{tool}");
    let hash = policy::digest(
        serde_json::to_vec(&json!([tool, args, policy::identity(host)]))
            .map_err(|_| "INVALID_ARGUMENTS")?,
    );
    let summary = format!("requestHash={hash}");
    let jobs = repository.jobs()?;
    if let Some(job) = existing_job(&jobs, &actor, request_id)? {
        if job.vault_id.as_deref() != Some(&client.vault_id)
            || job.host_id.as_deref() != Some(&host.id)
            || job.action != operation_action
            || job.params_summary.as_deref() != Some(summary.as_str())
        {
            return Err(
                "REQUEST_ID_CONFLICT: use a new requestId for a different operation".into(),
            );
        }
        // Includes nonterminal/unknown rows after a crash. Recover the audit;
        // never replay a metadata write just because completion was interrupted.
        return job_result(&job, true);
    }
    let job = operation_jobs::create_on(
        &jobs,
        operation_jobs::CreateOperationJobRequest {
            host_id: Some(host.id.clone()),
            vault_id: Some(client.vault_id.clone()),
            host_name: Some(host.name.clone()),
            host_address: Some(host.address.clone()),
            username: Some(host.username.clone()),
            source: "mcp".into(),
            actor: Some(actor),
            action: operation_action,
            target: rule_id.into(),
            risk: "low".into(),
            provider: Some("local-ops".into()),
            transport: Some("local".into()),
            params_summary: Some(summary),
            confirmation_required: false,
            request_id: Some(request_id.into()),
        },
    )?;
    if repository.audit(client, host, tool).is_err() {
        let _ = finish(&jobs, &job, "failed", None, Some("mcp_access_audit_failed"));
        return Err("MCP_AUDIT_FAILED".into());
    }
    let running = finish(&jobs, &job, "running", None, None)?;
    let request = local_ops::LocalOpsAlertAction {
        vault_id: client.vault_id.clone(),
        host_id: host.id.clone(),
        rule_id: rule_id.into(),
        action: action.into(),
        operation_job_id: running.job_id.clone(),
    };
    let document = match repository.mutate(client, host, tool, &request, revision) {
        Ok(document) => document,
        Err(error) => {
            let _ = finish(&jobs, &running, "failed", None, Some(&error));
            return Err(error);
        }
    };
    let completed = finish(
        &jobs,
        &running,
        "completed",
        Some("local alert lifecycle persisted"),
        None,
    )
    .map_err(|_| "MCP_OPERATION_AUDIT_FAILED")?;
    let mut result = job_result(&completed, false)?;
    result["ruleId"] = json!(rule_id);
    result["revision"] = json!(document.revision);
    result["alert"] = document.payload["alerts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["ruleId"] == rule_id))
        .cloned()
        .unwrap_or(Value::Null);
    result["audit"] = document.payload["audit"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["operationJobId"] == completed.job_id)
        })
        .cloned()
        .unwrap_or(Value::Null);
    result["observedAt"] = json!(now_unix_ms());
    Ok(result)
}

pub(super) fn submit(
    app: &tauri::AppHandle,
    client: &Client,
    host: &HostProfile,
    tool: &str,
    args: Value,
) -> Result<Value, String> {
    execute(&AppRepository(app), client, host, tool, args)
}

pub(super) fn authorized<T>(
    app: &tauri::AppHandle,
    client: &Client,
    host: &HostProfile,
    tool: &str,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    AppRepository(app).authorized(client, host, tool, work)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Barrier,
    };

    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    struct TestRepository {
        directory: Arc<Directory>,
        current: Mutex<Client>,
        host: Mutex<HostProfile>,
        audit_fails: AtomicBool,
        revoke_after_audit: AtomicBool,
        writes: AtomicUsize,
    }
    fn host() -> HostProfile {
        serde_json::from_value(json!({"id":"host","name":"Fixture","address":"127.0.0.1","port":2222,"username":"ops","authType":"privateKey","group":"","tags":[],"createdAt":1,"updatedAt":1})).unwrap()
    }
    fn client(id: &str) -> Client {
        Client {
            id: id.into(),
            name: id.into(),
            vault_id: "vault".into(),
            hosts: vec![policy::HostGrant {
                id: host().id,
                identity: policy::identity(&host()),
                connections: None,
            }],
            snippets: vec![],
            permissions: policy::Permissions {
                manage_alerts: true,
                ..Default::default()
            },
            created_at: 1,
            token_hash: None,
        }
    }
    fn args(rule: &str, request: &str, revision: i64) -> Value {
        json!({"hostId":"host","alertSource":"local-ops","ruleId":rule,"expectedRevision":revision,"requestId":request})
    }
    impl TestRepository {
        fn new(metric: &str, rule: &str) -> Self {
            let directory = Arc::new(Directory(std::env::temp_dir().join(format!(
                "shellbeam-mcp-local-alert-{}",
                uuid::Uuid::new_v4()
            ))));
            std::fs::create_dir(&directory.0).unwrap();
            let repository = Self {
                directory,
                current: Mutex::new(client("client")),
                host: Mutex::new(host()),
                audit_fails: AtomicBool::new(false),
                revoke_after_audit: AtomicBool::new(false),
                writes: AtomicUsize::new(0),
            };
            let db = local_ops::open_database(&repository.directory.0.join("observations.sqlite3"))
                .unwrap();
            let state = json!({"version":1,"alerts":[{"ruleId":rule,"hostId":"host","name":"Fixture alert","metric":metric,"status":"active","severity":"warning","openedAt":1,"updatedAt":1,"resolvedAt":null,"value":1,"source":"ssh-agentless","transport":"proxy-jump"}],"evaluations":[],"audit":[]});
            for vault in ["vault", "other-vault"] {
                db.execute("INSERT INTO local_ops_documents(vault_id,host_id,kind,payload_json,revision,updated_at) VALUES(?1,'host','alert-state',?2,1,1)", params![vault,state.to_string()]).unwrap();
            }
            repository
        }
        fn reopened(&self) -> Self {
            Self {
                directory: self.directory.clone(),
                current: Mutex::new(self.current.lock().unwrap().clone()),
                host: Mutex::new(self.host.lock().unwrap().clone()),
                audit_fails: AtomicBool::new(false),
                revoke_after_audit: AtomicBool::new(false),
                writes: AtomicUsize::new(0),
            }
        }
        fn document(&self, vault: &str) -> (Value, i64) {
            let db =
                local_ops::open_database(&self.directory.0.join("observations.sqlite3")).unwrap();
            let (raw, revision): (String,i64) = db.query_row("SELECT payload_json,revision FROM local_ops_documents WHERE vault_id=?1 AND host_id='host' AND kind='alert-state'", [vault], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
            (serde_json::from_str(&raw).unwrap(), revision)
        }
        fn job_count(&self) -> i64 {
            self.jobs()
                .unwrap()
                .query_row("SELECT count(*) FROM operation_jobs", [], |row| row.get(0))
                .unwrap()
        }
    }
    impl Repository for TestRepository {
        fn authorize(
            &self,
            expected: &Client,
            expected_host: &HostProfile,
            tool: &str,
        ) -> Result<(), String> {
            authorize_current(
                &self.current.lock().unwrap(),
                expected,
                &self.host.lock().unwrap(),
                expected_host,
                tool,
            )
        }
        fn jobs(&self) -> Result<Connection, String> {
            operation_jobs::open_database(&self.directory.0.join("jobs.sqlite3"))
        }
        fn audit(&self, _: &Client, _: &HostProfile, _: &str) -> Result<(), String> {
            if self.audit_fails.load(Ordering::SeqCst) {
                return Err("MCP_AUDIT_FAILED".into());
            }
            if self.revoke_after_audit.load(Ordering::SeqCst) {
                self.current.lock().unwrap().permissions.manage_alerts = false;
            }
            Ok(())
        }
        fn mutate(
            &self,
            expected: &Client,
            expected_host: &HostProfile,
            tool: &str,
            action: &local_ops::LocalOpsAlertAction,
            revision: i64,
        ) -> Result<local_ops::LocalOpsDocument, String> {
            let current = self.current.lock().unwrap();
            authorize_current(
                &current,
                expected,
                &self.host.lock().unwrap(),
                expected_host,
                tool,
            )?;
            let jobs = self.jobs()?;
            let job =
                operation_jobs::get_on(&jobs, &action.operation_job_id)?.ok_or("JOB_NOT_FOUND")?;
            let mut db = local_ops::open_database(&self.directory.0.join("observations.sqlite3"))?;
            let result = local_ops::apply_authorized_mcp_alert_action_on(
                &mut db,
                &expected.id,
                action,
                &job,
                revision,
                now_unix_ms(),
            )?;
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(result)
        }
    }

    #[test]
    fn service_check_and_probe_actions_reopen_canonical_audits_without_human_confirmation() {
        for (metric, rule) in [
            ("service", "fixture-service"),
            ("health-check", "check:fixture"),
            ("probe-provider", "probe:ssh-agentless:hash:metrics"),
        ] {
            let repository = TestRepository::new(metric, rule);
            let first = execute(
                &repository,
                &client("client"),
                &host(),
                "acknowledge_server_alert",
                args(rule, "ack", 1),
            )
            .unwrap();
            assert_eq!(first["alert"]["status"], "acknowledged");
            assert_eq!(first["alert"]["metric"], metric);
            assert_eq!(first["alert"]["transport"], "proxy-jump");
            assert_eq!(first["operationJob"]["confirmationStatus"], "not_required");
            assert_eq!(first["operationJob"]["confirmationRequired"], false);
            assert!(first["operationJob"]["confirmedBy"].is_null());
            assert_eq!(first["operationJob"]["source"], "mcp");
            assert_eq!(first["operationJob"]["actor"], "mcp-client:client");
            assert_eq!(first["audit"]["actor"], "mcp-client:client");
            assert_eq!(first["audit"]["operationJobId"], first["jobId"]);
            let reopened = repository.reopened();
            let recovered = execute(
                &reopened,
                &client("client"),
                &host(),
                "acknowledge_server_alert",
                args(rule, "ack", 1),
            )
            .unwrap();
            assert_eq!(recovered["jobId"], first["jobId"]);
            assert_eq!(recovered["deduplicated"], true);
            assert_eq!(reopened.writes.load(Ordering::SeqCst), 0);
            let closed = execute(
                &reopened,
                &client("client"),
                &host(),
                "close_server_alert",
                args(rule, "close", 2),
            )
            .unwrap();
            assert_eq!(closed["alert"]["status"], "closed");
            assert_eq!(closed["revision"], 3);
            let (document, revision) = repository.document("vault");
            assert_eq!(revision, 3);
            let audits = document["audit"].as_array().unwrap();
            assert_eq!(audits.len(), 2);
            assert_eq!(audits[0]["operationJobId"], first["jobId"]);
            assert_eq!(audits[1]["operationJobId"], closed["jobId"]);
            assert_eq!(
                repository.document("other-vault").0["alerts"][0]["status"],
                "active"
            );
            assert_eq!(reopened.job_count(), 2);
        }
    }

    #[test]
    fn revision_conflicts_and_request_id_changes_never_replay_a_write() {
        let repository = TestRepository::new("probe-provider", "probe:ssh-agentless:hash:metrics");
        let stale = args("probe:ssh-agentless:hash:metrics", "request", 0);
        assert_eq!(
            execute(
                &repository,
                &client("client"),
                &host(),
                "acknowledge_server_alert",
                stale.clone()
            )
            .unwrap_err(),
            "LOCAL_OPS_REVISION_CONFLICT"
        );
        let duplicate = execute(
            &repository,
            &client("client"),
            &host(),
            "acknowledge_server_alert",
            stale,
        )
        .unwrap();
        assert_eq!(duplicate["status"], "failed");
        assert_eq!(duplicate["deduplicated"], true);
        assert!(execute(
            &repository,
            &client("client"),
            &host(),
            "acknowledge_server_alert",
            args("probe:ssh-agentless:hash:metrics", "request", 1)
        )
        .unwrap_err()
        .starts_with("REQUEST_ID_CONFLICT"));
        assert_eq!(repository.document("vault").1, 1);
        assert_eq!(repository.writes.load(Ordering::SeqCst), 0);
        execute(
            &repository,
            &client("client"),
            &host(),
            "acknowledge_server_alert",
            args("probe:ssh-agentless:hash:metrics", "new-request", 1),
        )
        .unwrap();
        assert_eq!(repository.document("vault").1, 2);
    }

    #[test]
    fn current_permission_host_and_access_audit_are_required_before_any_mutation() {
        for failure in [
            "permission",
            "host",
            "vault",
            "audit",
            "revoked-after-audit",
        ] {
            let repository = TestRepository::new("service", "service");
            match failure {
                "permission" => {
                    repository.current.lock().unwrap().permissions.manage_alerts = false
                }
                "host" => repository.host.lock().unwrap().port = 3333,
                "vault" => repository.current.lock().unwrap().vault_id = "other-vault".into(),
                "audit" => repository.audit_fails.store(true, Ordering::SeqCst),
                _ => repository.revoke_after_audit.store(true, Ordering::SeqCst),
            }
            assert!(execute(
                &repository,
                &client("client"),
                &host(),
                "close_server_alert",
                args("service", "request", 1)
            )
            .is_err());
            assert_eq!(repository.document("vault").1, 1);
            assert_eq!(
                repository.document("vault").0["alerts"][0]["status"],
                "active"
            );
            assert_eq!(repository.writes.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn concurrent_identical_requests_commit_one_action_and_clients_do_not_share_request_ids() {
        let repository = Arc::new(TestRepository::new("health-check", "check:fixture"));
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let repository = repository.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    execute(
                        &*repository,
                        &client("client"),
                        &host(),
                        "acknowledge_server_alert",
                        args("check:fixture", "same", 1),
                    )
                    .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results[0]["jobId"], results[1]["jobId"]);
        assert_eq!(repository.job_count(), 1);
        assert_eq!(repository.writes.load(Ordering::SeqCst), 1);
        *repository.current.lock().unwrap() = client("another-client");
        let other = execute(
            &*repository,
            &client("another-client"),
            &host(),
            "close_server_alert",
            args("check:fixture", "same", 2),
        )
        .unwrap();
        assert_ne!(other["jobId"], results[0]["jobId"]);
        assert_eq!(other["operationJob"]["actor"], "mcp-client:another-client");
        assert_eq!(repository.job_count(), 2);
    }

    #[test]
    fn nonterminal_canonical_job_after_restart_is_returned_without_mutating() {
        let repository = TestRepository::new("service", "service");
        let request = args("service", "interrupted", 1);
        let hash = policy::digest(
            serde_json::to_vec(&json!([
                "close_server_alert",
                request,
                policy::identity(&host())
            ]))
            .unwrap(),
        );
        let jobs = repository.jobs().unwrap();
        let queued = operation_jobs::create_on(&jobs,serde_json::from_value(json!({"hostId":"host","vaultId":"vault","source":"mcp","actor":"mcp-client:client","action":"mcp.close_server_alert","target":"service","risk":"low","provider":"local-ops","transport":"local","paramsSummary":format!("requestHash={hash}"),"confirmationRequired":false,"requestId":"interrupted"})).unwrap()).unwrap();
        drop(jobs);
        let reopened = repository.reopened();
        let result = execute(
            &reopened,
            &client("client"),
            &host(),
            "close_server_alert",
            request,
        )
        .unwrap();
        assert_eq!(result["jobId"], queued.job_id);
        assert_eq!(result["status"], "queued");
        assert_eq!(result["deduplicated"], true);
        assert_eq!(reopened.document("vault").1, 1);
        assert_eq!(reopened.writes.load(Ordering::SeqCst), 0);
    }
}
