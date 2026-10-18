use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn launch(path: &Path) -> Daemon {
    Daemon(
        Command::new(env!("CARGO_BIN_EXE_shellbeam-agent"))
            .args([
                "daemon",
                "--interval-seconds",
                "1",
                "--history-limit",
                "3",
                "--state-dir",
            ])
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}
fn wait_sample(path: &Path, after: u64) -> Value {
    let started = Instant::now();
    loop {
        if let Ok(value) = shellbeam_agent::read_json(&path.join("status.json")) {
            if value["lastHeartbeatAt"].as_u64().unwrap_or(0) > after {
                return value;
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "daemon did not collect a new sample"
        );
        thread::sleep(Duration::from_millis(50));
    }
}
#[test]
fn daemon_collects_without_desktop_and_preserves_bounded_history_on_restart() {
    let directory = std::env::temp_dir().join(format!(
        "shellbeam-daemon-integration-{}-{}",
        std::process::id(),
        shellbeam_agent::now_ms()
    ));
    let mut daemon = launch(&directory);
    let initial = wait_sample(&directory, 0);
    assert!(initial["metrics"]["memoryTotalBytes"].as_u64().unwrap() > 0);
    assert!(initial["inventory"]["tools"].is_array());
    let mut duplicate = launch(&directory);
    assert!(!duplicate.0.wait().unwrap().success());
    let second = wait_sample(&directory, initial["lastHeartbeatAt"].as_u64().unwrap());
    unsafe {
        libc::kill(daemon.0.id() as i32, libc::SIGTERM);
    }
    assert!(daemon.0.wait().unwrap().success());
    assert_eq!(
        shellbeam_agent::probe(&directory).unwrap()["health"],
        "offline"
    );
    let mut restarted = launch(&directory);
    let third = wait_sample(&directory, second["lastHeartbeatAt"].as_u64().unwrap());
    let _fourth = wait_sample(&directory, third["lastHeartbeatAt"].as_u64().unwrap());
    unsafe {
        libc::kill(restarted.0.id() as i32, libc::SIGTERM);
    }
    assert!(restarted.0.wait().unwrap().success());
    let history = shellbeam_agent::history(&directory, 100).unwrap();
    assert_eq!(history.as_array().unwrap().len(), 3);
    assert!(
        history[0]["lastHeartbeatAt"].as_u64().unwrap()
            >= second["lastHeartbeatAt"].as_u64().unwrap()
    );
    fs::remove_dir_all(directory).unwrap();
}

fn page_command(path: &Path, agent_id: &str, after: u64, through: u64) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_shellbeam-agent"))
        .args([
            "history-page",
            "--json",
            "--agent-id",
            agent_id,
            "--after",
            &after.to_string(),
            "--through",
            &through.to_string(),
            "--limit",
            "1",
            "--state-dir",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "page failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() <= shellbeam_agent::history_protocol_limits().page_bytes);
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn daemon_cli_pages_original_samples_across_restart_with_a_fixed_through_and_identity() {
    let directory = std::env::temp_dir().join(format!(
        "shellbeam-daemon-pages-{}-{}",
        std::process::id(),
        shellbeam_agent::now_ms()
    ));
    let mut daemon = launch(&directory);
    let first = wait_sample(&directory, 0);
    let first_at = first["sampledAt"].as_u64().unwrap();
    let second = wait_sample(&directory, first_at);
    let second_at = second["sampledAt"].as_u64().unwrap();
    let third = wait_sample(&directory, second_at);
    let through = third["sampledAt"].as_u64().unwrap();
    unsafe { libc::kill(daemon.0.id() as i32, libc::SIGTERM) };
    assert!(daemon.0.wait().unwrap().success());
    let agent_id = first["agentId"].as_str().unwrap();
    let first_page = page_command(&directory, agent_id, 0, through);
    assert_eq!(first_page["points"], serde_json::json!([first]));
    assert_eq!(first_page["hasMore"], true);
    assert_eq!(first_page["nextCursor"], first_at);

    // A mutable legacy hostname/status must not alter the persisted provider
    // identity or disconnect the cursor when the daemon restarts.
    let mut changed = third.clone();
    changed["agentId"] = serde_json::json!("changed-hostname-does-not-change-installation");
    shellbeam_agent::atomic_json(&directory.join("status.json"), &changed).unwrap();
    let mut restarted = launch(&directory);
    let fourth = wait_sample(&directory, through);
    assert_eq!(fourth["agentId"].as_str(), Some(agent_id));
    let fourth_at = fourth["sampledAt"].as_u64().unwrap();
    unsafe { libc::kill(restarted.0.id() as i32, libc::SIGTERM) };
    assert!(restarted.0.wait().unwrap().success());
    let second_page = page_command(&directory, agent_id, first_at, through);
    assert_eq!(second_page["points"], serde_json::json!([second]));
    assert_eq!(second_page["through"], through);
    assert_eq!(second_page["nextCursor"], second_at);
    assert_eq!(second_page["hasMore"], true);
    let third_page = page_command(&directory, agent_id, second_at, through);
    assert_eq!(third_page["points"], serde_json::json!([third]));
    assert_eq!(third_page["hasMore"], false);
    let next_snapshot = page_command(&directory, agent_id, through, fourth_at);
    assert_eq!(next_snapshot["points"], serde_json::json!([fourth]));
    let empty = page_command(&directory, agent_id, fourth_at, fourth_at);
    assert_eq!(empty["nextCursor"], fourth_at);
    assert_eq!(empty["points"], serde_json::json!([]));
    let mismatch = Command::new(env!("CARGO_BIN_EXE_shellbeam-agent"))
        .args([
            "history-page",
            "--agent-id",
            "other-installation",
            "--after",
            "0",
            "--through",
            &through.to_string(),
            "--state-dir",
        ])
        .arg(&directory)
        .output()
        .unwrap();
    assert!(!mismatch.status.success());
    assert!(mismatch.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&mismatch.stderr).unwrap()["errorSummary"],
        "history_page_identity_mismatch"
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn history_page_cli_rejects_missing_malformed_or_ambiguous_cursors() {
    let cases = [
        vec!["--agent-id", "a", "--through", "4"],
        vec!["--agent-id", "a", "--after", "-1", "--through", "4"],
        vec![
            "--agent-id",
            "a",
            "--after",
            "0",
            "--through",
            "4",
            "--limit",
            "bad",
        ],
        vec![
            "--agent-id",
            "a",
            "--after",
            "0",
            "--through",
            "4",
            "--after",
            "2",
        ],
        vec!["--agent-id", "a", "--after", "0", "--through", "4", "extra"],
        vec!["--after", "0", "--through", "4"],
    ];
    for arguments in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_shellbeam-agent"))
            .arg("history-page")
            .args(arguments)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap()["errorSummary"],
            "history_page_arguments_invalid"
        );
    }
}

#[test]
fn history_page_cli_does_not_publish_a_partial_page_for_a_corrupt_window() {
    let directory = std::env::temp_dir().join(format!(
        "shellbeam-daemon-corrupt-page-{}-{}",
        std::process::id(),
        shellbeam_agent::now_ms()
    ));
    let agent_id = shellbeam_agent::persistent_agent_id(&directory).unwrap();
    let point = |sampled_at| serde_json::json!({"schemaVersion":1,"agentId":agent_id,"sampledAt":sampled_at,"metrics":{"sampledAt":sampled_at,"cpuPercent":10}});
    let mut invalid = point(20);
    invalid["schemaVersion"] = serde_json::json!(2);
    for value in [point(10), invalid, point(30)] {
        shellbeam_agent::append_history(&directory, &value, 3, shellbeam_agent::HISTORY_MAX_BYTES)
            .unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_shellbeam-agent"))
        .args([
            "history-page",
            "--json",
            "--agent-id",
            &agent_id,
            "--after",
            "0",
            "--through",
            "30",
            "--limit",
            "1",
            "--state-dir",
        ])
        .arg(&directory)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "a failed page must not expose a usable partial cursor"
    );
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["health"], "unknown");
    assert_eq!(error["errorSummary"], "history_page_record_invalid");
    assert!(error.get("nextCursor").is_none());
    fs::remove_dir_all(directory).unwrap();
}

/// Explicit smoke for an interactive macOS GUI session. It uses the real
/// generated service definition and never touches the user's default service,
/// HOME, executable installation or default data directory.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "Requires an interactive GUI launchd session; run explicitly on macOS"]
fn launchd_service_activates_restarts_and_stops_in_isolated_state() {
    let directory = std::env::temp_dir().join(format!(
        "shellbeam-launchd-smoke-{}-{}",
        std::process::id(),
        shellbeam_agent::now_ms()
    ));
    fs::create_dir_all(&directory).unwrap();
    let executable = Path::new(env!("CARGO_BIN_EXE_shellbeam-agent"));
    let label = format!("app.shellbeam.agent.smoke.{}", std::process::id());
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let target = format!("{domain}/{label}");
    let plist = directory.join("probe.plist");
    let definition = shellbeam_agent::service_definition(executable, &directory)
        .unwrap()
        .replace("app.shellbeam.agent", &label);
    fs::write(&plist, definition).unwrap();
    struct Cleanup {
        target: String,
        directory: std::path::PathBuf,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = Command::new("/bin/launchctl")
                .args(["bootout", &self.target])
                .output();
            let mut unloaded = shellbeam_agent::wait_for_launchd_unloaded(&self.target).is_ok();
            if !unloaded {
                let domain = self
                    .target
                    .rsplit_once('/')
                    .map(|(domain, _)| domain)
                    .unwrap_or_default();
                let _ = Command::new("/bin/launchctl")
                    .args(["bootout", domain])
                    .arg(self.directory.join("probe.plist"))
                    .output();
                unloaded = shellbeam_agent::wait_for_launchd_unloaded(&self.target).is_ok();
            }
            if unloaded && shellbeam_agent::wait_for_daemon_exit(&self.directory).is_ok() {
                let _ = fs::remove_dir_all(&self.directory);
            } else {
                eprintln!(
                    "Unable to stop isolated test service {}; state retained at {}",
                    self.target,
                    self.directory.display()
                );
            }
        }
    }
    let _cleanup = Cleanup {
        target: target.clone(),
        directory: directory.clone(),
    };
    let result = Command::new("/bin/launchctl")
        .args(["bootstrap", &domain])
        .arg(&plist)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "bootstrap failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let initial = wait_sample(&directory, 0);
    assert!(initial["metrics"]["memoryTotalBytes"].as_u64().unwrap() > 0);
    assert_eq!(initial["health"], "online");
    let result = Command::new("/bin/launchctl")
        .args(["kickstart", "-k", &target])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "kickstart failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    wait_sample(&directory, initial["lastHeartbeatAt"].as_u64().unwrap());
    let started = Instant::now();
    while shellbeam_agent::history(&directory, 100)
        .unwrap()
        .as_array()
        .unwrap()
        .len()
        < 2
    {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "restart did not retain the prior committed sample"
        );
        thread::sleep(Duration::from_millis(50));
    }
    let result = Command::new("/bin/launchctl")
        .args(["bootout", &target])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "bootout failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    // Exercise the same bounded absence verification used by production
    // service stop/uninstall, including launchd's asynchronous bootout period.
    shellbeam_agent::wait_for_launchd_unloaded(&target).unwrap();
    shellbeam_agent::wait_for_daemon_exit(&directory).unwrap();
}
