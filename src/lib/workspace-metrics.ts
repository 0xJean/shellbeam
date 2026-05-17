import type { HostProfile } from '@/lib/hosts'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'

export interface WorkspaceMetrics {
  cpu: string
  memory: string
  disk: string
  network: string
}

export const DEFAULT_WORKSPACE_METRICS: WorkspaceMetrics = {
  cpu: '',
  memory: '',
  disk: '',
  network: '',
}

export const WORKSPACE_METRICS_COMMAND = `bash -lc '
DISK=$(df -P / 2>/dev/null | awk '"'"'NR==2 {gsub(/%/,"",$5); print $5}'"'"')
read CPU_USER1 CPU_NICE1 CPU_SYSTEM1 CPU_IDLE1 CPU_IOWAIT1 CPU_IRQ1 CPU_SOFTIRQ1 CPU_STEAL1 < <(awk '"'"'/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9; exit}'"'"' /proc/stat 2>/dev/null)
read RX1 TX1 < <(awk '"'"'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx, tx}'"'"' /proc/net/dev 2>/dev/null)
sleep 1
read CPU_USER2 CPU_NICE2 CPU_SYSTEM2 CPU_IDLE2 CPU_IOWAIT2 CPU_IRQ2 CPU_SOFTIRQ2 CPU_STEAL2 < <(awk '"'"'/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9; exit}'"'"' /proc/stat 2>/dev/null)
read RX2 TX2 < <(awk '"'"'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx, tx}'"'"' /proc/net/dev 2>/dev/null)
CPU=$(awk \\
  -v u1="$CPU_USER1" -v n1="$CPU_NICE1" -v s1="$CPU_SYSTEM1" -v i1="$CPU_IDLE1" -v w1="$CPU_IOWAIT1" -v q1="$CPU_IRQ1" -v r1="$CPU_SOFTIRQ1" -v t1="$CPU_STEAL1" \\
  -v u2="$CPU_USER2" -v n2="$CPU_NICE2" -v s2="$CPU_SYSTEM2" -v i2="$CPU_IDLE2" -v w2="$CPU_IOWAIT2" -v q2="$CPU_IRQ2" -v r2="$CPU_SOFTIRQ2" -v t2="$CPU_STEAL2" \\
  '"'"'BEGIN {
    total1=u1+n1+s1+i1+w1+q1+r1+t1; idle1=i1+w1;
    total2=u2+n2+s2+i2+w2+q2+r2+t2; idle2=i2+w2;
    diff=total2-total1; idleDiff=idle2-idle1;
    if (diff > 0) {
      value=(diff-idleDiff) * 100 / diff;
      if (value < 0) value=0;
      if (value > 100) value=100;
      printf "%d", value + 0.5;
    }
  }'"'"')
if [ -z "$CPU" ]; then CPU=$(LANG=C top -bn1 2>/dev/null | awk -F"id," '"'"'/Cpu\\(s\\)|%Cpu/ {split($1,a,","); gsub(/[^0-9.]/,"",a[length(a)]); if (a[length(a)] != "") print int(100-a[length(a)])}'"'"' | head -n1); fi
if [ -z "$CPU" ]; then CPU=$(vmstat 1 2 2>/dev/null | tail -1 | awk '"'"'{print 100-$15}'"'"'); fi
MEM=$(awk '"'"'
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
      printf "%d", (used/total)*100;
    }
  }'"'"' /proc/meminfo 2>/dev/null)
if [ -z "$MEM" ]; then MEM=$(free 2>/dev/null | awk '"'"'/Mem:/ {printf "%d", ($3/$2)*100}'"'"'); fi
NET=$(awk -v rx1="$RX1" -v rx2="$RX2" -v tx1="$TX1" -v tx2="$TX2" '"'"'BEGIN {printf "%.1f KB/s", ((rx2-rx1)+(tx2-tx1))/1024}'"'"')
echo "cpu:$CPU"
echo "memory:$MEM"
echo "disk:$DISK"
echo "network:$NET"
'`

export function parseWorkspaceMetrics(output: string): WorkspaceMetrics {
  const values = { ...DEFAULT_WORKSPACE_METRICS }

  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [key, ...rest] = line.split(':')
      const value = rest.join(':').trim()
      if (key === 'cpu') values.cpu = value
      if (key === 'memory') values.memory = value
      if (key === 'disk') values.disk = value
      if (key === 'network') values.network = value
    })

  return values
}

export function resolveWorkspaceMetricsHost(
  hosts: HostProfile[],
  options: { selectedHostId?: string | null; hostAddress?: string | null },
) {
  return resolveWorkspaceHost(hosts, options)
}

function buildWorkspaceMetricsError(result: { stderr?: string; exitCode?: number; errorType?: string; errorCode?: string }) {
  const message = result.stderr?.trim()
    || result.errorCode
    || result.errorType
    || `metrics command failed with exit code ${result.exitCode ?? 'unknown'}`
  return new Error(message)
}

export async function fetchWorkspaceMetrics(options: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  const { host, resolveAuthSecret } = options
  const result = await runWorkspaceRemoteCommand({
    host,
    resolveAuthSecret,
    command: WORKSPACE_METRICS_COMMAND,
  })
  if (result.exitCode !== 0) {
    throw buildWorkspaceMetricsError(result)
  }

  return parseWorkspaceMetrics([result.stdout, result.stderr].filter(Boolean).join('\n'))
}
