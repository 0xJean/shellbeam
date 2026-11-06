//! Seal app data that lives outside the Vault file (for example AI
//! conversations kept in the webview's storage) with a key only an unlocked
//! Vault can produce.
//!
//! Each purpose gets its own subkey, derived from the Vault key with HKDF, so
//! data sealed for one feature can never be opened as another's. The caller's
//! context (for example which host a conversation belongs to) is bound as
//! associated data: a sealed value moved to another context does not open.
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use hkdf::Hkdf;
use serde::Deserialize;
use sha2::Sha256;

use super::secrets::{ensure_vault_id, read_unlocked_vault_key, VaultState, VAULT_KEY_SIZE};
use crate::error::{standard_error_from_raw, standard_error_payload};

const SEAL_VERSION: &str = "sb1";
const NONCE_SIZE: usize = 12;
const MAX_PURPOSE_LEN: usize = 64;
const MAX_CONTEXT_LEN: usize = 512;
/// Sealed values are kept in the webview's storage, which is small.
const MAX_PLAINTEXT_LEN: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSealRequest {
    vault_id: Option<String>,
    purpose: String,
    context: String,
    plaintext: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenRequest {
    vault_id: Option<String>,
    purpose: String,
    context: String,
    sealed: String,
}

fn validate_purpose(purpose: &str) -> Result<(), String> {
    let valid = !purpose.is_empty()
        && purpose.len() <= MAX_PURPOSE_LEN
        && purpose
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err("Seal purpose must be 1-64 characters of a-z, 0-9, '.' or '-'".into())
    }
}

fn validate_context(context: &str) -> Result<(), String> {
    if context.len() > MAX_CONTEXT_LEN {
        return Err("Seal context is too long".into());
    }
    Ok(())
}

fn subkey(vault_key: &[u8; VAULT_KEY_SIZE], purpose: &str) -> Result<[u8; 32], String> {
    let info = format!("shellbeam/vault-seal/{SEAL_VERSION}/{purpose}");
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, vault_key)
        .expand(info.as_bytes(), &mut out)
        .map_err(|_| "Derive seal key failed".to_string())?;
    Ok(out)
}

pub(crate) fn seal_with_key(
    vault_key: &[u8; VAULT_KEY_SIZE],
    purpose: &str,
    context: &str,
    plaintext: &str,
) -> Result<String, String> {
    validate_purpose(purpose)?;
    validate_context(context)?;
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err("Value is too large to seal".into());
    }
    let key = subkey(vault_key, purpose)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| "Create seal cipher failed".to_string())?;
    let nonce = rand::random::<[u8; NONCE_SIZE]>();
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| "Seal value failed".to_string())?;
    Ok(format!(
        "{SEAL_VERSION}:{}:{}",
        BASE64_STANDARD.encode(nonce),
        BASE64_STANDARD.encode(ciphertext)
    ))
}

pub(crate) fn open_with_key(
    vault_key: &[u8; VAULT_KEY_SIZE],
    purpose: &str,
    context: &str,
    sealed: &str,
) -> Result<String, String> {
    validate_purpose(purpose)?;
    validate_context(context)?;
    let mut parts = sealed.splitn(3, ':');
    let (Some(version), Some(nonce_b64), Some(ciphertext_b64)) =
        (parts.next(), parts.next(), parts.next())
    else {
        return Err("Sealed value is malformed".into());
    };
    if version != SEAL_VERSION {
        return Err("Sealed value version is not supported".into());
    }
    let nonce = BASE64_STANDARD
        .decode(nonce_b64)
        .map_err(|_| "Sealed value is malformed".to_string())?;
    if nonce.len() != NONCE_SIZE {
        return Err("Sealed value is malformed".into());
    }
    let ciphertext = BASE64_STANDARD
        .decode(ciphertext_b64)
        .map_err(|_| "Sealed value is malformed".to_string())?;
    let key = subkey(vault_key, purpose)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| "Create seal cipher failed".to_string())?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| "Sealed value does not open with this Vault".to_string())?;
    String::from_utf8(plain).map_err(|_| "Sealed value is not text".into())
}

fn validation_error(message: String) -> String {
    standard_error_payload("validation_error", "vault", false, &message, None)
}

#[tauri::command]
pub fn vault_seal_data(
    state: tauri::State<'_, VaultState>,
    payload: VaultSealRequest,
) -> Result<String, String> {
    validate_purpose(&payload.purpose).map_err(validation_error)?;
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    let key = read_unlocked_vault_key(&state, &vid)
        .map_err(|err| standard_error_from_raw("vault", "seal data", err))?;
    seal_with_key(&key, &payload.purpose, &payload.context, &payload.plaintext)
        .map_err(|err| standard_error_from_raw("vault", "seal data", err))
}

#[tauri::command]
pub fn vault_open_data(
    state: tauri::State<'_, VaultState>,
    payload: VaultOpenRequest,
) -> Result<String, String> {
    validate_purpose(&payload.purpose).map_err(validation_error)?;
    let vid = ensure_vault_id(payload.vault_id.as_deref());
    let key = read_unlocked_vault_key(&state, &vid)
        .map_err(|err| standard_error_from_raw("vault", "open data", err))?;
    open_with_key(&key, &payload.purpose, &payload.context, &payload.sealed)
        .map_err(|err| standard_error_from_raw("vault", "open data", err))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: [u8; VAULT_KEY_SIZE] = [7; VAULT_KEY_SIZE];
    const KEY_B: [u8; VAULT_KEY_SIZE] = [9; VAULT_KEY_SIZE];

    #[test]
    fn round_trips_and_hides_the_plaintext() {
        let plain = "{\"turns\":[\"df -h\"]}";
        let sealed = seal_with_key(&KEY_A, "ai.conversation", "root@10.0.0.5", plain).unwrap();
        assert!(sealed.starts_with("sb1:"));
        assert!(!sealed.contains("df -h"));
        assert_eq!(
            open_with_key(&KEY_A, "ai.conversation", "root@10.0.0.5", &sealed).unwrap(),
            plain
        );
    }

    #[test]
    fn does_not_open_with_another_vault_purpose_or_context() {
        let sealed = seal_with_key(&KEY_A, "ai.conversation", "root@a", "secret").unwrap();
        assert!(open_with_key(&KEY_B, "ai.conversation", "root@a", &sealed).is_err());
        assert!(open_with_key(&KEY_A, "ai.settings", "root@a", &sealed).is_err());
        assert!(open_with_key(&KEY_A, "ai.conversation", "root@b", &sealed).is_err());
    }

    #[test]
    fn rejects_tampered_or_malformed_values() {
        let sealed = seal_with_key(&KEY_A, "ai.conversation", "", "secret").unwrap();
        let mut tampered = sealed.clone().into_bytes();
        let last = tampered.len() - 2;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(open_with_key(&KEY_A, "ai.conversation", "", &tampered).is_err());
        assert!(open_with_key(&KEY_A, "ai.conversation", "", "plain text").is_err());
        assert!(open_with_key(&KEY_A, "ai.conversation", "", "sb0:AAAA:AAAA").is_err());
    }

    #[test]
    fn nonces_are_fresh_for_every_seal() {
        let a = seal_with_key(&KEY_A, "ai.conversation", "", "same").unwrap();
        let b = seal_with_key(&KEY_A, "ai.conversation", "", "same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn validates_purpose_and_sizes() {
        assert!(seal_with_key(&KEY_A, "", "", "x").is_err());
        assert!(seal_with_key(&KEY_A, "AI/Conversation", "", "x").is_err());
        assert!(seal_with_key(&KEY_A, "ai", &"c".repeat(MAX_CONTEXT_LEN + 1), "x").is_err());
        assert!(seal_with_key(&KEY_A, "ai", "", &"x".repeat(MAX_PLAINTEXT_LEN + 1)).is_err());
    }
}
