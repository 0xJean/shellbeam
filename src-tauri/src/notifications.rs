//! Narrow native notification adapter. Only the main app webview may access
//! it; embedded remote pages never receive the plugin's unrestricted API.
use tauri::{plugin::PermissionState, AppHandle, Webview};
use tauri_plugin_notification::NotificationExt;

fn ensure_main_webview(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("system-unavailable".into())
    }
}

fn permission_name(permission: PermissionState) -> &'static str {
    match permission {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "default",
    }
}

fn require_permission(permission: PermissionState) -> Result<(), String> {
    match permission {
        PermissionState::Granted => Ok(()),
        PermissionState::Denied => Err("system-permission-denied".into()),
        PermissionState::Prompt | PermissionState::PromptWithRationale => {
            Err("system-permission-required".into())
        }
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

#[tauri::command]
pub fn system_notification_permission(app: AppHandle, webview: Webview) -> Result<String, String> {
    ensure_main_webview(webview.label())?;
    app.notification()
        .permission_state()
        .map(|permission| permission_name(permission).to_owned())
        .map_err(|_| "system-unavailable".into())
}

#[tauri::command]
pub fn request_system_notification_permission(
    app: AppHandle,
    webview: Webview,
) -> Result<String, String> {
    ensure_main_webview(webview.label())?;
    app.notification()
        .request_permission()
        .map(|permission| permission_name(permission).to_owned())
        .map_err(|_| "system-unavailable".into())
}

/// Success means the native backend accepted the request, not that the OS
/// displayed a banner or the user read it. The plugin may queue the OS send.
/// Permission is checked again here without ever prompting from background work.
#[tauri::command]
pub fn send_system_notification(
    app: AppHandle,
    webview: Webview,
    title: String,
    body: String,
) -> Result<(), String> {
    ensure_main_webview(webview.label())?;
    // Reject excessive IPC input before doing any string allocation. The UI
    // sends already-redacted 120/240-character text, and no provider metadata.
    if title.len() > 4_096 || body.len() > 4_096 {
        return Err("system-send-failed".into());
    }
    let title = bounded_text(&title, 120);
    let body = bounded_text(&body, 240);
    if title.is_empty() || body.is_empty() {
        return Err("system-send-failed".into());
    }
    require_permission(
        app.notification()
            .permission_state()
            .map_err(|_| "system-unavailable".to_owned())?,
    )?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|_| "system-send-failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_webview_can_use_native_notification_commands() {
        assert!(ensure_main_webview("main").is_ok());
        assert_eq!(
            ensure_main_webview("remote-site"),
            Err("system-unavailable".into())
        );
    }

    #[test]
    fn permission_states_remain_distinct_without_requesting_permission() {
        assert_eq!(
            permission_name(PermissionState::PromptWithRationale),
            "default"
        );
        assert_eq!(
            require_permission(PermissionState::Denied),
            Err("system-permission-denied".into())
        );
        assert_eq!(
            require_permission(PermissionState::Prompt),
            Err("system-permission-required".into())
        );
        assert_eq!(require_permission(PermissionState::Granted), Ok(()));
    }

    #[test]
    fn native_text_is_bounded_and_control_characters_are_removed() {
        assert_eq!(
            bounded_text("  Probe\n\0   recovered\t ", 120),
            "Probe recovered"
        );
        assert_eq!(bounded_text(&"探".repeat(200), 120).chars().count(), 120);
        assert!(bounded_text("\n\0\t", 240).is_empty());
    }
}
