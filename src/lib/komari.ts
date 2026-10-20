import type { ServerMonitorSnapshot } from './server-monitor'

export const KOMARI_API_VERSION = 1

export interface KomariClient {
  uuid: string
  name: string
  hostname: string | null
  ipv4: string | null
  ipv6: string | null
  os: string | null
  kernel: string | null
  version: string | null
  raw: Record<string, unknown>
}

export interface KomariMetricRecord {
  time?: number | string | null
  cpu?: unknown
  ram?: unknown
  memory?: unknown
  disk?: unknown
  load?: unknown
  net?: unknown
  network?: unknown
  hostname?: unknown
  os?: unknown
  kernel?: unknown
  [key: string]: unknown
}

/** A read-only summary of the alert rules/events exposed by Komari. */
export interface KomariAlertSummary {
  /** Number of load/threshold notifications returned by Komari. */
  load: number | null
  /** Number of offline notifications returned by Komari. */
  offline: number | null
  /** Sum of the available notification counts. */
  total: number | null
  /** Whether the endpoint returned an active event count. */
  active: number | null
  /** Time at which this summary was read. */
  updatedAt: number
  /** True when the server does not expose the notification API to this token. */
  unsupported?: boolean
  /** A safe, user-facing failure code when one or more endpoints failed. */
  errorCode?: string
}

export interface KomariConnectionConfig {
  endpoint: string
  token?: string
  requestTimeoutMs?: number
}

export interface KomariRequestOptions {
  path: string
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
}

export type KomariFetch = typeof fetch

export class KomariApiError extends Error {
  readonly status: number | null
  readonly code: string

  constructor(message: string, options: { status?: number | null; code?: string } = {}) {
    super(message)
    this.name = 'KomariApiError'
    this.status = options.status ?? null
    this.code = options.code ?? classifyKomariError(options.status ?? null)
  }
}

export function normalizeKomariEndpoint(endpoint: string): string {
  const value = endpoint.trim()
  if (!value) throw new Error('Komari endpoint is required')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Komari endpoint must be a valid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Komari endpoint must use HTTP or HTTPS')
  }
  if (url.username || url.password) {
    throw new Error('Komari endpoint must not contain credentials')
  }
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

export function classifyKomariError(status: number | null): string {
  if (status === 401 || status === 403) return 'permission'
  if (status === 404) return 'endpoint-version'
  if (status === 429) return 'rate-limited'
  if (status === 503) return 'agent-offline'
  if (status === null) return 'unavailable'
  return status >= 500 ? 'server-error' : 'request-failed'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function unwrapPayload(value: unknown): unknown {
  const record = asRecord(value)
  if (!record) return value
  if ('data' in record) return record.data
  if ('result' in record) return record.result
  for (const key of ['records', 'clients', 'nodes']) {
    if (key in record) return record[key]
  }
  return value
}

function safeMessage(value: unknown, token?: string): string {
  const record = asRecord(value)
  const message = typeof record?.message === 'string'
    ? record.message
    : typeof record?.error === 'string'
      ? record.error
      : typeof value === 'string' ? value : 'Komari request failed'
  return token && token.length > 0 ? message.split(token).join('[redacted]') : message
}

async function parseResponse(response: Response): Promise<unknown> {
  const maxBytes = 4 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > maxBytes) throw new KomariApiError('Komari response exceeds the size limit', { code: 'response-too-large' })
  let text: string
  if (response.body) {
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > maxBytes) { await reader.cancel(); throw new KomariApiError('Komari response exceeds the size limit', { code: 'response-too-large' }) } chunks.push(chunk.value) } } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length } text = new TextDecoder().decode(bytes)
  } else { text = await response.text(); if (text.length > maxBytes) throw new KomariApiError('Komari response exceeds the size limit', { code: 'response-too-large' }) }
  if (!text.trim()) return null
  try { return JSON.parse(text) as unknown } catch { return text }
}

export async function requestKomari<T = unknown>(
  config: KomariConnectionConfig,
  options: KomariRequestOptions,
  fetchImpl: KomariFetch = globalThis.fetch,
): Promise<T> {
  const endpoint = normalizeKomariEndpoint(config.endpoint)
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`
  const controller = new AbortController()
  const timeoutMs = config.requestTimeoutMs ?? 15_000
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  const onAbort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const headers = new Headers({ Accept: 'application/json' })
  if (config.token?.trim()) headers.set('Authorization', `Bearer ${config.token.trim()}`)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')

  try {
    const response = await fetchImpl(`${endpoint}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    })
    const payload = await parseResponse(response)
    if (!response.ok) {
      throw new KomariApiError(safeMessage(payload, config.token), { status: response.status })
    }
    return unwrapPayload(payload) as T
  } catch (error) {
    if (error instanceof KomariApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new KomariApiError('Komari request timed out', { code: 'timeout' })
    }
    throw new KomariApiError('Komari endpoint is unavailable', { code: 'unavailable' })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record[key])
    if (value) return value
  }
  return null
}

export function normalizeKomariClient(value: unknown): KomariClient | null {
  const raw = asRecord(value)
  if (!raw) return null
  const uuid = firstString(raw, ['uuid', 'id', 'node_id', 'nodeId'])
  if (!uuid) return null
  return {
    uuid,
    name: firstString(raw, ['name', 'display_name', 'hostname']) ?? uuid,
    hostname: firstString(raw, ['hostname', 'host_name', 'name']),
    ipv4: firstString(raw, ['ipv4', 'ip', 'address']),
    ipv6: firstString(raw, ['ipv6']),
    os: firstString(raw, ['os', 'os_name', 'platform']),
    kernel: firstString(raw, ['kernel_version', 'kernel']),
    version: firstString(raw, ['version', 'client_version']),
    raw,
  }
}

export function normalizeKomariClients(value: unknown): KomariClient[] {
  const payload = unwrapPayload(value)
  if (!Array.isArray(payload)) return []
  return payload
    .map(normalizeKomariClient)
    .filter((client): client is KomariClient => client !== null)
}

function readKomariClientList(value: unknown): KomariClient[] {
  const payload = unwrapPayload(value)
  // A reverse proxy or an unsupported API route can return the HTML console
  // with HTTP 200. Do not turn that response into a successful empty discovery.
  if (!Array.isArray(payload)) {
    throw new KomariApiError('Komari node list has an unsupported response format', { code: 'endpoint-version' })
  }
  const clients = normalizeKomariClients(payload)
  if (payload.length > 0 && clients.length === 0) {
    throw new KomariApiError('Komari node list has an unsupported response format', { code: 'endpoint-version' })
  }
  return clients
}

export async function listKomariClients(
  config: KomariConnectionConfig,
  fetchImpl?: KomariFetch,
): Promise<KomariClient[]> {
  try {
    const payload = await requestKomari<unknown>(config, { path: '/api/admin/client/list' }, fetchImpl)
    return readKomariClientList(payload)
  } catch (error) {
    // Some Komari deployments expose public node discovery but restrict the
    // admin client list. Keep discovery read-only and use that endpoint as a
    // compatibility fallback for 401/403/404 responses.
    if (!(error instanceof KomariApiError) || !['permission', 'endpoint-version'].includes(error.code)) throw error
    const payload = await requestKomari<unknown>(config, { path: '/api/nodes' }, fetchImpl)
    return readKomariClientList(payload)
  }
}

export async function getKomariRecentRecords(
  config: KomariConnectionConfig,
  nodeId: string,
  fetchImpl?: KomariFetch,
): Promise<KomariMetricRecord[]> {
  if (!nodeId.trim()) throw new Error('Komari node id is required')
  const payload = await requestKomari<unknown>(
    config,
    { path: `/api/recent/${encodeURIComponent(nodeId.trim())}` },
    fetchImpl,
  )
  return normalizeKomariMetricRecords(payload)
}

/** HTTP v1.0.3+ and v1.6 RPC-bound HTTP routes use nested data/records
 * envelopes; report objects may be flat stored records or nested live reports. */
export function normalizeKomariMetricRecords(payload: unknown, depth = 0): KomariMetricRecord[] {
  if (depth > 5) return []
  if (Array.isArray(payload)) return payload.filter((item): item is KomariMetricRecord => Boolean(asRecord(item) && ['cpu', 'ram', 'memory', 'disk', 'network', 'net', 'load'].some((key) => key in (item as object)))).sort((left, right) => (komariRecordSampleTime(right) ?? 0) - (komariRecordSampleTime(left) ?? 0)).slice(0, 10000).sort((left, right) => (komariRecordSampleTime(left) ?? 0) - (komariRecordSampleTime(right) ?? 0))
  const record = asRecord(payload)
  if (!record) return []
  for (const key of ['records', 'reports', 'data', 'result']) if (key in record) return normalizeKomariMetricRecords(record[key], depth + 1)
  return ['cpu', 'ram', 'memory', 'disk', 'network', 'net', 'load'].some((key) => key in record) ? [record] : []
}

export async function getKomariHistoryRecords(config: KomariConnectionConfig, nodeId: string, options: { hours?: number } = {}, fetchImpl?: KomariFetch): Promise<KomariMetricRecord[]> {
  if (!nodeId.trim()) throw new Error('Komari node id is required')
  const hours = Math.max(1, Math.min(168, Math.floor(options.hours ?? 24)))
  const readWindow = async (windowHours: number) => {
    const query = new URLSearchParams({ uuid: nodeId.trim(), load_type: 'all', hours: String(windowHours) })
    return normalizeKomariMetricRecords(await requestKomari(config, { path: `/api/records/load?${query}` }, fetchImpl))
  }
  const records = await readWindow(hours)
  if (records.length || hours === 1) return records
  // Komari 1.6 selects a retention tier from the full query window. A new
  // node's 24h request can read an empty coarse tier while its 1h hot-minute
  // tier already contains real reports. Make at most one narrower request;
  // retain its original times and never turn an empty/denied result into data.
  return readWindow(1)
}

export async function getKomariServerVersion(config: KomariConnectionConfig, fetchImpl?: KomariFetch): Promise<{ version: string; hash: string; apiKeySupported: boolean | null }> {
  const value = asRecord(await requestKomari(config, { path: '/api/version' }, fetchImpl))
  const version = typeof value?.version === 'string' ? value.version.slice(0, 80) : 'unknown'
  const parsed = version.match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return { version, hash: typeof value?.hash === 'string' ? value.hash.slice(0, 80) : '', apiKeySupported: parsed ? Number(parsed[1]) > 1 || Number(parsed[1]) === 1 && (Number(parsed[2]) > 0 || Number(parsed[3]) >= 3) : null }
}

function countKomariNotifications(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  const record = asRecord(value)
  if (!record) return null

  for (const key of ['total', 'count', 'length', 'active', 'notifications', 'rules', 'items', 'data']) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return Math.max(0, candidate)
    if (Array.isArray(candidate)) return candidate.length
    const nested = asRecord(candidate)
    if (nested) {
      const nestedCount = countKomariNotifications(nested)
      if (nestedCount !== null) return nestedCount
    }
  }
  return null
}

function activeKomariNotifications(value: unknown): number | null {
  if (Array.isArray(value)) {
    const states = value
      .map((item) => asRecord(item)?.status ?? asRecord(item)?.state)
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.toLowerCase())
    if (states.length === 0) return null
    return states.filter((state) => ['active', 'firing', 'triggered', 'open', 'pending'].includes(state)).length
  }
  const record = asRecord(value)
  if (!record) return null
  for (const key of ['active', 'active_count', 'activeCount', 'firing']) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return Math.max(0, candidate)
    if (Array.isArray(candidate)) return activeKomariNotifications(candidate)
  }
  for (const key of ['notifications', 'rules', 'items', 'data']) {
    const candidate = record[key]
    const nested = activeKomariNotifications(candidate)
    if (nested !== null) return nested
  }
  return null
}

/**
 * Read the two notification collections supported by Komari's admin API.
 * Notification payloads changed shape between Komari releases, so this
 * adapter intentionally returns counts and keeps the raw event details out of
 * the local state and audit records.
 */
export async function getKomariAlertSummary(
  config: KomariConnectionConfig,
  fetchImpl?: KomariFetch,
  now = Date.now(),
): Promise<KomariAlertSummary> {
  const [loadResult, offlineResult] = await Promise.allSettled([
    requestKomari<unknown>(config, { path: '/api/admin/notification/load/' }, fetchImpl),
    requestKomari<unknown>(config, { path: '/api/admin/notification/offline' }, fetchImpl),
  ])
  const load = loadResult.status === 'fulfilled' ? countKomariNotifications(loadResult.value) : null
  const offline = offlineResult.status === 'fulfilled' ? countKomariNotifications(offlineResult.value) : null
  const activeValues = [
    loadResult.status === 'fulfilled' ? activeKomariNotifications(loadResult.value) : null,
    offlineResult.status === 'fulfilled' ? activeKomariNotifications(offlineResult.value) : null,
  ].filter((value): value is number => value !== null)
  const failures = [loadResult, offlineResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  const unsupported = failures.length === 2 && failures.every((result) => {
    const reason = result.reason as { code?: unknown }
    return typeof reason.code === 'string' && ['permission', 'endpoint-version'].includes(reason.code)
  })
  const firstError = failures[0]?.reason
  const errorCode = firstError instanceof KomariApiError ? firstError.code : undefined
  const total = load === null && offline === null ? null : (load ?? 0) + (offline ?? 0)
  return {
    load,
    offline,
    total,
    // Older notification endpoints expose only rule collections. Preserve
    // active as unknown unless a payload explicitly includes it or event
    // statuses that can be classified safely.
    active: activeValues.length > 0 ? activeValues.reduce((sum, value) => sum + value, 0) : null,
    updatedAt: now,
    ...(unsupported ? { unsupported: true } : {}),
    ...(errorCode ? { errorCode } : {}),
  }
}

/** Create the small read-only client consumed by the Komari ProbeProvider. */
export function createKomariProbeClient(
  config: KomariConnectionConfig,
  fetchImpl?: KomariFetch,
): { fetchRecentRecords: (nodeId: string) => Promise<KomariMetricRecord[]> } {
  return {
    fetchRecentRecords: (nodeId: string) => getKomariRecentRecords(config, nodeId, fetchImpl),
  }
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return null
}

function nestedNumber(value: unknown, keys: string[]): number | null {
  const direct = numeric(value)
  if (direct !== null) return direct
  const record = asRecord(value)
  if (!record) return null
  for (const key of keys) {
    const candidate = numeric(record[key])
    if (candidate !== null) return candidate
  }
  return null
}

function objectNumber(value: unknown, keys: string[]): number | null {
  const record = asRecord(value)
  if (!record) return null
  for (const key of keys) {
    const candidate = numeric(record[key])
    if (candidate !== null) return candidate
  }
  return null
}

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value))
}

function timestamp(value: unknown, fallback: number): number {
  const numericValue = typeof value === 'number'
    ? numeric(value)
    : typeof value === 'string' && /^\s*[+-]?(?:\d+\.?\d*|\.\d+)\s*$/.test(value)
      ? numeric(value)
      : null
  if (numericValue !== null) return numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function komariRecordToServerMonitorSnapshot(
  record: KomariMetricRecord,
  client?: KomariClient | null,
  receivedAt = Date.now(),
): ServerMonitorSnapshot {
  const ramValue = record.ram ?? record.memory
  const memoryTotal = objectNumber(ramValue, ['total', 'total_bytes', 'bytes_total'])
    ?? numeric(record.ram_total)
    ?? numeric(record.memory_total)
    ?? numeric(client?.raw.mem_total)
  const memoryUsed = objectNumber(ramValue, ['used', 'used_bytes', 'bytes_used'])
    ?? numeric(record.ram_used)
    ?? numeric(record.memory_used)
    ?? numeric(record.ram)
  const diskTotal = objectNumber(record.disk, ['total', 'total_bytes', 'bytes_total'])
    ?? numeric(record.disk_total)
    ?? numeric(client?.raw.disk_total)
  const diskUsed = objectNumber(record.disk, ['used', 'used_bytes', 'bytes_used'])
    ?? numeric(record.disk_used)
    ?? numeric(record.disk)
  const memoryPercent = clampPercent(objectNumber(ramValue, ['percent', 'usage', 'used_percent'])
    ?? numeric(record.ram_percent)
    ?? (memoryTotal === null ? numeric(record.ram) : null))
  const diskPercent = clampPercent(objectNumber(record.disk, ['percent', 'usage', 'used_percent'])
    ?? numeric(record.disk_percent)
    ?? (diskTotal === null ? numeric(record.disk) : null))
  const loadRecord = asRecord(record.load)
  const netRecord = asRecord(record.net ?? record.network)
  const cpu = clampPercent(nestedNumber(record.cpu, ['percent', 'usage', 'used_percent']))
  return {
    hostname: stringValue(record.hostname) ?? client?.hostname ?? client?.name ?? '',
    os: stringValue(record.os) ?? client?.os ?? '',
    kernel: stringValue(record.kernel) ?? client?.kernel ?? '',
    uptimeSeconds: nestedNumber(record, ['uptime', 'uptime_seconds']),
    cpuPercent: cpu,
    load1: nestedNumber(record.load, ['load1', 'one', '1']) ?? numeric(loadRecord?.load1) ?? numeric(record.load),
    load5: nestedNumber(record.load, ['load5', 'five', '5']) ?? numeric(loadRecord?.load5),
    load15: nestedNumber(record.load, ['load15', 'fifteen', '15']) ?? numeric(loadRecord?.load15),
    memoryUsedBytes: memoryUsed,
    memoryTotalBytes: memoryTotal,
    memoryPercent: memoryPercent ?? (memoryUsed !== null && memoryTotal ? clampPercent(memoryUsed / memoryTotal * 100) : null),
    diskUsedBytes: diskUsed,
    diskTotalBytes: diskTotal,
    diskPercent: diskPercent ?? (diskUsed !== null && diskTotal ? clampPercent(diskUsed / diskTotal * 100) : null),
    networkRxBytesPerSec: nestedNumber(record.net ?? record.network, ['rx', 'in', 'receive', 'download', 'down']) ?? numeric(netRecord?.rx) ?? numeric(record.net_in),
    networkTxBytesPerSec: nestedNumber(record.net ?? record.network, ['tx', 'out', 'send', 'upload', 'up']) ?? numeric(netRecord?.tx) ?? numeric(record.net_out),
    latencyMs: null,
    sampledAt: timestamp(record.time ?? record.updated_at ?? record.updatedAt, receivedAt),
  }
}

export function komariRecordSampleTime(record: KomariMetricRecord): number | null {
  const value = timestamp(record.time ?? record.updated_at ?? record.updatedAt, Number.NaN)
  return Number.isFinite(value) && value > 0 ? value : null
}
