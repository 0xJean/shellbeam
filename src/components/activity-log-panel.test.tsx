import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { ActivityLogPanel } from './activity-log-panel'

const { listActivityLog, listOperationAudit } = vi.hoisted(() => ({ listActivityLog: vi.fn(), listOperationAudit: vi.fn() }))
vi.mock('@/lib/activity-log', () => ({ listActivityLog }))
vi.mock('@/lib/operation-job', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operation-job')>('@/lib/operation-job')
  return { ...actual, listOperationAudit }
})
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'vault-a' }) }))
vi.mock('./operations-audit-center', () => ({ default: () => <div data-testid="audit-center" /> }))

const now = Date.now()
const hour = 3_600_000

describe('ActivityLogPanel', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'en')
    listActivityLog.mockReset().mockResolvedValue([
      { id: 'a1', event: 'connect', hostName: 'prod-web-01', hostAddress: '47.242.18.6', username: 'root', createdAt: now - hour },
      { id: 'a2', event: 'connect', hostName: 'prod-web-01', hostAddress: '47.242.18.6', createdAt: now - 2 * hour },
      { id: 'a3', event: 'auth_fail', hostName: 'db-master', hostAddress: '10.0.3.12', createdAt: now - 3 * hour },
      { id: 'a4', event: 'connect', hostName: 'old-box', hostAddress: '10.0.0.9', createdAt: now - 30 * 24 * hour },
    ])
    listOperationAudit.mockReset().mockResolvedValue([])
  })

  it('renders the day timeline and stats from the activity records', async () => {
    render(<I18nProvider><ActivityLogPanel /></I18nProvider>)
    expect(await screen.findByText('db-master')).toBeInTheDocument()
    expect(listActivityLog).toHaveBeenCalledWith('vault-a')
    expect(listOperationAudit).toHaveBeenCalledWith({ vaultId: 'vault-a', limit: 100 })
    expect(screen.getAllByText('old-box')).toHaveLength(1)

    const heatmap = screen.getByTestId('history-heatmap')
    expect(within(heatmap).getByText('4 events')).toBeInTheDocument()
    expect(heatmap.querySelectorAll('[data-count]')).toHaveLength(84)

    expect(within(screen.getByTestId('history-week')).getByText('3 events')).toBeInTheDocument()
    const top = screen.getByTestId('history-top-hosts')
    expect(within(top).getByText('prod-web-01')).toBeInTheDocument()
    expect(within(top).getByText('2')).toBeInTheDocument()
    expect(within(top).queryByText('old-box')).not.toBeInTheDocument()
    const attention = screen.getByTestId('history-attention')
    expect(within(attention).getByText('Authentication failures').nextSibling).toHaveTextContent('1')
  })

  it('filters by event type and switches to the audit view', async () => {
    render(<I18nProvider><ActivityLogPanel /></I18nProvider>)
    await screen.findByText('db-master')
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Filter by event' })).getByRole('tab', { name: 'Auth failed' }))
    expect(screen.queryByText('old-box')).not.toBeInTheDocument()
    expect(screen.getByText('db-master')).toBeInTheDocument()

    expect(screen.queryByTestId('audit-center')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Operation records/ }))
    expect(screen.getByTestId('audit-center')).toBeInTheDocument()
  })

  it('shows the empty state', async () => {
    listActivityLog.mockResolvedValue([])
    render(<I18nProvider><ActivityLogPanel /></I18nProvider>)
    expect(await screen.findByText('No activity recorded yet')).toBeInTheDocument()
  })
})
