import { describe, expect, it, vi } from 'vitest'
import { buildLocalServiceCheckCommand, collectLocalAlertObservations } from './local-alert-collector'
import { normalizeLocalAlertRule } from './local-alert-rules'
import type { HostProfile } from './hosts'
import type { ProbeSnapshot } from './probe-provider'
const host = { id: 'host', address: '10.0.0.1', jumpHost: 'bastion' } as HostProfile
const rule = normalizeLocalAlertRule({ id: 'service', hostId: 'host', name: 'nginx', metric: 'service', target: 'nginx.service' })
describe('local alert observations', () => {
  it('uses the shared ProxyJump transport with explicit vault scope for arbitrary service units', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '__SB_RULE_SERVICE_0=failed\n', stderr: '', exitCode: 0 })
    const observations = await collectLocalAlertObservations({ vaultId: 'vault', host, rules: [rule], resolveAuthSecret: vi.fn(), now: 1_000, runCommand })
    expect(runCommand.mock.calls[0][0]).toMatchObject({ vaultId: 'vault', host })
    expect(runCommand.mock.calls[0][0].command).toContain('systemctl show')
    expect(observations[0]).toMatchObject({ value: 1, transport: 'proxy-jump', sampledAt: 1_000 })
    expect(() => buildLocalServiceCheckCommand(['x;rm -rf /'])).toThrow()
  })
  it('keeps absent, unsupported or failed service collection unknown', async () => {
    for (const stdout of ['', '__SB_RULE_SERVICE_0=activating\n', '__SB_RULE_SERVICE_0=unknown\n']) {
      const rows = await collectLocalAlertObservations({ host, rules: [rule], resolveAuthSecret: vi.fn(), runCommand: vi.fn().mockResolvedValue({ stdout, exitCode: 0 }) })
      expect(rows[0].value).toBeNull()
    }
  })
  it.each([
    { name: 'saved jump reference', route: { jumpHost: undefined, jumpHostId: 'jump-profile' }, transport: 'proxy-jump' },
    { name: 'direct host', route: { jumpHost: undefined, jumpHostId: undefined }, transport: 'direct' },
  ] as const)('retains the $name route in service alerts and unavailable observations', async ({ route, transport }) => {
    const profile = { ...host, ...route }
    const runCommand = vi.fn().mockResolvedValue({ stdout: '__SB_RULE_SERVICE_0=failed\n', exitCode: 0 })
    const failed = await collectLocalAlertObservations({ vaultId: 'vault', host: profile, rules: [rule], resolveAuthSecret: vi.fn(), now: 1_000, runCommand })
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: profile, vaultId: 'vault' }))
    expect(failed).toEqual([expect.objectContaining({ ruleId: rule.id, value: 1, source: 'ssh-agentless', transport })])
    const cpu = normalizeLocalAlertRule({ ...rule, id: 'cpu', metric: 'cpu' })
    const unknown = await collectLocalAlertObservations({ host: profile, rules: [rule, cpu], resolveAuthSecret: vi.fn(), now: 2_000,
      probe: vi.fn().mockRejectedValue(new Error('collection unavailable')),
      runCommand: vi.fn().mockRejectedValue(new Error('collection unavailable')) })
    expect(unknown).toHaveLength(2)
    expect(unknown).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: rule.id, value: null, transport }), expect.objectContaining({ ruleId: cpu.id, value: null, transport })]))
  })
  it('uses only fresh canonical Provider metrics and does not turn cached failure into recovery', async () => {
    const cpu = normalizeLocalAlertRule({ ...rule, id: 'cpu', metric: 'cpu' })
    const snapshot = { health: 'online', provider: { kind: 'ssh-agentless' }, transport: 'proxy-jump', metrics: { data: { cpuPercent: 95 }, freshness: { sampledAt: 100, expiresAt: 2_000 } } } as ProbeSnapshot
    expect((await collectLocalAlertObservations({ host, rules: [cpu], resolveAuthSecret: vi.fn(), now: 1_000, probe: async () => snapshot }))[0]).toMatchObject({ value: 95, sampledAt: 100 })
    expect((await collectLocalAlertObservations({ host, rules: [cpu], resolveAuthSecret: vi.fn(), now: 3_000, probe: async () => snapshot }))[0].value).toBeNull()
    expect((await collectLocalAlertObservations({ host, rules: [cpu], resolveAuthSecret: vi.fn(), now: 1_000, probe: async () => ({ ...snapshot, health: 'stale' }) }))[0].value).toBeNull()
  })
})
