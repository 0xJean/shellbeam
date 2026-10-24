import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceProviderSource, WorkspaceProviderState } from '@/lib/workspace-provider-state'
import { workspaceProviderCopy } from '@/lib/locales/workspace-provider'
import { monitoringSourcesCopy } from '@/lib/locales/monitoring-sources'
import { WorkspaceProviderSummary } from './workspace-provider-summary'

const now = Date.UTC(2026, 9, 18, 12)
const komari: WorkspaceProviderSource = {
  kind: 'komari', id: 'komari-a', nodeId: 'node-a', health: 'online',
  sampledAt: now - 30_000, receivedAt: now - 20_000, lastSyncedAt: now - 10_000,
  ttlMs: 60_000, expiresAt: now + 30_000, confidence: 'partial',
  capabilities: ['metrics'], syncError: false,
}
const ssh: WorkspaceProviderSource = {
  kind: 'ssh-agentless', id: 'ssh-agentless', health: 'offline',
  sampledAt: null, receivedAt: now, lastSyncedAt: null,
  ttlMs: null, expiresAt: null, confidence: null, capabilities: [], syncError: false,
}
function state(source: WorkspaceProviderSource, sources = [source]): WorkspaceProviderState {
  return { view: null, source, sources, loading: false, error: false, telemetry: null, refresh: vi.fn(async () => {}), now }
}

describe('Workspace Provider presentation', () => {
  afterEach(() => localStorage.removeItem('shellbeam.locale'))

  it('does not advertise providers or integration setup when no source is configured', () => {
    const current = { ...state(ssh), source: null, sources: [], loading: false }
    const view = render(<WorkspaceProviderSummary state={current} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<WorkspaceProviderSummary state={{ ...current, loading: true }} />)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('resets diagnostics when the host scope changes and does not reveal old details on return', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    const scoped = (hostId: string) => ({ ...state(komari), view: { host: { id: hostId, vaultId: 'scope' } } as WorkspaceProviderState['view'] })
    const view = render(<WorkspaceProviderSummary state={scoped('first')} />)
    fireEvent.click(screen.getByText(monitoringSourcesCopy.en.details))
    expect(screen.getByTestId('workspace-data-source-details')).toHaveAttribute('open')
    view.rerender(<WorkspaceProviderSummary state={scoped('second')} />)
    expect(screen.getByTestId('workspace-data-source-details')).not.toHaveAttribute('open')
    view.rerender(<WorkspaceProviderSummary state={scoped('first')} />)
    expect(screen.getByTestId('workspace-data-source-details')).not.toHaveAttribute('open')
  })

  it.each(['en', 'zh-CN'] as const)('keeps the source and original sample visible while technical details are collapsed in %s', (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    render(<WorkspaceProviderSummary state={state(komari, [komari, ssh])} />)
    const current = screen.getByTestId('workspace-current-source')
    expect(current).toBeVisible()
    expect(current).toHaveTextContent(locale === 'en' ? 'Monitoring service' : '监控服务')
    expect(current).toHaveTextContent(new Date(komari.sampledAt!).toLocaleString(locale))
    const disclosure = screen.getByTestId('workspace-data-source-details')
    expect(disclosure).not.toHaveAttribute('open')
    expect(screen.getByText('komari-a · node-a')).not.toBeVisible()
    fireEvent.click(screen.getByText(monitoringSourcesCopy[locale].details))
    expect(disclosure).toHaveAttribute('open')
    expect(screen.getByText('komari-a · node-a')).toBeVisible()
    expect(screen.getAllByTestId('workspace-provider-source')).toHaveLength(2)
  })

  it('keeps selected Komari sampling, delivery, synchronization and capabilities separate from failed SSH', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    render(<WorkspaceProviderSummary state={state(komari, [komari, ssh])} />)
    const rows = screen.getAllByTestId('workspace-provider-source')
    const selected = rows.find((row) => row.dataset.selected === 'true')!
    expect(selected).toHaveAttribute('data-provider', 'komari')
    expect(selected).toHaveAttribute('data-health', 'online')
    expect(within(selected).getByTestId('workspace-provider-sampled')).toHaveTextContent(new Date(komari.sampledAt!).toLocaleString('en'))
    expect(within(selected).getByTestId('workspace-provider-synced')).toHaveTextContent(new Date(komari.lastSyncedAt!).toLocaleString('en'))
    expect(within(selected).getByText('Partial')).toBeInTheDocument()
    const capabilities = within(selected).getByLabelText('Provider capabilities')
    expect(capabilities).toHaveTextContent('Metrics')
    expect(capabilities).not.toHaveTextContent('Services')
    const other = rows.find((row) => row.dataset.selected === 'false')!
    expect(other).toHaveAttribute('data-health', 'offline')
    expect(within(other).queryByTestId('workspace-provider-synced')).not.toBeInTheDocument()
  })

  it('never substitutes reception time for an unavailable sync time or fabricates capability support', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    render(<WorkspaceProviderSummary state={state({ ...komari, lastSyncedAt: null, capabilities: [], syncError: true })} />)
    expect(screen.getByTestId('workspace-provider-synced')).toHaveTextContent(/^Unknown$/)
    expect(screen.getByLabelText('Provider capabilities')).toHaveTextContent('No capabilities reported')
    expect(screen.getByRole('status')).toHaveTextContent('The monitoring service refresh status could not be read.')
  })

  it.each(['en', 'zh-CN'] as const)('explains stale Komari fallback in %s while retaining the original Komari state', (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const selected = { ...ssh, health: 'online' as const, fallbackProvider: 'komari' as const, fallbackReason: 'internal English diagnostic' }
    render(<WorkspaceProviderSummary state={state(selected, [selected, { ...komari, health: 'stale' }])} />)
    expect(screen.getByTestId('workspace-provider-fallback')).toHaveTextContent(workspaceProviderCopy[locale].usingSsh)
    expect(screen.queryByText('internal English diagnostic')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('workspace-provider-source').find((row) => row.dataset.provider === 'komari')).toHaveAttribute('data-health', 'stale')
  })

  it.each(['en', 'zh-CN'] as const)('shows first-report and interruption status without opening details in %s', (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const selected = { ...ssh, health: 'online' as const, fallbackProvider: 'komari' as const }
    const waiting = { ...komari, health: 'unknown' as const, sampledAt: null, waitingForFirstReport: true }
    const view = render(<WorkspaceProviderSummary state={state(selected, [selected, waiting])} />)
    expect(screen.getByTestId('workspace-data-source-details')).not.toHaveAttribute('open')
    expect(screen.getByTestId('workspace-provider-attention')).toBeVisible()
    expect(screen.getByTestId('workspace-provider-attention')).toHaveTextContent(monitoringSourcesCopy[locale].waitingForFirstReport)
    view.rerender(<WorkspaceProviderSummary state={state(selected, [selected, { ...waiting, waitingForFirstReport: false, health: 'offline' }])} />)
    expect(screen.getByTestId('workspace-provider-attention')).toBeVisible()
    expect(screen.getByTestId('workspace-provider-attention')).not.toHaveTextContent(monitoringSourcesCopy[locale].waitingForFirstReport)
    view.rerender(<WorkspaceProviderSummary state={state(waiting)} />)
    expect(screen.getByTestId('workspace-current-source')).toHaveTextContent(monitoringSourcesCopy[locale].waitingForFirstReport)
  })

  it('offers a read-only saved-observation retry when refresh fails', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    const current = { ...state(komari), error: true }
    render(<WorkspaceProviderSummary state={current} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Saved observations could not be refreshed.')
    fireEvent.click(screen.getByText(monitoringSourcesCopy.en.details))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved observations' }))
    expect(current.refresh).toHaveBeenCalledOnce()
  })
})
