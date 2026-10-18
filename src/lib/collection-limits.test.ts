import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { COLLECTION_LIMITS, collectionConcurrency, collectionCommandTimeoutMs, renderProbeCollector } from './collection-limits'
import { DEFAULT_PROBE_SCHEDULER_CONCURRENCY } from './probe-scheduler'
import { SERVER_MONITOR_CONCURRENCY, SERVER_MONITOR_HISTORY_MS, SERVER_MONITOR_INTERVAL_MS } from './server-monitor-scan'
import { WORKSPACE_INVENTORY_REFRESH_INTERVAL_MS } from './workspace-inventory-scan'
import { DEFAULT_AGENTLESS_INVENTORY_TTL_MS, DEFAULT_AGENTLESS_METRICS_TTL_MS, createAgentlessSshProbeProvider } from './probe-provider'
import { DEFAULT_PROBE_RECOVERY_MAX_RETRIES, DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS, MAX_PROBE_RECOVERY_RETRY_DELAY_MS } from './probe-scheduler-constants'
import { MAX_PROBE_RECOVERY_RETRIES } from './probe-retry-settings'
import { PROVIDER_HISTORY_RETENTION_MS, appendProviderMetricHistory } from './provider-history'
import { buildUnifiedProbeCommand, fetchUnifiedProbe, parseUnifiedProbeOutput, UNIFIED_PROBE_OUTPUT_LIMIT } from './unified-probe'
import { parseWorkspaceInventory } from './workspace-inventory'
import { toPersistedProbeSnapshotPayload } from './probe-persistence'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { invoke } from '@tauri-apps/api/core'

vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const fixture = readFileSync('shared/fixtures/linux-probe-v1.txt', 'utf8')
const host = { id: 'machine', vaultId: 'vault-a', name: 'machine', address: '192.0.2.1', port: 22, username: 'ops', authType: 'password' as const, group: '', tags: [], createdAt: 1, updatedAt: 1 }

describe('Shared collection policy', () => {
  it('uses the compiled shared source for scheduler, scan, freshness and storage budgets', () => {
    expect(COLLECTION_LIMITS).toEqual(JSON.parse(readFileSync('shared/collection-limits.json', 'utf8')))
    expect(DEFAULT_PROBE_SCHEDULER_CONCURRENCY).toBe(COLLECTION_LIMITS.scheduler.concurrency)
    expect(SERVER_MONITOR_CONCURRENCY).toBe(COLLECTION_LIMITS.scheduler.concurrency)
    expect(SERVER_MONITOR_INTERVAL_MS).toBe(COLLECTION_LIMITS.cadence.monitorIntervalMs)
    expect(WORKSPACE_INVENTORY_REFRESH_INTERVAL_MS).toBe(COLLECTION_LIMITS.cadence.inventoryIntervalMs)
    expect(DEFAULT_AGENTLESS_METRICS_TTL_MS).toBe(COLLECTION_LIMITS.cadence.metricsTtlMs)
    expect(DEFAULT_AGENTLESS_INVENTORY_TTL_MS).toBe(COLLECTION_LIMITS.cadence.inventoryTtlMs)
    expect(SERVER_MONITOR_HISTORY_MS).toBe(COLLECTION_LIMITS.history.monitorRetentionMs)
    expect(PROVIDER_HISTORY_RETENTION_MS).toBe(COLLECTION_LIMITS.history.retentionMs)
    expect(DEFAULT_PROBE_RECOVERY_MAX_RETRIES).toBe(COLLECTION_LIMITS.scheduler.defaultRetries)
    expect(MAX_PROBE_RECOVERY_RETRIES).toBe(COLLECTION_LIMITS.scheduler.maxRetries)
    expect(DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS).toBe(COLLECTION_LIMITS.scheduler.retryDelayMs)
    expect(MAX_PROBE_RECOVERY_RETRY_DELAY_MS).toBe(COLLECTION_LIMITS.scheduler.maxRetryDelayMs)
    expect(UNIFIED_PROBE_OUTPUT_LIMIT).toBe(COLLECTION_LIMITS.remote.outputBytes)
  })

  it('renders a complete bounded shell script without leaving configuration on the remote host', () => {
    const script = renderProbeCollector(readFileSync('shared/probe-collector.sh', 'utf8'))
    expect(script).not.toContain('__SB_LIMIT_')
    expect(buildUnifiedProbeCommand()).not.toContain('__SB_LIMIT_')
    expect(script).toContain(`timeout ${COLLECTION_LIMITS.collector.optionalCommandTimeoutSeconds}`)
    expect(script).toContain(`-maxdepth ${COLLECTION_LIMITS.collector.projectDepth}`)
    expect(script).toContain(`head -n ${COLLECTION_LIMITS.collector.portRows}`)
    expect(() => renderProbeCollector('__SB_LIMIT_missing__')).toThrow('PROBE_LIMIT_INVALID:missing')
  })

  it('normalizes invalid worker options and never widens an explicit desktop command timeout', () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(collectionConcurrency(invalid)).toBe(COLLECTION_LIMITS.scheduler.concurrency)
      expect(collectionCommandTimeoutMs(invalid)).toBe(COLLECTION_LIMITS.remote.commandTimeoutMs)
    }
    expect(collectionConcurrency(0)).toBe(1)
    expect(collectionConcurrency(2.9)).toBe(2)
    expect(collectionCommandTimeoutMs(0)).toBe(COLLECTION_LIMITS.remote.minCommandTimeoutMs)
    expect(collectionCommandTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(COLLECTION_LIMITS.remote.commandTimeoutMs)
    expect(collectionCommandTimeoutMs(COLLECTION_LIMITS.remote.collectorTimeoutMs)).toBe(COLLECTION_LIMITS.remote.collectorTimeoutMs)
  })

  it('passes the shared collector deadline and one read-only audit operation to the transport', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: fixture, stderr: '', exitCode: 0, durationMs: 1 })
    await fetchUnifiedProbe({ host, vaultId: 'vault-a', resolveAuthSecret: async () => '', section: 'all' })
    expect(runWorkspaceRemoteCommand).toHaveBeenLastCalledWith(expect.objectContaining({ vaultId: 'vault-a', timeoutMs: COLLECTION_LIMITS.remote.collectorTimeoutMs, audit: { action: 'probe.collect', target: 'host all' } }))
  })

  it('preserves collected architecture through Workspace, canonical provider and persistence without guessing legacy values', async () => {
    const parsed = parseUnifiedProbeOutput(fixture, 1792281600100)
    expect(parsed.inventory.resource.arch).toBe('x86_64')
    expect(parseWorkspaceInventory(fixture).resource.arch).toBe('x86_64')
    expect(parseWorkspaceInventory('__SB_HOSTNAME=old-host').resource.arch).toBeNull()
    const unknown = parseUnifiedProbeOutput(fixture.replace(/^__SB_PROBE_ARCH=.*\n/m, ''), 1792281600100)
    expect(unknown.inventory.resource.arch).toBeNull()
    const provider = createAgentlessSshProbeProvider({ dependencies: { collect: async () => parsed } })
    const snapshot = await provider.probe({ host, resolveAuthSecret: async () => '', now: 1792281600100 })
    const persisted = JSON.parse(JSON.stringify(toPersistedProbeSnapshotPayload(snapshot, 'vault-a')))
    expect(persisted.snapshot.inventory.data.resource.arch).toBe('x86_64')
  })

  it('enforces the same output and row limits and chunks IPC below the native batch ceiling', async () => {
    expect(() => parseUnifiedProbeOutput('x'.repeat(COLLECTION_LIMITS.remote.outputBytes + 1))).toThrow('OUTPUT_LIMIT')
    const rows = Array.from({ length: COLLECTION_LIMITS.collector.portRows + 5 }, (_, index) => `__SB_PROBE_PORT=tcp ${index}`).join('\n')
    expect(parseUnifiedProbeOutput(fixture.replace('__SB_PROBE_END', `${rows}\n__SB_PROBE_END`), 1792281600100).inventory.listeningPorts).toHaveLength(COLLECTION_LIMITS.collector.portRows)
    vi.mocked(invoke).mockClear().mockResolvedValue(undefined)
    await appendProviderMetricHistory('vault-a', Array.from({ length: COLLECTION_LIMITS.history.appendChunkPoints + 1 }, () => ({}) as never))
    const calls = vi.mocked(invoke).mock.calls.filter(([name]) => name === 'append_provider_metric_history')
    expect(calls).toHaveLength(2)
    expect((calls[0][1] as { payload: { points: unknown[] } }).payload.points).toHaveLength(COLLECTION_LIMITS.history.appendChunkPoints)
    expect((calls[1][1] as { payload: { points: unknown[] } }).payload.points).toHaveLength(1)
  })
})
