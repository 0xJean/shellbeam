//! Keeps each peer's sync key out of sync_state.json.
//!
//! macOS and iOS use the Keychain, Windows the Credential Manager. Sync runs in the
//! background, so these items need no biometric prompt.
//!
//! NOT MOVED: Linux and Android still keep the key in plaintext in sync_state.json.
//! Linux has no secure store that is always present (the Secret Service is optional
//! and needs a session bus), and Android's Keystore needs native code that does not
//! exist here yet. Those platforms behave as before; see `backend::SUPPORTED`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::{SyncStateFile, CURRENT_PAIRING_VERSION};

#[cfg(all(not(test), any(target_os = "macos", target_os = "ios")))]
mod backend {
    use crate::apple_keychain::{self, Keychain};
    #[cfg(target_os = "ios")]
    use objc2_security::{kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly};

    pub(super) const SUPPORTED: bool = true;
    const SERVICE: &str = "app.shellbeam.sync-key";
    // The ordinary keychain: no entitlement needed, and access is limited to this
    // app's code signature. A background read must work without a person present.
    const KEYCHAIN: Keychain = Keychain::Default;

    pub(super) fn get(peer: &str) -> Result<Option<String>, String> {
        let data = apple_keychain::read(SERVICE, peer, KEYCHAIN, None)
            .map_err(|status| format!("Keychain read failed: {status}"))?;
        data.map(|bytes| String::from_utf8(bytes).map_err(|e| e.to_string()))
            .transpose()
    }

    pub(super) fn set(peer: &str, secret: &str) -> Result<(), String> {
        #[cfg(target_os = "ios")]
        let attributes = [(
            unsafe { kSecAttrAccessible }.as_ref(),
            unsafe { kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly }.as_ref(),
        )];
        #[cfg(not(target_os = "ios"))]
        let attributes = [];
        apple_keychain::replace(SERVICE, peer, KEYCHAIN, secret.as_bytes(), &attributes)
            .map_err(|status| format!("Keychain write failed: {status}"))
    }

    pub(super) fn delete(peer: &str) -> Result<(), String> {
        apple_keychain::delete(SERVICE, peer, KEYCHAIN)
            .map_err(|status| format!("Keychain delete failed: {status}"))
    }
}

#[cfg(all(not(test), target_os = "windows"))]
mod backend {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    pub(super) const SUPPORTED: bool = true;
    /// HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
    const NOT_FOUND: i32 = 0x8007_0490_u32 as i32;

    fn target(peer: &str) -> String {
        format!("app.shellbeam.sync-key/{peer}")
    }

    pub(super) fn get(peer: &str) -> Result<Option<String>, String> {
        let name = HSTRING::from(target(peer));
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        match unsafe { CredReadW(&name, CRED_TYPE_GENERIC, None, &mut credential) } {
            Ok(()) => {}
            Err(e) if e.code().0 == NOT_FOUND => return Ok(None),
            Err(e) => return Err(format!("Credential read failed: {e}")),
        }
        let secret = unsafe {
            let c = &*credential;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
            let secret = String::from_utf8(bytes.to_vec());
            CredFree(credential as *const core::ffi::c_void);
            secret
        };
        secret.map(Some).map_err(|e| e.to_string())
    }

    pub(super) fn set(peer: &str, secret: &str) -> Result<(), String> {
        let mut name: Vec<u16> = target(peer).encode_utf16().chain(Some(0)).collect();
        let mut blob = secret.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&credential, 0) }.map_err(|e| format!("Credential write failed: {e}"))
    }

    pub(super) fn delete(peer: &str) -> Result<(), String> {
        let name = HSTRING::from(target(peer));
        match unsafe { CredDeleteW(&name, CRED_TYPE_GENERIC, None) } {
            Err(e) if e.code().0 != NOT_FOUND => Err(format!("Credential delete failed: {e}")),
            _ => Ok(()),
        }
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "ios", target_os = "windows"))
))]
mod backend {
    pub(super) const SUPPORTED: bool = false;
    pub(super) fn get(_peer: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub(super) fn set(_peer: &str, _secret: &str) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn delete(_peer: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Tests must never touch the real keychain of whoever runs them.
#[cfg(test)]
pub(super) mod backend {
    use std::collections::{HashMap, HashSet};
    use std::sync::{LazyLock, Mutex};

    pub(in crate::sync) const SUPPORTED: bool = true;
    pub(in crate::sync) static ITEMS: LazyLock<Mutex<HashMap<String, String>>> =
        LazyLock::new(Mutex::default);
    pub(in crate::sync) static BROKEN: LazyLock<Mutex<HashSet<String>>> =
        LazyLock::new(Mutex::default);

    fn check(peer: &str) -> Result<(), String> {
        if BROKEN.lock().unwrap().contains(peer) {
            return Err("store unavailable".into());
        }
        Ok(())
    }
    pub(super) fn get(peer: &str) -> Result<Option<String>, String> {
        check(peer)?;
        Ok(ITEMS.lock().unwrap().get(peer).cloned())
    }
    pub(super) fn set(peer: &str, secret: &str) -> Result<(), String> {
        check(peer)?;
        ITEMS.lock().unwrap().insert(peer.into(), secret.into());
        Ok(())
    }
    pub(super) fn delete(peer: &str) -> Result<(), String> {
        check(peer)?;
        ITEMS.lock().unwrap().remove(peer);
        Ok(())
    }
}

/// Avoids a store round trip on every request, and records which keys this process
/// has actually seen: only those may be deleted when a peer's key goes to None, so a
/// store that was briefly unreadable can never cost a pairing.
static CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);

fn cache() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Fills in keys after a load. True when a plaintext key moved into the store, and
/// so the file should be rewritten without it.
pub(super) fn hydrate(state: &mut SyncStateFile) -> bool {
    if !backend::SUPPORTED {
        return false;
    }
    let mut migrated = false;
    for peer in &mut state.trusted_peers {
        if peer.pairing_version < CURRENT_PAIRING_VERSION {
            continue;
        }
        let id = peer.peer_device_id.clone();
        if let Some(secret) = &peer.sync_secret {
            match backend::set(&id, secret) {
                Ok(()) => {
                    cache().insert(id, secret.clone());
                    migrated = true;
                }
                // Stays in the file until the store works, so the pairing survives.
                Err(error) => log::warn!("[sync] could not move key to secure storage: {error}"),
            }
            continue;
        }
        if let Some(secret) = cache().get(&id) {
            peer.sync_secret = Some(secret.clone());
            continue;
        }
        match backend::get(&id) {
            Ok(Some(secret)) => {
                cache().insert(id, secret.clone());
                peer.sync_secret = Some(secret);
            }
            Ok(None) => {}
            Err(error) => log::warn!("[sync] could not read key from secure storage: {error}"),
        }
    }
    migrated
}

/// Saves keys to the store and returns what belongs on disk. A store failure stops
/// the save rather than writing a key in plaintext. `previous` holds peers on disk.
pub(super) fn persist(state: &SyncStateFile, previous: &[String]) -> Result<SyncStateFile, String> {
    let mut disk = state.clone();
    if !backend::SUPPORTED {
        return Ok(disk);
    }
    for peer in &mut disk.trusted_peers {
        let id = peer.peer_device_id.clone();
        match peer.sync_secret.take() {
            Some(secret) if peer.pairing_version >= CURRENT_PAIRING_VERSION => {
                if cache().get(&id) != Some(&secret) {
                    backend::set(&id, &secret)?;
                    cache().insert(id, secret);
                }
            }
            Some(_) => {}
            None => {
                if cache().contains_key(&id) {
                    backend::delete(&id)?;
                    cache().remove(&id);
                }
            }
        }
    }
    let gone: Vec<String> = previous
        .iter()
        .cloned()
        .chain(cache().keys().cloned())
        .filter(|id| !disk.trusted_peers.iter().any(|p| &p.peer_device_id == id))
        .collect();
    for id in gone {
        backend::delete(&id)?;
        cache().remove(&id);
    }
    Ok(disk)
}

/// The on-disk form of a just-migrated state: keys the store now holds are removed.
pub(super) fn without_stored_secrets(state: &SyncStateFile) -> SyncStateFile {
    let mut disk = state.clone();
    let cache = cache();
    for peer in &mut disk.trusted_peers {
        if peer.sync_secret.is_some()
            && peer.sync_secret.as_ref() == cache.get(&peer.peer_device_id)
        {
            peer.sync_secret = None;
        }
    }
    disk
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::SyncTrustedPeer;

    fn peer(id: &str, secret: Option<&str>) -> SyncTrustedPeer {
        SyncTrustedPeer {
            peer_device_id: id.into(),
            peer_device_name: None,
            verified_at: 0,
            last_seen_at: 0,
            source: "t".into(),
            peer_endpoint: None,
            sync_secret: secret.map(Into::into),
            pairing_version: CURRENT_PAIRING_VERSION,
        }
    }
    fn state(peers: Vec<SyncTrustedPeer>) -> SyncStateFile {
        SyncStateFile {
            schema_version: 1,
            trusted_peers: peers,
            ..Default::default()
        }
    }
    fn stored(id: &str) -> Option<String> {
        backend::ITEMS.lock().unwrap().get(id).cloned()
    }

    #[test]
    fn plaintext_key_moves_to_the_store_and_leaves_the_file() {
        let mut s = state(vec![peer("migrate", Some("k"))]);
        assert!(hydrate(&mut s));
        assert_eq!(stored("migrate").as_deref(), Some("k"));
        assert_eq!(s.trusted_peers[0].sync_secret.as_deref(), Some("k"));
        assert_eq!(
            without_stored_secrets(&s).trusted_peers[0].sync_secret,
            None
        );
    }

    #[test]
    fn failed_migration_keeps_the_key_in_the_file() {
        backend::BROKEN.lock().unwrap().insert("broken-move".into());
        let mut s = state(vec![peer("broken-move", Some("k"))]);
        assert!(!hydrate(&mut s));
        assert_eq!(
            without_stored_secrets(&s).trusted_peers[0]
                .sync_secret
                .as_deref(),
            Some("k")
        );
    }

    #[test]
    fn save_strips_the_key_and_load_brings_it_back() {
        let disk = persist(&state(vec![peer("round", Some("k"))]), &[]).unwrap();
        assert_eq!(disk.trusted_peers[0].sync_secret, None);
        cache().clear();
        let mut loaded = disk;
        assert!(!hydrate(&mut loaded));
        assert_eq!(loaded.trusted_peers[0].sync_secret.as_deref(), Some("k"));
    }

    #[test]
    fn save_fails_rather_than_writing_plaintext() {
        backend::BROKEN.lock().unwrap().insert("broken-save".into());
        assert!(persist(&state(vec![peer("broken-save", Some("k"))]), &[]).is_err());
    }

    #[test]
    fn removing_or_clearing_a_peer_deletes_its_key() {
        persist(
            &state(vec![peer("gone", Some("k")), peer("cleared", Some("k"))]),
            &[],
        )
        .unwrap();
        persist(&state(vec![peer("cleared", None)]), &["gone".to_string()]).unwrap();
        assert_eq!(stored("gone"), None);
        assert_eq!(stored("cleared"), None);
    }

    #[test]
    fn unreadable_store_does_not_cost_the_pairing() {
        backend::ITEMS
            .lock()
            .unwrap()
            .insert("flaky".into(), "k".into());
        backend::BROKEN.lock().unwrap().insert("flaky".into());
        let mut s = state(vec![peer("flaky", None)]);
        hydrate(&mut s);
        assert_eq!(s.trusted_peers[0].sync_secret, None);
        persist(&s, &[]).unwrap();
        backend::BROKEN.lock().unwrap().remove("flaky");
        assert_eq!(stored("flaky").as_deref(), Some("k"));
    }

    #[test]
    fn keys_from_before_authenticated_pairing_are_not_stored() {
        let mut old = peer("old", Some("k"));
        old.pairing_version = 0;
        let disk = persist(&state(vec![old]), &[]).unwrap();
        assert_eq!(disk.trusted_peers[0].sync_secret, None);
        assert_eq!(stored("old"), None);
    }
}
