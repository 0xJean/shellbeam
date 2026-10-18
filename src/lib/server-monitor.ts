import type { HostProfile } from '@/lib/hosts'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { invoke } from '@tauri-apps/api/core'
import { buildUnifiedProbeCommand, parseUnifiedProbeOutput } from './unified-probe'
import type { ProbeProviderTelemetry } from './probe-provider'

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
  /** Collection diagnostics from the shared ProbeProvider scheduler. */
  probeTelemetry?: ProbeProviderTelemetry | null
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

export const SERVER_MONITOR_COMMAND = buildUnifiedProbeCommand('metrics')

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
  if (output.includes('__SB_PROBE_BEGIN')) return parseUnifiedProbeOutput(output, sampledAt).metrics
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
  vaultId?: string
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  const result = await runWorkspaceRemoteCommand({
    host: options.host,
    resolveAuthSecret: options.resolveAuthSecret,
    command: SERVER_MONITOR_COMMAND,
    audit: { action: 'probe.metrics', target: 'host metrics' },
    vaultId: options.vaultId,
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
