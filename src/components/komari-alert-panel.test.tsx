import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { reconcileKomariAlerts, type KomariAlertState } from '@/lib/komari-alerts'
import { KomariAlertPanel } from './komari-alert-panel'

const state: KomariAlertState = {
  schemaVersion: 1,
  alerts: [{
    schemaVersion: 1,
    source: 'komari',
    alertId: 'komari-alert-1',
    fingerprint: 'prod|node-1|host-1|offline',
    integrationId: 'prod',
    nodeId: 'node-1',
    hostId: 'host-1',
    kind: 'probe-offline',
    title: 'Komari offline notifications',
    severity: 'critical',
    count: 2,
    status: 'active',
    firstSeenAt: 1_000,
    lastSeenAt: 2_000,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    closedAt: null,
    relatedOperationJobId: 'job-42',
    deduplicatedCount: 1,
  }],
  audit: [{
    auditId: 'audit-1',
    alertId: 'komari-alert-1',
    fingerprint: 'prod|node-1|host-1|offline',
    event: 'opened',
    status: 'active',
    actor: 'komari-sync',
    operationJobId: null,
    at: 1_000,
  }],
  summary: {
    load: 0,
    offline: 2,
    total: 2,
    active: 1,
    open: 1,
    acknowledged: 0,
    resolved: 0,
    closed: 0,
    deduplicated: 1,
    localUpdatedAt: 2_000,
    updatedAt: 2_000,
  },
}

function renderPanel(props: Partial<React.ComponentProps<typeof KomariAlertPanel>> = {}) {
  return render(<I18nProvider><KomariAlertPanel state={state} {...props} /></I18nProvider>)
}

describe('KomariAlertPanel', () => {
  it('shows lifecycle status, operation linkage and audit history', () => {
    renderPanel()
    expect(screen.getByTestId('komari-alert-panel')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Job job-42')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Audit history (1)'))
    expect(screen.getByText('Opened')).toBeInTheDocument()
  })

  it('runs acknowledgement and close actions through controlled callbacks', async () => {
    const onAcknowledge = vi.fn()
    const onClose = vi.fn()
    renderPanel({ onAcknowledge, onClose })
    fireEvent.click(screen.getByTestId('komari-alert-ack-komari-alert-1'))
    await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith(state.alerts[0]))
    fireEvent.click(screen.getByTestId('komari-alert-close-komari-alert-1'))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(state.alerts[0]))
  })

  it('shows one actionable incident while keeping legacy diagnostic IDs visible in details', () => {
    const scope = { integrationId: 'prod', nodeId: 'node', hostId: 'host', count: 1, updatedAt: 1_000 }
    const legacy = reconcileKomariAlerts([], [
      { ...scope, kind: 'probe-unknown', title: 'Komari Probe health is unknown', severity: 'warning' },
      { ...scope, kind: 'probe-error:provider', title: 'Komari Probe provider error: Probe recovery failed after 2 retries: Komari returned no dated metric observations', severity: 'critical' },
      { ...scope, kind: 'probe-error:metrics', title: 'Komari Probe metrics error: Komari returned no dated metric observations', severity: 'warning' },
    ], { now: 1_000 })
    const onClose = vi.fn()
    renderPanel({ state: { schemaVersion: 1, ...legacy }, onClose })
    expect(screen.getByText('3 related diagnostics')).toBeInTheDocument()
    expect(screen.getByText('Acknowledging or closing updates ShellBeam records only; Komari server state is unchanged.')).toBeInTheDocument()
    expect(screen.getAllByRole('article')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show alert details' }))
    for (const alert of legacy.alerts) expect(screen.getByText(new RegExp(alert.alertId))).toBeInTheDocument()
  })

  it('navigates to the host and operation when requested', () => {
    const onOpenHost = vi.fn()
    const onOpenOperation = vi.fn()
    renderPanel({ onOpenHost, onOpenOperation })
    fireEvent.click(screen.getByText('Host host-1'))
    fireEvent.click(screen.getByText('Job job-42'))
    expect(onOpenHost).toHaveBeenCalledWith('host-1')
    expect(onOpenOperation).toHaveBeenCalledWith('job-42')
  })
})
