//! Opt-in CI bridge: actual product operations call the real SSH executor and
//! canonical SQLite store. This is not a desktop IPC or production Vault test.
//! Compiled only in the native test executable; no release command registers it.
use super::test_fixture::{server, server_with_environment, trusted, Server, SessionEnvironment};
use super::transport::{connect_with_verifier, route_identity, Route};
use super::{commands, SshRequest};
use crate::data::operation_jobs::{self, OperationAuditListQuery, OperationJobListQuery};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const PREFIX: &str = "__SHELLBEAM_OPS_LIVE__";
const VAULT_ID: &str = "ops-live-vault";
const DIRECT_ID: &str = "ops-live-direct";
const JUMP_ID: &str = "ops-live-jump";
const PEER_JUMP_ID: &str = "ops-live-peer-jump";
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
    peer: Server,
    database: Option<Connection>,
    database_path: PathBuf,
    fixture: Value,
    stats: Stats,
    disconnect_armed: BTreeSet<Target>,
    shutdown: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Target {
    Primary,
    Peer,
}

fn target_for_host(host_id: &str) -> Result<Target, String> {
    match host_id {
        DIRECT_ID | JUMP_ID => Ok(Target::Primary),
        PEER_JUMP_ID => Ok(Target::Peer),
        _ => Err("Live Ops target is outside the fixture".into()),
    }
}

struct FixtureMetadata {
    public: Value,
    peer_docker_host: String,
    acme: Option<AcmeEnvironment>,
}

struct AcmeEnvironment {
    ca_bundle: String,
    certbot_bin: String,
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

fn fixture_metadata() -> Result<FixtureMetadata, String> {
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
    let state_directory = PathBuf::from(
        std::env::var("SHELLBEAM_OPS_LIVE_STATE_DIR")
            .map_err(|_| "Missing live Ops private state directory")?,
    );
    let (peer, peer_docker_host) =
        peer_fixture(&input, &container_id, &container_name, &state_directory)?;
    fixture["peer"] = peer;
    let acme = acme_fixture(&input, &state_directory)?;
    if let Some((public, _)) = &acme {
        fixture["acme"] = public.clone();
    }
    Ok(FixtureMetadata {
        public: fixture,
        peer_docker_host,
        acme: acme.map(|(_, environment)| environment),
    })
}

fn acme_fixture(input: &Value, state: &Path) -> Result<Option<(Value, AcmeEnvironment)>, String> {
    let acme = &input["acme"];
    if acme.is_null() {
        return Ok(None);
    }
    let root = PathBuf::from(
        input["rootFixtureDir"]
            .as_str()
            .ok_or("Missing live Ops private fixture root")?,
    );
    private_state_directory(&root)?;
    let root = root
        .canonicalize()
        .map_err(|_| "Live Ops private fixture root is unavailable")?;
    if state
        .parent()
        .and_then(|path| path.canonicalize().ok())
        .as_ref()
        != Some(&root)
    {
        return Err("Live Ops ACME environment and state must share the fixture root".into());
    }
    let owned_path = |value: Option<&str>, directory: bool| -> Result<String, String> {
        let path = PathBuf::from(value.ok_or("Missing live Ops ACME environment path")?);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "Live Ops ACME environment path is unavailable")?;
        let canonical = path
            .canonicalize()
            .map_err(|_| "Live Ops ACME environment path is unavailable")?;
        if !path.is_absolute()
            || metadata.file_type().is_symlink()
            || (directory && !metadata.is_dir())
            || (!directory && !metadata.is_file())
            || !canonical.starts_with(&root)
        {
            return Err("Live Ops ACME environment path is outside the private fixture".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err("Live Ops ACME environment must be owned by the fixture runner".into());
            }
        }
        path.to_str()
            .map(str::to_owned)
            .ok_or("Live Ops ACME environment path is invalid".into())
    };
    let ca_bundle = owned_path(acme["transportCAPath"].as_str(), false)?;
    let certbot_bin = owned_path(acme["certbotBinPath"].as_str(), true)?;
    owned_path(Path::new(&certbot_bin).join("certbot").to_str(), false)?;
    let mut public = json!({});
    for name in [
        "managedCertificatePath",
        "certificateName",
        "domains",
        "issuerCAPath",
        "transportCAPath",
        "directoryUrl",
        "initialSerial",
        "initialNotAfter",
        "httpsPort",
    ] {
        let value = acme.get(name).ok_or("Missing live Ops ACME metadata")?;
        public[name] = value.clone();
    }
    Ok(Some((
        public,
        AcmeEnvironment {
            ca_bundle,
            certbot_bin,
        },
    )))
}

fn peer_fixture(
    input: &Value,
    primary_id: &str,
    primary_name: &str,
    state: &Path,
) -> Result<(Value, String), String> {
    let peer = &input["peer"];
    let container_id = peer["containerId"]
        .as_str()
        .ok_or("Missing live Ops peer container identity")?;
    let container_name = peer["containerName"]
        .as_str()
        .ok_or("Missing live Ops peer container name")?;
    if container_id.len() != 64
        || !container_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || container_id == primary_id
        || container_name != primary_name
    {
        return Err(
            "Live Ops peer requires an independent container id and the same fixture name".into(),
        );
    }
    let root = PathBuf::from(
        input["rootFixtureDir"]
            .as_str()
            .ok_or("Missing live Ops private fixture root")?,
    );
    private_state_directory(&root)?;
    let root = root
        .canonicalize()
        .map_err(|_| "Live Ops private fixture root is unavailable")?;
    if state
        .parent()
        .and_then(|path| path.canonicalize().ok())
        .as_ref()
        != Some(&root)
    {
        return Err("Live Ops peer socket and state must share the fixture root".into());
    }
    let docker_host = peer["dockerHost"]
        .as_str()
        .ok_or("Missing live Ops peer Docker socket")?;
    let socket = PathBuf::from(
        docker_host
            .strip_prefix("unix://")
            .ok_or("Live Ops peer Docker endpoint must be a private Unix socket")?,
    );
    if !socket.is_absolute()
        || socket.file_name().and_then(|name| name.to_str()) != Some("peer.sock")
        || socket
            .parent()
            .and_then(|path| path.canonicalize().ok())
            .as_ref()
            != Some(&root)
    {
        return Err("Live Ops peer Docker socket is outside the private fixture root".into());
    }
    let metadata = std::fs::symlink_metadata(&socket)
        .map_err(|_| "Live Ops peer Docker socket is unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(
                "Live Ops peer Docker endpoint must be a socket owned by the fixture runner".into(),
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        return Err("Live Ops peer Docker socket requires Unix".into());
    }
    Ok((
        json!({"containerId":container_id,"containerName":container_name}),
        docker_host.into(),
    ))
}

fn command_kind(command: &str) -> (&'static str, bool) {
    // Both commands create challenge/cache state. Only ssl.renew is expected
    // to replace the live certificate; the smoke verifies that independently.
    match command.trim() {
        "certbot renew --dry-run --non-interactive 2>&1" => return ("ssl.dry-run", true),
        "certbot renew --non-interactive 2>&1" => return ("ssl.renew", true),
        _ => {}
    }
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
    if vault_id != Some(VAULT_ID) || !matches!(host_id, Some(DIRECT_ID | JUMP_ID | PEER_JUMP_ID)) {
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
        let environment = SessionEnvironment {
            requests_ca_bundle: fixture.acme.as_ref().map(|value| value.ca_bundle.as_str()),
            certbot_bin: fixture
                .acme
                .as_ref()
                .map(|value| value.certbot_bin.as_str()),
            ..SessionEnvironment::default()
        };
        let target =
            server_with_environment(environment).ok_or("Live Ops bridge requires a real sshd")?;
        let jump = server().ok_or("Live Ops bridge requires a second real sshd")?;
        let peer = server_with_environment(SessionEnvironment {
            docker_host: Some(&fixture.peer_docker_host),
            ..environment
        })
        .ok_or("Live Ops bridge requires a third independent real sshd")?;
        Ok(Self {
            target,
            jump,
            peer,
            database: Some(database),
            database_path,
            fixture: fixture.public,
            stats: Stats::default(),
            disconnect_armed: BTreeSet::new(),
            shutdown: false,
        })
    }

    fn ready(&self) -> Value {
        let profile = |id: &str, target: &Server, via_jump: bool| {
            let mut profile = json!({
                "id": id, "vaultId": VAULT_ID,
                "name": if id == PEER_JUMP_ID { "Ops live peer target through jump" } else if via_jump { "Ops live target through jump" } else { "Ops live direct target" },
                "address": target.endpoint.host, "port": target.endpoint.port,
                "username": target.endpoint.username, "authType": "privateKey",
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
            "hosts":{"direct":profile(DIRECT_ID, &self.target, false), "jump":profile(JUMP_ID, &self.target, true), "peerJump":profile(PEER_JUMP_ID, &self.peer, true)},
            "fixture":self.fixture})
    }

    fn server_for(&self, target: Target) -> &Server {
        match target {
            Target::Primary => &self.target,
            Target::Peer => &self.peer,
        }
    }

    fn server_for_mut(&mut self, target: Target) -> &mut Server {
        match target {
            Target::Primary => &mut self.target,
            Target::Peer => &mut self.peer,
        }
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
        let target = target_for_host(host_id)?;
        let via_jump = host_id != DIRECT_ID;
        let route = Route {
            target: self.server_for(target).endpoint.clone(),
            jump: via_jump.then(|| self.jump.endpoint.clone()),
            vault_id: None,
        };
        let (summary, mutation) = command_kind(&payload.command);
        self.stats.counts.command_count += 1;
        self.stats
            .by_host
            .entry(host_id.into())
            .or_default()
            .command_count += 1;
        let start = Instant::now();
        let peers = [&self.target, &self.jump, &self.peer];
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
                via_jump.then_some("ops-live-bastion"),
            ));
        }
        if self.disconnect_armed.contains(&target)
            && matches!(
                summary,
                "docker.start" | "docker.stop" | "docker.restart" | "ssl.dry-run" | "ssl.renew"
            )
            && result.exit_code == 0
            && result.error_type.is_none()
        {
            self.disconnect_armed.remove(&target);
            // Do not fabricate a verification result. The next real connection
            // must fail because this endpoint is no longer accepting sessions.
            self.server_for_mut(target).stop()?;
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
                args.get("hostId")
                    .map(|value| value.as_str().ok_or("control hostId must be a string"))
                    .transpose()?,
            ),
            _ => Err("Unsupported live Ops test command".into()),
        }
    }

    fn control(&mut self, action: &str, host_id: Option<&str>) -> Result<Value, String> {
        match action {
            "stats" => serde_json::to_value(&self.stats).map_err(|error| error.to_string()),
            "arm-disconnect-after-mutation" => {
                self.disconnect_armed
                    .insert(target_for_host(host_id.unwrap_or(DIRECT_ID))?);
                Ok(json!({"armed":true}))
            }
            "restart-target" => {
                self.server_for_mut(target_for_host(host_id.unwrap_or(DIRECT_ID))?)
                    .restart()?;
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
    // Dropping the bridge stops all three sshd listeners and deletes their keys.
    // The external private state directory belongs to the shell runner so the
    // next process can reopen the same SQLite database before final cleanup.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    struct Directory(PathBuf);

    #[cfg(unix)]
    impl Directory {
        fn new() -> Self {
            use std::os::unix::fs::PermissionsExt;
            // Unix socket paths must also fit the smaller macOS sockaddr_un.
            let directory =
                Self(PathBuf::from("/tmp").join(format!("sbop-{}", uuid::Uuid::new_v4())));
            std::fs::create_dir_all(&directory.0).unwrap();
            std::fs::set_permissions(&directory.0, std::fs::Permissions::from_mode(0o700)).unwrap();
            directory
        }
    }

    #[cfg(unix)]
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    #[ignore = "requires the explicitly enabled isolated Linux Ops CI fixture"]
    fn ops_live_bridge() {
        serve().expect("real Ops bridge failed");
    }

    #[test]
    fn fixture_scope_rejects_other_vaults_hosts_and_missing_scope() {
        assert!(validate_scope(Some(VAULT_ID), Some(DIRECT_ID)).is_ok());
        assert!(validate_scope(Some(VAULT_ID), Some(JUMP_ID)).is_ok());
        assert!(validate_scope(Some(VAULT_ID), Some(PEER_JUMP_ID)).is_ok());
        assert!(validate_scope(Some("production"), Some(DIRECT_ID)).is_err());
        assert!(validate_scope(Some(VAULT_ID), Some("arbitrary-host")).is_err());
        assert!(validate_scope(None, Some(DIRECT_ID)).is_err());
    }

    #[test]
    fn peer_control_maps_to_an_independent_target_and_keeps_legacy_route_aliases() {
        assert_eq!(target_for_host(DIRECT_ID).unwrap(), Target::Primary);
        assert_eq!(target_for_host(JUMP_ID).unwrap(), Target::Primary);
        assert_eq!(target_for_host(PEER_JUMP_ID).unwrap(), Target::Peer);
        assert!(target_for_host("production-host").is_err());
        let mut armed = BTreeSet::new();
        armed.insert(target_for_host(PEER_JUMP_ID).unwrap());
        assert!(!armed.remove(&target_for_host(DIRECT_ID).unwrap()));
        assert!(armed.remove(&target_for_host(PEER_JUMP_ID).unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn peer_metadata_requires_a_distinct_container_and_a_private_local_daemon_socket() {
        use std::os::unix::net::UnixListener;
        let directory = Directory::new();
        let state = directory.0.join("bridge-state");
        std::fs::create_dir_all(&state).unwrap();
        let socket = directory.0.join("peer.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let primary_id = "a".repeat(64);
        let mut input = json!({"rootFixtureDir": directory.0,
            "peer":{"containerId":"b".repeat(64), "containerName":"same-test-name", "dockerHost":format!("unix://{}", socket.display())}});
        let (public, docker_host) =
            peer_fixture(&input, &primary_id, "same-test-name", &state).unwrap();
        assert_eq!(public["containerId"], "b".repeat(64));
        assert!(public.get("dockerHost").is_none());
        assert_eq!(docker_host, format!("unix://{}", socket.display()));
        input["peer"]["containerId"] = json!(primary_id);
        assert!(peer_fixture(&input, &primary_id, "same-test-name", &state).is_err());
        input["peer"]["containerId"] = json!("b".repeat(64));
        input["peer"]["containerName"] = json!("wrong-resource");
        assert!(peer_fixture(&input, &primary_id, "same-test-name", &state).is_err());
        input["peer"]["containerName"] = json!("same-test-name");
        input["peer"]["dockerHost"] = json!("tcp://127.0.0.1:2375");
        assert!(peer_fixture(&input, &primary_id, "same-test-name", &state).is_err());
        input["peer"]["dockerHost"] = json!(format!("unix://{}", socket.display()));
        drop(listener);
        std::fs::remove_file(&socket).unwrap();
        std::fs::write(&socket, "not a Docker socket").unwrap();
        assert!(peer_fixture(&input, &primary_id, "same-test-name", &state).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn acme_environment_requires_fixture_owned_files_and_only_exports_public_metadata() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let state = directory.0.join("bridge-state");
        std::fs::create_dir_all(&state).unwrap();
        let bin = directory.0.join("acme/venv/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("certbot"), "fixture entrypoint").unwrap();
        let ca = directory.0.join("acme/transport-ca.pem");
        std::fs::write(&ca, "public test CA").unwrap();
        let mut input = json!({"rootFixtureDir":directory.0, "acme":{
            "transportCAPath":ca, "certbotBinPath":bin,
            "managedCertificatePath":"/etc/letsencrypt/live/fixture/fullchain.pem",
            "certificateName":"fixture", "domains":["fixture.test"],
            "issuerCAPath":directory.0.join("acme/issuer-ca.pem"),
            "directoryUrl":"https://localhost:14000/dir", "initialSerial":"01",
            "initialNotAfter":123456789, "httpsPort":14443,
            "privateKey":"must not be exported"
        }});
        let (public, environment) = acme_fixture(&input, &state).unwrap().unwrap();
        assert_eq!(environment.ca_bundle, ca.to_str().unwrap());
        assert_eq!(environment.certbot_bin, bin.to_str().unwrap());
        assert_eq!(public["certificateName"], "fixture");
        assert!(public.get("privateKey").is_none());
        assert!(public.get("certbotBinPath").is_none());
        input["acme"]["transportCAPath"] = json!(directory.0.join("missing-ca.pem"));
        assert!(acme_fixture(&input, &state).is_err());
        input["acme"]["transportCAPath"] = json!(ca);
        std::fs::remove_file(bin.join("certbot")).unwrap();
        symlink("/bin/sh", bin.join("certbot")).unwrap();
        assert!(acme_fixture(&input, &state).is_err());
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
        assert_eq!(
            command_kind("certbot renew --dry-run --non-interactive 2>&1"),
            ("ssl.dry-run", true)
        );
        assert_eq!(
            command_kind("certbot renew --non-interactive 2>&1"),
            ("ssl.renew", true)
        );
        assert_eq!(
            command_kind("certbot renew --dry-run --non-interactive 2>&1; echo other"),
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
