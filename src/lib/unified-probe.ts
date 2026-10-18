import type { VerifiedHostKey } from './sessions'
import collectorScript from '../../shared/probe-collector.sh?raw'
import type { ServerMonitorSnapshot } from './server-monitor'
import type { WorkspaceInventory } from './workspace-inventory'
import type { HostProfile } from './hosts'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { normalizeWorkspaceInventory } from './workspace-projects'

export const UNIFIED_PROBE_SCHEMA_VERSION = 1
export const UNIFIED_PROBE_OUTPUT_LIMIT = 256 * 1024
export function buildUnifiedProbeCommand(section: 'metrics' | 'inventory' | 'all' = 'all') {
  if (!['metrics', 'inventory', 'all'].includes(section)) throw new Error('PROBE_SECTION_INVALID')
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  return `sh -c ${quote(collectorScript)} shellbeam-probe ${section}`
}
export interface UnifiedProbeResult {
  verifiedHostKeys?: VerifiedHostKey[]
  metrics: ServerMonitorSnapshot
  inventory: WorkspaceInventory
  capacity: Record<string, unknown>
  filesystems: Array<Record<string, unknown>>
  inodes: Array<Record<string, unknown>>
  listeningPorts: string[]
}
const number = (value: string | undefined) => value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
const percent = (value: number | null) => value === null ? null : Math.min(100, Math.max(0, value))
const clean = (value: string | undefined) => (value ?? '').replace(/^"|"$/g, '').slice(0, 1024)
export function parseUnifiedProbeOutput(output: string, receivedAt = Date.now()): UnifiedProbeResult {
  if (new TextEncoder().encode(output).byteLength > UNIFIED_PROBE_OUTPUT_LIMIT) throw new Error('PROBE_OUTPUT_LIMIT')
  const lines = output.split(/\r?\n/)
  if (!lines.includes('__SB_PROBE_BEGIN') || !lines.includes('__SB_PROBE_END') || !lines.includes('__SB_PROBE_SCHEMA=1')) throw new Error('PROBE_INCOMPLETE')
  const capacity: Record<string, unknown> = {}
  const filesystems: Array<Record<string, unknown>> = []
  const inodes: Array<Record<string, unknown>> = []
  const listeningPorts: string[] = []
  const tools: WorkspaceInventory['tools'] = []
  const services = new Map<string, WorkspaceInventory['services'][number]>()
  const containers: WorkspaceInventory['containers'] = []
  const projects: WorkspaceInventory['projects'] = []
  const pm2: WorkspaceInventory['pm2'] = []
  let sampledAt: number | null = null
  for (const line of lines) {
    const match = line.match(/^__SB_PROBE_([A-Z_]+)=(.*)$/)
    if (!match) continue
    const [, key, raw] = match
    const value = clean(raw)
    const parts = value.split(/\s+/)
    if (key === 'SAMPLED_AT') { const stamp = number(value); if (stamp && stamp <= receivedAt) sampledAt = stamp; continue }
    if (['ARCH', 'HOSTNAME', 'OS', 'KERNEL'].includes(key)) { capacity[key.toLowerCase()] = value; continue }
    if (key === 'CPU') { capacity.cpuPercent = percent(number(value)); continue }
    if (key === 'CORES' || key === 'UPTIME') { capacity[key === 'CORES' ? 'cpuCores' : 'uptimeSeconds'] = number(value); continue }
    if (key === 'LOAD') { capacity.load = parts.slice(0, 3).map(number); continue }
    if (key === 'NETWORK') { capacity.networkRxBytesPerSec = number(parts[0]); capacity.networkTxBytesPerSec = number(parts[1]); continue }
    if (key === 'MEM') {
      const field = ({ 'MemTotal:': 'memoryTotalBytes', 'MemAvailable:': 'memoryAvailableBytes', 'SwapTotal:': 'swapTotalBytes', 'SwapFree:': 'swapFreeBytes' } as Record<string, string>)[parts[0]]
      const amount = number(parts[1]); if (field) capacity[field] = amount === null ? null : amount * 1024
      continue
    }
    if ((key === 'DISK' || key === 'INODE') && parts.length >= 6 && number(parts[1]) !== null) {
      const multiplier = key === 'DISK' ? 1024 : 1
      const amount = (index: number) => { const value = number(parts[index]); return value === null ? null : value * multiplier }
      const rows = key === 'DISK' ? filesystems : inodes
      if (rows.length < 100) rows.push({ device: parts[0], total: amount(1), used: amount(2), available: amount(3), usedPercent: percent(number(parts[4].replace('%', ''))), mount: parts.slice(5).join(' '), unit: key === 'DISK' ? 'bytes' : 'inodes' })
      continue
    }
    if (key === 'PORT' && listeningPorts.length < 200) listeningPorts.push(value)
    if (key === 'TOOLDETAIL' && tools.length < 100) { const [id, name, category, binary, path, version = ''] = value.split('|'); if (id && name) tools.push({ id, name, category, binary, path, version }) }
    if (key === 'SERVICE' && services.size < 200) { const [name, , active] = parts; if (name) services.set(name, { name, active: active ?? 'unknown', enabled: 'unknown' }) }
    if (key === 'SERVICEDETAIL') { const [name, active, enabled] = value.split('|'); if (name) services.set(name, { name, active: active || 'unknown', enabled: enabled || 'unknown' }) }
    if (key === 'DOCKERDETAIL' && containers.length < 100) { const [name, image, status, ports = ''] = value.split('|'); if (name) containers.push({ name, image, status, ports }) }
    if (key === 'PROJECTDETAIL' && projects.length < 100) { const [path, kind, name, modifiedAt = ''] = value.split('|'); if (path) projects.push({ path, kind, name, modifiedAt }) }
    if (key === 'PM2' && pm2.length < 25) pm2.push({ raw: value })
  }
  if (sampledAt === null) throw new Error('PROBE_INVALID_SAMPLE_TIME')
  const capacityNumber = (key: string) => typeof capacity[key] === 'number' ? capacity[key] as number : null
  const memoryTotal = capacityNumber('memoryTotalBytes')
  const memoryAvailable = capacityNumber('memoryAvailableBytes')
  const memoryUsed = memoryTotal !== null && memoryAvailable !== null ? Math.max(0, memoryTotal - memoryAvailable) : null
  const load = capacity.load as Array<number | null> | undefined
  const root = filesystems.find((disk) => disk.mount === '/')
  const metrics: ServerMonitorSnapshot = {
    hostname: clean(capacity.hostname as string), os: clean(capacity.os as string), kernel: clean(capacity.kernel as string),
    uptimeSeconds: capacityNumber('uptimeSeconds'), cpuPercent: capacityNumber('cpuPercent'), load1: load?.[0] ?? null, load5: load?.[1] ?? null, load15: load?.[2] ?? null,
    memoryUsedBytes: memoryUsed, memoryTotalBytes: memoryTotal, memoryPercent: memoryUsed !== null && memoryTotal ? percent(memoryUsed / memoryTotal * 100) : null,
    diskUsedBytes: root?.used as number | null ?? null, diskTotalBytes: root?.total as number | null ?? null, diskPercent: root?.usedPercent as number | null ?? null,
    networkRxBytesPerSec: capacityNumber('networkRxBytesPerSec'), networkTxBytesPerSec: capacityNumber('networkTxBytesPerSec'), latencyMs: null, sampledAt,
  }
  const inventory = normalizeWorkspaceInventory({
    resource: { hostname: metrics.hostname, os: metrics.os, kernel: metrics.kernel, uptime: metrics.uptimeSeconds === null ? '' : `${metrics.uptimeSeconds}s`, cpuPercent: metrics.cpuPercent, memoryPercent: metrics.memoryPercent, memoryText: memoryUsed === null || memoryTotal === null ? '' : `${memoryUsed}/${memoryTotal} B`, diskPercent: metrics.diskPercent, diskText: metrics.diskUsedBytes === null || metrics.diskTotalBytes === null ? '' : `${metrics.diskUsedBytes}/${metrics.diskTotalBytes} B`, network: metrics.networkRxBytesPerSec === null || metrics.networkTxBytesPerSec === null ? '' : `${metrics.networkRxBytesPerSec}/${metrics.networkTxBytesPerSec} B/s` },
    tools, services: [...services.values()], containers, projects, pm2, scannedAt: sampledAt, listeningPorts, filesystems, inodes,
  })
  return { metrics, inventory, capacity, filesystems, inodes, listeningPorts }
}

export async function fetchUnifiedProbe(options: { vaultId?: string; host: HostProfile; resolveAuthSecret: (host: HostProfile) => Promise<string>; section?: 'metrics' | 'inventory' | 'all' }): Promise<UnifiedProbeResult> {
  const result = await runWorkspaceRemoteCommand({ ...options, command: buildUnifiedProbeCommand(options.section ?? 'all'), audit: { action: 'probe.collect', target: `host ${options.section ?? 'metrics and inventory'}` } })
  if (result.exitCode !== 0) throw new Error(result.errorCode || result.errorType || 'PROBE_COLLECTION_FAILED')
  let parsed: UnifiedProbeResult
  if (!result.stdout.includes('__SB_PROBE_') && /__SB_(?:MON_|HOSTNAME=|TOOL=|PROJECT=)/.test(result.stdout)) {
    // Older exported collector responses remain readable during migration;
    // a truncated versioned frame never enters this compatibility path.
    const [{ parseServerMonitorOutput }, { parseWorkspaceInventory }] = await Promise.all([import('./server-monitor'), import('./workspace-inventory')])
    const metrics = parseServerMonitorOutput(result.stdout)
    const inventory = parseWorkspaceInventory(result.stdout)
    if (!result.stdout.includes('__SB_MON_')) {
      Object.assign(metrics, { hostname: inventory.resource.hostname, os: inventory.resource.os, kernel: inventory.resource.kernel, cpuPercent: inventory.resource.cpuPercent, memoryPercent: inventory.resource.memoryPercent, diskPercent: inventory.resource.diskPercent })
    }
    parsed = { metrics, inventory, capacity: {}, filesystems: [], inodes: [], listeningPorts: [] }
  } else parsed = parseUnifiedProbeOutput(result.stdout)
  parsed.verifiedHostKeys = result.verifiedHostKeys
  parsed.metrics.latencyMs = result.durationMs
  return parsed
}
