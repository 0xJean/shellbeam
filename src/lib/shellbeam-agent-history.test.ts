import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { normalizeShellbeamAgentRecord } from './shellbeam-agent'
import { createShellbeamAgentScheduler } from './shellbeam-agent-scheduler'
import { buildShellbeamAgentHistoryCommand, parseShellbeamAgentHistoryPage, syncShellbeamAgentHistory, SHELLBEAM_AGENT_HISTORY_PAGE_BYTES, type ShellbeamAgentHistoryCursor } from './shellbeam-agent-history'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
const now = 1_800_000_100_000
const one = now - 60_000
const two = now - 30_000
const host = { id: 'edge', vaultId: 'vault-a', name: 'edge', address: '192.0.2.1', port: 22, username: 'ops', authType: 'privateKey' as const, group: '', tags: [], createdAt: 1, updatedAt: 1, jumpHostId: 'jump' }
const record = normalizeShellbeamAgentRecord({ vaultId: 'vault-a', hostId: host.id, status: 'installed', health: 'online', providerKind: 'shellbeam-agent', agentId: 'node-a', version: '0.1.0', capabilities: ['heartbeat', 'metrics'], lastHeartbeatAt: two, heartbeatTtlMs: 180000, transport: 'proxy-jump' }, now)
const point = (at: number, cpu: number | null = 20) => ({ schemaVersion: 1, agentId: 'node-a', version: '0.0.9', sampledAt: at, heartbeatTtlMs: 180000, status: 'installed', health: 'online', metrics: { sampledAt: at, cpuPercent: cpu, token: 'must-not-persist' }, rawCommand: 'must-not-persist' })
const frame = (points = [point(one), point(two)], extra: object = {}) => JSON.stringify({ schemaVersion: 1, agentId: 'node-a', version: '0.1.0', after: 0, through: two, nextCursor: points.at(-1)?.sampledAt ?? 0, hasMore: false, points, ...extra })
const options = { host, record, vaultId: 'vault-a', resolveAuthSecret: vi.fn(async () => 'not-transferred'), now: () => now }
let durable: ShellbeamAgentHistoryCursor
beforeEach(() => {
  durable = { cursor: null, revision: 0, updatedAt: null, exhausted: false, reason: 'not-started' }
  vi.mocked(invoke).mockReset().mockImplementation(async (name, args) => {
    if (name === 'get_provider_history_cursor') return { ...durable }
    if (name === 'append_provider_history_page') {
      const payload = (args as { payload: { nextCursor: string | null; exhausted: boolean; points: unknown[] } }).payload
      durable = { cursor: payload.nextCursor, revision: durable.revision + 1, updatedAt: now, exhausted: payload.exhausted, reason: payload.exhausted ? 'complete' : 'page-imported' }
      return { ...durable, appended: payload.points.length }
    }
    throw new Error('unexpected command')
  })
  vi.mocked(runWorkspaceRemoteCommand).mockReset().mockResolvedValue({ stdout: frame(), stderr: '', exitCode: 0, durationMs: 1 })
})
afterEach(() => vi.restoreAllMocks())
describe('Bounded Agent history import', () => {
  it('runs history catch-up by default through the production probe, lifecycle, latest snapshot and page import chain', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const historyImplementation = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (name, args) => {
      if (name === 'upsert_shellbeam_agent') return record
      if (name === 'upsert_probe_snapshot' || name === 'append_provider_metric_history') return
      return historyImplementation(name, args)
    })
    vi.mocked(runWorkspaceRemoteCommand).mockImplementation(async (request) => ({ stdout: request.command.includes('history-page --json') ? frame() : JSON.stringify({ ...point(two), version: '0.1.0', lastHeartbeatAt: two }), stderr: '', exitCode: 0, durationMs: 1 }))
    const onHistory = vi.fn()
    const scheduler = createShellbeamAgentScheduler({ hosts: [host], vaultId: 'vault-a', resolveAuthSecret: options.resolveAuthSecret, now: () => now, onHistory })
    const result = await scheduler.scanNow()
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls[0][0].command).toContain('probe --json')
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls[1][0].command).toContain('history-page --json')
    expect(result.history[0]).toMatchObject({ status: 'complete', pages: 1, hostId: host.id, nodeId: record.agentId })
    expect(result.records[0].health).toBe('online')
    expect(onHistory).toHaveBeenCalledWith(result.history[0])
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toContain('append_provider_history_page')
  })
  it('retains an acknowledged page when the scheduler deadline interrupts the next real history read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const historyImplementation = vi.mocked(invoke).getMockImplementation()!
      vi.mocked(invoke).mockImplementation(async (name, args) => {
        if (name === 'upsert_shellbeam_agent') return record
        if (name === 'upsert_probe_snapshot' || name === 'append_provider_metric_history') return
        return historyImplementation(name, args)
      })
      let historyReads = 0
      vi.mocked(runWorkspaceRemoteCommand).mockImplementation(async (request) => {
        if (!request.command.includes('history-page --json')) return { stdout: JSON.stringify({ ...point(two), version: '0.1.0', lastHeartbeatAt: two }), stderr: '', exitCode: 0, durationMs: 1 }
        historyReads += 1
        if (historyReads === 1) return { stdout: frame([point(one)], { nextCursor: one, hasMore: true }), stderr: '', exitCode: 0, durationMs: 1 }
        return new Promise<never>(() => undefined)
      })
      const onHistory = vi.fn()
      const scheduler = createShellbeamAgentScheduler({ hosts: [host], vaultId: 'vault-a', resolveAuthSecret: options.resolveAuthSecret, now: () => now, onHistory })
      const scan = scheduler.scanNow()
      await vi.advanceTimersByTimeAsync(0)
      expect(historyReads).toBe(2)
      expect(durable.cursor).toBe(String(one))
      await vi.advanceTimersByTimeAsync(30_001)
      const result = await scan
      expect(result.history[0]).toMatchObject({ status: 'failed', reason: 'timeout', imported: 1, pages: 1, cursor: String(one), hasMore: true })
      expect(onHistory).toHaveBeenCalledWith(result.history[0])
      expect(result.records[0].health).toBe('online')
    } finally { vi.useRealTimers() }
  })
  it('sorts and deduplicates original samples without inventing a gap or retaining unknown fields', () => {
    const parsed = parseShellbeamAgentHistoryPage(frame([point(two), point(one, null), point(two, 99)], { nextCursor: two }), { host, record, after: 0, through: two, receivedAt: now })
    expect(parsed.points.map((entry) => entry.sampledAt)).toEqual([one, two])
    expect(parsed.points.map((entry) => entry.metrics.cpuPercent)).toEqual([null, 20])
    expect(parsed.points.every((entry) => entry.providerId === 'shellbeam-agent' && entry.nodeId === 'node-a' && entry.hostId === host.id)).toBe(true)
    expect(parsed.points[0].receivedAt).toBe(now)
    expect(parsed.points[0].expiresAt).toBe(one + 180000)
    expect(JSON.stringify(parsed)).not.toContain('must-not-persist')
  })
  it('rejects foreign identities, future samples, inconsistent watermarks, bad frames and byte overflow', () => {
    const invalid = [frame([], { nextCursor: two }), frame([point(one)], { agentId: 'other' }), frame([point(now + 1)], { through: now + 1, nextCursor: now + 1 }), frame([point(one)], { nextCursor: two }), frame([point(one)], { after: 1 }), frame([{ ...point(one), agentId: 'other' }]), frame([{ ...point(one), schemaVersion: 2 }]), frame([{ ...point(one), metrics: { sampledAt: two, cpuPercent: 1, token: '' } }]), frame([], { hasMore: true }), '{', '界'.repeat(Math.ceil(SHELLBEAM_AGENT_HISTORY_PAGE_BYTES / 3) + 1)]
    for (const output of invalid) expect(() => parseShellbeamAgentHistoryPage(output, { host, record, after: 0, through: two, receivedAt: now })).toThrow('agent_history_invalid_page')
  })
  it.each([undefined, 'jump'])('uses the same saved-host remote path, then atomically imports the page (%s)', async (jumpHostId) => {
    const onProgress = vi.fn()
    const result = await syncShellbeamAgentHistory({ ...options, host: { ...host, jumpHostId }, onProgress })
    expect(result).toMatchObject({ status: 'complete', imported: 2, pages: 1, cursor: String(two), hasMore: false })
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(result)
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ vaultId: 'vault-a', host: { ...host, jumpHostId }, timeoutMs: 30000, audit: { action: 'agent.history', target: 'bounded agent metric history' } }))
    expect(invoke).toHaveBeenLastCalledWith('append_provider_history_page', { payload: expect.objectContaining({ vaultId: 'vault-a', hostId: host.id, providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', nodeId: 'node-a', expectedCursor: null, expectedRevision: 0, nextCursor: String(two), exhausted: true }) })
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain('must-not-persist')
  })
  it('does not advance past a page budget and resumes from the durable cursor on the next pass', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: frame([point(one)], { nextCursor: one, hasMore: true }), stderr: '', exitCode: 0, durationMs: 1 })
    expect(await syncShellbeamAgentHistory({ ...options, maxPages: 1 })).toMatchObject({ status: 'partial', reason: 'page-budget', imported: 1, cursor: String(one), hasMore: true })
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: frame([point(two)], { after: one }), stderr: '', exitCode: 0, durationMs: 1 })
    expect(await syncShellbeamAgentHistory(options)).toMatchObject({ status: 'complete', imported: 1, cursor: String(two) })
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls[1][0].command).toContain(`--after ${one}`)
  })
  it('keeps the cursor on persistence failure/lock and retries from that same cursor after unlock', async () => {
    const onProgress = vi.fn()
    const working = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementationOnce(working).mockRejectedValueOnce(new Error('VAULT_LOCKED'))
    expect(await syncShellbeamAgentHistory({ ...options, onProgress })).toMatchObject({ status: 'failed', reason: 'persistence-error', imported: 0, cursor: null })
    expect(onProgress).not.toHaveBeenCalled()
    expect(durable.cursor).toBeNull()
    expect(await syncShellbeamAgentHistory(options)).toMatchObject({ status: 'complete', imported: 2 })
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls[1][0].command).toContain('--after 0')
  })
  it('reports old Agent capability as unavailable without legacy unbounded history fallback', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: '__SB_AGENT_HISTORY_UNAVAILABLE\n', stderr: '', exitCode: 127, durationMs: 1 })
    expect(await syncShellbeamAgentHistory(options)).toMatchObject({ status: 'unavailable', reason: 'history-unavailable', imported: 0 })
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(['get_provider_history_cursor'])
    expect(buildShellbeamAgentHistoryCommand({ agentId: 'node-a', after: 0, through: two })).toContain('history-page --json --agent-id')
    expect(buildShellbeamAgentHistoryCommand({ agentId: 'node-a', after: 0, through: two })).not.toContain(' history --json')
  })
  it('does not issue an import after a cancelled read or a foreign Vault/host/node response', async () => {
    let current = true
    vi.mocked(runWorkspaceRemoteCommand).mockImplementationOnce(async () => { current = false; return { stdout: frame(), stderr: '', exitCode: 0, durationMs: 1 } })
    expect(await syncShellbeamAgentHistory({ ...options, isCurrent: () => current })).toMatchObject({ status: 'cancelled', reason: 'interrupted' })
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(['get_provider_history_cursor'])
    vi.mocked(invoke).mockClear()
    expect(await syncShellbeamAgentHistory({ ...options, host: { ...host, vaultId: 'other-vault' } })).toMatchObject({ reason: 'scope-mismatch' })
    expect(invoke).not.toHaveBeenCalled()
  })
  it('retains durable progress for CAS conflicts and transport failures, never substituting the latest heartbeat', async () => {
    durable = { ...durable, cursor: String(one), revision: 4 }
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: frame([point(two)], { after: one }), stderr: '', exitCode: 0, durationMs: 1 })
    const implementation = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementationOnce(implementation).mockRejectedValueOnce('history_cursor_conflict')
    expect(await syncShellbeamAgentHistory(options)).toMatchObject({ reason: 'cursor-conflict', cursor: String(one) })
    expect(durable.cursor).toBe(String(one))
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: frame([point(two)], { after: one }), stderr: '', exitCode: 0, durationMs: 1, errorType: 'unknown' })
    expect(await syncShellbeamAgentHistory(options)).toMatchObject({ reason: 'transport-error', cursor: String(one) })
    expect(durable.cursor).toBe(String(one))
  })
})
