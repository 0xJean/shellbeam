import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { collectNetworkOps, NETWORK_OPS_COMMAND, NETWORK_ROW_LIMIT, networkPortCommand, networkProcessCommand, parseNetworkOps, safeNetworkPort, type NetworkSection } from './network-ops'
const { runWorkspaceRemoteCommand } = vi.hoisted(() => ({ runWorkspaceRemoteCommand: vi.fn() }))
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand }))
const host = { id: 'host-1', name: 'Production', address: '10.0.0.1', port: 22, username: 'ops', group: 'Default', tags: [], authType: 'password' as const, createdAt: 0, updatedAt: 0, jumpHost: 'bastion.test' }
export function networkFixture(sections: Partial<Record<NetworkSection, string>> = {}, status = 0) {
  return '__SB_NET_SCHEMA=1\n' + (['LISTEN', 'CONNECTIONS', 'INTERFACES', 'ROUTES', 'SUMMARY'] as NetworkSection[]).map((name) => `__SB_NET_${name}_BEGIN\n${sections[name] ?? ''}\n__SB_NET_${name}_STATUS=${status}\n__SB_NET_${name}_END\n`).join('')
}
describe('read-only network diagnostics', () => {
  it('parses numeric IPv4/IPv6 listeners, PID linkage and interface/route records', () => {
    const snapshot = parseNetworkOps(networkFixture({ LISTEN: 'tcp LISTEN 0 128 [::]:443 [::]:* users:(("nginx",pid=120,fd=5))\nudp UNCONN 0 0 127.0.0.53:53 0.0.0.0:*', INTERFACES: '2: eth0 inet 10.0.0.1/24 brd 10.0.0.255 scope global eth0', ROUTES: 'default via 10.0.0.254 dev eth0' }), { now: 42, transport: 'proxy-jump' })
    expect(snapshot).toMatchObject({ status: 'ready', sampledAt: 42, transport: 'proxy-jump', listeners: [{ port: 443, pid: '120', process: 'nginx' }, { port: 53, pid: null }], interfaces: [{ name: 'eth0', family: 'inet', address: '10.0.0.1/24' }] })
  })
  it('distinguishes verified empty, unsupported tools and missing/invalid observations', () => {
    expect(parseNetworkOps(networkFixture()).status).toBe('ready')
    expect(parseNetworkOps(networkFixture({}, 127)).status).toBe('unsupported')
    expect(parseNetworkOps('permission denied').status).toBe('unknown')
    expect(parseNetworkOps(networkFixture({ LISTEN: 'unexpected output' })).sections.LISTEN).toBe('unknown')
    expect(parseNetworkOps(networkFixture().replace('__SB_NET_ROUTES_STATUS=0', '__SB_NET_ROUTES_STATUS=2')).status).toBe('partial')
  })
  it('bounds rows and rejects unsafe handoff port or PID input', () => {
    const sockets = Array.from({ length: NETWORK_ROW_LIMIT + 10 }, (_, index) => `tcp LISTEN 0 128 0.0.0.0:${index + 1} 0.0.0.0:*`).join('\n')
    const snapshot = parseNetworkOps(networkFixture({ LISTEN: sockets }))
    expect(snapshot.listeners).toHaveLength(NETWORK_ROW_LIMIT)
    expect(snapshot.truncated).toContain('LISTEN')
    for (const port of ['80; id', 0, 65536, -1, 80.5]) expect(safeNetworkPort(port)).toBeNull()
    expect(networkPortCommand(443)).toBe("ss -lntup '( sport = :443 )'")
    expect(() => networkProcessCommand('1; id')).toThrow()
  })
  it('executes the actual shell collector with bounded output and preserves section exit status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellbeam-net-test-'))
    try {
      writeFileSync(join(dir, 'ss'), '#!/bin/sh\nif [ "$1" = "-s" ]; then printf "TCP: 10\\n"; else i=0; while [ "$i" -lt 220 ]; do printf "tcp LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\\n"; i=$((i+1)); done; fi\n', { mode: 0o700 })
      writeFileSync(join(dir, 'ip'), '#!/bin/sh\ncase "$2" in address) printf "2: eth0 inet 10.0.0.1/24 scope global eth0\\n";; *) exit 2;; esac\n', { mode: 0o700 })
      const output = execFileSync('/bin/sh', ['-c', NETWORK_OPS_COMMAND], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 5000 })
      const snapshot = parseNetworkOps(output)
      expect(snapshot.listeners).toHaveLength(200)
      expect(snapshot.sections.ROUTES).toBe('unknown')
      expect(snapshot.sections.INTERFACES).toBe('ready')
      expect(snapshot.status).toBe('partial')
      expect(output.length).toBeLessThan(30_000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('uses the common audited transport and preserves unknown rather than rendering empty on timeout', async () => {
    runWorkspaceRemoteCommand.mockResolvedValueOnce({ stdout: networkFixture(), stderr: '', exitCode: 0, durationMs: 1 })
    const resolveAuthSecret = vi.fn(async () => 'secret')
    expect(await collectNetworkOps({ host, vaultId: 'team', resolveAuthSecret })).toMatchObject({ status: 'ready', transport: 'proxy-jump' })
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledWith(expect.objectContaining({ host, vaultId: 'team', audit: { action: 'network.read', target: 'bounded host network snapshot' } }))
    runWorkspaceRemoteCommand.mockResolvedValueOnce({ stdout: networkFixture(), exitCode: 124, errorCode: 'target_timeout' })
    expect(await collectNetworkOps({ host, vaultId: 'team', resolveAuthSecret })).toMatchObject({ status: 'unknown', listeners: [], errorCode: 'target_timeout' })
  })
})
