//! mDNS service registration, network utilities, and sync server loop.
//! Split from transport.rs to keep files under 500 lines.

#[cfg(not(any(target_os = "ios", target_os = "android")))]
use mdns_sd::{ServiceDaemon, ServiceInfo};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::atomic::Ordering;
#[cfg(target_os = "ios")]
use std::sync::Mutex;
use std::thread;

use super::transport::{serve_connection, SERVER_PORT, SERVER_RUNNING, SYNC_DEFAULT_PORT};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use super::transport::{MDNS_DAEMON, SHELLBEAM_SERVICE_TYPE};

fn sanitize_hostname_for_dns(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.trim_matches('-');
    let s = if s.is_empty() { "shellbeam" } else { s };
    s.chars().take(63).collect()
}

/// Public accessor for native_device_name, used by commands.rs.
pub fn native_device_name_public() -> String {
    native_device_name()
}

/// Get a human-friendly device name using platform-native APIs.
fn native_device_name() -> String {
    #[cfg(target_os = "ios")]
    {
        unsafe {
            use objc::runtime::{Class, Object};
            use objc::{msg_send, sel, sel_impl};
            let cls = Class::get("UIDevice").unwrap();
            let device: *mut Object = msg_send![cls, currentDevice];
            let name: *mut Object = msg_send![device, name];
            let utf8: *const std::os::raw::c_char = msg_send![name, UTF8String];
            if !utf8.is_null() {
                let s = std::ffi::CStr::from_ptr(utf8)
                    .to_string_lossy()
                    .into_owned();
                if !s.is_empty() {
                    return s;
                }
            }
        }
        return "ShellBeam-iOS".to_string();
    }
    #[cfg(target_os = "android")]
    {
        // hostname::get() returns "localhost" on Android — useless.
        // Try to get a useful name from Android system properties.
        // The real device name is obtained via the NSD bridge (JS side),
        // but we need a reasonable fallback for Rust-side init.
        if let Ok(model) = std::env::var("ANDROID_MODEL") {
            if !model.is_empty() && model != "unknown" {
                return model;
            }
        }
        // Try reading from /system/build.prop
        if let Ok(content) = std::fs::read_to_string("/system/build.prop") {
            for line in content.lines() {
                if let Some(val) = line.strip_prefix("ro.product.model=") {
                    let val = val.trim();
                    if !val.is_empty() {
                        return val.to_string();
                    }
                }
            }
        }
        return "ShellBeam-Android".to_string();
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let name = hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_default();
        name.strip_suffix(".local").unwrap_or(&name).to_string()
    }
}

fn device_type() -> &'static str {
    #[cfg(target_os = "ios")]
    {
        "phone"
    }
    #[cfg(target_os = "android")]
    {
        "phone"
    }
    #[cfg(target_os = "macos")]
    {
        "computer"
    }
    #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "android")))]
    {
        "computer"
    }
}

pub(crate) fn find_lan_ipv4() -> Option<std::net::Ipv4Addr> {
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        let mut preferred: Option<std::net::Ipv4Addr> = None;
        let mut fallback: Option<std::net::Ipv4Addr> = None;
        for iface in &ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                if v4.is_link_local() || v4.is_loopback() {
                    continue;
                }
                if iface.name.starts_with("en") || iface.name.starts_with("wlan") {
                    if preferred.is_none() {
                        preferred = Some(v4);
                    }
                } else if fallback.is_none() {
                    fallback = Some(v4);
                }
            }
        }
        preferred.or(fallback)
    } else {
        None
    }
}

#[cfg(target_os = "ios")]
static IOS_NET_SERVICE: Mutex<Option<usize>> = Mutex::new(None);
#[cfg(target_os = "ios")]
static IOS_SERVICE_RUNLOOP: Mutex<Option<usize>> = Mutex::new(None);

pub(crate) fn register_mdns_service(port: u16) {
    let device_name = native_device_name();
    let instance_name = if device_name.is_empty() || device_name == "localhost" {
        format!("ShellBeam-{port}")
    } else {
        device_name
    };

    #[cfg(target_os = "ios")]
    {
        register_mdns_service_ios(port, &instance_name);
    }
    #[cfg(target_os = "android")]
    {
        log::info!(
            "[android] mDNS registration skipped (handled by NsdHelper): name={} port={}",
            instance_name,
            port
        );
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        register_mdns_service_mdns_sd(port, &instance_name);
    }
}

#[cfg(target_os = "ios")]
fn register_mdns_service_ios(port: u16, instance_name: &str) {
    let name_owned = instance_name.to_string();
    std::thread::spawn(move || unsafe {
        use objc::runtime::{Class, Object, BOOL};
        use objc::{msg_send, sel, sel_impl};
        let cls = Class::get("NSNetService").unwrap();
        let alloc: *mut Object = msg_send![cls, alloc];
        let ns_string_cls = Class::get("NSString").unwrap();
        let domain: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: b"\0".as_ptr()];
        let svc_type_str = b"_shellbeam._tcp.\0";
        let svc_type: *mut Object =
            msg_send![ns_string_cls, stringWithUTF8String: svc_type_str.as_ptr()];
        let name_cstr = std::ffi::CString::new(name_owned.as_str()).unwrap_or_default();
        let name: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: name_cstr.as_ptr()];
        let service: *mut Object = msg_send![alloc,
            initWithDomain: domain type: svc_type name: name port: (port as i32)
        ];
        if service.is_null() {
            log::warn!("[iOS] NSNetService init returned nil");
            return;
        }

        let dt_key: *mut Object = msg_send![ns_string_cls, stringWithUTF8String: b"dt\0".as_ptr()];
        let dt_val: *mut Object =
            msg_send![ns_string_cls, stringWithUTF8String: b"phone\0".as_ptr()];
        let dict_cls = Class::get("NSDictionary").unwrap();
        let txt_dict: *mut Object =
            msg_send![dict_cls, dictionaryWithObject: dt_val forKey: dt_key];
        let ns_net_service_cls = Class::get("NSNetService").unwrap();
        let txt_data: *mut Object =
            msg_send![ns_net_service_cls, dataFromTXTRecordDictionary: txt_dict];
        let _: BOOL = msg_send![service, setTXTRecordData: txt_data];

        let run_loop_cls = Class::get("NSRunLoop").unwrap();
        let current_rl: *mut Object = msg_send![run_loop_cls, currentRunLoop];
        let default_mode: *mut Object =
            msg_send![ns_string_cls, stringWithUTF8String: b"kCFRunLoopDefaultMode\0".as_ptr()];
        let _: () = msg_send![service, scheduleInRunLoop: current_rl forMode: default_mode];
        let _: () = msg_send![service, publish];
        log::info!(
            "[iOS] NSNetService published: name={} port={}",
            name_owned,
            port
        );

        let cf_rl: *mut std::ffi::c_void = msg_send![current_rl, getCFRunLoop];
        if let Ok(mut guard) = IOS_NET_SERVICE.lock() {
            *guard = Some(service as usize);
        }
        if let Ok(mut guard) = IOS_SERVICE_RUNLOOP.lock() {
            *guard = Some(cf_rl as usize);
        }

        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFRunLoopRun();
        }
        CFRunLoopRun();
        log::info!("[iOS] NSNetService RunLoop exited");
    });
    log::info!(
        "[iOS] mDNS Bonjour service thread started: name={} port={}",
        instance_name,
        port
    );
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn register_mdns_service_mdns_sd(port: u16, instance_name: &str) {
    let dns_safe = sanitize_hostname_for_dns(instance_name);
    let host_name = format!("{dns_safe}.local.");
    let ip_str = find_lan_ipv4().map(|ip| ip.to_string()).unwrap_or_default();
    let mut props = HashMap::new();
    props.insert("dt".to_string(), device_type().to_string());

    match ServiceDaemon::new() {
        Ok(daemon) => {
            match ServiceInfo::new(
                SHELLBEAM_SERVICE_TYPE,
                instance_name,
                &host_name,
                &ip_str,
                port,
                Some(props),
            )
            .map(|s| s.enable_addr_auto())
            {
                Ok(info) => {
                    if let Err(e) = daemon.register(info) {
                        log::warn!("mDNS register failed: {e}");
                    } else {
                        log::info!("mDNS registered: name={instance_name} host={host_name} ip={ip_str} port={port} type={}", device_type());
                    }
                }
                Err(e) => log::warn!("mDNS ServiceInfo creation failed: {e}"),
            }
            if let Ok(mut guard) = MDNS_DAEMON.lock() {
                *guard = Some(daemon);
            }
        }
        Err(e) => log::warn!("mDNS daemon creation failed: {e}"),
    }
}

pub(crate) fn unregister_mdns_service() {
    #[cfg(target_os = "ios")]
    {
        if let Ok(mut guard) = IOS_NET_SERVICE.lock() {
            if let Some(ptr) = guard.take() {
                unsafe {
                    use objc::runtime::Object;
                    use objc::{msg_send, sel, sel_impl};
                    let service = ptr as *mut Object;
                    let _: () = msg_send![service, stop];
                    log::info!("[iOS] NSNetService stopped");
                }
            }
        }
        if let Ok(mut guard) = IOS_SERVICE_RUNLOOP.lock() {
            if let Some(rl_ptr) = guard.take() {
                unsafe {
                    #[link(name = "CoreFoundation", kind = "framework")]
                    extern "C" {
                        fn CFRunLoopStop(rl: *mut std::ffi::c_void);
                    }
                    CFRunLoopStop(rl_ptr as *mut std::ffi::c_void);
                    log::info!("[iOS] NSNetService RunLoop stopped");
                }
            }
        }
    }
    #[cfg(target_os = "android")]
    {
        log::info!("[android] mDNS unregistration skipped (handled by NsdHelper)");
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if let Ok(mut guard) = MDNS_DAEMON.lock() {
            if let Some(daemon) = guard.take() {
                daemon.shutdown().ok();
                log::info!("mDNS service unregistered");
            }
        }
    }
}

pub fn server_loop(app: tauri::AppHandle, port: u16) {
    // On Android, binding to 0.0.0.0 may cause the listener to be associated
    // with the cellular interface when WiFi has no internet.  Binding to the
    // specific WiFi IP ensures incoming LAN connections reach our socket.
    let bind_addr = if cfg!(target_os = "android") {
        if let Some(wifi_ip) = find_lan_ipv4() {
            let addr = format!("{wifi_ip}:{port}");
            log::info!("[android] Sync server will bind to WiFi IP: {addr}");
            addr
        } else {
            log::warn!("[android] No WiFi IP found, falling back to 0.0.0.0:{port}");
            format!("0.0.0.0:{port}")
        }
    } else {
        format!("0.0.0.0:{port}")
    };

    let listener = match TcpListener::bind(&bind_addr) {
        Ok(l) => l,
        Err(e) => {
            // If binding to a specific IP failed, try 0.0.0.0 as fallback
            log::warn!("Sync server bind to {bind_addr} failed ({e}), trying 0.0.0.0:{port}");
            match TcpListener::bind(format!("0.0.0.0:{port}")) {
                Ok(l) => l,
                Err(e2) => {
                    log::error!("Sync server bind failed: {e2}");
                    SERVER_RUNNING.store(false, Ordering::SeqCst);
                    SERVER_PORT.store(0, Ordering::SeqCst);
                    return;
                }
            }
        }
    };
    let actual_addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_default();
    SERVER_RUNNING.store(true, Ordering::SeqCst);
    SERVER_PORT.store(port, Ordering::SeqCst);
    register_mdns_service(port);
    log::info!("Sync server listening on {actual_addr}");
    for stream in listener.incoming() {
        if !SERVER_RUNNING.load(Ordering::SeqCst) {
            break;
        }
        match stream {
            Ok(s) => {
                let app_clone = app.clone();
                thread::spawn(move || serve_connection(app_clone, s));
            }
            Err(e) => log::warn!("Sync server accept error: {e}"),
        }
    }
    unregister_mdns_service();
    SERVER_RUNNING.store(false, Ordering::SeqCst);
    SERVER_PORT.store(0, Ordering::SeqCst);
}

/// Diagnostic: test each step of mDNS registration and return results.
pub fn mdns_diagnose() -> Vec<String> {
    let mut log = Vec::new();
    let device_name = native_device_name();
    log.push(format!("[OK] native_device_name() = {:?}", device_name));
    log.push(format!("[OK] device_type() = {:?}", device_type()));

    match find_lan_ipv4() {
        Some(ip) => log.push(format!("[OK] LAN IPv4 = {}", ip)),
        None => log.push("[WARN] No LAN IPv4 found".to_string()),
    }
    match if_addrs::get_if_addrs() {
        Ok(ifaces) => {
            let ipv4_non_lo: Vec<_> = ifaces
                .iter()
                .filter(|i| !i.is_loopback() && matches!(i.ip(), std::net::IpAddr::V4(_)))
                .collect();
            log.push(format!(
                "[OK] if_addrs: {} total, {} non-loopback IPv4",
                ifaces.len(),
                ipv4_non_lo.len()
            ));
            for iface in &ipv4_non_lo {
                log.push(format!("  - {} ip={}", iface.name, iface.ip()));
            }
        }
        Err(e) => log.push(format!("[FAIL] if_addrs error: {e}")),
    }

    let port = SERVER_PORT.load(Ordering::SeqCst);
    let test_port = if port > 0 { port } else { SYNC_DEFAULT_PORT };
    log.push(format!(
        "[INFO] sync server port = {} (0 = not started)",
        port
    ));

    let instance_name = if device_name.is_empty() || device_name == "localhost" {
        format!("ShellBeam-{test_port}")
    } else {
        device_name
    };
    let dns_safe = sanitize_hostname_for_dns(&instance_name);
    let host_name = format!("{dns_safe}.local.");
    let ip_str = find_lan_ipv4().map(|ip| ip.to_string()).unwrap_or_default();
    log.push(format!(
        "[INFO] instance={:?} host={:?} ip={:?} dt={:?}",
        instance_name,
        host_name,
        ip_str,
        device_type()
    ));

    #[cfg(target_os = "android")]
    {
        log.push("[INFO] Android: mDNS handled by NsdHelper (NsdManager API)".to_string());
    }
    #[cfg(target_os = "ios")]
    {
        log.push("[INFO] iOS: mDNS handled by NSNetService (Bonjour)".to_string());
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        match ServiceDaemon::new() {
            Ok(daemon) => {
                log.push("[OK] ServiceDaemon::new() succeeded".to_string());
                match ServiceInfo::new(
                    SHELLBEAM_SERVICE_TYPE,
                    &instance_name,
                    &host_name,
                    &ip_str,
                    test_port,
                    None,
                ) {
                    Ok(info) => {
                        let info = info.enable_addr_auto();
                        log.push("[OK] ServiceInfo::new() succeeded".to_string());
                        match daemon.register(info) {
                            Ok(_) => {
                                log.push("[OK] daemon.register() succeeded".to_string());
                                std::thread::sleep(std::time::Duration::from_secs(2));
                                let _ = daemon.shutdown();
                                log.push("[OK] test service unregistered".to_string());
                            }
                            Err(e) => log.push(format!("[FAIL] daemon.register() error: {e}")),
                        }
                    }
                    Err(e) => log.push(format!("[FAIL] ServiceInfo::new() error: {e}")),
                }
            }
            Err(e) => log.push(format!("[FAIL] ServiceDaemon::new() error: {e}")),
        }
    }
    log
}
