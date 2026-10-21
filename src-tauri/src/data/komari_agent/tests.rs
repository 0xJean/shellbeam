use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
fn release(version: &str, bytes: &[u8]) -> TrustedRelease {
    let key = SigningKey::from_bytes(&[7; 32]);
    let mut manifest = Manifest {
        runtime: "komari".into(),
        version: version.into(),
        platform: "linux".into(),
        architecture: "amd64".into(),
        url: format!("https://release.test/{version}"),
        sha256: artifact::hash(bytes),
        size_bytes: bytes.len(),
        signature: String::new(),
    };
    manifest.signature = STANDARD.encode(key.sign(&artifact::canonical(&manifest)).to_bytes());
    TrustedRelease {
        manifest,
        public_key: STANDARD.encode(key.verifying_key().to_bytes()),
    }
}
fn host() -> HostProfile {
    serde_json::from_value(json!({"id":"host","name":"Test","address":"fixture.invalid","port":22,"username":"runner","group":"test","authType":"password","tags":[],"createdAt":1,"updatedAt":2})).unwrap()
}
fn record() -> Record {
    Record {
        vault_id: "vault".into(),
        host_id: "host".into(),
        host_created_at: 1,
        integration_id: "service".into(),
        service_identity: "source".into(),
        node_id: Uuid::new_v4().to_string(),
        node_created_at: "2026-01-01T00:00:00Z".into(),
        deployment: Uuid::new_v4().to_string(),
        revision: 0,
        identity: Identity {
            machine: "a".repeat(32),
            uid: 1000,
            root: "/home/fixture/.local/share/shellbeam/komari/id".into(),
            architecture: "amd64".into(),
        },
        host_keys: "pins".into(),
        endpoint: "https://monitor.test".into(),
        status: "prepared".into(),
        action: "install".into(),
        job_id: String::new(),
        current: None,
        previous: None,
        requested: Some(release("1.5.11", b"agent")),
        observation: Observation {
            status: "absent".into(),
            ..Default::default()
        },
        watermark: 0,
        observed_at: None,
        updated_at: 1,
        error_code: None,
    }
}
#[test]
fn requires_domain_separated_signature_exact_size_hash_and_runtime() {
    let r = release("1.5.11", b"agent");
    artifact::verify_bytes(&r, b"agent").unwrap();
    assert!(artifact::verify_bytes(&r, b"agEnt").is_err());
    assert!(artifact::verify_bytes(&r, b"agent0").is_err());
    let mut tampered = r.clone();
    tampered.manifest.url = "https://else.test/agent".into();
    assert!(artifact::verify(&tampered).is_err());
    let mut cross = r.clone();
    cross.manifest.runtime = "shellbeam".into();
    assert!(artifact::verify(&cross).is_err());
    let mut signature = r.clone();
    signature.manifest.signature = STANDARD.encode(
        SigningKey::from_bytes(&[7; 32])
            .sign(&serde_json::to_vec(&r.manifest).unwrap())
            .to_bytes(),
    );
    assert!(artifact::verify(&signature).is_err());
    let mut root = r;
    root.public_key = STANDARD.encode(SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes());
    assert!(artifact::verify(&root).is_err());
}
#[test]
fn original_samples_only_and_freshness_never_uses_receipt_time() {
    let t = chrono::DateTime::parse_from_rfc3339("2026-10-21T12:00:00Z")
        .unwrap()
        .timestamp_millis();
    assert_eq!(
        sample(
            &json!({"data":{"records":[{"cpu":1,"time":"2026-10-21T12:00:00Z"}]}}),
            0
        ),
        t
    );
    assert_eq!(sample(&json!({"cpu":1,"receivedAt":t}), 0), 0);
    assert_eq!(sample(&json!({"time":"2026-10-21T12:00:00Z"}), 0), 0);
    assert!(!fresh(t, t, t, t));
    assert!(!fresh(t, t - 1, t + 6_000, t + 6_000));
    assert!(!fresh(t + 10_000, t, t, t));
    assert!(fresh(t, t - 1, t, t + 1_000));
}
#[test]
fn preview_endpoint_cannot_contain_authentication_or_query() {
    for url in [
        "https://user:pass@example.test",
        "https://x.test?token=private",
        "file:///etc/passwd",
        "https://x.test/#token",
    ] {
        assert!(endpoint(url).is_err());
    }
    assert_eq!(
        endpoint("http://127.0.0.1:8080/").unwrap(),
        "http://127.0.0.1:8080"
    );
}
#[test]
fn recovery_accepts_only_previously_trusted_deployment_releases() {
    let mut r = record();
    let mut s = Observation {
        status: "active".into(),
        active: true,
        deployment: Some(r.deployment.clone()),
        current: Some(r.requested.as_ref().unwrap().manifest.clone()),
        ..Default::default()
    };
    apply_observation(&mut r, s.clone()).unwrap();
    assert_eq!(r.current.as_ref().unwrap().manifest.version, "1.5.11");
    s.current = Some(release("1.5.12", b"other").manifest);
    assert!(apply_observation(&mut r, s.clone()).is_err());
    s.deployment = Some(Uuid::new_v4().to_string());
    assert!(validate_observation(&r, &s).is_err());
    assert!(validate_observation(
        &r,
        &Observation {
            status: "absent".into(),
            ..Default::default()
        }
    )
    .is_err());
}
#[test]
fn intent_and_confirmed_audit_are_atomic_and_revision_guarded() {
    let path = std::env::temp_dir().join(format!(
        "shellbeam-komari-agent-test-{}.sqlite3",
        Uuid::new_v4()
    ));
    let mut db = crate::data::operation_jobs::open_database(&path).unwrap();
    store::initialize(&db).unwrap();
    let mut r = record();
    store::begin(&mut db, &mut r, &host(), "ssh-proxyjump", 0).unwrap();
    let job = super::super::operation_jobs::get_on(&db, &r.job_id)
        .unwrap()
        .unwrap();
    assert_eq!(job.confirmation_status, "confirmed");
    assert_eq!(job.status, "running");
    assert_eq!(job.transport, "ssh-proxyjump");
    assert_eq!(job.vault_id.as_deref(), Some("vault"));
    let mut stale = record();
    assert!(store::begin(&mut db, &mut stale, &host(), "ssh-direct", 0).is_err());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM operation_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    r.status = "dispatched".into();
    store::save(&mut db, &mut r, None).unwrap();
    let old_job = r.job_id.clone();
    let mut recovered = store::get(&db, "vault", "host").unwrap().unwrap();
    recovered.action = "inspect".into();
    let revision = recovered.revision;
    store::begin(&mut db, &mut recovered, &host(), "ssh-proxyjump", revision).unwrap();
    assert_ne!(old_job, recovered.job_id);
    assert_eq!(
        super::super::operation_jobs::get_on(&db, &old_job)
            .unwrap()
            .unwrap()
            .status,
        "unknown"
    );
    recovered.status = "active".into();
    store::save(&mut db, &mut recovered, Some("completed")).unwrap();
    assert_eq!(
        super::super::operation_jobs::get_on(&db, &old_job)
            .unwrap()
            .unwrap()
            .status,
        "unknown"
    );
    assert!(store::get(&db, "other-vault", "host").unwrap().is_none());
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='shellbeam_agents'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn public_errors_never_include_remote_exception_or_secret() {
    assert_eq!(
        safe_error("command failed: token=secret"),
        "KOMARI_AGENT_OPERATION_FAILED"
    );
    assert_eq!(
        safe_error("KOMARI_AGENT_SCOPE_CHANGED"),
        "KOMARI_AGENT_SCOPE_CHANGED"
    );
}
#[test]
fn native_verifies_the_node_publishers_exact_wire_payload() {
    let release: TrustedRelease = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/compatible-agent-signed-test.json"
    ))
    .unwrap();
    artifact::verify_bytes(&release, b"isolated cross-language signing fixture").unwrap();
}
#[test]
fn changed_remote_configuration_cannot_silently_rebind_an_existing_agent() {
    let mut r = record();
    let manifest = r.requested.as_ref().unwrap().manifest.clone();
    r.observation.config_sha256 = Some("a".repeat(64));
    let state = Observation {
        status: "active".into(),
        deployment: Some(r.deployment.clone()),
        current: Some(manifest),
        config_sha256: Some("b".repeat(64)),
        ..Default::default()
    };
    assert_eq!(
        validate_observation(&r, &state).unwrap_err(),
        "KOMARI_AGENT_CONFIGURATION_CHANGED"
    );
}
#[test]
fn execution_lease_limits_a_vault_and_excludes_duplicate_host_actions() {
    let vault = Uuid::new_v4().to_string();
    let another = Uuid::new_v4().to_string();
    let first = lease(&vault, "one").unwrap();
    assert!(lease(&vault, "one").is_err());
    let second = lease(&vault, "two").unwrap();
    assert!(lease(&vault, "three").is_err());
    let foreign = lease(&another, "one").unwrap();
    drop(first);
    let next = lease(&vault, "three").unwrap();
    drop((second, foreign, next));
    assert!(lease(&vault, "one").is_ok());
}
#[test]
fn compensation_tolerates_a_stopped_process_but_never_a_changed_remote_journal() {
    let before = Observation {
        status: "active".into(),
        active: true,
        deployment: Some("managed".into()),
        current: Some(release("1.5.11", b"agent").manifest),
        config_sha256: Some("a".repeat(64)),
        job: Some("authorized".into()),
        ..Default::default()
    };
    let mut after = before.clone();
    after.active = false;
    assert!(same_activation(&before, &after));
    after.job = Some("another-operation".into());
    assert!(!same_activation(&before, &after));
    after = before.clone();
    after.config_sha256 = Some("b".repeat(64));
    assert!(!same_activation(&before, &after));
}

#[test]
fn default_trust_is_built_in_but_old_custom_preferences_are_not_overwritten() {
    let path = std::env::temp_dir().join(format!("probe-policy-{}", Uuid::new_v4()));
    let default = artifact::read_policy(&path).unwrap();
    assert!(default.enabled);
    assert_eq!(default.source, "official");
    assert_eq!(default.trusted_public_key, official::trust().public_key);
    let legacy = br#"{"enabled":false,"manifestUrl":"https://private.test/catalog.json","trustedPublicKey":"existing","allowedHosts":["private.test"]}"#;
    std::fs::write(&path, legacy).unwrap();
    let old = artifact::read_policy(&path).unwrap();
    assert_eq!(old.source, "custom");
    assert!(!old.enabled);
    assert_eq!(old.trusted_public_key, "existing");
    assert_eq!(std::fs::read(&path).unwrap(), legacy);
    std::fs::write(&path, br#"{"source":"official","enabled":false,"manifestUrl":"https://attacker.test","trustedPublicKey":"other","allowedHosts":[]}"#).unwrap();
    let normalized = artifact::read_policy(&path).unwrap();
    assert!(!normalized.enabled);
    assert_eq!(normalized.manifest_url, default.manifest_url);
    assert_eq!(normalized.trusted_public_key, default.trusted_public_key);
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(artifact::read_policy(&path).is_err());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn official_catalog_signature_time_and_architectures_match_node_publisher() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/official-compatible-catalog-test.json"
    ))
    .unwrap();
    let root: official::Trust = serde_json::from_value(fixture["root"].clone()).unwrap();
    let c = fixture["catalog"].clone();
    let now = c["publishedAt"].as_i64().unwrap();
    let bytes = serde_json::to_vec(&c).unwrap();
    official::verify_catalog(&bytes, &root, now).unwrap();
    assert!(official::verify_catalog(&bytes, &official::trust(), now).is_err());
    assert!(official::verify_catalog(&bytes, &root, c["expiresAt"].as_i64().unwrap()).is_err());
    assert!(official::verify_catalog(&bytes, &root, now - 300_001).is_err());
    for (key, value) in [
        ("sequence", json!(2)),
        ("channel", json!("preview")),
        ("expiresAt", json!(now + 1)),
        ("keyId", json!("other")),
    ] {
        let mut changed = c.clone();
        changed[key] = value;
        assert!(
            official::verify_catalog(&serde_json::to_vec(&changed).unwrap(), &root, now).is_err()
        );
    }
}

#[test]
fn production_bootstrap_catalog_verifies_with_the_compiled_public_key() {
    let bytes = include_bytes!("../../../../releases/compatible-probe-bootstrap.json");
    let header: Value = serde_json::from_slice(bytes).unwrap();
    let c = official::verify_catalog(
        bytes,
        &official::trust(),
        header["publishedAt"].as_i64().unwrap(),
    )
    .unwrap();
    let pins: Value = serde_json::from_str(include_str!(
        "../../../../releases/compatible-probe-pins.json"
    ))
    .unwrap();
    for m in c.artifacts {
        assert_eq!(
            m.sha256,
            pins["versions"][&m.version][&m.architecture]["sha256"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            m.size_bytes as u64,
            pins["versions"][&m.version][&m.architecture]["size"]
                .as_u64()
                .unwrap()
        );
    }
}

#[test]
fn catalog_watermark_survives_reopen_and_rejects_replay_equivocation_and_downgrade() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/official-compatible-catalog-test.json"
    ))
    .unwrap();
    let mut c: official::Catalog = serde_json::from_value(fixture["catalog"].clone()).unwrap();
    let path = std::env::temp_dir().join(format!("probe-catalog-{}.sqlite3", Uuid::new_v4()));
    official::remember(&path, &c).unwrap();
    official::remember(&path, &c).unwrap();
    c.sequence = 2;
    official::remember(&path, &c).unwrap();
    c.sequence = 1;
    assert!(official::remember(&path, &c).is_err());
    c.sequence = 2;
    c.published_at += 1;
    assert!(official::remember(&path, &c).is_err());
    c.sequence = 3;
    c.artifacts[0].version = "1.5.10".into();
    assert!(official::remember(&path, &c).is_err());
    std::fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "explicit anonymous production release download, no Vault access"]
fn builtin_production_catalog_and_binaries_verify_without_user_configuration() {
    assert_eq!(
        std::env::var("SHELLBEAM_OFFICIAL_PROBE_RELEASE_LIVE").as_deref(),
        Ok("1")
    );
    let policy = artifact::Policy::default();
    let downloaded =
        crate::agent_release::download(&policy.manifest_url, &policy.allowed_hosts, 65536).unwrap();
    let catalog = official::verify_catalog(
        &STANDARD.decode(downloaded.bytes_b64).unwrap(),
        &official::trust(),
        now_unix_ms(),
    )
    .unwrap();
    for manifest in catalog.artifacts {
        let r = TrustedRelease {
            manifest,
            public_key: policy.trusted_public_key.clone(),
        };
        let bytes = artifact::download(&r, &policy).unwrap();
        artifact::verify_bytes(&r, &STANDARD.decode(bytes).unwrap()).unwrap();
    }
}
