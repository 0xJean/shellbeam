//! Phase B: Backup & Restore - encrypted archive of hosts, snippets, vault, sync, history.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::path::Path;

use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::history::CommandHistoryEntry;
use crate::hosts::{load_hosts, HostProfile};
use crate::snippets::SnippetEntry;
use crate::storage::{data_file_path, now_unix_ms, read_json_or_default, write_json, HISTORY_FILE};
use crate::sync::{load_sync_state_for_transport, save_sync_state_for_transport, SyncStateFile};

const BACKUP_KEY_SIZE: usize = 32;
const BACKUP_SALT_SIZE: usize = 16;
const BACKUP_NONCE_SIZE: usize = 12;
const BACKUP_PBKDF2_ITERATIONS: u32 = 120_000;
const BACKUP_VERIFIER_PLAIN: &str = "shellbeam-backup-verifier-v1";
const BACKUP_SCHEMA: &str = "shellbeam-backup-v1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPayload {
    pub schema: String,
    pub version: u32,
    pub created_at: i64,
    pub hosts: Option<Vec<HostProfile>>,
    pub snippets: Option<Vec<SnippetEntry>>,
    pub vault_raw: Option<String>,
    pub sync_state: Option<SyncStateFile>,
    pub history: Option<Vec<CommandHistoryEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    schema: String,
    version: u32,
    salt_b64: String,
    verifier_nonce_b64: String,
    verifier_ciphertext_b64: String,
    payload_nonce_b64: String,
    payload_ciphertext_b64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCreateRequest {
    path: String,
    password: String,
    vault_id: Option<String>,
    include_hosts: Option<bool>,
    include_snippets: Option<bool>,
    include_vault: Option<bool>,
    include_sync: Option<bool>,
    include_history: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreRequest {
    path: String,
    password: String,
    vault_id: Option<String>,
    overwrite_hosts: Option<bool>,
    overwrite_snippets: Option<bool>,
    overwrite_vault: Option<bool>,
    overwrite_sync: Option<bool>,
    overwrite_history: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCreateResult {
    path: String,
    size_bytes: usize,
    created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreResult {
    pub hosts_restored: usize,
    pub snippets_restored: usize,
    pub vault_restored: bool,
    pub sync_restored: bool,
    pub history_restored: usize,
}

fn derive_backup_key(password: &str, salt: &[u8]) -> [u8; BACKUP_KEY_SIZE] {
    let mut key = [0u8; BACKUP_KEY_SIZE];
    pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        salt,
        BACKUP_PBKDF2_ITERATIONS,
        &mut key,
    );
    key
}

fn encrypt_payload(
    key: &[u8; BACKUP_KEY_SIZE],
    plaintext: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("Create cipher failed: {e}"))?;
    let nonce = rand::random::<[u8; BACKUP_NONCE_SIZE]>();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| "Encrypt failed".to_string())?;
    Ok((nonce.to_vec(), ciphertext))
}

fn decrypt_payload(
    key: &[u8; BACKUP_KEY_SIZE],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    if nonce.len() != BACKUP_NONCE_SIZE {
        return Err("Invalid nonce size".to_string());
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("Create cipher failed: {e}"))?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "Decrypt failed. Wrong password or corrupted backup.".to_string())
}

#[tauri::command]
pub fn backup_create(
    app: tauri::AppHandle,
    payload: BackupCreateRequest,
) -> Result<BackupCreateResult, String> {
    if payload.password.trim().len() < 8 {
        return Err(standard_error_payload(
            "validation_error",
            "backup",
            false,
            "Backup password must be at least 8 characters",
            None,
        ));
    }

    let backup_payload = backup_create_in_memory(
        &app,
        payload.vault_id.as_deref(),
        payload.include_hosts.unwrap_or(true),
        payload.include_snippets.unwrap_or(true),
        payload.include_vault.unwrap_or(true),
        payload.include_sync.unwrap_or(true),
        payload.include_history.unwrap_or(false),
    )
    .map_err(|e| standard_error_from_raw("backup", "create payload", e))?;

    let plaintext = serde_json::to_vec(&backup_payload)
        .map_err(|e| standard_error_from_raw("backup", "serialize", e.to_string()))?;
    let salt = rand::random::<[u8; BACKUP_SALT_SIZE]>();
    let key = derive_backup_key(&payload.password, &salt);
    let (verifier_nonce, verifier_ct) = encrypt_payload(&key, BACKUP_VERIFIER_PLAIN.as_bytes())
        .map_err(|e| standard_error_from_raw("backup", "encrypt verifier", e))?;
    let (payload_nonce, payload_ct) = encrypt_payload(&key, &plaintext)
        .map_err(|e| standard_error_from_raw("backup", "encrypt payload", e))?;

    let backup_file = BackupFile {
        schema: BACKUP_SCHEMA.to_string(),
        version: 1,
        salt_b64: BASE64_STANDARD.encode(salt),
        verifier_nonce_b64: BASE64_STANDARD.encode(verifier_nonce),
        verifier_ciphertext_b64: BASE64_STANDARD.encode(verifier_ct),
        payload_nonce_b64: BASE64_STANDARD.encode(payload_nonce),
        payload_ciphertext_b64: BASE64_STANDARD.encode(payload_ct),
    };

    let json = serde_json::to_string_pretty(&backup_file)
        .map_err(|e| standard_error_from_raw("backup", "serialize file", e.to_string()))?;
    let path = Path::new(&payload.path);
    fs::write(path, &json)
        .map_err(|e| standard_error_from_raw("backup", "write file", e.to_string()))?;

    Ok(BackupCreateResult {
        path: payload.path,
        size_bytes: json.len(),
        created_at: backup_payload.created_at,
    })
}

#[tauri::command]
pub fn backup_restore(
    app: tauri::AppHandle,
    payload: BackupRestoreRequest,
) -> Result<BackupRestoreResult, String> {
    if payload.password.trim().is_empty() {
        return Err(standard_error_payload(
            "validation_error",
            "backup",
            false,
            "Backup password is required",
            None,
        ));
    }
    let overwrite_hosts = payload.overwrite_hosts.unwrap_or(true);
    let overwrite_snippets = payload.overwrite_snippets.unwrap_or(true);
    let overwrite_vault = payload.overwrite_vault.unwrap_or(true);
    let overwrite_sync = payload.overwrite_sync.unwrap_or(true);
    let overwrite_history = payload.overwrite_history.unwrap_or(false);

    let content = fs::read_to_string(&payload.path)
        .map_err(|e| standard_error_from_raw("backup", "read file", e.to_string()))?;
    let backup_file: BackupFile = serde_json::from_str(&content)
        .map_err(|e| standard_error_from_raw("backup", "parse file", e.to_string()))?;

    if backup_file.schema != BACKUP_SCHEMA {
        return Err(standard_error_payload(
            "validation_error",
            "backup",
            false,
            "Invalid backup file format",
            None,
        ));
    }

    let salt = BASE64_STANDARD
        .decode(&backup_file.salt_b64)
        .map_err(|e| standard_error_from_raw("backup", "decode salt", e.to_string()))?;
    let key = derive_backup_key(&payload.password, &salt);
    let verifier_nonce = BASE64_STANDARD
        .decode(&backup_file.verifier_nonce_b64)
        .map_err(|e| standard_error_from_raw("backup", "decode verifier nonce", e.to_string()))?;
    let verifier_ct = BASE64_STANDARD
        .decode(&backup_file.verifier_ciphertext_b64)
        .map_err(|e| standard_error_from_raw("backup", "decode verifier ct", e.to_string()))?;
    let decrypted_verifier = decrypt_payload(&key, &verifier_nonce, &verifier_ct)
        .map_err(|e| standard_error_from_raw("backup", "decrypt verifier", e))?;
    if decrypted_verifier != BACKUP_VERIFIER_PLAIN.as_bytes() {
        return Err(standard_error_payload(
            "auth_failed",
            "backup",
            false,
            "Backup password is incorrect",
            None,
        ));
    }

    let payload_nonce = BASE64_STANDARD
        .decode(&backup_file.payload_nonce_b64)
        .map_err(|e| standard_error_from_raw("backup", "decode payload nonce", e.to_string()))?;
    let payload_ct = BASE64_STANDARD
        .decode(&backup_file.payload_ciphertext_b64)
        .map_err(|e| standard_error_from_raw("backup", "decode payload ct", e.to_string()))?;
    let plaintext = decrypt_payload(&key, &payload_nonce, &payload_ct)
        .map_err(|e| standard_error_from_raw("backup", "decrypt payload", e))?;
    let backup_payload: BackupPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| standard_error_from_raw("backup", "parse payload", e.to_string()))?;

    backup_restore_in_memory(
        &app,
        &backup_payload,
        payload.vault_id.as_deref(),
        overwrite_hosts,
        overwrite_snippets,
        overwrite_vault,
        overwrite_sync,
        overwrite_history,
    )
    .map_err(|e| standard_error_from_raw("backup", "restore", e))
}

/// Create an in-memory backup payload.
/// Used by both the file-based backup command and P2P sync.
pub fn backup_create_in_memory(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    include_hosts: bool,
    include_snippets: bool,
    include_vault: bool,
    include_sync: bool,
    include_history: bool,
) -> Result<BackupPayload, String> {
    let hosts = if include_hosts {
        Some(load_hosts(app, vault_id).map_err(|e| format!("load hosts: {e}"))?)
    } else {
        None
    };
    let snippets = if include_snippets {
        Some(
            crate::snippets::load_snippets(app, vault_id)
                .map_err(|e| format!("load snippets: {e}"))?,
        )
    } else {
        None
    };
    let vault_raw = if include_vault {
        crate::vault::load_vault_file_raw(app, vault_id).map_err(|e| format!("load vault: {e}"))?
    } else {
        None
    };
    let sync_state = if include_sync {
        Some(load_sync_state_for_transport(app).map_err(|e| format!("load sync: {e}"))?)
    } else {
        None
    };
    let history = if include_history {
        let path = data_file_path(app, HISTORY_FILE)?;
        Some(
            read_json_or_default::<Vec<CommandHistoryEntry>>(&path)
                .map_err(|e| format!("load history: {e}"))?,
        )
    } else {
        None
    };
    Ok(BackupPayload {
        schema: BACKUP_SCHEMA.to_string(),
        version: 1,
        created_at: now_unix_ms(),
        hosts,
        snippets,
        vault_raw,
        sync_state,
        history,
    })
}

/// Restore from an in-memory backup payload.
/// Used by both the file-based backup restore command and P2P sync.
pub fn backup_restore_in_memory(
    app: &tauri::AppHandle,
    payload: &BackupPayload,
    vault_id: Option<&str>,
    overwrite_hosts: bool,
    overwrite_snippets: bool,
    overwrite_vault: bool,
    overwrite_sync: bool,
    overwrite_history: bool,
) -> Result<BackupRestoreResult, String> {
    let mut hosts_restored = 0usize;
    let mut snippets_restored = 0usize;
    let mut vault_restored = false;
    let mut sync_restored = false;
    let mut history_restored = 0usize;

    if overwrite_hosts {
        if let Some(hosts) = &payload.hosts {
            crate::hosts::save_hosts(app, hosts, vault_id)
                .map_err(|e| format!("restore hosts: {e}"))?;
            hosts_restored = hosts.len();
        }
    }
    if overwrite_snippets {
        if let Some(snippets) = &payload.snippets {
            crate::snippets::save_snippets(app, snippets, vault_id)
                .map_err(|e| format!("restore snippets: {e}"))?;
            snippets_restored = snippets.len();
        }
    }
    if overwrite_vault {
        if let Some(vault_raw) = &payload.vault_raw {
            crate::vault::save_vault_file_raw(app, vault_raw, vault_id)
                .map_err(|e| format!("restore vault: {e}"))?;
            vault_restored = true;
        }
    }
    if overwrite_sync {
        if let Some(sync_state) = &payload.sync_state {
            save_sync_state_for_transport(app, sync_state)
                .map_err(|e| format!("restore sync: {e}"))?;
            sync_restored = true;
        }
    }
    if overwrite_history {
        if let Some(history) = &payload.history {
            let path = data_file_path(app, HISTORY_FILE)?;
            write_json(&path, history).map_err(|e| format!("restore history: {e}"))?;
            history_restored = history.len();
        }
    }

    Ok(BackupRestoreResult {
        hosts_restored,
        snippets_restored,
        vault_restored,
        sync_restored,
        history_restored,
    })
}
