import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { SitesSslPanel } from './sites-ssl-panel'
import { runSiteOperation, runCertificateOperation } from '@/lib/sites-ssl'

const runSiteSslScan = vi.fn()

vi.mock('@/lib/sites-ssl', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sites-ssl')>('@/lib/sites-ssl')
  return { ...actual, runSiteSslScan: (options: unknown) => runSiteSslScan(options), runSiteOperation: vi.fn(), runCertificateOperation: vi.fn() }
})

const host: HostProfile = {
  id: 'host-1', name: 'edge', address: '10.0.0.8', port: 2222, username: 'ops', group: 'Production', tags: [], authType: 'privateKey', privateKeyRef: 'key', jumpHost: 'bastion', jumpPort: 22, jumpUser: 'jump', createdAt: 1, updatedAt: 1,
}

describe('SitesSslPanel', () => {
  afterEach(() => { cleanup() })
  beforeEach(() => {
    vi.mocked(runSiteOperation).mockReset()
    vi.mocked(runCertificateOperation).mockReset()
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

  it('discards a delayed old-Vault scan when the same host id is selected in another Vault', async () => {
    const base = await runSiteSslScan()
    const oldSnapshot = { ...base, sites: [{ ...base.sites[0], name: 'old.example', domains: ['old.example'] }], certificates: [] }
    const newSnapshot = { ...base, sites: [{ ...base.sites[0], name: 'new.example', domains: ['new.example'] }], certificates: [] }
    let completeOld!: (snapshot: typeof oldSnapshot) => void
    runSiteSslScan.mockReset().mockImplementationOnce(() => new Promise((resolve) => { completeOld = resolve })).mockResolvedValueOnce(newSnapshot)
    const resolveAuthSecret = vi.fn()
    const view = render(<I18nProvider><SitesSslPanel host={{ ...host, vaultId: 'vault-a' }} resolveAuthSecret={resolveAuthSecret} /></I18nProvider>)
    view.rerender(<I18nProvider><SitesSslPanel host={{ ...host, vaultId: 'vault-b' }} resolveAuthSecret={resolveAuthSecret} /></I18nProvider>)
    await screen.findAllByText('new.example')
    await act(async () => { completeOld(oldSnapshot) })
    expect(screen.queryByText('old.example')).not.toBeInTheDocument()
    expect(screen.getAllByText('new.example').length).toBeGreaterThan(0)
  })

  it.each(['site', 'certificate'] as const)('displays canonical %s verification and uses its returned snapshot without rescanning outside the job', async (kind) => {
    const snapshot = { ...(await runSiteSslScan()), certificates: [] }
    const execution = { job: { jobId: 'job-1', auditId: 'audit-1', status: 'unknown' }, value: { stdout: '', stderr: '', exitCode: 0, durationMs: 2, verification: { status: 'unknown', summary: 'Post-state unavailable; recheck before retrying.' }, snapshot } }
    vi.mocked(runSiteOperation).mockResolvedValue(execution as Awaited<ReturnType<typeof runSiteOperation>>)
    vi.mocked(runCertificateOperation).mockResolvedValue(execution as Awaited<ReturnType<typeof runCertificateOperation>>)
    runSiteSslScan.mockClear()
    render(<I18nProvider><SitesSslPanel host={host} resolveAuthSecret={vi.fn()} /></I18nProvider>)
    await screen.findByText('Valid')
    fireEvent.click(screen.getByRole('button', { name: kind === 'site' ? 'Reload service' : 'Renew certificates' }))
    const output = await screen.findByTestId('sites-ssl-output')
    expect(output).toHaveTextContent('status=unknown')
    expect(output).toHaveTextContent('verification=unknown; Post-state unavailable')
    expect(screen.queryByText('Valid')).not.toBeInTheDocument()
    expect(runSiteSslScan).toHaveBeenCalledTimes(1)
  })
})
