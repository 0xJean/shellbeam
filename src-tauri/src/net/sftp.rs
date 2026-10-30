use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use ssh2::{Session, Sftp};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Emitter;
use uuid::Uuid;

use crate::error::{sftp_error_from_raw, sftp_error_payload};

// SSH handshakes, directory enumeration and file transfers must never run on
// the window thread or occupy the async executor while waiting for I/O.
async fn run_file_io<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            sftp_error_payload(
                "io_task_failed",
                "client",
                false,
                "File operation worker failed",
                None,
            )
        })?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRequest {
    host_id: Option<String>,
    vault_id: Option<String>,
    #[serde(default)]
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
    follow_symlinks: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpUploadRequest {
    host_id: Option<String>,
    vault_id: Option<String>,
    #[serde(default)]
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
    host_id: Option<String>,
    vault_id: Option<String>,
    #[serde(default)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpPathState {
    exists: bool,
    is_dir: Option<bool>,
    is_file: Option<bool>,
    size: Option<u64>,
    permissions: Option<u32>,
}

fn observed_path_state(
    result: Result<ssh2::FileStat, ssh2::Error>,
) -> Result<SftpPathState, String> {
    match result {
        Ok(stat) => Ok(SftpPathState {
            exists: true,
            is_dir: stat.perm.map(|mode| mode & 0o170000 == 0o040000),
            is_file: stat.perm.map(|mode| mode & 0o170000 == 0o100000),
            size: stat.size,
            permissions: stat.perm.map(|mode| mode & 0o7777),
        }),
        // Permission errors, transport failures and generic server failures do
        // not prove that a path was removed. Only explicit missing-path codes do.
        Err(error) if matches!(error.code(), ssh2::ErrorCode::SFTP(2 | 10)) => Ok(SftpPathState {
            exists: false,
            is_dir: None,
            is_file: None,
            size: None,
            permissions: None,
        }),
        Err(error) => Err(sftp_error_from_raw(
            "sftp",
            "observe path",
            error.to_string(),
        )),
    }
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

/// Every SFTP handshake uses the same verified route as terminal/commands.
fn checkout_with_sftp(
    app: &tauri::AppHandle,
    host_id: Option<&str>,
    vault_id: Option<&str>,
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
) -> Result<
    (
        Session,
        Sftp,
        Option<std::sync::Arc<crate::ssh::transport::TunnelLease>>,
    ),
    String,
> {
    let route = if let (Some(host_id), Some(vault_id)) = (host_id, vault_id) {
        crate::ssh::transport::resolve_host_route(app, vault_id, host_id)?
    } else {
        crate::ssh::transport::legacy_route(
            vault_id,
            host,
            port,
            username,
            auth_type,
            password,
            private_key,
            passphrase,
            jump_host,
            jump_port,
            jump_user,
        )
    };
    let connection = crate::ssh::transport::connect(app, &route)?;
    crate::ssh::transport::ensure_vault_unlocked(app, vault_id)?;
    let sftp = connection
        .session
        .sftp()
        .map_err(|error| sftp_error_from_raw("sftp", "open channel", error.to_string()))?;
    Ok((connection.session, sftp, connection.tunnel))
}

#[tauri::command]
pub async fn sftp_stat_path(
    app: tauri::AppHandle,
    payload: SftpRequest,
) -> Result<SftpPathState, String> {
    run_file_io(move || sftp_stat_path_blocking(app, payload)).await
}

fn sftp_stat_path_blocking(
    app: tauri::AppHandle,
    payload: SftpRequest,
) -> Result<SftpPathState, String> {
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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
    let path = Path::new(payload.remote_path.trim());
    let result = observed_path_state(if payload.follow_symlinks.unwrap_or(false) {
        sftp.stat(path)
    } else {
        sftp.lstat(path)
    });
    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_list_dir(
    app: tauri::AppHandle,
    payload: SftpRequest,
) -> Result<Vec<SftpEntry>, String> {
    run_file_io(move || sftp_list_dir_blocking(app, payload)).await
}

fn sftp_list_dir_blocking(
    app: tauri::AppHandle,
    payload: SftpRequest,
) -> Result<Vec<SftpEntry>, String> {
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_home_dir(app: tauri::AppHandle, payload: SftpRequest) -> Result<String, String> {
    run_file_io(move || sftp_home_dir_blocking(app, payload)).await
}

fn sftp_home_dir_blocking(app: tauri::AppHandle, payload: SftpRequest) -> Result<String, String> {
    let (session, sftp, jump_tunnel) = checkout_with_sftp(
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

// The legacy renderer transfer API returns base64 in one response. Bound
// allocations even when an SFTP server reports an unknown/incorrect size.
const MAX_BUFFERED_DOWNLOAD: usize = 64 * 1024 * 1024;
fn read_download(
    file: &mut impl Read,
    limit: usize,
    deadline: std::time::Instant,
    mut progress: impl FnMut(u64),
) -> Result<Vec<u8>, String> {
    let mut content = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("SFTP_DOWNLOAD_TIMEOUT".into());
        }
        let count = file
            .read(&mut buffer)
            .map_err(|_| "SFTP_DOWNLOAD_READ_FAILED")?;
        if count == 0 {
            return Ok(content);
        }
        if content.len().saturating_add(count) > limit {
            return Err("SFTP_DOWNLOAD_LIMIT: buffered downloads are limited to 64 MiB".into());
        }
        content.extend_from_slice(&buffer[..count]);
        progress(content.len() as u64);
    }
}

#[tauri::command]
pub async fn sftp_download_file(
    app: tauri::AppHandle,
    payload: SftpRequest,
) -> Result<SftpFileData, String> {
    run_file_io(move || sftp_download_file_blocking(app, payload)).await
}

fn sftp_download_file_blocking(
    app: tauri::AppHandle,
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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
        if total_size.is_some_and(|size| size > MAX_BUFFERED_DOWNLOAD as u64) {
            return Err("SFTP_DOWNLOAD_LIMIT: buffered downloads are limited to 64 MiB".into());
        }
        let content = read_download(
            &mut remote_file,
            MAX_BUFFERED_DOWNLOAD,
            std::time::Instant::now() + std::time::Duration::from_secs(90),
            |processed| {
                emit_sftp_progress(
                    &app,
                    &transfer_id,
                    "download_progress",
                    processed,
                    total_size,
                    "Downloading",
                );
            },
        )?;
        let processed = content.len() as u64;
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_upload_file(
    app: tauri::AppHandle,
    payload: SftpUploadRequest,
) -> Result<(), String> {
    run_file_io(move || sftp_upload_file_blocking(app, payload)).await
}

fn sftp_upload_file_blocking(
    app: tauri::AppHandle,
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_delete_path(app: tauri::AppHandle, payload: SftpRequest) -> Result<(), String> {
    run_file_io(move || sftp_delete_path_blocking(app, payload)).await
}

fn sftp_delete_path_blocking(app: tauri::AppHandle, payload: SftpRequest) -> Result<(), String> {
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_rename_path(
    app: tauri::AppHandle,
    payload: SftpRenameRequest,
) -> Result<(), String> {
    run_file_io(move || sftp_rename_path_blocking(app, payload)).await
}

fn sftp_rename_path_blocking(
    app: tauri::AppHandle,
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_create_dir(app: tauri::AppHandle, payload: SftpRequest) -> Result<(), String> {
    run_file_io(move || sftp_create_dir_blocking(app, payload)).await
}

fn sftp_create_dir_blocking(app: tauri::AppHandle, payload: SftpRequest) -> Result<(), String> {
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_create_file(app: tauri::AppHandle, payload: SftpRequest) -> Result<(), String> {
    run_file_io(move || sftp_create_file_blocking(app, payload)).await
}

fn sftp_create_file_blocking(app: tauri::AppHandle, payload: SftpRequest) -> Result<(), String> {
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[tauri::command]
pub async fn sftp_write_file(
    app: tauri::AppHandle,
    payload: SftpUploadRequest,
) -> Result<(), String> {
    run_file_io(move || sftp_write_file_blocking(app, payload)).await
}

fn sftp_write_file_blocking(
    app: tauri::AppHandle,
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpChmodRequest {
    host_id: Option<String>,
    vault_id: Option<String>,
    #[serde(default)]
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
pub async fn sftp_chmod(app: tauri::AppHandle, payload: SftpChmodRequest) -> Result<(), String> {
    run_file_io(move || sftp_chmod_blocking(app, payload)).await
}

fn sftp_chmod_blocking(app: tauri::AppHandle, payload: SftpChmodRequest) -> Result<(), String> {
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
        &app,
        payload.host_id.as_deref(),
        payload.vault_id.as_deref(),
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

    drop(sftp);
    drop(session);
    drop(jump_tunnel);
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
pub async fn local_list_dir(payload: LocalListRequest) -> Result<Vec<LocalEntry>, String> {
    run_file_io(move || local_list_dir_blocking(payload)).await
}

fn local_list_dir_blocking(payload: LocalListRequest) -> Result<Vec<LocalEntry>, String> {
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
pub async fn local_read_file_b64(path: String) -> Result<String, String> {
    run_file_io(move || local_read_file_b64_blocking(path)).await
}

fn local_read_file_b64_blocking(path: String) -> Result<String, String> {
    let mut file = std::fs::File::open(&path).map_err(|_| "LOCAL_FILE_READ_FAILED")?;
    let data = read_download(
        &mut file,
        MAX_BUFFERED_DOWNLOAD,
        std::time::Instant::now() + std::time::Duration::from_secs(90),
        |_| {},
    )?;
    Ok(BASE64_STANDARD.encode(&data))
}

#[tauri::command]
pub async fn local_write_file_b64(path: String, content_b64: String) -> Result<(), String> {
    run_file_io(move || local_write_file_b64_blocking(path, content_b64)).await
}

fn local_write_file_b64_blocking(path: String, content_b64: String) -> Result<(), String> {
    let data = BASE64_STANDARD
        .decode(&content_b64)
        .map_err(|e| format!("Decode base64: {}", e))?;
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&path, &data).map_err(|e| format!("Write failed: {}", e))
}

#[cfg(test)]
mod bounded_download_tests {
    use super::*;
    #[test]
    fn unknown_length_downloads_are_bounded_and_timeout_before_read() {
        let data = vec![7u8; 80_000];
        assert!(read_download(
            &mut data.as_slice(),
            1024,
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            |_| {}
        )
        .unwrap_err()
        .starts_with("SFTP_DOWNLOAD_LIMIT"));
        assert_eq!(
            read_download(
                &mut data.as_slice(),
                data.len(),
                std::time::Instant::now(),
                |_| {}
            )
            .unwrap_err(),
            "SFTP_DOWNLOAD_TIMEOUT"
        );
        assert_eq!(
            read_download(
                &mut &b"small"[..],
                1024,
                std::time::Instant::now() + std::time::Duration::from_secs(1),
                |_| {}
            )
            .unwrap(),
            b"small"
        );
    }

    #[test]
    fn post_state_only_marks_explicit_missing_path_codes_absent() {
        for code in [2, 10] {
            let state = observed_path_state(Err(ssh2::Error::new(
                ssh2::ErrorCode::SFTP(code),
                "missing",
            )))
            .unwrap();
            assert!(!state.exists);
        }
        for code in [
            ssh2::ErrorCode::SFTP(3),
            ssh2::ErrorCode::SFTP(4),
            ssh2::ErrorCode::Session(-7),
        ] {
            assert!(
                observed_path_state(Err(ssh2::Error::new(code, "observation unavailable")))
                    .is_err()
            );
        }
        let state = observed_path_state(Ok(ssh2::FileStat {
            size: Some(6),
            uid: None,
            gid: None,
            perm: Some(0o100640),
            atime: None,
            mtime: None,
        }))
        .unwrap();
        assert!(state.exists);
        assert_eq!(state.is_file, Some(true));
        assert_eq!(state.is_dir, Some(false));
        assert_eq!(state.permissions, Some(0o640));
        assert_eq!(state.size, Some(6));
        let unknown = observed_path_state(Ok(ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: None,
        }))
        .unwrap();
        assert_eq!(unknown.is_file, None);
        assert_eq!(unknown.permissions, None);
    }
}

#[cfg(test)]
mod nonblocking_io_tests {
    use super::*;
    use std::{
        future::Future,
        sync::{mpsc, Arc},
        task::{Context, Poll, Wake, Waker},
    };

    struct NoopWake;
    impl Wake for NoopWake {
        fn wake(self: Arc<Self>) {}
    }

    #[test]
    fn slow_file_io_yields_to_the_caller_and_runs_on_a_worker() {
        let caller = std::thread::current().id();
        let (release, wait) = mpsc::channel();
        let mut request = Box::pin(run_file_io(move || {
            // Bound the test's failure path if someone makes this run inline.
            wait.recv_timeout(std::time::Duration::from_secs(2))
                .map_err(|_| "worker blocked caller".to_string())?;
            Ok(std::thread::current().id())
        }));
        let waker = Waker::from(Arc::new(NoopWake));
        assert!(matches!(
            request.as_mut().poll(&mut Context::from_waker(&waker)),
            Poll::Pending
        ));
        release.send(()).unwrap();
        let worker = tauri::async_runtime::block_on(request).unwrap();
        assert_ne!(caller, worker);
    }

    #[test]
    fn async_local_file_commands_keep_listing_and_transfer_results() {
        tauri::async_runtime::block_on(async {
            let directory =
                std::env::temp_dir().join(format!("shellbeam-sftp-test-{}", Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("sample.txt").to_string_lossy().into_owned();
            let encoded = BASE64_STANDARD.encode(b"sample");
            local_write_file_b64(path.clone(), encoded.clone())
                .await
                .unwrap();
            assert_eq!(local_read_file_b64(path).await.unwrap(), encoded);
            let entries = local_list_dir(LocalListRequest {
                dir_path: directory.to_string_lossy().into_owned(),
            })
            .await
            .unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].file_name, "sample.txt");
            assert_eq!(entries[0].size, Some(6));
            std::fs::remove_dir_all(directory).unwrap();
        });
    }
}
