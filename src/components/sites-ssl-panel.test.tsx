import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { SitesSslPanel } from './sites-ssl-panel'

const runSiteSslScan = vi.fn()

vi.mock('@/lib/sites-ssl', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sites-ssl')>('@/lib/sites-ssl')
  return { ...actual, runSiteSslScan: (options: unknown) => runSiteSslScan(options) }
})

const host: HostProfile = {
  id: 'host-1', name: 'edge', address: '10.0.0.8', port: 2222, username: 'ops', group: 'Production', tags: [], authType: 'privateKey', privateKeyRef: 'key', jumpHost: 'bastion', jumpPort: 22, jumpUser: 'jump', createdAt: 1, updatedAt: 1,
}

describe('SitesSslPanel', () => {
  beforeEach(() => {
    runSiteSslScan.mockReset()
    runSiteSslScan.mockResolvedValue({
      hostId: host.id,
      sites: [{ id: 'site-1', hostId: host.id, server: 'nginx', name: 'app.example.com', domains: ['app.example.com'], root: '/srv/app', configPath: '/etc/nginx/nginx.conf', ssl: true, status: 'active', observedAt: 1, transport: 'proxy-jump', provider: 'ssh-agentless' }],
      certificates: [{ id: 'cert-1', hostId: host.id, path: '/etc/letsencrypt/live/app/fullchain.pem', subject: 'CN=app.example.com', issuer: 'CN=R3', domains: ['app.example.com'], notBefore: 1, notAfter: Date.now() + 100 * 24 * 60 * 60 * 1000, daysRemaining: 100, status: 'valid', observedAt: 1, transport: 'proxy-jump', provider: 'ssh-agentless' }],
      checkedAt: 1,
      durationMs: 20,
      transport: 'proxy-jump',
      provider: 'ssh-agentless',
    })
    localStorage.setItem('shellbeam.locale', 'en')
  })

  it('renders discovered site and certificate summaries with ProxyJump transport', async () => {
    render(<I18nProvider><SitesSslPanel host={host} resolveAuthSecret={vi.fn()} /></I18nProvider>)
    await waitFor(() => expect(screen.getAllByText('app.example.com').length).toBeGreaterThan(0))
    expect(screen.getByTestId('sites-ssl-panel')).toBeInTheDocument()
    expect(screen.getByText('Valid')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan sites' })).toBeInTheDocument()
    expect(runSiteSslScan).toHaveBeenCalledWith(expect.objectContaining({ host, resolveAuthSecret: expect.any(Function) }))
  })
})
