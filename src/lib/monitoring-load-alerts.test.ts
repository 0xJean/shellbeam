import { describe, expect, it, vi } from 'vitest'
import { readMonitoringLoad, reconcileMonitoringLoad } from './monitoring-load-alerts'
import { acknowledgeKomariAlert, closeKomariAlert, parseKomariAlertState, summarizeKomariAlertState, type KomariAlertState } from './komari-alerts'
import { isHistoricalKomariAlert } from './komari-alert-incidents'
import type { HostProfile } from './hosts'
import type { KomariClient } from './komari'
import type { LoadRule } from './monitoring-policy'
import { dispatchKomariAlertNotifications } from './komari-alert-notifications'
import { isCurrentKomariAlert, type CurrentKomariSource } from './komari-source-eligibility'
import { loadEvidenceObservation } from './monitoring-load-evidence'

const host: HostProfile = { id: 'h', vaultId: 'v', name: 'WEB', createdAt: 1, updatedAt: 1, address: '', port: 22, username: '', authType: 'password', tags: [], group: '' }
const node: KomariClient = { uuid: 'n', name: 'WEB', raw: { created_at: 'created' }, hostname: null, ipv4: null, ipv6: null, os: null, kernel: null, version: null }
const rule: LoadRule = { id: 'cpu', name: 'CPU high', nodeId: 'n', nodeCreatedAt: 'created', metric: 'cpu', enabled: true, threshold: 80, recovery: 50, durationSeconds: 0, recoverySeconds: 0 }
const empty = (): KomariAlertState => ({ schemaVersion: 1, alerts: [], audit: [], summary: summarizeKomariAlertState([], 1000) })
const mappings = [{ hostId: 'h', nodeId: 'n', source: 'manual' as const, confidence: 'explicit' as const, updatedAt: 1 }]
const read = (sampledAt = 1000, firing = true) => ({ identity: 'a'.repeat(48), rules: [{ ...rule }], evaluations: { cpu: { sampledAt, firing, status: firing ? 'firing' : 'healthy', value: firing ? 95 : 20, notified: firing } } })
const options = (state = empty()) => ({ integrationId: 'i', endpoint: 'https://monitor.test', hosts: [host], clients: [node], mappings, state, read: read(), now: 2000 })
const run = (overrides: Partial<Parameters<typeof reconcileMonitoringLoad>[0]> = {}) => reconcileMonitoringLoad({ ...options(), ...overrides })
const policy = { extension_identity: 'a'.repeat(48), revision: 1, rules: [rule], silences: [] }
const status = { revision: 1, scope: 'extension-load-notifications', evaluations: read().evaluations }

describe('server load observation subscription', () => {
  it('reads only the fixed GET contract and rejects changes across its read boundary', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => new Response(JSON.stringify(String(input).endsWith('/status') ? status : policy)))
    expect(await readMonitoringLoad({ endpoint: 'https://monitor.test', token: 'synthetic' }, fetch)).toMatchObject(read())
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['/policy', '/status', '/policy'].map(p => 'https://monitor.test/api/shellbeam-alerts/v1' + p))
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET' && init?.body === undefined && init?.redirect === 'error')).toBe(true)
    fetch.mockClear(); fetch.mockImplementation(async () => new Response(JSON.stringify(fetch.mock.calls.length === 1 ? policy : fetch.mock.calls.length === 2 ? status : { ...policy, revision: 2 })))
    expect(await readMonitoringLoad({ endpoint: 'https://monitor.test' }, fetch)).toBeNull()
  })
  it.each([404, 403, 500])('treats HTTP %s as unavailable without recovering or installing anything', async code => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: code }))
    expect(await readMonitoringLoad({ endpoint: 'https://monitor.test' }, fetch)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['<html>not installed</html>', JSON.stringify({ ...policy, rules: [rule, rule] }), JSON.stringify({ ...policy, rules: [{ ...rule, recovery: 100 }] })])('rejects invalid policy rather than deriving incidents from it', async body => {
    expect(await readMonitoringLoad({ endpoint: 'https://monitor.test' }, vi.fn().mockResolvedValue(new Response(body)))).toBeNull()
  })
  it('opens once, retains ack/archive across repeated reads, and reopens only after new recovery evidence', async () => {
    const first = await run()
    expect(first.state.summary.open).toBe(1)
    expect(first.audit.map(a => a.event)).toEqual(['opened'])
    expect(first.state.alerts[0]).toMatchObject({ kind: 'server-load', firstSeenAt: 1000, lastSeenAt: 1000 })
    const acknowledged = acknowledgeKomariAlert(first.state.alerts[0], 'user', 2100)
    const state = { ...first.state, alerts: [acknowledged.alert], audit: [...first.state.audit, acknowledged.audit] }
    const repeat = await run({ state, read: read(2200), now: 2300 })
    expect(repeat.state.alerts[0].status).toBe('acknowledged'); expect(repeat.audit).toEqual([])
    const closed = closeKomariAlert(repeat.state.alerts[0], 'user', 2400)
    const archived = { ...repeat.state, alerts: [closed.alert], audit: [...repeat.state.audit, closed.audit] }
    const stillFiring = await run({ state: archived, read: read(2500), now: 2600 })
    expect(stillFiring.state.alerts[0].status).toBe('closed'); expect(stillFiring.audit).toEqual([])
    const recovered = await run({ state: stillFiring.state, read: read(2700, false), now: 2800 })
    expect(recovered.state.alerts[0]).toMatchObject({ status: 'closed', count: 0, resolvedAt: 2700 })
    expect(recovered.audit.map(a => a.event)).toEqual(['resolved'])
    const restarted = parseKomariAlertState(JSON.parse(JSON.stringify(recovered.state)))!
    const reopened = await run({ state: restarted, read: read(2900), now: 3000 })
    expect(reopened.audit.map(a => a.event)).toEqual(['reopened'])
    expect(reopened.state.alerts[0]).toMatchObject({ status: 'active', acknowledgedAt: null, closedAt: null, resolvedAt: null })
    expect(reopened.state.audit.slice(0, 3)).toEqual(archived.audit)
  })
  it('resolves acknowledged facts with newer samples and retains their operation link', async () => {
    const first = await run(); first.state.alerts[0] = { ...first.state.alerts[0], status: 'acknowledged', relatedOperationJobId: 'job' }
    const result = await run({ state: first.state, read: read(1500, false) })
    expect(result.state.alerts[0].status).toBe('resolved')
    expect(result.audit[0]).toMatchObject({ event: 'resolved', operationJobId: 'job' })
  })
  it('does not turn stale, absent, repeated, future or regressing samples into recovery', async () => {
    const first = await run()
    for (const candidate of [null, read(900, false), read(1000, false), read(3000, false), { ...read(), evaluations: {} }]) {
      const result = await run({ state: first.state, read: candidate })
      expect(result.state.alerts[0]).toMatchObject({ status: 'active', count: 1, resolvedAt: null })
      expect(result.audit).toEqual([])
    }
    const stale = await run({ state: first.state, read: read(1000, false), now: 500000 })
    expect(stale.state.alerts[0].loadEvidence?.state).toBe('unknown'); expect(stale.audit).toEqual([])
    expect(loadEvidenceObservation(first.state.alerts[0].loadEvidence!, 500000)).toBe('unknown')
  })
  it('keeps silence and channel disable separate from faults and never duplicates server delivery', async () => {
    const candidate = read(); Object.assign(candidate.evaluations.cpu, { status: 'silenced', notified: false })
    const result = await run({ read: candidate })
    expect(result.state.alerts[0]).toMatchObject({ status: 'active', count: 1, loadEvidence: { notification: 'silenced', state: 'firing' } })
    const sink = vi.fn(); const fetch = vi.fn()
    const dispatch = await dispatchKomariAlertNotifications(result.state, { audit: result.audit, onLocal: sink, fetchImpl: fetch, now: 2000, policy: { enabled: true, channels: ['local', 'webhook'], webhookUrl: 'https://example.test/hook' } })
    expect(dispatch.summary.delivered).toBe(0); expect(sink).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('does not create alerts from healthy, pending or disabled rules, and retains retired records as history', async () => {
    expect((await run({ read: read(1000, false) })).state.alerts).toEqual([])
    const disabled = read(); disabled.rules[0].enabled = false
    expect((await run({ read: disabled })).state.alerts).toEqual([])
    const first = await run()
    for (const candidate of [disabled, { ...read(), rules: [] }, { ...read(), identity: 'b'.repeat(48), evaluations: {} }]) {
      const result = await run({ state: first.state, read: candidate })
      expect(result.state.summary.open).toBe(0)
      expect(result.state.alerts[0].status).toBe('active') // Do not fabricate recovery or delete audit.
      expect(isHistoricalKomariAlert(result.state.alerts[0])).toBe(true)
      expect(result.audit).toEqual([])
      const unavailable = await run({ state: result.state, read: null, now: 3000 })
      expect(unavailable.state.summary.open).toBe(0)
      expect(unavailable.state.alerts).toEqual(result.state.alerts)
      expect(unavailable.audit).toEqual([])
    }
  })
  it('preserves archived handling through disable/enable until actual recovery and a new failure', async () => {
    const first = await run()
    const closed = closeKomariAlert(first.state.alerts[0], 'user', 2100)
    const archived = { ...first.state, alerts: [closed.alert], audit: [...first.state.audit, closed.audit] }
    const disabled = read(2200); disabled.rules[0].enabled = false
    const stopped = await run({ state: archived, read: disabled, now: 2300 })
    const resumed = await run({ state: stopped.state, read: read(2400), now: 2500 })
    expect(resumed.state.alerts[0].status).toBe('closed'); expect(resumed.audit).toEqual([])
    const healthy = await run({ state: resumed.state, read: read(2600, false), now: 2700 })
    expect(healthy.audit.map(a => a.event)).toEqual(['resolved'])
    const failing = await run({ state: healthy.state, read: read(2800), now: 2900 })
    expect(failing.audit.map(a => a.event)).toEqual(['reopened'])
  })
  it('separates rule/node/host/service identities while metadata renames retain the incident', async () => {
    const first = await run()
    const renamed = read(1500); renamed.rules[0].name = 'Renamed'
    const same = await run({ state: first.state, read: renamed })
    expect(same.state.alerts[0].alertId).toBe(first.state.alerts[0].alertId); expect(same.audit).toEqual([])
    const recreated = await run({ state: first.state, hosts: [{ ...host, createdAt: 99 }] })
    expect(recreated.state.alerts).toHaveLength(2); expect(recreated.state.summary.open).toBe(1)
    const changed = read(); changed.rules[0].threshold = 90
    expect((await run({ state: first.state, read: changed })).state.alerts).toHaveLength(2)
    expect((await run({ clients: [{ ...node, raw: { created_at: 'replacement' } }] })).state.alerts).toEqual([])
    expect((await run({ mappings: [...mappings, { ...mappings[0], hostId: 'other' }] })).state.alerts).toEqual([])
  })
  it('projects monitoring-only hosts without needing a metrics snapshot and rejects replaced local identities', async () => {
    const first = await run()
    const sources = [{ integration: { id: 'i', vaultId: 'v', name: 'Monitoring', credentialRef: 'ref', createdAt: 1, updatedAt: 1, enabled: true, endpoint: 'https://monitor.test' }, state: { snapshots: [], lastSyncedAt: 2000, syncState: null, mappings: mappings.map(m => ({ ...m, integrationId: 'i' })) }, error: false }] as CurrentKomariSource[]
    expect(isCurrentKomariAlert(first.state.alerts[0], host, sources, [])).toBe(true)
    expect(isCurrentKomariAlert(first.state.alerts[0], { ...host, createdAt: 2 }, sources, [])).toBe(false)
    expect(isCurrentKomariAlert(first.state.alerts[0], { ...host, vaultId: 'other' }, sources, [])).toBe(false)
    const other = structuredClone(sources); other[0].integration.endpoint = 'https://other.test'
    expect(isCurrentKomariAlert(first.state.alerts[0], host, other, [])).toBe(false)
  })
})
