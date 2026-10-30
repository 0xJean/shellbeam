use crate::ssh::interactive::InteractiveSessionState;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(not(mobile))]
use tauri::webview::{PageLoadEvent, WebviewBuilder, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Runtime};
#[cfg(not(mobile))]
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Webview, WebviewUrl, WebviewWindow, WindowEvent,
};

#[cfg(target_os = "macos")]
use objc::runtime::Object;
#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl};

/// A live in-process tunnel: a shutdown sender.
struct TunnelHandle {
    shutdown: std::sync::mpsc::Sender<()>,
}

lazy_static::lazy_static! {
    static ref BROWSER_PORT_FORWARDS: Mutex<HashMap<String, TunnelHandle>> = Mutex::new(HashMap::new());
    static ref BROWSER_HTTP_PROXIES: Mutex<HashMap<String, TunnelHandle>> = Mutex::new(HashMap::new());
    static ref BROWSER_SOCKS_PROXIES: Mutex<HashMap<String, TunnelHandle>> = Mutex::new(HashMap::new());
    static ref BROWSER_PROXY_CONFIGS: Mutex<HashMap<String, Option<String>>> = Mutex::new(HashMap::new());
    static ref BROWSER_LAST_PAGE_LOADS: Mutex<HashMap<String, BrowserPageLoadMarker>> = Mutex::new(HashMap::new());
}

const MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_STATE_EVENT: &str = "shellbeam://browser-state";
const BROWSER_WINDOW_CLOSED_EVENT: &str = "shellbeam://browser-window-closed";
const PAGE_LOAD_DEDUPE_WINDOW_MS: u128 = 400;

#[derive(Debug, Clone)]
struct BrowserPageLoadMarker {
    url: String,
    is_loading: bool,
    seen_at_ms: u128,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBrowserWindowRequest {
    pub browser_id: String,
    pub session_id: String,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSourcePayload {
    pub kind: String,
    pub url: Option<String>,
    pub html: Option<String>,
    pub base_url: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadBrowserSourceRequest {
    pub browser_id: String,
    pub session_id: String,
    pub source: BrowserSourcePayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionRequest {
    pub browser_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatePayload {
    pub browser_id: String,
    pub session_id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub is_loading: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindowClosedPayload {
    pub browser_id: String,
    pub session_id: String,
}

fn browser_window_label(browser_id: &str) -> String {
    format!("browser-window-{browser_id}")
}

fn browser_proxy_config(browser_id: &str) -> Option<Option<String>> {
    BROWSER_PROXY_CONFIGS
        .lock()
        .ok()
        .and_then(|configs| configs.get(browser_id).cloned())
}

fn set_browser_proxy_config(browser_id: &str, proxy_url: Option<String>) {
    if let Ok(mut configs) = BROWSER_PROXY_CONFIGS.lock() {
        configs.insert(browser_id.to_string(), proxy_url);
    }
}

fn clear_browser_proxy_config(browser_id: &str) {
    if let Ok(mut configs) = BROWSER_PROXY_CONFIGS.lock() {
        configs.remove(browser_id);
    }
}

fn browser_now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn should_suppress_page_load_marker(
    previous: Option<&BrowserPageLoadMarker>,
    url: &str,
    is_loading: bool,
    now_ms: u128,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };

    previous.url == url
        && previous.is_loading == is_loading
        && now_ms.saturating_sub(previous.seen_at_ms) < PAGE_LOAD_DEDUPE_WINDOW_MS
}

fn should_suppress_page_load_event(browser_id: &str, url: &str, is_loading: bool) -> bool {
    let now_ms = browser_now_ms();
    let marker = BrowserPageLoadMarker {
        url: url.to_string(),
        is_loading,
        seen_at_ms: now_ms,
    };

    if let Ok(mut markers) = BROWSER_LAST_PAGE_LOADS.lock() {
        let should_suppress =
            should_suppress_page_load_marker(markers.get(browser_id), url, is_loading, now_ms);
        markers.insert(browser_id.to_string(), marker);
        return should_suppress;
    }

    false
}

fn clear_browser_page_load_state(browser_id: &str) {
    if let Ok(mut markers) = BROWSER_LAST_PAGE_LOADS.lock() {
        markers.remove(browser_id);
    }
}

fn browser_proxy_config_changed(browser_id: &str, requested_proxy_url: Option<&str>) -> bool {
    match browser_proxy_config(browser_id) {
        Some(existing_proxy_url) => existing_proxy_url.as_deref() != requested_proxy_url,
        None => false,
    }
}

fn is_duplicate_browser_label_error(error: &str) -> bool {
    error.to_ascii_lowercase().contains("already exists")
}

fn normalize_url(url: &str) -> Result<url::Url, String> {
    url::Url::parse(url).map_err(|error| error.to_string())
}

fn webview_data_url(html: &str) -> Result<url::Url, String> {
    normalize_url(&format!(
        "data:text/html;charset=utf-8,{}",
        urlencoding::encode(html)
    ))
}

fn blank_browser_html() -> String {
    "<!doctype html><html><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><style>:root{color-scheme:dark;}html,body{margin:0;height:100%;background:#0f172a;}</style></head><body></body></html>".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPortForwardRequest {
    pub vault_id: Option<String>,
    pub host_id: Option<String>,
    pub accepted_host_key: Option<crate::ssh::transport::HostKeyAcceptance>,
    pub browser_id: String,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHttpProxyRequest {
    pub vault_id: Option<String>,
    pub host_id: Option<String>,
    pub accepted_host_key: Option<crate::ssh::transport::HostKeyAcceptance>,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
}

#[cfg(not(mobile))]
fn browser_window<R: Runtime>(app: &AppHandle<R>, browser_id: &str) -> Option<WebviewWindow<R>> {
    app.get_webview_window(&browser_window_label(browser_id))
}

#[cfg(not(mobile))]
fn browser_webview<R: Runtime>(app: &AppHandle<R>, browser_id: &str) -> Option<Webview<R>> {
    app.get_webview(&browser_window_label(browser_id))
}

#[cfg(not(mobile))]
fn emit_browser_state<R: Runtime>(
    app: &AppHandle<R>,
    payload: BrowserStatePayload,
) -> Result<(), String> {
    app.emit_to(MAIN_WINDOW_LABEL, BROWSER_STATE_EVENT, payload)
        .map_err(|error| error.to_string())
}

#[cfg(not(mobile))]
fn emit_browser_window_closed<R: Runtime>(
    app: &AppHandle<R>,
    payload: BrowserWindowClosedPayload,
) -> Result<(), String> {
    app.emit_to(MAIN_WINDOW_LABEL, BROWSER_WINDOW_CLOSED_EVENT, payload)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn wkwebview_can_go_back<R: Runtime>(webview: &Webview<R>) -> Result<bool, String> {
    let value = Arc::new(Mutex::new(false));
    let value_ref = value.clone();
    webview
        .with_webview(move |native| unsafe {
            let wk_webview: *mut Object = native.inner() as *mut Object;
            if let Ok(mut stored) = value_ref.lock() {
                *stored = msg_send![wk_webview, canGoBack];
            }
        })
        .map_err(|error| error.to_string())?;
    value
        .lock()
        .map(|stored| *stored)
        .map_err(|_| "Browser navigation state mutex poisoned".to_string())
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn wkwebview_can_go_back<R: Runtime>(webview: &Webview<R>) -> Result<bool, String> {
    use webkit2gtk::WebViewExt;
    let value = Arc::new(Mutex::new(false));
    let value_ref = value.clone();
    webview
        .with_webview(move |native| {
            if let Ok(mut stored) = value_ref.lock() {
                *stored = native.inner().can_go_back();
            }
        })
        .map_err(|error| error.to_string())?;
    value
        .lock()
        .map(|stored| *stored)
        .map_err(|_| "Browser navigation state mutex poisoned".to_string())
}

#[cfg(windows)]
fn wkwebview_can_go_back<R: Runtime>(webview: &Webview<R>) -> Result<bool, String> {
    use webview2_com_sys::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    let value = Arc::new(Mutex::new(false));
    let value_ref = value.clone();
    webview
        .with_webview(move |native| unsafe {
            let controller: ICoreWebView2Controller = native.controller();
            let core = controller
                .CoreWebView2()
                .map_err(|error| error.to_string())
                .unwrap();
            let mut raw = Default::default();
            core.CanGoBack(&mut raw)
                .map_err(|error| error.to_string())
                .unwrap();
            if let Ok(mut stored) = value_ref.lock() {
                *stored = raw.as_bool();
            }
        })
        .map_err(|error| error.to_string())?;
    value
        .lock()
        .map(|stored| *stored)
        .map_err(|_| "Browser navigation state mutex poisoned".to_string())
}

#[cfg(all(
    not(mobile),
    not(any(
        target_os = "macos",
        windows,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))
))]
fn wkwebview_can_go_back<R: Runtime>(_webview: &Webview<R>) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
fn wkwebview_can_go_forward<R: Runtime>(webview: &Webview<R>) -> Result<bool, String> {
    let value = Arc::new(Mutex::new(false));
    let value_ref = value.clone();
    webview
        .with_webview(move |native| unsafe {
            let wk_webview: *mut Object = native.inner() as *mut Object;
            if let Ok(mut stored) = value_ref.lock() {
                *stored = msg_send![wk_webview, canGoForward];
            }
        })
        .map_err(|error| error.to_string())?;
    value
        .lock()
        .map(|stored| *stored)
        .map_err(|_| "Browser navigation state mutex poisoned".to_string())
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn wkwebview_can_go_forward<R: Runtime>(webview: &Webview<R>) -> Result<bool, String> {
    use webkit2gtk::WebViewExt;
    let value = Arc::new(Mutex::new(false));
    let value_ref = value.clone();
    webview
        .with_webview(move |native| {
            if let Ok(mut stored) = value_ref.lock() {
                *stored = native.inner().can_go_forward();
            }
        })
        .map_err(|error| error.to_string())?;
    value
        .lock()
        .map(|stored| *stored)
        .map_err(|_| "Browser navigation state mutex poisoned".to_string())
}

#[cfg(windows)]
fn wkwebview_can_go_forward<R: Runtime>(webview: &Webview<R>) -> Result<bool, String> {
    use webview2_com_sys::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    let value = Arc::new(Mutex::new(false));
    let value_ref = value.clone();
    webview
        .with_webview(move |native| unsafe {
            let controller: ICoreWebView2Controller = native.controller();
            let core = controller
                .CoreWebView2()
                .map_err(|error| error.to_string())
                .unwrap();
            let mut raw = Default::default();
            core.CanGoForward(&mut raw)
                .map_err(|error| error.to_string())
                .unwrap();
            if let Ok(mut stored) = value_ref.lock() {
                *stored = raw.as_bool();
            }
        })
        .map_err(|error| error.to_string())?;
    value
        .lock()
        .map(|stored| *stored)
        .map_err(|_| "Browser navigation state mutex poisoned".to_string())
}

#[cfg(all(
    not(mobile),
    not(any(
        target_os = "macos",
        windows,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))
))]
fn wkwebview_can_go_forward<R: Runtime>(_webview: &Webview<R>) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
fn wkwebview_go_back<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    webview
        .with_webview(move |native| unsafe {
            let wk_webview: *mut Object = native.inner() as *mut Object;
            let _: *mut Object = msg_send![wk_webview, goBack];
        })
        .map_err(|error| error.to_string())
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn wkwebview_go_back<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    webview
        .with_webview(move |native| {
            native.inner().go_back();
        })
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn wkwebview_go_back<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    use webview2_com_sys::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    webview
        .with_webview(move |native| unsafe {
            let controller: ICoreWebView2Controller = native.controller();
            let core = controller
                .CoreWebView2()
                .map_err(|error| error.to_string())
                .unwrap();
            core.GoBack().map_err(|error| error.to_string()).unwrap();
        })
        .map_err(|error| error.to_string())
}

#[cfg(all(
    not(mobile),
    not(any(
        target_os = "macos",
        windows,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))
))]
fn wkwebview_go_back<R: Runtime>(_webview: &Webview<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn wkwebview_go_forward<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    webview
        .with_webview(move |native| unsafe {
            let wk_webview: *mut Object = native.inner() as *mut Object;
            let _: *mut Object = msg_send![wk_webview, goForward];
        })
        .map_err(|error| error.to_string())
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn wkwebview_go_forward<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    webview
        .with_webview(move |native| {
            native.inner().go_forward();
        })
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn wkwebview_go_forward<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    use webview2_com_sys::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    webview
        .with_webview(move |native| unsafe {
            let controller: ICoreWebView2Controller = native.controller();
            let core = controller
                .CoreWebView2()
                .map_err(|error| error.to_string())
                .unwrap();
            core.GoForward().map_err(|error| error.to_string()).unwrap();
        })
        .map_err(|error| error.to_string())
}

#[cfg(all(
    not(mobile),
    not(any(
        target_os = "macos",
        windows,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))
))]
fn wkwebview_go_forward<R: Runtime>(_webview: &Webview<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(mobile))]
fn emit_navigation_capabilities<R: Runtime>(
    app: &AppHandle<R>,
    webview: &Webview<R>,
    browser_id: String,
    session_id: String,
) -> Result<(), String> {
    let can_go_back = wkwebview_can_go_back(webview)?;
    let can_go_forward = wkwebview_can_go_forward(webview)?;
    app.emit_to(
        MAIN_WINDOW_LABEL,
        BROWSER_STATE_EVENT,
        serde_json::json!({
            "browserId": browser_id,
            "sessionId": session_id,
            "canGoBack": can_go_back,
            "canGoForward": can_go_forward,
        }),
    )
    .map_err(|error| error.to_string())
}

#[cfg(not(mobile))]
fn build_embedded_browser<R: Runtime>(
    app: &AppHandle<R>,
    request: &OpenBrowserWindowRequest,
) -> Result<Webview<R>, String> {
    let initial_url = webview_data_url(&blank_browser_html())?;
    let label = browser_window_label(&request.browser_id);
    let browser_id = request.browser_id.clone();
    let session_id = request.session_id.clone();

    let browser_id_for_title = browser_id.clone();
    let session_id_for_title = session_id.clone();
    let browser_id_for_load = browser_id.clone();
    let session_id_for_load = session_id.clone();

    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or("Main window not found")?;

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(initial_url))
        .zoom_hotkeys_enabled(true)
        .on_document_title_changed(move |webview, title| {
            let _ = emit_browser_state(
                &webview.app_handle(),
                BrowserStatePayload {
                    browser_id: browser_id_for_title.clone(),
                    session_id: session_id_for_title.clone(),
                    url: None,
                    title: Some(title),
                    is_loading: None,
                    error: None,
                },
            );
            let _ = emit_navigation_capabilities(
                &webview.app_handle(),
                &webview,
                browser_id_for_title.clone(),
                session_id_for_title.clone(),
            );
        })
        .on_page_load(move |webview, payload| {
            let raw_url = payload.url().to_string();
            let is_blank = raw_url.starts_with("data:");
            // Suppress all events for the synthetic blank data: page that is
            // used only to initialise the webview.  The real URL events will
            // arrive once the actual page starts loading.
            if is_blank {
                return;
            }
            let is_loading = matches!(payload.event(), PageLoadEvent::Started);
            if should_suppress_page_load_event(&browser_id_for_load, &raw_url, is_loading) {
                return;
            }
            let event_type = if is_loading { "Started" } else { "Finished" };
            log::info!(
                "[Browser] on_page_load(embedded): id={} {} url={} blank={}",
                browser_id_for_load,
                event_type,
                &raw_url[..raw_url.len().min(120)],
                is_blank
            );
            let event = match payload.event() {
                PageLoadEvent::Started => BrowserStatePayload {
                    browser_id: browser_id_for_load.clone(),
                    session_id: session_id_for_load.clone(),
                    url: Some(raw_url),
                    title: None,
                    is_loading: Some(true),
                    error: None,
                },
                PageLoadEvent::Finished => BrowserStatePayload {
                    browser_id: browser_id_for_load.clone(),
                    session_id: session_id_for_load.clone(),
                    url: Some(raw_url),
                    title: None,
                    is_loading: Some(false),
                    error: None,
                },
            };
            let _ = emit_browser_state(&webview.app_handle(), event);
            let _ = emit_navigation_capabilities(
                &webview.app_handle(),
                &webview,
                browser_id_for_load.clone(),
                session_id_for_load.clone(),
            );
        });

    if let Some(proxy) = request.proxy_url.as_ref() {
        if let Ok(parsed) = normalize_url(proxy) {
            builder = builder.proxy_url(parsed);
        }
    }

    let webview = main_window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(800.0, 600.0),
        )
        .map_err(|error| error.to_string())?;

    webview.hide().map_err(|error| error.to_string())?;
    set_browser_proxy_config(&request.browser_id, request.proxy_url.clone());
    Ok(webview)
}

#[cfg(not(mobile))]
fn build_browser_window<R: Runtime>(
    app: &AppHandle<R>,
    request: &OpenBrowserWindowRequest,
) -> Result<WebviewWindow<R>, String> {
    let initial_url = webview_data_url(&blank_browser_html())?;
    let label = browser_window_label(&request.browser_id);
    let browser_id = request.browser_id.clone();
    let session_id = request.session_id.clone();

    let browser_id_for_title = browser_id.clone();
    let session_id_for_title = session_id.clone();
    let browser_id_for_load = browser_id.clone();
    let session_id_for_load = session_id.clone();

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(initial_url))
        .title("ShellBeam Browser")
        .inner_size(1200.0, 820.0)
        .visible(true)
        .on_document_title_changed(move |webview_window, title| {
            let _ = emit_browser_state(
                &webview_window.app_handle(),
                BrowserStatePayload {
                    browser_id: browser_id_for_title.clone(),
                    session_id: session_id_for_title.clone(),
                    url: None,
                    title: Some(title),
                    is_loading: None,
                    error: None,
                },
            );
            if let Some(webview) =
                browser_webview(&webview_window.app_handle(), &browser_id_for_title)
            {
                let _ = emit_navigation_capabilities(
                    &webview_window.app_handle(),
                    &webview,
                    browser_id_for_title.clone(),
                    session_id_for_title.clone(),
                );
            }
        })
        .on_page_load(move |webview_window, payload| {
            let raw_url = payload.url().to_string();
            if raw_url.starts_with("data:") {
                return;
            }
            let is_loading = matches!(payload.event(), PageLoadEvent::Started);
            if should_suppress_page_load_event(&browser_id_for_load, &raw_url, is_loading) {
                return;
            }
            let event_type = if is_loading { "Started" } else { "Finished" };
            log::info!(
                "[Browser] on_page_load(window): id={} {} url={}",
                browser_id_for_load,
                event_type,
                &raw_url[..raw_url.len().min(120)]
            );
            let event = match payload.event() {
                PageLoadEvent::Started => BrowserStatePayload {
                    browser_id: browser_id_for_load.clone(),
                    session_id: session_id_for_load.clone(),
                    url: Some(raw_url),
                    title: None,
                    is_loading: Some(true),
                    error: None,
                },
                PageLoadEvent::Finished => BrowserStatePayload {
                    browser_id: browser_id_for_load.clone(),
                    session_id: session_id_for_load.clone(),
                    url: Some(raw_url),
                    title: None,
                    is_loading: Some(false),
                    error: None,
                },
            };
            let _ = emit_browser_state(&webview_window.app_handle(), event);
            if let Some(webview) =
                browser_webview(&webview_window.app_handle(), &browser_id_for_load)
            {
                let _ = emit_navigation_capabilities(
                    &webview_window.app_handle(),
                    &webview,
                    browser_id_for_load.clone(),
                    session_id_for_load.clone(),
                );
            }
        });

    if let Some(proxy) = request.proxy_url.as_ref() {
        if let Ok(parsed) = normalize_url(proxy) {
            builder = builder.proxy_url(parsed);
        }
    }

    let window = builder.build().map_err(|error| error.to_string())?;
    set_browser_proxy_config(&request.browser_id, request.proxy_url.clone());

    let app_handle = app.clone();
    let browser_id_for_close = request.browser_id.clone();
    let session_id_for_close = request.session_id.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            let _ = emit_browser_window_closed(
                &app_handle,
                BrowserWindowClosedPayload {
                    browser_id: browser_id_for_close.clone(),
                    session_id: session_id_for_close.clone(),
                },
            );
        }
    });

    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::{
        blank_browser_html, browser_window_label, should_suppress_page_load_marker,
        BrowserPageLoadMarker,
    };
    use std::net::TcpListener;

    #[test]
    fn blank_browser_html_uses_dark_shell_background() {
        let html = blank_browser_html();

        assert!(html.contains("color-scheme:dark;"));
        assert!(html.contains("background:#0f172a;"));
        assert!(html.contains("<body></body>"));
    }

    #[test]
    fn browser_window_label_uses_distinct_window_namespace() {
        assert_eq!(
            browser_window_label("session-1"),
            "browser-window-session-1"
        );
    }

    #[test]
    fn find_free_port_binds_a_usable_port() {
        // Verify that a newly bound listener is immediately connectable –
        // the same guarantee our in-process tunnel relies on.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let port = listener.local_addr().expect("listener addr").port();
        std::net::TcpStream::connect(format!("127.0.0.1:{port}"))
            .expect("port should be reachable");
    }

    #[test]
    fn suppresses_duplicate_page_load_markers_for_same_url_and_phase() {
        let previous = BrowserPageLoadMarker {
            url: "https://www.baidu.com/".to_string(),
            is_loading: true,
            seen_at_ms: 1_000,
        };

        assert!(should_suppress_page_load_marker(
            Some(&previous),
            "https://www.baidu.com/",
            true,
            1_200,
        ));
        assert!(!should_suppress_page_load_marker(
            Some(&previous),
            "https://www.baidu.com/",
            false,
            1_200,
        ));
        assert!(!should_suppress_page_load_marker(
            Some(&previous),
            "https://www.baidu.com/",
            true,
            1_500,
        ));
    }
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn open_embedded_browser<R: Runtime>(
    app: AppHandle<R>,
    request: OpenBrowserWindowRequest,
) -> Result<(), String> {
    log::info!(
        "[Browser] open_embedded_browser: id={}, proxy={:?}",
        request.browser_id,
        request.proxy_url
    );
    if browser_webview(&app, &request.browser_id).is_some() {
        if browser_proxy_config_changed(&request.browser_id, request.proxy_url.as_deref()) {
            log::info!(
                "[Browser] open_embedded_browser: proxy config changed, recreating id={} old={:?} new={:?}",
                request.browser_id,
                browser_proxy_config(&request.browser_id).flatten(),
                request.proxy_url
            );
            close_browser_window(
                app.clone(),
                request.browser_id.clone(),
                request.session_id.clone(),
            )
            .await?;
        } else {
            log::info!(
                "[Browser] open_embedded_browser: already exists, reusing id={}",
                request.browser_id
            );
            return Ok(());
        }
    }
    if let Err(error) = build_embedded_browser(&app, &request) {
        if is_duplicate_browser_label_error(&error)
            && browser_webview(&app, &request.browser_id).is_some()
        {
            log::warn!(
                "[Browser] open_embedded_browser: duplicate label raced with registration, reusing id={}",
                request.browser_id
            );
            return Ok(());
        }
        return Err(error);
    }
    log::info!(
        "[Browser] open_embedded_browser: created OK id={}",
        request.browser_id
    );
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn open_embedded_browser<R: Runtime>(
    _app: AppHandle<R>,
    _request: OpenBrowserWindowRequest,
) -> Result<(), String> {
    Err("Embedded browser is not supported on mobile builds".to_string())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn open_browser_window<R: Runtime>(
    app: AppHandle<R>,
    request: OpenBrowserWindowRequest,
) -> Result<(), String> {
    log::info!("[Browser] open_browser_window: id={}", request.browser_id);
    if let Some(window) = browser_window(&app, &request.browser_id) {
        if browser_proxy_config_changed(&request.browser_id, request.proxy_url.as_deref()) {
            log::info!(
                "[Browser] open_browser_window: proxy config changed, recreating id={} old={:?} new={:?}",
                request.browser_id,
                browser_proxy_config(&request.browser_id).flatten(),
                request.proxy_url
            );
            window.close().map_err(|e| e.to_string())?;
            clear_browser_proxy_config(&request.browser_id);
        } else {
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }
    }

    let window = build_browser_window(&app, &request)?;
    let _ = window.show();
    let _ = window.set_focus();
    log::info!("[Browser] browser window created successfully");
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn open_browser_window<R: Runtime>(
    _app: AppHandle<R>,
    _request: OpenBrowserWindowRequest,
) -> Result<(), String> {
    Err("Browser windows are not supported on mobile builds".to_string())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn update_browser_bounds<R: Runtime>(
    app: AppHandle<R>,
    browser_id: String,
    bounds: serde_json::Value,
) -> Result<(), String> {
    if let Some(webview) = browser_webview(&app, &browser_id) {
        let x = bounds.get("x").and_then(|v| v.as_f64()).unwrap_or_default();
        let y = bounds.get("y").and_then(|v| v.as_f64()).unwrap_or_default();
        let width = bounds
            .get("width")
            .and_then(|v| v.as_f64())
            .unwrap_or_default();
        let height = bounds
            .get("height")
            .and_then(|v| v.as_f64())
            .unwrap_or_default();
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn update_browser_bounds<R: Runtime>(
    _app: AppHandle<R>,
    _browser_id: String,
    _bounds: serde_json::Value,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn show_browser_webview<R: Runtime>(
    app: AppHandle<R>,
    browser_id: String,
) -> Result<(), String> {
    log::info!("[Browser] show_browser_webview: id={}", browser_id);
    if let Some(webview) = browser_webview(&app, &browser_id) {
        webview.show().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn show_browser_webview<R: Runtime>(
    _app: AppHandle<R>,
    _browser_id: String,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn hide_browser_webview<R: Runtime>(
    app: AppHandle<R>,
    browser_id: String,
) -> Result<(), String> {
    log::info!("[Browser] hide_browser_webview: id={}", browser_id);
    if let Some(webview) = browser_webview(&app, &browser_id) {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn hide_browser_webview<R: Runtime>(
    _app: AppHandle<R>,
    _browser_id: String,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn close_browser_window<R: Runtime>(
    app: AppHandle<R>,
    browser_id: String,
    session_id: String,
) -> Result<(), String> {
    log::info!(
        "[Browser] close_browser_window: id={}, session={}",
        browser_id,
        session_id
    );

    if let Some(window) = browser_window(&app, &browser_id) {
        window.close().map_err(|e| e.to_string())?;
        clear_browser_proxy_config(&browser_id);
        clear_browser_page_load_state(&browser_id);
    } else if let Some(webview) = browser_webview(&app, &browser_id) {
        // Embedded child webview — destroy it and emit the closed event so the
        // frontend can clean up its state. Transport teardown is intentionally
        // left to the frontend state machine because embedded views may be
        // temporarily unmounted while the browser session should remain alive.
        webview.close().map_err(|e| e.to_string())?;
        clear_browser_proxy_config(&browser_id);
        clear_browser_page_load_state(&browser_id);
        let _ = emit_browser_window_closed(
            &app,
            BrowserWindowClosedPayload {
                browser_id,
                session_id,
            },
        );
    } else {
        clear_browser_proxy_config(&browser_id);
        clear_browser_page_load_state(&browser_id);
        let _ = emit_browser_window_closed(
            &app,
            BrowserWindowClosedPayload {
                browser_id,
                session_id,
            },
        );
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn close_browser_window<R: Runtime>(
    _app: AppHandle<R>,
    browser_id: String,
    _session_id: String,
) -> Result<(), String> {
    clear_browser_proxy_config(&browser_id);
    clear_browser_page_load_state(&browser_id);
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn load_browser_source<R: Runtime>(
    app: AppHandle<R>,
    request: LoadBrowserSourceRequest,
) -> Result<(), String> {
    let Some(webview) = browser_webview(&app, &request.browser_id) else {
        log::error!(
            "[Browser] load_browser_source: webview {} not open",
            request.browser_id
        );
        return Err(format!(
            "Browser webview {} is not open yet",
            request.browser_id
        ));
    };
    log::info!(
        "[Browser] load_browser_source: id={}, kind={}",
        request.browser_id,
        request.source.kind
    );

    emit_browser_state(
        &app,
        BrowserStatePayload {
            browser_id: request.browser_id.clone(),
            session_id: request.session_id.clone(),
            url: None,
            title: request.source.title.clone(),
            is_loading: Some(true),
            error: None,
        },
    )?;

    match request.source.kind.as_str() {
        "url" => {
            let url = request
                .source
                .url
                .as_deref()
                .ok_or_else(|| "Missing browser URL".to_string())?;
            clear_browser_page_load_state(&request.browser_id);
            log::info!("[Browser] load_browser_source: navigating to url={}", url);
            webview.navigate(normalize_url(url)?).map_err(|error| {
                log::error!(
                    "[Browser] load_browser_source: navigate FAILED url={}, error={}",
                    url,
                    error
                );
                error.to_string()
            })?;
            log::info!(
                "[Browser] load_browser_source: navigate called OK url={}",
                url
            );
            if let Some(window) = browser_window(&app, &request.browser_id) {
                let _ = window.set_title(url);
            }
        }
        "html" => {
            let html = request
                .source
                .html
                .as_deref()
                .ok_or_else(|| "Missing HTML payload".to_string())?;
            webview
                .navigate(webview_data_url(html)?)
                .map_err(|error| error.to_string())?;
            let title = request.source.title.clone();
            emit_browser_state(
                &app,
                BrowserStatePayload {
                    browser_id: request.browser_id.clone(),
                    session_id: request.session_id.clone(),
                    url: request.source.base_url.clone(),
                    title: title.clone(),
                    is_loading: Some(false),
                    error: None,
                },
            )?;
            if let Some(window) = browser_window(&app, &request.browser_id) {
                let _ = window.set_title(title.as_deref().unwrap_or("ShellBeam Browser"));
            }
        }
        "markdown" => {
            let html = request
                .source
                .html
                .as_deref()
                .ok_or_else(|| "Missing rendered markdown HTML payload".to_string())?;
            webview
                .navigate(webview_data_url(html)?)
                .map_err(|error| error.to_string())?;
            let title = request.source.title.clone();
            emit_browser_state(
                &app,
                BrowserStatePayload {
                    browser_id: request.browser_id.clone(),
                    session_id: request.session_id.clone(),
                    url: request.source.base_url.clone(),
                    title: title.clone(),
                    is_loading: Some(false),
                    error: None,
                },
            )?;
            if let Some(window) = browser_window(&app, &request.browser_id) {
                let _ = window.set_title(title.as_deref().unwrap_or("ShellBeam Browser"));
            }
        }
        other => return Err(format!("Unsupported browser source kind: {other}")),
    }

    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn load_browser_source<R: Runtime>(
    _app: AppHandle<R>,
    _request: LoadBrowserSourceRequest,
) -> Result<(), String> {
    Err("Browser source loading is not supported on mobile builds".to_string())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn reload_browser_window<R: Runtime>(
    app: AppHandle<R>,
    request: BrowserActionRequest,
) -> Result<(), String> {
    if let Some(webview) = browser_webview(&app, &request.browser_id) {
        emit_browser_state(
            &app,
            BrowserStatePayload {
                browser_id: request.browser_id.clone(),
                session_id: request.session_id.clone(),
                url: None,
                title: None,
                is_loading: Some(true),
                error: None,
            },
        )?;
        // Standalone browser window reload uses JS for consistency across webview backends.
        webview
            .eval("location.reload()")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn reload_browser_window<R: Runtime>(
    _app: AppHandle<R>,
    _request: BrowserActionRequest,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn go_back_browser_window<R: Runtime>(
    app: AppHandle<R>,
    request: BrowserActionRequest,
) -> Result<(), String> {
    if let Some(webview) = browser_webview(&app, &request.browser_id) {
        emit_browser_state(
            &app,
            BrowserStatePayload {
                browser_id: request.browser_id.clone(),
                session_id: request.session_id.clone(),
                url: None,
                title: None,
                is_loading: Some(true),
                error: None,
            },
        )?;
        wkwebview_go_back(&webview)?;
        emit_navigation_capabilities(&app, &webview, request.browser_id, request.session_id)?;
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn go_back_browser_window<R: Runtime>(
    _app: AppHandle<R>,
    _request: BrowserActionRequest,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
pub async fn go_forward_browser_window<R: Runtime>(
    app: AppHandle<R>,
    request: BrowserActionRequest,
) -> Result<(), String> {
    if let Some(webview) = browser_webview(&app, &request.browser_id) {
        emit_browser_state(
            &app,
            BrowserStatePayload {
                browser_id: request.browser_id.clone(),
                session_id: request.session_id.clone(),
                url: None,
                title: None,
                is_loading: Some(true),
                error: None,
            },
        )?;
        wkwebview_go_forward(&webview)?;
        emit_navigation_capabilities(&app, &webview, request.browser_id, request.session_id)?;
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub async fn go_forward_browser_window<R: Runtime>(
    _app: AppHandle<R>,
    _request: BrowserActionRequest,
) -> Result<(), String> {
    Ok(())
}

fn stop_browser_port_forward_inner(browser_id: &str) {
    if let Ok(mut map) = BROWSER_PORT_FORWARDS.lock() {
        if let Some(handle) = map.remove(browser_id) {
            let _ = handle.shutdown.send(());
        }
    }
}

fn verified_browser_connection(
    app: &AppHandle,
    session_id: &str,
    host_id: Option<&str>,
    vault_id: Option<&str>,
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    jump_host: Option<&str>,
    jump_port: Option<u16>,
    jump_user: Option<&str>,
    accepted: Option<&crate::ssh::transport::HostKeyAcceptance>,
) -> Result<crate::ssh::transport::Connection, String> {
    crate::ssh::transport::ensure_vault_unlocked(app, vault_id)?;
    // Saved hosts always resolve the selected vault's current route. Manual
    // terminal sessions may reuse their verified transport without credentials.
    if host_id.is_none() && vault_id.is_none() {
        if let Some(connection) = app
            .state::<InteractiveSessionState>()
            .clone_verified_connection(app, session_id)?
        {
            return Ok(connection);
        }
    }
    let route = if let (Some(host_id), Some(vault_id)) = (host_id, vault_id) {
        crate::ssh::transport::resolve_host_route(app, vault_id, host_id)?
    } else {
        crate::ssh::transport::legacy_route(
            vault_id,
            host,
            port,
            username,
            auth_type,
            password,
            private_key,
            None,
            jump_host,
            jump_port,
            jump_user,
        )
    };
    let connection = crate::ssh::transport::connect_accepting_fingerprint(app, &route, accepted)?;
    crate::ssh::transport::ensure_vault_unlocked(app, vault_id)?;
    Ok(connection)
}

fn retain_browser_forward(lease: crate::ssh::forward::ForwardLease) -> TunnelHandle {
    let (shutdown, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _lease = lease;
        let _ = receiver.recv();
    });
    TunnelHandle { shutdown }
}

#[tauri::command]
pub async fn start_browser_port_forward(
    app: AppHandle,
    request: BrowserPortForwardRequest,
) -> Result<u16, String> {
    stop_browser_port_forward_inner(&request.browser_id);
    tauri::async_runtime::spawn_blocking(move || {
        let connection = verified_browser_connection(
            &app,
            &request.session_id,
            request.host_id.as_deref(),
            request.vault_id.as_deref(),
            &request.host,
            request.port,
            &request.username,
            &request.auth_type,
            request.password.as_deref(),
            request.private_key.as_deref(),
            request.jump_host.as_deref(),
            request.jump_port,
            request.jump_user.as_deref(),
            request.accepted_host_key.as_ref(),
        )?;
        let lease = crate::ssh::forward::start(
            connection,
            "127.0.0.1",
            0,
            crate::ssh::forward::ForwardKind::Local {
                host: request.remote_host,
                port: request.remote_port,
            },
        )?;
        let port = lease.port;
        BROWSER_PORT_FORWARDS
            .lock()
            .map_err(|_| "Browser forwarding registry unavailable")?
            .insert(request.browser_id, retain_browser_forward(lease));
        Ok(port)
    })
    .await
    .map_err(|_| "Browser forwarding task failed")?
}

#[tauri::command]
pub async fn stop_browser_port_forward(browser_id: String) -> Result<(), String> {
    stop_browser_port_forward_inner(&browser_id);
    Ok(())
}

#[tauri::command]
pub async fn start_browser_http_proxy(
    app: AppHandle,
    request: BrowserHttpProxyRequest,
) -> Result<u16, String> {
    stop_browser_http_proxy_inner(&request.session_id);
    tauri::async_runtime::spawn_blocking(move || {
        let connection = verified_browser_connection(
            &app,
            &request.session_id,
            request.host_id.as_deref(),
            request.vault_id.as_deref(),
            &request.host,
            request.port,
            &request.username,
            &request.auth_type,
            request.password.as_deref(),
            request.private_key.as_deref(),
            request.jump_host.as_deref(),
            request.jump_port,
            request.jump_user.as_deref(),
            request.accepted_host_key.as_ref(),
        )?;
        let lease = crate::ssh::forward::start(
            connection,
            "127.0.0.1",
            0,
            crate::ssh::forward::ForwardKind::Http,
        )?;
        let port = lease.port;
        BROWSER_HTTP_PROXIES
            .lock()
            .map_err(|_| "Browser forwarding registry unavailable")?
            .insert(request.session_id, retain_browser_forward(lease));
        Ok(port)
    })
    .await
    .map_err(|_| "Browser forwarding task failed")?
}

#[tauri::command]
pub async fn stop_browser_http_proxy(session_id: String) -> Result<(), String> {
    stop_browser_http_proxy_inner(&session_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Browser SOCKS5 proxy – in-process, traffic exits from the SSH server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSocksProxyRequest {
    pub vault_id: Option<String>,
    pub host_id: Option<String>,
    pub accepted_host_key: Option<crate::ssh::transport::HostKeyAcceptance>,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
}

fn stop_browser_socks_proxy_inner(session_id: &str) {
    if let Ok(mut map) = BROWSER_SOCKS_PROXIES.lock() {
        if let Some(handle) = map.remove(session_id) {
            let _ = handle.shutdown.send(());
        }
    }
}

fn stop_browser_http_proxy_inner(session_id: &str) {
    if let Ok(mut map) = BROWSER_HTTP_PROXIES.lock() {
        if let Some(handle) = map.remove(session_id) {
            let _ = handle.shutdown.send(());
        }
    }
}

#[tauri::command]
pub async fn start_browser_socks_proxy(
    app: AppHandle,
    request: BrowserSocksProxyRequest,
) -> Result<u16, String> {
    stop_browser_socks_proxy_inner(&request.session_id);
    tauri::async_runtime::spawn_blocking(move || {
        let connection = verified_browser_connection(
            &app,
            &request.session_id,
            request.host_id.as_deref(),
            request.vault_id.as_deref(),
            &request.host,
            request.port,
            &request.username,
            &request.auth_type,
            request.password.as_deref(),
            request.private_key.as_deref(),
            request.jump_host.as_deref(),
            request.jump_port,
            request.jump_user.as_deref(),
            request.accepted_host_key.as_ref(),
        )?;
        let lease = crate::ssh::forward::start(
            connection,
            "127.0.0.1",
            0,
            crate::ssh::forward::ForwardKind::Socks,
        )?;
        let port = lease.port;
        BROWSER_SOCKS_PROXIES
            .lock()
            .map_err(|_| "Browser forwarding registry unavailable")?
            .insert(request.session_id, retain_browser_forward(lease));
        Ok(port)
    })
    .await
    .map_err(|_| "Browser forwarding task failed")?
}

#[tauri::command]
pub async fn stop_browser_socks_proxy(session_id: String) -> Result<(), String> {
    stop_browser_socks_proxy_inner(&session_id);
    Ok(())
}
