use crate::ssh::interactive::InteractiveSessionState;
use crate::ssh::SshSessionPool;
use crate::storage::data_file_path;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(not(mobile))]
use tauri::webview::{PageLoadEvent, WebviewBuilder, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Runtime};
#[cfg(not(mobile))]
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Webview, WebviewUrl, WebviewWindow, WindowEvent,
};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use objc::runtime::Object;
#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl};

/// A live in-process tunnel: a shutdown sender.
struct TunnelHandle {
    shutdown: std::sync::mpsc::Sender<()>,
}

#[derive(Debug, Clone, Copy)]
enum BrowserTransportSource {
    Interactive,
    Pool,
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
    pub accept_host_key: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHttpProxyRequest {
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
    pub accept_host_key: Option<bool>,
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
        blank_browser_html, browser_window_label, parse_proxy_authority,
        should_suppress_page_load_marker, BrowserPageLoadMarker,
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
    fn parse_proxy_authority_supports_default_port_and_ipv6() {
        assert_eq!(
            parse_proxy_authority("example.com", 443).expect("default port"),
            ("example.com".to_string(), 443)
        );
        assert_eq!(
            parse_proxy_authority("example.com:8443", 443).expect("explicit port"),
            ("example.com".to_string(), 8443)
        );
        assert_eq!(
            parse_proxy_authority("[::1]:8080", 80).expect("ipv6 authority"),
            ("::1".to_string(), 8080)
        );
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

fn browser_checkout_pooled_session(
    app: &AppHandle,
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
) -> Result<ssh2::Session, String> {
    let pool = app.state::<SshSessionPool>();
    pool.checkout(host, port, username, auth_type, password, private_key, None)
        .map_err(|e| format!("SSH connect failed: {e}"))
}

fn browser_clone_interactive_transport(app: &AppHandle, session_id: &str) -> Option<ssh2::Session> {
    let state = app.state::<InteractiveSessionState>();
    state.clone_reusable_transport(session_id)
}

fn browser_checkout_transport_session(
    app: &AppHandle,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
) -> Result<(ssh2::Session, BrowserTransportSource), String> {
    if let Some(session) = browser_clone_interactive_transport(app, session_id) {
        log::info!(
            "[Browser] transport checkout: session_id={}, source=interactive, target={}@{}:{}",
            session_id,
            username,
            host,
            port
        );
        return Ok((session, BrowserTransportSource::Interactive));
    }
    browser_checkout_pooled_session(app, host, port, username, auth_type, password, private_key)
        .map(|session| {
            log::info!(
                "[Browser] transport checkout: session_id={}, source=pool, target={}@{}:{}",
                session_id,
                username,
                host,
                port
            );
            (session, BrowserTransportSource::Pool)
        })
}

fn browser_checkin_pooled_session(
    app: &AppHandle,
    host: &str,
    port: u16,
    username: &str,
    session: ssh2::Session,
) {
    let pool = app.state::<SshSessionPool>();
    pool.checkin(host, port, username, session);
}

fn open_direct_tcpip_channel(
    session: &ssh2::Session,
    target_host: &str,
    target_port: u16,
) -> Result<ssh2::Channel, String> {
    loop {
        match session.channel_direct_tcpip(target_host, target_port, None) {
            Ok(channel) => return Ok(channel),
            Err(error) => {
                let io_error: std::io::Error = error.into();
                if io_error.kind() == ErrorKind::WouldBlock {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    continue;
                }
                return Err(io_error.to_string());
            }
        }
    }
}

/// Relay data between a local TCP stream and an ssh2 channel until one side closes.
///
/// Both directions are driven from the calling thread sequentially using
/// blocking I/O on the local side and non-blocking polling on the channel,
/// while a companion thread pumps local→channel writes so neither direction
/// starves the other.
fn relay_tcp_and_channel(mut local: TcpStream, channel: ssh2::Channel) {
    // Wrap in Arc<Mutex> so both threads can share the channel safely.
    let channel = Arc::new(Mutex::new(channel));

    let local_clone = match local.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };

    // Thread: local → channel
    let ch_write = Arc::clone(&channel);
    let write_thread = std::thread::spawn(move || {
        let mut local_r = local_clone;
        let mut buf = [0u8; 16 * 1024];
        loop {
            match local_r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut offset = 0;
                    while offset < n {
                        if let Ok(mut ch) = ch_write.lock() {
                            match ch.write(&buf[offset..n]) {
                                Ok(0) => break,
                                Ok(written) => {
                                    offset += written;
                                }
                                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                                    drop(ch);
                                    std::thread::sleep(std::time::Duration::from_millis(1));
                                }
                                Err(_) => break,
                            }
                        } else {
                            break;
                        }
                    }
                }
            }
        }
        if let Ok(mut ch) = ch_write.lock() {
            let _ = ch.send_eof();
        }
    });

    // Main: channel → local  (poll with short sleep on WouldBlock)
    let mut buf = [0u8; 16 * 1024];
    loop {
        let result = channel.lock().map(|mut ch| ch.read(&mut buf));
        match result {
            Ok(Ok(0)) | Err(_) => break,
            Ok(Ok(n)) => {
                if local.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Ok(Err(ref e)) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Ok(Err(_)) => break,
        }
    }

    let _ = write_thread.join();
}

fn stop_browser_port_forward_inner(browser_id: &str) {
    if let Ok(mut map) = BROWSER_PORT_FORWARDS.lock() {
        if let Some(handle) = map.remove(browser_id) {
            let _ = handle.shutdown.send(());
        }
    }
}

#[tauri::command]
pub async fn start_browser_port_forward(
    app: AppHandle,
    request: BrowserPortForwardRequest,
) -> Result<u16, String> {
    // Stop any existing forward for this browser instance first
    stop_browser_port_forward_inner(&request.browser_id);

    if has_jump_host(request.jump_host.as_deref()) {
        if request.auth_type != "privateKey" {
            return Err(
                "Remote browser over a jump host currently requires private key authentication"
                    .to_string(),
            );
        }
        let started_at = std::time::Instant::now();
        let private_key = request.private_key.clone().ok_or_else(|| {
            "Private key is required for jump-host browser forwarding".to_string()
        })?;
        let local_port = reserve_local_port()?;
        let bind_spec = format!(
            "127.0.0.1:{local_port}:{}:{}",
            request.remote_host, request.remote_port
        );
        let browser_id_for_tunnel = request.browser_id.clone();
        let session_id_for_log = request.session_id.clone();
        spawn_ssh_process_tunnel(
            &app,
            request.session_id.clone(),
            request.host.clone(),
            request.port,
            request.username.clone(),
            private_key,
            request.jump_host.clone(),
            request.jump_port,
            request.jump_user.clone(),
            vec!["-L".to_string(), bind_spec],
            move |handle| {
                if let Ok(mut map) = BROWSER_PORT_FORWARDS.lock() {
                    map.insert(browser_id_for_tunnel.clone(), handle);
                }
            },
        )?;
        log::info!(
            "[Browser PF] tunnel ready: session_id={}, source=jump-system, local_port={}, target={}:{} elapsed_ms={}",
            session_id_for_log,
            local_port,
            request.remote_host,
            request.remote_port,
            started_at.elapsed().as_millis()
        );
        return Ok(local_port);
    }

    // Bind the local listener before spawning to return the port immediately
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind local port: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();

    // Clone everything needed for the background thread
    let host = request.host.clone();
    let ssh_port = request.port;
    let username = request.username.clone();
    let auth_type = request.auth_type.clone();
    let password = request.password.clone();
    let private_key = request.private_key.clone();
    let _accept_host_key = request.accept_host_key.unwrap_or(false);
    let remote_host = request.remote_host.clone();
    let remote_port = request.remote_port;
    let session_id_bg = request.session_id.clone();
    let browser_id_bg = request.browser_id.clone();
    let browser_id_for_map = request.browser_id.clone();
    let app_handle = app.clone();

    // Validate the SSH connection on this thread so we can surface errors
    // before returning the port to the caller.
    let setup_started_at = std::time::Instant::now();
    let (probe_session, probe_source) = tauri::async_runtime::spawn_blocking({
        let host = host.clone();
        let username = username.clone();
        let auth_type = auth_type.clone();
        let password = password.clone();
        let private_key = private_key.clone();
        let session_id = request.session_id.clone();
        let app2 = app.clone();
        move || {
            browser_checkout_transport_session(
                &app2,
                &session_id,
                &host,
                ssh_port,
                &username,
                &auth_type,
                password.as_deref(),
                private_key.as_deref(),
            )
        }
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))??;

    probe_session.set_blocking(false);
    if matches!(probe_source, BrowserTransportSource::Pool) {
        browser_checkin_pooled_session(&app, &host, ssh_port, &username, probe_session);
    }
    log::info!(
        "[Browser PF] probe ready: session_id={}, source={:?}, target={}@{}:{}, elapsed_ms={}",
        request.session_id,
        probe_source,
        username,
        host,
        ssh_port,
        setup_started_at.elapsed().as_millis()
    );

    std::thread::spawn(move || {
        // Set a short accept timeout so we can check the shutdown signal.
        listener
            .set_nonblocking(true)
            .expect("set_nonblocking failed");

        loop {
            if shutdown_rx.try_recv().is_ok() {
                break;
            }

            match listener.accept() {
                Ok((local_stream, _)) => {
                    let h = host.clone();
                    let u = username.clone();
                    let auth = auth_type.clone();
                    let pw = password.clone();
                    let pk = private_key.clone();
                    let rh = remote_host.clone();
                    let session_id = session_id_bg.clone();
                    let app3 = app_handle.clone();
                    std::thread::spawn(move || {
                        let (session, source) = match browser_checkout_transport_session(
                            &app3,
                            &session_id,
                            &h,
                            ssh_port,
                            &u,
                            &auth,
                            pw.as_deref(),
                            pk.as_deref(),
                        ) {
                            Ok(result) => result,
                            Err(e) => {
                                log::warn!("[Browser PF] SSH connect failed: {e}");
                                return;
                            }
                        };
                        session.set_blocking(false);
                        log::info!(
                            "[Browser PF] channel open: session_id={}, source={:?}, target={}:{}",
                            session_id,
                            source,
                            rh,
                            remote_port
                        );
                        let channel = match open_direct_tcpip_channel(&session, &rh, remote_port) {
                            Ok(c) => c,
                            Err(e) => {
                                log::warn!("[Browser PF] direct-tcpip failed: {e}");
                                return;
                            }
                        };
                        // Set blocking on the local side
                        let _ = local_stream.set_nonblocking(false);
                        relay_tcp_and_channel(local_stream, channel);
                        if matches!(source, BrowserTransportSource::Pool) && session.authenticated()
                        {
                            browser_checkin_pooled_session(&app3, &h, ssh_port, &u, session);
                        }
                    });
                }
                Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(_) => break,
            }

            // Clean up map entry if we've been stopped
            if shutdown_rx.try_recv().is_ok() {
                break;
            }
        }

        if let Ok(mut map) = BROWSER_PORT_FORWARDS.lock() {
            map.remove(&browser_id_bg);
        }
    });

    if let Ok(mut map) = BROWSER_PORT_FORWARDS.lock() {
        map.insert(
            browser_id_for_map,
            TunnelHandle {
                shutdown: shutdown_tx,
            },
        );
    }

    Ok(local_port)
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
    let _ = (
        &request.jump_port,
        &request.jump_user,
        &request.accept_host_key,
    );
    stop_browser_http_proxy_inner(&request.session_id);

    if has_jump_host(request.jump_host.as_deref()) {
        return Err(
            "Remote HTTP proxy over a jump host is not supported yet; use SOCKS fallback"
                .to_string(),
        );
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind local HTTP proxy port: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local HTTP proxy addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();

    let host = request.host.clone();
    let ssh_port = request.port;
    let username = request.username.clone();
    let auth_type = request.auth_type.clone();
    let password = request.password.clone();
    let private_key = request.private_key.clone();
    let session_id_bg = request.session_id.clone();
    let session_id_for_map = request.session_id.clone();
    let app_handle = app.clone();

    let setup_started_at = std::time::Instant::now();
    let (probe, probe_source) = tauri::async_runtime::spawn_blocking({
        let host = host.clone();
        let username = username.clone();
        let auth_type = auth_type.clone();
        let password = password.clone();
        let private_key = private_key.clone();
        let session_id = request.session_id.clone();
        let app2 = app.clone();
        move || {
            browser_checkout_transport_session(
                &app2,
                &session_id,
                &host,
                ssh_port,
                &username,
                &auth_type,
                password.as_deref(),
                private_key.as_deref(),
            )
        }
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))??;
    probe.set_blocking(false);
    if matches!(probe_source, BrowserTransportSource::Pool) {
        browser_checkin_pooled_session(&app, &host, ssh_port, &username, probe);
    }
    log::info!(
        "[Browser HTTP Proxy] probe ready: session_id={}, source={:?}, target={}@{}:{}, elapsed_ms={}",
        request.session_id,
        probe_source,
        username,
        host,
        ssh_port,
        setup_started_at.elapsed().as_millis()
    );

    std::thread::spawn(move || {
        listener.set_nonblocking(true).expect("set_nonblocking");

        loop {
            if shutdown_rx.try_recv().is_ok() {
                break;
            }

            match listener.accept() {
                Ok((mut local_stream, _)) => {
                    let h = host.clone();
                    let u = username.clone();
                    let auth = auth_type.clone();
                    let pw = password.clone();
                    let pk = private_key.clone();
                    let session_id = session_id_bg.clone();
                    let app3 = app_handle.clone();
                    std::thread::spawn(move || {
                        local_stream.set_nonblocking(false).ok();
                        local_stream
                            .set_read_timeout(Some(std::time::Duration::from_secs(15)))
                            .ok();

                        let proxy_request = match parse_http_proxy_request(&mut local_stream) {
                            Ok(value) => value,
                            Err(error) => {
                                log::warn!("[Browser HTTP Proxy] parse failed: {error}");
                                write_http_proxy_error(
                                    &mut local_stream,
                                    "400 Bad Request",
                                    &error,
                                );
                                return;
                            }
                        };

                        let (target_host, target_port) = match &proxy_request {
                            BrowserHttpProxyRequestLine::Connect {
                                target_host,
                                target_port,
                            } => (target_host.clone(), *target_port),
                            BrowserHttpProxyRequestLine::Forward {
                                target_host,
                                target_port,
                                ..
                            } => (target_host.clone(), *target_port),
                        };

                        let (session, source) = match browser_checkout_transport_session(
                            &app3,
                            &session_id,
                            &h,
                            ssh_port,
                            &u,
                            &auth,
                            pw.as_deref(),
                            pk.as_deref(),
                        ) {
                            Ok(result) => result,
                            Err(error) => {
                                log::warn!("[Browser HTTP Proxy] SSH connect failed: {error}");
                                write_http_proxy_error(
                                    &mut local_stream,
                                    "502 Bad Gateway",
                                    &error,
                                );
                                return;
                            }
                        };
                        session.set_blocking(false);
                        log::info!(
                            "[Browser HTTP Proxy] channel open: session_id={}, source={:?}, target={}:{}",
                            session_id,
                            source,
                            target_host,
                            target_port
                        );

                        let mut channel = match open_direct_tcpip_channel(
                            &session,
                            &target_host,
                            target_port,
                        ) {
                            Ok(channel) => channel,
                            Err(error) => {
                                log::warn!(
                                        "[Browser HTTP Proxy] direct-tcpip to {target_host}:{target_port} failed: {error}"
                                    );
                                write_http_proxy_error(
                                    &mut local_stream,
                                    "502 Bad Gateway",
                                    &error,
                                );
                                return;
                            }
                        };

                        match proxy_request {
                            BrowserHttpProxyRequestLine::Connect { .. } => {
                                if local_stream
                                    .write_all(
                                        b"HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n",
                                    )
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            BrowserHttpProxyRequestLine::Forward { initial_bytes, .. } => {
                                if channel.write_all(&initial_bytes).is_err() {
                                    write_http_proxy_error(
                                        &mut local_stream,
                                        "502 Bad Gateway",
                                        "Failed to forward proxied request to SSH channel",
                                    );
                                    return;
                                }
                            }
                        }

                        local_stream.set_read_timeout(None).ok();
                        relay_tcp_and_channel(local_stream, channel);
                        if matches!(source, BrowserTransportSource::Pool) && session.authenticated()
                        {
                            browser_checkin_pooled_session(&app3, &h, ssh_port, &u, session);
                        }
                    });
                }
                Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(_) => break,
            }

            if shutdown_rx.try_recv().is_ok() {
                break;
            }
        }

        if let Ok(mut map) = BROWSER_HTTP_PROXIES.lock() {
            map.remove(&session_id_bg);
        }
    });

    if let Ok(mut map) = BROWSER_HTTP_PROXIES.lock() {
        map.insert(
            session_id_for_map,
            TunnelHandle {
                shutdown: shutdown_tx,
            },
        );
    }

    Ok(local_port)
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
    pub accept_host_key: Option<bool>,
}

fn write_temp_private_key(
    app: &tauri::AppHandle,
    private_key: &str,
) -> Result<std::path::PathBuf, String> {
    let key_path = data_file_path(app, &format!("browser_{}.key", Uuid::new_v4()))?;
    fs::write(&key_path, private_key).map_err(|e| format!("Write temp key failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&key_path, permissions)
            .map_err(|e| format!("Set key permissions failed: {e}"))?;
    }
    Ok(key_path)
}

fn has_jump_host(jump_host: Option<&str>) -> bool {
    jump_host
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn reserve_local_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind local port: {e}"))?;
    listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))
        .map(|addr| addr.port())
}

fn spawn_ssh_process_tunnel(
    app: &AppHandle,
    session_id: String,
    host: String,
    ssh_port: u16,
    username: String,
    private_key: String,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
    tunnel_args: Vec<String>,
    register: impl FnOnce(TunnelHandle) + Send + 'static,
) -> Result<(), String> {
    let key_path = write_temp_private_key(app, &private_key)?;

    let mut cmd = Command::new("ssh");
    cmd.arg("-N");
    for arg in tunnel_args {
        cmd.arg(arg);
    }
    cmd.arg("-p")
        .arg(ssh_port.to_string())
        .arg("-i")
        .arg(&key_path)
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=no")
        .arg("-o")
        .arg("UserKnownHostsFile=/dev/null");

    if let Some(jh) = jump_host
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let jump_username = jump_user.as_deref().unwrap_or(&username);
        cmd.arg("-J")
            .arg(format!("{jump_username}@{jh}:{}", jump_port.unwrap_or(22)));
    }

    cmd.arg(format!("{username}@{host}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        let _ = fs::remove_file(&key_path);
        format!("Spawn SSH tunnel failed: {e}")
    })?;

    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("Wait SSH tunnel failed: {e}"))?;
                let _ = fs::remove_file(&key_path);
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let message = if stderr.is_empty() {
                    format!("SSH tunnel exited early with status {status}")
                } else {
                    stderr
                };
                return Err(message);
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(e) => {
                let _ = fs::remove_file(&key_path);
                return Err(format!("Check SSH tunnel status failed: {e}"));
            }
        }
    }

    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();
    register(TunnelHandle {
        shutdown: shutdown_tx,
    });

    std::thread::spawn(move || {
        let mut child: Child = child;
        loop {
            if shutdown_rx.try_recv().is_ok() {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        let _ = fs::remove_file(&key_path);
        if let Ok(mut map) = BROWSER_PORT_FORWARDS.lock() {
            map.remove(&session_id);
        }
        if let Ok(mut map) = BROWSER_SOCKS_PROXIES.lock() {
            map.remove(&session_id);
        }
    });

    Ok(())
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

enum BrowserHttpProxyRequestLine {
    Connect {
        target_host: String,
        target_port: u16,
    },
    Forward {
        target_host: String,
        target_port: u16,
        initial_bytes: Vec<u8>,
    },
}

fn parse_proxy_authority(value: &str, default_port: u16) -> Result<(String, u16), String> {
    if let Some(rest) = value.strip_prefix('[') {
        let closing = rest
            .find(']')
            .ok_or_else(|| format!("Invalid proxy authority: {value}"))?;
        let host = rest[..closing].to_string();
        let port = rest[closing + 1..]
            .strip_prefix(':')
            .map(|v| v.parse::<u16>().map_err(|e| e.to_string()))
            .transpose()?
            .unwrap_or(default_port);
        return Ok((host, port));
    }

    if let Some((host, port)) = value.rsplit_once(':') {
        if !host.contains(':') {
            return Ok((
                host.to_string(),
                port.parse::<u16>().map_err(|e| e.to_string())?,
            ));
        }
    }

    Ok((value.to_string(), default_port))
}

fn parse_http_proxy_request(stream: &mut TcpStream) -> Result<BrowserHttpProxyRequestLine, String> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Proxy client closed before sending request".to_string());
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        if buffer.len() > 64 * 1024 {
            return Err("Proxy request headers too large".to_string());
        }
    };

    let header_text =
        String::from_utf8(buffer[..header_end].to_vec()).map_err(|e| e.to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing proxy request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "Missing HTTP proxy method".to_string())?;
    let target = parts
        .next()
        .ok_or_else(|| "Missing HTTP proxy target".to_string())?;
    let version = parts.next().unwrap_or("HTTP/1.1");

    if method.eq_ignore_ascii_case("CONNECT") {
        let (target_host, target_port) = parse_proxy_authority(target, 443)?;
        return Ok(BrowserHttpProxyRequestLine::Connect {
            target_host,
            target_port,
        });
    }

    let target_url = if target.starts_with("http://") || target.starts_with("https://") {
        url::Url::parse(target).map_err(|e| e.to_string())?
    } else {
        let host_header = lines
            .clone()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("host") {
                    Some(value.trim().to_string())
                } else {
                    None
                }
            })
            .ok_or_else(|| "Missing Host header for proxied HTTP request".to_string())?;
        url::Url::parse(&format!("http://{host_header}{target}")).map_err(|e| e.to_string())?
    };

    let target_host = target_url
        .host_str()
        .ok_or_else(|| "Missing target host in proxied HTTP request".to_string())?
        .to_string();
    let target_port = target_url
        .port_or_known_default()
        .ok_or_else(|| "Missing target port in proxied HTTP request".to_string())?;

    let mut origin_form = target_url.path().to_string();
    if origin_form.is_empty() {
        origin_form.push('/');
    }
    if let Some(query) = target_url.query() {
        origin_form.push('?');
        origin_form.push_str(query);
    }

    let mut initial_bytes = format!("{method} {origin_form} {version}\r\n").into_bytes();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        initial_bytes.extend_from_slice(line.as_bytes());
        initial_bytes.extend_from_slice(b"\r\n");
    }
    initial_bytes.extend_from_slice(b"\r\n");
    initial_bytes.extend_from_slice(&buffer[header_end + 4..]);

    Ok(BrowserHttpProxyRequestLine::Forward {
        target_host,
        target_port,
        initial_bytes,
    })
}

fn write_http_proxy_error(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!("{status}\n{message}\n");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

/// Perform a SOCKS5 handshake on `stream` and return the target host and port.
fn socks5_handshake(stream: &mut TcpStream) -> Result<(String, u16), String> {
    // Greeting: VER NMETHODS METHODS...
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
    if buf[0] != 5 {
        return Err("Not a SOCKS5 client".to_string());
    }
    let nmethods = buf[1] as usize;
    let mut methods = vec![0u8; nmethods];
    stream.read_exact(&mut methods).map_err(|e| e.to_string())?;

    // We only support no-auth (method 0x00)
    stream.write_all(&[5, 0]).map_err(|e| e.to_string())?;

    // Request: VER CMD RSV ATYP DST.ADDR DST.PORT
    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr).map_err(|e| e.to_string())?;
    if hdr[0] != 5 || hdr[1] != 1 {
        // Only CONNECT (0x01) supported
        stream
            .write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
            .map_err(|e| e.to_string())?;
        return Err("Only SOCKS5 CONNECT supported".to_string());
    }

    let target_host = match hdr[3] {
        1 => {
            // IPv4
            let mut ip = [0u8; 4];
            stream.read_exact(&mut ip).map_err(|e| e.to_string())?;
            format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
        }
        3 => {
            // Domain
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(|e| e.to_string())?;
            let mut domain = vec![0u8; len[0] as usize];
            stream.read_exact(&mut domain).map_err(|e| e.to_string())?;
            String::from_utf8(domain).map_err(|e| e.to_string())?
        }
        4 => {
            // IPv6
            let mut ip = [0u8; 16];
            stream.read_exact(&mut ip).map_err(|e| e.to_string())?;
            let addr = std::net::Ipv6Addr::from(ip);
            format!("{addr}")
        }
        _ => {
            stream
                .write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0])
                .map_err(|e| e.to_string())?;
            return Err("Unsupported SOCKS5 address type".to_string());
        }
    };

    let mut port_buf = [0u8; 2];
    stream
        .read_exact(&mut port_buf)
        .map_err(|e| e.to_string())?;
    let target_port = u16::from_be_bytes(port_buf);

    // Reply: success
    stream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .map_err(|e| e.to_string())?;

    Ok((target_host, target_port))
}

#[tauri::command]
pub async fn start_browser_socks_proxy(
    app: AppHandle,
    request: BrowserSocksProxyRequest,
) -> Result<u16, String> {
    stop_browser_socks_proxy_inner(&request.session_id);

    if has_jump_host(request.jump_host.as_deref()) {
        if request.auth_type != "privateKey" {
            return Err(
                "Remote browser over a jump host currently requires private key authentication"
                    .to_string(),
            );
        }
        let started_at = std::time::Instant::now();
        let private_key = request
            .private_key
            .clone()
            .ok_or_else(|| "Private key is required for jump-host browser proxying".to_string())?;
        let local_port = reserve_local_port()?;
        let bind_spec = format!("127.0.0.1:{local_port}");
        let session_id_for_tunnel = request.session_id.clone();
        let session_id_for_log = request.session_id.clone();
        spawn_ssh_process_tunnel(
            &app,
            request.session_id.clone(),
            request.host.clone(),
            request.port,
            request.username.clone(),
            private_key,
            request.jump_host.clone(),
            request.jump_port,
            request.jump_user.clone(),
            vec!["-D".to_string(), bind_spec],
            move |handle| {
                if let Ok(mut map) = BROWSER_SOCKS_PROXIES.lock() {
                    map.insert(session_id_for_tunnel.clone(), handle);
                }
            },
        )?;
        log::info!(
            "[Browser SOCKS] tunnel ready: session_id={}, source=jump-system, local_port={}, elapsed_ms={}",
            session_id_for_log,
            local_port,
            started_at.elapsed().as_millis()
        );
        return Ok(local_port);
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind local SOCKS port: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();

    let host = request.host.clone();
    let ssh_port = request.port;
    let username = request.username.clone();
    let auth_type = request.auth_type.clone();
    let password = request.password.clone();
    let private_key = request.private_key.clone();
    let _accept_host_key = request.accept_host_key.unwrap_or(false);
    let session_id_bg = request.session_id.clone();
    let session_id_for_map = request.session_id.clone();
    let app_handle = app.clone();

    // Probe connection to validate credentials before returning the port
    let setup_started_at = std::time::Instant::now();
    let (probe, probe_source) = tauri::async_runtime::spawn_blocking({
        let host = host.clone();
        let username = username.clone();
        let auth_type = auth_type.clone();
        let password = password.clone();
        let private_key = private_key.clone();
        let session_id = request.session_id.clone();
        let app2 = app.clone();
        move || {
            browser_checkout_transport_session(
                &app2,
                &session_id,
                &host,
                ssh_port,
                &username,
                &auth_type,
                password.as_deref(),
                private_key.as_deref(),
            )
        }
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))??;
    probe.set_blocking(false);
    if matches!(probe_source, BrowserTransportSource::Pool) {
        browser_checkin_pooled_session(&app, &host, ssh_port, &username, probe);
    }
    log::info!(
        "[Browser SOCKS] probe ready: session_id={}, source={:?}, target={}@{}:{}, elapsed_ms={}",
        request.session_id,
        probe_source,
        username,
        host,
        ssh_port,
        setup_started_at.elapsed().as_millis()
    );

    std::thread::spawn(move || {
        listener.set_nonblocking(true).expect("set_nonblocking");

        loop {
            if shutdown_rx.try_recv().is_ok() {
                break;
            }

            match listener.accept() {
                Ok((mut local_stream, _)) => {
                    let h = host.clone();
                    let u = username.clone();
                    let auth = auth_type.clone();
                    let pw = password.clone();
                    let pk = private_key.clone();
                    let session_id = session_id_bg.clone();
                    let app3 = app_handle.clone();
                    std::thread::spawn(move || {
                        local_stream.set_nonblocking(false).ok();
                        local_stream
                            .set_read_timeout(Some(std::time::Duration::from_secs(15)))
                            .ok();

                        let (target_host, target_port) = match socks5_handshake(&mut local_stream) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("[Browser SOCKS] handshake failed: {e}");
                                return;
                            }
                        };

                        let (session, source) = match browser_checkout_transport_session(
                            &app3,
                            &session_id,
                            &h,
                            ssh_port,
                            &u,
                            &auth,
                            pw.as_deref(),
                            pk.as_deref(),
                        ) {
                            Ok(result) => result,
                            Err(e) => {
                                log::warn!("[Browser SOCKS] SSH connect failed: {e}");
                                return;
                            }
                        };
                        session.set_blocking(false);
                        log::info!(
                            "[Browser SOCKS] channel open: session_id={}, source={:?}, target={}:{}",
                            session_id,
                            source,
                            target_host,
                            target_port
                        );

                        let channel = match open_direct_tcpip_channel(
                            &session,
                            &target_host,
                            target_port,
                        ) {
                            Ok(c) => c,
                            Err(e) => {
                                log::warn!("[Browser SOCKS] direct-tcpip to {target_host}:{target_port} failed: {e}");
                                return;
                            }
                        };

                        // Clear the read timeout before relaying
                        local_stream.set_read_timeout(None).ok();
                        relay_tcp_and_channel(local_stream, channel);
                        if matches!(source, BrowserTransportSource::Pool) && session.authenticated()
                        {
                            browser_checkin_pooled_session(&app3, &h, ssh_port, &u, session);
                        }
                    });
                }
                Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(_) => break,
            }

            if shutdown_rx.try_recv().is_ok() {
                break;
            }
        }

        if let Ok(mut map) = BROWSER_SOCKS_PROXIES.lock() {
            map.remove(&session_id_bg);
        }
    });

    if let Ok(mut map) = BROWSER_SOCKS_PROXIES.lock() {
        map.insert(
            session_id_for_map,
            TunnelHandle {
                shutdown: shutdown_tx,
            },
        );
    }

    Ok(local_port)
}

#[tauri::command]
pub async fn stop_browser_socks_proxy(session_id: String) -> Result<(), String> {
    stop_browser_socks_proxy_inner(&session_id);
    Ok(())
}
