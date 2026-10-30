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
    session_generation: std::sync::atomic::AtomicU64,
    unlocked_keys: Mutex<std::collections::HashMap<String, [u8; VAULT_KEY_SIZE]>>,
}

impl VaultState {
    pub(crate) fn session_generation(&self) -> u64 {
        self.session_generation
            .load(std::sync::atomic::Ordering::SeqCst)
    }
    pub(crate) fn is_unlocked(&self, vault_id: &str) -> bool {
        self.unlocked_keys
            .lock()
            .map(|keys| keys.contains_key(vault_id))
            .unwrap_or(false)
    }

    /// Drop a Vault's key from memory (used when the Vault is deleted).
    pub(crate) fn forget(&self, vault_id: &str) -> Result<(), String> {
        self.unlocked_keys
            .lock()
            .map_err(|_| "Vault state lock poisoned".to_string())?
            .remove(vault_id);
        self.session_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// Linearize a short local persistence transaction against Vault locking.
    /// The callback must not perform remote work or re-enter VaultState.
    pub(crate) fn while_unlocked<T>(
        &self,
        vault_id: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self
            .unlocked_keys
            .lock()
            .map_err(|_| "VAULT_LOCKED".to_string())?;
        if !guard.contains_key(vault_id) {
            return Err("VAULT_LOCKED".into());
        }
        let result = operation();
        drop(guard);
        result
    }

    /// `while_unlocked` for several Vaults at once (e.g. moving hosts between two).
    pub(crate) fn while_all_unlocked<T>(
        &self,
        vault_ids: &[&str],
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self
            .unlocked_keys
            .lock()
            .map_err(|_| "VAULT_LOCKED".to_string())?;
        if vault_ids.iter().any(|id| !guard.contains_key(*id)) {
            return Err("VAULT_LOCKED".into());
        }
        let result = operation();
        drop(guard);
        result
    }
}

/// How a source key compares with a key name in another Vault. Values never
/// leave this module; callers only learn whether they are equal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SecretMatch {
    /// The source Vault has no such key (a dangling reference).
    MissingInSource,
    /// The target Vault has no key with that name yet.
    AbsentInTarget,
    Same,
    Different,
}

/// Whether the Vault has a master password (a vault file) yet.
pub(crate) fn is_initialized(app: &tauri::AppHandle, vault_id: &str) -> Result<bool, String> {
    Ok(load_vault_file(app, Some(vault_id))?.is_some())
}

/// Key names only; works while locked.
pub(crate) fn secret_key_names(
    app: &tauri::AppHandle,
    vault_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    Ok(load_vault_file(app, Some(vault_id))?
        .map(|file| file.secrets.into_keys().collect())
        .unwrap_or_default())
}

fn decrypt_record(
    key: &[u8; VAULT_KEY_SIZE],
    record: &VaultSecretRecord,
) -> Result<Vec<u8>, String> {
    decrypt_vault_value(key, &record.nonce_b64, &record.ciphertext_b64)
}

/// Compare `(source key, target key)` pairs across two unlocked Vaults.
pub(crate) fn compare_secrets(
    app: &tauri::AppHandle,
    state: &VaultState,
    source: &str,
    target: &str,
    pairs: &[(String, String)],
) -> Result<Vec<SecretMatch>, String> {
    let keys = state
        .unlocked_keys
        .lock()
        .map_err(|_| "Vault state lock poisoned")?;
    let source_key = keys.get(source).ok_or("VAULT_LOCKED")?;
    let target_key = keys.get(target).ok_or("VAULT_LOCKED")?;
    let source_file = load_vault_file(app, Some(source))?.ok_or("Vault is not initialized")?;
    let target_file = load_vault_file(app, Some(target))?;
    let mut result = Vec::with_capacity(pairs.len());
    for (from, to) in pairs {
        let Some(record) = source_file.secrets.get(from) else {
            result.push(SecretMatch::MissingInSource);
            continue;
        };
        let Some(existing) = target_file.as_ref().and_then(|file| file.secrets.get(to)) else {
            result.push(SecretMatch::AbsentInTarget);
            continue;
        };
        let same = decrypt_record(source_key, record)? == decrypt_record(target_key, existing)?;
        result.push(if same {
            SecretMatch::Same
        } else {
            SecretMatch::Different
        });
    }
    Ok(result)
}

/// Copy `(source key, target key)` pairs into the target Vault. Additive: an
/// existing target key with the same value is kept, a different one refuses.
pub(crate) fn copy_secrets(
    app: &tauri::AppHandle,
    state: &VaultState,
    source: &str,
    target: &str,
    pairs: &[(String, String)],
) -> Result<usize, String> {
    let keys = state
        .unlocked_keys
        .lock()
        .map_err(|_| "Vault state lock poisoned")?;
    let source_key = keys.get(source).ok_or("VAULT_LOCKED")?;
    let target_key = keys.get(target).ok_or("VAULT_LOCKED")?;
    let source_file = load_vault_file(app, Some(source))?.ok_or("Vault is not initialized")?;
    let mut target_file = load_vault_file(app, Some(target))?.ok_or("Vault is not initialized")?;
    let copied = copy_records(
        &source_file,
        source_key,
        &mut target_file,
        target_key,
        pairs,
    )?;
    if copied > 0 {
        save_vault_file(app, &target_file, Some(target))?;
    }
    Ok(copied)
}

fn copy_records(
    source_file: &VaultFile,
    source_key: &[u8; VAULT_KEY_SIZE],
    target_file: &mut VaultFile,
    target_key: &[u8; VAULT_KEY_SIZE],
    pairs: &[(String, String)],
) -> Result<usize, String> {
    let mut copied = 0;
    for (from, to) in pairs {
        let Some(record) = source_file.secrets.get(from) else {
            continue;
        };
        let plain = decrypt_record(source_key, record)?;
        if let Some(existing) = target_file.secrets.get(to) {
            if decrypt_record(target_key, existing)? != plain {
                return Err(format!("SECRET_NAME_TAKEN: {to}"));
            }
            continue;
        }
        let (nonce_b64, ciphertext_b64) = encrypt_vault_value(target_key, &plain)?;
        target_file.secrets.insert(
            to.clone(),
            VaultSecretRecord {
                nonce_b64,
                ciphertext_b64,
                updated_at: now_unix_ms(),
            },
        );
        copied += 1;
    }
    Ok(copied)
}

/// Delete source keys of `(source key, target key)` pairs, but only those whose
/// value the target already holds under the target name.
pub(crate) fn delete_copied_secrets(
    app: &tauri::AppHandle,
    state: &VaultState,
    source: &str,
    target: &str,
    pairs: &[(String, String)],
) -> Result<usize, String> {
    let keys = state
        .unlocked_keys
        .lock()
        .map_err(|_| "Vault state lock poisoned")?;
    let source_key = keys.get(source).ok_or("VAULT_LOCKED")?;
    let target_key = keys.get(target).ok_or("VAULT_LOCKED")?;
    let Some(mut source_file) = load_vault_file(app, Some(source))? else {
        return Ok(0);
    };
    let target_file = load_vault_file(app, Some(target))?.ok_or("Vault is not initialized")?;
    let deleted = delete_records(
        &mut source_file,
        source_key,
        &target_file,
        target_key,
        pairs,
    )?;
    if deleted > 0 {
        save_vault_file(app, &source_file, Some(source))?;
    }
    Ok(deleted)
}

fn delete_records(
    source_file: &mut VaultFile,
    source_key: &[u8; VAULT_KEY_SIZE],
    target_file: &VaultFile,
    target_key: &[u8; VAULT_KEY_SIZE],
    pairs: &[(String, String)],
) -> Result<usize, String> {
    let mut deleted = 0;
    for (from, to) in pairs {
        let (Some(record), Some(existing)) =
            (source_file.secrets.get(from), target_file.secrets.get(to))
        else {
            continue;
        };
        if decrypt_record(source_key, record)? == decrypt_record(target_key, existing)? {
            source_file.secrets.remove(from);
            deleted += 1;
        }
    }
    Ok(deleted)
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
    state: &VaultState,
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
    state
        .session_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
    let generation = state.session_generation();
    set_secret_in_session(
        &app,
        &state,
        &ensure_vault_id(payload.vault_id.as_deref()),
        &payload.key,
        &payload.value,
        generation,
    )
    .map_err(|error| standard_error_from_raw("vault", "set secret", error))
}

/// Serialize secret writes with locking and reject A -> B -> A completions.
pub(crate) fn set_secret_in_session(
    app: &tauri::AppHandle,
    state: &VaultState,
    vid: &str,
    secret_ref: &str,
    value: &str,
    generation: u64,
) -> Result<(), String> {
    if secret_ref.trim().is_empty() {
        return Err("Vault key is required".into());
    }
    let keys = state
        .unlocked_keys
        .lock()
        .map_err(|_| "Vault state lock poisoned")?;
    if state.session_generation() != generation {
        return Err("MONITORING_SCOPE_CHANGED".into());
    }
    let key = keys.get(vid).ok_or("Vault is locked")?;
    let mut file = load_vault_file(app, Some(vid))?.ok_or("Vault is not initialized")?;
    let (nonce_b64, ciphertext_b64) = encrypt_vault_value(key, value.as_bytes())?;
    file.secrets.insert(
        secret_ref.trim().to_string(),
        VaultSecretRecord {
            nonce_b64,
            ciphertext_b64,
            updated_at: now_unix_ms(),
        },
    );
    save_vault_file(app, &file, Some(vid))
}

#[tauri::command]
pub fn vault_get_secret(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    payload: VaultSecretKeyRequest,
) -> Result<Option<String>, String> {
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    get_secret_value(&app, &state, &vid, &payload.key)
}

pub(crate) fn get_secret_value(
    app: &tauri::AppHandle,
    state: &VaultState,
    vid: &str,
    secret_ref: &str,
) -> Result<Option<String>, String> {
    let key = read_unlocked_vault_key(state, vid)
        .map_err(|err| standard_error_from_raw("vault", "get secret", err))?;
    let vault = load_vault_file(app, Some(vid))
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
    let Some(record) = vault.secrets.get(secret_ref.trim()) else {
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

/// Encrypt pending remote edits without placing channel credentials in the
/// operation database or audit. The Vault remains the only key authority.
pub(crate) fn seal_operation_value(
    state: &VaultState,
    vault_id: &str,
    value: &str,
) -> Result<String, String> {
    let key = read_unlocked_vault_key(state, vault_id)?;
    let (nonce, ciphertext) = encrypt_vault_value(&key, value.as_bytes())?;
    serde_json::to_string(&(nonce, ciphertext)).map_err(|_| "MONITORING_STORAGE".into())
}

pub(crate) fn open_operation_value(
    state: &VaultState,
    vault_id: &str,
    value: &str,
) -> Result<String, String> {
    let key = read_unlocked_vault_key(state, vault_id)?;
    let (nonce, ciphertext): (String, String) =
        serde_json::from_str(value).map_err(|_| "MONITORING_STORAGE")?;
    let plain = decrypt_vault_value(&key, &nonce, &ciphertext)?;
    String::from_utf8(plain).map_err(|_| "MONITORING_STORAGE".into())
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

#[cfg(test)]
mod unlocked_transaction_tests {
    use super::*;

    #[test]
    fn operation_values_are_authenticated_encrypted_and_vault_scoped() {
        let state = VaultState::default();
        state
            .unlocked_keys
            .lock()
            .unwrap()
            .insert("a".into(), [1; VAULT_KEY_SIZE]);
        state
            .unlocked_keys
            .lock()
            .unwrap()
            .insert("b".into(), [2; VAULT_KEY_SIZE]);
        let plain = "synthetic-channel-password";
        let sealed = seal_operation_value(&state, "a", plain).unwrap();
        assert!(!sealed.contains(plain));
        assert_eq!(open_operation_value(&state, "a", &sealed).unwrap(), plain);
        assert!(open_operation_value(&state, "b", &sealed).is_err());
        state.unlocked_keys.lock().unwrap().remove("a");
        assert!(open_operation_value(&state, "a", &sealed).is_err());
    }

    #[test]
    fn locked_or_different_vault_never_runs_the_persistence_callback() {
        let state = VaultState::default();
        state
            .unlocked_keys
            .lock()
            .unwrap()
            .insert("vault-a".into(), [0; VAULT_KEY_SIZE]);
        let ran = std::cell::Cell::new(false);
        let result = state.while_unlocked("vault-b", || {
            ran.set(true);
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "VAULT_LOCKED");
        assert!(!ran.get());
        assert!(state.while_unlocked("vault-a", || Ok(())).is_ok());
    }

    #[test]
    fn vault_lock_waits_for_the_local_transaction_to_finish() {
        let state = std::sync::Arc::new(VaultState::default());
        state
            .unlocked_keys
            .lock()
            .unwrap()
            .insert("vault-a".into(), [0; VAULT_KEY_SIZE]);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let transaction_state = state.clone();
        let transaction = std::thread::spawn(move || {
            transaction_state.while_unlocked("vault-a", || {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Ok(())
            })
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let lock_state = state.clone();
        let locking = std::thread::spawn(move || {
            lock_state.unlocked_keys.lock().unwrap().remove("vault-a");
            locked_tx.send(()).unwrap();
        });
        assert!(locked_rx
            .recv_timeout(std::time::Duration::from_millis(20))
            .is_err());
        release_tx.send(()).unwrap();
        assert!(transaction.join().unwrap().is_ok());
        locking.join().unwrap();
        locked_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(!state.is_unlocked("vault-a"));
    }
}

#[cfg(test)]
mod host_move_secret_tests {
    use super::*;

    fn file(key: &[u8; VAULT_KEY_SIZE], entries: &[(&str, &str)]) -> VaultFile {
        let mut secrets = HashMap::new();
        for (name, value) in entries {
            let (nonce_b64, ciphertext_b64) = encrypt_vault_value(key, value.as_bytes()).unwrap();
            secrets.insert(
                name.to_string(),
                VaultSecretRecord {
                    nonce_b64,
                    ciphertext_b64,
                    updated_at: 0,
                },
            );
        }
        VaultFile {
            initialized_at: 0,
            salt_b64: String::new(),
            verifier_nonce_b64: String::new(),
            verifier_ciphertext_b64: String::new(),
            secrets,
        }
    }

    fn value(file: &VaultFile, key: &[u8; VAULT_KEY_SIZE], name: &str) -> Option<String> {
        file.secrets
            .get(name)
            .map(|record| String::from_utf8(decrypt_record(key, record).unwrap()).unwrap())
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn copy_re_encrypts_for_the_target_and_keeps_existing_equal_keys() {
        let (sk, tk) = ([1u8; VAULT_KEY_SIZE], [2u8; VAULT_KEY_SIZE]);
        let source = file(&sk, &[("pw", "alpha"), ("key", "beta"), ("shared", "same")]);
        let mut target = file(&tk, &[("shared", "same"), ("pw", "other")]);
        let copied = copy_records(
            &source,
            &sk,
            &mut target,
            &tk,
            &pairs(&[
                ("pw", "pw-moved-abc123"),
                ("key", "key"),
                ("shared", "shared"),
                ("gone", "gone"),
            ]),
        )
        .unwrap();
        assert_eq!(copied, 2);
        assert_eq!(
            value(&target, &tk, "pw-moved-abc123").as_deref(),
            Some("alpha")
        );
        assert_eq!(value(&target, &tk, "key").as_deref(), Some("beta"));
        assert_eq!(value(&target, &tk, "pw").as_deref(), Some("other"));
        assert!(target.secrets.get("gone").is_none());
    }

    #[test]
    fn copy_refuses_a_taken_name_with_a_different_value() {
        let (sk, tk) = ([1u8; VAULT_KEY_SIZE], [2u8; VAULT_KEY_SIZE]);
        let source = file(&sk, &[("pw", "alpha")]);
        let mut target = file(&tk, &[("pw", "other")]);
        let error =
            copy_records(&source, &sk, &mut target, &tk, &pairs(&[("pw", "pw")])).unwrap_err();
        assert!(error.starts_with("SECRET_NAME_TAKEN"));
        assert_eq!(value(&target, &tk, "pw").as_deref(), Some("other"));
    }

    #[test]
    fn delete_only_removes_source_keys_the_target_holds_with_the_same_value() {
        let (sk, tk) = ([1u8; VAULT_KEY_SIZE], [2u8; VAULT_KEY_SIZE]);
        let mut source = file(&sk, &[("a", "1"), ("b", "2"), ("c", "3")]);
        let target = file(&tk, &[("a-moved", "1"), ("b", "changed")]);
        let deleted = delete_records(
            &mut source,
            &sk,
            &target,
            &tk,
            &pairs(&[("a", "a-moved"), ("b", "b"), ("c", "c")]),
        )
        .unwrap();
        assert_eq!(deleted, 1);
        assert!(source.secrets.get("a").is_none());
        assert_eq!(value(&source, &sk, "b").as_deref(), Some("2"));
        assert_eq!(value(&source, &sk, "c").as_deref(), Some("3"));
    }
}
