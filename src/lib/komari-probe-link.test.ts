import { describe, expect, it } from 'vitest'
import type { HostProfile } from './hosts'
import type { KomariAlertState } from './komari-alerts'
import type { ProbeSnapshot } from './probe-provider'
import type { ShellbeamAgentRecord } from './shellbeam-agent'
import {
  attachShellbeamProbeToKomariSnapshot,
  buildKomariProbeLinks,
  resolveKomariProbeTarget,
} from './komari-probe-link'

const host: HostProfile = {
  id: 'host-1', name: 'prod', address: '10.0.0.1', port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [],
  jumpHost: 'bastion', jumpPort: 2200, jumpUser: 'jump', createdAt: 0, updatedAt: 0,
}
const mapping = { integrationId: 'komari-prod', hostId: 'host-1', nodeId: 'node-1', source: 'manual' as const, confidence: 'explicit' as const, updatedAt: 100 }
const snapshot: ProbeSnapshot = {
  schemaVersion: 1,
  host: { hostId: host.id, address: host.address, port: 22, username: host.username, jump: { address: 'bastion', port: 2200, username: 'jump' } },
  provider: { kind: 'komari', id: 'komari-prod', nodeId: 'node-1', endpoint: 'https://komari.example', capabilities: ['metrics'] },
  transport: 'proxy-jump', health: 'online', receivedAt: 1_000,
  metrics: {
    data: { hostname: 'prod', os: 'Linux', kernel: '6.8', uptimeSeconds: 1, cpuPercent: 1, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 1, memoryTotalBytes: 2, memoryPercent: 50, diskUsedBytes: 1, diskTotalBytes: 2, diskPercent: 50, networkRxBytesPerSec: 1, networkTxBytesPerSec: 1, latencyMs: null, sampledAt: 1_000 },
    source: { kind: 'komari', id: 'komari-prod', nodeId: 'node-1', endpoint: 'https://komari.example', capabilities: ['metrics'] },
    freshness: { sampledAt: 1_000, receivedAt: 1_000, ttlMs: 5_000, expiresAt: 6_000, expired: false }, confidence: 'partial',
  },
  inventory: null, errors: [], alerts: { load: 1, offline: 0, total: 1, active: 1, updatedAt: 1_000 },
}
const agent: ShellbeamAgentRecord = {
  vaultId: 'vault-1', hostId: host.id, agentId: 'agent-1', providerKind: 'shellbeam-agent', source: 'shellbeam-agent', status: 'installed', health: 'online', version: '1.2.0', capabilities: ['heartbeat'], heartbeatTtlMs: 300_000, lastHeartbeatAt: 950, lastCheckedAt: 1_000, updatedAt: 1_000, transport: 'proxy-jump',
}

describe('Komari and ShellBeam Probe linkage', () => {
  it('resolves only an explicit durable mapping and preserves ProxyJump host data', () => {
    expect(resolveKomariProbeTarget({ integrationId: 'komari-prod', nodeId: 'node-1', mappings: [mapping], hosts: [host] })).toMatchObject({ host, mapping })
    expect(() => resolveKomariProbeTarget({ integrationId: 'komari-prod', nodeId: 'node-1', mappings: [], hosts: [host] })).toThrow('not mapped')
    expect(() => resolveKomariProbeTarget({ integrationId: 'komari-prod', nodeId: 'node-1', mappings: [mapping, { ...mapping, hostId: 'other' }], hosts: [host] })).toThrow('conflicting')
    expect(() => resolveKomariProbeTarget({ integrationId: 'komari-prod', nodeId: 'node-1', mappings: [mapping, { ...mapping, nodeId: 'node-2' }], hosts: [host] })).toThrow('conflicting')
  })

  it('joins Komari freshness, alert state and probe lifecycle without conflating health', () => {
    const links = buildKomariProbeLinks({ integrationId: 'komari-prod', hosts: [host], mappings: [mapping], snapshots: [snapshot], shellbeamAgents: [agent], now: 1_100 })
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ status: 'linked', hostId: 'host-1', komari: { state: 'online', alerts: { active: 1 } }, probe: { state: 'installed', health: 'online', version: '1.2.0' }, recommendedAction: 'none' })
  })

  it('carries persisted alert lifecycle context to the mapped Probe action', () => {
    const alertState = { schemaVersion: 1, alerts: [{ alertId: 'alert-1', integrationId: 'komari-prod', nodeId: 'node-1', hostId: host.id, status: 'active' }], audit: [], summary: {} } as unknown as KomariAlertState
    const links = buildKomariProbeLinks({ integrationId: 'komari-prod', hosts: [host], mappings: [mapping], snapshots: [snapshot], alertState })
    expect(links[0]?.alertState).toMatchObject({ alerts: [{ alertId: 'alert-1' }] })
  })

  it('does not hide an unmapped or stale Komari node behind a Probe action', () => {
    const links = buildKomariProbeLinks({ integrationId: 'komari-prod', hosts: [host], mappings: [], snapshots: [snapshot], now: 10_000 })
    expect(links[0]).toMatchObject({ status: 'unmapped', komari: { state: 'stale' }, recommendedAction: 'inspect-komari' })
  })

  it('attaches lifecycle metadata while retaining Komari as the metric source', () => {
    const enriched = attachShellbeamProbeToKomariSnapshot(snapshot, agent)
    expect(enriched.provider.kind).toBe('komari')
    expect(enriched.metrics?.source.kind).toBe('komari')
    expect(enriched.agent).toMatchObject({ status: 'installed', version: '1.2.0', lastHeartbeat: 950 })
  })
})
