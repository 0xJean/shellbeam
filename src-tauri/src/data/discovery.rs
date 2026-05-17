//! mDNS device discovery for LAN P2P sync.
//!
//! On macOS: uses the `mdns-sd` Rust crate (userspace mDNS works fine).
//! On iOS: uses the system dns_sd C API (DNSServiceBrowse/Resolve) because
//! userspace multicast is blocked by iOS sandbox — only the system
//! mDNSResponder can send/receive mDNS packets reliably.

use serde::Serialize;
#[cfg(not(target_os = "android"))]
use std::sync::atomic::AtomicBool;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::sync::atomic::Ordering;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::sync::Mutex;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::Emitter;

#[cfg(not(target_os = "android"))]
pub(crate) static DISCOVER_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub device_type: String, // "phone" or "computer"
}

// ─── Android implementation (no-op, NSD handled by Kotlin NsdHelper) ────────

#[cfg(target_os = "android")]
mod android {
    use super::*;

    pub fn discover_devices() -> Result<Vec<DiscoveredDevice>, String> {
        // On Android, discovery is handled by NsdHelper in Kotlin.
        // Devices are emitted via WebView CustomEvent -> frontend bridge.
        log::info!("[android discover] no-op: discovery handled by NsdHelper");
        Ok(Vec::new())
    }

    pub fn start_discover(_app: tauri::AppHandle) -> Result<(), String> {
        // NsdHelper.startDiscovery() is called from the frontend via JS bridge.
        log::info!("[android discover] no-op: start_discover handled by NsdHelper");
        Ok(())
    }

    pub fn stop_discover() {
        log::info!("[android discover] no-op: stop_discover handled by NsdHelper");
    }
}

// ─── macOS implementation (mdns-sd crate) ───────────────────────────────────

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod desktop {
    use super::*;
    use crate::sync::transport::SHELLBEAM_SERVICE_TYPE;
    use mdns_sd::{ScopedIp, ServiceDaemon, ServiceEvent};
    use std::collections::HashMap;
    use std::time::Duration;

    static DISCOVER_DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

    fn best_lan_ipv4(addr: &std::collections::HashSet<ScopedIp>) -> Option<String> {
        let mut good: Option<std::net::Ipv4Addr> = None;
        for a in addr {
            if let ScopedIp::V4(v) = a {
                let ip = *v.addr();
                if ip.is_loopback() || ip.is_link_local() {
                    continue;
                }
                good = Some(ip);
            }
        }
        good.map(|ip| ip.to_string())
    }

    fn instance_name_from_fullname(fullname: &str) -> String {
        fullname.split('.').next().unwrap_or(fullname).to_string()
    }

    pub fn discover_devices() -> Result<Vec<DiscoveredDevice>, String> {
        // Always use a fresh daemon to avoid stale cache
        let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS daemon: {e}"))?;
        let receiver = daemon
            .browse(SHELLBEAM_SERVICE_TYPE)
            .map_err(|e| format!("mDNS browse: {e}"))?;
        let mut devices: HashMap<String, DiscoveredDevice> = HashMap::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while std::time::Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(ServiceEvent::ServiceResolved(resolved)) => {
                    if let Some(addr) = best_lan_ipv4(&resolved.addresses) {
                        let name = instance_name_from_fullname(&resolved.fullname);
                        let dt = resolved
                            .get_properties()
                            .get_property_val_str("dt")
                            .unwrap_or("computer")
                            .to_string();
                        devices.insert(
                            format!("{}:{}", addr, resolved.port),
                            DiscoveredDevice {
                                name,
                                host: addr,
                                port: resolved.port,
                                device_type: dt,
                            },
                        );
                    }
                }
                _ => {}
            }
        }
        daemon.shutdown().ok();
        Ok(devices.into_values().collect())
    }

    pub fn start_discover(app: tauri::AppHandle) -> Result<(), String> {
        // Always stop previous discovery first
        if DISCOVER_RUNNING.load(Ordering::SeqCst) {
            stop_discover();
            std::thread::sleep(Duration::from_millis(50));
        }

        // Always create a fresh standalone daemon for discovery.
        // Reusing the shared registration daemon is unreliable: mdns_sd caches
        // resolved records internally, and stop_browse doesn't flush that cache.
        // A fresh daemon has no cache, so it will always re-query the network.
        log::info!("[discover] creating fresh daemon for browse");
        let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS daemon: {e}"))?;
        let receiver = daemon
            .browse(SHELLBEAM_SERVICE_TYPE)
            .map_err(|e| format!("mDNS browse: {e}"))?;
        if let Ok(mut dg) = DISCOVER_DAEMON.lock() {
            *dg = Some(daemon);
        }

        DISCOVER_RUNNING.store(true, Ordering::SeqCst);
        std::thread::spawn(move || {
            log::info!("[discover] browse started");
            while DISCOVER_RUNNING.load(Ordering::SeqCst) {
                match receiver.recv_timeout(Duration::from_millis(500)) {
                    Ok(ServiceEvent::ServiceResolved(resolved)) => {
                        log::info!(
                            "[discover] RESOLVED: fullname={} addrs={:?}",
                            resolved.fullname,
                            resolved.addresses
                        );
                        if let Some(addr) = best_lan_ipv4(&resolved.addresses) {
                            let dt = resolved
                                .get_properties()
                                .get_property_val_str("dt")
                                .unwrap_or("computer")
                                .to_string();
                            let device = DiscoveredDevice {
                                name: instance_name_from_fullname(&resolved.fullname),
                                host: addr,
                                port: resolved.port,
                                device_type: dt,
                            };
                            log::info!("[discover] emitting: {:?}", device);
                            let _ = app.emit("mdns-device-found", &device);
                        }
                    }
                    Ok(ServiceEvent::ServiceFound(_, fullname)) => {
                        log::info!("[discover] FOUND: {}", fullname);
                    }
                    Ok(ServiceEvent::SearchStarted(s)) => {
                        log::info!("[discover] search started: {}", s);
                    }
                    _ => {}
                }
            }
            log::info!("[discover] browse thread exiting");
        });
        Ok(())
    }

    pub fn stop_discover() {
        DISCOVER_RUNNING.store(false, Ordering::SeqCst);
        // Shutdown the standalone discover daemon (fresh each scan)
        if let Ok(mut guard) = DISCOVER_DAEMON.lock() {
            if let Some(daemon) = guard.take() {
                let _ = daemon.stop_browse(SHELLBEAM_SERVICE_TYPE);
                daemon.shutdown().ok();
            }
        }
    }
}

// ─── Public Tauri commands (delegate to platform module) ────────────────────

#[tauri::command]
pub fn mdns_discover_devices() -> Result<Vec<DiscoveredDevice>, String> {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        desktop::discover_devices()
    }
    #[cfg(target_os = "ios")]
    {
        super::discovery_ios::discover_devices()
    }
    #[cfg(target_os = "android")]
    {
        android::discover_devices()
    }
}

#[tauri::command]
pub fn mdns_start_discover(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        desktop::start_discover(app)
    }
    #[cfg(target_os = "ios")]
    {
        super::discovery_ios::start_discover(app)
    }
    #[cfg(target_os = "android")]
    {
        android::start_discover(app)
    }
}

#[tauri::command]
pub fn mdns_stop_discover() {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        desktop::stop_discover()
    }
    #[cfg(target_os = "ios")]
    {
        super::discovery_ios::stop_discover()
    }
    #[cfg(target_os = "android")]
    {
        android::stop_discover()
    }
}
