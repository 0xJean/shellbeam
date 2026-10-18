import { invoke } from '@tauri-apps/api/core'
import protocolSource from '../../agent/history-protocol-limits.json?raw'
import type { HostProfile } from './hosts'
import type { ProviderMetricHistoryPoint } from './provider-history'
import { observationToMetricHistoryPoint } from './provider-history'
import { parseShellbeamAgentObservation, type ShellbeamAgentRecord } from './shellbeam-agent'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { remoteOperationStatus } from './operation-verification'

const protocol = JSON.parse(protocolSource) as { schemaVersion: number; pageBytes: number; maxPoints: number; defaultPoints: number }
export const SHELLBEAM_AGENT_HISTORY_PAGE_BYTES = protocol.pageBytes
export const SHELLBEAM_AGENT_HISTORY_PAGE_POINTS = protocol.defaultPoints
export const SHELLBEAM_AGENT_HISTORY_MAX_PAGES = 4
export const SHELLBEAM_AGENT_HISTORY_TIMEOUT_MS = 30_000

export interface ShellbeamAgentHistoryScope { vaultId: string; hostId: string; providerKind: 'shellbeam-agent'; providerId: 'shellbeam-agent'; nodeId: string }
export interface ShellbeamAgentHistoryCursor { cursor: string | null; revision: number; updatedAt: number | null; exhausted: boolean; reason: 'not-started' | 'page-imported' | 'complete' | 'empty' }
export interface ShellbeamAgentHistoryPage { after: number; through: number; nextCursor: number; hasMore: boolean; points: ProviderMetricHistoryPoint[] }
export type ShellbeamAgentHistoryReason = 'complete' | 'page-budget' | 'history-unavailable' | 'invalid-page' | 'scope-mismatch' | 'cursor-conflict' | 'transport-error' | 'persistence-error' | 'interrupted' | 'clock-rollback' | 'timeout'
export interface ShellbeamAgentHistorySyncSummary extends ShellbeamAgentHistoryScope {
  status: 'complete' | 'partial' | 'unavailable' | 'failed' | 'cancelled'
  reason: ShellbeamAgentHistoryReason
  imported: number
  pages: number
  hasMore: boolean | null
  cursor: string | null
}
export interface ShellbeamAgentHistorySyncOptions {
  host: HostProfile
  record: ShellbeamAgentRecord
  vaultId: string
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  isCurrent?: () => boolean
  now?: () => number
  maxPages?: number
  timeoutMs?: number
  /** Acknowledged pages only. This lets an outer deadline retain committed
   * progress while a later remote read is still pending. */
  onProgress?: (summary: ShellbeamAgentHistorySyncSummary) => void
}
export const SHELLBEAM_AGENT_HISTORY_CHANGED_EVENT = 'shellbeam-agent-history-changed'
const sessionSummaries = new Map<string, ShellbeamAgentHistorySyncSummary>()
const summaryKey = (vaultId: string, hostId: string, nodeId: string) => JSON.stringify([vaultId, hostId, 'shellbeam-agent', nodeId])
export function getShellbeamAgentHistorySummary(vaultId: string, hostId: string, nodeId: string) {
  return sessionSummaries.get(summaryKey(vaultId, hostId, nodeId)) ?? null
}
export function subscribeShellbeamAgentHistorySummary(listener: () => void) {
  window.addEventListener(SHELLBEAM_AGENT_HISTORY_CHANGED_EVENT, listener)
  return () => window.removeEventListener(SHELLBEAM_AGENT_HISTORY_CHANGED_EVENT, listener)
}
export function publishShellbeamAgentHistorySummary(summary: ShellbeamAgentHistorySyncSummary) {
  // These are session diagnostics, not historical samples or a health state.
  const safe: ShellbeamAgentHistorySyncSummary = { vaultId: summary.vaultId, hostId: summary.hostId, providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', nodeId: summary.nodeId, status: summary.status, reason: summary.reason, imported: summary.imported, pages: summary.pages, hasMore: summary.hasMore, cursor: summary.cursor }
  const key = summaryKey(safe.vaultId, safe.hostId, safe.nodeId)
  sessionSummaries.delete(key)
  sessionSummaries.set(key, safe)
  if (sessionSummaries.size > 256) sessionSummaries.delete(sessionSummaries.keys().next().value!)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SHELLBEAM_AGENT_HISTORY_CHANGED_EVENT, { detail: safe }))
}

export function getShellbeamAgentHistoryCursor(vaultId: string, hostId: string, nodeId: string) {
  return invoke<ShellbeamAgentHistoryCursor>('get_provider_history_cursor', { query: { vaultId, hostId, providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', nodeId } })
}
class HistoryError extends Error {
  readonly reason: ShellbeamAgentHistoryReason
  constructor(reason: ShellbeamAgentHistoryReason) { super(`agent_history_${reason.replaceAll('-', '_')}`); this.reason = reason }
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const hasControl = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

function scopeFor(options: ShellbeamAgentHistorySyncOptions): ShellbeamAgentHistoryScope {
  const { vaultId, host, record } = options
  if (!vaultId.trim() || vaultId !== vaultId.trim() || !host.id || host.vaultId && host.vaultId !== vaultId
    || record.vaultId !== vaultId || record.hostId !== host.id || record.providerKind !== 'shellbeam-agent'
    || !record.agentId.trim() || record.agentId.length > 160 || hasControl(record.agentId)) throw new HistoryError('scope-mismatch')
  return { vaultId, hostId: host.id, providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', nodeId: record.agentId }
}

export function buildShellbeamAgentHistoryCommand(options: { agentId: string; after: number; through: number; limit?: number }) {
  const { agentId, after, through, limit = SHELLBEAM_AGENT_HISTORY_PAGE_POINTS } = options
  if (!agentId || agentId.length > 160 || hasControl(agentId) || !integer(after) || !integer(through) || after > through
    || !integer(limit) || limit < 1 || limit > protocol.maxPoints) throw new HistoryError('invalid-page')
  return `if [ -x "$HOME/.local/bin/shellbeam-agent" ]; then
  sb_agent="$HOME/.local/bin/shellbeam-agent"
elif command -v shellbeam-agent >/dev/null 2>&1; then
  sb_agent=$(command -v shellbeam-agent)
else
  printf '%s\\n' '__SB_AGENT_HISTORY_UNAVAILABLE'; exit 127
fi
if ! "$sb_agent" --help 2>/dev/null | head -c 4096 | grep -q 'history-page'; then
  printf '%s\\n' '__SB_AGENT_HISTORY_UNAVAILABLE'; exit 127
fi
"$sb_agent" history-page --json --agent-id ${quote(agentId)} --after ${after} --through ${through} --limit ${limit}`
}

/** Decode only the bounded public metric schema. A malformed page is rejected
 * as a unit, so its cursor cannot skip a point we failed to retain. */
export function parseShellbeamAgentHistoryPage(output: string, options: { host: HostProfile; record: ShellbeamAgentRecord; after: number; through: number; receivedAt: number }): ShellbeamAgentHistoryPage {
  if (new TextEncoder().encode(output).byteLength > SHELLBEAM_AGENT_HISTORY_PAGE_BYTES) throw new HistoryError('invalid-page')
  let page: unknown
  try { page = JSON.parse(output) } catch { throw new HistoryError('invalid-page') }
  const { host, record, after, through, receivedAt } = options
  if (!object(page) || page.schemaVersion !== protocol.schemaVersion || page.agentId !== record.agentId
    || typeof page.version !== 'string' || !page.version || page.version.length > 80 || record.version && page.version !== record.version
    || page.after !== after || page.through !== through || !integer(page.nextCursor) || page.nextCursor < after || page.nextCursor > through
    || !integer(receivedAt) || through > receivedAt || typeof page.hasMore !== 'boolean'
    || !Array.isArray(page.points) || page.points.length > protocol.maxPoints) throw new HistoryError('invalid-page')
  const byTime = new Map<number, ProviderMetricHistoryPoint>()
  for (const row of page.points) {
    if (!object(row) || row.schemaVersion !== protocol.schemaVersion || row.agentId !== record.agentId || !integer(row.sampledAt)
      || row.sampledAt <= after || row.sampledAt > through || row.sampledAt > receivedAt || !object(row.metrics)
      || row.metrics.sampledAt !== undefined && row.metrics.sampledAt !== row.sampledAt
      || !integer(row.heartbeatTtlMs) || row.heartbeatTtlMs < 1 || !Number.isSafeInteger(row.sampledAt + row.heartbeatTtlMs)
      || row.providerKind !== undefined && row.providerKind !== 'shellbeam-agent'
      || row.nodeId !== undefined && row.nodeId !== record.agentId
      || row.hostId !== undefined && row.hostId !== host.id) throw new HistoryError('invalid-page')
    if (object(row.provider) && (row.provider.kind !== 'shellbeam-agent' || row.provider.id !== 'shellbeam-agent' || row.provider.nodeId !== record.agentId)) throw new HistoryError('invalid-page')
    const observation = parseShellbeamAgentObservation(JSON.stringify(row), { ...record, heartbeatTtlMs: row.heartbeatTtlMs }, host, receivedAt).metrics
    if (!observation || observation.freshness.sampledAt !== row.sampledAt) throw new HistoryError('invalid-page')
    // Keep the first original observation at a timestamp. Native import also
    // uses INSERT OR IGNORE; re-reading an old page never edits a newer row.
    if (!byTime.has(row.sampledAt)) byTime.set(row.sampledAt, observationToMetricHistoryPoint(observation, host.id))
  }
  const points = [...byTime.values()].sort((left, right) => left.sampledAt - right.sampledAt)
  const last = points.at(-1)?.sampledAt ?? after
  if (page.nextCursor !== last || page.hasMore && (points.length === 0 || page.nextCursor >= through)) throw new HistoryError('invalid-page')
  return { after, through, nextCursor: page.nextCursor, hasMore: page.hasMore, points }
}

function cursorNumber(value: string | null) {
  if (value === null) return 0
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !integer(Number(value))) throw new HistoryError('persistence-error')
  return Number(value)
}
function validateCursor(value: ShellbeamAgentHistoryCursor) {
  if (!value || !integer(value.revision)) throw new HistoryError('persistence-error')
  cursorNumber(value.cursor)
  return value
}

/** One host's bounded catch-up pass. Only the dedicated native transaction
 * advances the cursor; a successful latest probe is never used as its value. */
export async function syncShellbeamAgentHistory(options: ShellbeamAgentHistorySyncOptions): Promise<ShellbeamAgentHistorySyncSummary> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(SHELLBEAM_AGENT_HISTORY_TIMEOUT_MS, Math.max(1000, options.timeoutMs!)) : SHELLBEAM_AGENT_HISTORY_TIMEOUT_MS
  const isCurrent = options.isCurrent ?? (() => true)
  const maxPages = Number.isFinite(options.maxPages) ? Math.min(SHELLBEAM_AGENT_HISTORY_MAX_PAGES, Math.max(1, Math.floor(options.maxPages!))) : SHELLBEAM_AGENT_HISTORY_MAX_PAGES
  let summary: ShellbeamAgentHistorySyncSummary = { vaultId: options.vaultId, hostId: options.host.id, providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', nodeId: options.record.agentId, status: 'failed', reason: 'persistence-error', imported: 0, pages: 0, hasMore: null, cursor: null }
  let stage: 'remote' | 'persist' = 'persist'
  const gate = () => {
    if (!isCurrent()) throw new HistoryError('interrupted')
    if (now() - startedAt >= timeoutMs) throw new HistoryError('timeout')
  }
  try {
    const scope = scopeFor(options)
    summary = { ...summary, ...scope }
    gate()
    let state = validateCursor(await invoke<ShellbeamAgentHistoryCursor>('get_provider_history_cursor', { query: scope }))
    summary.cursor = state.cursor
    gate()
    const through = options.record.lastHeartbeatAt
    if (!integer(through) || through === 0 || through > now()) throw new HistoryError('clock-rollback')
    let after = cursorNumber(state.cursor)
    if (after > through) throw new HistoryError('clock-rollback')
    if (after === through) return { ...summary, status: 'complete', reason: 'complete', hasMore: false }
    for (let index = 0; index < maxPages; index += 1) {
      gate()
      stage = 'remote'
      const result = await runWorkspaceRemoteCommand({ host: options.host, vaultId: scope.vaultId, resolveAuthSecret: options.resolveAuthSecret,
        command: buildShellbeamAgentHistoryCommand({ agentId: scope.nodeId, after, through }),
        timeoutMs: Math.max(1000, timeoutMs - Math.max(0, now() - startedAt)), audit: { action: 'agent.history', target: 'bounded agent metric history' } })
      gate()
      if (result.stdout.trim() === '__SB_AGENT_HISTORY_UNAVAILABLE' && result.exitCode === 127) throw new HistoryError('history-unavailable')
      if (remoteOperationStatus(result) !== 'completed') throw new HistoryError('transport-error')
      const page = parseShellbeamAgentHistoryPage(result.stdout, { host: options.host, record: options.record, after, through, receivedAt: now() })
      gate()
      stage = 'persist'
      const nextCursor = page.nextCursor === 0 ? null : String(page.nextCursor)
      const committed = await invoke<ShellbeamAgentHistoryCursor & { appended: number }>('append_provider_history_page', { payload: { ...scope, expectedRevision: state.revision, expectedCursor: state.cursor, nextCursor, points: page.points, exhausted: !page.hasMore } })
      validateCursor(committed)
      if (committed.cursor !== nextCursor || committed.revision !== state.revision + 1 || !integer(committed.appended) || committed.appended > page.points.length) throw new HistoryError('persistence-error')
      state = committed
      after = page.nextCursor
      summary = { ...summary, cursor: state.cursor, imported: summary.imported + committed.appended, pages: summary.pages + 1, hasMore: page.hasMore }
      gate()
      options.onProgress?.({ ...summary, status: page.hasMore ? 'partial' : 'complete', reason: page.hasMore ? 'page-budget' : 'complete' })
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('provider-metric-history-changed', { detail: { vaultId: scope.vaultId } }))
      if (!page.hasMore) return { ...summary, status: 'complete', reason: 'complete', hasMore: false }
    }
    return { ...summary, status: 'partial', reason: 'page-budget', hasMore: true }
  } catch (error) {
    const reason = error instanceof HistoryError ? error.reason : String(error).includes('history_cursor_conflict') ? 'cursor-conflict' : stage === 'remote' ? 'transport-error' : 'persistence-error'
    return { ...summary, status: reason === 'history-unavailable' ? 'unavailable' : reason === 'interrupted' ? 'cancelled' : 'failed', reason }
  }
}
