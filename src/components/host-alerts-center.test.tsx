import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import type { LocalAlertRecord } from '@/lib/local-alert-rules'
import { reconcileKomariAlerts, type KomariAlertRecord } from '@/lib/komari-alerts'
import { groupKomariAlertIncidents } from '@/lib/komari-alert-incidents'
import type { HostOperationalSummary } from './host-card'
import { HostAlertsCenter } from './host-alerts-center'
import { buildHostIncidents, type HostIncident } from '@/lib/host-incidents'

const host: HostProfile = { id: 'web', vaultId: 'vault-a', name: 'Web', address: 'web.test', port: 22, username: 'ops', authType: 'password', group: 'Default', tags: [], createdAt: 1, updatedAt: 1 }
const database: HostProfile = { ...host, id: 'db', name: 'Database', address: 'db.test' }
function local(overrides: Partial<LocalAlertRecord> = {}): LocalAlertRecord {
  return { ruleId: 'cpu', hostId: host.id, name: 'CPU high', metric: 'cpu', status: 'active', severity: 'warning', openedAt: 100, updatedAt: 200, resolvedAt: null, value: 95, source: 'ssh-agentless', transport: 'direct', ...overrides }
}
function komari(overrides: Partial<KomariAlertRecord> = {}): KomariAlertRecord {
  const alert = reconcileKomariAlerts([], [{ integrationId: 'integration', hostId: host.id, nodeId: 'node', kind: 'probe-error:metrics', count: 1, active: 1, title: 'Monitoring interrupted', updatedAt: 250 }], { now: 250 }).alerts[0]
  return { ...alert, ...overrides }
}
function summary(overrides: Partial<HostOperationalSummary> = {}): HostOperationalSummary {
  return { vaultId: 'vault-a', serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', ...overrides }
}
function panel(incidents: HostIncident[], onOpenHost?: (id: string) => void) {
  return <I18nProvider><HostAlertsCenter incidents={incidents} onOpenHost={onOpenHost} /></I18nProvider>
}
function shownTitles() {
  return screen.queryAllByTestId('host-incident').map(element => element.querySelector('p')!.textContent)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('host incident projection', () => {
  it('keeps different sources with the same title separate and retains the original records', () => {
    const alerts = [local({ name: 'Same title' })]
    const komariAlerts = [komari({ title: 'Same title' })]
    const before = JSON.stringify({ alerts, komariAlerts })
    const rows = buildHostIncidents([host], new Map([[host.id, summary({ localAlerts: alerts, komariAlerts })]]), 'vault-a')
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(row => row.key)).size).toBe(2)
    expect(rows.map(row => row.source)).toEqual(['komari', 'ssh-agentless'])
    expect(rows.map(row => row.title)).toEqual(['Same title', 'Same title'])
    expect(JSON.stringify({ alerts, komariAlerts })).toBe(before)
  })

  it('uses existing Komari incident grouping without joining another host or integration', () => {
    const metrics = komari({ alertId: 'metrics', kind: 'probe-error:metrics', title: 'Komari Probe metrics error: Komari returned no dated metric observations', firstSeenAt: 100, lastSeenAt: 220 })
    const unknown = komari({ alertId: 'unknown', kind: 'probe-unknown', title: 'Komari Probe health is unknown', firstSeenAt: 100, lastSeenAt: 230 })
    const retry = komari({ alertId: 'retry', kind: 'probe-error:provider', title: 'Komari Probe provider error: Probe recovery failed after 2 retries: Komari returned no dated metric observations', firstSeenAt: 100, lastSeenAt: 240 })
    const unrelated = { ...metrics, alertId: 'another-integration', integrationId: 'another' }
    const alerts = [metrics, unknown, retry, unrelated]
    const rows = buildHostIncidents([host], new Map([[host.id, summary({ komariAlerts: alerts })]]), 'vault-a')
    const expected = groupKomariAlertIncidents(alerts).map(({ alert }) => alert)
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.key)).toEqual(expected.sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(alert => `komari:${host.id}:${alert.integrationId}:${alert.alertId}`))
    expect(rows[0]).toMatchObject({ title: metrics.title, updatedAt: 240, status: 'active' })
    expect(alerts.every(alert => !alert.incidentKey)).toBe(true)
  })

  it('rejects foreign Vault summaries, foreign host records and absent scopes', () => {
    const scoped = summary({ localAlerts: [local(), local({ ruleId: 'foreign', hostId: database.id })], komariAlerts: [komari(), komari({ alertId: 'foreign', hostId: database.id })] })
    const summaries = new Map([[host.id, scoped]])
    expect(buildHostIncidents([host], summaries, 'vault-a')).toHaveLength(2)
    expect(buildHostIncidents([host], summaries)).toEqual([])
    expect(buildHostIncidents([{ ...host, vaultId: 'vault-b' }], summaries, 'vault-a')).toEqual([])
    expect(buildHostIncidents([host], new Map([[host.id, { ...scoped, vaultId: 'vault-b' }]]), 'vault-a')).toEqual([])
    expect(buildHostIncidents([host], new Map([[host.id, { ...scoped, vaultId: undefined }]]), 'vault-a')).toEqual([])
    expect(buildHostIncidents([database], summaries, 'vault-a')).toEqual([])
  })
})

describe('unified host alerts center', () => {
  it('filters mixed local and Komari alerts by host/source and includes history only when selected', () => {
    const summaries = new Map([
      [host.id, summary({ localAlerts: [local()], komariAlerts: [komari(), komari({ alertId: 'old', title: 'Old recovered alert', status: 'resolved', lastSeenAt: 80 })] })],
      [database.id, summary({ localAlerts: [local({ ruleId: 'disk', hostId: database.id, name: 'Disk full', updatedAt: 300 })] })],
    ])
    render(panel(buildHostIncidents([host, database], summaries, 'vault-a')))
    expect(shownTitles()).toEqual(['Disk full', 'Monitoring interrupted', 'CPU high'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Host' }), { target: { value: host.id } })
    expect(shownTitles()).toEqual(['Monitoring interrupted', 'CPU high'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'komari' } })
    expect(shownTitles()).toEqual(['Monitoring interrupted'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include history' }))
    expect(shownTitles()).toEqual(['Monitoring interrupted', 'Old recovered alert'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Host' }), { target: { value: database.id } })
    expect(shownTitles()).toEqual([])
    expect(screen.getByText('No matching alerts')).toBeVisible()
  })

  it('keeps inactive-source active incidents out of current alerts but preserves their original audit in explicit history', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    const row: HostIncident = {
      key: 'komari:web:integration:archived', hostId: host.id, hostName: host.name, title: 'Previous source interruption',
      source: 'komari', status: 'active', updatedAt: 250, busy: false, historyOnly: true, act: onAction,
      audit: [
        { auditId: 'opened-audit', alertId: 'archived', fingerprint: 'original-fingerprint', event: 'opened', status: 'active', actor: 'komari-sync', operationJobId: null, at: 100 },
        { auditId: 'ack-audit', alertId: 'archived', fingerprint: 'original-fingerprint', event: 'acknowledged', status: 'acknowledged', actor: 'original-operator', operationJobId: 'original-operation-job', at: 200 },
      ],
    }
    const before = JSON.stringify(row)
    render(panel([row]))
    expect(shownTitles()).toEqual([])
    expect(screen.getByText('No matching alerts')).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include history' }))
    const incident = screen.getByTestId('host-incident')
    expect(shownTitles()).toEqual(['Previous source interruption'])
    expect(within(incident).getByText('History · inactive data source')).toBeVisible()
    const audit = within(incident).getByText('Audit history (2)').closest('details')!
    expect(audit).not.toHaveAttribute('open')
    expect(within(audit).getByText('original-operator')).not.toBeVisible()
    fireEvent.click(within(audit).getByText('Audit history (2)'))
    expect(audit).toHaveAttribute('open')
    for (const text of ['Opened', 'komari-sync', 'Acknowledged', 'original-operator', '#original-operation-job']) {
      expect(within(audit).getByText(text)).toBeVisible()
    }
    fireEvent.click(within(incident).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('close'))
    expect(JSON.stringify(row)).toBe(before)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include history' }))
    expect(shownTitles()).toEqual([])
  })

  it('offers no host navigation for aggregate incidents with no associated host', () => {
    const onOpenHost = vi.fn()
    render(panel([{
      key: 'komari:unassigned:integration:load', hostId: '', hostName: 'Monitoring server',
      title: 'Aggregate load alert', source: 'komari', status: 'active', updatedAt: 250, busy: false,
    }], onOpenHost))
    const incident = screen.getByTestId('host-incident')
    expect(incident).toHaveAttribute('data-host-id', '')
    expect(within(incident).getByText('Aggregate load alert')).toBeVisible()
    expect(within(incident).queryByRole('button', { name: 'Host overview' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Host' }).children).toHaveLength(1)
    expect(onOpenHost).not.toHaveBeenCalled()
  })

  it('clears a disappeared source/host selection during refresh instead of leaving an invisible filter', () => {
    const summaries = new Map([
      [host.id, summary({ komariAlerts: [komari()] })],
      [database.id, summary({ localAlerts: [local({ hostId: database.id, name: 'Disk pressure' })] })],
    ])
    const rows = buildHostIncidents([host, database], summaries, 'vault-a')
    const view = render(panel(rows))
    fireEvent.change(screen.getByRole('combobox', { name: 'Host' }), { target: { value: host.id } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'komari' } })
    expect(shownTitles()).toEqual(['Monitoring interrupted'])
    view.rerender(panel(rows.filter(row => row.hostId === database.id)))
    expect(screen.queryByRole('combobox', { name: 'Source' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Host' })).toHaveValue('')
    expect(shownTitles()).toEqual(['Disk pressure'])
    // A later sync bringing the source back must not reactivate stale filters.
    view.rerender(panel(rows))
    expect(screen.getByRole('combobox', { name: 'Source' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Host' })).toHaveValue('')
    expect(shownTitles()).toEqual(['Monitoring interrupted', 'Disk pressure'])
  })

  it('forwards local and Komari actions to existing confirmation callbacks without changing lifecycle state itself', async () => {
    const localAlert = local()
    const komariAlert = komari()
    const onLocal = vi.fn().mockResolvedValue(undefined)
    const onKomari = vi.fn().mockResolvedValue(undefined)
    const onOpen = vi.fn()
    const rows = buildHostIncidents([host], new Map([[host.id, summary({ localAlerts: [localAlert], komariAlerts: [komariAlert], onLocalAlertAction: onLocal, onKomariAlertAction: onKomari })]]), 'vault-a')
    render(panel(rows, onOpen))
    const localCard = screen.getAllByTestId('host-incident').find(element => element.dataset.source === 'ssh-agentless')!
    const komariCard = screen.getAllByTestId('host-incident').find(element => element.dataset.source === 'komari')!
    fireEvent.click(within(localCard).getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(onLocal).toHaveBeenCalledWith(localAlert, 'acknowledge'))
    fireEvent.click(within(komariCard).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(onKomari).toHaveBeenCalledWith('close', expect.objectContaining({ alertId: komariAlert.alertId, integrationId: komariAlert.integrationId, nodeId: komariAlert.nodeId })))
    expect(localAlert.status).toBe('active')
    expect(komariAlert.status).toBe('active')
    expect(within(localCard).getByRole('button', { name: 'Acknowledge' })).toBeVisible()
    fireEvent.click(within(localCard).getByRole('button', { name: 'Host overview' }))
    expect(onOpen).toHaveBeenCalledWith(host.id)
  })

  it('blocks all duplicate actions while a confirmation path is pending and respects source busy state', async () => {
    const waiting = deferred()
    const onLocal = vi.fn(() => waiting.promise)
    const onKomari = vi.fn()
    const makeRows = (busy = false) => buildHostIncidents([host], new Map([[host.id, summary({ localAlerts: [local()], komariAlerts: [komari()], onLocalAlertAction: onLocal, onKomariAlertAction: onKomari, komariAlertBusy: busy ? 'busy' : null })]]), 'vault-a')
    const view = render(panel(makeRows(true)))
    const cards = screen.getAllByTestId('host-incident')
    const localCard = cards.find(element => element.dataset.source === 'ssh-agentless')!
    const komariCard = cards.find(element => element.dataset.source === 'komari')!
    expect(within(komariCard).getByRole('button', { name: 'Acknowledge' })).toBeDisabled()
    fireEvent.click(within(komariCard).getByRole('button', { name: 'Acknowledge' }))
    expect(onKomari).not.toHaveBeenCalled()
    fireEvent.click(within(localCard).getByRole('button', { name: 'Acknowledge' }))
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button', { name: /Acknowledge|Archive/ }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(within(localCard).getByRole('button', { name: 'Archive' }))
    expect(onLocal).toHaveBeenCalledTimes(1)
    await act(async () => { waiting.resolve(); await waiting.promise })
    view.rerender(panel(makeRows()))
    expect(screen.getAllByRole('button', { name: /Acknowledge|Archive/ }).every(button => !(button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('shows action failure, preserves the row and allows a later retry', async () => {
    const action = vi.fn().mockRejectedValueOnce(new Error('persistence unavailable')).mockResolvedValueOnce(undefined)
    const rows = buildHostIncidents([host], new Map([[host.id, summary({ localAlerts: [local()], onLocalAlertAction: action })]]), 'vault-a')
    render(panel(rows))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
    expect(shownTitles()).toEqual(['CPU high'])
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers no mutation for closed alerts or missing handlers and only close for recovered alerts', () => {
    const onKomari = vi.fn()
    const rows = buildHostIncidents([host], new Map([[host.id, summary({
      localAlerts: [local()],
      komariAlerts: [komari({ alertId: 'resolved', title: 'Recovered', status: 'resolved' }), komari({ alertId: 'closed', title: 'Closed', status: 'closed' })],
      onKomariAlertAction: onKomari,
    })]]), 'vault-a')
    render(panel(rows))
    expect(screen.queryByRole('button', { name: /alert$/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include history' }))
    const recovered = screen.getByText('Recovered').closest('article')!
    const closed = screen.getByText('Closed').closest('article')!
    expect(within(recovered).queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument()
    expect(within(recovered).getByRole('button', { name: 'Archive' })).toBeVisible()
    expect(within(closed).queryByRole('button')).not.toBeInTheDocument()
  })
})
