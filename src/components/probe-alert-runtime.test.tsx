import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { ProbeCollectionDiagnostic, ProbeCollectionEvent } from '@/lib/probe-collection-events'
import { createProbeAlertLifecycleConsumer } from '@/lib/probe-alert-lifecycle'
import { clearProbeAlertRuntimeDiagnostic, getProbeAlertRuntimeDiagnostic } from '@/lib/probe-alert-runtime-state'
import { ProbeAlertRuntime } from './probe-alert-runtime'

const mocks = vi.hoisted(() => ({
  hosts: [] as HostProfile[], vaultId: 'vault', unlocked: true, sequence: 0,
  listener: null as ((event: ProbeCollectionEvent) => void) | null,
  diagnosticListener: null as ((event: ProbeCollectionDiagnostic) => void) | null,
  subscribe: vi.fn(), unsubscribe: vi.fn(), create: vi.fn(),
  unsubscribeDiagnostics: vi.fn(),
  consume: vi.fn(), flush: vi.fn(),
  t: (key: string, params?: { section?: string }) => key === 'localOps.probeUnavailable' ? `${params?.section} collection unavailable` : key === 'localOps.probeSection.metrics' ? 'Metrics' : 'Inventory',
}))
vi.mock('@/lib/i18n', () => ({ useT: () => ({ t: mocks.t }) }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => ({ hosts: mocks.hosts }) }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: mocks.vaultId, vaultStatusState: { unlocked: mocks.unlocked } }) }))
vi.mock('@/lib/probe-collection-events', () => ({
  currentProbeCollectionSequence: () => mocks.sequence,
  subscribeProbeCollections: (listener: (event: ProbeCollectionEvent) => void) => {
    mocks.listener = listener; mocks.subscribe(listener); return mocks.unsubscribe
  },
  subscribeProbeCollectionDiagnostics: (listener: (event: ProbeCollectionDiagnostic) => void) => {
    mocks.diagnosticListener = listener; return mocks.unsubscribeDiagnostics
  },
}))
vi.mock('@/lib/probe-alert-lifecycle', () => ({ createProbeAlertLifecycleConsumer: (...args: unknown[]) => {
  mocks.create(...args); return { consume: mocks.consume, flush: mocks.flush }
} }))

const host = { id: 'host', vaultId: 'vault', name: 'edge', address: '10.0.0.1', updatedAt: 1 } as HostProfile
function event(patch: Partial<ProbeCollectionEvent> = {}): ProbeCollectionEvent {
  return { eventId: 'event', vaultId: 'vault', hostId: 'host', configRevision: 'a'.repeat(64),
    provider: { kind: 'ssh-agentless', id: 'ssh-agentless' }, transport: 'direct',
    startedAt: Date.now(), completedAt: Date.now(), startedSequence: ++mocks.sequence, sections: [], ...patch }
}
function diagnostic(patch: Partial<ProbeCollectionDiagnostic> = {}): ProbeCollectionDiagnostic {
  return { code: 'publication-unavailable', vaultId: 'vault', hostId: 'host', startedAt: Date.now(), startedSequence: ++mocks.sequence, ...patch }
}
type ConsumerOptions = Parameters<typeof createProbeAlertLifecycleConsumer>[0]
beforeEach(() => {
  vi.clearAllMocks()
  mocks.hosts = [host]; mocks.vaultId = 'vault'; mocks.unlocked = true; mocks.listener = null; mocks.sequence = 0
  mocks.consume.mockResolvedValue({ status: 'applied' }); mocks.flush.mockResolvedValue(undefined)
  clearProbeAlertRuntimeDiagnostic('vault', 'host')
  clearProbeAlertRuntimeDiagnostic('other', 'host')
})
afterEach(() => cleanup())

it('subscribes without Workspace and admits only this unlocked Vault and unambiguous host', () => {
  const { unmount } = render(<ProbeAlertRuntime />)
  const options = mocks.create.mock.calls[0][0] as ConsumerOptions
  const observation = event()
  expect(options.getCurrentHost(observation)).toBe(host)
  expect(options.isCurrent(observation)).toBe(true)
  expect(options.ruleName?.('metrics')).toBe('Metrics collection unavailable')
  mocks.listener!(observation)
  expect(mocks.consume).toHaveBeenCalledExactlyOnceWith(observation)
  for (const invalid of [event({ vaultId: 'other' }), event({ hostId: 'other' }), event({ startedAt: Date.now() + 60_000 }), event({ startedAt: Number.NaN }), event({ startedAt: 1 })]) {
    expect(options.getCurrentHost(invalid)).toBeNull()
    mocks.listener!(invalid)
  }
  expect(mocks.consume).toHaveBeenCalledOnce()
  unmount()
  expect(options.isCurrent(observation)).toBe(false)
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  expect(mocks.unsubscribeDiagnostics).toHaveBeenCalledOnce()
  expect(mocks.flush).toHaveBeenCalledOnce()
})

it('invalidates pending work on host edits, Vault changes and locking', () => {
  const { rerender } = render(<ProbeAlertRuntime />)
  const original = mocks.create.mock.calls[0][0] as ConsumerOptions
  const observation = event()
  mocks.hosts = [{ ...host, updatedAt: 2, jumpHostId: 'new-jump' }]
  rerender(<ProbeAlertRuntime />)
  expect(original.isCurrent(observation)).toBe(false)
  const edited = mocks.create.mock.calls[1][0] as ConsumerOptions
  expect(edited.getCurrentHost(event())).toMatchObject({ jumpHostId: 'new-jump' })
  mocks.vaultId = 'other'
  mocks.hosts = [{ ...host, vaultId: 'other' }]
  rerender(<ProbeAlertRuntime />)
  expect(edited.isCurrent(observation)).toBe(false)
  const switched = mocks.create.mock.calls[2][0] as ConsumerOptions
  expect(switched.getCurrentHost(event())).toBeNull()
  mocks.unlocked = false
  rerender(<ProbeAlertRuntime />)
  expect(switched.isCurrent(event({ vaultId: 'other' }))).toBe(false)
  expect(mocks.subscribe).toHaveBeenCalledTimes(3)
})

it('does not subscribe for a locked Vault or accept ambiguous cross-Vault host identities', () => {
  mocks.unlocked = false
  const { rerender } = render(<ProbeAlertRuntime />)
  expect(mocks.subscribe).not.toHaveBeenCalled()
  mocks.unlocked = true
  mocks.hosts = [host, { ...host, name: 'duplicate' }]
  rerender(<ProbeAlertRuntime />)
  const options = mocks.create.mock.calls[0][0] as ConsumerOptions
  expect(options.getCurrentHost(event())).toBeNull()
})

it('reports only a fixed diagnostic when the lifecycle store rejects an event', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.consume.mockRejectedValueOnce(new Error('private provider credential detail'))
  render(<ProbeAlertRuntime />)
  mocks.listener!(event())
  await waitFor(() => expect(warning).toHaveBeenCalledExactlyOnceWith('Probe alert lifecycle persistence unavailable'))
  expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBe('persistence-unavailable')
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private')
  warning.mockRestore()
})

it('shows only current collection publication failures and clears them after a durable applied event', async () => {
  const { rerender } = render(<ProbeAlertRuntime />)
  const previousListener = mocks.diagnosticListener!
  for (const invalid of [{ vaultId: 'other', hostId: 'host', startedAt: Date.now() }, { vaultId: 'vault', hostId: 'host', startedAt: 1 }, { vaultId: 'vault', hostId: 'host', startedAt: Number.NaN }]) {
    previousListener(diagnostic(invalid))
  }
  expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBeNull()
  previousListener(diagnostic())
  expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBe('publication-unavailable')
  mocks.consume.mockResolvedValueOnce({ status: 'ignored' })
  mocks.listener!(event())
  await waitFor(() => expect(mocks.consume).toHaveBeenCalledOnce())
  expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBe('publication-unavailable')
  mocks.listener!(event({ eventId: 'applied' }))
  await waitFor(() => expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBeNull())
  mocks.vaultId = 'other'; mocks.hosts = [{ ...host, vaultId: 'other' }]
  rerender(<ProbeAlertRuntime />)
  previousListener(diagnostic({ code: 'listener-failed' }))
  expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBeNull()
  expect(getProbeAlertRuntimeDiagnostic('other', 'host')).toBeNull()
})

it('does not let a previous Vault rejection overwrite the current runtime diagnostic', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let reject!: (error: Error) => void
  mocks.consume.mockImplementationOnce(() => new Promise((_, rejectPromise) => { reject = rejectPromise }))
  const { rerender } = render(<ProbeAlertRuntime />)
  mocks.listener!(event())
  mocks.vaultId = 'other'; mocks.hosts = [{ ...host, vaultId: 'other' }]
  rerender(<ProbeAlertRuntime />)
  mocks.diagnosticListener!(diagnostic({ vaultId: 'other', code: 'listener-failed' }))
  reject(new Error('private previous Vault detail'))
  await Promise.resolve()
  expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBeNull()
  expect(getProbeAlertRuntimeDiagnostic('other', 'host')).toBe('listener-failed')
  expect(warning).not.toHaveBeenCalled()
  warning.mockRestore()
})

it('does not clear a newer publication failure when an older pending durable write succeeds', async () => {
  let resolve!: (value: { status: 'applied' }) => void
  mocks.consume.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  render(<ProbeAlertRuntime />)
  mocks.listener!(event({ eventId: 'pending' }))
  mocks.diagnosticListener!(diagnostic())
  resolve({ status: 'applied' })
  await Promise.resolve()
  expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBe('publication-unavailable')
  mocks.listener!(event({ eventId: 'later-success' }))
  await waitFor(() => expect(getProbeAlertRuntimeDiagnostic('vault', 'host')).toBeNull())
})

it('rejects an old referenced-jump attempt even when the edit and new work share the same millisecond', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  try {
    const jump = { ...host, id: 'bastion', address: '10.0.0.2' }
    const target = { ...host, jumpHostId: jump.id }
    mocks.hosts = [target, jump]
    const { rerender } = render(<ProbeAlertRuntime />)
    const oldAttempt = event()
    mocks.hosts = [target, { ...jump, address: '10.0.0.3', updatedAt: 2 }]
    rerender(<ProbeAlertRuntime />)
    const options = mocks.create.mock.calls[1][0] as ConsumerOptions
    expect(options.getCurrentHost(oldAttempt)).toBeNull()
    mocks.listener!(oldAttempt)
    expect(mocks.consume).not.toHaveBeenCalled()
    const newAttempt = event()
    expect(newAttempt.startedAt).toBe(oldAttempt.startedAt)
    expect(options.getCurrentHost(newAttempt)).toBe(target)
    mocks.listener!(newAttempt)
    expect(mocks.consume).toHaveBeenCalledExactlyOnceWith(newAttempt)
  } finally { clock.mockRestore() }
})
