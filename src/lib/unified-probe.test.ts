import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { buildUnifiedProbeCommand, parseUnifiedProbeOutput, fetchUnifiedProbe, UnsupportedProbeError } from './unified-probe'
import { createAgentlessSshProbeProvider } from './probe-provider'
import { parseServerMonitorOutput } from './server-monitor'
import { parseWorkspaceInventory } from './workspace-inventory'
import { runWorkspaceRemoteCommand } from './workspace-remote'
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
const fixture = readFileSync('shared/fixtures/linux-probe-v1.txt', 'utf8')
describe('One shared Linux collector wire contract', () => {
  it('retains rich inventory and missing-value semantics through both consumer adapters', () => {
    const parsed = parseUnifiedProbeOutput(fixture, 1792281600100)
    expect(parsed.metrics).toMatchObject({ hostname: 'prod-api', cpuPercent: 25.5, memoryTotalBytes: 8388608, memoryUsedBytes: 6291456, memoryPercent: 75, diskPercent: 20, load15: 0.3 })
    expect(parsed.inventory.tools[0]).toMatchObject({ id: 'node', category: 'runtime', version: 'v22.0.0' })
    expect(parsed.inventory.services[0]).toEqual({ name: 'nginx.service', active: 'active', enabled: 'enabled' })
    expect(parsed.inventory.containers[0]).toMatchObject({ name: 'web', image: 'nginx:stable' })
    expect(parsed.inventory.projects).toEqual([{ path: '/srv/api', kind: 'compose · node', name: 'api', modifiedAt: '2026-10-17 10:31' }])
    expect(parsed.inventory.listeningPorts).toHaveLength(1)
    expect(parseServerMonitorOutput(fixture, 1792281600100)).toEqual(parsed.metrics)
    expect(parseWorkspaceInventory(fixture)).toEqual(parsed.inventory)
    expect(() => parseUnifiedProbeOutput('__SB_PROBE_BEGIN\n__SB_PROBE_SCHEMA=1\n__SB_PROBE_END')).toThrow('INVALID_SAMPLE_TIME')
    expect(() => parseUnifiedProbeOutput('__SB_PROBE_BEGIN\n__SB_PROBE_SCHEMA=1\n__SB_PROBE_SAMPLED_AT=9999\n__SB_PROBE_END', 1000)).toThrow('INVALID_SAMPLE_TIME')
    expect(() => parseUnifiedProbeOutput(fixture.replace('__SB_PROBE_END', ''))).toThrow('INCOMPLETE')
  })
  it('collects both requested sections once while carrying vault scope and transport', async () => {
    const collect = vi.fn(async () => parseUnifiedProbeOutput(fixture, 1792281600100))
    const host = { id: 'edge', vaultId: 'vault-1', address: '10.0.0.1', port: 22, username: 'ops', name: 'edge', authType: 'password' as const, group: 'Production', tags: [], createdAt: 1, updatedAt: 1, jumpHost: 'bastion' }
    const snapshot = await createAgentlessSshProbeProvider({ dependencies: { collect } }).probe({ vaultId: 'vault-1', host, resolveAuthSecret: async () => '', sections: ['metrics', 'inventory'], now: 1792281600100 })
    expect(collect).toHaveBeenCalledTimes(1)
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'vault-1', section: 'all' }))
    expect(snapshot.metrics?.data.cpuPercent).toBe(25.5)
    expect(snapshot.inventory?.data.tools).toHaveLength(2)
    expect(snapshot.transport).toBe('proxy-jump')
  })
  it.skipIf(process.platform !== 'linux')('runs the actual shared script on Linux and skips inventory subprocesses for metrics-only probes', () => {
    const script = 'shared/probe-collector.sh'
    const result = spawnSync('sh', ['-x', script, 'metrics'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 262144 })
    expect(result.status, result.stderr).toBe(0)
    const sample = parseUnifiedProbeOutput(result.stdout)
    expect(sample.metrics.uptimeSeconds).not.toBeNull()
    expect(sample.metrics.memoryTotalBytes).toBeGreaterThan(0)
    expect(sample.metrics.diskTotalBytes).toBeGreaterThan(0)
    expect(sample.inventory.tools).toHaveLength(0)
    expect(result.stderr).not.toMatch(/\+ (?:sb_probe_tool|docker|find|systemctl) /)
  }, 20_000)
  it.skipIf(process.platform === 'win32')('the actual collector reports unsupported OS before producing any Linux sample', () => {
    const script = readFileSync('shared/probe-collector.sh', 'utf8')
    const result = spawnSync('/bin/sh', ['-c', `uname() { printf 'Darwin\\n'; }\n${script}`], { encoding: 'utf8', timeout: 5000 })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('__SB_PROBE_UNSUPPORTED_OS=Darwin\n')
    expect(result.stdout).not.toContain('__SB_PROBE_BEGIN')
    expect(result.stderr).toContain('PROBE_UNSUPPORTED_OS: Darwin')
  })
  it('turns only a definite collector rejection into a typed unsupported result carrying the verified identity', async () => {
    const host = { id: 'edge', address: 'target', port: 22, username: 'ops', name: 'edge', authType: 'password' as const, group: '', tags: [], createdAt: 1, updatedAt: 1 }
    const hostIdentity = { hostId: 'edge', address: 'target', port: 22, username: 'ops', jump: { hostId: 'jump', address: 'edited', port: 2200, username: 'current' } }
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: '__SB_PROBE_UNSUPPORTED_OS=Darwin\n', stderr: 'PROBE_UNSUPPORTED_OS: Darwin', exitCode: 2, durationMs: 4, hostIdentity })
    await expect(fetchUnifiedProbe({ host, resolveAuthSecret: async () => '' })).rejects.toMatchObject({ code: 'unsupported_os', hostIdentity })
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: '__SB_PROBE_UNSUPPORTED_OS=Darwin\n', stderr: '', exitCode: -1, durationMs: 4, errorType: 'unknown' })
    await expect(fetchUnifiedProbe({ host, resolveAuthSecret: async () => '' })).rejects.not.toBeInstanceOf(UnsupportedProbeError)
  })
  it('all wrappers carry the same versioned script and choose the requested sections', () => {
    expect(buildUnifiedProbeCommand('metrics')).toContain('__SB_PROBE_SCHEMA=1')
    expect(buildUnifiedProbeCommand('metrics')).toMatch(/shellbeam-probe metrics$/)
    expect(buildUnifiedProbeCommand('inventory')).toMatch(/shellbeam-probe inventory$/)
  })
})
