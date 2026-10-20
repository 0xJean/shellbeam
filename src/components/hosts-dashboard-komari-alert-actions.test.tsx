import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostsDashboard } from './hosts-dashboard'
import { I18nProvider } from '@/lib/i18n'
import { buildHostOpsViews, loadHostOpsViews } from '@/lib/host-ops-view'
import { listKomariIntegrations } from '@/lib/komari-config'
import { getKomariMappingState, KOMARI_MAPPING_CHANGED_EVENT, loadKomariPersistence, type KomariPersistedState } from '@/lib/komari-persistence'
import { runKomariAlertAction } from '@/lib/komari-alert-actions'
import { reconcileKomariAlerts, type KomariAlertRecord, type KomariAlertState } from '@/lib/komari-alerts'
import type { HostProfile } from '@/lib/hosts'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string) => command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []) }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/components/komari-alerts-dashboard-panel', () => ({ KomariAlertsDashboardPanel: () => null }))
vi.mock('@/lib/host-ops-view', async (original) => ({ ...await original<typeof import('@/lib/host-ops-view')>(), loadHostOpsViews: vi.fn() }))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn() }))
vi.mock('@/lib/komari-persistence', async (original) => ({ ...await original<typeof import('@/lib/komari-persistence')>(), loadKomariPersistence: vi.fn(), getKomariMappingState: vi.fn() }))
vi.mock('@/lib/komari-alert-actions', () => ({ runKomariAlertAction: vi.fn() }))

const host: HostProfile = { id: 'host', vaultId: 'vault-a', name: 'Existing host', address: '10.0.0.1', username: 'ops', port: 22, authType: 'password', passwordKeyRef: 'host.key', group: '', tags: [], createdAt: 1, updatedAt: 1 }
let state: KomariAlertState
let displayed: KomariAlertRecord
let persisted: KomariPersistedState
const writes = vi.fn()
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function element(extra: Partial<React.ComponentProps<typeof HostsDashboard>> = {}) {
  return <I18nProvider><HostsDashboard activeVaultId="vault-a" vaultUnlocked hosts={[host]} selectedHostId={null} loading={false} onSelectHost={vi.fn()} onCreateHost={vi.fn()} onUpdateHost={vi.fn()} onDeleteHost={vi.fn()} {...extra} /></I18nProvider>
}
async function clickAction() {
  const action = await screen.findByTestId(`komari-host-alert-ack-${displayed.alertId}`)
  const row = action.closest('[data-testid="host-card"]')
  expect(row).toBeTruthy()
  const toggle = row!.querySelector('[data-testid="host-ops-details-toggle"]')!
  expect(toggle).toBeVisible()
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  expect(action).toBeVisible()
  fireEvent.click(action)
}
async function fresh() { await waitFor(() => expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh')) }
function mappingChanged(integrationId = 'integration', vaultId = 'vault-a') { window.dispatchEvent(new CustomEvent(KOMARI_MAPPING_CHANGED_EVENT, { detail: { integrationId, vaultId } })) }
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en'); vi.clearAllMocks()
  state = { schemaVersion: 1, ...reconcileKomariAlerts([], [{ integrationId: 'integration', nodeId: 'node', hostId: host.id, kind: 'probe-error:metrics', count: 1, title: 'Metrics unavailable', updatedAt: 100 }], { now: 100 }) }
  displayed = state.alerts[0]
  persisted = { snapshots: [], mappings: [], syncState: { integrationId: 'integration', alertSummary: { ...state }, lastSyncedAt: 100, updatedAt: 100, ttlMs: 60_000 }, lastSyncedAt: 100 }
  vi.mocked(loadKomariPersistence).mockImplementation(async () => persisted)
  vi.mocked(listKomariIntegrations).mockImplementation(async (vaultId) => [{ id: 'integration', vaultId, name: 'Source', endpoint: 'https://komari.example', credentialRef: 'saved.key', enabled: true, createdAt: 1, updatedAt: 1 }])
  vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 1, mappings: [{ integrationId: 'integration', nodeId: 'node', hostId: host.id, source: 'manual', confidence: 'explicit', updatedAt: 1 }] })
  vi.mocked(loadHostOpsViews).mockImplementation(async (hosts) => {
    const views = buildHostOpsViews({ hosts })
    for (const row of hosts) views[row.id] = { ...views[row.id], komariAlerts: row.id === host.id ? [displayed] : [], komariAlertAudits: [] }
    return views
  })
  vi.mocked(runKomariAlertAction).mockImplementation(async (_action, options) => { if (options.isCurrent?.()) writes(); return null })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('host Komari alert scope guards', () => {
  it.each(['vault-return', 'lock-return', 'host', 'host-return', 'remove-host', 'mapping', 'unmount'] as const)('abandons a late ledger read after %s, without a forced refresh or operation', async (change) => {
    const read = deferred<KomariPersistedState>()
    vi.mocked(loadKomariPersistence).mockReturnValueOnce(read.promise)
    const view = render(element()); await fresh(); await clickAction()
    await waitFor(() => expect(loadKomariPersistence).toHaveBeenCalledTimes(1))
    if (change === 'vault-return') {
      view.rerender(element({ activeVaultId: 'vault-b', hosts: [{ ...host, vaultId: 'vault-b' }] })); await fresh()
      view.rerender(element()); await fresh()
    } else if (change === 'lock-return') {
      view.rerender(element({ vaultUnlocked: false }))
      view.rerender(element())
    } else if (change === 'host' || change === 'host-return') {
      view.rerender(element({ hosts: [{ ...host, address: '10.0.0.2' }] })); await fresh()
      if (change === 'host-return') { view.rerender(element()); await fresh() }
    } else if (change === 'remove-host') {
      view.rerender(element({ hosts: [] }))
      await waitFor(() => expect(screen.getByTestId('host-ops-refresh')).toBeEnabled())
      expect(screen.queryByTestId('host-ops-refresh-status')).not.toBeInTheDocument()
      expect(screen.queryByTestId('host-card')).not.toBeInTheDocument()
    }
    else if (change === 'mapping') act(() => mappingChanged())
    else view.unmount()
    const refreshes = vi.mocked(loadHostOpsViews).mock.calls.length
    await act(async () => { read.resolve(persisted) })
    expect(runKomariAlertAction).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(loadHostOpsViews).toHaveBeenCalledTimes(refreshes)
  })

  it.each(['lock-return', 'host-credential', 'jump-route', 'mapping'] as const)('invalidates the OperationJob callback before execution after %s', async (change) => {
    const execution = deferred<void>()
    vi.mocked(runKomariAlertAction).mockImplementation(async (_action, options) => { await execution.promise; if (options.isCurrent?.()) writes(); return null })
    const jump = { ...host, id: 'jump', name: 'Jump', address: 'jump.example' }
    const target = { ...host, jumpHostId: jump.id }
    const view = render(element({ hosts: [target, jump] })); await fresh(); await clickAction()
    await waitFor(() => expect(runKomariAlertAction).toHaveBeenCalledTimes(1))
    const guard = vi.mocked(runKomariAlertAction).mock.calls[0][1].isCurrent!
    expect(guard()).toBe(true)
    if (change === 'lock-return') { view.rerender(element({ hosts: [target, jump], vaultUnlocked: false })); view.rerender(element({ hosts: [target, jump] })); await fresh() }
    if (change === 'host-credential') { view.rerender(element({ hosts: [{ ...target, passwordKeyRef: 'rotated' }, jump] })); await fresh() }
    if (change === 'jump-route') { view.rerender(element({ hosts: [target, { ...jump, address: 'changed-jump.example' }] })); await fresh() }
    if (change === 'mapping') act(() => mappingChanged())
    expect(guard()).toBe(false)
    const refreshes = vi.mocked(loadHostOpsViews).mock.calls.length
    await act(async () => { execution.resolve() })
    expect(writes).not.toHaveBeenCalled()
    expect(loadHostOpsViews).toHaveBeenCalledTimes(refreshes)
  })

  it('retains explicit historical host ownership after a node remap and ignores unrelated mapping events', async () => {
    vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 2, mappings: [{ integrationId: 'integration', nodeId: 'node', hostId: 'new-host', source: 'manual', confidence: 'explicit', updatedAt: 2 }] })
    const execution = deferred<void>()
    vi.mocked(runKomariAlertAction).mockImplementation(async (_action, options) => { await execution.promise; if (options.isCurrent?.()) writes(); return null })
    render(element()); await fresh(); await clickAction()
    await waitFor(() => expect(runKomariAlertAction).toHaveBeenCalledTimes(1))
    act(() => { mappingChanged('other-integration'); mappingChanged('integration', 'other-vault') })
    expect(vi.mocked(runKomariAlertAction).mock.calls[0][1].isCurrent?.()).toBe(true)
    await act(async () => { execution.resolve() })
    expect(writes).toHaveBeenCalledTimes(1)
    expect(getKomariMappingState).not.toHaveBeenCalled()
  })

  it('validates the current incident projection when a secondary member was first observed earlier', async () => {
    const primary = { ...displayed, incidentKey: 'one-incident', firstSeenAt: 200 }
    const secondary = { ...displayed, alertId: 'earlier-member', fingerprint: 'earlier-member', kind: 'probe-error:logs', incidentKey: 'one-incident' }
    state = { ...state, alerts: [primary, secondary] }
    persisted = { ...persisted, syncState: { ...persisted.syncState!, alertSummary: { ...state } } }
    vi.mocked(loadHostOpsViews).mockImplementation(async (hosts) => {
      const views = buildHostOpsViews({ hosts })
      for (const row of hosts) views[row.id] = { ...views[row.id], komariAlerts: state.alerts, komariAlertAudits: [] }
      return views
    })
    render(element()); await fresh(); await clickAction()
    await waitFor(() => expect(runKomariAlertAction).toHaveBeenCalledTimes(1))
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('requires a current mapping for a node-only legacy alert (matches: %s)', async (matches) => {
    displayed.hostId = null
    vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 2, mappings: [{ integrationId: 'integration', nodeId: 'node', hostId: matches ? host.id : 'other-host', source: 'manual', confidence: 'explicit', updatedAt: 2 }] })
    render(element()); await fresh(); await clickAction()
    await waitFor(() => expect(getKomariMappingState).toHaveBeenCalledExactlyOnceWith('vault-a', 'integration'))
    await fresh()
    expect(runKomariAlertAction).toHaveBeenCalledTimes(matches ? 1 : 0)
    expect(writes).toHaveBeenCalledTimes(matches ? 1 : 0)
  })

  it('rejects a late node-only mapping read after a mapping event', async () => {
    displayed.hostId = null
    const mapping = deferred<Awaited<ReturnType<typeof getKomariMappingState>>>()
    vi.mocked(getKomariMappingState).mockReturnValueOnce(mapping.promise)
    render(element()); await fresh(); await clickAction()
    await waitFor(() => expect(getKomariMappingState).toHaveBeenCalledTimes(1))
    act(() => mappingChanged())
    const refreshes = vi.mocked(loadHostOpsViews).mock.calls.length
    await act(async () => { mapping.resolve({ revision: 1, mappings: [{ integrationId: 'integration', nodeId: 'node', hostId: host.id, source: 'manual', confidence: 'explicit', updatedAt: 1 }] }) })
    expect(runKomariAlertAction).not.toHaveBeenCalled()
    expect(loadHostOpsViews).toHaveBeenCalledTimes(refreshes)
  })

  it.each(['foreign-host', 'foreign-integration', 'replaced-record'] as const)('does not operate on %s from a stale card', async (change) => {
    if (change === 'foreign-host') displayed.hostId = 'other-host'
    if (change === 'foreign-integration') vi.mocked(listKomariIntegrations).mockResolvedValue([])
    if (change === 'replaced-record') persisted = { ...persisted, syncState: { ...persisted.syncState!, alertSummary: { ...state, alerts: [{ ...displayed, firstSeenAt: 200 }] } } }
    render(element()); await fresh(); await clickAction()
    await waitFor(() => expect(loadKomariPersistence).toHaveBeenCalledTimes(1)); await fresh()
    expect(runKomariAlertAction).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
  })
})
