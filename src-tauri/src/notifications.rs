//! Narrow native notification adapter. Only the main app webview may access it.
//! Desktop backends await the OS API result; acceptance never means presentation.
use tauri::{AppHandle, Webview};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationPermission {
    Granted,
    Denied,
    Default,
    Limited,
    // The desktop notification service exists but offers no per-app permission API.
    Unknown,
}

impl NotificationPermission {
    fn name(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Default => "default",
            Self::Limited => "limited",
            Self::Unknown => "unknown",
        }
    }
}

fn ensure_main_webview(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("system-unavailable".into())
    }
}

fn require_permission(permission: NotificationPermission) -> Result<(), String> {
    match permission {
        NotificationPermission::Granted
        | NotificationPermission::Limited
        | NotificationPermission::Unknown => Ok(()),
        NotificationPermission::Denied => Err("system-permission-denied".into()),
        NotificationPermission::Default => Err("system-permission-required".into()),
    }
}

fn bounded_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn notification_content(title: &str, body: &str) -> Result<(String, String), String> {
    if title.len() > 4_096 || body.len() > 4_096 {
        return Err("system-send-failed".into());
    }
    let content = (bounded_text(title, 120), bounded_text(body, 240));
    if content.0.is_empty() || content.1.is_empty() {
        return Err("system-send-failed".into());
    }
    Ok(content)
}

fn native_scope<T>(operation: impl FnOnce() -> T) -> T {
    #[cfg(target_os = "macos")]
    {
        objc2::rc::autoreleasepool(|_| operation())
    }
    #[cfg(not(target_os = "macos"))]
    {
        operation()
    }
}

fn send_checked(
    query: impl FnOnce() -> Result<NotificationPermission, String>,
    send: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    require_permission(query()?)?;
    // Do not enqueue-and-forget: the caller receives the backend's actual error.
    send()
}

#[cfg(any(target_os = "macos", test))]
fn apple_permission(status: isize) -> NotificationPermission {
    match status {
        0 => NotificationPermission::Default,
        1 => NotificationPermission::Denied,
        2 => NotificationPermission::Granted,
        3 | 4 => NotificationPermission::Limited,
        _ => NotificationPermission::Unknown,
    }
}

#[tauri::command]
pub async fn system_notification_permission(
    app: AppHandle,
    webview: Webview,
) -> Result<String, String> {
    ensure_main_webview(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        native_scope(|| platform::permission(&app).map(|value| value.name().to_owned()))
    })
    .await
    .map_err(|_| "system-unavailable".to_string())?
}

#[tauri::command]
pub async fn request_system_notification_permission(
    app: AppHandle,
    webview: Webview,
) -> Result<String, String> {
    ensure_main_webview(webview.label())?;
    // This is the only entry point allowed to request interactive permission.
    tauri::async_runtime::spawn_blocking(move || {
        native_scope(|| platform::request_permission(&app).map(|value| value.name().to_owned()))
    })
    .await
    .map_err(|_| "system-unavailable".to_string())?
}

/// Resolves after the OS API acknowledges the request, not a banner/read receipt.
/// Permission is checked again without prompting during background delivery.
#[tauri::command]
pub async fn send_system_notification(
    app: AppHandle,
    webview: Webview,
    title: String,
    body: String,
) -> Result<(), String> {
    ensure_main_webview(webview.label())?;
    let (title, body) = notification_content(&title, &body)?;
    tauri::async_runtime::spawn_blocking(move || {
        native_scope(|| {
            send_checked(
                || platform::permission(&app),
                || platform::send(&app, &title, &body),
            )
        })
    })
    .await
    .map_err(|_| "system-send-failed".to_string())?
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationSettings, UNUserNotificationCenter,
    };
    use std::{ffi::CStr, ptr::NonNull, sync::mpsc, time::Duration};

    pub(super) fn require_class(name: &CStr) -> Result<(), String> {
        AnyClass::get(name)
            .map(|_| ())
            .ok_or_else(|| "system-unavailable".into())
    }

    fn center(app: &AppHandle) -> Result<objc2::rc::Retained<UNUserNotificationCenter>, String> {
        // The existing app minimum includes macOS 10.13. Check dynamically before
        // objc2's typed lookup, which would panic if this 10.14+ class is absent.
        require_class(c"UNUserNotificationCenter")?;
        // Apple's API raises an exception for unbundled executables. Never impersonate Terminal,
        // or use a renamed Info.plist while persisting under the original embedded identifier.
        let identifier = NSBundle::mainBundle()
            .bundleIdentifier()
            .ok_or("system-unavailable")?;
        if identifier.to_string() != app.config().identifier {
            return Err("system-unavailable".into());
        }
        Ok(UNUserNotificationCenter::currentNotificationCenter())
    }

    pub fn permission(app: &AppHandle) -> Result<NotificationPermission, String> {
        let center = center(app)?;
        let (tx, rx) = mpsc::channel();
        center.getNotificationSettingsWithCompletionHandler(&RcBlock::new(
            move |settings: NonNull<UNNotificationSettings>| {
                let status = unsafe { settings.as_ref() }.authorizationStatus().0;
                let _ = tx.send(apple_permission(status));
            },
        ));
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "system-unavailable".into())
    }

    pub fn request_permission(app: &AppHandle) -> Result<NotificationPermission, String> {
        let current = permission(app)?;
        if current != NotificationPermission::Default {
            return Ok(current);
        }
        let center = center(app)?;
        let (tx, rx) = mpsc::channel();
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert,
            &RcBlock::new(move |_granted: Bool, error: *mut NSError| {
                let _ = tx.send(error.is_null());
            }),
        );
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(true) => permission(app),
            _ => Err("system-unavailable".into()),
        }
    }

    pub fn send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        let center = center(app)?;
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let identifier = NSString::from_str(&format!("shellbeam-{}", uuid::Uuid::new_v4()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );
        let (tx, rx) = mpsc::channel();
        center.addNotificationRequest_withCompletionHandler(
            &request,
            Some(&RcBlock::new(move |error: *mut NSError| {
                let _ = tx.send(error.is_null());
            })),
        );
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(true) => Ok(()),
            _ => Err("system-send-failed".into()),
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        UI::Notifications::{
            NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
        },
    };

    fn notifier(app: &AppHandle) -> Result<ToastNotifier, String> {
        // Use only this installed application's AUMID, never the PowerShell fallback identity.
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
            &app.config().identifier,
        ))
        .map_err(|_| "system-unavailable".into())
    }

    pub fn permission(app: &AppHandle) -> Result<NotificationPermission, String> {
        let setting = notifier(app)?
            .Setting()
            .map_err(|_| "system-unavailable".to_string())?;
        Ok(match setting {
            NotificationSetting::Enabled => NotificationPermission::Granted,
            NotificationSetting::DisabledForApplication
            | NotificationSetting::DisabledForUser
            | NotificationSetting::DisabledByGroupPolicy
            | NotificationSetting::DisabledByManifest => NotificationPermission::Denied,
            _ => NotificationPermission::Unknown,
        })
    }

    // Windows has no application permission prompt. Respect the actual OS setting;
    // the UI directs denied users to Windows notification settings.
    pub fn request_permission(app: &AppHandle) -> Result<NotificationPermission, String> {
        permission(app)
    }

    pub fn send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        let xml = XmlDocument::new().map_err(|_| "system-send-failed".to_string())?;
        xml.LoadXml(&HSTRING::from(super::toast_xml(title, body)))
            .map_err(|_| "system-send-failed".to_string())?;
        let toast = ToastNotification::CreateToastNotification(&xml)
            .map_err(|_| "system-send-failed".to_string())?;
        notifier(app)?
            .Show(&toast)
            .map_err(|_| "system-send-failed".into())
    }
}

#[cfg(any(target_os = "windows", test))]
fn toast_xml(title: &str, body: &str) -> String {
    fn escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('\"', "&quot;")
            .replace('\'', "&apos;")
    }
    format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>", escape(title), escape(body))
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
mod platform {
    use super::*;
    use std::{collections::HashMap, time::Duration};
    use zbus::{
        blocking::{connection::Builder, Connection},
        zvariant::Value,
    };

    fn connection() -> Result<Connection, String> {
        Builder::session()
            .and_then(|builder| builder.method_timeout(Duration::from_secs(2)).build())
            .map_err(|_| "system-unavailable".into())
    }

    fn permission_on(connection: &Connection) -> Result<NotificationPermission, String> {
        let reply = connection
            .call_method(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                Some("org.freedesktop.Notifications"),
                "GetServerInformation",
                &(),
            )
            .map_err(|_| "system-unavailable".to_string())?;
        let _: (String, String, String, String) = reply
            .body()
            .deserialize()
            .map_err(|_| "system-unavailable".to_string())?;
        // Freedesktop notifications have no per-application permission query/request.
        Ok(NotificationPermission::Unknown)
    }

    pub fn permission(_app: &AppHandle) -> Result<NotificationPermission, String> {
        permission_on(&connection()?)
    }
    pub fn request_permission(app: &AppHandle) -> Result<NotificationPermission, String> {
        permission(app)
    }

    fn notify_on(
        connection: &Connection,
        identifier: &str,
        title: &str,
        body: &str,
    ) -> Result<(), String> {
        let reply = connection
            .call_method(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                Some("org.freedesktop.Notifications"),
                "Notify",
                &(
                    identifier,
                    0u32,
                    "",
                    title,
                    body,
                    Vec::<&str>::new(),
                    HashMap::<&str, Value<'_>>::new(),
                    5_000i32,
                ),
            )
            .map_err(|_| "system-send-failed".to_string())?;
        let id: u32 = reply
            .body()
            .deserialize()
            .map_err(|_| "system-send-failed".to_string())?;
        if id == 0 {
            return Err("system-send-failed".into());
        }
        Ok(())
    }

    pub fn send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        notify_on(&connection()?, &app.config().identifier, title, body)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            process::{Child, Command, Stdio},
            thread,
        };
        fn isolated_bus() -> Connection {
            assert_eq!(
                std::env::var("SHELLBEAM_NOTIFICATION_TEST_BUS").as_deref(),
                Ok("1"),
                "Run only inside dbus-run-session with the notifications-session.conf fixture"
            );
            assert!(std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok());
            connection().expect("private D-Bus connection")
        }
        struct Daemon(Child);
        impl Drop for Daemon {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        #[test]
        #[ignore = "requires an explicitly isolated dbus-run-session without notification service activation"]
        fn real_dbus_without_daemon_rejects_delivery() {
            let bus = isolated_bus();
            assert_eq!(permission_on(&bus), Err("system-unavailable".into()));
            assert_eq!(
                notify_on(
                    &bus,
                    "app.shellbeam.notification-smoke",
                    "ShellBeam isolated test",
                    "No daemon must reject"
                ),
                Err("system-send-failed".into())
            );
        }

        #[test]
        #[ignore = "requires isolated dbus-run-session, Xvfb and the real dunst notification daemon"]
        fn real_dbus_dunst_acknowledges_delivery() {
            let bus = isolated_bus();
            assert!(std::env::var("DISPLAY").is_ok(), "Xvfb DISPLAY is required");
            assert_eq!(
                permission_on(&bus),
                Err("system-unavailable".into()),
                "test bus must start without a notification daemon"
            );
            let _daemon = Daemon(
                Command::new("dunst")
                    .arg("-conf")
                    .arg("/dev/null")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("start real dunst"),
            );
            let mut ready = false;
            for _ in 0..60 {
                if permission_on(&bus) == Ok(NotificationPermission::Unknown) {
                    ready = true;
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            assert!(ready, "real dunst must own the notification service");
            assert_eq!(
                notify_on(
                    &bus,
                    "app.shellbeam.notification-smoke",
                    "ShellBeam isolated test",
                    "Actual D-Bus backend acknowledgement; not a display receipt"
                ),
                Ok(())
            );
            // This verifies real service acceptance, never a banner or human read receipt.
        }
    }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
mod platform {
    use super::*;
    use tauri::plugin::PermissionState;
    use tauri_plugin_notification::NotificationExt;
    fn convert(value: PermissionState) -> NotificationPermission {
        match value {
            PermissionState::Granted => NotificationPermission::Granted,
            PermissionState::Denied => NotificationPermission::Denied,
            _ => NotificationPermission::Default,
        }
    }
    pub fn permission(app: &AppHandle) -> Result<NotificationPermission, String> {
        app.notification()
            .permission_state()
            .map(convert)
            .map_err(|_| "system-unavailable".into())
    }
    pub fn request_permission(app: &AppHandle) -> Result<NotificationPermission, String> {
        app.notification()
            .request_permission()
            .map(convert)
            .map_err(|_| "system-unavailable".into())
    }
    pub fn send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|_| "system-send-failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn only_main_webview_can_use_native_notification_commands() {
        assert!(ensure_main_webview("main").is_ok());
        assert_eq!(
            ensure_main_webview("remote-site"),
            Err("system-unavailable".into())
        );
    }

    #[test]
    fn permission_states_remain_distinct_and_background_send_never_requests_permission() {
        for (permission, expected) in [
            (
                NotificationPermission::Default,
                "system-permission-required",
            ),
            (NotificationPermission::Denied, "system-permission-denied"),
        ] {
            let sent = Cell::new(false);
            let result = send_checked(
                || Ok(permission),
                || {
                    sent.set(true);
                    Ok(())
                },
            );
            assert_eq!(result, Err(expected.into()));
            assert!(!sent.get());
        }
        assert_eq!(NotificationPermission::Unknown.name(), "unknown");
        assert_eq!(
            send_checked(|| Ok(NotificationPermission::Unknown), || Ok(())),
            Ok(())
        );
    }

    #[test]
    fn backend_rejection_is_propagated_instead_of_queued_success() {
        assert_eq!(
            send_checked(
                || Ok(NotificationPermission::Granted),
                || Err("system-send-failed".into())
            ),
            Err("system-send-failed".into())
        );
        let sent = Cell::new(false);
        assert_eq!(
            send_checked(
                || Err("system-unavailable".into()),
                || {
                    sent.set(true);
                    Ok(())
                }
            ),
            Err("system-unavailable".into())
        );
        assert!(!sent.get());
    }

    #[test]
    fn apple_permission_distinguishes_quiet_delivery_and_future_unknown_states() {
        assert_eq!(apple_permission(0), NotificationPermission::Default);
        assert_eq!(apple_permission(1), NotificationPermission::Denied);
        assert_eq!(apple_permission(2), NotificationPermission::Granted);
        assert_eq!(apple_permission(3), NotificationPermission::Limited);
        assert_eq!(apple_permission(4), NotificationPermission::Limited);
        assert_eq!(apple_permission(999), NotificationPermission::Unknown);
    }

    #[test]
    fn native_text_is_bounded_and_control_characters_are_removed() {
        assert_eq!(
            bounded_text("  Probe\n\0   recovered\t ", 120),
            "Probe recovered"
        );
        assert_eq!(
            notification_content(&"探".repeat(200), "Body")
                .unwrap()
                .0
                .chars()
                .count(),
            120
        );
        assert!(notification_content("\n\0\t", "body").is_err());
        assert!(notification_content("title", &"x".repeat(4_097)).is_err());
    }

    #[test]
    fn windows_toast_text_cannot_inject_xml() {
        let xml = toast_xml("<title>&'\"", "</text><audio src='private'/>");
        assert!(xml.contains("&lt;title&gt;&amp;&apos;&quot;"));
        assert!(!xml.contains("<audio"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unbundled_tests_cannot_impersonate_a_registered_application() {
        assert!(objc2_foundation::NSBundle::mainBundle()
            .bundleIdentifier()
            .is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn absent_notification_class_returns_unavailable_without_typed_lookup() {
        assert_eq!(
            platform::require_class(c"ShellBeamUnavailableNotificationTestClass"),
            Err("system-unavailable".into())
        );
        assert!(platform::require_class(c"NSObject").is_ok());
    }
}
