//! Move hosts from one Vault to another, carrying everything tied to them:
//! credentials, per-host rows in the app databases, port forwards, known
//! hosts, history and activity. MCP grants for the moved hosts are revoked.
//!
//! The host rows and the per-host rows of `workspace_inventory.sqlite3` move in
//! one transaction; that commit is the point of no return. Secrets are copied
//! into the target before it, and everything after it is idempotent: a rerun
//! with the same request finds the hosts in the target ("resume") and finishes
//! the remaining steps without moving anything twice.

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::path::Path;
use tauri::{Emitter, Manager};

use super::hosts::{self, HostProfile};
use super::server_monitor::scoped_host_key;
use crate::storage::{data_file_path, now_unix_ms, vault_id_or_default};
use crate::vault::purge::scoped_host_key_prefix;
use crate::vault::secrets::{self, SecretMatch, VaultState};

const OPERATION_DB: &str = "operation_jobs.sqlite3";
const MCP_DB: &str = "mcp.sqlite3";

/// Tables whose host rows are not re-scoped by the generic pass.
/// `workspace_hosts` moves explicitly. Metadata bindings and notification rules
/// are sync intents bound to a Komari integration of the source Vault; they
/// stay there and `hosts_changed` disables bindings of hosts that left.
const NOT_MOVED_TABLES: &[&str] = &[
    "workspace_hosts",
    "host_metadata_bindings",
    "host_notification_rules",
];

/// Renamed keys look like `<name>-moved-<6 hex>`; the suffix is derived from
/// the source Vault and name so a rerun picks the same name.
const RENAME_MARKER: &str = "-moved-";
const RENAME_ATTEMPTS: u32 = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMoveRequest {
    pub source_vault_id: String,
    pub target_vault_id: String,
    pub host_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMoveHostRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedJumpHost {
    pub id: String,
    pub name: String,
    pub required_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockingDependent {
    pub id: String,
    pub name: String,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMoveConflict {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRename {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSummary {
    pub moved: usize,
    pub copied: usize,
    pub renamed: Vec<SecretRename>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordCounts {
    pub port_forwards: usize,
    pub known_hosts: usize,
    pub command_history: usize,
    pub activity: usize,
    pub database_rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMovePlan {
    pub hosts: Vec<HostMoveHostRef>,
    pub added_jump_hosts: Vec<AddedJumpHost>,
    pub blocking_dependents: Vec<BlockingDependent>,
    pub conflicts: Vec<HostMoveConflict>,
    pub secrets: SecretSummary,
    pub records: RecordCounts,
    pub mcp_clients_affected: Vec<HostMoveHostRef>,
    pub source_unlocked: bool,
    pub target_unlocked: bool,
    pub target_uninitialized: bool,
}

impl HostMovePlan {
    /// Mirrors `hostMoveBlocked` in src/lib/host-move.ts.
    fn blocked(&self) -> bool {
        !self.blocking_dependents.is_empty()
            || !self.conflicts.is_empty()
            || !self.source_unlocked
            || !self.target_unlocked
            || self.target_uninitialized
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMoveResult {
    pub moved_host_ids: Vec<String>,
    pub warnings: Vec<String>,
}

/// One credential the moving hosts use: copied from `from` in the source to
/// `to` in the target. `moved` ones are deleted from the source afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SecretEntry {
    from: String,
    to: String,
    moved: bool,
}

/// Everything known about a request before anything is written.
struct MoveScope {
    source: String,
    target: String,
    /// The hosts are already in the target: only the idempotent steps remain.
    resume: bool,
    /// Moving hosts as stored in their current Vault, in move order.
    moving: Vec<HostProfile>,
    moving_ids: BTreeSet<String>,
    /// Jump host id -> moving hosts that connect through it (not picked).
    added_jumps: BTreeMap<String, BTreeSet<String>>,
    staying: Vec<HostProfile>,
    target_hosts: Vec<HostProfile>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// Hosts this host connects through, directly or via one of its connections.
fn jump_dependencies(host: &HostProfile) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    ids.extend(non_empty(&host.jump_host_id).map(str::to_string));
    for connection in host.connections.iter().flatten() {
        ids.extend(non_empty(&connection.jump_host_id).map(str::to_string));
    }
    ids.remove(&host.id);
    ids
}

/// Picked hosts plus every host they transitively jump through (in `hosts`).
/// Returns the ids in discovery order and, for each added jump host, the
/// moving hosts that directly need it. Cycles terminate via the visited set.
fn jump_closure(
    hosts: &[HostProfile],
    picked: &[String],
) -> (Vec<String>, BTreeMap<String, BTreeSet<String>>) {
    let by_id: BTreeMap<&str, &HostProfile> = hosts.iter().map(|h| (h.id.as_str(), h)).collect();
    let picked_set: BTreeSet<&str> = picked.iter().map(String::as_str).collect();
    let mut order = Vec::new();
    let mut seen = BTreeSet::new();
    let mut added: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut queue: VecDeque<&str> = picked.iter().map(String::as_str).collect();
    while let Some(id) = queue.pop_front() {
        let Some(host) = by_id.get(id) else { continue };
        if !seen.insert(id.to_string()) {
            continue;
        }
        order.push(id.to_string());
        for jump in jump_dependencies(host) {
            let Some((&jump_id, _)) = by_id.get_key_value(jump.as_str()) else {
                continue;
            };
            if !picked_set.contains(jump_id) {
                added
                    .entry(jump.clone())
                    .or_default()
                    .insert(id.to_string());
            }
            queue.push_back(jump_id);
        }
    }
    (order, added)
}

/// Staying hosts that connect through a moving host.
fn blocking_dependents(
    staying: &[HostProfile],
    moving_ids: &BTreeSet<String>,
) -> Vec<BlockingDependent> {
    staying
        .iter()
        .filter_map(|host| {
            let depends_on: Vec<String> = jump_dependencies(host)
                .intersection(moving_ids)
                .cloned()
                .collect();
            (!depends_on.is_empty()).then(|| BlockingDependent {
                id: host.id.clone(),
                name: host.name.clone(),
                depends_on,
            })
        })
        .collect()
}

/// Secret references of a host, including each connection's own.
fn secret_refs(host: &HostProfile) -> BTreeSet<String> {
    let mut refs = BTreeSet::new();
    let mut add = |value: &Option<String>| refs.extend(non_empty(value).map(str::to_string));
    add(&host.secret_key_ref);
    add(&host.password_key_ref);
    add(&host.private_key_ref);
    for connection in host.connections.iter().flatten() {
        add(&connection.secret_key_ref);
        add(&connection.password_key_ref);
        add(&connection.private_key_ref);
    }
    refs
}

fn rewrite_secret_refs(host: &mut HostProfile, renames: &BTreeMap<String, String>) {
    let rewrite = |value: &mut Option<String>| {
        if let Some(to) = non_empty(value).and_then(|v| renames.get(v)) {
            *value = Some(to.clone());
        }
    };
    rewrite(&mut host.secret_key_ref);
    rewrite(&mut host.password_key_ref);
    rewrite(&mut host.private_key_ref);
    for connection in host.connections.iter_mut().flatten() {
        rewrite(&mut connection.secret_key_ref);
        rewrite(&mut connection.password_key_ref);
        rewrite(&mut connection.private_key_ref);
    }
}

fn renamed_key(source_vault: &str, name: &str, attempt: u32) -> String {
    let digest = Sha256::digest(format!("{source_vault}\0{name}\0{attempt}").as_bytes());
    let hex: String = digest.iter().take(3).map(|b| format!("{b:02x}")).collect();
    format!("{name}{RENAME_MARKER}{hex}")
}

/// The source name a (possibly renamed) target reference was copied from.
fn source_name_of(target_ref: &str, source_vault: &str, source_keys: &HashSet<String>) -> String {
    if let Some(index) = target_ref.rfind(RENAME_MARKER) {
        let base = &target_ref[..index];
        if source_keys.contains(base)
            && (0..RENAME_ATTEMPTS).any(|n| renamed_key(source_vault, base, n) == target_ref)
        {
            return base.to_string();
        }
    }
    target_ref.to_string()
}

/// `(source key, target key)` -> how their values compare.
type CompareSecret<'a> = &'a mut dyn FnMut(&str, &str) -> Result<SecretMatch, String>;

/// Decide, per reference of the moving hosts, the target name and whether the
/// source keeps it. `compare(from, to)` is None while either Vault is locked:
/// then names are kept and nothing is known about dangling references.
fn plan_secret_entries(
    moving_refs: &BTreeSet<String>,
    staying_refs: &BTreeSet<String>,
    source_vault: &str,
    mut compare: Option<CompareSecret<'_>>,
) -> Result<Vec<SecretEntry>, String> {
    let mut taken: BTreeSet<String> = moving_refs.clone();
    let mut entries = Vec::new();
    for name in moving_refs {
        let moved = !staying_refs.contains(name);
        let Some(compare) = compare.as_deref_mut() else {
            entries.push(SecretEntry {
                from: name.clone(),
                to: name.clone(),
                moved,
            });
            continue;
        };
        let to = match compare(name, name)? {
            // A dangling reference: nothing to copy, the host keeps it as is.
            SecretMatch::MissingInSource => continue,
            SecretMatch::AbsentInTarget | SecretMatch::Same => name.clone(),
            SecretMatch::Different => {
                let mut found = None;
                for attempt in 0..RENAME_ATTEMPTS {
                    let candidate = renamed_key(source_vault, name, attempt);
                    if taken.contains(&candidate) {
                        continue;
                    }
                    if matches!(
                        compare(name, &candidate)?,
                        SecretMatch::AbsentInTarget | SecretMatch::Same
                    ) {
                        found = Some(candidate);
                        break;
                    }
                }
                found.ok_or_else(|| format!("HOST_MOVE_SECRET_NAME_UNAVAILABLE: {name}"))?
            }
        };
        taken.insert(to.clone());
        entries.push(SecretEntry {
            from: name.clone(),
            to,
            moved,
        });
    }
    Ok(entries)
}

fn summarize_secrets(entries: &[SecretEntry]) -> SecretSummary {
    SecretSummary {
        moved: entries.iter().filter(|e| e.moved).count(),
        copied: entries.iter().filter(|e| !e.moved).count(),
        renamed: entries
            .iter()
            .filter(|e| e.from != e.to)
            .map(|e| SecretRename {
                from: e.from.clone(),
                to: e.to.clone(),
            })
            .collect(),
    }
}

/// `vault:["<source>","<host>"]` -> `vault:["<target>","<host>"]` for moving
/// hosts. Legacy bare keys carry no Vault and are left alone.
fn rewrite_host_key(
    key: &str,
    source: &str,
    target: &str,
    host_ids: &BTreeSet<String>,
) -> Option<String> {
    let parts: Vec<String> = serde_json::from_str(key.strip_prefix("vault:")?).ok()?;
    match parts.as_slice() {
        [vault, host]
            if vault == source
                && host_ids.contains(host)
                && key == scoped_host_key(vault, host) =>
        {
            Some(scoped_host_key(target, host))
        }
        _ => None,
    }
}

/// SSH endpoints a host reaches, for known-hosts entries (`host:port`).
fn endpoints(host: &HostProfile) -> BTreeSet<(String, u16)> {
    fn add(set: &mut BTreeSet<(String, u16)>, address: &str, port: u16) {
        let address = address.trim().to_ascii_lowercase();
        if !address.is_empty() && port > 0 {
            set.insert((address, port));
        }
    }
    let mut set = BTreeSet::new();
    add(&mut set, &host.address, host.port);
    if let Some(jump) = non_empty(&host.jump_host) {
        add(&mut set, jump, host.jump_port.unwrap_or(22));
    }
    for connection in host.connections.iter().flatten() {
        add(&mut set, &connection.address, connection.port);
        if let Some(jump) = non_empty(&connection.jump_host) {
            add(&mut set, jump, connection.jump_port.unwrap_or(22));
        }
    }
    set
}

fn endpoint_key(host: &str, port: u16) -> (String, u16) {
    (host.trim().to_ascii_lowercase(), port)
}

// ---------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum RowPass {
    Count,
    Apply,
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn table_columns(db: &Connection, table: &str) -> Result<BTreeSet<String>, String> {
    let mut stmt = db
        .prepare(&format!("PRAGMA table_info({})", quote_ident(table)))
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<_, _>>()
        .map_err(|err| err.to_string())
}

/// Count or re-scope every per-host row of the moving hosts in one database:
/// tables with `vault_id` + `host_id` change Vault (and a JSON `body` whose
/// `vaultId` names the source follows), tables keyed by a scoped `host_key`
/// get the target's key. Conflicting stale target rows are replaced.
fn move_host_rows(
    db: &Connection,
    source: &str,
    target: &str,
    host_ids: &BTreeSet<String>,
    pass: RowPass,
) -> Result<usize, String> {
    let mut tables = Vec::new();
    {
        let mut stmt = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for row in rows {
            let name = row.map_err(|err| err.to_string())?;
            if !NOT_MOVED_TABLES.contains(&name.as_str()) {
                let columns = table_columns(db, &name)?;
                tables.push((name, columns));
            }
        }
    }
    let prefix = scoped_host_key_prefix(source);
    let mut total = 0;
    for (table, columns) in &tables {
        let quoted = quote_ident(table);
        let scoped_by_vault = columns.contains("vault_id") && columns.contains("host_id");
        if scoped_by_vault {
            for id in host_ids {
                total += match pass {
                    RowPass::Count => db
                        .query_row(
                            &format!("SELECT COUNT(*) FROM {quoted} WHERE vault_id = ?1 AND host_id = ?2"),
                            params![source, id],
                            |row| row.get::<_, i64>(0),
                        )
                        .map(|count| count as usize),
                    RowPass::Apply if columns.contains("body") => db.execute(
                        &format!(
                            "UPDATE OR REPLACE {quoted} SET vault_id = ?2, body = CASE
                               WHEN json_valid(body) AND json_extract(body, '$.vaultId') = ?1
                               THEN json_set(body, '$.vaultId', ?2) ELSE body END
                             WHERE vault_id = ?1 AND host_id = ?3"
                        ),
                        params![source, target, id],
                    ),
                    RowPass::Apply => db.execute(
                        &format!(
                            "UPDATE OR REPLACE {quoted} SET vault_id = ?2 WHERE vault_id = ?1 AND host_id = ?3"
                        ),
                        params![source, target, id],
                    ),
                }
                .map_err(|err| format!("{table}: {err}"))?;
            }
        }
        if columns.contains("host_key") {
            let keys: Vec<String> = db
                .prepare(&format!(
                    "SELECT DISTINCT host_key FROM {quoted} WHERE substr(host_key, 1, length(?1)) = ?1"
                ))
                .and_then(|mut stmt| {
                    stmt.query_map([&prefix], |row| row.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()
                })
                .map_err(|err| format!("{table}: {err}"))?;
            for key in keys {
                let Some(next) = rewrite_host_key(&key, source, target, host_ids) else {
                    continue;
                };
                let changed = match pass {
                    RowPass::Count => db
                        .query_row(
                            &format!("SELECT COUNT(*) FROM {quoted} WHERE host_key = ?1"),
                            [&key],
                            |row| row.get::<_, i64>(0),
                        )
                        .map(|count| count as usize),
                    RowPass::Apply => db.execute(
                        &format!(
                            "UPDATE OR REPLACE {quoted} SET host_key = ?2 WHERE host_key = ?1"
                        ),
                        params![key, next],
                    ),
                }
                .map_err(|err| format!("{table}: {err}"))?;
                // Rows found by vault_id above are not counted twice.
                if !(scoped_by_vault && pass == RowPass::Count) {
                    total += changed;
                }
            }
        }
    }
    Ok(total)
}

/// The point of no return: host rows and their per-host rows change Vault in
/// one transaction, under both Vaults' metadata write guards. Bindings of the
/// hosts that left are disabled by `hosts_changed` (they belong to the source
/// Vault's integrations), and each move is journaled as a directory edit.
fn commit_host_move(
    tx: &rusqlite::Transaction<'_>,
    source: &str,
    target: &str,
    moved: &[HostProfile],
    target_hosts: &[HostProfile],
) -> Result<usize, String> {
    let ids: BTreeSet<String> = moved.iter().map(|h| h.id.clone()).collect();
    for id in &ids {
        let in_source: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_hosts WHERE vault_id=?1 AND id=?2)",
                params![source, id],
                |r| r.get(0),
            )
            .map_err(|_| "HOST_SAVE_FAILED")?;
        let in_target: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_hosts WHERE vault_id=?1 AND id=?2)",
                params![target, id],
                |r| r.get(0),
            )
            .map_err(|_| "HOST_SAVE_FAILED")?;
        if !in_source || in_target {
            return Err("HOST_MOVE_STALE: the hosts changed; review the move again".into());
        }
    }
    super::host_metadata::begin_host_write(tx, source)?;
    super::host_metadata::begin_host_write(tx, target)?;
    let mut after: Vec<HostProfile> = target_hosts.to_vec();
    after.extend(moved.iter().cloned());
    super::host_connections::validate_registry_import(tx, target, &after)?;
    for host in moved {
        tx.execute(
            "DELETE FROM workspace_hosts WHERE vault_id=?1 AND id=?2",
            params![source, host.id],
        )
        .map_err(|err| format!("Remove moved host failed: {err}"))?;
        hosts::insert_host_row(tx, target, host)?;
        super::host_metadata::record_directory_edit(tx, target, &host.id, "host.directory.move")?;
    }
    let rows = move_host_rows(tx, source, target, &ids, RowPass::Apply)?;
    super::host_metadata::hosts_changed(tx, source)?;
    super::host_metadata::hosts_changed(tx, target)?;
    super::host_metadata::end_host_write(tx, source)?;
    super::host_metadata::end_host_write(tx, target)?;
    Ok(rows)
}

/// Hosts with a Komari agent transfer lock in this Vault.
fn transfer_locked_hosts(db: &Connection, vault: &str) -> Result<BTreeSet<String>, String> {
    if !table_columns(db, "komari_agent_transfer_locks")?.contains("host_id") {
        return Ok(BTreeSet::new());
    }
    let mut stmt = db
        .prepare("SELECT host_id FROM komari_agent_transfer_locks WHERE vault_id = ?1")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([vault], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<_, _>>()
        .map_err(|err| err.to_string())
}

/// Secret names other features of the source Vault rely on (Komari integration
/// credentials); they are never deleted from the source.
fn integration_refs(db: &Connection, vault: &str) -> Result<BTreeSet<String>, String> {
    if !table_columns(db, "komari_integrations")?.contains("credential_ref") {
        return Ok(BTreeSet::new());
    }
    let mut stmt = db
        .prepare("SELECT credential_ref FROM komari_integrations WHERE vault_id = ?1")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([vault], |row| row.get::<_, Option<String>>(0))
        .map_err(|err| err.to_string())?;
    let mut refs = BTreeSet::new();
    for row in rows {
        if let Some(value) = row.map_err(|err| err.to_string())? {
            refs.insert(value.trim().to_string());
        }
    }
    Ok(refs)
}

/// Open an auxiliary store if it exists; a missing file has no rows to move.
fn open_optional_db(path: &Path, name: &str) -> Result<Option<Connection>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let db = if name == OPERATION_DB {
        super::operation_jobs::open_database(path)?
    } else {
        Connection::open(path).map_err(|err| err.to_string())?
    };
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    Ok(Some(db))
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

fn load_scope(app: &tauri::AppHandle, request: &HostMoveRequest) -> Result<MoveScope, String> {
    let source = vault_id_or_default(Some(&request.source_vault_id));
    let target = vault_id_or_default(Some(&request.target_vault_id));
    if source == target {
        return Err("HOST_MOVE_SAME_VAULT".into());
    }
    let vaults = crate::vaults_meta::list_vaults(app.clone())?;
    for id in [&source, &target] {
        if !vaults.iter().any(|vault| &vault.id == id) {
            return Err(format!("HOST_MOVE_VAULT_NOT_FOUND: {id}"));
        }
    }
    let mut picked = Vec::new();
    for id in &request.host_ids {
        let id = id.trim().to_string();
        if !id.is_empty() && !picked.contains(&id) {
            picked.push(id);
        }
    }
    if picked.is_empty() {
        return Err("HOST_MOVE_NO_HOSTS".into());
    }
    let source_hosts = hosts::load_hosts(app, Some(&source))?;
    let target_hosts = hosts::load_hosts(app, Some(&target))?;
    let in_source = |id: &String| source_hosts.iter().any(|h| &h.id == id);
    let in_target = |id: &String| target_hosts.iter().any(|h| &h.id == id);
    let resume = if picked.iter().all(in_source) {
        false
    } else if picked.iter().all(|id| !in_source(id) && in_target(id)) {
        true
    } else {
        let missing = picked.iter().find(|id| !in_source(id)).cloned();
        return Err(format!(
            "HOST_MOVE_HOST_NOT_FOUND: {}",
            missing.unwrap_or_default()
        ));
    };
    let home = if resume { &target_hosts } else { &source_hosts };
    let (order, added_jumps) = jump_closure(home, &picked);
    let moving: Vec<HostProfile> = order
        .iter()
        .filter_map(|id| home.iter().find(|h| &h.id == id).cloned())
        .collect();
    let moving_ids: BTreeSet<String> = order.into_iter().collect();
    let staying = source_hosts
        .iter()
        .filter(|h| !moving_ids.contains(&h.id))
        .cloned()
        .collect();
    Ok(MoveScope {
        source,
        target,
        resume,
        moving,
        moving_ids,
        added_jumps,
        staying,
        target_hosts,
    })
}

fn analyze(
    app: &tauri::AppHandle,
    scope: &MoveScope,
) -> Result<(HostMovePlan, Vec<SecretEntry>), String> {
    let state = app.state::<VaultState>();
    let source_unlocked = state.is_unlocked(&scope.source);
    let target_unlocked = state.is_unlocked(&scope.target);
    let target_uninitialized = !secrets::is_initialized(app, &scope.target)?;
    let hosts_db = hosts::open_hosts_db(app)?;
    let data_dir = data_file_path(app, OPERATION_DB)?
        .parent()
        .map(Path::to_path_buf)
        .ok_or("Resolve app data dir failed")?;
    let operation_db = open_optional_db(&data_dir.join(OPERATION_DB), OPERATION_DB)?;

    let mut conflicts = Vec::new();
    if !scope.resume {
        let locked = match &operation_db {
            Some(db) => transfer_locked_hosts(db, &scope.source)?,
            None => BTreeSet::new(),
        };
        for host in &scope.moving {
            let reason = if scope.target_hosts.iter().any(|h| h.id == host.id) {
                "The target vault already has a host with this id"
            } else if locked.contains(&host.id) {
                "A Komari agent transfer for this host is in progress"
            } else {
                continue;
            };
            conflicts.push(HostMoveConflict {
                id: host.id.clone(),
                name: host.name.clone(),
                reason: reason.into(),
            });
        }
    }

    // Secrets. In a resume the moving hosts already carry target names.
    let mut staying_refs: BTreeSet<String> = scope.staying.iter().flat_map(secret_refs).collect();
    staying_refs.extend(integration_refs(&hosts_db, &scope.source)?);
    let entries = if scope.resume {
        let source_keys = secrets::secret_key_names(app, &scope.source)?;
        let mut pairs: BTreeMap<String, String> = BTreeMap::new();
        for target_ref in scope.moving.iter().flat_map(secret_refs) {
            let from = source_name_of(&target_ref, &scope.source, &source_keys);
            if source_keys.contains(&from) {
                pairs.insert(from, target_ref);
            }
        }
        pairs
            .into_iter()
            .map(|(from, to)| SecretEntry {
                moved: !staying_refs.contains(&from),
                from,
                to,
            })
            .collect()
    } else {
        let moving_refs: BTreeSet<String> = scope.moving.iter().flat_map(secret_refs).collect();
        let can_compare = source_unlocked && target_unlocked && !target_uninitialized;
        let mut compare = |from: &str, to: &str| -> Result<SecretMatch, String> {
            secrets::compare_secrets(
                app,
                &state,
                &scope.source,
                &scope.target,
                &[(from.to_string(), to.to_string())],
            )?
            .pop()
            .ok_or_else(|| "HOST_MOVE_SECRET_COMPARE_FAILED".to_string())
        };
        plan_secret_entries(
            &moving_refs,
            &staying_refs,
            &scope.source,
            can_compare.then_some(&mut compare as CompareSecret<'_>),
        )?
    };

    // Records still in the source that follow the hosts.
    let ids = &scope.moving_ids;
    // Host rows themselves are listed in `hosts`, not counted as records.
    let mcp_db = open_optional_db(&data_dir.join(MCP_DB), MCP_DB)?;
    let mut database_rows = 0;
    for db in [Some(&hosts_db), operation_db.as_ref(), mcp_db.as_ref()]
        .into_iter()
        .flatten()
    {
        database_rows += move_host_rows(db, &scope.source, &scope.target, ids, RowPass::Count)?;
    }
    let moving_endpoints: BTreeSet<_> = scope.moving.iter().flat_map(endpoints).collect();
    let records = RecordCounts {
        port_forwards: crate::net::port_forward::list_port_forward_rules(
            app.clone(),
            Some(scope.source.clone()),
        )?
        .iter()
        .filter(|rule| ids.contains(&rule.host_id))
        .count(),
        known_hosts: crate::net::known_hosts::list_known_hosts(
            app.clone(),
            Some(scope.source.clone()),
        )?
        .iter()
        .filter(|entry| moving_endpoints.contains(&endpoint_key(&entry.host, entry.port)))
        .count(),
        command_history: super::history::load_vault_history(app, Some(&scope.source))?
            .iter()
            .filter(|entry| entry.host_id.as_ref().is_some_and(|id| ids.contains(id)))
            .count(),
        activity: super::activity_log::list_activity_log(app.clone(), Some(scope.source.clone()))?
            .iter()
            .filter(|entry| entry.host_id.as_ref().is_some_and(|id| ids.contains(id)))
            .count(),
        database_rows,
    };

    let name_of = |id: &str| {
        scope
            .moving
            .iter()
            .find(|h| h.id == id)
            .map(|h| h.name.clone())
            .unwrap_or_default()
    };
    let plan = HostMovePlan {
        hosts: scope
            .moving
            .iter()
            .map(|h| HostMoveHostRef {
                id: h.id.clone(),
                name: h.name.clone(),
            })
            .collect(),
        added_jump_hosts: scope
            .added_jumps
            .iter()
            .map(|(id, required_by)| AddedJumpHost {
                id: id.clone(),
                name: name_of(id),
                required_by: required_by.iter().cloned().collect(),
            })
            .collect(),
        blocking_dependents: blocking_dependents(&scope.staying, ids),
        conflicts,
        secrets: summarize_secrets(&entries),
        records,
        mcp_clients_affected: crate::mcp::vault_clients_granting(app, &scope.source, ids)?
            .into_iter()
            .map(|(id, name)| HostMoveHostRef { id, name })
            .collect(),
        source_unlocked,
        target_unlocked,
        target_uninitialized,
    };
    Ok((plan, entries))
}

#[tauri::command]
pub fn plan_host_move(
    app: tauri::AppHandle,
    request: HostMoveRequest,
) -> Result<HostMovePlan, String> {
    let scope = load_scope(&app, &request)?;
    Ok(analyze(&app, &scope)?.0)
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn move_hosts_to_vault(
    app: tauri::AppHandle,
    request: HostMoveRequest,
) -> Result<HostMoveResult, String> {
    let scope = load_scope(&app, &request)?;
    let (plan, entries) = analyze(&app, &scope)?;
    if plan.blocked() {
        return Err("HOST_MOVE_BLOCKED: review the move plan".into());
    }
    let (source, target) = (scope.source.as_str(), scope.target.as_str());
    let state = app.state::<VaultState>();
    let pairs: Vec<(String, String)> = entries
        .iter()
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();

    if !scope.resume {
        // 1. Credentials first, additively: nothing is lost if a later step fails.
        secrets::copy_secrets(&app, &state, source, target, &pairs)
            .map_err(|err| format!("Copy credentials failed: {err}"))?;

        // 2. Host rows and workspace rows in one transaction.
        let renames: BTreeMap<String, String> = entries
            .iter()
            .filter(|e| e.from != e.to)
            .map(|e| (e.from.clone(), e.to.clone()))
            .collect();
        let now = now_unix_ms();
        let moved: Vec<HostProfile> = scope
            .moving
            .iter()
            .cloned()
            .map(|mut host| {
                rewrite_secret_refs(&mut host, &renames);
                host.updated_at = now.max(host.updated_at + 1);
                host
            })
            .collect();
        state.while_all_unlocked(&[source, target], || {
            let mut conn = hosts::open_hosts_db(&app)?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| "HOST_SAVE_FAILED")?;
            commit_host_move(&tx, source, target, &moved, &scope.target_hosts)?;
            tx.commit().map_err(|_| "HOST_SAVE_FAILED".to_string())
        })?;
        emit_changed(&app, source, target);
    }

    // 3-6 are idempotent; failures become warnings and a rerun finishes them.
    let mut warnings = Vec::new();
    let ids = &scope.moving_ids;
    let mut record = |step: &str, result: Result<(), String>| {
        if let Err(err) = result {
            log::warn!("Host move step '{step}' did not finish: {err}");
            warnings.push(format!("{step}: {err}"));
        }
    };

    // 3. Operation jobs and MCP stores.
    let data_dir = data_file_path(&app, OPERATION_DB)?
        .parent()
        .map(Path::to_path_buf)
        .ok_or("Resolve app data dir failed")?;
    for name in [OPERATION_DB, MCP_DB] {
        let result = open_optional_db(&data_dir.join(name), name).and_then(|db| {
            let Some(mut db) = db else { return Ok(()) };
            let tx = db.transaction().map_err(|err| err.to_string())?;
            move_host_rows(&tx, source, target, ids, RowPass::Apply)?;
            tx.commit().map_err(|err| err.to_string())
        });
        record(&format!("Move {name} rows"), result);
    }

    // 4. Per-Vault JSON stores.
    record(
        "Move port forwards",
        crate::net::port_forward::move_vault_rules(&app, source, target, ids).map(drop),
    );
    record(
        "Move command history",
        super::history::move_vault_history(&app, source, target, |entry| {
            entry.host_id.as_ref().is_some_and(|id| ids.contains(id))
        })
        .map(drop),
    );
    record(
        "Move activity",
        super::activity_log::move_vault_activity(&app, source, target, |entry| {
            entry.host_id.as_ref().is_some_and(|id| ids.contains(id))
        })
        .map(drop),
    );
    let moving_endpoints: BTreeSet<_> = scope.moving.iter().flat_map(endpoints).collect();
    let staying_endpoints: BTreeSet<_> = scope.staying.iter().flat_map(endpoints).collect();
    record(
        "Move known hosts",
        crate::net::known_hosts::move_vault_entries(
            &app,
            source,
            target,
            |entry| moving_endpoints.contains(&endpoint_key(&entry.host, entry.port)),
            |entry| !staying_endpoints.contains(&endpoint_key(&entry.host, entry.port)),
        )
        .map(drop),
    );

    // 5. MCP clients of the source lose their grants for the moved hosts.
    record(
        "Revoke MCP grants",
        crate::mcp::revoke_vault_host_grants(&app, source, ids).map(drop),
    );

    // 6. Credentials only the moved hosts used leave the source, once the
    // target holds the same value.
    let moved_pairs: Vec<(String, String)> = entries
        .iter()
        .filter(|e| e.moved)
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();
    record(
        "Remove moved credentials from the source",
        secrets::delete_copied_secrets(&app, &state, source, target, &moved_pairs).map(drop),
    );

    emit_changed(&app, source, target);
    Ok(HostMoveResult {
        moved_host_ids: scope.moving.iter().map(|h| h.id.clone()).collect(),
        warnings,
    })
}

/// The existing refresh signal the UI listens to for out-of-band data changes.
fn emit_changed(app: &tauri::AppHandle, source: &str, target: &str) {
    for vault_id in [source, target] {
        let _ = app.emit(
            "sync-data-changed",
            serde_json::json!({ "vaultId": vault_id }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    fn host(id: &str, jump: Option<&str>) -> HostProfile {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id.to_uppercase(), "address": format!("{id}.test"), "port": 22,
            "username": "ops", "group": "", "authType": "password", "tags": [],
            "passwordKeyRef": format!("{id}-pw"), "jumpHostId": jump,
            "createdAt": 1, "updatedAt": 1
        }))
        .unwrap()
    }

    fn with_connection(mut host: HostProfile, jump: Option<&str>, key: &str) -> HostProfile {
        host.connections = Some(vec![serde_json::from_value(serde_json::json!({
            "id": "c1", "label": "alt", "address": format!("alt-{}.test", host.id), "port": 2222,
            "username": "ops", "authType": "privateKey", "privateKeyRef": key, "jumpHostId": jump,
            "jumpHost": "bastion.test", "jumpPort": 2200
        }))
        .unwrap()]);
        host
    }

    fn ids(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn closure_follows_host_and_connection_jumps_transitively() {
        let hosts = vec![
            host("a", Some("j1")),
            with_connection(host("b", None), Some("j2"), "k"),
            host("j1", Some("j3")),
            host("j2", None),
            host("j3", None),
            host("other", None),
        ];
        let (order, added) = jump_closure(&hosts, &["a".into(), "b".into()]);
        assert_eq!(order, vec!["a", "b", "j1", "j2", "j3"]);
        assert_eq!(added.get("j1"), Some(&ids(&["a"])));
        assert_eq!(added.get("j2"), Some(&ids(&["b"])));
        assert_eq!(added.get("j3"), Some(&ids(&["j1"])));
        assert!(!added.contains_key("a"));
    }

    #[test]
    fn closure_terminates_on_cycles_and_ignores_missing_or_picked_jumps() {
        let hosts = vec![
            host("a", Some("b")),
            host("b", Some("c")),
            host("c", Some("a")),
            host("d", Some("gone")),
        ];
        let (order, added) = jump_closure(&hosts, &["a".into(), "d".into()]);
        assert_eq!(order, vec!["a", "d", "b", "c"]);
        // "a" is picked, so the cycle back to it does not list it as added.
        assert_eq!(added.keys().cloned().collect::<Vec<_>>(), vec!["b", "c"]);
        // A self-jump is not a dependency.
        assert!(jump_dependencies(&host("s", Some("s"))).is_empty());
    }

    #[test]
    fn staying_hosts_that_jump_through_a_moving_host_block_the_move() {
        let staying = vec![
            host("x", Some("a")),
            with_connection(host("y", None), Some("b"), "k"),
            host("z", Some("elsewhere")),
        ];
        let blocking = blocking_dependents(&staying, &ids(&["a", "b"]));
        assert_eq!(
            blocking,
            vec![
                BlockingDependent {
                    id: "x".into(),
                    name: "X".into(),
                    depends_on: vec!["a".into()]
                },
                BlockingDependent {
                    id: "y".into(),
                    name: "Y".into(),
                    depends_on: vec!["b".into()]
                },
            ]
        );
    }

    #[test]
    fn secrets_are_moved_copied_reused_or_renamed() {
        let moving = ids(&["only-mine", "shared", "taken", "same", "dangling"]);
        let staying = ids(&["shared"]);
        let first_rename = renamed_key("src", "taken", 0);
        let mut compare = |from: &str, to: &str| -> Result<SecretMatch, String> {
            Ok(match (from, to) {
                ("dangling", _) => SecretMatch::MissingInSource,
                ("taken", "taken") => SecretMatch::Different,
                ("taken", candidate) if candidate == first_rename => SecretMatch::Different,
                ("same", "same") => SecretMatch::Same,
                _ => SecretMatch::AbsentInTarget,
            })
        };
        let entries = plan_secret_entries(
            &moving,
            &staying,
            "src",
            Some(&mut compare as CompareSecret<'_>),
        )
        .unwrap();
        let find = |name: &str| entries.iter().find(|e| e.from == name).cloned();
        assert!(find("dangling").is_none());
        assert_eq!(find("only-mine").unwrap().to, "only-mine");
        assert!(find("only-mine").unwrap().moved);
        assert!(!find("shared").unwrap().moved);
        assert_eq!(find("same").unwrap().to, "same");
        let taken = find("taken").unwrap();
        assert_eq!(taken.to, renamed_key("src", "taken", 1));
        assert!(taken.to.starts_with("taken-moved-") && taken.to.len() == "taken-moved-".len() + 6);
        let summary = summarize_secrets(&entries);
        assert_eq!((summary.moved, summary.copied), (3, 1));
        assert_eq!(
            summary.renamed,
            vec![SecretRename {
                from: "taken".into(),
                to: taken.to.clone()
            }]
        );
        // The rename is deterministic, so a rerun maps it back to its source.
        let source_keys: HashSet<String> = ["taken".to_string()].into();
        assert_eq!(source_name_of(&taken.to, "src", &source_keys), "taken");
        assert_eq!(source_name_of(&taken.to, "other", &source_keys), taken.to);
        assert_eq!(source_name_of("plain", "src", &source_keys), "plain");
    }

    #[test]
    fn locked_vaults_report_counts_without_renames() {
        let entries = plan_secret_entries(&ids(&["a", "b"]), &ids(&["b"]), "src", None).unwrap();
        let summary = summarize_secrets(&entries);
        assert_eq!((summary.moved, summary.copied), (1, 1));
        assert!(summary.renamed.is_empty());
    }

    #[test]
    fn refs_of_host_and_connections_are_collected_and_rewritten() {
        let mut moving = with_connection(host("a", None), None, "conn-key");
        assert_eq!(secret_refs(&moving), ids(&["a-pw", "conn-key"]));
        let renames: BTreeMap<String, String> =
            [("conn-key".to_string(), "conn-key-moved-abcdef".to_string())].into();
        rewrite_secret_refs(&mut moving, &renames);
        assert_eq!(
            secret_refs(&moving),
            ids(&["a-pw", "conn-key-moved-abcdef"])
        );
    }

    #[test]
    fn scoped_host_keys_follow_only_moving_hosts_of_the_source() {
        let moving = ids(&["h1"]);
        assert_eq!(
            rewrite_host_key(&scoped_host_key("src", "h1"), "src", "dst", &moving),
            Some(scoped_host_key("dst", "h1"))
        );
        assert_eq!(
            rewrite_host_key(&scoped_host_key("src", "h2"), "src", "dst", &moving),
            None
        );
        assert_eq!(
            rewrite_host_key(&scoped_host_key("srcx", "h1"), "src", "dst", &moving),
            None
        );
        assert_eq!(rewrite_host_key("h1", "src", "dst", &moving), None);
        assert_eq!(
            rewrite_host_key("vault:[\"src\"]", "src", "dst", &moving),
            None
        );
    }

    #[test]
    fn endpoints_include_connections_and_jump_hosts() {
        let moving = with_connection(host("a", None), None, "k");
        assert_eq!(
            endpoints(&moving),
            [
                ("a.test".to_string(), 22),
                ("alt-a.test".to_string(), 2222),
                ("bastion.test".to_string(), 2200),
            ]
            .into()
        );
    }

    fn temp_db(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!(
            "shellbeam-host-move-{}-{}-{}",
            name,
            std::process::id(),
            now_unix_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        (dir, db)
    }

    fn count(db: &Connection, sql: &str) -> i64 {
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn commit_moves_one_hosts_rows_and_leaves_the_others() {
        let (dir, mut db) = temp_db("rows");
        hosts::initialize_host_schema(&db).unwrap();
        super::super::host_metadata::initialize(&db).unwrap();
        let moving = host("h1", None);
        let staying = host("h2", None);
        hosts::insert_host_row(&db, "src", &moving).unwrap();
        hosts::insert_host_row(&db, "src", &staying).unwrap();
        db.execute_batch(&format!(
            r#"
            CREATE TABLE probe_snapshots (vault_id TEXT, host_id TEXT, PRIMARY KEY(vault_id, host_id));
            INSERT INTO probe_snapshots VALUES ('src','h1'),('src','h2'),('other','h1'),('dst','h1');
            CREATE TABLE komari_agent_deployments (vault_id TEXT, host_id TEXT, body TEXT);
            INSERT INTO komari_agent_deployments VALUES ('src','h1','{{"vaultId":"src","hostId":"h1"}}');
            INSERT INTO server_monitor_latest (host_key,host_id,host_name,host_address,username,port,status,last_attempt_at,updated_at)
              VALUES ('{k1}','h1','n','a','u',22,'ok',1,1),('{k2}','h2','n','a','u',22,'ok',1,1),('h1','h1','n','a','u',22,'ok',1,1);
            "#,
            k1 = scoped_host_key("src", "h1"),
            k2 = scoped_host_key("src", "h2"),
        ))
        .unwrap();
        let values = serde_json::json!({"name": "H1", "group": "", "tags": []});
        let binding = serde_json::json!({
            "id": "b1", "vaultId": "src", "hostId": "h1", "integrationId": "i1", "nodeId": "n",
            "endpoint": "https://monitor.test", "credentialRef": "token", "integrationVersion": 1,
            "mappingRevision": 1, "identity": "n:1", "baseline": values, "desired": values,
            "remote": values, "status": "synced", "version": 1, "attempts": 0, "nextAttemptAt": 0,
            "errorCode": null, "conflicts": [], "jobId": "j", "updatedAt": 1
        });
        db.execute(
            "INSERT INTO host_metadata_bindings VALUES ('b1','src','h1','i1',?1)",
            [binding.to_string()],
        )
        .unwrap();
        let before = move_host_rows(&db, "src", "dst", &ids(&["h1"]), RowPass::Count).unwrap();
        // probe row + deployment row + scoped monitor row; bare and other-vault rows excluded.
        assert_eq!(before, 3);

        let tx = db.transaction().unwrap();
        commit_host_move(&tx, "src", "dst", std::slice::from_ref(&moving), &[]).unwrap();
        tx.commit().unwrap();

        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM workspace_hosts WHERE vault_id='dst' AND id='h1'"
            ),
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM workspace_hosts WHERE vault_id='src'"
            ),
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM workspace_hosts WHERE vault_id='src' AND id='h2'"
            ),
            1
        );
        // The stale target row is replaced, the other Vault's row is untouched.
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM probe_snapshots WHERE vault_id='dst' AND host_id='h1'"
            ),
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM probe_snapshots WHERE vault_id='src'"
            ),
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM probe_snapshots WHERE vault_id='other'"
            ),
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM komari_agent_deployments WHERE vault_id='dst' AND json_extract(body,'$.vaultId')='dst'"),
            1
        );
        let keys: Vec<String> = db
            .prepare("SELECT host_key FROM server_monitor_latest ORDER BY host_key")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            keys,
            vec![
                "h1".to_string(),
                scoped_host_key("dst", "h1"),
                scoped_host_key("src", "h2")
            ]
        );
        // The binding stays with the source integration and is disabled.
        let status: String = db
            .query_row(
                "SELECT json_extract(body,'$.status') FROM host_metadata_bindings WHERE id='b1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "disabled");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM host_metadata_write_guard"),
            0
        );
        assert_eq!(
            move_host_rows(&db, "src", "dst", &ids(&["h1"]), RowPass::Count).unwrap(),
            0
        );

        // A second commit is refused: the host is no longer in the source.
        let tx = db.transaction().unwrap();
        assert!(commit_host_move(&tx, "src", "dst", &[moving], &[])
            .unwrap_err()
            .starts_with("HOST_MOVE_STALE"));
        drop(tx);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_rolls_back_when_the_target_already_has_the_host() {
        let (dir, mut db) = temp_db("conflict");
        hosts::initialize_host_schema(&db).unwrap();
        let moving = host("h1", None);
        hosts::insert_host_row(&db, "src", &moving).unwrap();
        hosts::insert_host_row(&db, "dst", &moving).unwrap();
        let tx = db.transaction().unwrap();
        assert!(commit_host_move(&tx, "src", "dst", &[moving], &[]).is_err());
        drop(tx);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_hosts"), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transfer_locks_and_integration_refs_are_read_per_vault() {
        let (dir, db) = temp_db("aux");
        assert!(transfer_locked_hosts(&db, "src").unwrap().is_empty());
        db.execute_batch(
            "CREATE TABLE komari_agent_transfer_locks(vault_id TEXT,host_id TEXT,transfer_id TEXT);
             INSERT INTO komari_agent_transfer_locks VALUES('src','h1','t'),('dst','h2','t');
             CREATE TABLE komari_integrations(id TEXT,vault_id TEXT,credential_ref TEXT);
             INSERT INTO komari_integrations VALUES('i','src','komari-token'),('j','dst','other');",
        )
        .unwrap();
        assert_eq!(transfer_locked_hosts(&db, "src").unwrap(), ids(&["h1"]));
        assert_eq!(
            integration_refs(&db, "src").unwrap(),
            ids(&["komari-token"])
        );
        let found: Option<String> = db
            .query_row(
                "SELECT host_id FROM komari_agent_transfer_locks WHERE vault_id='x'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert!(found.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
