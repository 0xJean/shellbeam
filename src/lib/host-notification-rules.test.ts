import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { vaultGetSecret, vaultStatus } from './vault'
import { readOfflineRule, syncHostRules, writeOfflineRule, type HostRuleIntent, type RuleObservation } from './host-notification-rules'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./vault', () => ({ vaultGetSecret: vi.fn(), vaultStatus: vi.fn() }))
const identity = 'node:2026-01-01T00:00:00Z'
const node = { uuid: 'node', created_at: '2026-01-01T00:00:00Z', name: 'WEB', group: 'prod', tags: 'web', token: 'never-retain-agent-token' }
const observed = (enabled = false, gracePeriod = 180): RuleObservation => ({ identity, rule: { enabled, gracePeriod } })
let sequence = 0
const intent = (): HostRuleIntent => ({ id: `intent-${++sequence}`, vaultId: 'v', hostId: 'h', integrationId: 'i', nodeId: 'node', endpoint: 'https://monitor.test', credentialRef: 'existing-ref', integrationVersion: 1, mappingRevision: 2, hostCreatedAt: 1, baseline: observed(), remote: observed(), desired: { enabled: true, gracePeriod: 60 }, status: 'pending', version: 1, jobId: 'same-job', errorCode: null, observedAt: 1, updatedAt: 1 })
beforeEach(() => { vi.resetAllMocks(); vi.mocked(vaultStatus).mockResolvedValue({ initialized: true, unlocked: true, secretCount: 1 }); vi.mocked(vaultGetSecret).mockResolvedValue('never-persist-access') })
afterEach(() => vi.unstubAllGlobals())
function server(initial = observed().rule, onPost?: () => void) {
  let current = initial
  return vi.fn<typeof fetch>(async (url, options) => {
    if (options?.method === 'POST') { onPost?.(); const [body] = JSON.parse(String(options.body)); current = { enabled: body.enable, gracePeriod: body.grace_period }; return new Response(JSON.stringify({ status: 'success' })) }
    if (String(url).endsWith('/api/version')) return new Response(JSON.stringify({ version: '1.6.0' }))
    if (String(url).endsWith('/api/admin/client/node')) return new Response(JSON.stringify(node))
    return new Response(JSON.stringify(current ? [{ client: 'node', enable: current.enabled, grace_period: current.gracePeriod, last_notified: 'runtime-field', client_info: node }] : []))
  })
}
function bridge(row: HostRuleIntent, sending?: () => void) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'host_metadata_session') return 9
    if (command === 'list_host_notification_rules') return [structuredClone(row)]
    const input = (args as { input: { action: string; session: number; remote?: RuleObservation } }).input
    expect(input.session).toBe(9)
    if (input.action === 'observe') {
      row.remote = input.remote!
      if (JSON.stringify(row.remote.rule) === JSON.stringify(row.desired)) row.status = 'synced'
      else if (JSON.stringify(row.remote) !== JSON.stringify(row.baseline)) row.status = 'conflict'
      else if (row.status === 'applying') row.status = 'failed'
    }
    if (input.action === 'sending') { row.status = 'applying'; sending?.() }
    if (input.action === 'error') row.status = 'failed'
    row.version++
    return structuredClone(row)
  })
}
describe('offline notification rule contract', () => {
  it('reads exact values and writes only the selected node and two supported fields', async () => {
    const fetcher = server(); const config = { endpoint: 'https://monitor.test', token: 'never-persist-access' }
    const result = await readOfflineRule(config, 'node', undefined, fetcher)
    expect(result).toEqual(observed()); expect(JSON.stringify(result)).not.toContain('token')
    await writeOfflineRule(config, 'node', { enabled: true, gracePeriod: 45 }, undefined, fetcher)
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual([{ client: 'node', enable: true, grace_period: 45 }])
    expect(await readOfflineRule(config, 'node', undefined, fetcher)).toEqual(observed(true, 45))
  })
  it('keeps absence distinct and rejects unsupported versions, malformed/duplicate rules and invalid periods', async () => {
    expect((await readOfflineRule({ endpoint: 'https://monitor.test' }, 'node', undefined, server(null))).rule).toBeNull()
    for (const data of [{ count: 1 }, [{ client: 'node', enable: 'true', grace_period: 180 }], [{ client: 'node', enable: false, grace_period: 0 }], [{ client: 'node' }, { client: 'node' }]]) {
      const fetcher = server(); fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { version: '1.6.0' } : String(url).endsWith('/api/admin/client/node') ? node : data)))
      await expect(readOfflineRule({ endpoint: 'https://monitor.test' }, 'node', undefined, fetcher)).rejects.toMatchObject({ code: 'invalid-response' })
    }
    const unsupported = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ version: '2.0.0' })))
    await expect(readOfflineRule({ endpoint: 'https://monitor.test' }, 'node', undefined, unsupported)).rejects.toMatchObject({ code: 'endpoint-version' })
    expect(unsupported).toHaveBeenCalledTimes(1)
    await expect(writeOfflineRule({ endpoint: 'https://monitor.test' }, 'node', { enabled: true, gracePeriod: NaN }, undefined, unsupported)).rejects.toThrow('HOST_RULE_INVALID')
  })
})
describe('durable rule worker', () => {
  it('bounds recovery to two requests and ten intents per tick, with a read TTL and no POST', async () => {
    const rows = Array.from({ length: 12 }, () => ({ ...intent(), status: 'failed' as const }))
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'host_metadata_session') return 9
      if (command === 'list_host_notification_rules') return rows
      const input = (args as { input: { id: string; action: string } }).input
      expect(input.action).toBe('observe')
      return rows.find(row => row.id === input.id)
    })
    const respond = server()
    let concurrent = 0; let peak = 0
    const fetcher = vi.fn<typeof fetch>(async (...args) => {
      concurrent++; peak = Math.max(peak, concurrent)
      await new Promise(done => setTimeout(done, 1))
      try { return await respond(...args) } finally { concurrent-- }
    })
    vi.stubGlobal('fetch', fetcher)
    await syncHostRules('v', () => true)
    expect(vaultGetSecret).toHaveBeenCalledTimes(10)
    expect(peak).toBe(2)
    await syncHostRules('v', () => true)
    expect(vaultGetSecret).toHaveBeenCalledTimes(12)
    await syncHostRules('v', () => true)
    expect(vaultGetSecret).toHaveBeenCalledTimes(12)
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })
  it('claims before one write, verifies afterward and never sends credentials to persistence', async () => {
    const row = intent(); bridge(row)
    const fetcher = server(observed().rule, () => expect(row.status).toBe('applying')); vi.stubGlobal('fetch', fetcher)
    await syncHostRules('v', () => true)
    expect(row.status).toBe('synced'); expect(row.jobId).toBe('same-job')
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toMatch(/never-persist|never-retain|last_notified/)
  })
  it.each([true, false])('recovers interrupted writes by readback only (applied=%s)', async applied => {
    const row = { ...intent(), status: 'applying' as const }; bridge(row)
    const fetcher = server(applied ? row.desired : row.baseline.rule); vi.stubGlobal('fetch', fetcher)
    await syncHostRules('v', () => true)
    expect(row.status).toBe(applied ? 'synced' : 'failed')
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })
  it('does not write detected conflicts or claims invalidated before dispatch', async () => {
    const conflict = intent(); bridge(conflict); const fetcher = server(observed(false, 90).rule); vi.stubGlobal('fetch', fetcher)
    await syncHostRules('v', () => true); expect(conflict.status).toBe('conflict')
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    const row = intent(); bridge(row, () => { throw new Error('HOST_RULE_SCOPE_CHANGED') }); const normal = server(); vi.stubGlobal('fetch', normal)
    await syncHostRules('v', () => true); expect(normal.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })
  it('stops after Vault switch or relocking without persisting a late result', async () => {
    const row = intent(); bridge(row); let current = true
    vi.mocked(vaultGetSecret).mockImplementation(async () => { current = false; return 'never-persist-access' })
    const fetcher = server(); vi.stubGlobal('fetch', fetcher)
    await syncHostRules('v', () => current); expect(fetcher).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('host_notification_rule_action', expect.anything())
  })
})
