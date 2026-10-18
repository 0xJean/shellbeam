import source from '../../shared/collection-limits.json?raw'

/** The numeric source of truth is shared with native Rust. Separate budgets
 * are intentional: an MCP task can be longer than a read-only host probe,
 * and a chart response is much smaller than the retained SQLite history. */
interface CollectionLimits {
  schemaVersion: number
  remote: { outputBytes: number; commandTimeoutMs: number; minCommandTimeoutMs: number; mcpCommandMaxTimeoutMs: number; collectorTimeoutMs: number; mcpFileTimeoutMs: number; mcpFileDefaultReadBytes: number; mcpFileMaxReadBytes: number }
  collector: { filesystemRows: number; portRows: number; toolRows: number; serviceRows: number; serviceDetailRows: number; containerRows: number; projectRows: number; pm2Rows: number; optionalCommandTimeoutSeconds: number; versionBudgetSeconds: number; projectDepth: number; projectRowsPerRoot: number; projectManifestRows: number; manifestReadBytes: number }
  scheduler: { concurrency: number; defaultRetries: number; maxRetries: number; retryDelayMs: number; maxRetryDelayMs: number }
  cadence: { monitorIntervalMs: number; inventoryIntervalMs: number; metricsTtlMs: number; inventoryTtlMs: number; mcpProbeCacheMs: number }
  history: { retentionMs: number; monitorRetentionMs: number; maxSeriesPoints: number; maxTotalPoints: number; appendChunkPoints: number; maxBatchPoints: number; defaultQueryPoints: number; maxQueryPoints: number; defaultQueryRangeMs: number }
}
export const COLLECTION_LIMITS: Readonly<CollectionLimits> = JSON.parse(source) as CollectionLimits

/** Invalid caller options must not disable a worker pool or create an
 * unbounded array. Explicit finite concurrency remains supported. */
export function collectionConcurrency(value = COLLECTION_LIMITS.scheduler.concurrency) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : COLLECTION_LIMITS.scheduler.concurrency
}

/** The shell is a template, so remote hosts need no JSON parser/config file.
 * Native MCP uses the same JSON and substitutions before sending this frame. */
export function renderProbeCollector(script: string) {
  return script.replace(/__SB_LIMIT_([A-Za-z]+)__/g, (_match, key: string) => {
    const value = COLLECTION_LIMITS.collector[key as keyof CollectionLimits['collector']]
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`PROBE_LIMIT_INVALID:${key}`)
    return String(value)
  })
}

/** Renderer/IPC callers may shorten deadlines; invalid numbers fall back to
 * the ordinary budget and no caller can increase the native ceiling. */
export function collectionCommandTimeoutMs(value = COLLECTION_LIMITS.remote.commandTimeoutMs) {
  return Number.isFinite(value)
    ? Math.min(COLLECTION_LIMITS.remote.commandTimeoutMs, Math.max(COLLECTION_LIMITS.remote.minCommandTimeoutMs, Math.floor(value)))
    : COLLECTION_LIMITS.remote.commandTimeoutMs
}
