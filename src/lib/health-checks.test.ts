import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import {
  buildHealthCheckCommand,
  defaultHealthCheck,
  loadHealthChecks,
  normalizeHealthCheck,
  runHealthCheck,
  runHealthCheckBatch,
  saveHealthChecks,
} from './health-checks'

const host: HostProfile = {
  id: 'host-1', name: 'edge', address: '10.0.0.8', port: 2222, username: 'ops', group: 'Production', tags: [], authType: 'privateKey',
  privateKeyRef: 'vault:key', jumpHost: 'bastion.internal', jumpPort: 22, jumpUser: 'jump',
  createdAt: 1, updatedAt: 1,
}

describe('health checks', () => {
  beforeEach(() => localStorage.clear())

  it('normalizes TCP and HTTP definitions without accepting shell or URL credentials', () => {
    expect(normalizeHealthCheck({ ...defaultHealthCheck(host), name: ' ssh ', timeoutMs: 999_999 })).toMatchObject({ name: 'ssh', timeoutMs: 60_000, port: 2222 })
    expect(normalizeHealthCheck({ id: 'http', hostId: host.id, name: 'web', kind: 'http', target: 'https://example.com/health', expectedStatus: 204, timeoutMs: 1000, intervalMs: 5000, enabled: true })).toMatchObject({ target: 'https://example.com/health', expectedStatus: 204 })
    expect(() => normalizeHealthCheck({ id: 'bad', hostId: host.id, name: 'bad', kind: 'tcp', target: 'x;rm -rf /', port: 22, timeoutMs: 1000, intervalMs: 5000, enabled: true })).toThrow('health_check_invalid_target')
    expect(() => normalizeHealthCheck({ id: 'bad', hostId: host.id, name: 'bad', kind: 'tcp', target: 'x/var', port: 22, timeoutMs: 1000, intervalMs: 5000, enabled: true })).toThrow('health_check_invalid_target')
    expect(() => normalizeHealthCheck({ id: 'bad', hostId: host.id, name: 'bad', kind: 'http', target: 'https://user:pass@example.com', timeoutMs: 1000, intervalMs: 5000, enabled: true })).toThrow('health_check_invalid_target')
    expect(() => normalizeHealthCheck({ id: 'bad', hostId: host.id, name: 'bad', kind: 'http', target: 'https://example.com/health?token=secret', timeoutMs: 1000, intervalMs: 5000, enabled: true })).toThrow('health_check_invalid_target')
  })

  it('builds remote commands and reports ProxyJump transport and HTTP status', async () => {
    expect(buildHealthCheckCommand(defaultHealthCheck(host))).toContain('nc -z')
    const result = await runHealthCheck({
      host,
      check: { id: 'web', hostId: host.id, name: 'web', kind: 'http', target: 'https://example.com/health', expectedStatus: 204, timeoutMs: 1000, intervalMs: 5000, enabled: true },
      resolveAuthSecret: vi.fn().mockResolvedValue('private-key'),
      now: 100,
      runCommand: vi.fn().mockResolvedValue({ stdout: '__SB_CHECK_HTTP=204|0.012\n', stderr: '', exitCode: 0, durationMs: 17 }),
    })
    expect(result).toMatchObject({ status: 'passing', statusCode: 204, latencyMs: 12, transport: 'proxy-jump', provider: 'ssh-agentless', nextCheckAt: 5100 })
  })

  it('classifies timeout as unknown and limits concurrent refreshes while honoring TTL', async () => {
    const check = defaultHealthCheck(host)
    const run = vi.fn().mockRejectedValue(new Error('ProxyJump timeout'))
    const first = await runHealthCheck({ host, check, resolveAuthSecret: vi.fn(), now: 200, runCommand: run })
    expect(first).toMatchObject({ status: 'unknown', errorCode: 'jump-unavailable', errorSummary: 'Error: ProxyJump timeout' })
    let active = 0
    let peak = 0
    const checks = Array.from({ length: 5 }, (_, index) => ({ ...check, id: `check-${index}` }))
    const batch = await runHealthCheckBatch(checks, {
      maxConcurrency: 2,
      now: 100,
      run: async (item) => {
        active += 1; peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return { ...(await runHealthCheck({ host, check: item, resolveAuthSecret: vi.fn(), now: 100, runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }) })) }
      },
    })
    expect(batch.results).toHaveLength(5)
    expect(peak).toBeLessThanOrEqual(2)
    const skipped = await runHealthCheckBatch(checks, { now: 101, previous: Object.fromEntries(batch.results.map((item) => [item.checkId, item])), run: vi.fn() })
    expect(skipped.results).toHaveLength(0)
  })

  it('persists only normalized local definitions', () => {
    const saved = saveHealthChecks('vault-1', host.id, [defaultHealthCheck(host)])
    expect(loadHealthChecks('vault-1', host)).toEqual(saved)
    expect(localStorage.getItem('shellbeam.healthChecks.v1:vault-1:host-1')).not.toContain('private-key')
  })
})
