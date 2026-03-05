//! mDNS device discovery for LAN P2P sync.
//!
//! On macOS: uses the `mdns-sd` Rust crate (userspace mDNS works fine).
//! On iOS: uses the system dns_sd C API (DNSServiceBrowse/Resolve) because
//! userspace multicast is blocked by iOS sandbox — only the system
//! mDNSResponder can send/receive mDNS packets reliably.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

static DISCOVER_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub device_type: String, // "phone" or "computer"
}

// ─── macOS implementation (mdns-sd crate) ───────────────────────────────────

#[cfg(not(target_os = "ios"))]
mod desktop {
    use super::*;
    use mdns_sd::{ScopedIp, ServiceDaemon, ServiceEvent};
    use std::collections::HashMap;
    use std::time::Duration;
    use crate::sync::transport::{MDNS_DAEMON, SHELLBEAM_SERVICE_TYPE};

    static DISCOVER_DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

    fn best_lan_ipv4(addr: &std::collections::HashSet<ScopedIp>) -> Option<String> {
        let mut good: Option<std::net::Ipv4Addr> = None;
        for a in addr {
            if let ScopedIp::V4(v) = a {
                let ip = *v.addr();
                if ip.is_loopback() || ip.is_link_local() { continue; }
                good = Some(ip);
            }
        }
        good.map(|ip| ip.to_string())
    }

    fn instance_name_from_fullname(fullname: &str) -> String {
        fullname.split('.').next().unwrap_or(fullname).to_string()
    }

    pub fn discover_devices() -> Result<Vec<DiscoveredDevice>, String> {
        let (receiver, temp_daemon) = {
            let guard = MDNS_DAEMON.lock().map_err(|e| format!("lock: {e}"))?;
            if let Some(ref daemon) = *guard {
                let r = daemon.browse(SHELLBEAM_SERVICE_TYPE)
                    .map_err(|e| format!("mDNS browse failed: {e}"))?;
                (r, None)
            } else {
                drop(guard);
                let d = ServiceDaemon::new().map_err(|e| format!("mDNS daemon: {e}"))?;
                let r = d.browse(SHELLBEAM_SERVICE_TYPE)
                    .map_err(|e| format!("mDNS browse: {e}"))?;
                (r, Some(d))
            }
        };
        let mut devices: HashMap<String, DiscoveredDevice> = HashMap::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while std::time::Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(ServiceEvent::ServiceResolved(resolved)) => {
                    if let Some(addr) = best_lan_ipv4(&resolved.addresses) {
                        let name = instance_name_from_fullname(&resolved.fullname);
                        let dt = resolved.get_properties().get_property_val_str("dt")
                            .unwrap_or("computer").to_string();
                        devices.insert(format!("{}:{}", addr, resolved.port),
                            DiscoveredDevice { name, host: addr, port: resolved.port, device_type: dt });
                    }
                }
                _ => {}
            }
        }
        if let Some(d) = temp_daemon { d.shutdown().ok(); }
        Ok(devices.into_values().collect())
    }

    pub fn start_discover(app: tauri::AppHandle) -> Result<(), String> {
        if DISCOVER_RUNNING.load(Ordering::SeqCst) { return Ok(()); }

        let (receiver, _uses_shared) = {
            let guard = MDNS_DAEMON.lock().map_err(|e| format!("lock: {e}"))?;
            if let Some(ref daemon) = *guard {
                log::info!("[discover] reusing registration daemon for browse");
                (daemon.browse(SHELLBEAM_SERVICE_TYPE).map_err(|e| format!("{e}"))?, true)
            } else {
                drop(guard);
                log::info!("[discover] creating standalone daemon");
                let d = ServiceDaemon::new().map_err(|e| format!("{e}"))?;
                let r = d.browse(SHELLBEAM_SERVICE_TYPE).map_err(|e| format!("{e}"))?;
                if let Ok(mut dg) = DISCOVER_DAEMON.lock() { *dg = Some(d); }
                (r, false)
            }
        };

        DISCOVER_RUNNING.store(true, Ordering::SeqCst);
        std::thread::spawn(move || {
            log::info!("[discover] browse started");
            while DISCOVER_RUNNING.load(Ordering::SeqCst) {
                match receiver.recv_timeout(Duration::from_millis(500)) {
                    Ok(ServiceEvent::ServiceResolved(resolved)) => {
                        log::info!("[discover] RESOLVED: fullname={} addrs={:?}", resolved.fullname, resolved.addresses);
                        if let Some(addr) = best_lan_ipv4(&resolved.addresses) {
                            let dt = resolved.get_properties().get_property_val_str("dt")
                                .unwrap_or("computer").to_string();
                            let device = DiscoveredDevice {
                                name: instance_name_from_fullname(&resolved.fullname),
                                host: addr, port: resolved.port, device_type: dt,
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
        if let Ok(mut guard) = DISCOVER_DAEMON.lock() {
            if let Some(daemon) = guard.take() { daemon.shutdown().ok(); }
        }
    }
}

// ─── iOS implementation (native dns_sd C API) ───────────────────────────────

#[cfg(target_os = "ios")]
mod ios {
    use super::*;
    use std::collections::HashMap;

    // Raw dns_sd.h C API bindings (available on iOS via system framework)
    type DNSServiceRef = *mut std::ffi::c_void;
    type DNSServiceFlags = u32;
    type DNSServiceErrorType = i32;

    #[allow(non_upper_case_globals)]
    const kDNSServiceFlagsMoreComing: DNSServiceFlags = 0x1;
    #[allow(non_upper_case_globals)]
    const kDNSServiceFlagsAdd: DNSServiceFlags = 0x2;

    type DNSServiceBrowseReply = extern "C" fn(
        sd_ref: DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        error_code: DNSServiceErrorType,
        service_name: *const std::os::raw::c_char,
        reg_type: *const std::os::raw::c_char,
        reply_domain: *const std::os::raw::c_char,
        context: *mut std::ffi::c_void,
    );

    type DNSServiceResolveReply = extern "C" fn(
        sd_ref: DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        error_code: DNSServiceErrorType,
        fullname: *const std::os::raw::c_char,
        hosttarget: *const std::os::raw::c_char,
        port: u16, // network byte order
        txt_len: u16,
        txt_record: *const u8,
        context: *mut std::ffi::c_void,
    );

    type DNSServiceGetAddrInfoReply = extern "C" fn(
        sd_ref: DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        error_code: DNSServiceErrorType,
        hostname: *const std::os::raw::c_char,
        address: *const libc::sockaddr,
        ttl: u32,
        context: *mut std::ffi::c_void,
    );

    #[link(name = "System")]
    extern "C" {
        fn DNSServiceBrowse(
            sd_ref: *mut DNSServiceRef,
            flags: DNSServiceFlags,
            interface_index: u32,
            reg_type: *const std::os::raw::c_char,
            domain: *const std::os::raw::c_char,
            callback: DNSServiceBrowseReply,
            context: *mut std::ffi::c_void,
        ) -> DNSServiceErrorType;

        fn DNSServiceResolve(
            sd_ref: *mut DNSServiceRef,
            flags: DNSServiceFlags,
            interface_index: u32,
            name: *const std::os::raw::c_char,
            reg_type: *const std::os::raw::c_char,
            domain: *const std::os::raw::c_char,
            callback: DNSServiceResolveReply,
            context: *mut std::ffi::c_void,
        ) -> DNSServiceErrorType;

        fn DNSServiceGetAddrInfo(
            sd_ref: *mut DNSServiceRef,
            flags: DNSServiceFlags,
            interface_index: u32,
            protocol: u32,  // kDNSServiceProtocol_IPv4 = 1
            hostname: *const std::os::raw::c_char,
            callback: DNSServiceGetAddrInfoReply,
            context: *mut std::ffi::c_void,
        ) -> DNSServiceErrorType;

        fn DNSServiceRefSockFD(sd_ref: DNSServiceRef) -> i32;
        fn DNSServiceProcessResult(sd_ref: DNSServiceRef) -> DNSServiceErrorType;
        fn DNSServiceRefDeallocate(sd_ref: DNSServiceRef);
    }

    /// Helper: run a DNSServiceRef for up to `timeout_ms`, processing callbacks.
    unsafe fn process_ref(sd_ref: DNSServiceRef, timeout_ms: u64) {
        let fd = DNSServiceRefSockFD(sd_ref);
        if fd < 0 { return; }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        while std::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let mut tv = libc::timeval {
                tv_sec: remaining.as_secs() as _,
                tv_usec: remaining.subsec_micros() as _,
            };
            let mut fds: libc::fd_set = std::mem::zeroed();
            libc::FD_ZERO(&mut fds);
            libc::FD_SET(fd, &mut fds);
            let n = libc::select(fd + 1, &mut fds, std::ptr::null_mut(), std::ptr::null_mut(), &mut tv);
            if n > 0 {
                DNSServiceProcessResult(sd_ref);
            } else {
                break;
            }
        }
    }

    /// Parse a DNS-SD TXT record to extract "dt" (device type) value.
    fn parse_txt_device_type(txt_record: *const u8, txt_len: u16) -> String {
        if txt_record.is_null() || txt_len == 0 { return "computer".to_string(); }
        let data = unsafe { std::slice::from_raw_parts(txt_record, txt_len as usize) };
        let mut i = 0usize;
        while i < data.len() {
            let len = data[i] as usize;
            i += 1;
            if i + len > data.len() { break; }
            if let Ok(s) = std::str::from_utf8(&data[i..i+len]) {
                if let Some(val) = s.strip_prefix("dt=") {
                    return val.to_string();
                }
            }
            i += len;
        }
        "computer".to_string()
    }

    // ─── Context structs for C callbacks ─────────────────────────────────

    struct BrowseCtx {
        app: tauri::AppHandle,
    }

    struct ResolveCtx {
        service_name: String,
        app: tauri::AppHandle,
    }

    struct AddrCtx {
        service_name: String,
        port: u16,
        device_type: String,
        app: tauri::AppHandle,
    }

    extern "C" fn browse_callback(
        _sd_ref: DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        error_code: DNSServiceErrorType,
        service_name: *const std::os::raw::c_char,
        reg_type: *const std::os::raw::c_char,
        reply_domain: *const std::os::raw::c_char,
        context: *mut std::ffi::c_void,
    ) {
        if error_code != 0 { return; }
        if flags & kDNSServiceFlagsAdd == 0 { return; } // not an add event

        let ctx = unsafe { &*(context as *const BrowseCtx) };
        let name = unsafe { std::ffi::CStr::from_ptr(service_name).to_string_lossy().to_string() };
        let rtype = unsafe { std::ffi::CStr::from_ptr(reg_type).to_string_lossy().to_string() };
        let domain = unsafe { std::ffi::CStr::from_ptr(reply_domain).to_string_lossy().to_string() };

        log::info!("[iOS discover] FOUND: name={} type={} domain={} iface={}", name, rtype, domain, interface_index);

        // Resolve this service on a new thread to get host+port
        let app = ctx.app.clone();
        let name_c = std::ffi::CString::new(name.clone()).unwrap_or_default();
        let rtype_c = std::ffi::CString::new(rtype).unwrap_or_default();
        let domain_c = std::ffi::CString::new(domain).unwrap_or_default();

        std::thread::spawn(move || {
            unsafe {
                let resolve_ctx = Box::new(ResolveCtx {
                    service_name: name.clone(),
                    app: app.clone(),
                });
                let mut resolve_ref: DNSServiceRef = std::ptr::null_mut();
                let err = DNSServiceResolve(
                    &mut resolve_ref,
                    0,
                    interface_index,
                    name_c.as_ptr(),
                    rtype_c.as_ptr(),
                    domain_c.as_ptr(),
                    resolve_callback,
                    Box::into_raw(resolve_ctx) as *mut std::ffi::c_void,
                );
                if err != 0 {
                    log::warn!("[iOS discover] DNSServiceResolve failed: {}", err);
                    return;
                }
                process_ref(resolve_ref, 3000);
                DNSServiceRefDeallocate(resolve_ref);
            }
        });
    }

    extern "C" fn resolve_callback(
        _sd_ref: DNSServiceRef,
        _flags: DNSServiceFlags,
        interface_index: u32,
        error_code: DNSServiceErrorType,
        _fullname: *const std::os::raw::c_char,
        hosttarget: *const std::os::raw::c_char,
        port: u16, // network byte order
        txt_len: u16,
        txt_record: *const u8,
        context: *mut std::ffi::c_void,
    ) {
        if error_code != 0 { return; }
        let ctx = unsafe { Box::from_raw(context as *mut ResolveCtx) };
        let host = unsafe { std::ffi::CStr::from_ptr(hosttarget).to_string_lossy().to_string() };
        let real_port = u16::from_be(port);
        let dt = parse_txt_device_type(txt_record, txt_len);

        log::info!("[iOS discover] RESOLVED: name={} host={} port={} dt={}", ctx.service_name, host, real_port, dt);

        // Now get the actual IP address
        let host_c = std::ffi::CString::new(host.clone()).unwrap_or_default();
        let addr_ctx = Box::new(AddrCtx {
            service_name: ctx.service_name.clone(),
            port: real_port,
            device_type: dt,
            app: ctx.app.clone(),
        });

        unsafe {
            let mut addr_ref: DNSServiceRef = std::ptr::null_mut();
            let err = DNSServiceGetAddrInfo(
                &mut addr_ref,
                0,
                interface_index,
                1, // kDNSServiceProtocol_IPv4
                host_c.as_ptr(),
                addr_info_callback,
                Box::into_raw(addr_ctx) as *mut std::ffi::c_void,
            );
            if err != 0 {
                log::warn!("[iOS discover] DNSServiceGetAddrInfo failed: {}", err);
                return;
            }
            process_ref(addr_ref, 2000);
            DNSServiceRefDeallocate(addr_ref);
        }
    }

    extern "C" fn addr_info_callback(
        _sd_ref: DNSServiceRef,
        _flags: DNSServiceFlags,
        _interface_index: u32,
        error_code: DNSServiceErrorType,
        _hostname: *const std::os::raw::c_char,
        address: *const libc::sockaddr,
        _ttl: u32,
        context: *mut std::ffi::c_void,
    ) {
        if error_code != 0 { return; }
        let ctx = unsafe { Box::from_raw(context as *mut AddrCtx) };

        // Extract IPv4 address
        let sa_family = unsafe { (*address).sa_family as i32 };
        if sa_family != libc::AF_INET { return; }

        let addr_in = unsafe { &*(address as *const libc::sockaddr_in) };
        let ip_bytes = addr_in.sin_addr.s_addr.to_ne_bytes();
        let ip_str = format!("{}.{}.{}.{}", ip_bytes[0], ip_bytes[1], ip_bytes[2], ip_bytes[3]);

        // Skip loopback and link-local
        if ip_str.starts_with("127.") || ip_str.starts_with("169.254.") { return; }

        let device = DiscoveredDevice {
            name: ctx.service_name.clone(),
            host: ip_str,
            port: ctx.port,
            device_type: ctx.device_type.clone(),
        };
        log::info!("[iOS discover] emitting: {:?}", device);
        let _ = ctx.app.emit("mdns-device-found", &device);
    }

    pub fn discover_devices(_app_opt: Option<&tauri::AppHandle>) -> Result<Vec<DiscoveredDevice>, String> {
        // For the blocking version, we collect results into a shared vec
        let devices: std::sync::Arc<Mutex<HashMap<String, DiscoveredDevice>>> =
            std::sync::Arc::new(Mutex::new(HashMap::new()));

        // Use a simplified approach: just do browse+resolve synchronously
        // For now, return empty and rely on start_discover for real results
        log::info!("[iOS discover] blocking discover not implemented, use start_discover");
        Ok(Vec::new())
    }

    pub fn start_discover(app: tauri::AppHandle) -> Result<(), String> {
        if DISCOVER_RUNNING.load(Ordering::SeqCst) { return Ok(()); }
        DISCOVER_RUNNING.store(true, Ordering::SeqCst);

        std::thread::spawn(move || {
            log::info!("[iOS discover] starting native Bonjour browse");
            unsafe {
                let browse_ctx = Box::new(BrowseCtx { app: app.clone() });
                // Leak intentionally — lives as long as browse is running
                let ctx_ptr = Box::into_raw(browse_ctx);

                let reg_type = std::ffi::CString::new("_shellbeam._tcp.").unwrap();
                let mut browse_ref: DNSServiceRef = std::ptr::null_mut();
                let err = DNSServiceBrowse(
                    &mut browse_ref,
                    0,
                    0, // all interfaces
                    reg_type.as_ptr(),
                    std::ptr::null(), // default domain
                    browse_callback,
                    ctx_ptr as *mut std::ffi::c_void,
                );
                if err != 0 {
                    log::warn!("[iOS discover] DNSServiceBrowse failed: {}", err);
                    DISCOVER_RUNNING.store(false, Ordering::SeqCst);
                    let _ = Box::from_raw(ctx_ptr); // cleanup
                    return;
                }

                let fd = DNSServiceRefSockFD(browse_ref);
                log::info!("[iOS discover] browse fd={}", fd);

                // select() loop until stopped
                while DISCOVER_RUNNING.load(Ordering::SeqCst) {
                    let mut tv = libc::timeval { tv_sec: 1, tv_usec: 0 };
                    let mut fds: libc::fd_set = std::mem::zeroed();
                    libc::FD_ZERO(&mut fds);
                    libc::FD_SET(fd, &mut fds);
                    let n = libc::select(fd + 1, &mut fds, std::ptr::null_mut(), std::ptr::null_mut(), &mut tv);
                    if n > 0 {
                        DNSServiceProcessResult(browse_ref);
                    }
                }

                DNSServiceRefDeallocate(browse_ref);
                let _ = Box::from_raw(ctx_ptr); // cleanup
                log::info!("[iOS discover] browse stopped");
            }
        });
        Ok(())
    }

    pub fn stop_discover() {
        DISCOVER_RUNNING.store(false, Ordering::SeqCst);
    }
}

// ─── Public Tauri commands (delegate to platform module) ────────────────────

#[tauri::command]
pub fn mdns_discover_devices() -> Result<Vec<DiscoveredDevice>, String> {
    #[cfg(not(target_os = "ios"))]
    { desktop::discover_devices() }
    #[cfg(target_os = "ios")]
    { ios::discover_devices(None) }
}

#[tauri::command]
pub fn mdns_start_discover(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "ios"))]
    { desktop::start_discover(app) }
    #[cfg(target_os = "ios")]
    { ios::start_discover(app) }
}

#[tauri::command]
pub fn mdns_stop_discover() {
    #[cfg(not(target_os = "ios"))]
    { desktop::stop_discover() }
    #[cfg(target_os = "ios")]
    { ios::stop_discover() }
}
