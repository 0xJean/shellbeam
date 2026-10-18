//! Opt-in CI bridge: actual product operations call the real SSH executor and
//! canonical SQLite store. This is not a desktop IPC or production Vault test.
//! Compiled only in the native test executable; no release command registers it.
use super::test_fixture::{server, trusted, Server};
use super::transport::{connect_with_verifier, route_identity, Route};
use super::{commands, SshRequest};
use crate::data::operation_jobs::{self, OperationAuditListQuery, OperationJobListQuery};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const PREFIX: &str = "__SHELLBEAM_OPS_LIVE__";
const VAULT_ID: &str = "ops-live-vault";
const DIRECT_ID: &str = "ops-live-direct";
const JUMP_ID: &str = "ops-live-jump";
const MAX_REQUEST_BYTES: u64 = 128 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: Value,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    /// Accepted run_ssh_command calls, including failed connection attempts.
    command_count: u64,
    /// Mutating commands actually handed to commands::execute, even if failed.
    mutation_count: u64,
    executed_command_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandSummary {
    host_id: String,
    /// Fixed classification, never the supplied command or remote output.
    summary: &'static str,
    executed: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    #[serde(flatten)]
    counts: Counts,
    by_host: BTreeMap<String, Counts>,
    commands: Vec<CommandSummary>,
}

struct Bridge {
    target: Server,
    jump: Server,
    database: Option<Connection>,
    database_path: PathBuf,
    fixture: Value,
    stats: Stats,
    disconnect_armed: bool,
    shutdown: bool,
}

fn require_opt_in() -> Result<(), String> {
    if std::env::var("SHELLBEAM_OPS_LIVE").as_deref() != Ok("1") {
        return Err("Live Ops bridge requires SHELLBEAM_OPS_LIVE=1".into());
    }
    if !cfg!(target_os = "linux") {
        return Err("Live Ops bridge requires an isolated Linux runner".into());
    }
    if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || std::env::var("RUNNER_OS").as_deref() != Ok("Linux")
    {
        return Err("Live Ops bridge requires its explicit GitHub Linux CI runner".into());
    }
    #[cfg(unix)]
    if unsafe { libc::geteuid() } != 0 {
        return Err("Live Ops fixture requires its controlled root runner".into());
    }
    Ok(())
}

fn private_state_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Live Ops state must be an existing private directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Live Ops state directory must be owned by the runner and private".into());
        }
    }
    Ok(())
}

fn fixture_metadata() -> Result<Value, String> {
    // The shell runner creates only public fixture metadata here. SSH keys are
    // generated independently by Server and never serialized in this protocol.
    let input = match std::env::var("SHELLBEAM_OPS_LIVE_FIXTURE_FILE") {
        Ok(path) => {
            let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
            let mut text = String::new();
            file.take(MAX_REQUEST_BYTES)
                .read_to_string(&mut text)
                .map_err(|error| error.to_string())?;
            serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())?
        }
        Err(_) => json!({}),
    };
    let field = |env: &str, names: &[&str]| -> Result<String, String> {
        if let Ok(value) = std::env::var(env) {
            if !value.trim().is_empty() {
                return Ok(value);
            }
        }
        names
            .iter()
            .find_map(|name| input[*name].as_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("Missing live Ops fixture field: {env}"))
    };
    let container_id = field("SHELLBEAM_OPS_CONTAINER_ID", &["containerId"])?;
    if container_id.len() != 64 || !container_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Live Ops containerId must be the full immutable Docker id".into());
    }
    let container_name = field("SHELLBEAM_OPS_CONTAINER_NAME", &["containerName"])?;
    let site_name = field("SHELLBEAM_OPS_SITE_NAME", &["siteName"])?;
    let certificate_path = field(
        "SHELLBEAM_OPS_CERTIFICATE_PATH",
        &["certificatePath", "certPath"],
    )?;
    let domains = if let Ok(value) = std::env::var("SHELLBEAM_OPS_DOMAINS") {
        serde_json::from_str::<Vec<String>>(&value).map_err(|error| error.to_string())?
    } else if let Some(values) = ["domains", "siteDomains", "certSAN"]
        .iter()
        .find_map(|name| input[*name].as_array())
    {
        values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Live Ops domains must contain strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![site_name.clone(), format!("www.{site_name}")]
    };
    if domains.is_empty() || domains.len() > 32 {
        return Err("Live Ops fixture requires one to 32 expected domains".into());
    }
    let mut fixture = json!({
        "containerId": container_id,
        "containerName": container_name,
        "siteName": site_name,
        "server": "nginx",
        "certificatePath": certificate_path,
        "domains": domains,
        "logMarker": input["logMarker"].as_str().unwrap_or("SHELLBEAM_OPS_LIVE_CONTAINER_READY"),
    });
    for name in ["fixtureId", "httpPort", "httpsPort", "expectedBody"] {
        if !input[name].is_null() {
            fixture[name] = input[name].clone();
        }
    }
    Ok(fixture)
}

fn command_kind(command: &str) -> (&'static str, bool) {
    let mut words = command.split_whitespace();
    let first = words.next();
    let second = words.next();
    match (first, second) {
        (Some("docker"), Some("start")) => ("docker.start", true),
        (Some("docker"), Some("stop")) => ("docker.stop", true),
        (Some("docker"), Some("restart")) => ("docker.restart", true),
        (Some("docker"), Some("logs")) => ("docker.logs", false),
        (Some("docker"), Some("inspect")) => ("docker.inspect", false),
        (Some("nginx"), Some("-t")) => ("site.config-test", false),
        (Some("systemctl"), Some("reload")) => ("site.reload", true),
        _ if command.contains("__SB_SITE=") => ("sites.scan", false),
        _ if command.contains("__SB_DOCKER=") => ("docker.list", false),
        _ => ("diagnostic.command", false),
    }
}

fn validate_scope(vault_id: Option<&str>, host_id: Option<&str>) -> Result<(), String> {
    if vault_id != Some(VAULT_ID) || !matches!(host_id, Some(DIRECT_ID | JUMP_ID)) {
        return Err("Live Ops scope is limited to the fixture Vault and hosts".into());
    }
    Ok(())
}

impl Bridge {
    fn new() -> Result<Self, String> {
        require_opt_in()?;
        let directory = PathBuf::from(
            std::env::var("SHELLBEAM_OPS_LIVE_STATE_DIR")
                .map_err(|_| "Live Ops bridge requires a private SHELLBEAM_OPS_LIVE_STATE_DIR")?,
        );
        private_state_directory(&directory)?;
        let database_path = directory.join("operation_jobs.sqlite3");
        if std::fs::symlink_metadata(&database_path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("Live Ops database must not be a symbolic link".into());
        }
        let database = operation_jobs::open_database(&database_path)?;
        let fixture = fixture_metadata()?;
        let target = server().ok_or("Live Ops bridge requires a real sshd")?;
        let jump = server().ok_or("Live Ops bridge requires a second real sshd")?;
        Ok(Self {
            target,
            jump,
            database: Some(database),
            database_path,
            fixture,
            stats: Stats::default(),
            disconnect_armed: false,
            shutdown: false,
        })
    }

    fn ready(&self) -> Value {
        let profile = |id: &str, via_jump: bool| {
            let mut profile = json!({
                "id": id, "vaultId": VAULT_ID,
                "name": if via_jump { "Ops live target through jump" } else { "Ops live direct target" },
                "address": self.target.endpoint.host, "port": self.target.endpoint.port,
                "username": self.target.endpoint.username, "authType": "privateKey",
                "group": "Custom", "tags": ["ci-fixture"], "createdAt": 0, "updatedAt": 0,
            });
            if via_jump {
                profile["jumpHostId"] = json!("ops-live-bastion");
                profile["jumpHost"] = json!(self.jump.endpoint.host);
                profile["jumpPort"] = json!(self.jump.endpoint.port);
                profile["jumpUser"] = json!(self.jump.endpoint.username);
            }
            profile
        };
        json!({"type":"ready", "vaultId":VAULT_ID,
            "hosts":{"direct":profile(DIRECT_ID, false), "jump":profile(JUMP_ID, true)},
            "fixture":self.fixture})
    }

    fn database(&self) -> Result<&Connection, String> {
        self.database
            .as_ref()
            .ok_or_else(|| "Live Ops database is closed".into())
    }

    fn remote(&mut self, args: Value) -> Result<Value, String> {
        let payload: SshRequest =
            serde_json::from_value(args["payload"].clone()).map_err(|error| error.to_string())?;
        validate_scope(payload.vault_id.as_deref(), payload.host_id.as_deref())?;
        if payload.command.trim().is_empty() {
            return Err("Remote command is required".into());
        }
        if payload.password.is_some()
            || payload.private_key.is_some()
            || payload.passphrase.is_some()
        {
            return Err("Live Ops client must not send SSH credentials".into());
        }
        let host_id = payload.host_id.as_deref().unwrap();
        let route = Route {
            target: self.target.endpoint.clone(),
            jump: (host_id == JUMP_ID).then(|| self.jump.endpoint.clone()),
        };
        let (summary, mutation) = command_kind(&payload.command);
        self.stats.counts.command_count += 1;
        self.stats
            .by_host
            .entry(host_id.into())
            .or_default()
            .command_count += 1;
        let start = Instant::now();
        let peers = [&self.target, &self.jump];
        // The verifier compares each endpoint to its independently generated key.
        let connection = connect_with_verifier(&route, &mut trusted(&peers));
        let executed = connection.is_ok();
        self.stats.commands.push(CommandSummary {
            host_id: host_id.into(),
            summary,
            executed,
        });
        if self.stats.commands.len() > 256 {
            self.stats.commands.remove(0);
        }
        let connection = connection?;
        self.stats.counts.executed_command_count += 1;
        let counts = self.stats.by_host.get_mut(host_id).unwrap();
        counts.executed_command_count += 1;
        if mutation {
            self.stats.counts.mutation_count += 1;
            counts.mutation_count += 1;
        }
        let limits = &crate::collection_limits::limits().remote;
        let timeout = Duration::from_millis(
            payload
                .timeout_ms
                .unwrap_or(limits.command_timeout_ms)
                .clamp(limits.min_command_timeout_ms, limits.command_timeout_ms),
        );
        let mut result = commands::execute(connection, &payload.command, start, timeout);
        if result.verified_host_keys.is_some() {
            result.host_identity = Some(route_identity(
                &route,
                host_id,
                (host_id == JUMP_ID).then_some("ops-live-bastion"),
            ));
        }
        if self.disconnect_armed
            && matches!(summary, "docker.start" | "docker.stop" | "docker.restart")
            && result.exit_code == 0
            && result.error_type.is_none()
        {
            self.disconnect_armed = false;
            // Do not fabricate a verification result. The next real connection
            // must fail because this endpoint is no longer accepting sessions.
            self.target.stop()?;
        }
        serde_json::to_value(result).map_err(|error| error.to_string())
    }

    fn dispatch(&mut self, request: &Request) -> Result<Value, String> {
        let args = &request.args;
        match request.command.as_str() {
            "run_ssh_command" => self.remote(args.clone()),
            "operation_job_create" => {
                let payload: operation_jobs::CreateOperationJobRequest =
                    serde_json::from_value(args["request"].clone())
                        .map_err(|error| error.to_string())?;
                validate_scope(payload.vault_id.as_deref(), payload.host_id.as_deref())?;
                serde_json::to_value(operation_jobs::create_on(self.database()?, payload)?)
                    .map_err(|error| error.to_string())
            }
            "operation_job_update" => {
                let payload: operation_jobs::UpdateOperationJobRequest =
                    serde_json::from_value(args["request"].clone())
                        .map_err(|error| error.to_string())?;
                let current = operation_jobs::get_on(self.database()?, &payload.job_id)?
                    .ok_or("Live Ops job not found")?;
                validate_scope(current.vault_id.as_deref(), current.host_id.as_deref())?;
                serde_json::to_value(operation_jobs::update_on(self.database()?, payload)?)
                    .map_err(|error| error.to_string())
            }
            "operation_job_get" => {
                let job_id = args["jobId"].as_str().ok_or("jobId is required")?;
                let result = operation_jobs::get_on(self.database()?, job_id)?;
                if let Some(job) = &result {
                    validate_scope(job.vault_id.as_deref(), job.host_id.as_deref())?;
                }
                serde_json::to_value(result).map_err(|error| error.to_string())
            }
            "operation_job_list" => {
                let mut query: OperationJobListQuery = serde_json::from_value(
                    args.get("query")
                        .cloned()
                        .filter(|value| !value.is_null())
                        .unwrap_or(json!({})),
                )
                .map_err(|error| error.to_string())?;
                if query
                    .vault_id
                    .as_deref()
                    .is_some_and(|vault| vault != VAULT_ID)
                {
                    return Err("Live Ops query outside fixture Vault".into());
                }
                query.vault_id = Some(VAULT_ID.into());
                serde_json::to_value(operation_jobs::list_on(self.database()?, query)?)
                    .map_err(|error| error.to_string())
            }
            "operation_audit_list" => {
                let mut query: OperationAuditListQuery = serde_json::from_value(
                    args.get("query")
                        .cloned()
                        .filter(|value| !value.is_null())
                        .unwrap_or(json!({})),
                )
                .map_err(|error| error.to_string())?;
                if query
                    .vault_id
                    .as_deref()
                    .is_some_and(|vault| vault != VAULT_ID)
                {
                    return Err("Live Ops query outside fixture Vault".into());
                }
                query.vault_id = Some(VAULT_ID.into());
                serde_json::to_value(operation_jobs::audit_list_on(self.database()?, query)?)
                    .map_err(|error| error.to_string())
            }
            "ops_live_control" => self.control(
                args["action"]
                    .as_str()
                    .ok_or("control action is required")?,
            ),
            _ => Err("Unsupported live Ops test command".into()),
        }
    }

    fn control(&mut self, action: &str) -> Result<Value, String> {
        match action {
            "stats" => serde_json::to_value(&self.stats).map_err(|error| error.to_string()),
            "arm-disconnect-after-mutation" => {
                self.disconnect_armed = true;
                Ok(json!({"armed":true}))
            }
            "restart-target" => {
                self.target.restart()?;
                Ok(json!({"restarted":true}))
            }
            "reopen-database" => {
                self.database.take();
                self.database = Some(operation_jobs::open_database(&self.database_path)?);
                Ok(json!({"reopened":true}))
            }
            "shutdown" => {
                self.shutdown = true;
                Ok(json!({"shutdown":true}))
            }
            _ => Err("Unsupported live Ops control".into()),
        }
    }
}

fn emit(value: &Value) -> Result<(), String> {
    let mut output = std::io::stdout().lock();
    writeln!(output, "{PREFIX}{value}").map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

fn serve() -> Result<(), String> {
    let mut bridge = Bridge::new()?;
    emit(&bridge.ready())?;
    let input = std::io::stdin();
    let mut input = input.lock();
    loop {
        let mut line = Vec::new();
        let bytes = input
            .by_ref()
            .take(MAX_REQUEST_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            break;
        }
        if bytes as u64 > MAX_REQUEST_BYTES {
            return Err("Live Ops request exceeds input budget".into());
        }
        let request = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => request,
            Err(_) => {
                emit(&json!({"id":null,"result":null,"error":"Invalid live Ops request"}))?;
                continue;
            }
        };
        let response = match bridge.dispatch(&request) {
            Ok(result) => json!({"id":request.id,"result":result,"error":null}),
            Err(error) => json!({"id":request.id,"result":null,"error":error}),
        };
        emit(&response)?;
        if bridge.shutdown {
            break;
        }
    }
    // Dropping the bridge stops both sshd listeners and deletes their keys.
    // The external private state directory belongs to the shell runner so the
    // next process can reopen the same SQLite database before final cleanup.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires the explicitly enabled isolated Linux Ops CI fixture"]
    fn ops_live_bridge() {
        serve().expect("real Ops bridge failed");
    }

    #[test]
    fn fixture_scope_rejects_other_vaults_hosts_and_missing_scope() {
        assert!(validate_scope(Some(VAULT_ID), Some(DIRECT_ID)).is_ok());
        assert!(validate_scope(Some(VAULT_ID), Some(JUMP_ID)).is_ok());
        assert!(validate_scope(Some("production"), Some(DIRECT_ID)).is_err());
        assert!(validate_scope(Some(VAULT_ID), Some("arbitrary-host")).is_err());
        assert!(validate_scope(None, Some(DIRECT_ID)).is_err());
    }

    #[test]
    fn command_accounting_does_not_retain_targets_or_raw_output() {
        assert_eq!(
            command_kind("docker start 'immutable-id'"),
            ("docker.start", true)
        );
        assert_eq!(
            command_kind("docker inspect --format 'private-output' 'id'"),
            ("docker.inspect", false)
        );
        assert_eq!(
            command_kind("docker startup anything"),
            ("diagnostic.command", false)
        );
        let mut stats = Stats::default();
        stats.commands.push(CommandSummary {
            host_id: DIRECT_ID.into(),
            summary: "docker.start",
            executed: true,
        });
        let value = serde_json::to_string(&stats).unwrap();
        assert!(!value.contains("immutable-id"));
        assert!(!value.contains("private-output"));
    }
}
