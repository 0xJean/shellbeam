import { invoke } from '@tauri-apps/api/core'
import type { HostProfile } from './hosts'
import { operationTransport, type OperationJob, runConfirmedOperation } from './operation-job'
import type { ProbeCapability, ProbeProvider, ProbeProviderRef, ProbeSnapshot } from './probe-provider'
import { createProbeObservation, getProbeTransport } from './probe-provider'
import type { ServerMonitorSnapshot } from './server-monitor'
import type { WorkspaceInventory } from './workspace-inventory'
import { runWorkspaceRemoteCommand } from './workspace-remote'

export type ShellbeamAgentLifecycleStatus =
  | 'not-installed' | 'installing' | 'installed' | 'upgrading' | 'uninstalling'
  | 'offline' | 'unsupported' | 'unknown' | 'failed' | 'retired'
export type ShellbeamAgentInstallMethod = 'ssh-confirmed' | 'manual' | 'unknown'

/** Persisted lifecycle metadata only; credentials and command output never enter this shape. */
export interface ShellbeamAgentRecord {
  vaultId: string
  hostId: string
  agentId: string
  providerKind: string
  source: string
  status: ShellbeamAgentLifecycleStatus
  health: 'online' | 'stale' | 'offline' | 'unsupported' | 'unknown'
  version?: string | null
  capabilities: string[]
  installPath?: string | null
  serviceName?: string | null
  heartbeatTtlMs: number
  lastHeartbeatAt?: number | null
  lastCheckedAt: number
  installedAt?: number | null
  updatedAt: number
  lastErrorCode?: string | null
  lastError?: string | null
  transport: 'direct' | 'proxy-jump'
  installMethod?: ShellbeamAgentInstallMethod
}

export type ShellbeamAgentInput = Partial<ShellbeamAgentRecord> & Pick<ShellbeamAgentRecord, 'hostId' | 'status' | 'transport'>

export interface ShellbeamAgentCommandResult {
  record: ShellbeamAgentRecord
  snapshot?: ProbeSnapshot
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface ShellbeamAgentOperationResult {
  record: ShellbeamAgentRecord
  job: OperationJob
  commandResult?: ShellbeamAgentCommandResult
}

export interface ShellbeamAgentPlan {
  action: 'install' | 'upgrade' | 'uninstall' | 'check'
  command: string
  target: string
  risk: 'read-only' | 'low' | 'high'
  requiresConfirmation: boolean
  notes: string[]
}

export const SHELLBEAM_AGENT_DEFAULT_PATH = '$HOME/.local/bin/shellbeam-agent'
export const SHELLBEAM_AGENT_HEARTBEAT_TTL_MS = 5 * 60 * 1000
export const SHELLBEAM_AGENT_CHECK_COMMAND = `
if [ -x "$HOME/.local/bin/shellbeam-agent" ]; then
  "$HOME/.local/bin/shellbeam-agent" probe --json
elif command -v shellbeam-agent >/dev/null 2>&1; then
  shellbeam-agent probe --json
elif [ -f "$HOME/.local/share/shellbeam-agent/status.json" ]; then
  cat "$HOME/.local/share/shellbeam-agent/status.json"
else
  printf '%s\\n' '__SB_AGENT_STATUS=not-installed'
fi
`.trim()

const MAX_TEXT_LENGTH = 240
const MAX_CAPABILITIES = 24

function text(value: unknown, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null
  const normalized = [...value].map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function safeError(value: unknown) {
  const valueText = text(value)
  if (!valueText) return null
  return valueText.split(/\s+/).map((part) => {
    const lower = part.toLowerCase()
    return ['password', 'passwd', 'private_key', 'private-key', 'secret', 'token', 'credential', 'authorization', 'bearer'].some((needle) => lower.includes(needle)) ? '<redacted>' : part
  }).join(' ')
}

function safePath(value: unknown): string {
  const path = text(value, 180)
  // `$HOME` paths are expanded by the remote shell below. Restrict the path
  // before using double quotes so the expansion cannot introduce shell syntax.
  if (!path || !/^(?:\$HOME|\/usr\/local|\/opt)(?:\/[A-Za-z0-9._+@-]+)*$/.test(path)) return SHELLBEAM_AGENT_DEFAULT_PATH
  return path
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellPathArg(value: string) {
  const path = safePath(value)
  // Single quotes protect ordinary absolute paths. They would suppress
  // `$HOME` expansion, so the already constrained home-relative path uses
  // double quotes instead.
  return path.startsWith('$HOME') ? `"${path}"` : shellQuote(path)
}

function parseTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value >= 1_000_000_000 && value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return parseTimestamp(numeric)
    const date = Date.parse(value)
    if (Number.isFinite(date)) return date
  }
  return null
}

function normalizeStatus(value: unknown): ShellbeamAgentLifecycleStatus {
  const raw = text(value, 40)?.replace(/_/g, '-')
  const status = raw === 'uninstalled' ? 'retired' : raw
  const known: ShellbeamAgentLifecycleStatus[] = ['not-installed', 'installing', 'installed', 'upgrading', 'uninstalling', 'offline', 'unsupported', 'unknown', 'failed', 'retired']
  return known.includes(status as ShellbeamAgentLifecycleStatus) ? status as ShellbeamAgentLifecycleStatus : 'unknown'
}

function normalizeCapabilities(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return Array.from(new Set(values.map((entry) => text(entry, 64)).filter((entry): entry is string => Boolean(entry)))).slice(0, MAX_CAPABILITIES)
}

function normalizeHealth(value: unknown, status: ShellbeamAgentLifecycleStatus): ShellbeamAgentRecord['health'] {
  if (status === 'unsupported') return 'unsupported'
  if (status === 'offline') return 'offline'
  if (status !== 'installed') return 'unknown'
  const health = text(value, 24)
  if (health === 'online' || health === 'stale' || health === 'offline' || health === 'unsupported' || health === 'unknown') return health
  return 'unknown'
}

export function deriveShellbeamAgentHealth(record: Pick<ShellbeamAgentRecord, 'status' | 'lastHeartbeatAt' | 'heartbeatTtlMs'>, now = Date.now()) {
  if (record.status === 'unsupported') return 'unsupported' as const
  if (record.status === 'not-installed' || record.status === 'retired') return 'unknown' as const
  if (record.status !== 'installed') return record.status === 'offline' ? 'offline' as const : 'unknown' as const
  if (!record.lastHeartbeatAt || record.lastHeartbeatAt > now) return 'unknown' as const
  return now - record.lastHeartbeatAt <= record.heartbeatTtlMs ? 'online' as const : 'offline' as const
}

function refreshPersistedHealth(record: ShellbeamAgentRecord, now: number) {
  if (record.status !== 'installed' || record.health !== 'online' && record.health !== 'stale') return record
  // Restoring a cached heartbeat can only reduce confidence. A failed or
  // unknown daemon observation needs a new successful check to recover.
  const derived = deriveShellbeamAgentHealth(record, now)
  return derived === 'online' ? record : { ...record, health: derived }
}

export function normalizeShellbeamAgentRecord(input: Partial<ShellbeamAgentRecord> & Pick<ShellbeamAgentRecord, 'hostId' | 'status' | 'transport'>, now = Date.now()): ShellbeamAgentRecord {
  const status = normalizeStatus(input.status)
  const heartbeatTtlMs = Number.isFinite(input.heartbeatTtlMs) && Number(input.heartbeatTtlMs) > 0 ? Number(input.heartbeatTtlMs) : SHELLBEAM_AGENT_HEARTBEAT_TTL_MS
  const record: ShellbeamAgentRecord = {
    vaultId: text(input.vaultId, 160) ?? 'local',
    hostId: text(input.hostId, 160) ?? '',
    agentId: text(input.agentId, 160) ?? 'shellbeam-agent',
    providerKind: text(input.providerKind, 64) ?? 'shellbeam-agent',
    source: text(input.source, 64) ?? 'shellbeam-agent',
    status,
    health: 'unknown',
    version: text(input.version, 80),
    capabilities: normalizeCapabilities(input.capabilities),
    installPath: safePath(input.installPath),
    serviceName: text(input.serviceName, 120),
    heartbeatTtlMs,
    lastHeartbeatAt: parseTimestamp(input.lastHeartbeatAt),
    lastCheckedAt: parseTimestamp(input.lastCheckedAt) ?? now,
    installedAt: parseTimestamp(input.installedAt),
    updatedAt: parseTimestamp(input.updatedAt) ?? now,
    lastErrorCode: text(input.lastErrorCode, 80),
    lastError: safeError(input.lastError),
    transport: input.transport === 'proxy-jump' ? 'proxy-jump' : 'direct',
    installMethod: input.installMethod === 'ssh-confirmed' || input.installMethod === 'manual' ? input.installMethod : 'unknown',
  }
  record.health = normalizeHealth(input.health, status)
  if (input.health === undefined) record.health = deriveShellbeamAgentHealth(record, now)
  if (status === 'installed' && record.lastHeartbeatAt && record.lastHeartbeatAt > now) record.health = 'unknown'
  return record
}

export function parseShellbeamAgentProbeOutput(output: string, host: HostProfile, now = Date.now()): ShellbeamAgentRecord {
  const payload: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(output.trim()) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(payload, parsed)
  } catch {
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^__SB_AGENT_([A-Z_]+)=(.*)$/)
      if (!match) continue
      payload[match[1].toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = match[2]
    }
  }
  const status = normalizeStatus(payload.status ?? payload.lifecycle ?? payload.state)
  const lastHeartbeatAt = parseTimestamp(payload.lastHeartbeat ?? payload.lastHeartbeatAt ?? payload.heartbeat ?? payload.lastSeen)
  return normalizeShellbeamAgentRecord({
    vaultId: 'local', hostId: host.id, agentId: text(payload.agentId ?? payload.id, 160) ?? 'shellbeam-agent',
    providerKind: 'shellbeam-agent', source: 'shellbeam-agent', status,
    health: normalizeHealth(payload.health, status), version: text(payload.version, 80),
    capabilities: normalizeCapabilities(payload.capabilities), installPath: safePath(payload.installPath ?? payload.path),
    serviceName: text(payload.serviceName, 120), heartbeatTtlMs: Number(payload.heartbeatTtlMs) || SHELLBEAM_AGENT_HEARTBEAT_TTL_MS,
    lastHeartbeatAt, lastCheckedAt: now, lastErrorCode: text(payload.errorCode ?? payload.lastErrorCode, 80),
    lastError: safeError(payload.errorSummary ?? payload.error ?? payload.lastError), updatedAt: now,
    transport: getProbeTransport(host),
  }, now)
}

export function buildShellbeamAgentPlan(action: ShellbeamAgentPlan['action'], options: { installPath?: string; version?: string } = {}): ShellbeamAgentPlan {
  const installPath = safePath(options.installPath)
  const version = text(options.version, 48)
  if (action === 'check') return { action, command: SHELLBEAM_AGENT_CHECK_COMMAND, target: 'shellbeam-agent heartbeat', risk: 'read-only', requiresConfirmation: false, notes: ['Reads only agent probe output or the local status file.', 'A missing agent remains not-installed and does not change SSH health.'] }
  const command = action === 'uninstall'
    ? `${shellPathArg(installPath)} uninstall --json --path ${shellPathArg(installPath)}`
    : `${shellPathArg(installPath)} ${action} --json --path ${shellPathArg(installPath)}${version ? ` --version ${shellQuote(version)}` : ''}`
  return { action, command, target: `shellbeam-agent ${action}`, risk: 'high', requiresConfirmation: true, notes: ['Requires explicit confirmation and is recorded as an OperationJob.', 'Uses the existing SSH/ProxyJump transport without including Vault credentials.', 'A lost connection is recorded as unknown until a follow-up check confirms the state.'] }
}

function toInput(payload: ShellbeamAgentInput): Record<string, unknown> {
  const normalized = normalizeShellbeamAgentRecord(payload, Date.now())
  return {
    vaultId: normalized.vaultId, hostId: normalized.hostId, agentId: normalized.agentId,
    providerKind: normalized.providerKind, source: normalized.source, status: normalized.status,
    health: normalized.health, version: normalized.version, capabilities: normalized.capabilities,
    installPath: normalized.installPath, serviceName: normalized.serviceName, heartbeatTtlMs: normalized.heartbeatTtlMs,
    lastHeartbeatAt: normalized.lastHeartbeatAt, lastCheckedAt: normalized.lastCheckedAt, installedAt: normalized.installedAt,
    lastErrorCode: normalized.lastErrorCode, lastError: normalized.lastError, transport: normalized.transport,
  }
}

function toHeartbeatInput(payload: ShellbeamAgentInput): Record<string, unknown> {
  const normalized = normalizeShellbeamAgentRecord(payload, Date.now())
  return {
    vaultId: normalized.vaultId, hostId: normalized.hostId, agentId: normalized.agentId,
    providerKind: normalized.providerKind, source: normalized.source, status: normalized.status,
    health: normalized.health, version: normalized.version, capabilities: normalized.capabilities,
    heartbeatTtlMs: normalized.heartbeatTtlMs, heartbeatAt: normalized.lastHeartbeatAt,
    checkedAt: normalized.lastCheckedAt, lastErrorCode: normalized.lastErrorCode,
    lastError: normalized.lastError, transport: normalized.transport,
  }
}

export async function listShellbeamAgents(options: { vaultId?: string; hostId?: string } = {}) {
  const records = await invoke<ShellbeamAgentRecord[]>('list_shellbeam_agents', { vaultId: options.vaultId, hostId: options.hostId })
  const now = Date.now()
  return records.map((record) => refreshPersistedHealth(normalizeShellbeamAgentRecord(record, now), now))
}

export const SHELLBEAM_AGENT_STATE_CHANGED_EVENT = 'shellbeam-agent-state-changed'

export async function upsertShellbeamAgent(payload: ShellbeamAgentInput, options: { notifyChange?: boolean } = {}) {
  const record = await invoke<ShellbeamAgentRecord>('upsert_shellbeam_agent', { input: toInput(payload) })
  if (options.notifyChange !== false && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SHELLBEAM_AGENT_STATE_CHANGED_EVENT))
  return normalizeShellbeamAgentRecord(record, Date.now())
}

export async function recordShellbeamAgentHeartbeat(payload: ShellbeamAgentInput) {
  const record = await invoke<ShellbeamAgentRecord>('record_shellbeam_agent_heartbeat', { input: toHeartbeatInput(payload) })
  return normalizeShellbeamAgentRecord(record, Date.now())
}

export async function clearShellbeamAgents(options: { vaultId?: string; hostId?: string } = {}) {
  return invoke<void>('clear_shellbeam_agents', options)
}

export async function checkShellbeamAgent(host: HostProfile, resolveAuthSecret: (host: HostProfile) => Promise<string>, now = Date.now(), vaultId?: string): Promise<ShellbeamAgentCommandResult> {
  const result = await runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command: SHELLBEAM_AGENT_CHECK_COMMAND })
  // A daemon sample can be generated while the SSH request is in flight.
  // Compare it with response receipt, never the request's start timestamp.
  const receivedAt = Date.now()
  const record = result.exitCode === 0
    ? parseShellbeamAgentProbeOutput(result.stdout, host, receivedAt)
    : normalizeShellbeamAgentRecord({ hostId: host.id, status: 'unknown', health: 'unknown', transport: getProbeTransport(host), lastCheckedAt: now, lastErrorCode: `agent_check_exit_${result.exitCode}`, lastError: 'Agent probe command did not complete successfully' }, receivedAt)
  return { record, snapshot: parseShellbeamAgentObservation(result.stdout, record, host, receivedAt), stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs }
}

export async function runShellbeamAgentOperation(options: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  action: 'install' | 'upgrade' | 'uninstall'
  vaultId?: string
  installPath?: string
  version?: string
  confirmMessage?: string
  onRecord?: (record: ShellbeamAgentRecord) => void
}): Promise<ShellbeamAgentOperationResult | null> {
  const { host, resolveAuthSecret, action, vaultId = 'local', installPath, version, confirmMessage, onRecord } = options
  const plan = buildShellbeamAgentPlan(action, { installPath, version })
  const initial = normalizeShellbeamAgentRecord({ vaultId, hostId: host.id, status: action === 'install' ? 'installing' : action === 'upgrade' ? 'upgrading' : 'uninstalling', transport: operationTransport(host), installPath, installMethod: 'ssh-confirmed' }, Date.now())
  onRecord?.(initial)
  try {
    const execution = await runConfirmedOperation({
      host, action: `agent.${action}`, target: plan.target, risk: plan.risk,
      provider: 'shellbeam-agent', transport: operationTransport(host),
      paramsSummary: `path=${initial.installPath ?? SHELLBEAM_AGENT_DEFAULT_PATH}${version ? `; version=${version}` : ''}`,
      confirmMessage: confirmMessage ?? `Confirm ${action} for the ShellBeam Probe on ${host.name}?`,
      execute: () => runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command: plan.command }),
      getResult: (result) => result,
      onJob: () => undefined,
    })
    if (!execution) {
      const cancelled = normalizeShellbeamAgentRecord({ ...initial, status: action === 'uninstall' ? 'installed' : 'unknown', health: 'unknown', lastErrorCode: 'confirmation_rejected', lastError: 'Operation was cancelled before execution', updatedAt: Date.now() })
      onRecord?.(cancelled)
      await upsertShellbeamAgent(cancelled).catch(() => undefined)
      return null
    }
    const parsed = parseShellbeamAgentProbeOutput([execution.value.stdout, execution.value.stderr].filter(Boolean).join('\n'), host)
    const lifecycleStatus = parsed.status === 'unsupported' || execution.value.exitCode === 127
      ? 'unsupported'
      : execution.value.exitCode === 0
        ? action === 'uninstall' ? 'retired' : 'installed'
        : execution.job.status === 'unknown' ? 'unknown' : 'failed'
    const record = normalizeShellbeamAgentRecord({ ...parsed, vaultId, hostId: host.id, status: lifecycleStatus, installPath: initial.installPath, transport: operationTransport(host), installMethod: 'ssh-confirmed', lastErrorCode: execution.value.exitCode === 0 ? parsed.lastErrorCode : `exit_${execution.value.exitCode}`, lastError: execution.value.exitCode === 0 ? parsed.lastError : execution.value.stderr || parsed.lastError || 'Agent operation failed', updatedAt: Date.now() })
    onRecord?.(record)
    await upsertShellbeamAgent(record)
    return { record, job: execution.job, commandResult: { record, stdout: execution.value.stdout, stderr: execution.value.stderr, exitCode: execution.value.exitCode, durationMs: execution.value.durationMs } }
  } catch (error) {
    const record = normalizeShellbeamAgentRecord({ ...initial, status: 'unknown', health: 'unknown', lastErrorCode: 'agent_operation_unknown', lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
    onRecord?.(record)
    await upsertShellbeamAgent(record).catch(() => undefined)
    throw error
  }
}

export function shellbeamAgentRecordToProbeSnapshot(record: ShellbeamAgentRecord, host: HostProfile, now = Date.now()): ProbeSnapshot {
  record = normalizeShellbeamAgentRecord(record, now)
  const source: ProbeProviderRef = { kind: 'shellbeam-agent', id: record.agentId || record.hostId, capabilities: normalizeCapabilities(record.capabilities) as ProbeCapability[] }
  return {
    schemaVersion: 1, host: getHostIdentity(host), provider: source, transport: getProbeTransport(host), health: record.health,
    receivedAt: record.lastCheckedAt || now, metrics: null, inventory: null,
    errors: record.lastError ? [{ section: 'provider', message: record.lastError, code: record.lastErrorCode ?? undefined }] : [],
    agent: { status: record.status, version: record.version ?? null, nodeId: record.agentId ?? null, capabilities: record.capabilities, lastHeartbeat: record.lastHeartbeatAt ?? null, checkedAt: record.lastCheckedAt ?? null },
  }
}

function getHostIdentity(host: HostProfile) {
  return { hostId: host.id, address: host.address, port: host.port || 22, username: host.username || 'root', ...(host.jumpHost?.trim() ? { jump: { address: host.jumpHost.trim(), port: host.jumpPort || 22, username: host.jumpUser?.trim() || host.username || 'root' } } : {}) }
}

export function createShellbeamAgentProbeProvider(options: { check?: (host: HostProfile, resolveAuthSecret: (host: HostProfile) => Promise<string>, now: number) => Promise<ShellbeamAgentCommandResult> } = {}): ProbeProvider {
  const ref: ProbeProviderRef = { kind: 'shellbeam-agent', id: 'shellbeam-agent', capabilities: ['heartbeat', 'metrics', 'inventory'] }
  return {
    ref,
    async probe(request) {
      const now = request.now ?? Date.now()
      try {
        const checked = await (options.check ?? checkShellbeamAgent)(request.host, request.resolveAuthSecret, now)
        const receivedAt = request.now ?? Date.now()
        return checked.snapshot ?? parseShellbeamAgentObservation(checked.stdout, checked.record, request.host, receivedAt)
      } catch (error) {
        const record = normalizeShellbeamAgentRecord({ hostId: request.host.id, status: 'unknown', health: 'unknown', transport: getProbeTransport(request.host), lastCheckedAt: now, lastErrorCode: 'agent_check_failed', lastError: error instanceof Error ? error.message : String(error) }, now)
        return shellbeamAgentRecordToProbeSnapshot(record, request.host, now)
      }
    },
  }
}

/** Decode only the public observation schema. Command output, environment,
 * process arguments and unrecognized fields never enter a persisted snapshot. */
export function parseShellbeamAgentObservation(output: string, record: ShellbeamAgentRecord, host: HostProfile, now = Date.now()): ProbeSnapshot {
  const snapshot = shellbeamAgentRecordToProbeSnapshot(record, host, now)
  let payload: Record<string, unknown>
  try {
    if (output.length > 1024 * 1024) return snapshot
    const parsed = JSON.parse(output) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return snapshot
    payload = parsed as Record<string, unknown>
  } catch { return snapshot }
  const sampledAt = parseTimestamp(payload.sampledAt ?? payload.lastHeartbeatAt)
  if (sampledAt && sampledAt > now) {
    snapshot.health = 'unknown'
    snapshot.errors.push({ section: 'provider', code: 'agent_sample_in_future', message: 'Agent sample time is later than response receipt' })
    return snapshot
  }
  if (!sampledAt || payload.schemaVersion !== 1) return snapshot
  const raw = payload.metrics && typeof payload.metrics === 'object' ? payload.metrics as Record<string, unknown> : null
  const metricNumber = (key: string, max = Number.MAX_SAFE_INTEGER) => {
    const value = raw?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null
  }
  if (raw) {
    const metrics: ServerMonitorSnapshot = {
      hostname: text(raw.hostname) ?? '', os: text(raw.os) ?? '', kernel: text(raw.kernel) ?? '',
      sampledAt, uptimeSeconds: metricNumber('uptimeSeconds'), cpuPercent: metricNumber('cpuPercent', 100),
      load1: metricNumber('load1'), load5: metricNumber('load5'), load15: metricNumber('load15'),
      memoryUsedBytes: metricNumber('memoryUsedBytes'), memoryTotalBytes: metricNumber('memoryTotalBytes'), memoryPercent: metricNumber('memoryPercent', 100),
      diskUsedBytes: metricNumber('diskUsedBytes'), diskTotalBytes: metricNumber('diskTotalBytes'), diskPercent: metricNumber('diskPercent', 100),
      networkRxBytesPerSec: metricNumber('networkRxBytesPerSec'), networkTxBytesPerSec: metricNumber('networkTxBytesPerSec'), latencyMs: null,
    }
    snapshot.metrics = createProbeObservation({ data: metrics, source: snapshot.provider, sampledAt, receivedAt: now, ttlMs: record.heartbeatTtlMs, confidence: Object.values(metrics).some((value) => value === null) ? 'partial' : 'observed' })
  }
  const rawInventory = payload.inventory && typeof payload.inventory === 'object' ? payload.inventory as Record<string, unknown> : null
  if (rawInventory && snapshot.metrics) {
    const metrics = snapshot.metrics.data
    const rows = (value: unknown) => Array.isArray(value) ? value.slice(0, 100).filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row))) : []
    const inventory: WorkspaceInventory = {
      resource: { hostname: metrics.hostname, os: metrics.os, kernel: metrics.kernel, uptime: metrics.uptimeSeconds === null ? '' : `${Math.floor(metrics.uptimeSeconds)}s`, cpuPercent: metrics.cpuPercent, memoryPercent: metrics.memoryPercent, memoryText: metrics.memoryUsedBytes === null || metrics.memoryTotalBytes === null ? '' : `${metrics.memoryUsedBytes}/${metrics.memoryTotalBytes} B`, diskPercent: metrics.diskPercent, diskText: metrics.diskUsedBytes === null || metrics.diskTotalBytes === null ? '' : `${metrics.diskUsedBytes}/${metrics.diskTotalBytes} B`, network: metrics.networkRxBytesPerSec === null || metrics.networkTxBytesPerSec === null ? '' : `${Math.round(metrics.networkRxBytesPerSec + metrics.networkTxBytesPerSec)} B/s` },
      tools: rows(rawInventory.tools).map((row) => ({ id: text(row.id, 80) ?? '', name: text(row.name, 80) ?? '', category: text(row.category, 80) ?? '', binary: text(row.binary, 80) ?? '', path: text(row.path) ?? '', version: text(row.version, 80) ?? '' })),
      services: rows(rawInventory.services).map((row) => ({ name: text(row.name, 120) ?? '', active: text(row.active, 40) ?? 'unknown', enabled: text(row.enabled, 40) ?? 'unknown' })),
      containers: [], pm2: [], projects: [], scannedAt: sampledAt,
    }
    snapshot.inventory = createProbeObservation({ data: inventory, source: snapshot.provider, sampledAt, receivedAt: now, ttlMs: record.heartbeatTtlMs, confidence: 'partial' })
  }
  if (snapshot.metrics?.freshness.expired || snapshot.inventory?.freshness.expired) snapshot.health = record.health === 'offline' ? 'offline' : 'stale'
  return snapshot
}
