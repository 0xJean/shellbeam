//! Multi-route endpoint discovery and selection for paired ShellBeam peers.
//! Supports LAN IPv4, Tailscale CGNAT/MagicDNS, and custom endpoints (e.g. VPS reverse tunnels).

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use super::{PeerRoute, SyncTrustedPeer};

/// RFC 6598 CGNAT range (`100.64.0.0/10`) used by Tailscale.
pub fn is_tailscale_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

/// Tailscale IPv6 ULA prefix (`fd7a:115c:a1e0::/48`).
pub fn is_tailscale_ipv6(ip: std::net::Ipv6Addr) -> bool {
    let s = ip.segments();
    s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
}

pub fn is_tailscale_hostname(host: &str) -> bool {
    let lower = host.trim().trim_end_matches('.').to_ascii_lowercase();
    lower.ends_with(".ts.net") || lower.ends_with(".beta.tailscale.net")
}

pub fn classify_host(host: &str) -> &'static str {
    let trimmed = host.trim();
    if super::iroh_transport::parse_iroh_spec(trimmed).is_some() {
        return "iroh";
    }
    if is_tailscale_hostname(trimmed) {
        return "tailnet";
    }
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                if is_tailscale_ipv4(v4) {
                    "tailnet"
                } else if v4.is_private() || v4.is_loopback() {
                    "lan"
                } else {
                    "custom"
                }
            }
            IpAddr::V6(v6) => {
                if is_tailscale_ipv6(v6) {
                    "tailnet"
                } else if v6.is_loopback() {
                    "lan"
                } else {
                    "custom"
                }
            }
        };
    }
    if trimmed.ends_with(".local") {
        return "lan";
    }
    "custom"
}

pub fn route_priority(kind: &str) -> u8 {
    match kind {
        "lan" => 0,
        "tailnet" => 1,
        "iroh" => 2,
        _ => 3,
    }
}

pub fn route_connect_timeout(kind: &str) -> Duration {
    match kind {
        "lan" => Duration::from_millis(1200),
        "tailnet" => Duration::from_millis(3500),
        "iroh" => Duration::from_secs(8),
        _ => Duration::from_millis(5000),
    }
}

/// Parse a `host:port` string (including IPv6 `[::1]:9123`, hostnames `mac.ts.net:9123`,
/// or built-in P2P `iroh://<endpoint_id>`).
pub fn parse_host_port(endpoint: &str) -> Option<(String, u16)> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((id, _)) = super::iroh_transport::parse_iroh_spec(trimmed) {
        return Some((id, 1));
    }
    if let Ok(addr) = trimmed.parse::<SocketAddr>() {
        return Some((addr.ip().to_string(), addr.port()));
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        let (host, port_part) = rest.split_once("]:")?;
        let port = port_part.parse::<u16>().ok()?;
        if host.is_empty() || port == 0 {
            return None;
        }
        return Some((host.to_string(), port));
    }
    let (host, port_part) = trimmed.rsplit_once(':')?;
    let port = port_part.parse::<u16>().ok()?;
    let host = host.trim();
    if host.is_empty() || port == 0 || host.contains(':') {
        return None;
    }
    Some((host.to_string(), port))
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn read_tailscale_cli_info() -> (Vec<String>, Option<String>) {
    use std::process::{Command, Stdio};

    let candidates = [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
    ];
    for bin in candidates {
        let Ok(mut child) = Command::new(bin)
            .args(["status", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            continue;
        };
        let deadline = std::time::Instant::now() + Duration::from_millis(1500);
        let exited = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        if !exited {
            continue;
        }
        let Ok(output) = child.wait_with_output() else {
            continue;
        };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
            continue;
        };
        let backend_state = json
            .get("BackendState")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if backend_state != "Running" {
            return (Vec::new(), None);
        }
        let ips = json
            .get("TailscaleIPs")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| s.parse::<Ipv4Addr>().is_ok())
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let dns_name = json
            .get("Self")
            .and_then(|s| s.get("DNSName"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim_end_matches('.').to_string())
            .filter(|s| !s.is_empty());
        return (ips, dns_name);
    }
    (Vec::new(), None)
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn read_tailscale_cli_info() -> (Vec<String>, Option<String>) {
    (Vec::new(), None)
}

/// Detect all locally reachable endpoints (LAN IPv4 + Tailscale IPv4 / MagicDNS) for pairing & QR.
pub fn detect_local_endpoints(port: u16) -> Vec<PeerRoute> {
    let mut routes = Vec::new();
    let mut seen: HashSet<(String, u16)> = HashSet::new();

    let (ts_cli_ips, ts_magic_dns) = read_tailscale_cli_info();
    let ts_ip_set: HashSet<String> = ts_cli_ips.iter().cloned().collect();

    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        let mut by_iface: HashMap<String, Vec<IpAddr>> = HashMap::new();
        for iface in &ifaces {
            if !iface.is_loopback() {
                by_iface
                    .entry(iface.name.clone())
                    .or_default()
                    .push(iface.ip());
            }
        }

        // First collect LAN IPv4 addresses.
        for iface in &ifaces {
            if iface.is_loopback() {
                continue;
            }
            let IpAddr::V4(v4) = iface.ip() else {
                continue;
            };
            if v4.is_link_local() || is_tailscale_ipv4(v4) {
                continue;
            }
            if v4.is_private() {
                let host = v4.to_string();
                if seen.insert((host.clone(), port)) {
                    routes.push(PeerRoute {
                        kind: "lan".to_string(),
                        host,
                        port,
                        label: Some(format!("LAN ({})", iface.name)),
                        last_ok_at: None,
                    });
                }
            }
        }

        // Next collect Tailscale IPv4 addresses (by interface identity or CLI confirmation).
        for (name, addrs) in &by_iface {
            let lower = name.to_ascii_lowercase();
            let is_ts_iface = lower.starts_with("tailscale")
                || addrs
                    .iter()
                    .any(|ip| matches!(ip, IpAddr::V6(v6) if is_tailscale_ipv6(*v6)));
            for ip in addrs {
                let IpAddr::V4(v4) = ip else {
                    continue;
                };
                if !is_tailscale_ipv4(*v4) {
                    continue;
                }
                let host = v4.to_string();
                if !is_ts_iface && !ts_ip_set.contains(&host) {
                    continue;
                }
                if seen.insert((host.clone(), port)) {
                    routes.push(PeerRoute {
                        kind: "tailnet".to_string(),
                        host,
                        port,
                        label: Some("Tailscale IP".to_string()),
                        last_ok_at: None,
                    });
                }
            }
        }
    }

    // Add CLI-confirmed Tailscale IPs missed by interface enumeration (if any).
    for host in ts_cli_ips {
        if seen.insert((host.clone(), port)) {
            routes.push(PeerRoute {
                kind: "tailnet".to_string(),
                host,
                port,
                label: Some("Tailscale IP".to_string()),
                last_ok_at: None,
            });
        }
    }

    // Add MagicDNS hostname if Tailscale is running.
    if let Some(dns) = ts_magic_dns {
        if seen.insert((dns.clone(), port)) {
            routes.push(PeerRoute {
                kind: "tailnet".to_string(),
                host: dns,
                port,
                label: Some("Tailscale MagicDNS".to_string()),
                last_ok_at: None,
            });
        }
    }

    // Add built-in iroh P2P / Relay route when the sync server is active.
    if let Some(iroh_route) = super::iroh_transport::current_iroh_route() {
        if seen.insert((iroh_route.host.clone(), iroh_route.port)) {
            routes.push(iroh_route);
        }
    }

    routes
}

/// Merge `peer.routes` and legacy `peer.peer_endpoint`, deduplicate, and rank:
/// LAN → Tailscale → Custom (breaking ties by most recent `last_ok_at`).
pub fn collect_candidate_routes(peer: &SyncTrustedPeer) -> Vec<PeerRoute> {
    let mut map: HashMap<(String, u16), PeerRoute> = HashMap::new();

    for route in &peer.routes {
        let host = route.host.trim().to_string();
        if host.is_empty() || route.port == 0 {
            continue;
        }
        let kind = if route.kind.is_empty() {
            classify_host(&host).to_string()
        } else {
            route.kind.clone()
        };
        let key = (host.clone(), route.port);
        map.entry(key)
            .and_modify(|existing| {
                if route.last_ok_at > existing.last_ok_at {
                    existing.last_ok_at = route.last_ok_at;
                }
                if existing.label.is_none() {
                    existing.label = route.label.clone();
                }
            })
            .or_insert(PeerRoute {
                kind,
                host,
                port: route.port,
                label: route.label.clone(),
                last_ok_at: route.last_ok_at,
            });
    }

    if let Some(endpoint) = peer.peer_endpoint.as_deref() {
        if let Some((id, inline_relay)) = super::iroh_transport::parse_iroh_spec(endpoint) {
            map.entry((id.clone(), 1))
                .and_modify(|existing| {
                    if existing.label.is_none() && inline_relay.is_some() {
                        existing.label = inline_relay.clone();
                    }
                })
                .or_insert(PeerRoute {
                    kind: "iroh".to_string(),
                    host: id,
                    port: 1,
                    label: inline_relay,
                    last_ok_at: Some(peer.last_seen_at),
                });
        } else if let Some((host, port)) = parse_host_port(endpoint) {
            let kind = classify_host(&host).to_string();
            map.entry((host.clone(), port)).or_insert(PeerRoute {
                kind,
                host,
                port,
                label: None,
                last_ok_at: Some(peer.last_seen_at),
            });
        }
    }

    let mut routes: Vec<PeerRoute> = map.into_values().collect();
    routes.sort_by(|a, b| {
        route_priority(&a.kind)
            .cmp(&route_priority(&b.kind))
            .then_with(|| b.last_ok_at.unwrap_or(0).cmp(&a.last_ok_at.unwrap_or(0)))
            .then_with(|| a.host.cmp(&b.host))
    });
    routes
}

/// Connect to a single `PeerRoute` using IP literal, DNS resolution, or built-in `iroh` P2P/Relay.
pub fn connect_tcp_route(route: &PeerRoute) -> Result<TcpStream, String> {
    let timeout = route_connect_timeout(&route.kind);
    if route.kind == "iroh" || super::iroh_transport::parse_iroh_spec(&route.host).is_some() {
        let (id, inline_relay) = super::iroh_transport::parse_iroh_spec(&route.host)
            .unwrap_or_else(|| (route.host.trim().to_string(), None));
        let relay = inline_relay.as_deref().or(route.label.as_deref());
        return super::iroh_transport::connect_iroh_route(&id, relay, timeout);
    }
    let target = format!("{}:{}", route.host, route.port);
    let addrs: Vec<SocketAddr> = target
        .to_socket_addrs()
        .map_err(|e| format!("Resolve {target} failed: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("No addresses resolved for {target}"));
    }
    let mut last_err = String::new();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(e) => last_err = format!("Connect {addr} failed: {e}"),
        }
    }
    Err(last_err)
}

/// Upsert a route into a peer's route list (preserving existing `last_ok_at` when unchanged).
pub fn upsert_peer_route(peer: &mut SyncTrustedPeer, route: PeerRoute) {
    let host = route.host.trim().to_string();
    if host.is_empty() || route.port == 0 {
        return;
    }
    let kind = if route.kind.is_empty() {
        classify_host(&host).to_string()
    } else {
        route.kind
    };
    if let Some(existing) = peer
        .routes
        .iter_mut()
        .find(|r| r.host == host && r.port == route.port)
    {
        existing.kind = kind;
        if route.label.is_some() {
            existing.label = route.label;
        }
        if route.last_ok_at.is_some() {
            existing.last_ok_at = route.last_ok_at;
        }
    } else {
        peer.routes.push(PeerRoute {
            kind,
            host,
            port: route.port,
            label: route.label,
            last_ok_at: route.last_ok_at,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::PeerBridgePermissions;

    fn sample_peer() -> SyncTrustedPeer {
        SyncTrustedPeer {
            peer_device_id: "mac-1".into(),
            peer_device_name: Some("MacBook".into()),
            verified_at: 100,
            last_seen_at: 200,
            source: "lan".into(),
            peer_endpoint: Some("192.168.1.50:9123".into()),
            routes: vec![
                PeerRoute {
                    kind: "custom".into(),
                    host: "vps.example.com".into(),
                    port: 9123,
                    label: Some("VPS".into()),
                    last_ok_at: Some(900),
                },
                PeerRoute {
                    kind: "tailnet".into(),
                    host: "100.88.12.5".into(),
                    port: 9123,
                    label: Some("Tailscale".into()),
                    last_ok_at: Some(500),
                },
            ],
            bridge_permissions: PeerBridgePermissions::default(),
            sync_secret: None,
            pairing_version: 2,
        }
    }

    #[test]
    fn classifies_lan_tailscale_and_custom_hosts() {
        assert_eq!(classify_host("192.168.1.10"), "lan");
        assert_eq!(classify_host("10.0.0.5"), "lan");
        assert_eq!(classify_host("100.64.0.1"), "tailnet");
        assert_eq!(classify_host("100.127.255.254"), "tailnet");
        assert_eq!(classify_host("macbook.tail1234.ts.net"), "tailnet");
        assert_eq!(classify_host("100.128.0.1"), "custom");
        assert_eq!(classify_host("relay.example.com"), "custom");
    }

    #[test]
    fn ranks_lan_before_tailnet_before_custom_and_merges_legacy_endpoint() {
        let routes = collect_candidate_routes(&sample_peer());
        assert_eq!(routes.len(), 3);
        assert_eq!(routes[0].kind, "lan");
        assert_eq!(routes[0].host, "192.168.1.50");
        assert_eq!(routes[1].kind, "tailnet");
        assert_eq!(routes[1].host, "100.88.12.5");
        assert_eq!(routes[2].kind, "custom");
        assert_eq!(routes[2].host, "vps.example.com");
    }

    #[test]
    fn parses_ipv4_ipv6_and_magicdns_endpoints() {
        assert_eq!(
            parse_host_port("192.168.1.5:9123"),
            Some(("192.168.1.5".into(), 9123))
        );
        assert_eq!(
            parse_host_port("mac.tailnet.ts.net:9123"),
            Some(("mac.tailnet.ts.net".into(), 9123))
        );
        assert_eq!(parse_host_port("[::1]:9123"), Some(("::1".into(), 9123)));
        assert_eq!(parse_host_port("invalid"), None);
    }
}
