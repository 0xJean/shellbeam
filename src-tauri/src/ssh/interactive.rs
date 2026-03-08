use serde::{Deserialize, Serialize};
use ssh2::{Channel, Session};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

use tauri::Manager;

use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::ssh::connect_and_authenticate;
use crate::storage::now_unix_ms;

fn default_cols() -> u32 { 80 }
fn default_rows() -> u32 { 24 }

#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct InteractiveSessionCreateRequest {
    host_id: Option<String>, host: String, port: u16, username: String, auth_type: String,
    password: Option<String>, private_key: Option<String>,
    #[serde(default)] passphrase: Option<String>,
    #[serde(default = "default_cols")] cols: u32,
    #[serde(default = "default_rows")] rows: u32,
    #[serde(default)] keep_alive_interval_secs: Option<u32>,
    #[serde(default)] jump_host: Option<String>,
    #[serde(default)] jump_port: Option<u16>,
    #[serde(default)] jump_user: Option<String>,
    #[serde(default)] accept_host_key: Option<bool>,
}

#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SessionInputRequest { session_id: String, input: String }
#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SessionPollRequest { session_id: String, after_seq: Option<u64> }
#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SessionCloseRequest { session_id: String }
#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SessionResizeRequest { session_id: String, cols: u32, rows: u32 }
#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct LocalTerminalRequest {
    #[serde(default = "default_cols")] cols: u32,
    #[serde(default = "default_rows")] rows: u32,
}

#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub struct InteractiveSessionInfo {
    session_id: String, host_id: Option<String>, host: String,
    username: String, created_at: i64, last_active_at: i64, status: String,
}
#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
struct InteractiveOutputChunk { seq: u64, stream: String, data: String, timestamp: i64 }
#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub struct InteractivePollResponse {
    session_id: String, status: String, next_seq: u64, chunks: Vec<InteractiveOutputChunk>,
}

enum SessionCommand { Input(Vec<u8>), Resize(u32, u32), Close }

struct SessionRecord {
    info: InteractiveSessionInfo,
    command_tx: mpsc::Sender<SessionCommand>,
    output: Arc<Mutex<Vec<InteractiveOutputChunk>>>,
    _seq_counter: Arc<AtomicU64>,
    status: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct InteractiveSessionState {
    sessions: Mutex<HashMap<String, SessionRecord>>,
}

type SharedOutput = Arc<Mutex<Vec<InteractiveOutputChunk>>>;
type SharedSeq = Arc<AtomicU64>;

const OUTPUT_BUFFER_CAP: usize = 2000;

fn push_chunk(output: &SharedOutput, seq_counter: &SharedSeq, stream: &str, data: String) {
    if let Ok(mut guard) = output.lock() {
        let seq = seq_counter.fetch_add(1, Ordering::Relaxed) + 1;
        guard.push(InteractiveOutputChunk { seq, stream: stream.to_string(), data, timestamp: now_unix_ms() });
        if guard.len() > OUTPUT_BUFFER_CAP {
            let excess = guard.len() - OUTPUT_BUFFER_CAP / 2;
            guard.drain(..excess);
        }
    }
}

fn new_shared_state() -> (SharedOutput, SharedSeq, Arc<Mutex<String>>) {
    (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicU64::new(0)), Arc::new(Mutex::new("running".to_string())))
}

fn make_info(session_id: &str, p: &InteractiveSessionCreateRequest) -> InteractiveSessionInfo {
    let now = now_unix_ms();
    InteractiveSessionInfo {
        session_id: session_id.to_string(), host_id: p.host_id.clone(),
        host: p.host.clone(), username: p.username.clone(),
        created_at: now, last_active_at: now, status: "running".to_string(),
    }
}

fn spawn_pipe_reader(mut reader: impl Read + Send + 'static, output: SharedOutput, seq: SharedSeq, stream: &'static str) {
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => push_chunk(&output, &seq, stream, String::from_utf8_lossy(&buf[..n]).to_string()),
            }
        }
    });
}

fn session_io_loop(
    session: Session, mut channel: Channel, command_rx: mpsc::Receiver<SessionCommand>,
    output: SharedOutput, seq_counter: SharedSeq, status: Arc<Mutex<String>>,
    keepalive_secs: u32,
) {
    use std::time::Instant;

    session.set_blocking(false);
    let mut buf = [0u8; 32768];
    let mut last_activity = Instant::now();
    let mut last_keepalive = Instant::now();
    let keepalive_interval = Duration::from_secs(keepalive_secs as u64);
    let dead_threshold = Duration::from_secs(keepalive_secs as u64 * 3 + 10);
    let mut consecutive_keepalive_failures: u32 = 0;
    const MAX_KEEPALIVE_FAILURES: u32 = 3;

    loop {
        let mut had_data = false;
        let mut coalesced = String::new();
        for _ in 0..16 {
            match channel.read(&mut buf) {
                Ok(0) => {
                    if !coalesced.is_empty() {
                        push_chunk(&output, &seq_counter, "stdout", coalesced);
                    }
                    if let Ok(mut s) = status.lock() { *s = format!("closed({})", channel.exit_status().unwrap_or(0)); }
                    return;
                }
                Ok(n) => {
                    coalesced.push_str(&String::from_utf8_lossy(&buf[..n]));
                    had_data = true;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => {
                    if !coalesced.is_empty() {
                        push_chunk(&output, &seq_counter, "stdout", coalesced);
                    }
                    if let Ok(mut s) = status.lock() { *s = "closed(-1)".to_string(); }
                    return;
                }
            }
        }
        if !coalesced.is_empty() {
            push_chunk(&output, &seq_counter, "stdout", coalesced);
            last_activity = Instant::now();
            consecutive_keepalive_failures = 0;
        }
        match channel.stderr().read(&mut buf) {
            Ok(n) if n > 0 => {
                push_chunk(&output, &seq_counter, "stderr", String::from_utf8_lossy(&buf[..n]).to_string());
                had_data = true;
                last_activity = Instant::now();
                consecutive_keepalive_failures = 0;
            }
            _ => {}
        }
        loop {
            match command_rx.try_recv() {
                Ok(SessionCommand::Input(data)) => {
                    session.set_blocking(true);
                    let _ = channel.write_all(&data);
                    let _ = channel.flush();
                    session.set_blocking(false);
                    last_activity = Instant::now();
                }
                Ok(SessionCommand::Resize(cols, rows)) => {
                    session.set_blocking(true);
                    let _ = channel.request_pty_size(cols, rows, None, None);
                    session.set_blocking(false);
                }
                Ok(SessionCommand::Close) => {
                    session.set_blocking(true);
                    let _ = channel.send_eof();
                    let _ = channel.close();
                    let _ = channel.wait_close();
                    if let Ok(mut s) = status.lock() { *s = format!("closed({})", channel.exit_status().unwrap_or(-1)); }
                    return;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    session.set_blocking(true);
                    let _ = channel.send_eof();
                    let _ = channel.close();
                    if let Ok(mut s) = status.lock() { *s = "closed(-1)".to_string(); }
                    return;
                }
            }
        }
        if channel.eof() {
            session.set_blocking(true);
            let _ = channel.wait_close();
            if let Ok(mut s) = status.lock() { *s = format!("closed({})", channel.exit_status().unwrap_or(0)); }
            break;
        }

        if last_keepalive.elapsed() >= keepalive_interval {
            session.set_blocking(true);
            match session.keepalive_send() {
                Ok(_) => {
                    consecutive_keepalive_failures = 0;
                    last_activity = Instant::now();
                }
                Err(_) => {
                    consecutive_keepalive_failures += 1;
                }
            }
            session.set_blocking(false);
            last_keepalive = Instant::now();
        }

        if consecutive_keepalive_failures >= MAX_KEEPALIVE_FAILURES || last_activity.elapsed() > dead_threshold {
            push_chunk(&output, &seq_counter, "stderr",
                "\r\n\x1b[1;31mConnection lost (keepalive timeout)\x1b[0m\r\n".to_string());
            if let Ok(mut s) = status.lock() { *s = "closed(timeout)".to_string(); }
            break;
        }

        if !had_data { thread::sleep(Duration::from_millis(10)); }
    }
}

fn create_via_system_ssh(
    app: &tauri::AppHandle, payload: &InteractiveSessionCreateRequest, session_id: &str,
) -> Result<SessionRecord, String> {
    use std::fs;
    use std::process::{Command, Stdio};
    use crate::storage::data_file_path;

    let private_key = payload.private_key.as_deref().ok_or_else(||
        standard_error_payload("validation_error", "interactive", false, "Jump host requires privateKey auth", None))?;

    let key_path = data_file_path(app, &format!("interactive-{session_id}.key"))
        .map_err(|e| standard_error_from_raw("interactive", "create session", e))?;
    fs::write(&key_path, private_key).map_err(|e| standard_error_from_raw("interactive", "write key", e.to_string()))?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600)); }

    let mut cmd = Command::new("ssh");
    cmd.arg("-tt").arg("-p").arg(payload.port.to_string())
       .arg("-i").arg(&key_path)
       .arg("-o").arg("StrictHostKeyChecking=no")
       .arg("-o").arg("UserKnownHostsFile=/dev/null")
       .arg("-o").arg(format!("ServerAliveInterval={}", payload.keep_alive_interval_secs.unwrap_or(30)));
    if let Some(ref jh) = payload.jump_host {
        if !jh.trim().is_empty() {
            let ju = payload.jump_user.as_deref().unwrap_or(&payload.username);
            cmd.arg("-J").arg(format!("{ju}@{jh}:{}", payload.jump_port.unwrap_or(22)));
        }
    }
    cmd.arg(format!("{}@{}", payload.username, payload.host))
       .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        let _ = fs::remove_file(&key_path);
        standard_error_from_raw("interactive", "spawn ssh", format!("Spawn failed: {e}"))
    })?;

    let mut stdin = child.stdin.take().ok_or_else(|| standard_error_payload("io_error", "interactive", true, "No stdin", None))?;
    let stdout = child.stdout.take().ok_or_else(|| standard_error_payload("io_error", "interactive", true, "No stdout", None))?;
    let stderr = child.stderr.take().ok_or_else(|| standard_error_payload("io_error", "interactive", true, "No stderr", None))?;

    let (output, seq_counter, status) = new_shared_state();
    spawn_pipe_reader(stdout, output.clone(), seq_counter.clone(), "stdout");
    spawn_pipe_reader(stderr, output.clone(), seq_counter.clone(), "stderr");

    let (command_tx, command_rx) = mpsc::channel::<SessionCommand>();
    let status_clone = status.clone();
    let kp = key_path.clone();
    thread::spawn(move || {
        for cmd in command_rx {
            match cmd {
                SessionCommand::Input(data) => { let _ = stdin.write_all(&data); let _ = stdin.flush(); }
                SessionCommand::Resize(_, _) => {}
                SessionCommand::Close => { let _ = child.kill(); let _ = child.wait(); break; }
            }
        }
        let _ = fs::remove_file(&kp);
        if let Ok(mut s) = status_clone.lock() { if s.starts_with("running") { *s = "closed(-1)".to_string(); } }
    });

    Ok(SessionRecord { info: make_info(session_id, payload), command_tx, output, _seq_counter: seq_counter, status })
}

#[tauri::command]
pub async fn create_interactive_session(
    app: tauri::AppHandle,
    payload: InteractiveSessionCreateRequest,
) -> Result<InteractiveSessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<InteractiveSessionState>();
        let session_id = Uuid::new_v4().to_string();
        let has_jump = payload.jump_host.as_ref().map_or(false, |jh| !jh.trim().is_empty());

        let record = if has_jump {
            create_via_system_ssh(&app, &payload, &session_id)?
        } else {
            let session = connect_and_authenticate(
                &payload.host, payload.port, &payload.username, &payload.auth_type,
                payload.password.as_deref(), payload.private_key.as_deref(),
                payload.passphrase.as_deref(), Some(&app), payload.accept_host_key.unwrap_or(true),
            ).map_err(|err| {
                if err.contains("host_key_unknown") || err.contains("host_key_mismatch") { err }
                else { standard_error_from_raw("interactive", "connect", err) }
            })?;

            session.set_keepalive(true, payload.keep_alive_interval_secs.unwrap_or(30));

            let mut channel = session.channel_session().map_err(|e| standard_error_from_raw("interactive", "open channel", e.to_string()))?;
            channel.request_pty("xterm-256color", None, Some((payload.cols, payload.rows, 0, 0)))
                .map_err(|e| standard_error_from_raw("interactive", "request PTY", e.to_string()))?;
            channel.shell().map_err(|e| standard_error_from_raw("interactive", "start shell", e.to_string()))?;

            let keepalive_secs = payload.keep_alive_interval_secs.unwrap_or(30);
            let (command_tx, command_rx) = mpsc::channel::<SessionCommand>();
            let (output, seq_counter, status) = new_shared_state();
            let (o, s2, st) = (output.clone(), seq_counter.clone(), status.clone());
            thread::spawn(move || session_io_loop(session, channel, command_rx, o, s2, st, keepalive_secs));

            SessionRecord { info: make_info(&session_id, &payload), command_tx, output, _seq_counter: seq_counter, status }
        };

        let info = record.info.clone();
        state.sessions.lock().map_err(|_| standard_error_from_raw("interactive", "create", "Lock poisoned"))?
            .insert(session_id, record);
        Ok(info)
    }).await.map_err(|e| format!("Task panicked: {e}"))?
}

fn get_record<'a>(sessions: &'a HashMap<String, SessionRecord>, id: &str) -> Result<&'a SessionRecord, String> {
    sessions.get(id).ok_or_else(|| standard_error_payload("not_found", "interactive", false, "Session not found", None))
}

#[tauri::command]
pub fn send_interactive_input(state: tauri::State<'_, InteractiveSessionState>, payload: SessionInputRequest) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| standard_error_from_raw("interactive", "send", "Lock poisoned"))?;
    get_record(&sessions, &payload.session_id)?.command_tx.send(SessionCommand::Input(payload.input.into_bytes()))
        .map_err(|e| standard_error_from_raw("interactive", "send", e.to_string()))
}

#[tauri::command]
pub fn resize_interactive_terminal(state: tauri::State<'_, InteractiveSessionState>, payload: SessionResizeRequest) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| standard_error_from_raw("interactive", "resize", "Lock poisoned"))?;
    get_record(&sessions, &payload.session_id)?.command_tx.send(SessionCommand::Resize(payload.cols, payload.rows))
        .map_err(|e| standard_error_from_raw("interactive", "resize", e.to_string()))
}

#[tauri::command]
pub fn poll_interactive_output(state: tauri::State<'_, InteractiveSessionState>, payload: SessionPollRequest) -> Result<InteractivePollResponse, String> {
    let sessions = state.sessions.lock().map_err(|_| standard_error_from_raw("interactive", "poll", "Lock poisoned"))?;
    let record = get_record(&sessions, &payload.session_id)?;
    let current_status = record.status.lock().map(|s| s.clone()).unwrap_or_else(|_| "unknown".to_string());
    let after_seq = payload.after_seq.unwrap_or(0);
    let mut output = record.output.lock().map_err(|_| standard_error_from_raw("interactive", "poll", "Output lock poisoned"))?;
    if after_seq > 0 {
        let drain_up_to = output.partition_point(|c| c.seq <= after_seq);
        if drain_up_to > 0 { output.drain(..drain_up_to); }
    }
    let chunks: Vec<InteractiveOutputChunk> = std::mem::take(&mut *output);
    let next_seq = chunks.last().map(|c| c.seq).unwrap_or(after_seq);
    Ok(InteractivePollResponse { session_id: payload.session_id, status: current_status, next_seq, chunks })
}

#[tauri::command]
pub fn list_interactive_sessions(state: tauri::State<'_, InteractiveSessionState>) -> Result<Vec<InteractiveSessionInfo>, String> {
    let sessions = state.sessions.lock().map_err(|_| standard_error_from_raw("interactive", "list", "Lock poisoned"))?;
    Ok(sessions.values().map(|r| {
        let mut info = r.info.clone();
        if let Ok(s) = r.status.lock() { info.status = s.clone(); }
        info
    }).collect())
}

#[tauri::command]
pub fn close_interactive_session(state: tauri::State<'_, InteractiveSessionState>, payload: SessionCloseRequest) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| standard_error_from_raw("interactive", "close", "Lock poisoned"))?;
    let record = sessions.remove(&payload.session_id).ok_or_else(||
        standard_error_payload("not_found", "interactive", false, "Session not found", None))?;
    let _ = record.command_tx.send(SessionCommand::Close);
    Ok(())
}

#[cfg(unix)]
fn open_local_pty(shell: &str, cols: u32, rows: u32) -> Result<(std::fs::File, std::fs::File, i32), String> {
    use std::os::unix::process::CommandExt;
    use std::os::fd::FromRawFd;
    use std::process::{Command, Stdio};

    let mut master_fd: libc::c_int = 0;
    let mut slave_fd: libc::c_int = 0;
    let mut ws = libc::winsize { ws_row: rows as u16, ws_col: cols as u16, ws_xpixel: 0, ws_ypixel: 0 };

    if unsafe { libc::openpty(&mut master_fd, &mut slave_fd, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) } != 0 {
        return Err(standard_error_from_raw("interactive", "openpty", "Failed to allocate PTY"));
    }

    let slave_copy = slave_fd;
    let master_copy = master_fd;
    let mut cmd = Command::new(shell);
    cmd.arg("-l").env("TERM", "xterm-256color");
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(move || {
            libc::setsid();
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            libc::ioctl(slave_copy, libc::TIOCSCTTY as libc::c_ulong, 0);
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            libc::ioctl(slave_copy, libc::TIOCSCTTY as libc::c_int, 0);
            libc::dup2(slave_copy, 0);
            libc::dup2(slave_copy, 1);
            libc::dup2(slave_copy, 2);
            if slave_copy > 2 { libc::close(slave_copy); }
            libc::close(master_copy);
            Ok(())
        });
    }

    let child = cmd.spawn().map_err(|e| {
        unsafe { libc::close(master_fd); libc::close(slave_fd); }
        standard_error_from_raw("interactive", "spawn shell", format!("{e}"))
    })?;
    let pid = child.id() as i32;
    unsafe { libc::close(slave_fd); }

    let master = unsafe { std::fs::File::from_raw_fd(master_fd) };
    let master_writer = master.try_clone().map_err(|e| standard_error_from_raw("interactive", "dup master", format!("{e}")))?;

    // Reap child process to avoid zombies and update status would be handled by caller
    thread::spawn(move || { let mut c = child; let _ = c.wait(); });
    Ok((master, master_writer, pid))
}

#[tauri::command]
pub fn create_local_terminal(
    state: tauri::State<'_, InteractiveSessionState>,
    payload: LocalTerminalRequest,
) -> Result<InteractiveSessionInfo, String> {
    let session_id = Uuid::new_v4().to_string();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") { "/bin/zsh".to_string() } else { "/bin/bash".to_string() }
    });
    let username = std::env::var("USER").unwrap_or_else(|_| "local".to_string());

    #[cfg(unix)]
    let (reader, writer, child_pid) = open_local_pty(&shell, payload.cols, payload.rows)?;
    #[cfg(not(unix))]
    return Err(standard_error_from_raw("interactive", "local terminal", "Not supported on this platform"));

    let (output, seq_counter, status) = new_shared_state();
    spawn_pipe_reader(reader, output.clone(), seq_counter.clone(), "stdout");

    let (command_tx, command_rx) = mpsc::channel::<SessionCommand>();
    let status_clone = status.clone();

    #[cfg(unix)]
    thread::spawn(move || {
        use std::os::fd::AsRawFd;
        let mut writer = writer;
        let fd = writer.as_raw_fd();
        for cmd in command_rx {
            match cmd {
                SessionCommand::Input(data) => { let _ = writer.write_all(&data); let _ = writer.flush(); }
                SessionCommand::Resize(cols, rows) => {
                    let ws = libc::winsize { ws_row: rows as u16, ws_col: cols as u16, ws_xpixel: 0, ws_ypixel: 0 };
                    #[cfg(any(target_os = "macos", target_os = "ios"))]
                    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ as libc::c_ulong, &ws); }
                    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
                    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ as libc::c_int, &ws); }
                }
                SessionCommand::Close => {
                    unsafe { libc::kill(child_pid, libc::SIGHUP); }
                    break;
                }
            }
        }
        if let Ok(mut s) = status_clone.lock() { if s.starts_with("running") { *s = "closed(0)".to_string(); } }
    });

    let now = now_unix_ms();
    let info = InteractiveSessionInfo {
        session_id: session_id.clone(), host_id: None, host: "local".to_string(),
        username, created_at: now, last_active_at: now, status: "running".to_string(),
    };
    let record = SessionRecord { info: info.clone(), command_tx, output, _seq_counter: seq_counter, status };
    state.sessions.lock().map_err(|_| standard_error_from_raw("interactive", "create", "Lock poisoned"))?
        .insert(session_id, record);
    Ok(info)
}
