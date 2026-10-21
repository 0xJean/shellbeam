import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { getKomariMappingState, loadKomariPersistence } from '@/lib/komari-persistence'
import { dispatchAndPersistKomariAlertNotifications } from '@/lib/komari-alert-notifications'
import { persistKomariAlertAction, runKomariAlertAction } from '@/lib/komari-alert-actions'
import { reconcileKomariAlerts, type KomariAlertState } from '@/lib/komari-alerts'
import type { HostProfile } from '@/lib/hosts'
import { KomariAlertsDashboardPanel } from './komari-alerts-dashboard-panel'
import type { HostIncident } from './host-alerts-center'

vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn() }))
vi.mock('@/lib/komari-persistence', async (original) => ({
  ...await original<typeof import('@/lib/komari-persistence')>(), loadKomariPersistence: vi.fn(), getKomariMappingState: vi.fn(),
}))
vi.mock('@/lib/komari-alert-notifications', () => ({
  dispatchAndPersistKomariAlertNotifications: vi.fn(), emitKomariAlertNotification: vi.fn(),
}))
vi.mock('@/lib/komari-alert-actions', () => ({ runKomariAlertAction: vi.fn(), persistKomariAlertAction: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function integration(vaultId = 'a'): KomariIntegration {
  return { id: `integration-${vaultId}`, vaultId, name: vaultId, endpoint: 'https://example.test', credentialRef: 'saved', enabled: true, createdAt: 1, updatedAt: 1 }
}
function state(vaultId = 'a'): KomariAlertState {
  const result = reconcileKomariAlerts([], [{
    integrationId: `integration-${vaultId}`, nodeId: 'node', hostId: 'host', kind: 'probe-error:metrics',
    count: 1, active: 1, title: `Alert for ${vaultId}`, updatedAt: 100,
  }], { now: 100 })
  return { schemaVersion: 1, ...result, probeBaselines: [{ integrationId: `integration-${vaultId}`, endpoint: 'https://example.test', nodeId: 'node', hostId: 'host', lastHealthySampledAt: 99 }] }
}
function persisted(value = state()) {
  return {
    snapshots: [], mappings: [], lastSyncedAt: 100,
    syncState: { integrationId: value.alerts[0]?.integrationId ?? 'integration-a', lastSyncedAt: 100, lastSuccessfulSyncAt: 100 as number | null, ttlMs: 100, updatedAt: 100, alertSummary: value as unknown as Record<string, unknown> },
  }
}
const host = { id: 'host', vaultId: 'a', name: 'Host A', address: 'host.test', port: 22, username: 'user', authType: 'password' } as HostProfile
const panel = (vaultId?: string, vaultUnlocked = true) => <I18nProvider><KomariAlertsDashboardPanel activeVaultId={vaultId} vaultUnlocked={vaultUnlocked} hosts={[host]} /></I18nProvider>

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(listKomariIntegrations).mockResolvedValue([integration()])
  vi.mocked(loadKomariPersistence).mockResolvedValue(persisted())
  vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 1, mappings: [{ integrationId: 'integration-a', hostId: 'host', nodeId: 'node', source: 'manual', confidence: 'explicit', updatedAt: 1 }] })
  vi.mocked(dispatchAndPersistKomariAlertNotifications).mockResolvedValue({
    events: [], state: { deliveries: [] },
    summary: { considered: 0, delivered: 0, skipped: 0, failed: 0, omitted: 0, lastDeliveredAt: null },
  })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

describe('scoped monitoring alert entry', () => {
  it('does not render a vendor empty panel without a configured integration', async () => {
    vi.mocked(listKomariIntegrations).mockResolvedValue([])
    render(panel('a'))
    await waitFor(() => expect(listKomariIntegrations).toHaveBeenCalledWith('a'))
    expect(screen.queryByTestId('komari-alert-panel')).not.toBeInTheDocument()
    expect(dispatchAndPersistKomariAlertNotifications).not.toHaveBeenCalled()
  })

  it('rejects an old Vault load even when returning to the same Vault ID', async () => {
    const late = deferred<Awaited<ReturnType<typeof loadKomariPersistence>>>()
    vi.mocked(loadKomariPersistence).mockReturnValueOnce(late.promise)
    const view = render(panel('a'))
    await waitFor(() => expect(loadKomariPersistence).toHaveBeenCalledTimes(1))
    vi.mocked(listKomariIntegrations).mockResolvedValue([])
    await act(async () => view.rerender(panel('b')))
    await waitFor(() => expect(listKomariIntegrations).toHaveBeenCalledWith('b'))
    await act(async () => view.rerender(panel('a')))
    await act(async () => late.resolve(persisted()))
    expect(screen.queryByText('Alert for a')).not.toBeInTheDocument()
    expect(dispatchAndPersistKomariAlertNotifications).not.toHaveBeenCalled()
  })

  it('invalidates queued notification delivery on scope replacement', async () => {
    render(panel('a'))
    await waitFor(() => expect(dispatchAndPersistKomariAlertNotifications).toHaveBeenCalledTimes(1))
    const options = vi.mocked(dispatchAndPersistKomariAlertNotifications).mock.calls[0][2]
    expect(options?.isCurrent?.()).toBe(true)
    cleanup()
    expect(options?.isCurrent?.()).toBe(false)
  })

  it('rejects late reads across lock and unlock and invalidates pending deliveries', async () => {
    const late = deferred<Awaited<ReturnType<typeof loadKomariPersistence>>>()
    vi.mocked(loadKomariPersistence).mockReturnValueOnce(late.promise)
    const view = render(panel('a'))
    await waitFor(() => expect(loadKomariPersistence).toHaveBeenCalledTimes(1))
    await act(async () => view.rerender(panel('a', false)))
    vi.mocked(listKomariIntegrations).mockResolvedValue([])
    await act(async () => view.rerender(panel('a')))
    await act(async () => late.resolve(persisted()))
    expect(screen.queryByText('Alert for a')).not.toBeInTheDocument()
    expect(dispatchAndPersistKomariAlertNotifications).not.toHaveBeenCalled()

    vi.mocked(listKomariIntegrations).mockResolvedValue([integration()])
    await act(async () => view.rerender(panel('a', false)))
    await act(async () => view.rerender(panel('a')))
    await waitFor(() => expect(dispatchAndPersistKomariAlertNotifications).toHaveBeenCalledTimes(1))
    const options = vi.mocked(dispatchAndPersistKomariAlertNotifications).mock.calls[0][2]
    expect(options?.isCurrent?.()).toBe(true)
    await act(async () => view.rerender(panel('a', false)))
    expect(options?.isCurrent?.()).toBe(false)
    expect(screen.queryByTestId('komari-alert-panel')).not.toBeInTheDocument()
  })

  it('uses the latest persisted lifecycle for an action and preserves its scope guard', async () => {
    const initial = state()
    const latest = { ...initial, audit: [...initial.audit, { ...initial.audit[0], auditId: 'newer-audit', event: 'operation-linked' as const, operationJobId: 'existing-job' }] }
    vi.mocked(loadKomariPersistence).mockResolvedValueOnce(persisted(initial)).mockResolvedValue(persisted(latest))
    vi.mocked(runKomariAlertAction).mockResolvedValue(null)
    const view = render(panel('a'))
    await screen.findByText('Alert for a')
    const details = screen.getByTestId('komari-alert-panel').parentElement as HTMLDetailsElement
    fireEvent.click(details.querySelector('summary')!)
    fireEvent.click(screen.getByTestId(`komari-alert-ack-${initial.alerts[0].alertId}`))
    await waitFor(() => expect(runKomariAlertAction).toHaveBeenCalledTimes(1))
    const options = vi.mocked(runKomariAlertAction).mock.calls[0][1]
    expect(options.state.audit.some((row) => row.auditId === 'newer-audit')).toBe(true)
    expect(options.isCurrent?.()).toBe(true)
    await act(async () => view.rerender(<I18nProvider><KomariAlertsDashboardPanel activeVaultId="a" vaultUnlocked hosts={[{ ...host, address: 'replaced.test' }]} /></I18nProvider>))
    expect(options.isCurrent?.()).toBe(false)
    await act(async () => view.rerender(panel('b')))
    expect(options.isCurrent?.()).toBe(false)
  })

  it('dispatches only current mapped alerts while preserving the complete stored journal', async () => {
    const current = state()
    const former = { ...current.alerts[0], alertId: 'former-host', hostId: 'removed', nodeId: 'removed-node' }
    const stored = { ...current, alerts: [...current.alerts, former], audit: [...current.audit, { ...current.audit[0], auditId: 'former-audit', alertId: former.alertId }] }
    const before = JSON.stringify(stored)
    vi.mocked(loadKomariPersistence).mockResolvedValue(persisted(stored))
    const incidents = vi.fn()
    render(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked hosts={[host]} onAdditionalIncidents={incidents} /></I18nProvider>)
    await waitFor(() => expect(dispatchAndPersistKomariAlertNotifications).toHaveBeenCalledTimes(1))
    const projected = vi.mocked(dispatchAndPersistKomariAlertNotifications).mock.calls[0][1]
    expect(projected.alerts.map(row => row.alertId)).toEqual([current.alerts[0].alertId])
    expect(projected.audit.map(row => row.auditId)).toEqual(current.audit.map(row => row.auditId))
    expect(JSON.stringify(stored)).toBe(before)
    expect(persistKomariAlertAction).not.toHaveBeenCalled()
    expect(incidents.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ title: former.title, historyOnly: true, act: undefined })])
  })

  it.each(['unbound', 'endpoint', 'unreadable'] as const)('does not send current-host notifications from an %s source', async (reason) => {
    if (reason === 'unbound') vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 2, mappings: [] })
    if (reason === 'endpoint') vi.mocked(listKomariIntegrations).mockResolvedValue([{ ...integration(), endpoint: 'https://replacement.test' }])
    if (reason === 'unreadable') vi.mocked(getKomariMappingState).mockRejectedValue(new Error('unavailable'))
    const incidents = vi.fn()
    render(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked hosts={[host]} onAdditionalIncidents={incidents} /></I18nProvider>)
    await waitFor(() => expect(loadKomariPersistence).toHaveBeenCalled())
    await act(async () => {})
    expect(dispatchAndPersistKomariAlertNotifications).not.toHaveBeenCalled()
    expect(incidents.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ hostId: 'host', historyOnly: true })])
  })

  it('exposes aggregate and genuinely unmapped-node incidents without reassigning host-owned history', async () => {
    const original = state()
    const aggregate = { ...original.alerts[0], alertId: 'aggregate', title: 'Server alerts', hostId: null, nodeId: null }
    const node = { ...aggregate, alertId: 'unmapped-node', title: 'Unmapped node', nodeId: 'unmapped' }
    const mappedNode = { ...node, alertId: 'mapped-node', nodeId: 'node' }
    const former = { ...original.alerts[0], alertId: 'former', hostId: 'removed' }
    const stored = { ...original, alerts: [aggregate, node, mappedNode, former] }
    vi.mocked(loadKomariPersistence).mockResolvedValue(persisted(stored))
    const incidents = vi.fn<(rows: HostIncident[]) => void>()
    render(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked hosts={[host]} onAdditionalIncidents={incidents} /></I18nProvider>)
    await waitFor(() => expect(incidents.mock.calls.at(-1)?.[0]).toHaveLength(3))
    expect(incidents.mock.calls.at(-1)![0].filter(row => !row.historyOnly).map(row => ({ title: row.title, hostId: row.hostId, hostName: row.hostName, source: row.source }))).toEqual([
      { title: 'Server alerts', hostId: '', hostName: 'a', source: 'komari' },
      { title: 'Unmapped node', hostId: '', hostName: 'a', source: 'komari' },
    ])
    expect(new Set(incidents.mock.calls.at(-1)![0].map(row => row.key)).size).toBe(3)
    expect(incidents.mock.calls.at(-1)![0].find(row => row.historyOnly)).toMatchObject({ act: undefined })
    expect(screen.queryByTestId('komari-alert-panel')).not.toBeInTheDocument()
  })

  it.each(['disabled', 'unconfirmed', 'old-server'] as const)('retains unassigned resolved history but never notifies %s aggregate records', async (reason) => {
    const original = state()
    const active = { ...original.alerts[0], alertId: 'aggregate', hostId: null, nodeId: null }
    const closed = { ...active, alertId: 'closed', status: 'closed' as const, closedAt: 101 }
    const stored = { ...original, alerts: [active, closed] }
    const saved = persisted(stored)
    if (reason === 'disabled') vi.mocked(listKomariIntegrations).mockResolvedValue([{ ...integration(), enabled: false }])
    if (reason === 'unconfirmed') saved.syncState.lastSuccessfulSyncAt = null
    if (reason === 'old-server') {
      vi.mocked(listKomariIntegrations).mockResolvedValue([{ ...integration(), updatedAt: 200, endpoint: 'https://replacement.test' }])
      saved.syncState.lastSuccessfulSyncAt = 300
    }
    vi.mocked(loadKomariPersistence).mockResolvedValue(saved)
    const incidents = vi.fn<(rows: HostIncident[]) => void>()
    render(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked onAdditionalIncidents={incidents} /></I18nProvider>)
    await waitFor(() => expect(incidents.mock.calls.at(-1)?.[0]).toHaveLength(2))
    expect(incidents.mock.calls.at(-1)![0].map(row => ({ status: row.status, historyOnly: row.historyOnly }))).toEqual([{ status: 'active', historyOnly: true }, { status: 'closed', historyOnly: true }])
    expect(dispatchAndPersistKomariAlertNotifications).not.toHaveBeenCalled()
  })

  it('keeps aggregate observations current after a legitimate cache reconciliation advances lastSeenAt', async () => {
    const original = state()
    const aggregate = { ...original.alerts[0], hostId: null, nodeId: null, lastSeenAt: 110 }
    vi.mocked(loadKomariPersistence).mockResolvedValue(persisted({ ...original, alerts: [aggregate] }))
    const incidents = vi.fn<(rows: HostIncident[]) => void>()
    render(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked onAdditionalIncidents={incidents} /></I18nProvider>)
    await waitFor(() => expect(dispatchAndPersistKomariAlertNotifications).toHaveBeenCalledTimes(1))
    expect(incidents.mock.calls.at(-1)![0][0]).toMatchObject({ historyOnly: false, updatedAt: 110 })
  })

  it('retains disabled host-owned active and closed lifecycle rows and their original audits only as history', async () => {
    const original = state()
    const closed = { ...original.alerts[0], alertId: 'closed-host-alert', status: 'closed' as const, closedAt: 100 }
    const closedAudit = { ...original.audit[0], alertId: closed.alertId, auditId: 'closed-host-audit', event: 'closed' as const }
    const stored = { ...original, alerts: [...original.alerts, closed], audit: [...original.audit, closedAudit] }
    vi.mocked(listKomariIntegrations).mockResolvedValue([{ ...integration(), enabled: false }])
    vi.mocked(loadKomariPersistence).mockResolvedValue(persisted(stored))
    const incidents = vi.fn<(rows: HostIncident[]) => void>()
    render(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked hosts={[host]} onAdditionalIncidents={incidents} /></I18nProvider>)
    await waitFor(() => expect(incidents.mock.calls.at(-1)?.[0]).toHaveLength(2))
    const rows = incidents.mock.calls.at(-1)![0]
    expect(rows.map(row => ({ hostId: row.hostId, historyOnly: row.historyOnly, status: row.status }))).toEqual([
      { hostId: 'host', historyOnly: true, status: 'active' }, { hostId: 'host', historyOnly: true, status: 'closed' },
    ])
    expect(rows[0].key).toBe(`komari:host:integration-a:${original.alerts[0].alertId}`)
    expect(rows[0].audit).toEqual(original.audit)
    expect(rows[1].audit).toEqual([closedAudit])
    expect(dispatchAndPersistKomariAlertNotifications).not.toHaveBeenCalled()
    expect(persistKomariAlertAction).not.toHaveBeenCalled()
  })

  it('never publishes a late previous-Vault incident projection or permits its retained host action after removal', async () => {
    const original = state()
    vi.mocked(listKomariIntegrations).mockResolvedValue([{ ...integration(), enabled: false }])
    const incidents = vi.fn<(rows: HostIncident[]) => void>()
    const props = { headless: true, activeVaultId: 'a', vaultUnlocked: true, onAdditionalIncidents: incidents }
    const view = render(<I18nProvider><KomariAlertsDashboardPanel {...props} hosts={[host]} /></I18nProvider>)
    await waitFor(() => expect(incidents.mock.calls.at(-1)?.[0]).toHaveLength(1))
    const retained = incidents.mock.calls.at(-1)![0][0]
    const late = deferred<Awaited<ReturnType<typeof loadKomariPersistence>>>()
    vi.mocked(loadKomariPersistence).mockReturnValueOnce(late.promise)
    view.rerender(<I18nProvider><KomariAlertsDashboardPanel {...props} hosts={[]} /></I18nProvider>)
    await waitFor(() => expect(loadKomariPersistence).toHaveBeenCalledTimes(2))
    await act(async () => { await retained.act!('acknowledge') })
    expect(runKomariAlertAction).not.toHaveBeenCalled()
    const otherIncidents = vi.fn()
    vi.mocked(listKomariIntegrations).mockResolvedValue([])
    view.rerender(<I18nProvider><KomariAlertsDashboardPanel {...props} activeVaultId="b" onAdditionalIncidents={otherIncidents} hosts={[]} /></I18nProvider>)
    await act(async () => { late.resolve(persisted(original)) })
    expect(incidents.mock.calls.at(-1)![0]).toEqual([])
    expect(otherIncidents.mock.calls.every(([rows]) => rows.length === 0)).toBe(true)
    expect(dispatchAndPersistKomariAlertNotifications).not.toHaveBeenCalled()
  })

  it('uses the complete latest journal for an unassigned local action and invalidates retained callbacks on lock', async () => {
    const original = state()
    const aggregate = { ...original.alerts[0], alertId: 'aggregate', hostId: null, nodeId: null }
    let stored = { ...original, alerts: [aggregate, ...original.alerts] }
    vi.mocked(loadKomariPersistence).mockImplementation(async () => persisted(stored))
    vi.mocked(persistKomariAlertAction).mockImplementation(async (_action, options) => {
      stored = { ...options.state, alerts: options.state.alerts.map(row => row.alertId === aggregate.alertId ? { ...row, status: 'acknowledged' as const } : row) }
      return { state: stored, alert: stored.alerts[0] }
    })
    const incidents = vi.fn<(rows: HostIncident[]) => void>()
    const view = render(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked hosts={[host]} onAdditionalIncidents={incidents} /></I18nProvider>)
    await waitFor(() => expect(incidents.mock.calls.at(-1)?.[0]).toHaveLength(1))
    const first = incidents.mock.calls.at(-1)![0][0]
    await act(async () => { await first.act!('acknowledge') })
    expect(persistKomariAlertAction).toHaveBeenCalledWith('acknowledge', expect.objectContaining({
      alertId: aggregate.alertId, state: expect.objectContaining({ alerts: [aggregate, ...original.alerts], audit: original.audit }),
    }))
    expect(runKomariAlertAction).not.toHaveBeenCalled()
    expect(incidents.mock.calls.at(-1)![0][0].status).toBe('acknowledged')
    const last = incidents.mock.calls.at(-1)![0][0]
    view.rerender(<I18nProvider><KomariAlertsDashboardPanel headless activeVaultId="a" vaultUnlocked={false} onAdditionalIncidents={incidents} /></I18nProvider>)
    expect(incidents.mock.calls.at(-1)![0]).toEqual([])
    await act(async () => { await last.act!('close') })
    expect(persistKomariAlertAction).toHaveBeenCalledTimes(1)
  })
})
