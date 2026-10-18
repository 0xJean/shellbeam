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

use tauri::{Emitter, Manager};

use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::storage::now_unix_ms;

fn default_cols() -> u32 {
    80
}
fn default_rows() -> u32 {
    24
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveSessionCreateRequest {
    host_id: Option<String>,
    vault_id: Option<String>,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
    #[serde(default = "default_cols")]
    cols: u32,
    #[serde(default = "default_rows")]
    rows: u32,
    #[serde(default)]
    keep_alive_interval_secs: Option<u32>,
    #[serde(default)]
    jump_host: Option<String>,
    #[serde(default)]
    jump_port: Option<u16>,
    #[serde(default)]
    jump_user: Option<String>,
    #[serde(default)]
    accepted_host_key: Option<crate::ssh::transport::HostKeyAcceptance>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInputRequest {
    session_id: String,
    input: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPollRequest {
    session_id: String,
    after_seq: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseRequest {
    session_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResizeRequest {
    session_id: String,
    cols: u32,
    rows: u32,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalRequest {
    #[serde(default = "default_cols")]
    cols: u32,
    #[serde(default = "default_rows")]
    rows: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveSessionInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_id: Option<String>,
    session_id: String,
    host_id: Option<String>,
    host: String,
    username: String,
    created_at: i64,
    last_active_at: i64,
    status: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InteractiveOutputChunk {
    seq: u64,
    stream: String,
    data: String,
    timestamp: i64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractivePollResponse {
    session_id: String,
    status: String,
    next_seq: u64,
    chunks: Vec<InteractiveOutputChunk>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveOutputEvent {
    session_id: String,
    chunks: Vec<InteractiveOutputChunk>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveStatusEvent {
    session_id: String,
    status: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveProgressEvent {
    session_id: String,
    stage: String,
}

enum SessionCommand {
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct SessionRecord {
    vault_id: Option<String>,
    verified_host_keys: Vec<crate::ssh::transport::VerifiedHostKey>,
    info: InteractiveSessionInfo,
    command_tx: mpsc::Sender<SessionCommand>,
    output: Arc<Mutex<Vec<InteractiveOutputChunk>>>,
    _seq_counter: Arc<AtomicU64>,
    status: Arc<Mutex<String>>,
    reusable_transport: Option<Session>,
    _tunnel: Option<Arc<crate::ssh::transport::TunnelLease>>,
}

#[derive(Default)]
pub struct InteractiveSessionState {
    sessions: Mutex<HashMap<String, SessionRecord>>,
}

impl InteractiveSessionState {
    pub fn clone_verified_connection(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
    ) -> Result<Option<crate::ssh::transport::Connection>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "SESSION_STATE_UNAVAILABLE")?;
        let Some(record) = sessions.get(session_id) else {
            return Ok(None);
        };
        crate::ssh::transport::ensure_vault_unlocked(app, record.vault_id.as_deref())?;
        if record
            .status
            .lock()
            .map_err(|_| "SESSION_STATE_UNAVAILABLE")?
            .as_str()
            != "running"
        {
            return Ok(None);
        }
        Ok(record
            .reusable_transport
            .clone()
            .map(|session| crate::ssh::transport::Connection {
                verified_host_keys: record.verified_host_keys.clone(),
                session,
                tunnel: record._tunnel.clone(),
            }))
    }
}

type SharedOutput = Arc<Mutex<Vec<InteractiveOutputChunk>>>;
type SharedSeq = Arc<AtomicU64>;

const OUTPUT_BUFFER_CAP: usize = 2000;
const OUTPUT_BUFFER_MAX_BYTES: usize = 8 * 1024 * 1024;
const OUTPUT_BUFFER_TRIM_TO_BYTES: usize = 4 * 1024 * 1024;
const INTERACTIVE_OUTPUT_EVENT: &str = "shellbeam://interactive-output";
const INTERACTIVE_STATUS_EVENT: &str = "shellbeam://interactive-status";
const INTERACTIVE_PROGRESS_EVENT: &str = "shellbeam://interactive-progress";

fn emit_output(app: &tauri::AppHandle, session_id: &str, chunk: InteractiveOutputChunk) {
    let _ = app.emit(
        INTERACTIVE_OUTPUT_EVENT,
        InteractiveOutputEvent {
            session_id: session_id.to_string(),
            chunks: vec![chunk],
        },
    );
}

fn emit_progress(app: &tauri::AppHandle, session_id: &str, stage: &str) {
    let _ = app.emit(
        INTERACTIVE_PROGRESS_EVENT,
        InteractiveProgressEvent {
            session_id: session_id.to_string(),
            stage: stage.to_string(),
        },
    );
}

fn set_status(app: &tauri::AppHandle, session_id: &str, status: &Arc<Mutex<String>>, next: String) {
    let changed = match status.lock() {
        Ok(mut guard) => {
            if *guard == next {
                false
            } else {
                *guard = next.clone();
                true
            }
        }
        Err(_) => true,
    };
    if changed {
        let _ = app.emit(
            INTERACTIVE_STATUS_EVENT,
            InteractiveStatusEvent {
                session_id: session_id.to_string(),
                status: next,
            },
        );
    }
}

fn push_chunk(
    app: &tauri::AppHandle,
    session_id: &str,
    output: &SharedOutput,
    seq_counter: &SharedSeq,
    stream: &str,
    data: String,
) {
    let chunk = InteractiveOutputChunk {
        seq: seq_counter.fetch_add(1, Ordering::Relaxed) + 1,
        stream: stream.to_string(),
        data,
        timestamp: now_unix_ms(),
    };
    if let Ok(mut guard) = output.lock() {
        guard.push(chunk.clone());
        if guard.len() > OUTPUT_BUFFER_CAP {
            let excess = guard.len() - OUTPUT_BUFFER_CAP / 2;
            guard.drain(..excess);
        }
        let mut total_bytes = guard.iter().map(|item| item.data.len()).sum::<usize>();
        if total_bytes > OUTPUT_BUFFER_MAX_BYTES {
            let mut drain_up_to = 0usize;
            for item in guard.iter() {
                if total_bytes <= OUTPUT_BUFFER_TRIM_TO_BYTES {
                    break;
                }
                total_bytes = total_bytes.saturating_sub(item.data.len());
                drain_up_to += 1;
            }
            let drain_count = drain_up_to.min(guard.len().saturating_sub(1));
            if drain_count > 0 {
                guard.drain(..drain_count);
            }
        }
    }
    emit_output(app, session_id, chunk);
}

fn new_shared_state() -> (SharedOutput, SharedSeq, Arc<Mutex<String>>) {
    (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(AtomicU64::new(0)),
        Arc::new(Mutex::new("running".to_string())),
    )
}

fn make_info(session_id: &str, p: &InteractiveSessionCreateRequest) -> InteractiveSessionInfo {
    let now = now_unix_ms();
    InteractiveSessionInfo {
        vault_id: p.vault_id.clone(),
        session_id: session_id.to_string(),
        host_id: p.host_id.clone(),
        host: p.host.clone(),
        username: p.username.clone(),
        created_at: now,
        last_active_at: now,
        status: "running".to_string(),
    }
}

fn spawn_pipe_reader(
    app: tauri::AppHandle,
    session_id: String,
    mut reader: impl Read + Send + 'static,
    output: SharedOutput,
    seq: SharedSeq,
    stream: &'static str,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => push_chunk(
                    &app,
                    &session_id,
                    &output,
                    &seq,
                    stream,
                    String::from_utf8_lossy(&buf[..n]).to_string(),
                ),
            }
        }
    });
}

fn retry_ssh2<T, F>(mut operation: F) -> Result<T, ()>
where
    F: FnMut() -> Result<T, ssh2::Error>,
{
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let io_error: std::io::Error = error.into();
                if io_error.kind() == std::io::ErrorKind::WouldBlock {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
                return Err(());
            }
        }
    }
}

fn write_channel_nonblocking(channel: &mut Channel, data: &[u8]) -> bool {
    let mut offset = 0;
    while offset < data.len() {
        match channel.write(&data[offset..]) {
            Ok(0) => return false,
            Ok(written) => offset += written,
            Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(_) => return false,
        }
    }
    match channel.flush() {
        Ok(_) => true,
        Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => true,
        Err(_) => false,
    }
}

fn resize_channel_nonblocking(channel: &mut Channel, cols: u32, rows: u32) -> bool {
    retry_ssh2(|| channel.request_pty_size(cols, rows, None, None)).is_ok()
}

fn close_channel_nonblocking(channel: &mut Channel) -> i32 {
    let _ = retry_ssh2(|| channel.send_eof());
    let _ = retry_ssh2(|| channel.close());
    let _ = retry_ssh2(|| channel.wait_close());
    channel.exit_status().unwrap_or(-1)
}

fn session_io_loop(
    app: tauri::AppHandle,
    session_id: String,
    session: Session,
    mut channel: Channel,
    command_rx: mpsc::Receiver<SessionCommand>,
    output: SharedOutput,
    seq_counter: SharedSeq,
    status: Arc<Mutex<String>>,
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
        loop {
            match command_rx.try_recv() {
                Ok(SessionCommand::Input(data)) => {
                    if !write_channel_nonblocking(&mut channel, &data) {
                        set_status(&app, &session_id, &status, "closed(-1)".to_string());
                        return;
                    }
                    last_activity = Instant::now();
                }
                Ok(SessionCommand::Resize(cols, rows)) => {
                    if !resize_channel_nonblocking(&mut channel, cols, rows) {
                        set_status(&app, &session_id, &status, "closed(-1)".to_string());
                        return;
                    }
                }
                Ok(SessionCommand::Close) => {
                    set_status(
                        &app,
                        &session_id,
                        &status,
                        format!("closed({})", close_channel_nonblocking(&mut channel)),
                    );
                    return;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = close_channel_nonblocking(&mut channel);
                    set_status(&app, &session_id, &status, "closed(-1)".to_string());
                    return;
                }
            }
        }
        let mut coalesced = String::new();
        for _ in 0..16 {
            match channel.read(&mut buf) {
                Ok(0) => {
                    if !coalesced.is_empty() {
                        push_chunk(
                            &app,
                            &session_id,
                            &output,
                            &seq_counter,
                            "stdout",
                            coalesced,
                        );
                    }
                    set_status(
                        &app,
                        &session_id,
                        &status,
                        format!("closed({})", channel.exit_status().unwrap_or(0)),
                    );
                    return;
                }
                Ok(n) => {
                    coalesced.push_str(&String::from_utf8_lossy(&buf[..n]));
                    had_data = true;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => {
                    if !coalesced.is_empty() {
                        push_chunk(
                            &app,
                            &session_id,
                            &output,
                            &seq_counter,
                            "stdout",
                            coalesced,
                        );
                    }
                    set_status(&app, &session_id, &status, "closed(-1)".to_string());
                    return;
                }
            }
        }
        if !coalesced.is_empty() {
            push_chunk(
                &app,
                &session_id,
                &output,
                &seq_counter,
                "stdout",
                coalesced,
            );
            last_activity = Instant::now();
            consecutive_keepalive_failures = 0;
        }
        match channel.stderr().read(&mut buf) {
            Ok(n) if n > 0 => {
                push_chunk(
                    &app,
                    &session_id,
                    &output,
                    &seq_counter,
                    "stderr",
                    String::from_utf8_lossy(&buf[..n]).to_string(),
                );
                had_data = true;
                last_activity = Instant::now();
                consecutive_keepalive_failures = 0;
            }
            _ => {}
        }
        loop {
            match command_rx.try_recv() {
                Ok(SessionCommand::Input(data)) => {
                    if !write_channel_nonblocking(&mut channel, &data) {
                        set_status(&app, &session_id, &status, "closed(-1)".to_string());
                        return;
                    }
                    last_activity = Instant::now();
                }
                Ok(SessionCommand::Resize(cols, rows)) => {
                    if !resize_channel_nonblocking(&mut channel, cols, rows) {
                        set_status(&app, &session_id, &status, "closed(-1)".to_string());
                        return;
                    }
                }
                Ok(SessionCommand::Close) => {
                    set_status(
                        &app,
                        &session_id,
                        &status,
                        format!("closed({})", close_channel_nonblocking(&mut channel)),
                    );
                    return;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = close_channel_nonblocking(&mut channel);
                    set_status(&app, &session_id, &status, "closed(-1)".to_string());
                    return;
                }
            }
        }
        if channel.eof() {
            set_status(
                &app,
                &session_id,
                &status,
                format!("closed({})", close_channel_nonblocking(&mut channel)),
            );
            break;
        }

        if last_keepalive.elapsed() >= keepalive_interval {
            match retry_ssh2(|| session.keepalive_send()) {
                Ok(_) => {
                    consecutive_keepalive_failures = 0;
                    last_activity = Instant::now();
                }
                Err(()) => {
                    consecutive_keepalive_failures += 1;
                }
            }
            last_keepalive = Instant::now();
        }

        if consecutive_keepalive_failures >= MAX_KEEPALIVE_FAILURES
            || last_activity.elapsed() > dead_threshold
        {
            push_chunk(
                &app,
                &session_id,
                &output,
                &seq_counter,
                "stderr",
                "\r\n\x1b[1;31mConnection lost (keepalive timeout)\x1b[0m\r\n".to_string(),
            );
            set_status(&app, &session_id, &status, "closed(timeout)".to_string());
            break;
        }

        if !had_data {
            thread::sleep(Duration::from_millis(1));
        }
    }
}

#[tauri::command]
pub async fn create_interactive_session(
    app: tauri::AppHandle,
    payload: InteractiveSessionCreateRequest,
) -> Result<InteractiveSessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<InteractiveSessionState>();
        let session_id = Uuid::new_v4().to_string();
        let record = {
            emit_progress(&app, &session_id, "resolve_host");
            let route = if let (Some(host_id), Some(vault_id)) =
                (payload.host_id.as_deref(), payload.vault_id.as_deref())
            {
                crate::ssh::transport::resolve_host_route(&app, vault_id, host_id)?
            } else {
                crate::ssh::transport::legacy_route(
                    &payload.host,
                    payload.port,
                    &payload.username,
                    &payload.auth_type,
                    payload.password.as_deref(),
                    payload.private_key.as_deref(),
                    payload.passphrase.as_deref(),
                    payload.jump_host.as_deref(),
                    payload.jump_port,
                    payload.jump_user.as_deref(),
                )
            };
            emit_progress(&app, &session_id, "secure_session");
            let connection = crate::ssh::transport::connect_accepting_fingerprint(
                &app,
                &route,
                payload.accepted_host_key.as_ref(),
            )?;
            crate::ssh::transport::ensure_vault_unlocked(&app, payload.vault_id.as_deref())?;
            let verified_host_keys = connection.verified_host_keys;
            let session = connection.session;
            let tunnel = connection.tunnel;
            session.set_keepalive(true, payload.keep_alive_interval_secs.unwrap_or(30));

            emit_progress(&app, &session_id, "prepare_workspace");
            let mut channel = session.channel_session().map_err(|e| {
                standard_error_from_raw("interactive", "open channel", e.to_string())
            })?;
            channel
                .request_pty(
                    "xterm-256color",
                    None,
                    Some((payload.cols, payload.rows, 0, 0)),
                )
                .map_err(|e| {
                    standard_error_from_raw("interactive", "request PTY", e.to_string())
                })?;
            channel.shell().map_err(|e| {
                standard_error_from_raw("interactive", "start shell", e.to_string())
            })?;

            let reusable_transport = session.clone();
            let keepalive_secs = payload.keep_alive_interval_secs.unwrap_or(30);
            let (command_tx, command_rx) = mpsc::channel::<SessionCommand>();
            let (output, seq_counter, status) = new_shared_state();
            let (o, s2, st) = (output.clone(), seq_counter.clone(), status.clone());
            let app_handle = app.clone();
            let session_id_owned = session_id.clone();
            let thread_tunnel = tunnel.clone();
            thread::spawn(move || {
                let _tunnel_lease = thread_tunnel;
                session_io_loop(
                    app_handle,
                    session_id_owned,
                    session,
                    channel,
                    command_rx,
                    o,
                    s2,
                    st,
                    keepalive_secs,
                )
            });

            SessionRecord {
                vault_id: payload.vault_id.clone(),
                verified_host_keys,
                info: make_info(&session_id, &payload),
                command_tx,
                output,
                _seq_counter: seq_counter,
                status,
                reusable_transport: Some(reusable_transport),
                _tunnel: tunnel,
            }
        };

        let info = record.info.clone();
        state
            .sessions
            .lock()
            .map_err(|_| standard_error_from_raw("interactive", "create", "Lock poisoned"))?
            .insert(session_id, record);
        Ok(info)
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))?
}

fn get_record<'a>(
    sessions: &'a HashMap<String, SessionRecord>,
    id: &str,
) -> Result<&'a SessionRecord, String> {
    sessions.get(id).ok_or_else(|| {
        standard_error_payload("not_found", "interactive", false, "Session not found", None)
    })
}

#[tauri::command]
pub fn send_interactive_input(
    state: tauri::State<'_, InteractiveSessionState>,
    payload: SessionInputRequest,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| standard_error_from_raw("interactive", "send", "Lock poisoned"))?;
    get_record(&sessions, &payload.session_id)?
        .command_tx
        .send(SessionCommand::Input(payload.input.into_bytes()))
        .map_err(|e| standard_error_from_raw("interactive", "send", e.to_string()))
}

#[tauri::command]
pub fn resize_interactive_terminal(
    state: tauri::State<'_, InteractiveSessionState>,
    payload: SessionResizeRequest,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| standard_error_from_raw("interactive", "resize", "Lock poisoned"))?;
    get_record(&sessions, &payload.session_id)?
        .command_tx
        .send(SessionCommand::Resize(payload.cols, payload.rows))
        .map_err(|e| standard_error_from_raw("interactive", "resize", e.to_string()))
}

#[tauri::command]
pub fn poll_interactive_output(
    state: tauri::State<'_, InteractiveSessionState>,
    payload: SessionPollRequest,
) -> Result<InteractivePollResponse, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| standard_error_from_raw("interactive", "poll", "Lock poisoned"))?;
    let record = get_record(&sessions, &payload.session_id)?;
    let current_status = record
        .status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| "unknown".to_string());
    let after_seq = payload.after_seq.unwrap_or(0);
    let mut output = record
        .output
        .lock()
        .map_err(|_| standard_error_from_raw("interactive", "poll", "Output lock poisoned"))?;
    if after_seq > 0 {
        let drain_up_to = output.partition_point(|c| c.seq <= after_seq);
        if drain_up_to > 0 {
            output.drain(..drain_up_to);
        }
    }
    let chunks: Vec<InteractiveOutputChunk> = std::mem::take(&mut *output);
    let next_seq = chunks.last().map(|c| c.seq).unwrap_or(after_seq);
    Ok(InteractivePollResponse {
        session_id: payload.session_id,
        status: current_status,
        next_seq,
        chunks,
    })
}

#[tauri::command]
pub fn list_interactive_sessions(
    state: tauri::State<'_, InteractiveSessionState>,
) -> Result<Vec<InteractiveSessionInfo>, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| standard_error_from_raw("interactive", "list", "Lock poisoned"))?;
    Ok(sessions
        .values()
        .map(|r| {
            let mut info = r.info.clone();
            if let Ok(s) = r.status.lock() {
                info.status = s.clone();
            }
            info
        })
        .collect())
}

#[tauri::command]
pub fn close_interactive_session(
    state: tauri::State<'_, InteractiveSessionState>,
    payload: SessionCloseRequest,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| standard_error_from_raw("interactive", "close", "Lock poisoned"))?;
    let record = sessions.remove(&payload.session_id).ok_or_else(|| {
        standard_error_payload("not_found", "interactive", false, "Session not found", None)
    })?;
    let _ = record.command_tx.send(SessionCommand::Close);
    Ok(())
}

#[cfg(unix)]
fn open_local_pty(
    shell: &str,
    cols: u32,
    rows: u32,
) -> Result<(std::fs::File, std::fs::File, i32), String> {
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut master_fd: libc::c_int = 0;
    let mut slave_fd: libc::c_int = 0;
    let mut ws = libc::winsize {
        ws_row: rows as u16,
        ws_col: cols as u16,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    if unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut ws,
        )
    } != 0
    {
        return Err(standard_error_from_raw(
            "interactive",
            "openpty",
            "Failed to allocate PTY",
        ));
    }

    let slave_copy = slave_fd;
    let master_copy = master_fd;
    let mut cmd = Command::new(shell);
    cmd.arg("-l").env("TERM", "xterm-256color");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(move || {
            libc::setsid();
            libc::ioctl(slave_copy, libc::TIOCSCTTY as _, 0);
            libc::dup2(slave_copy, 0);
            libc::dup2(slave_copy, 1);
            libc::dup2(slave_copy, 2);
            if slave_copy > 2 {
                libc::close(slave_copy);
            }
            libc::close(master_copy);
            Ok(())
        });
    }

    let child = cmd.spawn().map_err(|e| {
        unsafe {
            libc::close(master_fd);
            libc::close(slave_fd);
        }
        standard_error_from_raw("interactive", "spawn shell", format!("{e}"))
    })?;
    let pid = child.id() as i32;
    unsafe {
        libc::close(slave_fd);
    }

    let master = unsafe { std::fs::File::from_raw_fd(master_fd) };
    let master_writer = master
        .try_clone()
        .map_err(|e| standard_error_from_raw("interactive", "dup master", format!("{e}")))?;

    std::mem::forget(child);
    Ok((master, master_writer, pid))
}

#[tauri::command]
#[cfg(unix)]
pub fn create_local_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, InteractiveSessionState>,
    payload: LocalTerminalRequest,
) -> Result<InteractiveSessionInfo, String> {
    let session_id = Uuid::new_v4().to_string();
    emit_progress(&app, &session_id, "detect_shell");
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    });
    let username = std::env::var("USER").unwrap_or_else(|_| "local".to_string());

    emit_progress(&app, &session_id, "spawn_shell");
    #[cfg(unix)]
    let (reader, writer, child_pid) = open_local_pty(&shell, payload.cols, payload.rows)?;

    emit_progress(&app, &session_id, "allocate_pty");
    let (output, seq_counter, status) = new_shared_state();
    emit_progress(&app, &session_id, "prepare_workspace");
    spawn_pipe_reader(
        app.clone(),
        session_id.clone(),
        reader,
        output.clone(),
        seq_counter.clone(),
        "stdout",
    );

    let (command_tx, command_rx) = mpsc::channel::<SessionCommand>();
    let status_clone = status.clone();
    let status_watcher = status.clone();
    let session_id_writer = session_id.clone();
    let session_id_watcher = session_id.clone();
    let app_watcher = app.clone();

    #[cfg(unix)]
    thread::spawn(move || {
        use std::os::fd::AsRawFd;
        let mut writer = writer;
        let fd = writer.as_raw_fd();
        for cmd in command_rx {
            match cmd {
                SessionCommand::Input(data) => {
                    let _ = writer.write_all(&data);
                    let _ = writer.flush();
                }
                SessionCommand::Resize(cols, rows) => {
                    let ws = libc::winsize {
                        ws_row: rows as u16,
                        ws_col: cols as u16,
                        ws_xpixel: 0,
                        ws_ypixel: 0,
                    };
                    unsafe {
                        libc::ioctl(fd, libc::TIOCSWINSZ as _, &ws);
                    }
                }
                SessionCommand::Close => {
                    unsafe {
                        libc::kill(child_pid, libc::SIGHUP);
                    }
                    break;
                }
            }
        }
        set_status(
            &app,
            &session_id_writer,
            &status_clone,
            "closed(0)".to_string(),
        );
    });
    #[cfg(unix)]
    thread::spawn(move || {
        let mut status_code: libc::c_int = 0;
        let wait_rc = unsafe { libc::waitpid(child_pid, &mut status_code, 0) };
        if wait_rc < 0 {
            set_status(
                &app_watcher,
                &session_id_watcher,
                &status_watcher,
                "closed(-1)".to_string(),
            );
            return;
        }
        let code = if libc::WIFEXITED(status_code) {
            libc::WEXITSTATUS(status_code)
        } else if libc::WIFSIGNALED(status_code) {
            -(libc::WTERMSIG(status_code))
        } else {
            -1
        };
        set_status(
            &app_watcher,
            &session_id_watcher,
            &status_watcher,
            format!("closed({code})"),
        );
    });

    let now = now_unix_ms();
    let info = InteractiveSessionInfo {
        vault_id: None,
        session_id: session_id.clone(),
        host_id: None,
        host: "local".to_string(),
        username,
        created_at: now,
        last_active_at: now,
        status: "running".to_string(),
    };
    let record = SessionRecord {
        vault_id: None,
        verified_host_keys: Vec::new(),
        info: info.clone(),
        command_tx,
        output,
        _seq_counter: seq_counter,
        status,
        reusable_transport: None,
        _tunnel: None,
    };
    state
        .sessions
        .lock()
        .map_err(|_| standard_error_from_raw("interactive", "create", "Lock poisoned"))?
        .insert(session_id, record);
    Ok(info)
}

#[tauri::command]
#[cfg(not(unix))]
pub fn create_local_terminal(
    app: tauri::AppHandle,
    state: tauri::State<'_, InteractiveSessionState>,
    payload: LocalTerminalRequest,
) -> Result<InteractiveSessionInfo, String> {
    let _ = (app, state, payload);
    Err(standard_error_from_raw(
        "interactive",
        "local terminal",
        "Local terminals are not supported on this platform; SSH terminals are available",
    ))
}
