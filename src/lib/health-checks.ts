import { queueLocalOpsDocument, registerLocalOpsAdapter } from './local-ops-persistence'
import type { HostProfile } from './hosts'
import type { CommandRunResult } from './sessions'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { loadLocalAlertState, saveLocalAlertState, notifyLocalOpsChanged } from './local-ops-store'
import { operationTransport } from './operation-job'

export type HealthCheckKind = 'tcp' | 'http'
export type HealthCheckStatus = 'passing' | 'failing' | 'unknown'
export type HealthCheckErrorCode = 'invalid-target' | 'timeout' | 'jump-unavailable' | 'auth' | 'network' | 'http-status' | 'command' | 'unknown'

export interface HealthCheckDefinition {
  id: string
  hostId: string
  name: string
  kind: HealthCheckKind
  target: string
  port?: number
  path?: string
  expectedStatus?: number
  timeoutMs: number
  intervalMs: number
  enabled: boolean
  alertAfterMs?: number
  recoveryAfterMs?: number
}

export interface HealthCheckResult {
  checkId: string
  hostId: string
  status: HealthCheckStatus
  checkedAt: number
  durationMs: number | null
  latencyMs: number | null
  transport: 'direct' | 'proxy-jump'
  provider: 'ssh-agentless'
  statusCode?: number | null
  errorCode?: HealthCheckErrorCode | null
  errorSummary?: string | null
  nextCheckAt: number
}

export interface HealthCheckRunOptions {
  host: HostProfile
  vaultId?: string
  check: HealthCheckDefinition
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  now?: number
  runCommand?: (options: { vaultId?: string; host: HostProfile; resolveAuthSecret: (host: HostProfile) => Promise<string>; command: string }) => Promise<CommandRunResult>
}

export interface HealthCheckBatchOptions {
  now?: number
  maxConcurrency?: number
  ttlMs?: number
  previous?: Record<string, HealthCheckResult>
  run?: (check: HealthCheckDefinition) => Promise<HealthCheckResult>
}

const STORAGE_PREFIX = 'shellbeam.healthChecks.v1'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_INTERVAL_MS = 60_000
const MAX_TIMEOUT_MS = 60_000
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_ERROR_LENGTH = 240
const SECRET_QUERY_KEY = /(token|secret|pass(word)?|api[_-]?key|auth|credential)/i

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value as number)))
}

function normalizeHost(value: string) {
  const host = value.trim()
  if (!host || !/^[A-Za-z0-9._:\x5b\x5d-]+$/.test(host)) throw new Error('health_check_invalid_target')
  return host
}

function normalizePort(value: number | undefined, fallback = 443) {
  const port = clampInt(value, fallback, 1, 65_535)
  if (!Number.isInteger(port)) throw new Error('health_check_invalid_port')
  return port
}

function normalizeHttpTarget(check: HealthCheckDefinition) {
  const raw = check.target.trim()
  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    throw new Error('health_check_invalid_target')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('health_check_invalid_target')
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key)) throw new Error('health_check_invalid_target')
  }
  if (!url.hostname || /[\s|;&`$]/.test(url.hostname)) throw new Error('health_check_invalid_target')
  if (check.path?.trim()) {
    const path = check.path.trim()
    if (!path.startsWith('/') || /[\s|;&`$]/.test(path)) throw new Error('health_check_invalid_path')
    url.pathname = path
  }
  if (check.port) url.port = String(normalizePort(check.port, url.protocol === 'https:' ? 443 : 80))
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function normalizeHealthCheck(check: HealthCheckDefinition): HealthCheckDefinition {
  if (check.kind !== 'tcp' && check.kind !== 'http') throw new Error('health_check_invalid_kind')
  const normalized: HealthCheckDefinition = {
    id: check.id.trim().slice(0, 120),
    kind: check.kind,
    ...(check.port !== undefined ? { port: check.port } : {}),
    ...(check.path !== undefined ? { path: check.path } : {}),
    ...(check.expectedStatus !== undefined ? { expectedStatus: check.expectedStatus } : {}),
    hostId: check.hostId.trim(),
    name: check.name.trim().slice(0, 120),
    target: check.target.trim(),
    timeoutMs: clampInt(check.timeoutMs, DEFAULT_TIMEOUT_MS, 500, MAX_TIMEOUT_MS),
    intervalMs: clampInt(check.intervalMs, DEFAULT_INTERVAL_MS, 5_000, MAX_INTERVAL_MS),
    enabled: check.enabled !== false,
    alertAfterMs: clampInt(check.alertAfterMs, 0, 0, MAX_INTERVAL_MS),
    recoveryAfterMs: clampInt(check.recoveryAfterMs, 0, 0, MAX_INTERVAL_MS),
  }
  if (!normalized.id || !normalized.hostId || !normalized.name) throw new Error('health_check_missing_identity')
  if (normalized.kind === 'tcp') {
    normalized.target = normalizeHost(normalized.target)
    normalized.port = normalizePort(normalized.port, 22)
    delete normalized.path
    delete normalized.expectedStatus
  } else {
    normalized.target = normalizeHttpTarget(normalized)
    normalized.port = undefined
    normalized.path = undefined
    normalized.expectedStatus = normalized.expectedStatus == null ? undefined : clampInt(normalized.expectedStatus, 200, 100, 599)
  }
  return normalized
}

export function defaultHealthCheck(host: HostProfile): HealthCheckDefinition {
  return normalizeHealthCheck({
    id: `${host.id}:ssh`,
    hostId: host.id,
    name: 'SSH port',
    kind: 'tcp',
    target: host.address,
    port: host.port || 22,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    enabled: true,
  })
}

export function buildHealthCheckCommand(check: HealthCheckDefinition) {
  const normalized = normalizeHealthCheck(check)
  const timeoutSeconds = Math.max(1, Math.ceil(normalized.timeoutMs / 1000))
  if (normalized.kind === 'tcp') {
    const target = shellQuote(normalized.target)
    const port = String(normalized.port)
    return `bash -lc ${shellQuote(`if command -v nc >/dev/null 2>&1; then nc -z -w ${timeoutSeconds} ${target} ${port}; else timeout ${timeoutSeconds}s bash -c '</dev/tcp/${normalized.target}/${port}' >/dev/null 2>&1; fi`)}`
  }
  const url = shellQuote(normalized.target)
  return `curl --silent --show-error --max-time ${timeoutSeconds} --output /dev/null --write-out ${shellQuote('__SB_CHECK_HTTP=%{http_code}|%{time_total}\\n')} ${url}`
}

function redactError(value: unknown) {
  const message = String(value ?? 'health_check_failed')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/(token|password|secret|key)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/[\r\n|]+/g, ' ')
    .trim()
  return message.slice(0, MAX_ERROR_LENGTH) || 'health_check_failed'
}

function classifyError(error: unknown): HealthCheckErrorCode {
  const message = String(error).toLowerCase()
  if (message.includes('jump') || message.includes('bastion')) return 'jump-unavailable'
  if (message.includes('auth') || message.includes('permission')) return 'auth'
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout'
  if (message.includes('network') || message.includes('connect') || message.includes('handshake')) return 'network'
  return 'unknown'
}

function baseResult(check: HealthCheckDefinition, host: HostProfile, now: number, status: HealthCheckStatus): HealthCheckResult {
  return {
    checkId: check.id,
    hostId: host.id,
    status,
    checkedAt: now,
    durationMs: null,
    latencyMs: null,
    transport: operationTransport(host),
    provider: 'ssh-agentless',
    nextCheckAt: now + check.intervalMs,
  }
}

export async function runHealthCheck(options: HealthCheckRunOptions): Promise<HealthCheckResult> {
  const now = options.now ?? Date.now()
  let check: HealthCheckDefinition
  try {
    check = normalizeHealthCheck(options.check)
    if (check.hostId !== options.host.id) throw new Error('health_check_invalid_scope')
  } catch (error) {
    return { ...baseResult(options.check, options.host, now, 'unknown'), errorCode: 'invalid-target', errorSummary: redactError(error) }
  }
  const startedAt = Date.now()
  try {
    const result = await (options.runCommand ?? runWorkspaceRemoteCommand)({
      host: options.host,
      vaultId: options.vaultId,
      resolveAuthSecret: options.resolveAuthSecret,
      command: buildHealthCheckCommand(check),
    })
    const durationMs = Math.max(0, result.durationMs || Date.now() - startedAt)
    if ((result.errorType && result.errorType !== 'command') || result.exitCode === 126 || result.exitCode === 127) {
      return { ...baseResult(check, options.host, now, 'unknown'), durationMs, errorCode: result.errorType === 'auth' ? 'auth' : result.errorType === 'network' ? 'network' : 'command', errorSummary: 'health_check_collection_unavailable' }
    }
    if (check.kind === 'http') {
      const marker = result.stdout.match(/__SB_CHECK_HTTP=(\d{3})\|([0-9.]+)/)
      const statusCode = marker ? Number(marker[1]) : null
      const latencyMs = marker ? Math.round(Number(marker[2]) * 1000) : null
      const expected = check.expectedStatus ?? 200
      const passing = result.exitCode === 0 && statusCode !== null && statusCode === expected
      return {
        ...baseResult(check, options.host, now, passing ? 'passing' : marker ? 'failing' : 'unknown'),
        durationMs,
        latencyMs,
        statusCode,
        ...(passing ? {} : { errorCode: statusCode === null ? 'command' as const : 'http-status' as const, errorSummary: statusCode === null ? redactError(result.stderr || 'health_check_http_marker_missing') : `HTTP ${statusCode}` }),
      }
    }
    const passing = result.exitCode === 0
    return {
      ...baseResult(check, options.host, now, passing ? 'passing' : 'failing'),
      durationMs,
      latencyMs: durationMs,
      ...(passing ? {} : { errorCode: 'command' as const, errorSummary: redactError(result.stderr || `exit=${result.exitCode}`) }),
    }
  } catch (error) {
    const errorCode = classifyError(error)
    return { ...baseResult(check, options.host, now, 'unknown'), errorCode, errorSummary: redactError(error) }
  }
}

/** Run checks with a bounded worker pool and skip results that are still fresh. */
export async function runHealthCheckBatch(checks: HealthCheckDefinition[], options: HealthCheckBatchOptions = {}) {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? 5_000
  const maxConcurrency = clampInt(options.maxConcurrency, 4, 1, 16)
  const runnable = checks.filter((check) => check.enabled !== false && !(options.previous?.[check.id] && now - options.previous[check.id].checkedAt < ttlMs))
  const results: HealthCheckResult[] = []
  let cursor = 0
  async function worker() {
    while (cursor < runnable.length) {
      const check = runnable[cursor++]
      if (!check) continue
      let result: HealthCheckResult
      try {
        result = options.run
          ? await options.run(check)
          : { ...baseResult(check, { id: check.hostId } as HostProfile, now, 'unknown'), errorCode: 'unknown' as const, errorSummary: 'health_check_runner_required' }
      } catch (error) {
        result = { ...baseResult(check, { id: check.hostId } as HostProfile, now, 'unknown'), errorCode: classifyError(error), errorSummary: redactError(error) }
      }
      results.push(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, Math.max(1, runnable.length)) }, () => worker()))
  return { results, skipped: checks.filter((check) => !runnable.includes(check)) }
}

export function healthCheckStorageKey(vaultId: string | undefined, hostId: string) {
  return `${STORAGE_PREFIX}:${vaultId || 'default'}:${hostId}`
}

export function loadHealthChecks(vaultId: string | undefined, host: HostProfile): HealthCheckDefinition[] {
  try {
    const raw = localStorage.getItem(healthCheckStorageKey(vaultId, host.id))
    if (!raw) return [defaultHealthCheck(host)]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [defaultHealthCheck(host)]
    const checks = parsed.slice(0, 32).flatMap((item) => {
      try { const check = normalizeHealthCheck(item as HealthCheckDefinition); return check.hostId === host.id ? [check] : [] } catch { return [] }
    })
    return checks
  } catch {
    return [defaultHealthCheck(host)]
  }
}

export function saveHealthChecks(vaultId: string | undefined, hostId: string, checks: HealthCheckDefinition[]) {
  const normalized = checks.slice(0, 32).map(normalizeHealthCheck)
  if (normalized.some((check) => check.hostId !== hostId) || new Set(normalized.map((check) => check.id)).size !== normalized.length) throw new Error('health_check_invalid_scope')
  let previous: HealthCheckDefinition[] = normalized
  try { const raw: unknown = JSON.parse(localStorage.getItem(healthCheckStorageKey(vaultId, hostId)) || 'null'); if (Array.isArray(raw)) previous = raw.flatMap((row) => { try { return [normalizeHealthCheck(row)] } catch { return [] } }) } catch { previous = [] }
  const unchanged = new Set(normalized.filter((row) => previous.some((old) => JSON.stringify(old) === JSON.stringify(row))).map((row) => `check:${row.id}`))
  const state = loadLocalAlertState(vaultId, hostId)
  state.evaluations = state.evaluations.filter((row) => !row.ruleId.startsWith('check:') || unchanged.has(row.ruleId))
  localStorage.setItem(healthCheckStorageKey(vaultId, hostId), JSON.stringify(normalized))
  void queueLocalOpsDocument(vaultId, hostId, 'health-checks', normalized)
  saveLocalAlertState(vaultId, hostId, state)
  notifyLocalOpsChanged()
  return normalized
}


/** Bounded, allowlisted result history. URLs, credentials and remote output are
 * deliberately absent; configuration is stored separately from observations. */
export function healthCheckHistoryStorageKey(vaultId: string | undefined, hostId: string) {
  return `shellbeam.healthCheckHistory.v1:${encodeURIComponent(vaultId || 'default')}:${encodeURIComponent(hostId)}`
}
export function normalizeHealthCheckResult(value: unknown, hostId: string): HealthCheckResult | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<HealthCheckResult>
  if (row.hostId !== hostId || typeof row.checkId !== 'string' || !row.checkId.trim() || !['passing', 'failing', 'unknown'].includes(row.status || '') || !Number.isFinite(row.checkedAt) || !Number.isFinite(row.nextCheckAt)) return null
  const duration = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(86_400_000, n)) : null
  const errors: HealthCheckErrorCode[] = ['invalid-target', 'timeout', 'jump-unavailable', 'auth', 'network', 'http-status', 'command', 'unknown']
  return {
    checkId: row.checkId.trim().slice(0, 120), hostId, status: row.status as HealthCheckStatus,
    checkedAt: Math.max(0, row.checkedAt!), nextCheckAt: Math.max(0, row.nextCheckAt!),
    durationMs: duration(row.durationMs), latencyMs: duration(row.latencyMs),
    transport: row.transport === 'proxy-jump' ? 'proxy-jump' : 'direct', provider: 'ssh-agentless',
    ...(typeof row.statusCode === 'number' && row.statusCode >= 100 && row.statusCode <= 599 ? { statusCode: row.statusCode } : {}),
    ...(errors.includes(row.errorCode as HealthCheckErrorCode) ? { errorCode: row.errorCode } : {}),
    // Persist fixed failure categories instead of arbitrary transport output.
    ...(row.status !== 'passing' ? { errorSummary: errors.includes(row.errorCode as HealthCheckErrorCode) ? row.errorCode! : 'unknown' } : {}),
  }
}
export function loadHealthCheckHistory(vaultId: string | undefined, hostId: string): HealthCheckResult[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(healthCheckHistoryStorageKey(vaultId, hostId)) || '[]')
    return Array.isArray(raw) ? raw.slice(-500).flatMap((row) => { const normalized = normalizeHealthCheckResult(row, hostId); return normalized ? [normalized] : [] }).sort((a, b) => a.checkedAt - b.checkedAt) : []
  } catch { return [] }
}
export function latestHealthCheckResults(history: HealthCheckResult[]) {
  return Object.fromEntries([...history].sort((a, b) => a.checkedAt - b.checkedAt).map((row) => [row.checkId, row])) as Record<string, HealthCheckResult>
}
export function persistHealthCheckResult(vaultId: string | undefined, result: HealthCheckResult) {
  const normalized = normalizeHealthCheckResult(result, result.hostId)
  if (!normalized) throw new Error('health_check_invalid_result')
  const history = [...loadHealthCheckHistory(vaultId, result.hostId).filter((row) => row.checkId !== normalized.checkId || row.checkedAt !== normalized.checkedAt), normalized].sort((a, b) => a.checkedAt - b.checkedAt).slice(-500)
  localStorage.setItem(healthCheckHistoryStorageKey(vaultId, result.hostId), JSON.stringify(history))
  void queueLocalOpsDocument(vaultId, result.hostId, 'health-history', history)
  notifyLocalOpsChanged()
  return normalized
}

registerLocalOpsAdapter('health-checks', {
  readCache: (vault, host) => { try { return JSON.parse(localStorage.getItem(healthCheckStorageKey(vault, host)) || 'null') } catch { return null } },
  writeCache: (vault, host, payload) => {
    if (!Array.isArray(payload)) throw new Error('LOCAL_OPS_INVALID_CHECKS')
    const checks = payload.slice(0, 32).map(normalizeHealthCheck)
    if (checks.some((check) => check.hostId !== host)) throw new Error('LOCAL_OPS_HOST_MISMATCH')
    localStorage.setItem(healthCheckStorageKey(vault, host), JSON.stringify(checks)); notifyLocalOpsChanged()
  },
})
registerLocalOpsAdapter('health-history', {
  readCache: (vault, host) => { const history = loadHealthCheckHistory(vault, host); return history.length ? history : null },
  writeCache: (vault, host, payload) => {
    if (!Array.isArray(payload)) throw new Error('LOCAL_OPS_INVALID_HISTORY')
    const history = payload.slice(-500).flatMap((row) => { const safe = normalizeHealthCheckResult(row, host); return safe ? [safe] : [] })
    localStorage.setItem(healthCheckHistoryStorageKey(vault, host), JSON.stringify(history)); notifyLocalOpsChanged()
  },
})
