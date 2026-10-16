use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use ssh2::{Session, Sftp};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::Emitter;
use uuid::Uuid;

use crate::error::{sftp_error_from_raw, sftp_error_payload};
use crate::ssh::SshSessionPool;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRequest {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
    remote_path: String,
    transfer_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpUploadRequest {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
    remote_path: String,
    content_b64: String,
    transfer_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRenameRequest {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
    old_remote_path: String,
    new_remote_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTransferProgressEvent {
    transfer_id: String,
    phase: String,
    bytes_processed: u64,
    bytes_total: Option<u64>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    path: String,
    file_name: String,
    is_dir: bool,
    size: Option<u64>,
    modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpFileData {
    path: String,
    content_b64: String,
    size_bytes: usize,
}

/// A short-lived local forwarding process used to route libssh2 through a
/// configured ProxyJump. The existing SFTP implementation uses libssh2 for
/// authentication and channels, while OpenSSH provides only the TCP path.
struct JumpTunnel {
    child: Child,
    key_path: PathBuf,
}

impl Drop for JumpTunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.key_path);
    }
}

fn has_jump_host(jump_host: Option<&str>) -> bool {
    jump_host
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn start_jump_tunnel(
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    private_key: Option<&str>,
    jump_host: Option<&str>,
    jump_port: Option<u16>,
    jump_user: Option<&str>,
) -> Result<(JumpTunnel, u16), String> {
    if !has_jump_host(jump_host) {
        return Err("Jump host is not configured".to_string());
    }
    if auth_type != "privateKey" {
        return Err(
            "SFTP over a jump host currently requires private key authentication".to_string(),
        );
    }
    let private_key = private_key
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "Private key is required for SFTP jump-host connections".to_string())?;
    let jump_host = jump_host.unwrap_or_default().trim();
    let local_port = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("Failed to reserve local SFTP jump port: {err}"))?
        .local_addr()
        .map_err(|err| format!("Failed to read local SFTP jump port: {err}"))?
        .port();

    let key_path = std::env::temp_dir().join(format!("shellbeam-sftp-jump-{}.key", Uuid::new_v4()));
    std::fs::write(&key_path, private_key)
        .map_err(|err| format!("Failed to write temporary SFTP jump key: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) =
            std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
        {
            let _ = std::fs::remove_file(&key_path);
            return Err(format!("Failed to protect temporary SFTP jump key: {err}"));
        }
    }

    let jump_username = jump_user
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(username);
    let forward = format!("127.0.0.1:{local_port}:{host}:{port}");
    let destination = format!("{username}@{host}");
    let mut command = Command::new("ssh");
    command
        .arg("-N")
        .arg("-L")
        .arg(&forward)
        .arg("-p")
        .arg(port.to_string())
        .arg("-i")
        .arg(&key_path)
        .arg("-J")
        .arg(format!(
            "{jump_username}@{jump_host}:{}",
            jump_port.unwrap_or(22)
        ))
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=no")
        .arg("-o")
        .arg("UserKnownHostsFile=/dev/null")
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command.spawn().map_err(|err| {
        let _ = std::fs::remove_file(&key_path);
        format!("Failed to start system ssh for SFTP jump host: {err}")
    })?;

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("Failed to inspect SFTP jump process: {err}"))?
        {
            let _ = std::fs::remove_file(&key_path);
            return Err(format!(
                "System ssh jump tunnel exited before becoming ready ({status})"
            ));
        }
        if TcpStream::connect(("127.0.0.1", local_port)).is_ok() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&key_path);
            return Err("Timed out waiting for SFTP jump tunnel".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    Ok((JumpTunnel { child, key_path }, local_port))
}

fn file_name_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn emit_sftp_progress(
    app: &tauri::AppHandle,
    transfer_id: &str,
    phase: &str,
    bytes_processed: u64,
    bytes_total: Option<u64>,
    message: &str,
) {
    let _ = app.emit(
        "sftp-transfer-progress",
        SftpTransferProgressEvent {
            transfer_id: transfer_id.to_string(),
            phase: phase.to_string(),
            bytes_processed,
            bytes_total,
            message: message.to_string(),
        },
    );
}

/// Check out an SSH session and open an SFTP channel, retrying once with a
/// fresh connection if the initial channel open fails (works around libssh2
/// error -21 "Unable to startup channel" that can occur right after auth).
fn checkout_with_sftp(
    pool: &SshSessionPool,
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&str>,
    jump_port: Option<u16>,
    jump_user: Option<&str>,
) -> Result<(Session, Sftp, Option<JumpTunnel>), String> {
    let (jump_tunnel, connect_host, connect_port) = if has_jump_host(jump_host) {
        let (tunnel, local_port) = start_jump_tunnel(
            host,
            port,
            username,
            auth_type,
            private_key,
            jump_host,
            jump_port,
            jump_user,
        )?;
        (Some(tunnel), "127.0.0.1", local_port)
    } else {
        (None, host, port)
    };

    let session = if jump_tunnel.is_some() {
        crate::ssh::connect_authenticated_ssh_session(
            connect_host,
            connect_port,
            username,
            auth_type,
            password,
            private_key,
            passphrase,
        )
    } else {
        pool.checkout(
            connect_host,
            connect_port,
            username,
            auth_type,
            password,
            private_key,
            passphrase,
        )
    }
    .map_err(|err| sftp_error_from_raw("ssh", "connect/authenticate", err))?;

    match session.sftp() {
        Ok(sftp) => Ok((session, sftp, jump_tunnel)),
        Err(first_err) => {
            drop(session);
            std::thread::sleep(Duration::from_millis(200));
            let session = if jump_tunnel.is_some() {
                crate::ssh::connect_authenticated_ssh_session(
                    connect_host,
                    connect_port,
                    username,
                    auth_type,
                    password,
                    private_key,
                    passphrase,
                )
            } else {
                pool.checkout(
                    connect_host,
                    connect_port,
                    username,
                    auth_type,
                    password,
                    private_key,
                    passphrase,
                )
            }
            .map_err(|err| sftp_error_from_raw("ssh", "reconnect", err))?;
            let sftp = session.sftp().map_err(|err| {
                sftp_error_from_raw(
                    "sftp",
                    "open channel",
                    format!("retry also failed (first: {first_err}; retry: {err})"),
                )
            })?;
            Ok((session, sftp, jump_tunnel))
        }
    }
}

#[tauri::command]
pub fn sftp_list_dir(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpRequest,
) -> Result<Vec<SftpEntry>, String> {
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<Vec<SftpEntry>, String> {
        let remote_path = if payload.remote_path.trim().is_empty() {
            "/"
        } else {
            payload.remote_path.trim()
        };
        let items = sftp
            .readdir(Path::new(remote_path))
            .map_err(|err| sftp_error_from_raw("sftp", "list directory", err.to_string()))?;

        let mut entries = items
            .into_iter()
            .map(|(path, stat)| {
                let perm = stat.perm.unwrap_or_default();
                let is_dir = (perm & 0o170000) == 0o040000;
                SftpEntry {
                    path: path.to_string_lossy().to_string(),
                    file_name: file_name_from_path(&path),
                    is_dir,
                    size: stat.size,
                    modified_at: stat.mtime,
                }
            })
            .filter(|entry| entry.file_name != "." && entry.file_name != "..")
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
        Ok(entries)
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_home_dir(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpRequest,
) -> Result<String, String> {
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<String, String> {
        sftp.realpath(Path::new("."))
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|err| sftp_error_from_raw("sftp", "resolve home directory", err.to_string()))
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_download_file(
    app: tauri::AppHandle,
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpRequest,
) -> Result<SftpFileData, String> {
    if payload.remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "remotePath is required",
            None,
        ));
    }
    let transfer_id = payload
        .transfer_id
        .clone()
        .unwrap_or_else(|| format!("download-{}", Uuid::new_v4()));
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<SftpFileData, String> {
        let remote_path = Path::new(payload.remote_path.trim());
        let total_size = sftp.stat(remote_path).ok().and_then(|stat| stat.size);
        let mut remote_file = sftp
            .open(remote_path)
            .map_err(|err| sftp_error_from_raw("sftp", "open remote file", err.to_string()))?;
        emit_sftp_progress(
            &app,
            &transfer_id,
            "download_start",
            0,
            total_size,
            "Download started",
        );
        let mut content = Vec::<u8>::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut processed = 0u64;
        loop {
            let read = remote_file
                .read(&mut buffer)
                .map_err(|err| sftp_error_from_raw("sftp", "read remote file", err.to_string()))?;
            if read == 0 {
                break;
            }
            content.extend_from_slice(&buffer[..read]);
            processed += read as u64;
            emit_sftp_progress(
                &app,
                &transfer_id,
                "download_progress",
                processed,
                total_size,
                "Downloading",
            );
        }
        emit_sftp_progress(
            &app,
            &transfer_id,
            "download_done",
            processed,
            total_size,
            "Download completed",
        );
        Ok(SftpFileData {
            path: payload.remote_path.trim().to_string(),
            content_b64: BASE64_STANDARD.encode(&content),
            size_bytes: content.len(),
        })
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_upload_file(
    app: tauri::AppHandle,
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpUploadRequest,
) -> Result<(), String> {
    if payload.remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "remotePath is required",
            None,
        ));
    }
    let transfer_id = payload
        .transfer_id
        .clone()
        .unwrap_or_else(|| format!("upload-{}", Uuid::new_v4()));
    let content = BASE64_STANDARD
        .decode(payload.content_b64)
        .map_err(|err| sftp_error_from_raw("client", "decode upload content", err.to_string()))?;
    let total_size = content.len() as u64;
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<(), String> {
        emit_sftp_progress(
            &app,
            &transfer_id,
            "upload_start",
            0,
            Some(total_size),
            "Upload started",
        );
        let mut remote_file = sftp
            .create(Path::new(payload.remote_path.trim()))
            .map_err(|err| sftp_error_from_raw("sftp", "create remote file", err.to_string()))?;
        let chunk_size = 64 * 1024;
        let mut processed = 0u64;
        for chunk in content.chunks(chunk_size) {
            remote_file
                .write_all(chunk)
                .map_err(|err| sftp_error_from_raw("sftp", "write remote file", err.to_string()))?;
            processed += chunk.len() as u64;
            emit_sftp_progress(
                &app,
                &transfer_id,
                "upload_progress",
                processed,
                Some(total_size),
                "Uploading",
            );
        }
        remote_file
            .flush()
            .map_err(|err| sftp_error_from_raw("sftp", "flush remote file", err.to_string()))?;
        emit_sftp_progress(
            &app,
            &transfer_id,
            "upload_done",
            processed,
            Some(total_size),
            "Upload completed",
        );
        Ok(())
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_delete_path(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpRequest,
) -> Result<(), String> {
    if payload.remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "remotePath is required",
            None,
        ));
    }
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<(), String> {
        let target = Path::new(payload.remote_path.trim());
        match sftp.unlink(target) {
            Ok(_) => Ok(()),
            Err(file_err) => sftp.rmdir(target).map_err(|dir_err| {
                sftp_error_from_raw(
                    "sftp",
                    "delete path",
                    format!("Delete path failed (file: {file_err}; dir: {dir_err})"),
                )
            }),
        }
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_rename_path(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpRenameRequest,
) -> Result<(), String> {
    if payload.old_remote_path.trim().is_empty() || payload.new_remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "oldRemotePath and newRemotePath are required",
            None,
        ));
    }
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<(), String> {
        sftp.rename(
            Path::new(payload.old_remote_path.trim()),
            Path::new(payload.new_remote_path.trim()),
            None,
        )
        .map_err(|err| sftp_error_from_raw("sftp", "rename path", err.to_string()))
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_create_dir(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpRequest,
) -> Result<(), String> {
    if payload.remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "remotePath is required",
            None,
        ));
    }
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<(), String> {
        sftp.mkdir(Path::new(payload.remote_path.trim()), 0o755)
            .map_err(|err| sftp_error_from_raw("sftp", "create directory", err.to_string()))
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_create_file(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpRequest,
) -> Result<(), String> {
    if payload.remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "remotePath is required",
            None,
        ));
    }
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<(), String> {
        let mut remote_file = sftp
            .create(Path::new(payload.remote_path.trim()))
            .map_err(|err| sftp_error_from_raw("sftp", "create remote file", err.to_string()))?;
        remote_file
            .flush()
            .map_err(|err| sftp_error_from_raw("sftp", "flush remote file", err.to_string()))
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[tauri::command]
pub fn sftp_write_file(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpUploadRequest,
) -> Result<(), String> {
    if payload.remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "remotePath is required",
            None,
        ));
    }
    let content = BASE64_STANDARD
        .decode(payload.content_b64)
        .map_err(|err| sftp_error_from_raw("client", "decode file content", err.to_string()))?;
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<(), String> {
        let mut remote_file =
            sftp.create(Path::new(payload.remote_path.trim()))
                .map_err(|err| {
                    sftp_error_from_raw("sftp", "open remote file for write", err.to_string())
                })?;
        remote_file
            .write_all(&content)
            .map_err(|err| sftp_error_from_raw("sftp", "write remote file", err.to_string()))?;
        remote_file
            .flush()
            .map_err(|err| sftp_error_from_raw("sftp", "flush remote file", err.to_string()))
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpChmodRequest {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
    remote_path: String,
    mode: u32,
}

#[tauri::command]
pub fn sftp_chmod(
    pool: tauri::State<'_, SshSessionPool>,
    payload: SftpChmodRequest,
) -> Result<(), String> {
    if payload.remote_path.trim().is_empty() {
        return Err(sftp_error_payload(
            "validation_error",
            "client",
            false,
            "remotePath is required",
            None,
        ));
    }
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &pool,
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
    )?;

    let result = (|| -> Result<(), String> {
        let path = Path::new(payload.remote_path.trim());
        let mut stat = sftp
            .stat(path)
            .map_err(|err| sftp_error_from_raw("sftp", "stat path", err.to_string()))?;
        stat.perm = Some(payload.mode);
        sftp.setstat(path, stat)
            .map_err(|err| sftp_error_from_raw("sftp", "chmod", err.to_string()))
    })();

    if result.is_ok() && jump_tunnel.is_none() {
        pool.checkin(&payload.host, payload.port, &payload.username, session);
    }
    result
}

// --- Local filesystem commands ---

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub path: String,
    pub file_name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListRequest {
    pub dir_path: String,
}

#[tauri::command]
pub fn local_list_dir(payload: LocalListRequest) -> Result<Vec<LocalEntry>, String> {
    let dir = PathBuf::from(&payload.dir_path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", payload.dir_path));
    }
    let mut entries = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for item in read {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let metadata = item.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = metadata
            .as_ref()
            .and_then(|m| if !m.is_dir() { Some(m.len()) } else { None });
        let modified_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        entries.push(LocalEntry {
            path: item.path().to_string_lossy().to_string(),
            file_name: item.file_name().to_string_lossy().to_string(),
            is_dir,
            size,
            modified_at,
        });
    }
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase())
    });
    Ok(entries)
}

#[tauri::command]
pub fn local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

#[tauri::command]
pub fn local_read_file_b64(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Read failed: {}", e))?;
    Ok(BASE64_STANDARD.encode(&data))
}

#[tauri::command]
pub fn local_write_file_b64(path: String, content_b64: String) -> Result<(), String> {
    let data = BASE64_STANDARD
        .decode(&content_b64)
        .map_err(|e| format!("Decode base64: {}", e))?;
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&path, &data).map_err(|e| format!("Write failed: {}", e))
}
