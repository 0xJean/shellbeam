import { describe, expect, it } from 'vitest'
import type { HostProfile } from './hosts'
import {
  SITE_SSL_SCAN_COMMAND,
  buildCertificateOperationCommand,
  buildSiteOperationCommand,
  parseSiteSslOutput,
  runSiteSslScan,
} from './sites-ssl'

const host: HostProfile = {
  id: 'host-1',
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
    expect(result.sites[0]).toMatchObject({ server: 'caddy', transport: 'proxy-jump', provider: 'ssh-agentless' })
    expect(result.durationMs).toBe(42)
  })

  it('keeps operation commands on a fixed allow-list', () => {
    expect(buildSiteOperationCommand({ server: 'nginx' }, 'config-test')).toBe('nginx -t 2>&1')
    expect(buildSiteOperationCommand({ server: 'apache' }, 'reload')).toBe('systemctl reload apache2')
    expect(buildCertificateOperationCommand('renew-dry-run')).toContain('--dry-run')
    expect(() => buildSiteOperationCommand({ server: 'unknown' }, 'reload')).toThrow('unsupported_server')
  })
})
