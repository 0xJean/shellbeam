//! SSH key generation and import from file.

use serde::{Deserialize, Serialize};
use ssh_key::rand_core::OsRng;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::fs;
use std::path::Path;

use crate::error::standard_error_from_raw;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSshKeyResult {
    pub private_key: String,
    pub public_key: String,
}

/// Generate a new Ed25519 SSH key pair.
/// Returns private key (OpenSSH PEM) and public key (OpenSSH format).
#[tauri::command]
pub fn generate_ssh_key(comment: Option<String>) -> Result<GenerateSshKeyResult, String> {
    let mut rng = OsRng;
    let mut private_key = PrivateKey::random(&mut rng, Algorithm::Ed25519).map_err(|err| {
        standard_error_from_raw("keys", "generate", format!("Generate key failed: {err}"))
    })?;
    if let Some(c) = comment.filter(|s| !s.trim().is_empty()) {
        private_key.set_comment(c);
    }
    let private_pem = private_key.to_openssh(LineEnding::LF).map_err(|err| {
        standard_error_from_raw(
            "keys",
            "generate",
            format!("Encode private key failed: {err}"),
        )
    })?;
    let public_openssh = private_key.public_key().to_openssh().map_err(|err| {
        standard_error_from_raw(
            "keys",
            "generate",
            format!("Encode public key failed: {err}"),
        )
    })?;
    Ok(GenerateSshKeyResult {
        private_key: private_pem.to_string(),
        public_key: public_openssh.to_string(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPrivateKeyRequest {
    pub path: String,
}

/// Read private key content from a file path (user-selected via dialog).
/// Returns the raw file content for PEM or OpenSSH private keys.
#[tauri::command]
pub fn import_private_key_from_file(payload: ImportPrivateKeyRequest) -> Result<String, String> {
    let path = Path::new(payload.path.trim());
    if !path.exists() {
        return Err(standard_error_from_raw(
            "keys",
            "import",
            "File does not exist",
        ));
    }
    if !path.is_file() {
        return Err(standard_error_from_raw(
            "keys",
            "import",
            "Path is not a file",
        ));
    }
    let content = fs::read_to_string(path).map_err(|err| {
        standard_error_from_raw("keys", "import", format!("Read file failed: {err}"))
    })?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(standard_error_from_raw("keys", "import", "File is empty"));
    }
    // Basic validation: should look like a private key (PEM format)
    if !trimmed.contains("PRIVATE KEY") {
        return Err(standard_error_from_raw(
            "keys",
            "import",
            "File does not appear to be a valid SSH private key (expected PEM/OpenSSH format)",
        ));
    }
    Ok(content)
}
