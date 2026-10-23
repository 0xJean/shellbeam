use super::*;
use std::{cell::RefCell, collections::HashMap};
struct Fixture {
    files: RefCell<HashMap<String, Vec<u8>>>,
    configuration: RefCell<Value>,
    enabled: RefCell<bool>,
    writes: RefCell<Vec<String>>,
    lose_merge: RefCell<bool>,
}
fn state() -> Value {
    json!({"version":1,"identity":"a".repeat(48),"revision":7,"policy":{"rules":[],"silences":[]},"evaluations":{"old":{"sampledAt":123,"notified":true}},"events":[{"delivery":"unknown","sampledAt":123}],"receipts":[{"revision":7}],"future":{"kept":true}})
}
impl Fixture {
    fn new() -> Self {
        let f = Self {
            files: RefCell::new(
                NAMES
                    .iter()
                    .zip(OLD_FILES)
                    .map(|(n, b)| (n.to_string(), b.to_vec()))
                    .collect(),
            ),
            configuration: RefCell::new(json!({"future":"synthetic-kept"})),
            enabled: RefCell::new(true),
            writes: RefCell::new(vec![]),
            lose_merge: RefCell::new(false),
        };
        f.files
            .borrow_mut()
            .insert("state.json".into(), state().to_string().into_bytes());
        f
    }
    fn value(&self) -> Value {
        serde_json::from_slice(&self.files.borrow()["state.json"]).unwrap()
    }
}
impl Transport for Fixture {
    fn call(&self, path: &str, body: Option<&Value>) -> Result<Value, String> {
        if let Some(b) = body {
            self.writes.borrow_mut().push(path.into());
            return match path {
                "/api/admin/plugin/enabled" => {
                    *self.enabled.borrow_mut() = b["enabled"] == true;
                    Ok(Value::Null)
                }
                "/api/admin/plugin/delete" => {
                    self.files.borrow_mut().clear();
                    *self.enabled.borrow_mut() = false;
                    *self.configuration.borrow_mut() = json!({});
                    Ok(Value::Null)
                }
                "/api/admin/plugin/configuration" => {
                    *self.configuration.borrow_mut() = b["data"].clone();
                    Ok(Value::Null)
                }
                _ => panic!("unexpected write"),
            };
        }
        Ok(match path {
            "/api/version" => json!({"version":"1.6.0"}),
            "/api/admin/plugin/list" => {
                if self.files.borrow().is_empty() {
                    json!([])
                } else {
                    json!([{"short":SHORT,"enabled":*self.enabled.borrow(),"running":*self.enabled.borrow()}])
                }
            }
            "/api/admin/plugin/configuration?short=shellbeam-alerts" => {
                json!({"data":*self.configuration.borrow()})
            }
            "/api/shellbeam-alerts/v1/lifecycle" => {
                json!({"version":CURRENT,"identity":self.value()["identity"]})
            }
            _ => panic!("unexpected read"),
        })
    }
    fn file(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.files.borrow().get(name).cloned())
    }
    fn install(&self, bytes: Vec<u8>, expected: Option<&Snapshot>) -> Result<(), String> {
        if let Some(s) = expected {
            stopped(self, s)?;
        } else {
            assert!(self.files.borrow().is_empty());
        }
        self.writes.borrow_mut().push("merge".into());
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut files = self.files.borrow_mut();
        files.clear();
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            let name = file.name().to_string();
            let mut b = Vec::new();
            file.read_to_end(&mut b).unwrap();
            files.insert(name, b);
        }
        if *self.lose_merge.borrow() {
            return Err("MONITORING_NETWORK".into());
        }
        Ok(())
    }
}
#[test]
fn upgrades_only_reviewed_code_and_preserves_all_state_with_durable_backup_first() {
    let f = Fixture::new();
    let mut cp = prepare(&f, "upgrade").unwrap();
    let mut saved = Vec::new();
    apply(&f, &mut cp, |c| {
        saved.push(c.clone());
        Ok(())
    })
    .unwrap();
    assert!(verified(&f, &cp).unwrap());
    assert_eq!(f.value(), state());
    assert_eq!(
        *f.configuration.borrow(),
        json!({"future":"synthetic-kept"})
    );
    let backup = saved.iter().find(|c| c.stage == "backed-up").unwrap();
    assert_eq!(backup.backup.as_ref().unwrap().state, state());
    assert_eq!(
        saved.iter().map(|c| c.stage.as_str()).collect::<Vec<_>>(),
        [
            "stop-dispatched",
            "backed-up",
            "replace-dispatched",
            "configuration-dispatched",
            "start-dispatched"
        ]
    );
    assert_eq!(known(&f).unwrap(), CURRENT);
}
#[test]
fn uninstall_has_recoverable_state_and_restore_keeps_identity_dispatch_markers_and_configuration() {
    let f = Fixture::new();
    let mut cp = prepare(&f, "uninstall").unwrap();
    apply(&f, &mut cp, |_| Ok(())).unwrap();
    assert!(verified(&f, &cp).unwrap());
    assert!(f.files.borrow().is_empty());
    let persisted: Checkpoint = serde_json::from_str(&serde_json::to_string(&cp).unwrap()).unwrap();
    let mut recovery = restore(&persisted).unwrap();
    apply(&f, &mut recovery, |_| Ok(())).unwrap();
    assert!(verified(&f, &recovery).unwrap());
    assert_eq!(known(&f).unwrap(), "0.1.0");
    assert_eq!(f.value(), state());
    assert!(*f.enabled.borrow());
    assert_eq!(
        *f.configuration.borrow(),
        json!({"future":"synthetic-kept"})
    );
}
#[test]
fn failed_backup_commit_prevents_delete_or_replace_and_readback_never_mutates() {
    for operation in ["upgrade", "uninstall"] {
        let f = Fixture::new();
        let mut cp = prepare(&f, operation).unwrap();
        assert!(apply(&f, &mut cp, |c| if c.stage == "backed-up" {
            Err("disk full".into())
        } else {
            Ok(())
        })
        .is_err());
        assert_eq!(*f.writes.borrow(), vec!["/api/admin/plugin/enabled"]);
        assert_eq!(f.value(), state());
        let count = f.writes.borrow().len();
        for _ in 0..3 {
            assert!(!verified(&f, &cp).unwrap());
        }
        assert_eq!(f.writes.borrow().len(), count);
    }
}
#[test]
fn lost_merge_response_is_read_only_until_explicit_continuation_and_never_merges_twice() {
    let f = Fixture::new();
    let mut cp = prepare(&f, "upgrade").unwrap();
    *f.lose_merge.borrow_mut() = true;
    assert!(apply(&f, &mut cp, |_| Ok(())).is_err());
    assert!(!verified(&f, &cp).unwrap());
    assert!(!*f.enabled.borrow());
    let count = f.writes.borrow().len();
    assert!(!verified(&f, &cp).unwrap());
    assert_eq!(count, f.writes.borrow().len());
    // A caller must obtain a new confirmed intent before invoking apply again.
    apply(&f, &mut cp, |_| Ok(())).unwrap();
    assert!(verified(&f, &cp).unwrap());
    assert_eq!(
        f.writes.borrow().iter().filter(|p| *p == "merge").count(),
        1
    );
}
#[test]
fn recovery_restores_failed_upgrade_but_refuses_new_remote_state_or_foreign_code() {
    let f = Fixture::new();
    let mut cp = prepare(&f, "upgrade").unwrap();
    *f.lose_merge.borrow_mut() = true;
    assert!(apply(&f, &mut cp, |_| Ok(())).is_err());
    *f.lose_merge.borrow_mut() = false;
    let mut recovery = restore(&cp).unwrap();
    apply(&f, &mut recovery, |_| Ok(())).unwrap();
    assert!(verified(&f, &recovery).unwrap());
    let f = Fixture::new();
    let mut cp = prepare(&f, "upgrade").unwrap();
    *f.lose_merge.borrow_mut() = true;
    assert!(apply(&f, &mut cp, |_| Ok(())).is_err());
    let mut changed = state();
    changed["events"] = json!([{"new":"must retain"}]);
    f.files
        .borrow_mut()
        .insert("state.json".into(), changed.to_string().into_bytes());
    let count = f.writes.borrow().len();
    assert!(apply(&f, &mut restore(&cp).unwrap(), |_| Ok(())).is_err());
    assert_eq!(count, f.writes.borrow().len());
    assert_eq!(f.value(), changed);
    f.files
        .borrow_mut()
        .insert("server.cjs".into(), b"foreign".to_vec());
    assert!(prepare(&f, "uninstall").is_err());
    assert_eq!(count, f.writes.borrow().len());
}
#[test]
fn scope_change_before_stop_and_backupless_restore_are_rejected() {
    let f = Fixture::new();
    let mut cp = prepare(&f, "uninstall").unwrap();
    assert!(restore(&cp).is_err());
    let mut s = state();
    s["identity"] = json!("b".repeat(48));
    f.files
        .borrow_mut()
        .insert("state.json".into(), s.to_string().into_bytes());
    assert!(apply(&f, &mut cp, |_| Ok(())).is_err());
    assert!(f.writes.borrow().is_empty());
}

/// Uses the production transport and state machine against an explicitly
/// launched disposable official service. No App/Vault context is impersonated.
pub(crate) fn live(client: &reqwest::blocking::Client, endpoint: &str, token: &str) -> Value {
    let io = Wire {
        client,
        endpoint,
        token,
        guard: &|| Ok(()),
    };
    let original = Snapshot {
        version: "0.1.0".into(),
        state: state(),
        configuration: json!({"future":"native-preserved"}),
        enabled: true,
    };
    let nonce = uuid::Uuid::new_v4().to_string();
    io.install(archive(&original, "0.1.0", &nonce).unwrap(), None)
        .unwrap();
    io.call(
        "/api/admin/plugin/configuration",
        Some(&json!({"short":SHORT,"data":original.configuration})),
    )
    .unwrap();
    enabled(&io, true).unwrap();
    assert_eq!(known(&io).unwrap(), "0.1.0");
    let mut upgrade = prepare(&io, "upgrade").unwrap();
    let mut retained = None;
    apply(&io, &mut upgrade, |cp| {
        retained = Some(serde_json::to_string(cp).unwrap());
        Ok(())
    })
    .unwrap();
    assert!(verified(&io, &upgrade).unwrap());
    let expected = upgrade.backup.as_ref().unwrap();
    assert_eq!(
        json_file(&io, "state.json").unwrap().unwrap(),
        expected.state
    );
    assert_eq!(config(&io).unwrap(), expected.configuration);
    let mut removal = prepare(&io, "uninstall").unwrap();
    apply(&io, &mut removal, |cp| {
        retained = Some(serde_json::to_string(cp).unwrap());
        Ok(())
    })
    .unwrap();
    assert!(verified(&io, &removal).unwrap());
    let saved: Checkpoint = serde_json::from_str(&retained.unwrap()).unwrap();
    let mut restored = restore(&saved).unwrap();
    apply(&io, &mut restored, |_| Ok(())).unwrap();
    assert!(verified(&io, &restored).unwrap());
    assert_eq!(
        json_file(&io, "state.json").unwrap().unwrap()["identity"],
        original.state["identity"]
    );
    assert_eq!(config(&io).unwrap(), original.configuration);
    // A stop-boundary interruption leaves the complete state in place. Read
    // reconciliation does not resume it; explicit continuation does.
    let mut interrupted = prepare(&io, "uninstall").unwrap();
    let mut saved = None;
    assert!(apply(&io, &mut interrupted, |cp| {
        saved = Some(cp.clone());
        if cp.stage == "backed-up" {
            Err("synthetic interrupted after checkpoint".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    let mut resumed = saved.unwrap();
    let before = inspect(&io).unwrap();
    assert!(!verified(&io, &resumed).unwrap());
    assert_eq!(inspect(&io).unwrap(), before);
    apply(&io, &mut resumed, |_| Ok(())).unwrap();
    assert!(verified(&io, &resumed).unwrap());
    let mut final_restore = restore(&resumed).unwrap();
    apply(&io, &mut final_restore, |_| Ok(())).unwrap();
    assert!(verified(&io, &final_restore).unwrap());
    let state = json_file(&io, "state.json").unwrap().unwrap();
    assert_eq!(state["events"], original.state["events"]);
    assert_eq!(state["receipts"], original.state["receipts"]);
    assert_eq!(
        state["evaluations"]["old"],
        original.state["evaluations"]["old"]
    );
    json!({"result":"passed","productionTransport":true,"productionEngine":true,"productionAppCoordinator":false,"checks":["reviewed legacy bytes installed","upgrade retains identity state configuration and dispatch markers","uninstall only after retained checkpoint","restore retained current version and original identity","interrupted stopped extension stays unchanged under readonly reconciliation","explicit continuation and restore retain event receipts and unknown fields"],"originalVersion":"0.1.0","upgradedVersion":CURRENT,"stateIdentityRetained":true,"unknownDispatchRetained":true})
}

#[test]
fn rejects_malformed_policy_and_external_enable_changes_without_stopping() {
    let mut malformed = state();
    for value in [json!("not-policy"), json!(7), json!(null)] {
        malformed["policy"] = value;
        assert!(validate_state(&malformed).is_err());
    }
    let f = Fixture::new();
    let mut cp = prepare(&f, "uninstall").unwrap();
    *f.enabled.borrow_mut() = false;
    assert!(apply(&f, &mut cp, |_| Ok(())).is_err());
    assert!(f.writes.borrow().is_empty());
}

#[test]
fn disabled_extension_stays_disabled_and_configuration_changes_are_not_verified() {
    let f = Fixture::new();
    *f.enabled.borrow_mut() = false;
    let mut cp = prepare(&f, "upgrade").unwrap();
    apply(&f, &mut cp, |_| Ok(())).unwrap();
    assert!(!*f.enabled.borrow());
    assert!(verified(&f, &cp).unwrap());
    *f.configuration.borrow_mut() = json!({"future":"changed-elsewhere"});
    assert!(!verified(&f, &cp).unwrap());
}
