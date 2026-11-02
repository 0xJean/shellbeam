//! Small wrapper over the Security framework's item API.

// The replacements need an LAContext per call; these still work and need none.
#![allow(deprecated)]

use objc2_core_foundation::{
    kCFBooleanTrue, kCFCopyStringDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFData,
    CFDictionary, CFDictionaryKeyCallBacks, CFDictionaryValueCallBacks, CFIndex, CFRetained,
    CFString, CFType,
};
use objc2_security::{
    errSecInteractionNotAllowed, errSecItemNotFound, errSecSuccess, kSecAttrAccount,
    kSecAttrService, kSecClass, kSecClassGenericPassword, kSecMatchLimit, kSecMatchLimitOne,
    kSecReturnData, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail,
    kSecUseDataProtectionKeychain, kSecUseOperationPrompt, kSecValueData, SecItemAdd,
    SecItemCopyMatching, SecItemDelete,
};
use std::ffi::c_void;
use std::ptr::NonNull;

type Pair<'a> = (&'a CFType, &'a CFType);

/// Which keychain holds the item. Access control is only enforced by the data
/// protection keychain, which on macOS needs a keychain entitlement.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Keychain {
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    DataProtection,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Default,
}

fn dictionary(pairs: &[Pair<'_>]) -> Result<CFRetained<CFDictionary>, i32> {
    let keys: Vec<&CFType> = pairs.iter().map(|pair| pair.0).collect();
    let values: Vec<&CFType> = pairs.iter().map(|pair| pair.1).collect();
    unsafe {
        CFDictionary::new(
            None,
            keys.as_ptr() as *mut *const c_void,
            values.as_ptr() as *mut *const c_void,
            pairs.len() as CFIndex,
            &kCFCopyStringDictionaryKeyCallBacks as *const CFDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks as *const CFDictionaryValueCallBacks,
        )
    }
    .ok_or(-108)
}

fn with_item<T>(
    service: &str,
    account: &str,
    keychain: Keychain,
    extra: &[Pair<'_>],
    call: impl FnOnce(&CFDictionary) -> T,
) -> Result<T, i32> {
    let service = CFString::from_str(service);
    let account = CFString::from_str(account);
    let yes = unsafe { kCFBooleanTrue }.ok_or(-108)?;
    let mut pairs: Vec<Pair<'_>> = unsafe {
        vec![
            (kSecClass.as_ref(), kSecClassGenericPassword.as_ref()),
            (kSecAttrService.as_ref(), service.as_ref()),
            (kSecAttrAccount.as_ref(), account.as_ref()),
        ]
    };
    if keychain == Keychain::DataProtection {
        pairs.push((
            unsafe { kSecUseDataProtectionKeychain }.as_ref(),
            yes.as_ref(),
        ));
    }
    pairs.extend_from_slice(extra);
    Ok(call(&*dictionary(&pairs)?))
}

/// Adds the item, replacing any earlier one. `attributes` must carry its protection.
pub(crate) fn replace(
    service: &str,
    account: &str,
    keychain: Keychain,
    data: &[u8],
    attributes: &[Pair<'_>],
) -> Result<(), i32> {
    delete(service, account, keychain)?;
    let value = CFData::from_bytes(data);
    let mut extra: Vec<Pair<'_>> = vec![(unsafe { kSecValueData }.as_ref(), value.as_ref())];
    extra.extend_from_slice(attributes);
    let status = with_item(service, account, keychain, &extra, |query| unsafe {
        SecItemAdd(query, std::ptr::null_mut())
    })?;
    if status == errSecSuccess {
        Ok(())
    } else {
        Err(status)
    }
}

/// Reads the item, showing the system prompt if its access control asks for one.
pub(crate) fn read(
    service: &str,
    account: &str,
    keychain: Keychain,
    prompt: Option<&str>,
) -> Result<Option<Vec<u8>>, i32> {
    let yes = unsafe { kCFBooleanTrue }.ok_or(-108)?;
    let prompt = prompt.map(CFString::from_str);
    let mut extra: Vec<Pair<'_>> = unsafe {
        vec![
            (kSecReturnData.as_ref(), yes.as_ref()),
            (kSecMatchLimit.as_ref(), kSecMatchLimitOne.as_ref()),
        ]
    };
    if let Some(prompt) = &prompt {
        extra.push((unsafe { kSecUseOperationPrompt }.as_ref(), prompt.as_ref()));
    }
    let mut out: *const CFType = std::ptr::null();
    let status = with_item(service, account, keychain, &extra, |query| unsafe {
        SecItemCopyMatching(query, &mut out)
    })?;
    if status == errSecItemNotFound {
        return Ok(None);
    }
    if status != errSecSuccess {
        return Err(status);
    }
    let data = NonNull::new(out as *mut CFData).ok_or(-108)?;
    // Copy rule: SecItemCopyMatching hands over one reference.
    let data = unsafe { CFRetained::from_raw(data) };
    Ok(Some(data.to_vec()))
}

/// Whether the item exists, without ever showing a prompt.
pub(crate) fn exists(service: &str, account: &str, keychain: Keychain) -> Result<bool, i32> {
    let extra: Vec<Pair<'_>> = unsafe {
        vec![
            (kSecMatchLimit.as_ref(), kSecMatchLimitOne.as_ref()),
            (
                kSecUseAuthenticationUI.as_ref(),
                kSecUseAuthenticationUIFail.as_ref(),
            ),
        ]
    };
    let status = with_item(service, account, keychain, &extra, |query| unsafe {
        SecItemCopyMatching(query, std::ptr::null_mut())
    })?;
    #[allow(non_upper_case_globals)]
    match status {
        errSecSuccess | errSecInteractionNotAllowed => Ok(true),
        errSecItemNotFound => Ok(false),
        other => Err(other),
    }
}

pub(crate) fn delete(service: &str, account: &str, keychain: Keychain) -> Result<(), i32> {
    let status = with_item(service, account, keychain, &[], |query| unsafe {
        SecItemDelete(query)
    })?;
    if status == errSecSuccess || status == errSecItemNotFound {
        Ok(())
    } else {
        Err(status)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Run by hand: `cargo test --lib apple_keychain -- --ignored`. Uses a throwaway
    /// item in the login keychain, the store sync keys live in on macOS.
    #[test]
    #[ignore = "touches the login keychain"]
    fn default_keychain_round_trip() {
        let (service, account) = ("app.shellbeam.test", "round-trip");
        replace(service, account, Keychain::Default, b"one", &[]).unwrap();
        replace(service, account, Keychain::Default, b"two", &[]).unwrap();
        let read_back = read(service, account, Keychain::Default, None).unwrap();
        delete(service, account, Keychain::Default).unwrap();
        assert_eq!(read_back.as_deref(), Some(&b"two"[..]));
        assert_eq!(
            read(service, account, Keychain::Default, None).unwrap(),
            None
        );
    }
}
