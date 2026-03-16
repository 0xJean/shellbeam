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
CPU=$(LANG=C top -bn1 2>/dev/null | awk -F"id," '"'"'/Cpu\\(s\\)/ {split($1,a,","); gsub(/[^0-9.]/,"",a[length(a)]); if (a[length(a)] != "") print int(100-a[length(a)])}'"'"' | head -n1)
if [ -z "$CPU" ]; then CPU=$(vmstat 1 2 2>/dev/null | tail -1 | awk '"'"'{print 100-$15}'"'"'); fi
MEM=$(free 2>/dev/null | awk '"'"'/Mem:/ {printf "%d", ($3/$2)*100}'"'"')
DISK=$(df -P / 2>/dev/null | awk '"'"'NR==2 {gsub(/%/,"",$5); print $5}'"'"')
read RX1 TX1 < <(awk '"'"'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx, tx}'"'"' /proc/net/dev 2>/dev/null)
sleep 1
read RX2 TX2 < <(awk '"'"'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx, tx}'"'"' /proc/net/dev 2>/dev/null)
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

  return parseWorkspaceMetrics([result.stdout, result.stderr].filter(Boolean).join('\n'))
}
