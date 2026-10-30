//! Permanently remove everything this device stores for one Vault.
//!
//! Vault data is spread over per-Vault JSON files (`*_vault_{id}.json`),
//! `vault_id` columns in the SQLite stores, observation rows keyed by
//! `vault:["<id>","<host>"]`, and MCP clients bound to the Vault. Legacy rows
//! keyed by a bare host id are only removed when no other Vault owns that id.

use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use tauri::Manager;

use super::meta::DEFAULT_VAULT_ID;
use super::secrets::VaultState;
use crate::storage::data_file_path;

const HOSTS_DB: &str = "workspace_inventory.sqlite3";
const OPERATION_DB: &str = "operation_jobs.sqlite3";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeReport {
    pub files_removed: Vec<String>,
    /// `"<db file>/<table>"` -> deleted row count (only non-zero entries).
    pub rows_deleted: BTreeMap<String, usize>,
    pub mcp_clients_revoked: usize,
}

/// What identifies a Vault's rows in tables without a `vault_id` column.
#[derive(Debug, Default)]
struct VaultScope {
    vault_id: String,
    /// Host ids that belong to this Vault and to no other Vault, so legacy
    /// unscoped rows keyed by them can be attributed safely.
    exclusive_host_ids: BTreeSet<String>,
    job_ids: BTreeSet<String>,
    client_ids: BTreeSet<String>,
}

pub fn purge_vault_data(app: &tauri::AppHandle, vault_id: &str) -> Result<PurgeReport, String> {
    let vault_id = vault_id.trim();
    if vault_id.is_empty() || vault_id == DEFAULT_VAULT_ID {
        return Err("Refusing to purge the default Vault".into());
    }
    let mut report = PurgeReport::default();
    let mut failures = Vec::new();

    // Revoke MCP clients and lock the Vault before touching rows, so nothing
    // new is written or decrypted for it while it is purged.
    let client_ids = crate::mcp::revoke_vault_clients(app, vault_id)
        .map_err(|err| format!("Revoke MCP clients: {err}"))?;
    report.mcp_clients_revoked = client_ids.len();
    app.state::<VaultState>().forget(vault_id)?;

    let data_dir = data_file_path(app, HOSTS_DB)?
        .parent()
        .map(Path::to_path_buf)
        .ok_or("Resolve app data dir failed")?;
    let mut scope = VaultScope {
        vault_id: vault_id.to_string(),
        client_ids: client_ids.into_iter().collect(),
        ..VaultScope::default()
    };
    collect_scope(&data_dir, &mut scope).map_err(|err| format!("Collect Vault hosts: {err}"))?;

    // Files first: once the legacy hosts file is gone nothing can re-import it.
    let mut file_names = match fs::read_dir(&data_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<_>>(),
        Err(err) => return Err(format!("Read app data dir failed: {err}")),
    };
    file_names.sort();
    for name in file_names
        .iter()
        .filter(|name| is_vault_file(name, vault_id))
    {
        match fs::remove_file(data_dir.join(name)) {
            Ok(()) => report.files_removed.push(name.clone()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => failures.push(format!("remove {name}: {err}")),
        }
    }

    for name in file_names.iter().filter(|name| is_purgeable_db(name)) {
        let path = data_dir.join(name);
        let result = open_db(name, &path).and_then(|mut db| {
            let tx = db.transaction().map_err(|err| err.to_string())?;
            let counts = purge_connection(&tx, &scope)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(counts)
        });
        match result {
            Ok(counts) => {
                for (table, count) in counts {
                    report.rows_deleted.insert(format!("{name}/{table}"), count);
                }
            }
            Err(err) => failures.push(format!("{name}: {err}")),
        }
    }

    if failures.is_empty() {
        Ok(report)
    } else {
        Err(format!(
            "Vault data was only partly deleted; retry to finish. Failed: {}",
            failures.join("; ")
        ))
    }
}

/// Fill in the host and job ids that identify this Vault's unscoped rows.
fn collect_scope(data_dir: &Path, scope: &mut VaultScope) -> Result<(), String> {
    let mut vault_hosts = legacy_host_ids(&data_dir.join(format!(
        "hosts{}.json",
        super::meta::vault_storage_suffix(Some(&scope.vault_id))
    )));
    let mut other_hosts = BTreeSet::new();
    let hosts_db = data_dir.join(HOSTS_DB);
    if hosts_db.exists() {
        let db = Connection::open(&hosts_db).map_err(|err| err.to_string())?;
        if table_columns(&db, "workspace_hosts")?.contains("vault_id") {
            let mut stmt = db
                .prepare("SELECT vault_id, id FROM workspace_hosts")
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|err| err.to_string())?;
            for row in rows {
                let (vault, host) = row.map_err(|err| err.to_string())?;
                if vault == scope.vault_id {
                    vault_hosts.insert(host);
                } else {
                    other_hosts.insert(host);
                }
            }
        }
    }
    scope.exclusive_host_ids = vault_hosts.difference(&other_hosts).cloned().collect();

    let jobs_db = data_dir.join(OPERATION_DB);
    if jobs_db.exists() {
        let db = Connection::open(&jobs_db).map_err(|err| err.to_string())?;
        let columns = table_columns(&db, "operation_jobs")?;
        if columns.contains("vault_id") && columns.contains("job_id") {
            let mut stmt = db
                .prepare("SELECT job_id FROM operation_jobs WHERE vault_id = ?1")
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map([&scope.vault_id], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            for row in rows {
                scope.job_ids.insert(row.map_err(|err| err.to_string())?);
            }
        }
    }
    Ok(())
}

/// Host ids from a legacy `hosts_vault_{id}.json`, read without the corrupt-file
/// recovery side effect of `read_json_or_default`.
fn legacy_host_ids(path: &Path) -> BTreeSet<String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|host| host.get("id")?.as_str().map(str::to_string))
        .filter(|id| !id.is_empty())
        .collect()
}

fn is_purgeable_db(name: &str) -> bool {
    // The runtime lock database is held exclusively by the running app.
    name.ends_with(".sqlite3") && !crate::mcp::is_runtime_lock_file(std::ffi::OsStr::new(name))
}

/// Open through the owning module when there is one so its schema setup and
/// pragmas match; other stores are opened plainly.
fn open_db(name: &str, path: &Path) -> Result<Connection, String> {
    let db = match name {
        HOSTS_DB => {
            let db = Connection::open(path).map_err(|err| err.to_string())?;
            crate::data::hosts::initialize_host_schema(&db)?;
            db
        }
        OPERATION_DB => crate::data::operation_jobs::open_database(path)?,
        _ => Connection::open(path).map_err(|err| err.to_string())?,
    };
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    Ok(db)
}

/// Delete one Vault's rows from every table in this database. Children are
/// removed before parents: rows found through job/client/host ids first, then
/// `vault_id` tables with metadata bindings before `workspace_hosts` (its
/// delete trigger refuses while an active binding exists).
fn purge_connection(
    tx: &Transaction<'_>,
    scope: &VaultScope,
) -> Result<Vec<(String, usize)>, String> {
    let mut tables = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for row in rows {
            let name = row.map_err(|err| err.to_string())?;
            let columns = table_columns(tx, &name)?;
            tables.push((name, columns));
        }
    }
    tables.sort_by_key(|(name, _)| table_order(name));

    let prefix = scoped_host_key_prefix(&scope.vault_id);
    let mut counts = Vec::new();
    for (table, columns) in &tables {
        let quoted = quote_ident(table);
        let mut deleted = 0;
        let mut delete_each = |column: &str, ids: &BTreeSet<String>| -> Result<(), String> {
            if !columns.contains(column) || ids.is_empty() {
                return Ok(());
            }
            let mut stmt = tx
                .prepare(&format!(
                    "DELETE FROM {quoted} WHERE {} = ?1",
                    quote_ident(column)
                ))
                .map_err(|err| err.to_string())?;
            for id in ids {
                deleted += stmt
                    .execute([id])
                    .map_err(|err| format!("{table}: {err}"))?;
            }
            Ok(())
        };
        if columns.contains("vault_id") {
            // Scoped tables carry the Vault id; never widen them by host id,
            // which may be reused by another Vault.
        } else if columns.contains("host_key") {
            delete_each("host_key", &scope.exclusive_host_ids)?;
        } else {
            delete_each("job_id", &scope.job_ids)?;
            delete_each("operation_job_id", &scope.job_ids)?;
            delete_each("client_id", &scope.client_ids)?;
            delete_each("host_id", &scope.exclusive_host_ids)?;
        }
        if columns.contains("vault_id") {
            deleted += tx
                .execute(
                    &format!("DELETE FROM {quoted} WHERE vault_id = ?1"),
                    [&scope.vault_id],
                )
                .map_err(|err| format!("{table}: {err}"))?;
        }
        if columns.contains("host_key") {
            deleted += tx
                .execute(
                    &format!("DELETE FROM {quoted} WHERE substr(host_key, 1, length(?1)) = ?1"),
                    params![prefix],
                )
                .map_err(|err| format!("{table}: {err}"))?;
        }
        if table == "host_metadata_events" && columns.contains("body") {
            deleted += tx
                .execute(
                    "DELETE FROM host_metadata_events WHERE json_valid(body) AND json_extract(body, '$.vaultId') = ?1",
                    [&scope.vault_id],
                )
                .map_err(|err| format!("{table}: {err}"))?;
        }
        if deleted > 0 {
            counts.push((table.clone(), deleted));
        }
    }
    Ok(counts)
}

fn table_order(name: &str) -> u8 {
    match name {
        "host_metadata_bindings" => 0,
        "workspace_hosts" => 2,
        _ => 1,
    }
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

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Every observation key of this Vault starts with this exact text; see
/// `data::server_monitor::scoped_host_key`. The closing quote and comma stop a
/// Vault id from matching another id it is a prefix of.
pub(crate) fn scoped_host_key_prefix(vault_id: &str) -> String {
    format!(
        "vault:[{},",
        serde_json::to_string(vault_id).expect("serialize string")
    )
}

/// Whether an app data file belongs to this Vault: `vault_{id}.json` or
/// `<store>_vault_{id}.json`, plus their `.corrupt-*` backups and
/// `.<name>.tmp-*` atomic-write leftovers (see `storage::write_json`).
pub(crate) fn is_vault_file(name: &str, vault_id: &str) -> bool {
    if vault_id.is_empty() {
        return false;
    }
    let base = if let Some(rest) = name.strip_prefix('.') {
        match rest.rfind(".tmp-") {
            Some(index) => &rest[..index],
            None => return false,
        }
    } else if let Some(index) = name.rfind(".corrupt-") {
        &name[..index]
    } else {
        name
    };
    let file = format!("vault_{vault_id}.json");
    if base == file {
        return true;
    }
    match base.strip_suffix(&format!("_{file}")) {
        // The store name must not itself contain `vault_`, or a file of
        // Vault "x_vault_<id>" would look like a file of Vault "<id>".
        Some(store) => !store.is_empty() && !store.starts_with('.') && !store.contains("vault_"),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_files_match_only_the_exact_id() {
        let id = "3f2a";
        for name in [
            "vault_3f2a.json",
            "hosts_vault_3f2a.json",
            "snippets_vault_3f2a.json",
            "port_forward_rules_vault_3f2a.json",
            "known_hosts_vault_3f2a.json",
            "command_history_vault_3f2a.json",
            "activity_log_vault_3f2a.json",
            "hosts_vault_3f2a.json.corrupt-1773984018626",
            "vault_3f2a.json.corrupt-1-2-3",
            ".hosts_vault_3f2a.json.tmp-1773984018626-42-7",
            ".vault_3f2a.json.tmp-1-2-3",
        ] {
            assert!(is_vault_file(name, id), "{name} should match");
        }
        for name in [
            "vault_3f2ab.json",
            "hosts_vault_3f2ab.json",
            "hosts_vault_x3f2a.json",
            "hosts_vault_personal.json",
            "vaults_meta.json",
            "hosts.json",
            "_vault_3f2a.json",
            "hosts_vault_other_vault_3f2a.json",
            "vault_other_vault_3f2a.json",
            "hosts_vault_3f2a.json.bak",
            ".hosts_vault_3f2a.json",
            "hosts_vault_3f2a.json.tmp-1",
            "mcp.sqlite3",
        ] {
            assert!(!is_vault_file(name, id), "{name} should not match");
        }
        assert!(!is_vault_file("vault_.json", ""));
    }

    #[test]
    fn host_key_prefix_matches_scoped_keys_of_this_vault_only() {
        use crate::data::server_monitor::scoped_host_key;
        let prefix = scoped_host_key_prefix("ab");
        assert_eq!(prefix, "vault:[\"ab\",");
        assert!(scoped_host_key("ab", "h1").starts_with(&prefix));
        assert!(!scoped_host_key("abc", "h1").starts_with(&prefix));
        assert!(!scoped_host_key("a", "b\",x").starts_with(&prefix));
        let quoted = scoped_host_key_prefix("q\"%_");
        assert!(scoped_host_key("q\"%_", "h").starts_with(&quoted));
        assert!(!scoped_host_key("q\"%x", "h").starts_with(&quoted));
    }

    fn temp_db(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!(
            "shellbeam-vault-purge-{}-{}-{}",
            name,
            std::process::id(),
            crate::storage::now_unix_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let db = Connection::open(dir.join("test.sqlite3")).unwrap();
        (dir, db)
    }

    fn count(db: &Connection, sql: &str) -> i64 {
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn purge_removes_only_the_target_vault_rows() {
        let (dir, mut db) = temp_db("rows");
        db.execute_batch(
            r#"
            CREATE TABLE probe_snapshots (vault_id TEXT, host_id TEXT);
            INSERT INTO probe_snapshots VALUES ('gone','h1'),('gone','shared'),('keep','h1'),('gone2','h9');
            CREATE TABLE server_monitor_latest (host_key TEXT, host_id TEXT);
            INSERT INTO server_monitor_latest VALUES
              ('vault:["gone","h1"]','h1'),
              ('vault:["gone2","h1"]','h1'),
              ('vault:["keep","shared"]','shared'),
              ('h1','h1'),
              ('shared','shared'),
              ('other','other');
            CREATE TABLE operation_audit (job_id TEXT, host_id TEXT);
            INSERT INTO operation_audit VALUES ('j1','h1'),('j2','x'),(NULL,'h1'),(NULL,'shared');
            CREATE TABLE mcp_audit (client_id TEXT, host_id TEXT);
            INSERT INTO mcp_audit VALUES ('c1',NULL),('c2',NULL);
            "#,
        )
        .unwrap();
        let scope = VaultScope {
            vault_id: "gone".into(),
            // "shared" also lives in another Vault, so it is not exclusive.
            exclusive_host_ids: ["h1".to_string()].into(),
            job_ids: ["j1".to_string()].into(),
            client_ids: ["c1".to_string()].into(),
        };
        let tx = db.transaction().unwrap();
        let counts = purge_connection(&tx, &scope).unwrap();
        tx.commit().unwrap();

        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM probe_snapshots WHERE vault_id='gone'"
            ),
            0
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM probe_snapshots"), 2);
        let mut stmt = db
            .prepare("SELECT host_key FROM server_monitor_latest ORDER BY host_key")
            .unwrap();
        let keys: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            keys,
            vec![
                "other",
                "shared",
                "vault:[\"gone2\",\"h1\"]",
                "vault:[\"keep\",\"shared\"]"
            ]
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM operation_audit"), 2);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM operation_audit WHERE job_id='j1' OR host_id='h1'"
            ),
            0
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM mcp_audit"), 1);
        assert!(counts.contains(&("probe_snapshots".to_string(), 2)));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn purge_deletes_metadata_bindings_before_guarded_hosts() {
        let (dir, mut db) = temp_db("order");
        crate::data::hosts::initialize_host_schema(&db).unwrap();
        crate::data::host_metadata::initialize(&db).unwrap();
        db.execute_batch(
            r#"
            INSERT INTO workspace_hosts (vault_id,id,name,address,port,username,host_group,auth_type,tags_json,created_at,updated_at)
              VALUES ('gone','h1','n','a',22,'u','','password','[]',1,1);
            INSERT INTO host_metadata_bindings VALUES ('b1','gone','h1','i1','{"status":"active"}');
            INSERT INTO host_metadata_events(body) VALUES ('{"vaultId":"gone"}'),('{"vaultId":"keep"}');
            "#,
        )
        .unwrap();
        let scope = VaultScope {
            vault_id: "gone".into(),
            ..VaultScope::default()
        };
        let tx = db.transaction().unwrap();
        purge_connection(&tx, &scope).unwrap();
        tx.commit().unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM workspace_hosts"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM host_metadata_bindings"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM host_metadata_events"), 1);
        let _ = fs::remove_dir_all(dir);
    }
}
