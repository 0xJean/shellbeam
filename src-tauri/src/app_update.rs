//! Update reminder support: reads the public latest-release record and opens the
//! release page. Nothing is downloaded or installed. The request carries no
//! cookies, authentication, app version, or device details, only a fixed user agent.
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};
use tauri::{AppHandle, Runtime, Webview};

// GitHub's "latest" never returns drafts or prereleases. Monitoring probe
// releases in this repository are published with --latest=false.
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/0xJean/shellbeam/releases/latest";
const RELEASE_PAGE_PREFIX: &str = "https://github.com/0xJean/shellbeam/releases/tag/v";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const CHECK_FAILED: &str = "update_check_failed";
const OPEN_FAILED: &str = "update_page_open_failed";
const UNAVAILABLE: &str = "update_check_unavailable";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    version: String,
    platform: &'static str,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct LatestRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn ensure_main_webview(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(UNAVAILABLE.into())
    }
}

fn platform() -> &'static str {
    std::env::consts::OS
}

/// Only a plain released version can reach the system browser, and the rest of
/// the address is fixed here rather than taken from the response or the page.
fn release_page_url(version: &str) -> Result<String, String> {
    let parts: Vec<&str> = version.split('.').collect();
    let valid = parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit())
        });
    if valid {
        Ok(format!("{RELEASE_PAGE_PREFIX}{version}"))
    } else {
        Err(OPEN_FAILED.into())
    }
}

fn parse_latest_release(reader: impl Read) -> Result<LatestRelease, String> {
    serde_json::from_reader(reader.take(MAX_RESPONSE_BYTES)).map_err(|_| CHECK_FAILED.to_string())
}

fn fetch_latest_release() -> Result<LatestRelease, String> {
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("ShellBeam-Update-Check")
        .build()
        .map_err(|_| CHECK_FAILED.to_string())?;
    let response = client
        .get(LATEST_RELEASE_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .map_err(|_| CHECK_FAILED.to_string())?;
    // Rate limits (403/429), a repository with no release (404) and redirects
    // all mean the answer is unknown, so they fail the same quiet way.
    if !response.status().is_success() {
        return Err(CHECK_FAILED.into());
    }
    parse_latest_release(response)
}

#[tauri::command]
pub fn app_update_info<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
) -> Result<AppUpdateInfo, String> {
    ensure_main_webview(webview.label())?;
    Ok(AppUpdateInfo {
        version: app.package_info().version.to_string(),
        platform: platform(),
    })
}

#[tauri::command]
pub async fn check_latest_app_release<R: Runtime>(
    webview: Webview<R>,
) -> Result<LatestRelease, String> {
    ensure_main_webview(webview.label())?;
    // iOS updates arrive through TestFlight, so that build never contacts GitHub.
    if cfg!(target_os = "ios") {
        return Err(UNAVAILABLE.into());
    }
    tauri::async_runtime::spawn_blocking(fetch_latest_release)
        .await
        .map_err(|_| CHECK_FAILED.to_string())?
}

#[tauri::command]
pub async fn open_app_release_page<R: Runtime>(
    webview: Webview<R>,
    version: String,
) -> Result<(), String> {
    ensure_main_webview(webview.label())?;
    let url = release_page_url(&version)?;
    open_in_system_browser(&webview, url).await
}

#[cfg(target_os = "android")]
async fn open_in_system_browser<R: Runtime>(
    webview: &Webview<R>,
    url: String,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    let (tx, rx) = std::sync::mpsc::channel();
    webview
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let result = env.with_local_frame(16, |env| -> jni::errors::Result<()> {
                    let action = JObject::from(env.new_string("android.intent.action.VIEW")?);
                    let uri_text = JObject::from(env.new_string(&url)?);
                    let uri = env
                        .call_static_method(
                            "android/net/Uri",
                            "parse",
                            "(Ljava/lang/String;)Landroid/net/Uri;",
                            &[JValue::Object(&uri_text)],
                        )?
                        .l()?;
                    let intent = env.new_object(
                        "android/content/Intent",
                        "(Ljava/lang/String;Landroid/net/Uri;)V",
                        &[JValue::Object(&action), JValue::Object(&uri)],
                    )?;
                    env.call_method(
                        activity,
                        "startActivity",
                        "(Landroid/content/Intent;)V",
                        &[JValue::Object(&intent)],
                    )?;
                    Ok(())
                });
                // Clear ActivityNotFoundException and the like without describing them.
                let exception = env.exception_check().unwrap_or(true);
                if exception {
                    let _ = env.exception_clear();
                }
                let _ = tx.send(result.is_ok() && !exception);
            });
        })
        .map_err(|_| OPEN_FAILED.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|opened| *opened)
        .map(|_| ())
        .ok_or_else(|| OPEN_FAILED.to_string())
}

#[cfg(target_os = "ios")]
async fn open_in_system_browser<R: Runtime>(
    _webview: &Webview<R>,
    _url: String,
) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[cfg(not(mobile))]
async fn open_in_system_browser<R: Runtime>(
    _webview: &Webview<R>,
    url: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        // An AppImage points these at its bundled libraries, which break the browser.
        for name in [
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "GTK_PATH",
            "GIO_MODULE_DIR",
        ] {
            command.env_remove(name);
        }
        command
    };
    let mut child = command
        .arg(url)
        .spawn()
        .map_err(|_| OPEN_FAILED.to_string())?;
    // xdg-open can stay alive as long as the browser; reap it off the command path.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_versions_build_a_release_page_address() {
        assert_eq!(
            release_page_url("0.1.10").unwrap(),
            "https://github.com/0xJean/shellbeam/releases/tag/v0.1.10"
        );
        for bad in [
            "",
            "0.1",
            "0.1.10.2",
            "0.1.x",
            "0.1.10-beta.1",
            "v0.1.10",
            "0.1.10/../../evil",
            "0.1.10?a=b",
            "1234567890.0.0",
        ] {
            assert!(release_page_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn reads_only_the_fields_it_needs_from_a_release_record() {
        let release = parse_latest_release(
            br#"{"tag_name":"v0.1.8","draft":false,"prerelease":true,"body":"notes","assets":[]}"#
                .as_slice(),
        )
        .unwrap();
        assert_eq!(
            release,
            LatestRelease {
                tag_name: "v0.1.8".into(),
                draft: false,
                prerelease: true
            }
        );
    }

    #[test]
    fn malformed_or_oversized_responses_fail_quietly() {
        for body in [&b"<html>rate limited</html>"[..], b"{}", b""] {
            assert_eq!(parse_latest_release(body).unwrap_err(), CHECK_FAILED);
        }
        let oversized = format!(
            r#"{{"body":"{}","tag_name":"v9.9.9"}}"#,
            "x".repeat(MAX_RESPONSE_BYTES as usize)
        );
        assert_eq!(
            parse_latest_release(oversized.as_bytes()).unwrap_err(),
            CHECK_FAILED
        );
    }

    /// Network test against the real endpoint: cargo test --lib app_update -- --ignored
    #[test]
    #[ignore]
    fn fetches_the_published_latest_release() {
        let release = fetch_latest_release().unwrap();
        assert!(release.tag_name.starts_with('v'));
        assert!(!release.draft && !release.prerelease);
    }

    #[test]
    fn other_webviews_cannot_use_these_commands() {
        assert!(ensure_main_webview("main").is_ok());
        assert!(ensure_main_webview("browser-1").is_err());
    }
}
