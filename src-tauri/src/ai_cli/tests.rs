use super::*;
fn request() -> Request {
    Request {
        request_id: uuid::Uuid::new_v4().to_string(),
        backend: Backend::CodexCli,
        executable: String::new(),
        model: String::new(),
        prompt: "find large files".into(),
        context: "remote Linux".into(),
        history: Vec::new(),
        host: String::new(),
        mode: RunMode::Confirm,
    }
}
#[test]
fn request_limits_and_registry_do_not_overwrite_or_expand_concurrency() {
    let state = AiCliState::default();
    let first = request();
    let a = state.register(&first.request_id).unwrap();
    assert!(state.register(&first.request_id).is_err());
    state.register(&request().request_id).unwrap();
    assert!(state.register(&request().request_id).is_err());
    state.cancel_all();
    assert!(a.load(Ordering::Acquire));
    let mut r = request();
    r.model = "  --yolo".into();
    assert!(validate_request(&r).is_err());
    r.model.clear();
    r.context = "x".repeat(65 * 1024);
    assert!(validate_request(&r).is_err());
    assert!(resolve_executable(Backend::CodexCli, "relative/path").is_err());
}
#[test]
fn history_is_bounded_and_rejects_unknown_roles() {
    let item = |role, content: &str| HistoryItem { role, content: content.into() };
    let mut r = request();
    r.history = vec![item(HistoryRole::User, "df -h"), item(HistoryRole::Output, "/dev/sda1 98%")];
    assert!(validate_request(&r).is_ok());
    r.history = (0..=MAX_HISTORY_ITEMS).map(|_| item(HistoryRole::User, "x")).collect();
    assert!(validate_request(&r).is_err());
    r.history = vec![item(HistoryRole::Output, &"x".repeat(MAX_HISTORY_BYTES + 1))];
    assert!(validate_request(&r).is_err());
    r.history = vec![item(HistoryRole::Assistant, "a\0b")];
    assert!(validate_request(&r).is_err());
    r.history.clear();
    r.host = "x".repeat(2049);
    assert!(validate_request(&r).is_err());
    assert!(serde_json::from_str::<HistoryItem>(r#"{"role":"system","content":"x"}"#).is_err());
    assert!(serde_json::from_str::<HistoryItem>(r#"{"role":"user","content":"x","extra":1}"#).is_err());
}
#[test]
fn claude_partial_and_final_messages_emit_text_once() {
    let mut p = Parser::new(Backend::ClaudeCode);
    assert!(p
        .line(r#"{"type":"system","subtype":"init","model":"claude-sonnet-4-6","sensitive":"never forward"}"#)
        .unwrap()
        .is_none());
    assert_eq!(p.model.take().as_deref(), Some("claude-sonnet-4-6"));
    p.line(r#"{"type":"system","subtype":"status","model":"other"}"#).unwrap();
    assert!(p.model.is_none());
    assert_eq!(p.line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ls "}}}"#).unwrap(), Some("ls ".into()));
    assert_eq!(
        p.line(r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"-la"}}}"#)
            .unwrap(),
        Some("-la".into())
    );
    assert!(p
        .line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ls -la"}]}}"#)
        .unwrap()
        .is_none());
    assert!(p
        .line(r#"{"type":"result","subtype":"success","is_error":false,"result":"ls -la"}"#)
        .unwrap()
        .is_none());
    assert!(p.done);
    assert_eq!(p.text, "ls -la");
}
#[test]
fn parsers_reject_tools_errors_incomplete_and_disagreeing_results() {
    for (backend, input, expected) in [
        (
            Backend::ClaudeCode,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
            "tool_use",
        ),
        (
            Backend::ClaudeCode,
            r#"{"type":"stream_event","event":{"content_block":{"type":"tool_use"}}}"#,
            "tool_use",
        ),
        (
            Backend::CodexCli,
            r#"{"type":"item.started","item":{"type":"command_execution"}}"#,
            "tool_use",
        ),
        (
            Backend::CodexCli,
            r#"{"type":"item.completed","item":{"type":"file_change"}}"#,
            "tool_use",
        ),
        (
            Backend::CodexCli,
            r#"{"type":"turn.failed","error":{"message":"secret"}}"#,
            "failed",
        ),
        (
            Backend::ClaudeCode,
            r#"{"type":"result","is_error":true,"result":"secret"}"#,
            "failed",
        ),
    ] {
        let mut p = Parser::new(backend);
        assert_eq!(p.line(input).unwrap_err(), expected);
        assert!(p.text.is_empty());
    }
    let mut p = Parser::new(Backend::ClaudeCode);
    p.append("rm ").unwrap();
    assert!(!p.done);
    assert_eq!(
        p.line(r#"{"type":"result","is_error":false,"subtype":"success","result":"ls"}"#)
            .unwrap_err(),
        "invalid_output"
    );
    assert!(p.append(&"x".repeat(MAX_OUTPUT)).is_err());
}
#[test]
fn codex_only_final_message_is_a_candidate() {
    let mut p = Parser::new(Backend::CodexCli);
    for input in [
        r#"{"type":"thread.started","thread_id":"ignored"}"#,
        r#"{"type":"item.completed","item":{"type":"error","message":"configuration warning not a command"}}"#,
        r#"{"type":"item.completed","item":{"type":"agent_message","phase":"commentary","text":"Planning..."}}"#,
        r#"{"type":"item.completed","item":{"type":"reasoning","text":"not shown"}}"#,
    ] {
        assert!(p.line(input).unwrap().is_none());
    }
    assert_eq!(
        p.line(r#"{"type":"item.completed","item":{"type":"agent_message","text":"pwd"}}"#)
            .unwrap(),
        Some("pwd".into())
    );
    assert!(!p.done);
    p.line(r#"{"type":"turn.completed","usage":{}}"#).unwrap();
    assert!(p.done);
}
#[test]
fn generation_arguments_never_include_user_input_and_keep_isolation() {
    let args = cli_args(Backend::ClaudeCode, "model with spaces");
    assert!(args.windows(2).any(|a| a == ["--tools", ""]));
    assert!(args.contains(&"--safe-mode".into()));
    assert!(!args.contains(&"--bare".into()));
    assert!(args
        .windows(2)
        .any(|a| a == ["--model", "model with spaces"]));
    let args = cli_args(Backend::CodexCli, "");
    for required in [
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "features.shell_tool=false",
        "features.hooks=false",
        "features.plugins=false",
        "features.shell_snapshot=false",
        "mcp_servers={}",
    ] {
        assert!(args.contains(&required.into()));
    }
    assert!(args.windows(2).any(|a| a == ["--sandbox", "read-only"]));
    assert_eq!(args.last().unwrap(), "-");
}
#[cfg(unix)]
fn fixture() -> (Scratch, PathBuf) {
    let dir = Scratch::create().unwrap();
    let path = dir.0.join("fake cli");
    // Keep the executable bytes immutable. Parallel process creation can
    // briefly inherit a newly written script's descriptor on Linux (ETXTBSY).
    // The private symlink still exercises an executable path with spaces.
    std::os::unix::fs::symlink(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ai-cli.sh"),
        &path,
    )
    .unwrap();
    (dir, path)
}
#[cfg(unix)]
#[test]
fn real_child_uses_stdin_without_shell_interpolation_or_stderr_leak() {
    let (dir, path) = fixture();
    let mut result = String::new();
    let input = b"$(touch should-not-exist)\n";
    run_process(
        &path,
        &["echo-stdin".into()],
        &dir.0,
        Some(input.to_vec()),
        &AtomicBool::new(false),
        Duration::from_secs(2),
        |l| {
            result.push_str(l);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(result.as_bytes(), input);
    assert!(!dir.0.join("should-not-exist").exists());
}
#[cfg(unix)]
#[test]
fn cancellation_and_timeout_kill_the_entire_process_group() {
    for cancel_request in [true, false] {
        let (dir, path) = fixture();
        let cancel = Arc::new(AtomicBool::new(false));
        if cancel_request {
            let cancel = cancel.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                cancel.store(true, Ordering::Release);
            });
        }
        let result = run_process(
            &path,
            &["descendants".into()],
            &dir.0,
            None,
            &cancel,
            Duration::from_millis(200),
            |_| Ok(()),
        );
        assert_eq!(
            result.unwrap_err(),
            if cancel_request {
                "cancelled"
            } else {
                "timeout"
            }
        );
        std::thread::sleep(Duration::from_millis(650));
        assert!(!dir.0.join("survived").exists());
    }
}
#[cfg(unix)]
#[test]
fn malformed_and_excessive_output_terminate_and_fail_closed() {
    let (dir, path) = fixture();
    let mut parser = Parser::new(Backend::CodexCli);
    assert_eq!(
        run_process(
            &path,
            &["malformed".into()],
            &dir.0,
            None,
            &AtomicBool::new(false),
            Duration::from_secs(2),
            |l| parser.line(l).map(|_| ())
        )
        .unwrap_err(),
        "invalid_output"
    );
    // invalid_output (rather than timeout) proves early rejection without a CPU-speed assertion.
    let (dir, path) = fixture();
    assert_eq!(
        run_process(
            &path,
            &["excessive".into()],
            &dir.0,
            None,
            &AtomicBool::new(false),
            Duration::from_secs(2),
            |_| Ok(())
        )
        .unwrap_err(),
        "invalid_output"
    );
}
#[cfg(unix)]
#[test]
fn full_native_adapter_checks_capabilities_and_parses_the_child() {
    let (dir, path) = fixture();
    let mut r = request();
    r.executable = path.to_str().unwrap().into();
    let mut events = Vec::new();
    generate(&r, &AtomicBool::new(false), |event| {
        events.push(event);
        Ok(())
    })
    .unwrap();
    assert_eq!(events.len(), 1);
    assert!(matches!(&events[0], Event::Token { text } if text == "uname -a"));
    assert!(dir.0.exists());
}

/// scripts/ai-cli-smoke.mjs supplies an isolated wrapper and loopback model server.
/// This never reads the user's CLI login, sends a real model request, or runs generated commands.
#[test]
#[ignore = "requires an installed CLI and isolated local model fixture"]
fn installed_cli_loopback_generation() {
    let mut r = request();
    r.executable =
        std::env::var("SHELLBEAM_AI_CLI_SMOKE_EXECUTABLE").expect("isolated wrapper required");
    r.backend = match std::env::var("SHELLBEAM_AI_CLI_SMOKE_BACKEND").as_deref() {
        Ok("claude-code") => Backend::ClaudeCode,
        Ok("codex-cli") => Backend::CodexCli,
        _ => panic!("explicit backend required"),
    };
    r.model = if r.backend == Backend::ClaudeCode {
        "claude-sonnet-4-6"
    } else {
        "gpt-5.4"
    }
    .into();
    let mut text = String::new();
    generate(&r, &AtomicBool::new(false), |event| {
        if let Event::Token { text: token } = event {
            text.push_str(&token);
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(text, "pwd");
}

#[test]
fn child_path_starts_with_the_cli_directory_and_keeps_install_locations() {
    let path = child_path(Path::new("/opt/tools/bin/codex")).unwrap();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    assert_eq!(dirs[0], PathBuf::from("/opt/tools/bin"));
    assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
    assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    let unique: std::collections::HashSet<_> = dirs.iter().collect();
    assert_eq!(unique.len(), dirs.len());
}

#[test]
fn only_parent_session_variables_are_dropped() {
    for name in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "USE_LOCAL_OAUTH"] {
        assert!(is_host_session_var(name), "{name}");
    }
    for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "HOME", "PATH"] {
        assert!(!is_host_session_var(name), "{name}");
    }
}
#[test]
fn run_mode_defaults_to_confirm_and_rejects_unknown_values() {
    let base = r#"{"requestId":"r","backend":"codex-cli","executable":"","model":"","prompt":"p","context":""}"#;
    assert_eq!(serde_json::from_str::<Request>(base).unwrap().mode, RunMode::Confirm);
    let auto = base.replace(r#""context":"""#, r#""context":"","mode":"read-only""#);
    assert_eq!(serde_json::from_str::<Request>(&auto).unwrap().mode, RunMode::ReadOnly);
    let bad = base.replace(r#""context":"""#, r#""context":"","mode":"yolo""#);
    assert!(serde_json::from_str::<Request>(&bad).is_err());
}
