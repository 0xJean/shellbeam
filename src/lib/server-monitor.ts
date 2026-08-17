import type { HostProfile } from '@/lib/hosts'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { invoke } from '@tauri-apps/api/core'

export type ServerMonitorStatus = 'checking' | 'online' | 'stale' | 'offline' | 'paused'

export interface ServerMonitorSnapshot {
  hostname: string
  os: string
  kernel: string
  uptimeSeconds: number | null
  cpuPercent: number | null
  load1: number | null
  load5: number | null
  load15: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
  memoryPercent: number | null
  diskUsedBytes: number | null
  diskTotalBytes: number | null
  diskPercent: number | null
  networkRxBytesPerSec: number | null
  networkTxBytesPerSec: number | null
  latencyMs: number | null
  sampledAt: number
}

export interface ServerMonitorLatest {
  hostKey: string
  hostId: string
  hostName: string
  hostAddress: string
  username: string
  port: number
  status: ServerMonitorStatus
  snapshot: ServerMonitorSnapshot | null
  lastAttemptAt: number
  lastSuccessAt: number | null
  error?: string
  updatedAt: number
}

export interface ServerMonitorHistoryPoint {
  hostKey: string
  sampledAt: number
  snapshot: ServerMonitorSnapshot
}

export interface ServerMonitorHistoryQuery {
  hostKey: string
  from?: number
  to?: number
}

const DEFAULT_SNAPSHOT: ServerMonitorSnapshot = {
  hostname: '',
  os: '',
  kernel: '',
  uptimeSeconds: null,
  cpuPercent: null,
  load1: null,
  load5: null,
  load15: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  memoryPercent: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
  diskPercent: null,
  networkRxBytesPerSec: null,
  networkTxBytesPerSec: null,
  latencyMs: null,
  sampledAt: 0,
}

const MONITOR_SCRIPT = `
sb_mon_clean() {
  tr '\\n|' '  ' | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c 1-240
}

sb_mon_emit() {
  printf '__SB_MON_%s=%s\\n' "$1" "$2"
}

hostname_value="$(hostname 2>/dev/null | sb_mon_clean)"
os_value="$(. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME" | sb_mon_clean)"
kernel_value="$(uname -sr 2>/dev/null | sb_mon_clean)"
uptime_value="$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)"
load_value="$(awk '{printf "%s|%s|%s", $1, $2, $3}' /proc/loadavg 2>/dev/null)"

read cpu_user1 cpu_nice1 cpu_system1 cpu_idle1 cpu_iowait1 cpu_irq1 cpu_softirq1 cpu_steal1 <<EOF
$(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat 2>/dev/null)
EOF
read rx1 tx1 <<EOF
$(awk 'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx+0, tx+0}' /proc/net/dev 2>/dev/null)
EOF
sleep 1
read cpu_user2 cpu_nice2 cpu_system2 cpu_idle2 cpu_iowait2 cpu_irq2 cpu_softirq2 cpu_steal2 <<EOF
$(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat 2>/dev/null)
EOF
read rx2 tx2 <<EOF
$(awk 'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx+0, tx+0}' /proc/net/dev 2>/dev/null)
EOF

cpu_value="$(awk \
  -v u1="$cpu_user1" -v n1="$cpu_nice1" -v s1="$cpu_system1" -v i1="$cpu_idle1" -v w1="$cpu_iowait1" -v q1="$cpu_irq1" -v r1="$cpu_softirq1" -v t1="$cpu_steal1" \
  -v u2="$cpu_user2" -v n2="$cpu_nice2" -v s2="$cpu_system2" -v i2="$cpu_idle2" -v w2="$cpu_iowait2" -v q2="$cpu_irq2" -v r2="$cpu_softirq2" -v t2="$cpu_steal2" \
  'BEGIN {
    total1=u1+n1+s1+i1+w1+q1+r1+t1; idle1=i1+w1;
    total2=u2+n2+s2+i2+w2+q2+r2+t2; idle2=i2+w2;
    diff=total2-total1; idleDiff=idle2-idle1;
    if (diff > 0) {
      value=(diff-idleDiff) * 100 / diff;
      if (value < 0) value=0;
      if (value > 100) value=100;
      printf "%.1f", value;
    }
  }')"

memory_value="$(awk '
  /^MemTotal:/ {total=$2}
  /^MemAvailable:/ {available=$2}
  /^MemFree:/ {free=$2}
  /^Buffers:/ {buffers=$2}
  /^Cached:/ {cached=$2}
  /^SReclaimable:/ {reclaim=$2}
  /^Shmem:/ {shmem=$2}
  END {
    if (total > 0) {
      if (available <= 0) available=free+buffers+cached+reclaim-shmem;
      used=total-available;
      if (used < 0) used=0;
      printf "%d|%d|%.1f", used*1024, total*1024, (used/total)*100;
    }
  }' /proc/meminfo 2>/dev/null)"

disk_value="$(df -Pk / 2>/dev/null | awk 'NR==2 {
  used=$3*1024; total=($2+0)*1024; percent=$5; gsub(/%/,"",percent);
  printf "%d|%d|%.1f", used, total, percent
}')"

network_value="$(awk -v rx1="$rx1" -v rx2="$rx2" -v tx1="$tx1" -v tx2="$tx2" 'BEGIN {
  printf "%.0f|%.0f", rx2-rx1, tx2-tx1
}')"

sb_mon_emit HOSTNAME "$hostname_value"
sb_mon_emit OS "$os_value"
sb_mon_emit KERNEL "$kernel_value"
sb_mon_emit UPTIME "$uptime_value"
sb_mon_emit LOAD "$load_value"
sb_mon_emit CPU "$cpu_value"
sb_mon_emit MEMORY "$memory_value"
sb_mon_emit DISK "$disk_value"
sb_mon_emit NETWORK "$network_value"
`.trim()

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const SERVER_MONITOR_COMMAND = `bash -lc ${shellQuote(MONITOR_SCRIPT)}`

function parseNumber(value: string | undefined) {
  if (!value?.trim()) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseNonNegativeNumber(value: string | undefined) {
  const parsed = parseNumber(value)
  return parsed === null ? null : Math.max(0, parsed)
}

function clampPercent(value: number | null) {
  if (value === null) return null
  return Math.max(0, Math.min(100, value))
}

function parseMarkerValue(line: string, marker: string) {
  return line.startsWith(`${marker}=`) ? line.slice(marker.length + 1).trim() : null
}

function parseDelimitedNumbers(
  value: string | null,
  count: number,
  parser: (part: string | undefined) => number | null = parseNumber,
) {
  if (value === null) return Array.from({ length: count }, () => null)
  const parts = value.split('|')
  return Array.from({ length: count }, (_, index) => parser(parts[index]))
}

export function parseServerMonitorOutput(output: string, sampledAt = Date.now()): ServerMonitorSnapshot {
  const snapshot = { ...DEFAULT_SNAPSHOT, sampledAt }

  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const hostname = parseMarkerValue(line, '__SB_MON_HOSTNAME')
      if (hostname !== null) {
        snapshot.hostname = hostname
        return
      }

      const os = parseMarkerValue(line, '__SB_MON_OS')
      if (os !== null) {
        snapshot.os = os
        return
      }

      const kernel = parseMarkerValue(line, '__SB_MON_KERNEL')
      if (kernel !== null) {
        snapshot.kernel = kernel
        return
      }

      const uptime = parseMarkerValue(line, '__SB_MON_UPTIME')
      if (uptime !== null) {
        snapshot.uptimeSeconds = parseNonNegativeNumber(uptime)
        return
      }

      const load = parseDelimitedNumbers(
        parseMarkerValue(line, '__SB_MON_LOAD'),
        3,
        parseNonNegativeNumber,
      )
      if (line.startsWith('__SB_MON_LOAD=')) {
        snapshot.load1 = load[0]
        snapshot.load5 = load[1]
        snapshot.load15 = load[2]
        return
      }

      const cpu = parseMarkerValue(line, '__SB_MON_CPU')
      if (cpu !== null) {
        snapshot.cpuPercent = clampPercent(parseNumber(cpu))
        return
      }

      const memory = parseDelimitedNumbers(parseMarkerValue(line, '__SB_MON_MEMORY'), 3)
      if (line.startsWith('__SB_MON_MEMORY=')) {
        const [memoryUsedBytes, memoryTotalBytes] = parseDelimitedNumbers(
          parseMarkerValue(line, '__SB_MON_MEMORY'),
          3,
          parseNonNegativeNumber,
        )
        snapshot.memoryUsedBytes = memoryUsedBytes
        snapshot.memoryTotalBytes = memoryTotalBytes
        snapshot.memoryPercent = clampPercent(memory[2])
        return
      }

      const disk = parseDelimitedNumbers(
        parseMarkerValue(line, '__SB_MON_DISK'),
        3,
        parseNonNegativeNumber,
      )
      if (line.startsWith('__SB_MON_DISK=')) {
        snapshot.diskUsedBytes = disk[0]
        snapshot.diskTotalBytes = disk[1]
        snapshot.diskPercent = clampPercent(disk[2])
        return
      }

      const network = parseDelimitedNumbers(
        parseMarkerValue(line, '__SB_MON_NETWORK'),
        2,
        parseNonNegativeNumber,
      )
      if (line.startsWith('__SB_MON_NETWORK=')) {
        snapshot.networkRxBytesPerSec = network[0]
        snapshot.networkTxBytesPerSec = network[1]
      }
    })

  return snapshot
}

export function isUsableServerMonitorSnapshot(snapshot: ServerMonitorSnapshot) {
  return Boolean(
    snapshot.uptimeSeconds !== null
      || snapshot.cpuPercent !== null
      || snapshot.memoryPercent !== null
      || snapshot.diskPercent !== null
      || snapshot.load1 !== null,
  )
}

export function getServerMonitorHostKey(host: Pick<HostProfile, 'id' | 'address' | 'port' | 'username'>) {
  return host.id || `${host.username}@${host.address}:${host.port || 22}`
}

export async function fetchServerMonitorSnapshot(options: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  const result = await runWorkspaceRemoteCommand({
    host: options.host,
    resolveAuthSecret: options.resolveAuthSecret,
    command: SERVER_MONITOR_COMMAND,
  })

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr?.trim()
        || result.errorCode
        || result.errorType
        || `server monitor command failed with exit code ${result.exitCode}`,
    )
  }

  const snapshot = parseServerMonitorOutput(
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
    Date.now(),
  )
  if (!isUsableServerMonitorSnapshot(snapshot)) {
    throw new Error('server monitor returned no usable Linux metrics')
  }

  snapshot.latencyMs = result.durationMs
  return snapshot
}

export async function listServerMonitorLatest() {
  return invoke<ServerMonitorLatest[]>('list_server_monitor_latest')
}

export async function listServerMonitorHistory(query: ServerMonitorHistoryQuery) {
  return invoke<ServerMonitorHistoryPoint[]>('list_server_monitor_history', { query })
}

export async function saveServerMonitorResult(payload: {
  latest: ServerMonitorLatest
  history?: ServerMonitorHistoryPoint
}) {
  return invoke<void>('save_server_monitor_result', { payload })
}

export async function deleteServerMonitorData(hostKey: string) {
  return invoke<void>('delete_server_monitor_data', { hostKey })
}

export async function clearServerMonitorData() {
  return invoke<void>('clear_server_monitor_data')
}
