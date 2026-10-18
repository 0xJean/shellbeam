use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::{fs::PermissionsExt, io::AsRawFd},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const HISTORY_LIMIT: usize = 1440;
pub const HISTORY_MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_SAFE_TIMESTAMP: u64 = 9_007_199_254_740_991;
static STOP: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryProtocolLimits {
    pub schema_version: u32,
    /// JSON envelope plus terminating newline; below the remote command budget.
    pub page_bytes: usize,
    pub max_points: usize,
    pub default_points: usize,
}

pub fn history_protocol_limits() -> &'static HistoryProtocolLimits {
    static LIMITS: OnceLock<HistoryProtocolLimits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        let limits: HistoryProtocolLimits =
            serde_json::from_str(include_str!("../history-protocol-limits.json"))
                .expect("checked-in history protocol limits");
        assert!(limits.schema_version == 1);
        assert!(limits.page_bytes > 0 && limits.page_bytes < 256 * 1024);
        assert!(limits.max_points > 0 && limits.max_points <= HISTORY_LIMIT);
        assert!((1..=limits.max_points).contains(&limits.default_points));
        limits
    })
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("SHELLBEAM_AGENT_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local/share/shellbeam-agent"))
}
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

pub fn atomic_json(path: &Path, value: &Value) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("state_path_invalid"))?;
    private_dir(parent)?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    // State directories are private and symlinks are never followed for temporary files.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(&temporary, path)
}

pub fn read_json(path: &Path) -> io::Result<Value> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(io::Error::other("state_size_exceeded"));
    }
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

/// Fixed command/argument inventory; no shell, remote commands, environment or credentials are recorded.
fn output(program: &str, args: &[&str]) -> Option<String> {
    let resolved = if program.starts_with('/') {
        PathBuf::from(program)
    } else {
        ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .iter()
            .map(|directory| Path::new(directory).join(program))
            .find(|path| path.is_file())?
    };
    let mut child = Command::new(resolved)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Read concurrently to avoid a full pipe deadlocking the child. Retain at most 64 KiB.
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let remaining = 65536_usize.saturating_sub(bytes.len());
                    bytes.extend_from_slice(&buffer[..count.min(remaining)]);
                }
            }
        }
        bytes
    });
    let started = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(3) => {
                thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader.join().ok()?;
    success.then(|| String::from_utf8_lossy(&bytes).trim().to_owned())
}

fn safe_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(240)
        .collect()
}
fn number_file(path: &str) -> Option<f64> {
    fs::read_to_string(path)
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn cpu_ticks() -> Option<(u64, u64)> {
    let content = fs::read_to_string("/proc/stat").ok()?;
    let fields: Vec<u64> = content
        .lines()
        .next()?
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    Some((
        fields.iter().sum(),
        fields.get(3)? + fields.get(4).unwrap_or(&0),
    ))
}
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn host_port() -> libc::mach_port_t {
    // Retain one send right for the process lifetime instead of leaking a new
    // mach_host_self reference on each periodic sample.
    static HOST: std::sync::OnceLock<libc::mach_port_t> = std::sync::OnceLock::new();
    *HOST.get_or_init(|| unsafe { libc::mach_host_self() })
}

#[cfg(target_os = "macos")]
fn cpu_ticks() -> Option<(u64, u64)> {
    let mut info = libc::host_cpu_load_info { cpu_ticks: [0; 4] };
    let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
    // The buffer is exactly HOST_CPU_LOAD_INFO_COUNT integer fields as required by Mach.
    let result = unsafe {
        libc::host_statistics(
            host_port(),
            libc::HOST_CPU_LOAD_INFO,
            &mut info as *mut _ as *mut i32,
            &mut count,
        )
    };
    (result == 0).then(|| {
        (
            info.cpu_ticks.iter().map(|v| *v as u64).sum(),
            info.cpu_ticks[2] as u64,
        )
    })
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn cpu_ticks() -> Option<(u64, u64)> {
    None
}

#[cfg(target_os = "linux")]
fn memory() -> (Option<u64>, Option<u64>) {
    let content = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let field = |name: &str| {
        content
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1)?.parse::<u64>().ok())
            .map(|value| value * 1024)
    };
    let total = field("MemTotal:");
    let available = field("MemAvailable:");
    (
        total
            .zip(available)
            .map(|(total, available)| total.saturating_sub(available)),
        total,
    )
}
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn memory() -> (Option<u64>, Option<u64>) {
    let total =
        output("/usr/sbin/sysctl", &["-n", "hw.memsize"]).and_then(|v| v.parse::<u64>().ok());
    let mut info: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
    let mut count = libc::HOST_VM_INFO64_COUNT;
    let result = unsafe {
        libc::host_statistics64(
            host_port(),
            libc::HOST_VM_INFO64,
            &mut info as *mut _ as *mut i32,
            &mut count,
        )
    };
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    let available = (result == 0 && page_size > 0)
        .then(|| (u64::from(info.free_count) + u64::from(info.inactive_count)) * page_size as u64);
    (
        total
            .zip(available)
            .map(|(total, available)| total.saturating_sub(available)),
        total,
    )
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn memory() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[allow(clippy::unnecessary_cast)] // libc statvfs field widths differ across supported Unix targets.
fn disk() -> (Option<u64>, Option<u64>) {
    let path = c"/";
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return (None, None);
    }
    let block = stat.f_frsize as u64;
    (
        Some(
            (stat.f_blocks as u64)
                .saturating_sub(stat.f_bfree as u64)
                .saturating_mul(block),
        ),
        Some((stat.f_blocks as u64).saturating_mul(block)),
    )
}
#[cfg(target_os = "linux")]
fn network() -> Option<(u64, u64)> {
    let content = fs::read_to_string("/proc/net/dev").ok()?;
    let mut total = (0, 0);
    let mut found = false;
    for line in content.lines().skip(2) {
        let (name, values) = line.split_once(':')?;
        if name.trim() == "lo" {
            continue;
        }
        let fields: Vec<u64> = values
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?;
        total.0 += fields.first()?;
        total.1 += fields.get(8)?;
        found = true;
    }
    found.then_some(total)
}
#[cfg(target_os = "macos")]
fn network() -> Option<(u64, u64)> {
    let mut addresses: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut addresses) } != 0 {
        return None;
    }
    let mut current = addresses;
    let mut total = (0_u64, 0_u64);
    let mut found = false;
    while !current.is_null() {
        let interface = unsafe { &*current };
        if !interface.ifa_addr.is_null()
            && unsafe { (*interface.ifa_addr).sa_family as i32 } == libc::AF_LINK
            && !interface.ifa_data.is_null()
            && interface.ifa_flags & libc::IFF_LOOPBACK as u32 == 0
        {
            let data = unsafe { &*(interface.ifa_data as *const libc::if_data) };
            total.0 += u64::from(data.ifi_ibytes);
            total.1 += u64::from(data.ifi_obytes);
            found = true;
        }
        current = interface.ifa_next;
    }
    unsafe { libc::freeifaddrs(addresses) };
    found.then_some(total)
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn network() -> Option<(u64, u64)> {
    None
}
fn percentage(used: Option<u64>, total: Option<u64>) -> Option<f64> {
    used.zip(total)
        .filter(|(_, total)| *total > 0)
        .map(|(used, total)| (used as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
}

pub fn collect() -> Value {
    let cpu_before = cpu_ticks();
    let network_before = network();
    let started = Instant::now();
    thread::sleep(Duration::from_millis(120));
    let cpu_percent =
        cpu_before
            .zip(cpu_ticks())
            .and_then(|((before, idle_before), (after, idle_after))| {
                let total = after.checked_sub(before)?;
                let idle = idle_after.checked_sub(idle_before)?;
                (total > 0 && idle <= total).then(|| (total - idle) as f64 / total as f64 * 100.0)
            });
    let elapsed = started.elapsed().as_secs_f64();
    let rate =
        network_before
            .zip(network())
            .and_then(|((before_rx, before_tx), (after_rx, after_tx))| {
                Some((
                    after_rx.checked_sub(before_rx)? as f64 / elapsed,
                    after_tx.checked_sub(before_tx)? as f64 / elapsed,
                ))
            });
    let (memory_used, memory_total) = memory();
    let (disk_used, disk_total) = disk();
    let hostname = output("hostname", &[])
        .map(|s| safe_text(&s))
        .unwrap_or_default();
    let kernel = output("uname", &["-sr"])
        .map(|s| safe_text(&s))
        .unwrap_or_default();
    let os = if cfg!(target_os = "linux") {
        fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|s| {
                s.lines().find_map(|line| {
                    line.strip_prefix("PRETTY_NAME=")
                        .map(|s| safe_text(s.trim_matches('"')))
                })
            })
            .unwrap_or_else(|| "Linux".into())
    } else {
        std::env::consts::OS.into()
    };
    let mut load = [0.0_f64; 3];
    let load_count = unsafe { libc::getloadavg(load.as_mut_ptr(), 3) };
    let uptime = if cfg!(target_os = "linux") {
        number_file("/proc/uptime")
    } else {
        output("/usr/sbin/sysctl", &["-n", "kern.boottime"])
            .and_then(|v| {
                v.split("sec = ")
                    .nth(1)?
                    .split(',')
                    .next()?
                    .trim()
                    .parse::<u64>()
                    .ok()
            })
            .map(|boot| now_ms().saturating_sub(boot * 1000) as f64 / 1000.0)
    };
    let sampled_at = now_ms();
    let metrics = json!({ "hostname": hostname, "os": os, "kernel": kernel, "cpuPercent": cpu_percent, "memoryUsedBytes": memory_used, "memoryTotalBytes": memory_total, "memoryPercent": percentage(memory_used,memory_total), "diskUsedBytes": disk_used, "diskTotalBytes": disk_total, "diskPercent": percentage(disk_used,disk_total), "load1": (load_count >= 1).then_some(load[0]), "load5": (load_count >= 2).then_some(load[1]), "load15": (load_count >= 3).then_some(load[2]), "uptimeSeconds": uptime, "networkRxBytesPerSec": rate.map(|r| r.0), "networkTxBytesPerSec": rate.map(|r| r.1), "latencyMs": null, "sampledAt": sampled_at });
    let mut tools = Vec::new();
    for binary in [
        "systemctl",
        "docker",
        "git",
        "node",
        "python3",
        "nginx",
        "ss",
    ] {
        // Fixed directories prevent a PATH-controlled command from running during collection.
        if let Some(path) = ["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin"]
            .iter()
            .map(|dir| Path::new(dir).join(binary))
            .find(|p| p.is_file())
        {
            tools.push(json!({ "id":binary,"name":binary,"binary":binary,"category":"system","path":path,"version":"" }));
        }
    }
    let services: Vec<Value> = if cfg!(target_os = "linux") {
        output("/usr/bin/systemctl", &["--user", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"]).unwrap_or_default().lines().take(100).filter_map(|line| { let fields: Vec<&str> = line.split_whitespace().collect(); (fields.len() >= 4).then(|| json!({"name":safe_text(fields[0]),"active":safe_text(fields[2]),"enabled":"unknown"})) }).collect()
    } else {
        Vec::new()
    };
    let inventory = json!({ "resource": { "hostname":hostname,"os":os,"kernel":kernel,"arch":std::env::consts::ARCH,"uptime":uptime.map(|s| format!("{}s",s as u64)).unwrap_or_default(),"cpuPercent":cpu_percent,"memoryPercent":percentage(memory_used,memory_total),"memoryText":memory_used.zip(memory_total).map(|(u,t)| format!("{u}/{t} B")).unwrap_or_default(),"diskPercent":percentage(disk_used,disk_total),"diskText":disk_used.zip(disk_total).map(|(u,t)| format!("{u}/{t} B")).unwrap_or_default(),"network":rate.map(|(rx,tx)|format!("{:.0} B/s",rx+tx)).unwrap_or_default() }, "tools":tools,"services":services,"containers":[],"pm2":[],"projects":[],"scannedAt":sampled_at });
    let observed = cpu_percent.is_some() || memory_total.is_some() || disk_total.is_some();
    json!({"schemaVersion":1,"agentId":format!("shellbeam-agent-{hostname}"),"version":VERSION,"status":"installed","health":if observed {"online"} else {"unknown"},"capabilities":["heartbeat","metrics","inventory"],"lastHeartbeatAt":sampled_at,"heartbeatTtlMs":180000,"serviceName":"shellbeam-agent","sampledAt":sampled_at,"metrics":metrics,"inventory":inventory,"errors":if observed {Vec::<Value>::new()} else {vec![json!({"section":"provider","code":"collection_unavailable","message":"No metric source was readable"})]}})
}

pub fn append_history(
    directory: &Path,
    value: &Value,
    limit: usize,
    max_bytes: usize,
) -> io::Result<()> {
    private_dir(directory)?;
    let path = directory.join("history.jsonl");
    let mut entries: VecDeque<String> = if let Ok(file) = File::open(&path) {
        let mut bytes = Vec::new();
        file.take(HISTORY_MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > HISTORY_MAX_BYTES {
            return Err(io::Error::other("history_size_exceeded"));
        }
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|line| serde_json::from_str::<Value>(line).is_ok())
            .map(str::to_owned)
            .collect()
    } else {
        VecDeque::new()
    };
    let entry = serde_json::to_string(value)?;
    if entry.len() > max_bytes {
        return Err(io::Error::other("sample_size_exceeded"));
    }
    entries.push_back(entry);
    let mut size: usize = entries.iter().map(|line| line.len() + 1).sum();
    while entries.len() > limit.max(1) || size > max_bytes {
        if let Some(first) = entries.pop_front() {
            size -= first.len() + 1;
        } else {
            break;
        }
    }
    let temporary = directory.join(format!("history.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    for entry in entries {
        writeln!(file, "{entry}")?;
    }
    file.sync_all()?;
    fs::rename(temporary, path)
}

pub fn history(directory: &Path, limit: usize) -> io::Result<Value> {
    let file = File::open(directory.join("history.jsonl"))?;
    let mut bytes = Vec::new();
    file.take(HISTORY_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > HISTORY_MAX_BYTES {
        return Err(io::Error::other("history_size_exceeded"));
    }
    let mut entries: Vec<Value> = String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let start = entries.len().saturating_sub(limit.min(HISTORY_LIMIT));
    Ok(json!(entries.drain(start..).collect::<Vec<_>>()))
}

fn valid_agent_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 160 && !id.chars().any(char::is_control))
}

/// Identity belongs to this installation's private state, never to a mutable
/// hostname. The separate lock also serializes the first page request with a
/// daemon starting for the first time.
pub fn persistent_agent_id(directory: &Path) -> io::Result<String> {
    private_dir(directory)?;
    let lock_path = directory.join("identity.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)?;
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let identity_path = directory.join("identity.json");
    match read_json(&identity_path) {
        Ok(identity) => {
            return valid_agent_id(&identity["agentId"])
                .map(str::to_owned)
                .ok_or_else(|| io::Error::other("agent_identity_invalid"));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // Preserve the existing provider binding when upgrading a daemon that
    // previously used its hostname as identity.
    let previous = read_json(&directory.join("status.json"))
        .ok()
        .and_then(|status| valid_agent_id(&status["agentId"]).map(str::to_owned));
    let agent_id = if let Some(previous) = previous {
        previous
    } else {
        let mut random = [0_u8; 16];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let random: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("shellbeam-agent-{random}")
    };
    atomic_json(
        &identity_path,
        &json!({"schemaVersion":1,"agentId":agent_id}),
    )?;
    Ok(agent_id)
}

/// Read one bounded, ascending page of the daemon spool. `after` is exclusive
/// and `through` is inclusive; callers retain the same `through` for every page
/// of a synchronization. Invalid or foreign records in that window reject the
/// entire page without a cursor; unparseable timestamps also reject the page
/// because they cannot safely be assigned to a different window. Original
/// snapshots and sample times are retained.
pub fn history_page(
    directory: &Path,
    expected_agent_id: &str,
    after: u64,
    through: u64,
    limit: usize,
) -> io::Result<Value> {
    history_page_at(
        directory,
        expected_agent_id,
        after,
        through,
        limit,
        now_ms(),
    )
}

fn history_page_at(
    directory: &Path,
    expected_agent_id: &str,
    after: u64,
    through: u64,
    limit: usize,
    received_at: u64,
) -> io::Result<Value> {
    let limits = history_protocol_limits();
    if after > through
        || through > MAX_SAFE_TIMESTAMP
        || !(1..=limits.max_points).contains(&limit)
        || valid_agent_id(&json!(expected_agent_id)).is_none()
    {
        return Err(io::Error::other("history_page_arguments_invalid"));
    }
    // Open a single inode: a concurrent atomic spool replacement cannot mix
    // pieces of two generations within one page.
    let file = File::open(directory.join("history.jsonl"))?;
    let mut bytes = Vec::new();
    file.take(HISTORY_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > HISTORY_MAX_BYTES {
        return Err(io::Error::other("history_size_exceeded"));
    }
    let agent_id = persistent_agent_id(directory)?;
    if agent_id != expected_agent_id {
        return Err(io::Error::other("history_page_identity_mismatch"));
    }
    let mut ordered = BTreeMap::<u64, Value>::new();
    for (index, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
        if index >= HISTORY_LIMIT {
            return Err(io::Error::other("history_record_limit_exceeded"));
        }
        let point = serde_json::from_str::<Value>(line)
            .map_err(|_| io::Error::other("history_page_record_invalid"))?;
        let sampled_at = point["sampledAt"]
            .as_u64()
            .filter(|sampled_at| *sampled_at > 0 && *sampled_at <= MAX_SAFE_TIMESTAMP)
            .ok_or_else(|| io::Error::other("history_page_record_invalid"))?;
        // Known timestamps outside this snapshot do not describe its
        // completeness, including future rows after the fixed `through`.
        if sampled_at <= after || sampled_at > through {
            continue;
        }
        if sampled_at > received_at {
            return Err(io::Error::other("history_page_future_sample"));
        }
        if point["schemaVersion"] != 1
            || valid_agent_id(&point["agentId"]).is_none()
            || !point["metrics"].is_object()
            || point["metrics"]["sampledAt"].as_u64() != Some(sampled_at)
        {
            return Err(io::Error::other("history_page_record_invalid"));
        }
        if point["agentId"].as_str() != Some(agent_id.as_str()) {
            return Err(io::Error::other("history_page_foreign_identity"));
        }
        // Keep the first durable record for a timestamp. Deduplicate *before*
        // applying the page limit, so duplicates cannot strand a same-ms row.
        ordered.entry(sampled_at).or_insert(point);
    }
    let mut page = json!({
        "schemaVersion":1,"version":VERSION,"agentId":agent_id,
        "after":after,"through":through,"points":[],"nextCursor":after,"hasMore":false
    });
    let mut points = Vec::<Value>::new();
    let mut next_cursor = after;
    let mut iter = ordered.into_iter().peekable();
    while points.len() < limit {
        let Some((sampled_at, point)) = iter.next() else {
            break;
        };
        points.push(point);
        page["points"] = json!(points);
        page["nextCursor"] = json!(sampled_at);
        page["hasMore"] = json!(iter.peek().is_some());
        if serde_json::to_vec(&page)?.len() + 1 > limits.page_bytes {
            points.pop();
            if points.is_empty() {
                // Do not silently skip a large sample and move past it.
                return Err(io::Error::other("history_page_sample_size_exceeded"));
            }
            page["points"] = json!(points);
            page["nextCursor"] = json!(next_cursor);
            page["hasMore"] = json!(true);
            return Ok(page);
        }
        next_cursor = sampled_at;
    }
    page["hasMore"] = json!(iter.peek().is_some());
    Ok(page)
}

pub fn probe(directory: &Path) -> io::Result<Value> {
    let mut status = read_json(&directory.join("status.json"))?;
    let sampled = status["lastHeartbeatAt"].as_u64().unwrap_or(0);
    let received_at = now_ms();
    if sampled == 0 || sampled > received_at {
        status["health"] = json!("unknown");
    } else if received_at.saturating_sub(sampled)
        > status["heartbeatTtlMs"].as_u64().unwrap_or(180000)
    {
        status["health"] = json!("offline");
    }
    Ok(status)
}
extern "C" fn terminate(_: i32) {
    STOP.store(true, Ordering::Relaxed);
}
fn cleanup_stale_temps(directory: &Path) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(pid) = name
            .strip_prefix("history.")
            .or_else(|| name.strip_prefix("status."))
            .and_then(|name| name.strip_suffix(".tmp"))
        {
            if !pid.is_empty()
                && pid.bytes().all(|byte| byte.is_ascii_digit())
                && entry.file_type()?.is_file()
            {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

pub fn daemon(directory: &Path, interval: Duration, limit: usize) -> io::Result<()> {
    private_dir(directory)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.join("daemon.lock"))?;
    fs::set_permissions(
        directory.join("daemon.lock"),
        fs::Permissions::from_mode(0o600),
    )?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::other("agent_already_running"));
    }
    // Only the lock holder can remove orphaned atomic-write files left by a
    // crash. They must not accumulate outside the bounded spool budget.
    cleanup_stale_temps(directory)?;
    let agent_id = persistent_agent_id(directory)?;
    unsafe {
        libc::signal(libc::SIGTERM, terminate as *const () as usize);
        libc::signal(libc::SIGINT, terminate as *const () as usize);
    }
    STOP.store(false, Ordering::Relaxed);
    while !STOP.load(Ordering::Relaxed) {
        let mut status = collect();
        status["agentId"] = json!(agent_id);
        status["heartbeatTtlMs"] = json!((interval.as_millis() as u64).saturating_mul(3).max(3000));
        // A published heartbeat must refer to a durably spooled sample, even
        // when launchd/systemd restarts us immediately after reading status.
        append_history(directory, &status, limit, HISTORY_MAX_BYTES)?;
        atomic_json(&directory.join("status.json"), &status)?;
        let started = Instant::now();
        while started.elapsed() < interval && !STOP.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(100));
        }
    }
    if let Ok(mut status) = read_json(&directory.join("status.json")) {
        status["health"] = json!("offline");
        atomic_json(&directory.join("status.json"), &status)?;
    }
    Ok(())
}

pub fn service_definition(executable: &Path, directory: &Path) -> io::Result<String> {
    let exe = executable
        .to_str()
        .ok_or_else(|| io::Error::other("path_invalid"))?;
    let state = directory
        .to_str()
        .ok_or_else(|| io::Error::other("path_invalid"))?;
    if [exe, state].iter().any(|v| {
        v.chars()
            .any(|c| c.is_control() || c == '"' || c == '\\' || c == '%')
    }) {
        return Err(io::Error::other("path_invalid"));
    }
    if cfg!(target_os = "macos") {
        let escape = |v: &str| {
            v.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        Ok(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>app.shellbeam.agent</string><key>ProgramArguments</key><array><string>{}</string><string>daemon</string><string>--state-dir</string><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>10</integer></dict></plist>",escape(exe),escape(state)))
    } else {
        Ok(format!("[Unit]\nDescription=ShellBeam user metrics probe\n[Service]\nType=simple\nExecStart=\"{exe}\" daemon --state-dir \"{state}\"\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=\"{state}\"\nRestrictAddressFamilies=AF_UNIX\nUMask=0077\n[Install]\nWantedBy=default.target\n"))
    }
}

fn unit_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/LaunchAgents/app.shellbeam.agent.plist")
    } else {
        home_dir().join(".config/systemd/user/shellbeam-agent.service")
    }
}
fn checked_command(program: &str, args: &[&str]) -> io::Result<()> {
    output(program, args)
        .map(|_| ())
        .ok_or_else(|| io::Error::other("user_service_command_failed"))
}
fn launchd_loaded(target: &str) -> io::Result<bool> {
    let mut child = Command::new("/bin/launchctl")
        .args(["print", target])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return match status.code() {
                Some(0) => Ok(true),
                Some(113) => Ok(false),
                _ => Err(io::Error::other("launchd_state_unknown")),
            };
        }
        if started.elapsed() > Duration::from_secs(3) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("launchd_state_timeout"));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// launchctl bootout is asynchronous. File removal is safe only after launchd
/// confirms the service is absent; a timeout or permission error is unknown.
pub fn wait_for_launchd_unloaded(target: &str) -> io::Result<()> {
    let started = Instant::now();
    while launchd_loaded(target)? {
        if started.elapsed() > Duration::from_secs(10) {
            return Err(io::Error::other("launchd_stop_unverified"));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

pub fn service(action: &str) -> io::Result<()> {
    if !["start", "stop", "restart", "status"].contains(&action) {
        return Err(io::Error::other("service_action_invalid"));
    }
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let target = format!("{domain}/app.shellbeam.agent");
        let unit = unit_path();
        let unit = unit
            .to_str()
            .ok_or_else(|| io::Error::other("path_invalid"))?;
        match action {
            "start" => checked_command("/bin/launchctl", &["bootstrap", &domain, unit]),
            "stop" => {
                if !launchd_loaded(&target)? {
                    return Ok(());
                }
                checked_command("/bin/launchctl", &["bootout", &target])?;
                wait_for_launchd_unloaded(&target)
            }
            "restart" => checked_command("/bin/launchctl", &["kickstart", "-k", &target]),
            _ => checked_command("/bin/launchctl", &["print", &target]),
        }
    } else {
        checked_command(
            "/usr/bin/systemctl",
            &["--user", action, "shellbeam-agent.service"],
        )
    }
}
/// Verify the collector released its process lock before removing/replacing
/// its service files. Absence in the service manager alone can be asynchronous.
pub fn wait_for_daemon_exit(directory: &Path) -> io::Result<()> {
    let lock = match OpenOptions::new()
        .read(true)
        .open(directory.join("daemon.lock"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let started = Instant::now();
    loop {
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::WouldBlock {
            return Err(error);
        }
        if started.elapsed() > Duration::from_secs(10) {
            return Err(io::Error::other("agent_stop_unverified"));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

pub fn install(executable: &Path, directory: &Path) -> io::Result<Value> {
    let activated_at = now_ms();
    let default = home_dir().join(".local/bin/shellbeam-agent");
    // Lifecycle never writes system directories or modifies another account.
    if executable != default {
        return Err(io::Error::other("install_path_must_be_user_default"));
    }
    private_dir(directory)?;
    private_dir(
        executable
            .parent()
            .ok_or_else(|| io::Error::other("path_invalid"))?,
    )?;
    let source = std::env::current_exe()?;
    if source.canonicalize()? != executable.canonicalize().unwrap_or_default() {
        fs::copy(&source, executable)?;
    }
    fs::set_permissions(executable, fs::Permissions::from_mode(0o755))?;
    let unit = unit_path();
    private_dir(
        unit.parent()
            .ok_or_else(|| io::Error::other("path_invalid"))?,
    )?;
    // Service files include no environment, tokens or SSH credentials.
    fs::write(&unit, service_definition(executable, directory)?)?;
    fs::set_permissions(&unit, fs::Permissions::from_mode(0o600))?;
    if cfg!(target_os = "macos") {
        service("stop")?;
        wait_for_daemon_exit(directory)?;
        service("start")?;
    } else {
        checked_command("/usr/bin/systemctl", &["--user", "daemon-reload"])?;
        checked_command(
            "/usr/bin/systemctl",
            &["--user", "enable", "--now", "shellbeam-agent.service"],
        )?;
        service("restart")?;
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        if let Ok(status) = probe(directory) {
            if status["lastHeartbeatAt"].as_u64().unwrap_or(0) >= activated_at
                && status["health"] == "online"
                && status["version"] == VERSION
            {
                return Ok(status);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(io::Error::other("agent_activation_unverified"))
}
pub fn uninstall(executable: &Path, directory: &Path, purge: bool) -> io::Result<Value> {
    if executable != home_dir().join(".local/bin/shellbeam-agent") {
        return Err(io::Error::other("install_path_must_be_user_default"));
    }
    // Fail closed: never remove an executable while the service might still be running.
    service("stop")?;
    wait_for_daemon_exit(directory)?;
    if !cfg!(target_os = "macos") {
        checked_command(
            "/usr/bin/systemctl",
            &["--user", "disable", "shellbeam-agent.service"],
        )?;
    }
    let unit = unit_path();
    if unit.exists() {
        fs::remove_file(&unit)?;
    }
    if !cfg!(target_os = "macos") {
        checked_command("/usr/bin/systemctl", &["--user", "daemon-reload"])?;
    }
    if executable.exists() {
        fs::remove_file(executable)?;
    }
    if purge {
        let expected = home_dir().join(".local/share/shellbeam-agent");
        if directory != expected {
            return Err(io::Error::other("purge_path_invalid"));
        }
        if directory.exists() {
            fs::remove_dir_all(directory)?;
        }
    }
    if executable.exists() || unit.exists() {
        return Err(io::Error::other("uninstall_unverified"));
    }
    Ok(
        json!({"status":"retired","health":"unknown","version":VERSION,"capabilities":[],"serviceName":"shellbeam-agent","dataRetained":!purge}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "shellbeam-agent-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn collects_real_values_without_filling_unknowns_with_zero() {
        let value = collect();
        assert_eq!(value["status"], "installed");
        assert!(value["metrics"]["memoryTotalBytes"].as_u64().unwrap() > 0);
        assert!(value["metrics"]["diskTotalBytes"].as_u64().unwrap() > 0);
        assert!(value["inventory"]["resource"]["hostname"].is_string());
        assert_eq!(
            value["inventory"]["resource"]["arch"],
            std::env::consts::ARCH
        );
        assert!(value["metrics"]["latencyMs"].is_null());
    }
    #[test]
    fn history_is_bounded_and_survives_reopening() {
        let directory = temporary("history");
        for index in 0..8 {
            append_history(&directory, &json!({"sequence":index}), 3, 2048).unwrap();
        }
        let values = history(&directory, 100).unwrap();
        assert_eq!(values.as_array().unwrap().len(), 3);
        assert_eq!(values[0]["sequence"], 5);
        assert_eq!(
            fs::metadata(directory.join("history.jsonl"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(directory).unwrap();
    }
    fn history_point(agent_id: &str, sampled_at: u64) -> Value {
        json!({"schemaVersion":1,"agentId":agent_id,"sampledAt":sampled_at,
            "metrics":{"sampledAt":sampled_at,"cpuPercent":12,"memoryPercent":null}})
    }
    fn paging_directory(name: &str) -> (PathBuf, String) {
        let directory = temporary(name);
        let agent_id = persistent_agent_id(&directory).unwrap();
        (directory, agent_id)
    }
    #[test]
    fn history_pages_sort_before_limiting_with_a_fixed_through_snapshot() {
        let (directory, agent_id) = paging_directory("page-order");
        let mut lines = Vec::new();
        for sampled_at in [30, 10, 50, 20, 20, 40] {
            lines.push(history_point(&agent_id, sampled_at).to_string());
        }
        // Other installations and schema versions outside the requested
        // snapshot do not claim observations about this installation/window.
        lines.push(history_point("other-agent", 70).to_string());
        lines.push(json!({"schemaVersion":9,"sampledAt":80}).to_string());
        fs::write(directory.join("history.jsonl"), lines.join("\n")).unwrap();
        let first = history_page_at(&directory, &agent_id, 0, 35, 2, 35).unwrap();
        assert_eq!(first["nextCursor"], 20);
        assert_eq!(first["hasMore"], true);
        assert_eq!(first["points"][0], history_point(&agent_id, 10));
        assert_eq!(first["points"][1], history_point(&agent_id, 20));
        let second = history_page_at(&directory, &agent_id, 20, 35, 2, 35).unwrap();
        assert_eq!(second["nextCursor"], 30);
        assert_eq!(second["hasMore"], false);
        assert_eq!(second["points"], json!([history_point(&agent_id, 30)]));
        // Future records outside the earlier fixed snapshot remain available
        // when a later synchronization explicitly requests a newer through.
        let later = history_page_at(&directory, &agent_id, 30, 50, 2, 55).unwrap();
        assert_eq!(later["points"][0]["sampledAt"], 40);
        assert_eq!(later["nextCursor"], 50);
        let empty = history_page_at(&directory, &agent_id, 50, 60, 2, 60).unwrap();
        assert_eq!(empty["nextCursor"], 50);
        assert_eq!(empty["hasMore"], false);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn malformed_or_foreign_records_in_a_window_reject_the_whole_page_without_a_cursor() {
        let (directory, agent_id) = paging_directory("page-integrity");
        let mut mismatched = history_point(&agent_id, 20);
        mismatched["metrics"]["sampledAt"] = json!(99);
        let bad_rows = vec![
            "{broken".to_owned(),
            history_point(&agent_id, 0).to_string(),
            json!({"schemaVersion":2,"agentId":agent_id,"sampledAt":20,"metrics":{"sampledAt":20}})
                .to_string(),
            json!({"agentId":agent_id,"sampledAt":20}).to_string(),
            json!({"sampledAt":20,"schemaVersion":1,"metrics":{"sampledAt":20}}).to_string(),
            mismatched.to_string(),
        ];
        for bad in bad_rows {
            fs::write(
                directory.join("history.jsonl"),
                format!(
                    "{}\n{bad}\n{}\n",
                    history_point(&agent_id, 10),
                    history_point(&agent_id, 30)
                ),
            )
            .unwrap();
            // Even limit=1 must not return the valid first point with a cursor
            // that could eventually skip a known corrupt sample in the window.
            assert_eq!(
                history_page_at(&directory, &agent_id, 0, 30, 1, 30)
                    .unwrap_err()
                    .to_string(),
                "history_page_record_invalid"
            );
        }
        fs::write(
            directory.join("history.jsonl"),
            format!(
                "{}\n{}\n{}\n",
                history_point(&agent_id, 10),
                history_point("foreign-agent", 20),
                history_point(&agent_id, 30)
            ),
        )
        .unwrap();
        assert_eq!(
            history_page_at(&directory, &agent_id, 0, 30, 1, 30)
                .unwrap_err()
                .to_string(),
            "history_page_foreign_identity"
        );
        fs::write(
            directory.join("history.jsonl"),
            format!(
                "{}\n{}\n",
                history_point(&agent_id, 10),
                history_point(&agent_id, 40)
            ),
        )
        .unwrap();
        assert_eq!(
            history_page_at(&directory, &agent_id, 0, 50, 1, 30)
                .unwrap_err()
                .to_string(),
            "history_page_future_sample"
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn history_page_bytes_are_bounded_without_skipping_a_large_sample() {
        let (directory, agent_id) = paging_directory("page-size");
        let shared: Value =
            serde_json::from_str(include_str!("../../shared/collection-limits.json")).unwrap();
        let page_bytes = history_protocol_limits().page_bytes;
        assert!(page_bytes < shared["remote"]["outputBytes"].as_u64().unwrap() as usize);
        for sampled_at in 1..=3 {
            let mut point = history_point(&agent_id, sampled_at);
            point["padding"] = json!("x".repeat(80 * 1024));
            append_history(&directory, &point, 10, HISTORY_MAX_BYTES).unwrap();
        }
        let page = history_page_at(&directory, &agent_id, 0, 3, 100, 3).unwrap();
        assert_eq!(page["nextCursor"], 2);
        assert_eq!(page["hasMore"], true);
        assert!(serde_json::to_vec(&page).unwrap().len() < page_bytes);
        let next = history_page_at(&directory, &agent_id, 2, 3, 100, 3).unwrap();
        assert_eq!(next["points"][0]["sampledAt"], 3);
        let mut huge = history_point(&agent_id, 4);
        huge["padding"] = json!("x".repeat(page_bytes));
        append_history(&directory, &huge, 10, HISTORY_MAX_BYTES).unwrap();
        assert_eq!(
            history_page_at(&directory, &agent_id, 3, 4, 100, 4)
                .unwrap_err()
                .to_string(),
            "history_page_sample_size_exceeded"
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn history_page_requires_matching_identity_valid_ranges_and_one_same_timestamp_record() {
        let (directory, agent_id) = paging_directory("page-scope");
        let first = history_point(&agent_id, 10);
        let mut duplicate = first.clone();
        duplicate["metrics"]["cpuPercent"] = json!(99);
        append_history(&directory, &first, 10, HISTORY_MAX_BYTES).unwrap();
        append_history(&directory, &duplicate, 10, HISTORY_MAX_BYTES).unwrap();
        let page = history_page_at(&directory, &agent_id, 0, 10, 1, 10).unwrap();
        assert_eq!(page["points"], json!([first]));
        assert_eq!(page["hasMore"], false);
        assert!(history_page_at(&directory, "foreign-agent", 0, 10, 1, 10).is_err());
        for (after, through, limit) in [(11, 10, 1), (0, u64::MAX, 1), (0, 10, 0), (0, 10, 101)] {
            assert!(history_page_at(&directory, &agent_id, after, through, limit, 10).is_err());
        }
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn history_page_rejects_a_spool_exceeding_record_or_byte_budgets() {
        let (directory, agent_id) = paging_directory("page-corrupt-budget");
        // Even repeated rows count toward scan work: a corrupt spool must not
        // allocate unbounded parsed records or hide later rows behind a limit.
        fs::write(
            directory.join("history.jsonl"),
            format!("{}\n", history_point(&agent_id, 10)).repeat(HISTORY_LIMIT + 1),
        )
        .unwrap();
        assert_eq!(
            history_page_at(&directory, &agent_id, 0, 100, 1, 100)
                .unwrap_err()
                .to_string(),
            "history_record_limit_exceeded"
        );
        let file = File::create(directory.join("history.jsonl")).unwrap();
        file.set_len(HISTORY_MAX_BYTES as u64 + 1).unwrap();
        assert_eq!(
            history_page_at(&directory, &agent_id, 0, 100, 1, 100)
                .unwrap_err()
                .to_string(),
            "history_size_exceeded"
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn installation_identity_migrates_once_and_survives_hostname_status_changes() {
        let directory = temporary("identity");
        atomic_json(
            &directory.join("status.json"),
            &json!({"agentId":"legacy-hostname-id"}),
        )
        .unwrap();
        assert_eq!(
            persistent_agent_id(&directory).unwrap(),
            "legacy-hostname-id"
        );
        atomic_json(
            &directory.join("status.json"),
            &json!({"agentId":"changed-hostname-id"}),
        )
        .unwrap();
        assert_eq!(
            persistent_agent_id(&directory).unwrap(),
            "legacy-hostname-id"
        );
        assert_eq!(
            fs::metadata(directory.join("identity.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        atomic_json(&directory.join("identity.json"), &json!({"agentId":""})).unwrap();
        assert!(persistent_agent_id(&directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn stale_or_missing_heartbeat_is_never_online() {
        let directory = temporary("stale");
        atomic_json(
            &directory.join("status.json"),
            &json!({"health":"online","lastHeartbeatAt":1,"heartbeatTtlMs":3}),
        )
        .unwrap();
        assert_eq!(probe(&directory).unwrap()["health"], "offline");
        atomic_json(
            &directory.join("status.json"),
            &json!({"health":"online","lastHeartbeatAt":now_ms()+60000,"heartbeatTtlMs":180000}),
        )
        .unwrap();
        assert_eq!(probe(&directory).unwrap()["health"], "unknown");
        atomic_json(&directory.join("status.json"), &json!({"health":"online"})).unwrap();
        assert_eq!(probe(&directory).unwrap()["health"], "unknown");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn user_service_has_no_credentials_or_privileged_install() {
        let unit = service_definition(
            Path::new("/home/ops/.local/bin/shellbeam-agent"),
            Path::new("/home/ops/.local/share/shellbeam-agent"),
        )
        .unwrap();
        assert!(unit.contains("daemon"));
        assert!(!unit.contains("sudo"));
        assert!(!unit.contains("Environment="));
        assert!(service_definition(Path::new("/tmp/bad%path"), Path::new("/tmp/state")).is_err());
    }
    #[test]
    fn startup_cleanup_removes_only_own_orphaned_atomic_writes() {
        let directory = temporary("temps");
        for name in ["history.999.tmp", "status.111.tmp", "keep.tmp"] {
            fs::write(directory.join(name), b"retained").unwrap();
        }
        cleanup_stale_temps(&directory).unwrap();
        assert!(!directory.join("history.999.tmp").exists());
        assert!(!directory.join("status.111.tmp").exists());
        assert!(directory.join("keep.tmp").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
