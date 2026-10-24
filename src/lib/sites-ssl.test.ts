import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import type { HostProfile } from './hosts'
import {
  SITE_SSL_SCAN_COMMAND,
  CERTIFICATE_DNS_SAN_FILTER,
  buildCertificateOperationCommand,
  buildSiteOperationCommand,
  parseSiteSslOutput,
  runSiteSslScan,
  runSiteOperation,
  runCertificateOperation,
} from './sites-ssl'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))

const host: HostProfile = {
  id: 'host-1',
  vaultId: 'vault-a',
  name: 'jumped host',
  address: '10.0.0.4',
  port: 22,
  username: 'ops',
  group: 'Production',
  tags: [],
  authType: 'privateKey',
  jumpHost: 'bastion.example',
  jumpPort: 2222,
  jumpUser: 'jump',
  createdAt: 1,
  updatedAt: 1,
}

const result = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode, durationMs: 1 })
const site = { server: 'nginx' as const, name: 'app.example.com' }
const siteRow = '__SB_SITE=nginx|app.example.com|/srv/app|1|/etc/nginx/nginx.conf|app.example.com|configured'
const serviceReady = '__SB_SITE_CONFIG=0\n__SB_SITE_ACTIVE=active\n__SB_SITE_VERIFY_COMPLETE=1'
const runSite = (operation: 'config-test' | 'reload' = 'reload') => runSiteOperation({ host, resolveAuthSecret: async () => '', site, operation, confirmMessage: 'Confirm?' })
const runCertificate = (operation: 'renew-dry-run' | 'renew' = 'renew') => runCertificateOperation({ host, resolveAuthSecret: async () => '', operation, confirmMessage: 'Confirm?' })
const certificateRow = (expiresInDays: number) => `__SB_CERT=/etc/letsencrypt/live/app/fullchain.pem|CN=app.example.com|CN=R3|ABC123|1700000000|${Math.floor(Date.now() / 1000 + expiresInDays * 86400)}|app.example.com|openssl`

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(invoke).mockReset().mockImplementation(async (_command, args) => ({ jobId: 'job-1', auditId: 'audit-1', ...(args as { request: object }).request }))
  vi.mocked(runWorkspaceRemoteCommand).mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { vi.restoreAllMocks() })

describe('sites and SSL operations', () => {
  it('parses bounded site and certificate marker output with ProxyJump transport', () => {
    const result = parseSiteSslOutput([
      '__SB_SITE=nginx|app.example.com www.example.com|/srv/app|1|/etc/nginx/nginx.conf|app.example.com|active',
      '__SB_CERT=/etc/letsencrypt/live/app/fullchain.pem|CN=app.example.com|CN=R3|ABC123|1700000000|4102444800|app.example.com www.example.com|openssl',
    ].join('\n'), host, 1_700_000_000_000)
    expect(result.sites[0]).toMatchObject({ server: 'nginx', ssl: true, root: '/srv/app', status: 'active', transport: 'proxy-jump' })
    expect(result.sites[0]?.domains).toEqual(['app.example.com', 'www.example.com'])
    expect(result.certificates[0]).toMatchObject({ path: '/etc/letsencrypt/live/app/fullchain.pem', issuer: 'CN=R3', status: 'valid', transport: 'proxy-jump' })
  })

  it.skipIf(process.platform === 'win32')('extracts every real OpenSSL DNS SAN before post-state identity checks', () => {
    const domains = execFileSync('sh', ['-c', `printf '%s\\n' 'X509v3 Subject Alternative Name:' '    DNS:app.example.com, DNS:www.example.com, IP Address:127.0.0.1' | ${CERTIFICATE_DNS_SAN_FILTER}`], { encoding: 'utf8' }).trim()
    const parsed = parseSiteSslOutput(certificateRow(90).replace(/app.example.com\|openssl$/, `${domains}|openssl`), host)
    expect(parsed.certificates[0].domains).toEqual(['app.example.com', 'www.example.com'])
  })

  it('runs the scan through the injected transport and preserves provider metadata', async () => {
    const calls: Array<{ host: HostProfile; command: string }> = []
    const result = await runSiteSslScan({
      host,
      resolveAuthSecret: async () => 'secret',
      now: 1_700_000_000_000,
      runCommand: async (request) => {
        calls.push(request)
        return { stdout: '__SB_SITE=caddy|example.com||||example.com|configured', stderr: '', exitCode: 0, durationMs: 42 }
      },
    })
    expect(calls[0]?.host.jumpHost).toBe('bastion.example')
    expect(calls[0]?.command).toBe(SITE_SSL_SCAN_COMMAND)
    expect(calls[0]).toMatchObject({ audit: { action: 'sites.scan', target: 'sites and certificates' } })
    expect(result.sites[0]).toMatchObject({ server: 'caddy', transport: 'proxy-jump', provider: 'ssh-agentless' })
    expect(result.durationMs).toBe(42)
  })

  it('keeps operation commands on a fixed allow-list', () => {
    expect(buildSiteOperationCommand({ server: 'nginx' }, 'config-test')).toBe('nginx -t 2>&1')
    expect(buildSiteOperationCommand({ server: 'apache' }, 'reload')).toBe('systemctl reload apache2')
    expect(buildCertificateOperationCommand('renew-dry-run')).toContain('--dry-run')
    expect(() => buildSiteOperationCommand({ server: 'unknown' }, 'reload')).toThrow('unsupported_server')
  })

  it('finishes one reload job only after configuration, active service and selected site are observed', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(serviceReady)).mockResolvedValueOnce(result(siteRow))
    const execution = await runSite()
    expect(execution?.job.status).toBe('completed')
    expect(execution?.value.verification.status).toBe('verified')
    expect(execution?.value.snapshot?.sites[0].name).toBe('app.example.com')
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'operation_job_create')).toHaveLength(1)
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'completed', resultSummary: expect.stringContaining('selected site was observed') }) })
  })

  it.each(['__SB_SITE_CONFIG=1\n__SB_SITE_ACTIVE=active\n__SB_SITE_VERIFY_COMPLETE=1', '__SB_SITE_CONFIG=0\n__SB_SITE_ACTIVE=inactive\n__SB_SITE_VERIFY_COMPLETE=1', 'unframed output'])('keeps a reload with unverifiable service/configuration unknown', async (stdout) => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(stdout))
    expect((await runSite())?.job.status).toBe('unknown')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
  })

  it('records an in-job site rescan failure as unknown rather than completed', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(serviceReady)).mockRejectedValueOnce(new Error('scan permission denied'))
    const execution = await runSite()
    expect(execution?.job.status).toBe('unknown')
    expect(execution?.value.snapshot?.errorCode).toBe('auth')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'remote_state_unknown' }) })
  })

  it('verifies certificate validity and renewal progress against the confirmed in-job baseline', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result(certificateRow(10))).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(certificateRow(90)))
    const execution = await runCertificate()
    expect(execution?.job.status).toBe('completed')
    expect(execution?.value.verification).toMatchObject({ status: 'verified', summary: expect.stringContaining('expiry extended=1') })
    expect(runWorkspaceRemoteCommand).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: 'certbot renew --non-interactive 2>&1' }))
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'operation_job_create')).toHaveLength(1)
  })

  it('does not verify a renewal that loses any observed DNS SAN', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result(certificateRow(10).replace(/app.example.com\|openssl$/, 'app.example.com www.example.com|openssl'))).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(certificateRow(90)))
    expect((await runCertificate())?.job.status).toBe('unknown')
  })

  it('reports a valid certbot not-due no-op as unchanged instead of claiming renewed certificates', async () => {
    const certificate = certificateRow(90)
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result(certificate)).mockResolvedValueOnce(result('not due')).mockResolvedValueOnce(result(certificate))
    const execution = await runCertificate()
    expect(execution?.job.status).toBe('completed')
    expect(execution?.value.verification.summary).toContain('expiry extended=0; unchanged=1')
  })

  it.each(['', certificateRow(-1), certificateRow(5)])('does not complete renewal when the original certificate disappears, remains expired or regresses', async (stdout) => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result(certificateRow(10))).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(stdout))
    expect((await runCertificate())?.job.status).toBe('unknown')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(3)
  })

  it('does not mutate certificates without an observable baseline and keeps failed post-scans unknown', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockRejectedValueOnce(new Error('baseline unreadable'))
    expect((await runCertificate())?.value.verification.summary).toContain('No renewal executed')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(1)
    vi.mocked(runWorkspaceRemoteCommand).mockClear().mockResolvedValueOnce(result(certificateRow(10))).mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('rescan unavailable'))
    expect((await runCertificate())?.job.status).toBe('unknown')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(3)
  })

  it('shows the host, route and command in site/certificate confirmations and keeps child reads inside one job', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(serviceReady)).mockResolvedValueOnce(result(siteRow))
    await runSite()
    const review = vi.mocked(window.confirm).mock.calls[0][0]
    expect(review).toContain('jumped host · ops@10.0.0.4:22')
    expect(review).toContain('ProxyJump jump@bastion.example:2222')
    expect(review).toContain('Command summary: systemctl reload nginx')
    expect(vi.mocked(invoke).mock.calls.find(([command]) => command === 'operation_job_create')?.[1]).toMatchObject({ request: { vaultId: 'vault-a', hostId: host.id } })
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls.every(([request]) => !request.audit)).toBe(true)
    vi.mocked(runWorkspaceRemoteCommand).mockReset().mockResolvedValueOnce(result(certificateRow(10))).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(certificateRow(90)))
    await runCertificate()
    expect(vi.mocked(window.confirm).mock.calls[1][0]).toContain('Command summary: certbot renew --non-interactive')
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls.every(([request]) => !request.audit)).toBe(true)
  })

  it('rejects unknown post-state metadata even with exit zero and all expected markers', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result(serviceReady), errorType: 'unknown' })
    expect((await runSite())?.job.status).toBe('unknown')
    vi.mocked(runWorkspaceRemoteCommand).mockReset().mockResolvedValueOnce(result(certificateRow(10))).mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result(certificateRow(90)), errorType: 'unknown' })
    expect((await runCertificate())?.job.status).toBe('unknown')
  })

  it('performs zero remote reads or mutations when either confirmation is rejected', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    expect(await runSite()).toBeNull()
    expect(await runCertificate()).toBeNull()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })

  it('does not treat config tests or renewal dry runs as live changes', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValue(result())
    expect((await runSite('config-test'))?.value.verification.summary).toContain('configuration test passed')
    expect((await runCertificate('renew-dry-run'))?.value.verification.summary).toContain('live certificate renewal was not requested')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
  })
})
