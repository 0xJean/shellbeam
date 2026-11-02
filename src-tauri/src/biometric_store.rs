//! Biometric password store — platform-specific implementations.
//!
//! macOS/iOS: a data protection Keychain item whose access control requires Touch ID
//! or Face ID for the currently enrolled biometrics, so the OS enforces the check
//! rather than this app. On macOS that keychain needs the `keychain-access-groups`
//! entitlement, and a build without it gets errSecMissingEntitlement: biometric unlock
//! is then unavailable and the master password remains the way in. Never fall back to
//! weaker storage.
//!
//! The plugin's own `setData` is not used on these platforms: it asks for user
//! presence, which the device passcode also satisfies, and on macOS it does not
//! select the data protection keychain.
//!
//! Android: The frontend uses the biometry plugin's native
//! keystore (setData/getData) directly — these Rust commands are not called.
//! We still register them so the invoke_handler compiles on all platforms, but
//! they return errors there.

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple_impl {
    use crate::apple_keychain::{self, Keychain};
    #[cfg(target_os = "macos")]
    use crate::storage::data_file_path;
    use objc2_security::{
        kSecAttrAccessControl, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, SecAccessControl,
        SecAccessControlCreateFlags,
    };
    #[cfg(target_os = "macos")]
    use objc2_security::{kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
    #[cfg(target_os = "macos")]
    use std::sync::OnceLock;

    /// The old AES file, keyed by the world-readable kern.uuid. Never migrated.
    #[cfg(target_os = "macos")]
    const LEGACY_FILE: &str = "biometric_store.json";
    const SERVICE: &str = "app.shellbeam.vault-biometric";
    const ACCOUNT: &str = "vault-master-pw";
    #[cfg(target_os = "macos")]
    const PROBE_ACCOUNT: &str = "entitlement-probe";
    /// errSecMissingEntitlement
    const MISSING_ENTITLEMENT: i32 = -34018;

    /// Words the frontend matches on; see attemptBiometricUnlock.
    pub(super) fn keychain_error(status: i32) -> String {
        match status {
            -128 => "userCancel".into(),
            -25293 => "authenticationFailed".into(),
            MISSING_ENTITLEMENT => "keychainError: missing keychain entitlement (-34018)".into(),
            other => format!("keychainError: {other}"),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn purge_legacy(app: &tauri::AppHandle) -> Result<(), String> {
        remove_legacy_file(&data_file_path(app, LEGACY_FILE)?)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn remove_legacy_file(path: &std::path::Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Remove legacy biometric store failed: {e}")),
        }
    }

    pub fn store_password(password: &str) -> Result<(), String> {
        let access = unsafe {
            SecAccessControl::with_flags(
                None,
                kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                SecAccessControlCreateFlags::BiometryCurrentSet,
                std::ptr::null_mut(),
            )
        }
        .ok_or_else(|| "keychainError: could not create access control".to_string())?;
        apple_keychain::replace(
            SERVICE,
            ACCOUNT,
            Keychain::DataProtection,
            password.as_bytes(),
            &[(unsafe { kSecAttrAccessControl }.as_ref(), access.as_ref())],
        )
        .map_err(keychain_error)
    }

    pub fn retrieve_password(reason: &str) -> Result<String, String> {
        let data = apple_keychain::read(SERVICE, ACCOUNT, Keychain::DataProtection, Some(reason))
            .map_err(keychain_error)?
            .ok_or_else(|| "itemNotFound".to_string())?;
        String::from_utf8(data).map_err(|e| format!("Invalid UTF-8: {e}"))
    }

    /// A plain query answers "not found" even without the entitlement; only a
    /// write reveals it, so write and remove a throwaway item once per run.
    #[cfg(target_os = "macos")]
    fn require_entitlement() -> Result<(), String> {
        static PROBE: OnceLock<Result<(), i32>> = OnceLock::new();
        let probe = PROBE.get_or_init(|| {
            let attributes = [(
                unsafe { kSecAttrAccessible }.as_ref(),
                unsafe { kSecAttrAccessibleWhenUnlockedThisDeviceOnly }.as_ref(),
            )];
            let keychain = Keychain::DataProtection;
            match apple_keychain::replace(SERVICE, PROBE_ACCOUNT, keychain, b"", &attributes) {
                Err(MISSING_ENTITLEMENT) => Err(MISSING_ENTITLEMENT),
                _ => {
                    let _ = apple_keychain::delete(SERVICE, PROBE_ACCOUNT, keychain);
                    Ok(())
                }
            }
        });
        probe
            .as_ref()
            .map(|_| ())
            .map_err(|status| keychain_error(*status))
    }

    pub fn has_password() -> Result<bool, String> {
        #[cfg(target_os = "macos")]
        require_entitlement()?;
        apple_keychain::exists(SERVICE, ACCOUNT, Keychain::DataProtection).map_err(keychain_error)
    }

    pub fn remove_password() -> Result<(), String> {
        apple_keychain::delete(SERVICE, ACCOUNT, Keychain::DataProtection).map_err(keychain_error)
    }
}

/// Deletes the file left by earlier versions. Users enrol again from Settings.
#[cfg(target_os = "macos")]
pub fn purge_legacy_store(app: &tauri::AppHandle) {
    if let Err(error) = apple_impl::purge_legacy(app) {
        log::error!("{error}");
    }
}

/// Keychain calls can block on the system prompt, so they stay off the main thread.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn off_main<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(call)
        .await
        .map_err(|e| format!("Biometric store task failed: {e}"))?
}

// ── Tauri commands (all platforms) ──

#[tauri::command]
pub async fn biometric_store_password(password: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        off_main(move || apple_impl::store_password(&password)).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = password;
        Err("Use native biometric plugin on this platform".into())
    }
}

#[tauri::command]
pub async fn biometric_retrieve_password(reason: String) -> Result<String, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        off_main(move || apple_impl::retrieve_password(&reason)).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = reason;
        Err("Use native biometric plugin on this platform".into())
    }
}

#[tauri::command]
pub async fn biometric_has_password() -> Result<bool, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        off_main(apple_impl::has_password).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Err("Use native biometric plugin on this platform".into())
    }
}

#[tauri::command]
pub async fn biometric_remove_password() -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        off_main(apple_impl::remove_password).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Err("Use native biometric plugin on this platform".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::apple_impl::{has_password, keychain_error, remove_legacy_file};

    #[test]
    fn legacy_store_is_deleted_and_absence_is_fine() {
        let path = std::env::temp_dir().join(format!("sb-bio-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, "{}").unwrap();
        remove_legacy_file(&path).unwrap();
        assert!(!path.exists());
        remove_legacy_file(&path).unwrap();
    }

    #[test]
    fn missing_entitlement_and_cancel_reach_the_frontend_by_name() {
        assert!(keychain_error(-34018).contains("-34018"));
        assert!(keychain_error(-34018).contains("keychainError"));
        assert_eq!(keychain_error(-128), "userCancel");
    }

    #[test]
    fn probe_never_prompts_and_reports_a_build_without_entitlement() {
        // Test binaries are not signed with the entitlement, so this normally errs.
        // With one it answers false or true; either way it returns without a prompt.
        match has_password() {
            Ok(_) => {}
            Err(error) => assert!(error.contains("keychainError"), "{error}"),
        }
    }

    /// Run by hand: `cargo test --lib unsigned_binary -- --ignored`. Shows what an
    /// ad-hoc signed build gets. Refuses to run against a real enrolment.
    #[test]
    #[ignore = "touches the login keychain's data protection store"]
    fn unsigned_binary_cannot_store() {
        assert!(has_password().is_err(), "this binary has the entitlement");
        let error = super::apple_impl::store_password("x").unwrap_err();
        assert!(error.contains("-34018"), "{error}");
    }
}
