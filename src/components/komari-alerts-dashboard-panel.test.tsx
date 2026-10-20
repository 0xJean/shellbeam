import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { loadKomariPersistence } from '@/lib/komari-persistence'
import { dispatchAndPersistKomariAlertNotifications } from '@/lib/komari-alert-notifications'
import { runKomariAlertAction } from '@/lib/komari-alert-actions'
import { reconcileKomariAlerts, type KomariAlertState } from '@/lib/komari-alerts'
import type { HostProfile } from '@/lib/hosts'
import { KomariAlertsDashboardPanel } from './komari-alerts-dashboard-panel'

vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn() }))
vi.mock('@/lib/komari-persistence', async (original) => ({
  ...await original<typeof import('@/lib/komari-persistence')>(), loadKomariPersistence: vi.fn(),
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
    integrationId: `integration-${vaultId}`, nodeId: 'node', hostId: 'host', kind: 'load',
    count: 1, active: 1, title: `Alert for ${vaultId}`, updatedAt: 100,
  }], { now: 100 })
  return { schemaVersion: 1, ...result }
}
function persisted(value = state()) {
  return {
    snapshots: [], mappings: [], lastSyncedAt: 100,
    syncState: { integrationId: value.alerts[0]?.integrationId ?? 'integration-a', lastSyncedAt: 100, ttlMs: 100, updatedAt: 100, alertSummary: value as unknown as Record<string, unknown> },
  }
}
const host = { id: 'host', vaultId: 'a', name: 'Host A', address: 'host.test', port: 22, username: 'user', authType: 'password' } as HostProfile
const panel = (vaultId?: string, vaultUnlocked = true) => <I18nProvider><KomariAlertsDashboardPanel activeVaultId={vaultId} vaultUnlocked={vaultUnlocked} hosts={[host]} /></I18nProvider>

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(listKomariIntegrations).mockResolvedValue([integration()])
  vi.mocked(loadKomariPersistence).mockResolvedValue(persisted())
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
    await act(async () => view.rerender(panel('b')))
    expect(options.isCurrent?.()).toBe(false)
  })
})
