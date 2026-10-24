//! Main-webview-only handoff of a saved Komari endpoint to the mobile browser.
//! No API credential or caller-provided URL is accepted by this command.
use crate::{storage::data_file_path, vault::secrets::VaultState};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{
    collections::HashMap,
    sync::{atomic::AtomicU8, atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview};
use url::Url;

const UNAVAILABLE: &str = "KOMARI_CONSOLE_UNAVAILABLE";
const INVALID_ENDPOINT: &str = "KOMARI_CONSOLE_INVALID_ENDPOINT";
const OPEN_FAILED: &str = "KOMARI_CONSOLE_OPEN_FAILED";
const CANCELLED: &str = "KOMARI_CONSOLE_CANCELLED";
const REQUEST_TTL: Duration = Duration::from_secs(30);
const MAX_REQUESTS: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Phase {
    Prepared,
    Queued,
    #[cfg_attr(not(mobile), allow(dead_code))]
    HandedOff,
    Cancelled,
}

struct PendingConsole {
    #[cfg_attr(not(mobile), allow(dead_code))]
    vault_id: String,
    #[cfg_attr(not(mobile), allow(dead_code))]
    url: String,
    created: Instant,
    phase: AtomicU8,
}

impl PendingConsole {
    fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.created) >= REQUEST_TTL
    }

    fn cancel(&self) {
        let mut phase = self.phase.load(Ordering::Acquire);
        while phase == Phase::Prepared as u8 || phase == Phase::Queued as u8 {
            match self.phase.compare_exchange_weak(
                phase,
                Phase::Cancelled as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(current) => phase = current,
            }
        }
    }

    #[cfg(any(mobile, test))]
    fn handoff(
        &self,
        now: Instant,
        unlocked: impl FnOnce() -> bool,
        open: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if self.phase.load(Ordering::Acquire) != Phase::Queued as u8 || self.expired(now) {
            return Err(CANCELLED.into());
        }
        if !unlocked() {
            return Err("VAULT_LOCKED".into());
        }
        // The Vault mutex may briefly wait for another local transaction. Its
        // completion must not let a request cross its original deadline.
        if self.expired(Instant::now()) {
            return Err(CANCELLED.into());
        }
        // This CAS is the handoff linearization point. No mutex spans an OS API
        // call: a slow backend cannot block cancellation or our bounded waiter.
        // Cancellation after this point cannot revoke an OS handoff in progress.
        self.phase
            .compare_exchange(
                Phase::Queued as u8,
                Phase::HandedOff as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| CANCELLED.to_string())?;
        open()
    }
}

#[derive(Default)]
pub struct KomariConsoleState {
    requests: Mutex<HashMap<String, Arc<PendingConsole>>>,
}

impl KomariConsoleState {
    fn prepare(&self, vault_id: String, url: String, now: Instant) -> Result<String, String> {
        let mut requests = self.requests.lock().map_err(|_| UNAVAILABLE.to_string())?;
        requests.retain(|_, request| {
            !request.expired(now) && request.phase.load(Ordering::Acquire) != Phase::Cancelled as u8
        });
        if requests.len() >= MAX_REQUESTS {
            return Err(UNAVAILABLE.into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        requests.insert(
            id.clone(),
            Arc::new(PendingConsole {
                vault_id,
                url,
                created: now,
                phase: AtomicU8::new(Phase::Prepared as u8),
            }),
        );
        Ok(id)
    }

    fn claim(&self, id: &str, now: Instant) -> Result<Arc<PendingConsole>, String> {
        validate_request_id(id)?;
        let requests = self.requests.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let request = requests.get(id).ok_or_else(|| CANCELLED.to_string())?;
        if request.expired(now) {
            return Err(CANCELLED.into());
        }
        request
            .phase
            .compare_exchange(
                Phase::Prepared as u8,
                Phase::Queued as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| CANCELLED.to_string())?;
        Ok(request.clone())
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        validate_request_id(id)?;
        let requests = self.requests.lock().map_err(|_| UNAVAILABLE.to_string())?;
        if let Some(request) = requests.get(id) {
            request.cancel();
        }
        Ok(())
    }

    fn finish(&self, id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(id);
        }
    }
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.len() == 36 && uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        Ok(())
    } else {
        Err(UNAVAILABLE.into())
    }
}

fn ensure_main_webview(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(UNAVAILABLE.into())
    }
}

fn validate_scope(vault_id: &str, integration_id: &str) -> Result<(), String> {
    if [vault_id, integration_id].iter().any(|value| {
        value.is_empty()
            || value.len() > 240
            || value.trim() != *value
            || value.chars().any(char::is_control)
    }) {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}

fn console_url(endpoint: &str) -> Result<String, String> {
    let mut url = Url::parse(endpoint.trim()).map_err(|_| INVALID_ENDPOINT.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(INVALID_ENDPOINT.into());
    }
    url.set_query(None);
    url.set_fragment(None);
    // A saved endpoint is a base directory, including a reverse-proxy path.
    // set_path preserves already-percent-encoded URL path components.
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url.into())
}

fn saved_console_url(
    conn: &Connection,
    vault_id: &str,
    integration_id: &str,
) -> Result<String, String> {
    validate_scope(vault_id, integration_id)?;
    // Read only the endpoint, never the integration's credential reference.
    let endpoint: Option<String> = conn
        .query_row(
            "SELECT endpoint FROM komari_integrations WHERE id = ?1 AND vault_id = ?2",
            params![integration_id, vault_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| UNAVAILABLE.to_string())?;
    console_url(&endpoint.ok_or_else(|| UNAVAILABLE.to_string())?)
}

fn resolve_saved_console(app: &AppHandle, vault_id: &str, id: &str) -> Result<String, String> {
    read_unlocked_console(&app.state::<VaultState>(), vault_id, id, || {
        let path = data_file_path(app, "workspace_inventory.sqlite3")
            .map_err(|_| UNAVAILABLE.to_string())?;
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| UNAVAILABLE.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(1))
            .map_err(|_| UNAVAILABLE.to_string())?;
        saved_console_url(&conn, vault_id, id)
    })
}

fn read_unlocked_console(
    state: &VaultState,
    vault_id: &str,
    id: &str,
    read: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    validate_scope(vault_id, id)?;
    state.while_unlocked(vault_id, read)
}

#[tauri::command]
pub fn komari_console_mode(webview: Webview) -> Result<&'static str, String> {
    ensure_main_webview(webview.label())?;
    Ok(if cfg!(mobile) { "mobile" } else { "desktop" })
}

#[tauri::command]
pub async fn prepare_mobile_komari_console(
    app: AppHandle,
    webview: Webview,
    vault_id: String,
    integration_id: String,
) -> Result<String, String> {
    ensure_main_webview(webview.label())?;
    if !cfg!(mobile) {
        return Err(UNAVAILABLE.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let url = resolve_saved_console(&app, &vault_id, &integration_id)?;
        app.state::<KomariConsoleState>()
            .prepare(vault_id, url, Instant::now())
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?
}

#[tauri::command]
pub fn cancel_mobile_komari_console(
    app: AppHandle,
    webview: Webview,
    request_id: String,
) -> Result<(), String> {
    ensure_main_webview(webview.label())?;
    app.state::<KomariConsoleState>().cancel(&request_id)
}

#[tauri::command]
pub async fn open_mobile_komari_console(
    app: AppHandle,
    webview: Webview,
    request_id: String,
) -> Result<(), String> {
    ensure_main_webview(webview.label())?;
    let request = app
        .state::<KomariConsoleState>()
        .claim(&request_id, Instant::now())?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = open_system_browser(&app, &request);
        // The queued platform closure owns the same Arc: cancellation/expiry
        // remains effective even if a timed-out waiter removes the map entry.
        request.cancel();
        app.state::<KomariConsoleState>().finish(&request_id);
        result
    })
    .await
    .map_err(|_| OPEN_FAILED.to_string())?
}

#[cfg(target_os = "android")]
fn open_system_browser(app: &AppHandle, request: &Arc<PendingConsole>) -> Result<(), String> {
    use jni::objects::{JObject, JValue};
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let queued_request = request.clone();
    let queued_app = app.clone();
    app.get_webview("main")
        .ok_or(UNAVAILABLE)?
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                // Bound JNI references on this long-lived UI thread. Construct
                // the Intent before the CAS so even slow allocation stays cancellable.
                let result =
                    env.with_local_frame(16, |env| -> jni::errors::Result<Result<(), String>> {
                        let action = JObject::from(env.new_string("android.intent.action.VIEW")?);
                        let uri_text = JObject::from(env.new_string(&queued_request.url)?);
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
                        // Check token/TTL/Vault on the actual Android context,
                        // immediately before startActivity. No unchecked plugin
                        // queue or JS opener capability is involved.
                        Ok(queued_request.handoff(
                            Instant::now(),
                            || {
                                queued_app
                                    .state::<VaultState>()
                                    .is_unlocked(&queued_request.vault_id)
                            },
                            || {
                                env.call_method(
                                    activity,
                                    "startActivity",
                                    "(Landroid/content/Intent;)V",
                                    &[JValue::Object(&intent)],
                                )
                                .map(|_| ())
                                .map_err(|_| OPEN_FAILED.to_string())
                            },
                        ))
                    });
                // Clear Java exceptions (including ActivityNotFoundException)
                // without describing them: OS messages may contain the URL.
                let exception = env.exception_check().unwrap_or(true);
                if exception {
                    let _ = env.exception_clear();
                }
                let result = match result {
                    Ok(handoff) if !exception => handoff,
                    _ => Err(OPEN_FAILED.into()),
                };
                let _ = tx.send(result);
            });
        })
        .map_err(|_| OPEN_FAILED.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| OPEN_FAILED.to_string())?
}

#[cfg(target_os = "ios")]
fn open_system_browser(app: &AppHandle, request: &Arc<PendingConsole>) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::{runtime::Bool, MainThreadMarker};
    use objc2_foundation::{NSDictionary, NSString, NSURL};
    use objc2_ui_kit::UIApplication;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let queued_request = request.clone();
    let queued_app = app.clone();
    app.run_on_main_thread(move || {
        let Some(main_thread) = MainThreadMarker::new() else {
            let _ = tx.send(Err(OPEN_FAILED.to_string()));
            return;
        };
        let Some(url) = NSURL::URLWithString(&NSString::from_str(&queued_request.url)) else {
            let _ = tx.send(Err(INVALID_ENDPOINT.to_string()));
            return;
        };
        let completion_tx = tx.clone();
        let completion = RcBlock::new(move |opened: Bool| {
            let result = if opened.as_bool() {
                Ok(())
            } else {
                Err(OPEN_FAILED.to_string())
            };
            let _ = completion_tx.send(result);
        });
        // SAFETY: the URL and empty typed options are valid Foundation objects.
        // UIKit copies the completion block before returning. Only Apple's actual
        // success callback counts as a successful browser handoff.
        let result = queued_request.handoff(
            Instant::now(),
            || {
                queued_app
                    .state::<VaultState>()
                    .is_unlocked(&queued_request.vault_id)
            },
            || {
                unsafe {
                    UIApplication::sharedApplication(main_thread)
                        .openURL_options_completionHandler(
                            &url,
                            &NSDictionary::new(),
                            Some(&completion),
                        );
                }
                Ok(())
            },
        );
        if let Err(error) = result {
            let _ = tx.send(Err(error));
        }
    })
    .map_err(|_| OPEN_FAILED.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| OPEN_FAILED.to_string())?
}

#[cfg(not(mobile))]
fn open_system_browser(_app: &AppHandle, _request: &Arc<PendingConsole>) -> Result<(), String> {
    // Desktop callers keep the existing isolated browser-window behavior.
    Err(UNAVAILABLE.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepare(state: &KomariConsoleState, now: Instant) -> String {
        state
            .prepare("vault-a".into(), "https://komari.example/base/".into(), now)
            .unwrap()
    }

    #[test]
    fn prepared_tokens_are_single_use_and_do_not_expose_an_endpoint() {
        let state = KomariConsoleState::default();
        let now = Instant::now();
        let token = prepare(&state, now);
        assert!(uuid::Uuid::parse_str(&token).is_ok());
        let request = state.claim(&token, now).unwrap();
        assert_eq!(request.vault_id, "vault-a");
        assert_eq!(request.url, "https://komari.example/base/");
        assert!(matches!(state.claim(&token, now), Err(error) if error == CANCELLED));
        request.handoff(now, || true, || Ok(())).unwrap();
        request.cancel(); // OS handoffs cannot be revoked or replayed.
        assert_eq!(
            request.phase.load(Ordering::Acquire),
            Phase::HandedOff as u8
        );
        assert_eq!(
            request
                .handoff(now, || true, || panic!("No replay"))
                .unwrap_err(),
            CANCELLED
        );
        state.finish(&token);
        assert!(matches!(state.claim(&token, now), Err(error) if error == CANCELLED));
    }

    #[test]
    fn cancellation_before_open_and_inside_a_platform_queue_prevents_any_handoff() {
        let state = KomariConsoleState::default();
        let now = Instant::now();
        let prepared = prepare(&state, now);
        state.cancel(&prepared).unwrap();
        assert!(matches!(state.claim(&prepared, now), Err(error) if error == CANCELLED));

        let token = prepare(&state, now);
        let queued = state.claim(&token, now).unwrap();
        state.cancel(&token).unwrap();
        // Even if its waiter has timed out and removed the registry row, the
        // actual Android/iOS queue still holds this same cancellation Arc.
        state.finish(&token);
        assert_eq!(
            queued
                .handoff(now, || panic!("No Vault read"), || panic!("No OS call"))
                .unwrap_err(),
            CANCELLED
        );
    }

    #[test]
    fn a_slow_os_handoff_never_blocks_cancellation_or_registry_cleanup() {
        use std::sync::mpsc;
        let state = Arc::new(KomariConsoleState::default());
        let now = Instant::now();
        let token = prepare(&state, now);
        let queued = state.claim(&token, now).unwrap();
        let retained_request = queued.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            queued.handoff(
                now,
                || true,
                || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Err(OPEN_FAILED.into())
                },
            )
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        let cancel_state = state.clone();
        let canceller = std::thread::spawn(move || {
            cancel_state.cancel(&token).unwrap();
            cancel_state.finish(&token);
            cancelled_tx.send(()).unwrap();
        });
        let cancelled_before_backend_returns = cancelled_rx.recv_timeout(Duration::from_secs(2));
        // Always release/join both workers, including a regression failure path.
        release_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err(), OPEN_FAILED);
        canceller.join().unwrap();
        assert!(cancelled_before_backend_returns.is_ok());
        assert!(state.requests.lock().unwrap().is_empty());
        assert_eq!(
            retained_request.phase.load(Ordering::Acquire),
            Phase::HandedOff as u8
        );
    }

    #[test]
    fn expiry_and_vault_lock_are_rechecked_at_the_actual_platform_handoff() {
        let state = KomariConsoleState::default();
        let now = Instant::now();
        let token = prepare(&state, now);
        let queued = state.claim(&token, now).unwrap();
        assert_eq!(
            queued
                .handoff(now + REQUEST_TTL, || true, || panic!("Expired OS call"))
                .unwrap_err(),
            CANCELLED
        );
        assert!(matches!(state.claim(&token, now + REQUEST_TTL), Err(error) if error == CANCELLED));

        let token = prepare(&state, now);
        let queued = state.claim(&token, now).unwrap();
        assert_eq!(
            queued
                .handoff(now, || false, || panic!("Locked Vault OS call"))
                .unwrap_err(),
            "VAULT_LOCKED"
        );
    }

    #[test]
    fn a_request_that_expires_during_the_vault_check_cannot_start_an_os_handoff() {
        let state = KomariConsoleState::default();
        let created = Instant::now() - REQUEST_TTL;
        let token = prepare(&state, created);
        let queued = state.claim(&token, created).unwrap();
        let vault_was_checked = std::cell::Cell::new(false);
        // The injected entry time is still in-budget. Actual wall time is beyond
        // the deadline when the Vault callback returns; no sleeping is required.
        let result = queued.handoff(
            created,
            || {
                vault_was_checked.set(true);
                true
            },
            || panic!("Expired after Vault check"),
        );
        assert!(vault_was_checked.get());
        assert_eq!(result.unwrap_err(), CANCELLED);
    }

    #[test]
    fn registry_is_bounded_and_reclaims_cancelled_prepares_and_expired_requests() {
        let state = KomariConsoleState::default();
        let now = Instant::now();
        let first = prepare(&state, now);
        for _ in 1..MAX_REQUESTS {
            prepare(&state, now);
        }
        assert_eq!(
            state
                .prepare("vault-a".into(), "https://komari.example/".into(), now)
                .unwrap_err(),
            UNAVAILABLE
        );
        state.cancel(&first).unwrap();
        prepare(&state, now);
        assert_eq!(state.requests.lock().unwrap().len(), MAX_REQUESTS);
        let fresh = prepare(&state, now + REQUEST_TTL);
        assert_eq!(state.requests.lock().unwrap().len(), 1);
        assert!(state.claim(&fresh, now + REQUEST_TTL).is_ok());
        assert_eq!(state.cancel("not-a-token").unwrap_err(), UNAVAILABLE);
    }

    #[test]
    fn only_the_main_webview_may_resolve_or_open_a_console() {
        assert!(ensure_main_webview("main").is_ok());
        for label in ["", "komari-console-123", "browser-remote", "Main"] {
            assert_eq!(ensure_main_webview(label).unwrap_err(), UNAVAILABLE);
        }
    }

    #[test]
    fn a_locked_vault_cannot_even_read_the_saved_browser_address() {
        let state = VaultState::default();
        let result = read_unlocked_console(&state, "vault-a", "saved-id", || {
            panic!("A locked Vault must not read any integration endpoint")
        });
        assert_eq!(result.unwrap_err(), "VAULT_LOCKED");
    }

    #[test]
    fn preserves_private_http_and_proxy_paths_without_credentials_or_url_state() {
        for (input, expected) in [
            ("https://komari.example", "https://komari.example/"),
            (
                "http://192.168.0.2:25774/base",
                "http://192.168.0.2:25774/base/",
            ),
            ("http://[::1]:25774/", "http://[::1]:25774/"),
            (
                "https://komari.example/proxy///",
                "https://komari.example/proxy/",
            ),
            (
                "https://komari.example/team%20ops?token=secret#state",
                "https://komari.example/team%20ops/",
            ),
        ] {
            assert_eq!(console_url(input).unwrap(), expected);
        }
        for input in [
            "",
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///tmp/console",
            "ftp://komari.example",
            "https://user:secret@komari.example",
            "https://token@komari.example",
        ] {
            assert_eq!(console_url(input).unwrap_err(), INVALID_ENDPOINT);
        }
    }

    #[test]
    fn looks_up_only_the_saved_endpoint_with_the_exact_vault_and_integration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE komari_integrations (id TEXT, vault_id TEXT, endpoint TEXT, credential_ref TEXT);").unwrap();
        conn.execute(
            "INSERT INTO komari_integrations VALUES (?1, ?2, ?3, ?4)",
            params![
                "same-id",
                "vault-a",
                "http://192.168.0.2:25774/base?token=do-not-pass#state",
                "private-key-ref"
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO komari_integrations VALUES (?1, ?2, ?3, ?4)",
            params![
                "same-id",
                "vault-b",
                "https://other.example/other",
                "other-private-key-ref"
            ],
        )
        .unwrap();
        assert_eq!(
            saved_console_url(&conn, "vault-a", "same-id").unwrap(),
            "http://192.168.0.2:25774/base/"
        );
        assert_eq!(
            saved_console_url(&conn, "vault-b", "same-id").unwrap(),
            "https://other.example/other/"
        );
        for (vault, id) in [
            ("vault-c", "same-id"),
            ("vault-a", "missing"),
            ("", "same-id"),
            (" vault-a", "same-id"),
            ("vault-a", "same-id\n"),
        ] {
            assert_eq!(
                saved_console_url(&conn, vault, id).unwrap_err(),
                UNAVAILABLE
            );
        }
    }
}
