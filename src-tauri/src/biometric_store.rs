//! Biometric password store — platform-specific implementations.
//!
//! macOS: AES-256-GCM encrypted file keyed to hardware UUID.
//! Touch ID auth is handled in the frontend via the biometry plugin.
//!
//! iOS/Android: The frontend uses the biometry plugin's native
//! keychain/keystore (setData/getData) directly — these Rust commands
//! are not called. We still register them so the invoke_handler compiles
//! on all platforms, but they return errors on non-macOS.

#[cfg(target_os = "macos")]
mod macos_impl {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;
    use pbkdf2::pbkdf2_hmac;
    use serde::{Deserialize, Serialize};
    use sha2::Sha256;

    use crate::storage::data_file_path;

    const BIO_FILE: &str = "biometric_store.json";
    const NONCE_SIZE: usize = 12;
    const KEY_SIZE: usize = 32;
    const PBKDF2_ITERS: u32 = 100_000;
    const APP_SALT: &[u8] = b"shellbeam-biometric-v1";

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BioStore {
        nonce_b64: String,
        ciphertext_b64: String,
    }

    fn derive_key() -> Result<[u8; KEY_SIZE], String> {
        let hw_uuid = get_hardware_uuid()?;
        let mut key = [0u8; KEY_SIZE];
        pbkdf2_hmac::<Sha256>(hw_uuid.as_bytes(), APP_SALT, PBKDF2_ITERS, &mut key);
        Ok(key)
    }

    fn get_hardware_uuid() -> Result<String, String> {
        let output = std::process::Command::new("sysctl")
            .arg("-n")
            .arg("kern.uuid")
            .output()
            .map_err(|e| format!("Failed to read hardware UUID: {e}"))?;
        if !output.status.success() {
            return Err("sysctl kern.uuid failed".into());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn bio_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        data_file_path(app, BIO_FILE)
    }

    pub fn store_password(app: &tauri::AppHandle, password: String) -> Result<(), String> {
        let key = derive_key()?;
        let cipher =
            Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Create cipher failed: {e}"))?;
        let nonce_bytes = rand::random::<[u8; NONCE_SIZE]>();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), password.as_bytes())
            .map_err(|_| "Encrypt password failed".to_string())?;
        let store = BioStore {
            nonce_b64: BASE64_STANDARD.encode(nonce_bytes),
            ciphertext_b64: BASE64_STANDARD.encode(ciphertext),
        };
        let json = serde_json::to_string_pretty(&store)
            .map_err(|e| format!("Serialize bio store failed: {e}"))?;
        let path = bio_path(app)?;
        std::fs::write(&path, json).map_err(|e| format!("Write bio store failed: {e}"))
    }

    pub fn retrieve_password(app: &tauri::AppHandle) -> Result<String, String> {
        let path = bio_path(app)?;
        if !path.exists() {
            return Err("itemNotFound".into());
        }
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("Read bio store failed: {e}"))?;
        let store: BioStore =
            serde_json::from_str(&json).map_err(|e| format!("Parse bio store failed: {e}"))?;
        let key = derive_key()?;
        let nonce = BASE64_STANDARD
            .decode(&store.nonce_b64)
            .map_err(|e| format!("Decode nonce failed: {e}"))?;
        let ciphertext = BASE64_STANDARD
            .decode(&store.ciphertext_b64)
            .map_err(|e| format!("Decode ciphertext failed: {e}"))?;
        let cipher =
            Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Create cipher failed: {e}"))?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| "Decrypt password failed".to_string())?;
        String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8: {e}"))
    }

    pub fn has_password(app: &tauri::AppHandle) -> Result<bool, String> {
        let path = bio_path(app)?;
        Ok(path.exists())
    }

    pub fn remove_password(app: &tauri::AppHandle) -> Result<(), String> {
        let path = bio_path(app)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("Remove bio store failed: {e}"))?;
        }
        Ok(())
    }
}

// ── Tauri commands (all platforms) ──

#[tauri::command]
pub fn biometric_store_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { return macos_impl::store_password(&app, password); }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, password); Err("Use native biometric plugin on this platform".into()) }
}

#[tauri::command]
pub fn biometric_retrieve_password(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    { return macos_impl::retrieve_password(&app); }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Err("Use native biometric plugin on this platform".into()) }
}

#[tauri::command]
pub fn biometric_has_password(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    { return macos_impl::has_password(&app); }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Err("Use native biometric plugin on this platform".into()) }
}

#[tauri::command]
pub fn biometric_remove_password(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { return macos_impl::remove_password(&app); }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Err("Use native biometric plugin on this platform".into()) }
}
