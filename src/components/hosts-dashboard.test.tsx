import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { HostOpsRefreshIndicator } from './hosts-dashboard'

function renderIndicator(props: React.ComponentProps<typeof HostOpsRefreshIndicator>) {
  return render(<I18nProvider><HostOpsRefreshIndicator {...props} /></I18nProvider>)
}

describe('host operations refresh indicator', () => {
  it('shows a visible in-flight state while the cross-session refresh is running', () => {
    renderIndicator({ status: 'refreshing', lastRefreshedAt: null, error: null })

    expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'refreshing')
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing operations')
  })

  it('marks a persistence fallback after a failed remote refresh', () => {
    renderIndicator({ status: 'recovered', lastRefreshedAt: Date.UTC(2026, 0, 2, 3, 4, 5), error: 'remote unavailable' })

    expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'recovered')
    expect(screen.getByRole('status')).toHaveTextContent('Using persisted data')
    expect(screen.getByRole('status')).toHaveAttribute('title', 'remote unavailable')
  })

  it('surfaces a terminal refresh failure when persisted recovery is unavailable', () => {
    renderIndicator({ status: 'error', lastRefreshedAt: null, error: 'journal unavailable' })

    expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'error')
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed')
    expect(screen.getByRole('status')).toHaveAttribute('title', 'journal unavailable')
  })
})
