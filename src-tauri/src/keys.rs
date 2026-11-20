//! SSH key generation and import from file.

use serde::{Deserialize, Serialize};
use ssh_key::rand_core::OsRng;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::fs;
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedSshPrivateKey {
    pub content: String,
    pub file_name: String,
}

fn is_public_key_content(trimmed: &str) -> bool {
    if trimmed.contains("PRIVATE KEY") {
        return false;
    }
    let first = trimmed.lines().next().unwrap_or("").trim();
    [
        "ssh-rsa ",
        "ssh-ed25519 ",
        "ssh-dss ",
        "ecdsa-sha2-nistp256 ",
        "ecdsa-sha2-nistp384 ",
        "ecdsa-sha2-nistp521 ",
        "sk-ssh-ed25519@openssh.com ",
        "sk-ecdsa-sha2-nistp256@openssh.com ",
    ]
    .iter()
    .any(|prefix| first.starts_with(prefix))
}

fn default_ssh_dir_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let ssh_dir = home.join(".ssh");
    if ssh_dir.is_dir() {
        Some(ssh_dir)
    } else {
        Some(home)
    }
}

fn read_private_key_file(path: &Path) -> Result<PickedSshPrivateKey, String> {
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
    let is_pub_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pub"));
    if is_pub_ext || is_public_key_content(trimmed) {
        let sibling_hint = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".pub"))
            .filter(|base| path.with_file_name(base).is_file())
            .map(|base| format!(" Please select the matching private key file '{base}' instead."))
            .unwrap_or_else(|| {
                " Please select the matching private key file (without .pub).".to_string()
            });
        return Err(standard_error_from_raw(
            "keys",
            "import",
            format!(
                "Selected file is a public key (.pub), which cannot be used to sign in.{sibling_hint}"
            ),
        ));
    }
    // Basic validation: should look like a private key (PEM/OpenSSH format)
    if !trimmed.contains("PRIVATE KEY") {
        return Err(standard_error_from_raw(
            "keys",
            "import",
            "File does not appear to be a valid SSH private key (expected PEM/OpenSSH format)",
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("ssh-key")
        .to_string();
    Ok(PickedSshPrivateKey { content, file_name })
}

/// Return the default SSH key directory (~/.ssh on macOS/Linux, %USERPROFILE%\.ssh on Windows).
#[tauri::command]
pub fn default_ssh_dir() -> Option<String> {
    default_ssh_dir_path().map(|p| p.to_string_lossy().to_string())
}

/// Read private key content from a file path (user-selected via dialog).
/// Returns the raw file content for PEM or OpenSSH private keys.
#[tauri::command]
pub fn import_private_key_from_file(payload: ImportPrivateKeyRequest) -> Result<String, String> {
    let path = Path::new(payload.path.trim());
    Ok(read_private_key_file(path)?.content)
}

#[cfg(target_os = "macos")]
fn pick_key_path_macos(default_dir: Option<&Path>) -> Result<Option<PathBuf>, String> {
    use objc::runtime::{Class, Object, NO, YES};
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;

    unsafe {
        let panel_cls =
            Class::get("NSOpenPanel").ok_or_else(|| "NSOpenPanel unavailable".to_string())?;
        let panel: *mut Object = msg_send![panel_cls, openPanel];
        if panel.is_null() {
            return Err("Failed to create NSOpenPanel".to_string());
        }
        let _: () = msg_send![panel, setCanChooseFiles: YES];
        let _: () = msg_send![panel, setCanChooseDirectories: NO];
        let _: () = msg_send![panel, setAllowsMultipleSelection: NO];
        let _: () = msg_send![panel, setShowsHiddenFiles: YES];
        let _: () = msg_send![panel, setTreatsFilePackagesAsDirectories: YES];

        if let Some(dir) = default_dir.and_then(|p| p.to_str()) {
            if let Ok(c_dir) = CString::new(dir) {
                if let (Some(nsstr_cls), Some(nsurl_cls)) =
                    (Class::get("NSString"), Class::get("NSURL"))
                {
                    let ns_path: *mut Object =
                        msg_send![nsstr_cls, stringWithUTF8String: c_dir.as_ptr()];
                    if !ns_path.is_null() {
                        let url: *mut Object =
                            msg_send![nsurl_cls, fileURLWithPath: ns_path isDirectory: YES];
                        if !url.is_null() {
                            let _: () = msg_send![panel, setDirectoryURL: url];
                        }
                    }
                }
            }
        }

        let response: isize = msg_send![panel, runModal];
        if response != 1 {
            return Ok(None);
        }
        let url: *mut Object = msg_send![panel, URL];
        if url.is_null() {
            return Ok(None);
        }
        let path_obj: *mut Object = msg_send![url, path];
        if path_obj.is_null() {
            return Ok(None);
        }
        let c_str: *const c_char = msg_send![path_obj, UTF8String];
        if c_str.is_null() {
            return Ok(None);
        }
        let selected = CStr::from_ptr(c_str).to_string_lossy().into_owned();
        Ok(Some(PathBuf::from(selected)))
    }
}

/// Open a native file picker defaulted to the OS SSH key folder (~/.ssh on macOS/Linux,
/// %USERPROFILE%\.ssh on Windows) with hidden files shown on macOS and no restrictive
/// extension filters so extensionless keys like id_rsa / id_ed25519 can be chosen directly.
#[tauri::command]
pub async fn pick_ssh_private_key_file(
    app: tauri::AppHandle,
) -> Result<Option<PickedSshPrivateKey>, String> {
    #[cfg(target_os = "macos")]
    let picked_path: Option<PathBuf> = {
        let default_dir = default_ssh_dir_path();
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(pick_key_path_macos(default_dir.as_deref()));
        })
        .map_err(|err| {
            standard_error_from_raw("keys", "import", format!("Open file picker failed: {err}"))
        })?;
        tauri::async_runtime::spawn_blocking(move || rx.recv())
            .await
            .map_err(|_| standard_error_from_raw("keys", "import", "File picker failed"))?
            .map_err(|_| standard_error_from_raw("keys", "import", "File picker cancelled"))?
            .map_err(|err| standard_error_from_raw("keys", "import", err))?
    };

    #[cfg(not(target_os = "macos"))]
    let picked_path: Option<PathBuf> = {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file().set_title("Select SSH private key");
        if let Some(dir) = default_ssh_dir_path() {
            dialog = dialog.set_directory(dir);
        }
        let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
            .await
            .map_err(|_| standard_error_from_raw("keys", "import", "File picker failed"))?;
        match selected {
            Some(file_path) => file_path.into_path().ok(),
            None => None,
        }
    };

    match picked_path {
        Some(path) => Ok(Some(read_private_key_file(&path)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_public_key_files_and_points_to_sibling_private_key() {
        let dir =
            std::env::temp_dir().join(format!("shellbeam-keys-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let priv_path = dir.join("id_rsa");
        let pub_path = dir.join("id_rsa.pub");
        fs::write(
            &priv_path,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        fs::write(&pub_path, "ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB test@host\n").unwrap();

        let err = read_private_key_file(&pub_path).unwrap_err();
        assert!(err.contains("public key (.pub)"), "{err}");
        assert!(err.contains("id_rsa"), "{err}");

        let ok = read_private_key_file(&priv_path).unwrap();
        assert_eq!(ok.file_name, "id_rsa");
        assert!(ok.content.contains("PRIVATE KEY"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_openssh_public_key_text_without_pub_extension() {
        assert!(is_public_key_content(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 user@host"
        ));
        assert!(is_public_key_content(
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB user@host"
        ));
        assert!(!is_public_key_content(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n-----END OPENSSH PRIVATE KEY-----"
        ));
    }
}
