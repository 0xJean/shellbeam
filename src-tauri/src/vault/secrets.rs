use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

use crate::error::{standard_error_from_raw, standard_error_payload};
use crate::storage::{data_file_path, now_unix_ms, write_json};
use crate::vaults_meta::DEFAULT_VAULT_ID;

const VAULT_KEY_SIZE: usize = 32;
const VAULT_SALT_SIZE: usize = 16;
const VAULT_NONCE_SIZE: usize = 12;
const VAULT_PBKDF2_ITERATIONS: u32 = 120_000;
const VAULT_VERIFIER_PLAIN: &str = "shellbeam-vault-verifier-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultSecretRecord {
    nonce_b64: String,
    ciphertext_b64: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    initialized_at: i64,
    salt_b64: String,
    verifier_nonce_b64: String,
    verifier_ciphertext_b64: String,
    secrets: HashMap<String, VaultSecretRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    initialized: bool,
    unlocked: bool,
    secret_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInitRequest {
    master_password: String,
    vault_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultUnlockRequest {
    master_password: String,
    vault_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSetSecretRequest {
    key: String,
    value: String,
    vault_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSecretKeyRequest {
    key: String,
    vault_id: Option<String>,
}

fn vault_file_name(vault_id: Option<&str>) -> String {
    let id = vault_id
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_VAULT_ID);
    format!("vault_{}.json", id)
}

#[derive(Default)]
pub struct VaultState {
    unlocked_keys: Mutex<std::collections::HashMap<String, [u8; VAULT_KEY_SIZE]>>,
}

fn derive_vault_key(master_password: &str, salt: &[u8]) -> [u8; VAULT_KEY_SIZE] {
    let mut key = [0u8; VAULT_KEY_SIZE];
    pbkdf2_hmac::<Sha256>(
        master_password.as_bytes(),
        salt,
        VAULT_PBKDF2_ITERATIONS,
        &mut key,
    );
    key
}

fn encrypt_vault_value(
    key: &[u8; VAULT_KEY_SIZE],
    plaintext: &[u8],
) -> Result<(String, String), String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|err| format!("Create vault cipher failed: {err}"))?;
    let nonce = rand::random::<[u8; VAULT_NONCE_SIZE]>();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| "Encrypt vault value failed".to_string())?;
    Ok((
        BASE64_STANDARD.encode(nonce),
        BASE64_STANDARD.encode(ciphertext),
    ))
}

fn decrypt_vault_value(
    key: &[u8; VAULT_KEY_SIZE],
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> Result<Vec<u8>, String> {
    let nonce = BASE64_STANDARD
        .decode(nonce_b64)
        .map_err(|err| format!("Decode vault nonce failed: {err}"))?;
    if nonce.len() != VAULT_NONCE_SIZE {
        return Err("Vault nonce size invalid".to_string());
    }
    let ciphertext = BASE64_STANDARD
        .decode(ciphertext_b64)
        .map_err(|err| format!("Decode vault ciphertext failed: {err}"))?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|err| format!("Create vault cipher failed: {err}"))?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "Decrypt vault value failed. Wrong password or corrupted data.".to_string())
}

fn load_vault_file(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Option<VaultFile>, String> {
    let file = vault_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(path).map_err(|err| format!("Read vault file failed: {err}"))?;
    let vault = serde_json::from_str::<VaultFile>(&content)
        .map_err(|err| format!("Parse vault file failed: {err}"))?;
    Ok(Some(vault))
}

/// Load vault file as raw JSON string (for backup).
pub fn load_vault_file_raw(
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
) -> Result<Option<String>, String> {
    let file = vault_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(path).map_err(|err| format!("Read vault file failed: {err}"))?;
    Ok(Some(content))
}

/// Save vault file from raw JSON string (for restore).
pub fn save_vault_file_raw(
    app: &tauri::AppHandle,
    content: &str,
    vault_id: Option<&str>,
) -> Result<(), String> {
    let file = vault_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    fs::write(path, content).map_err(|err| format!("Write vault file failed: {err}"))
}

fn save_vault_file(
    app: &tauri::AppHandle,
    vault: &VaultFile,
    vault_id: Option<&str>,
) -> Result<(), String> {
    let file = vault_file_name(vault_id);
    let path = data_file_path(app, &file)?;
    write_json(&path, vault)
}

fn ensure_vault_id(vault_id: Option<&str>) -> String {
    vault_id
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_VAULT_ID)
        .to_string()
}

fn read_unlocked_vault_key(
    state: &tauri::State<'_, VaultState>,
    vault_id: &str,
) -> Result<[u8; VAULT_KEY_SIZE], String> {
    let guard = state
        .unlocked_keys
        .lock()
        .map_err(|_| "Vault state lock poisoned".to_string())?;
    guard
        .get(vault_id)
        .copied()
        .ok_or_else(|| "Vault is locked".to_string())
}

#[tauri::command]
pub fn vault_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    vault_id: Option<String>,
) -> Result<VaultStatus, String> {
    let vid = ensure_vault_id(vault_id.as_deref());
    let vault = load_vault_file(&app, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "status", err))?;
    let initialized = vault.is_some();
    let secret_count = vault.as_ref().map(|item| item.secrets.len()).unwrap_or(0);
    let unlocked = state
        .unlocked_keys
        .lock()
        .map_err(|_| standard_error_from_raw("vault", "status", "Vault state lock poisoned"))?
        .contains_key(&vid);
    Ok(VaultStatus {
        initialized,
        unlocked,
        secret_count,
    })
}

#[tauri::command]
pub fn vault_initialize(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    payload: VaultInitRequest,
) -> Result<VaultStatus, String> {
    if payload.master_password.trim().len() < 8 {
        return Err(standard_error_payload(
            "validation_error",
            "vault",
            false,
            "Master password must be at least 8 characters",
            None,
        ));
    }
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    if load_vault_file(&app, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "initialize", err))?
        .is_some()
    {
        return Err(standard_error_payload(
            "already_initialized",
            "vault",
            false,
            "Vault already initialized",
            None,
        ));
    }

    let salt = rand::random::<[u8; VAULT_SALT_SIZE]>();
    let key = derive_vault_key(&payload.master_password, &salt);
    let (verifier_nonce_b64, verifier_ciphertext_b64) =
        encrypt_vault_value(&key, VAULT_VERIFIER_PLAIN.as_bytes())
            .map_err(|err| standard_error_from_raw("vault", "initialize", err))?;
    let vault = VaultFile {
        initialized_at: now_unix_ms(),
        salt_b64: BASE64_STANDARD.encode(salt),
        verifier_nonce_b64,
        verifier_ciphertext_b64,
        secrets: HashMap::new(),
    };
    save_vault_file(&app, &vault, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "initialize", err))?;
    let mut guard = state
        .unlocked_keys
        .lock()
        .map_err(|_| standard_error_from_raw("vault", "initialize", "Vault state lock poisoned"))?;
    guard.insert(vid.clone(), key);
    Ok(VaultStatus {
        initialized: true,
        unlocked: true,
        secret_count: 0,
    })
}

#[tauri::command]
pub fn vault_unlock(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    payload: VaultUnlockRequest,
) -> Result<VaultStatus, String> {
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    let vault = load_vault_file(&app, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "unlock", err))?
        .ok_or_else(|| {
            standard_error_payload(
                "not_initialized",
                "vault",
                false,
                "Vault is not initialized",
                None,
            )
        })?;
    let salt = BASE64_STANDARD.decode(&vault.salt_b64).map_err(|err| {
        standard_error_from_raw(
            "vault",
            "unlock",
            format!("Decode vault salt failed: {err}"),
        )
    })?;
    let key = derive_vault_key(&payload.master_password, &salt);
    let verifier = decrypt_vault_value(
        &key,
        &vault.verifier_nonce_b64,
        &vault.verifier_ciphertext_b64,
    )
    .map_err(|err| standard_error_from_raw("vault", "unlock", err))?;
    if verifier != VAULT_VERIFIER_PLAIN.as_bytes() {
        return Err(standard_error_payload(
            "auth_failed",
            "vault",
            false,
            "Master password is incorrect",
            None,
        ));
    }
    let mut guard = state
        .unlocked_keys
        .lock()
        .map_err(|_| standard_error_from_raw("vault", "unlock", "Vault state lock poisoned"))?;
    guard.insert(vid.clone(), key);
    Ok(VaultStatus {
        initialized: true,
        unlocked: true,
        secret_count: vault.secrets.len(),
    })
}

#[tauri::command]
pub fn vault_lock(
    state: tauri::State<'_, VaultState>,
    vault_id: Option<String>,
) -> Result<VaultStatus, String> {
    let vid = ensure_vault_id(vault_id.as_deref());
    let mut guard = state
        .unlocked_keys
        .lock()
        .map_err(|_| standard_error_from_raw("vault", "lock", "Vault state lock poisoned"))?;
    guard.remove(&vid);
    Ok(VaultStatus {
        initialized: true,
        unlocked: false,
        secret_count: 0,
    })
}

#[tauri::command]
pub fn vault_set_secret(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    payload: VaultSetSecretRequest,
) -> Result<(), String> {
    if payload.key.trim().is_empty() {
        return Err(standard_error_payload(
            "validation_error",
            "vault",
            false,
            "Vault key is required",
            None,
        ));
    }
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    let key = read_unlocked_vault_key(&state, &vid)
        .map_err(|err| standard_error_from_raw("vault", "set secret", err))?;
    let mut vault = load_vault_file(&app, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "set secret", err))?
        .ok_or_else(|| {
            standard_error_payload(
                "not_initialized",
                "vault",
                false,
                "Vault is not initialized",
                None,
            )
        })?;
    let (nonce_b64, ciphertext_b64) = encrypt_vault_value(&key, payload.value.as_bytes())
        .map_err(|err| standard_error_from_raw("vault", "set secret", err))?;
    vault.secrets.insert(
        payload.key.trim().to_string(),
        VaultSecretRecord {
            nonce_b64,
            ciphertext_b64,
            updated_at: now_unix_ms(),
        },
    );
    save_vault_file(&app, &vault, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "set secret", err))
}

#[tauri::command]
pub fn vault_get_secret(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    payload: VaultSecretKeyRequest,
) -> Result<Option<String>, String> {
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    let key = read_unlocked_vault_key(&state, &vid)
        .map_err(|err| standard_error_from_raw("vault", "get secret", err))?;
    let vault = load_vault_file(&app, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "get secret", err))?
        .ok_or_else(|| {
            standard_error_payload(
                "not_initialized",
                "vault",
                false,
                "Vault is not initialized",
                None,
            )
        })?;
    let Some(record) = vault.secrets.get(payload.key.trim()) else {
        return Ok(None);
    };
    let plain = decrypt_vault_value(&key, &record.nonce_b64, &record.ciphertext_b64)
        .map_err(|err| standard_error_from_raw("vault", "get secret", err))?;
    String::from_utf8(plain).map(Some).map_err(|err| {
        standard_error_from_raw(
            "vault",
            "get secret",
            format!("Decode secret utf8 failed: {err}"),
        )
    })
}

/// Export all vault secrets as decrypted key-value pairs.
/// Requires vault to be unlocked. Used by P2P sync to transfer secrets.
pub fn vault_export_decrypted_secrets(
    app: &tauri::AppHandle,
    state: &VaultState,
    vault_id: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    let vid = ensure_vault_id(vault_id);
    let key = {
        let guard = state
            .unlocked_keys
            .lock()
            .map_err(|_| "Vault state lock poisoned".to_string())?;
        guard
            .get(&vid)
            .copied()
            .ok_or_else(|| "Vault is locked — unlock before syncing secrets".to_string())?
    };
    let vault =
        load_vault_file(app, Some(&vid))?.ok_or_else(|| "Vault is not initialized".to_string())?;
    let mut result = HashMap::new();
    for (secret_key, record) in &vault.secrets {
        let plain = decrypt_vault_value(&key, &record.nonce_b64, &record.ciphertext_b64)
            .map_err(|e| format!("decrypt secret '{}': {}", secret_key, e))?;
        let value = String::from_utf8(plain)
            .map_err(|e| format!("decode secret '{}': {}", secret_key, e))?;
        result.insert(secret_key.clone(), value);
    }
    Ok(result)
}

/// Import decrypted key-value pairs into the vault, encrypting with local key.
/// If the vault is not initialized, auto-creates one with a random key and keeps
/// it unlocked so the imported secrets are immediately accessible.
/// If the vault exists but is locked, returns an error.
/// Used by P2P sync to receive secrets.
pub fn vault_import_decrypted_secrets(
    app: &tauri::AppHandle,
    state: &VaultState,
    secrets: &HashMap<String, String>,
    vault_id: Option<&str>,
) -> Result<usize, String> {
    let vid = ensure_vault_id(vault_id);

    let existing_vault = load_vault_file(app, Some(&vid))?;
    let (key, mut vault) = if let Some(v) = existing_vault {
        // Vault exists — must be unlocked
        let k = {
            let guard = state
                .unlocked_keys
                .lock()
                .map_err(|_| "Vault state lock poisoned".to_string())?;
            guard
                .get(&vid)
                .copied()
                .ok_or_else(|| "Vault is locked — unlock before syncing secrets".to_string())?
        };
        (k, v)
    } else {
        // Vault not initialized — auto-create with a random key
        log::info!(
            "[vault] auto-initializing vault '{}' for sync import ({} secrets)",
            vid,
            secrets.len()
        );
        let salt = rand::random::<[u8; VAULT_SALT_SIZE]>();
        // Use a random 32-byte key directly (not derived from a password)
        let key = rand::random::<[u8; VAULT_KEY_SIZE]>();
        let (verifier_nonce_b64, verifier_ciphertext_b64) =
            encrypt_vault_value(&key, VAULT_VERIFIER_PLAIN.as_bytes())
                .map_err(|e| format!("auto-init vault verifier: {e}"))?;
        let v = VaultFile {
            initialized_at: now_unix_ms(),
            salt_b64: BASE64_STANDARD.encode(salt),
            verifier_nonce_b64,
            verifier_ciphertext_b64,
            secrets: HashMap::new(),
        };
        // Keep the vault unlocked in memory
        let mut guard = state
            .unlocked_keys
            .lock()
            .map_err(|_| "Vault state lock poisoned".to_string())?;
        guard.insert(vid.clone(), key);
        (key, v)
    };

    let mut count = 0usize;
    for (secret_key, plaintext) in secrets {
        let (nonce_b64, ciphertext_b64) = encrypt_vault_value(&key, plaintext.as_bytes())
            .map_err(|e| format!("encrypt secret '{}': {}", secret_key, e))?;
        vault.secrets.insert(
            secret_key.clone(),
            VaultSecretRecord {
                nonce_b64,
                ciphertext_b64,
                updated_at: now_unix_ms(),
            },
        );
        count += 1;
    }
    save_vault_file(app, &vault, Some(&vid))?;
    Ok(count)
}

#[tauri::command]
pub fn vault_delete_secret(
    app: tauri::AppHandle,
    payload: VaultSecretKeyRequest,
) -> Result<(), String> {
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    let mut vault = load_vault_file(&app, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "delete secret", err))?
        .ok_or_else(|| {
            standard_error_payload(
                "not_initialized",
                "vault",
                false,
                "Vault is not initialized",
                None,
            )
        })?;
    vault.secrets.remove(payload.key.trim());
    save_vault_file(&app, &vault, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "delete secret", err))
}

#[tauri::command]
pub fn vault_list_secret_keys(
    app: tauri::AppHandle,
    vault_id: Option<String>,
) -> Result<Vec<String>, String> {
    let vid = ensure_vault_id(vault_id.as_deref());
    let vault = load_vault_file(&app, Some(&vid))
        .map_err(|err| standard_error_from_raw("vault", "list secret keys", err))?
        .ok_or_else(|| {
            standard_error_payload(
                "not_initialized",
                "vault",
                false,
                "Vault is not initialized",
                None,
            )
        })?;
    let mut keys = vault.secrets.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    Ok(keys)
}
