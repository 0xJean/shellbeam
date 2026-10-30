import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const forward = vi.hoisted(() => ({ list: vi.fn(), status: vi.fn(), stats: vi.fn() }))
vi.mock('@/lib/port-forward', () => ({ listPortForwardRules: forward.list, portForwardTunnelStatus: forward.status, portForwardTunnelStats: forward.stats }))

import { MobileToolsPage } from './mobile-tools-page'

describe('MobileToolsPage', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'en')
    forward.list.mockResolvedValue([
      { id: 'db', hostId: 'h', name: 'Prod database', type: 'local', bindHost: '127.0.0.1', bindPort: 5433, targetHost: '10.0.3.12', targetPort: 5432, createdAt: 1, updatedAt: 1 },
      { id: 'web', hostId: 'h', name: 'Grafana', type: 'local', bindHost: 'localhost', bindPort: 3000, targetHost: 'prod-web-01', targetPort: 3000, createdAt: 1, updatedAt: 1 },
    ])
    forward.status.mockImplementation(async (id: string) => id === 'db')
    forward.stats.mockResolvedValue([{ ruleId: 'db', running: true, bytesIn: 24 * 1024 * 1024, bytesOut: 1024 * 1024, startedAt: 1 }])
  })

  it('lists only running port forwards first', async () => {
    render(<MobileToolsPage vaultId="v" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('mobile-tool-forward')).toHaveLength(1))
    expect(screen.getByTestId('mobile-tool-forward')).toHaveTextContent('127.0.0.1:5433 → 10.0.3.12:5432')
    expect(screen.getByTestId('mobile-tool-port-forwarding')).toHaveTextContent('2 rules')
  })

  it('shows traffic for running port forwards', async () => {
    render(<MobileToolsPage vaultId="v" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('mobile-tool-forward-traffic')).toHaveTextContent('↓ 24.0 MB · ↑ 1.0 MB'))
  })

  it('opens every former "More" destination', () => {
    const onNavigate = vi.fn()
    render(<MobileToolsPage vaultId="v" onNavigate={onNavigate} />)
    for (const nav of ['port-forwarding', 'asset-inventory', 'known-hosts', 'keychain', 'snippets', 'activity', 'sync', 'backup', 'guide']) {
      fireEvent.click(screen.getByTestId(`mobile-tool-${nav}`))
      expect(onNavigate).toHaveBeenLastCalledWith(nav)
    }
  })
})
