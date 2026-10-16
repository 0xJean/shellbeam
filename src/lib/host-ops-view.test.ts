import { describe, expect, it } from 'vitest'
import type { HostProfile } from './hosts'
import { buildHostOpsViews } from './host-ops-view'
import type { ServerMonitorLatest } from './server-monitor'
import type { OperationAuditEntry } from './operation-job'
import type { WorkspaceInventoryCache } from './workspace-inventory'
import { createProbeObservation } from './probe-provider'
import type { ProbeSnapshot } from './probe-provider'
import type { ShellbeamAgentRecord } from './shellbeam-agent'

const host: HostProfile = {
  id: 'host-1',
  name: 'app-1',
  address: '10.0.0.5',
  port: 22,
  username: 'ops',
  group: 'Production',
  authType: 'privateKey',
  tags: ['web'],
  jumpHost: 'bastion.internal',
  jumpPort: 2200,
  jumpUser: 'jump',
  createdAt: 1,
  updatedAt: 1,
}

const monitor: ServerMonitorLatest = {
  hostKey: 'host-1',
  hostId: 'host-1',
  hostName: 'app-1',
  hostAddress: host.address,
  username: host.username,
  port: host.port,
  status: 'online',
  snapshot: {
    hostname: 'app-1',
    os: 'Linux',
    kernel: '6.1',
    uptimeSeconds: 100,
    cpuPercent: 10,
    load1: 0.1,
    load5: 0.1,
    load15: 0.1,
    memoryUsedBytes: 10,
    memoryTotalBytes: 100,
    memoryPercent: 10,
    diskUsedBytes: 10,
    diskTotalBytes: 100,
    diskPercent: 10,
    networkRxBytesPerSec: 1,
    networkTxBytesPerSec: 2,
    latencyMs: 20,
    sampledAt: 1000,
  },
  lastAttemptAt: 1000,
  lastSuccessAt: 1000,
  updatedAt: 1000,
}

const inventoryCache: WorkspaceInventoryCache = {
  'host-1': {
    updatedAt: 1000,
    inventory: {
      resource: {
        hostname: 'app-1', os: 'Linux', kernel: '6.1', uptime: '1m', cpuPercent: 10,
        memoryPercent: 10, memoryText: '10M/100M', diskPercent: 20, diskText: '20M/100M', network: '1 KB/s',
      },
      tools: [],
      services: [
        { name: 'nginx.service', active: 'active', enabled: 'enabled' },
        { name: 'broken.service', active: 'failed', enabled: 'disabled' },
        { name: 'old.service', active: 'inactive', enabled: 'static' },
      ],
      containers: [],
      pm2: [{ raw: 'api' }, { raw: 'worker' }],
      projects: [],
      scannedAt: 1000,
    },
  },
}

const audit: OperationAuditEntry = {
  auditId: 'audit-1',
  jobId: 'job-1',
  hostId: 'host-1',
  hostName: 'app-1',
  hostAddress: host.address,
  source: 'workspace',
  actor: 'local-user',
  action: 'service.restart',
  target: 'nginx.service',
  risk: 'high',
  provider: 'ssh-agentless',
  transport: 'proxy-jump',
  event: 'updated',
  status: 'completed',
  confirmationStatus: 'confirmed',
  createdAt: 1001,
}

describe('buildHostOpsViews', () => {
  it('combines health, inventory summaries, ProxyJump route and audits', () => {
    const views = buildHostOpsViews({
      hosts: [host],
      monitorLatest: [monitor],
      inventoryCache,
      audits: [audit],
      now: 1100,
    })
    const view = views['host-1']

    expect(view.route).toEqual({ transport: 'proxy-jump', jumpHost: 'bastion.internal', jumpPort: 2200, jumpUser: 'jump' })
    expect(view.health.state).toBe('online')
    expect(view.health.provider).toBe('ssh-agentless')
    expect(view.health.freshness.ageMs).toBe(100)
    expect(view.serviceSummary).toMatchObject({ available: true, total: 3, active: 1, failed: 1, inactive: 1, enabled: 2 })
    expect(view.processSummary).toMatchObject({ available: true, total: 2, pm2: 2 })
    expect(view.latestAudit?.auditId).toBe('audit-1')
    expect(view.operationSummary).toMatchObject({ total: 1, active: 0, failed: 0, unknown: 0, latestStatus: 'completed' })
  })

  it('keeps missing probe values unknown instead of reporting zero or online', () => {
    const views = buildHostOpsViews({ hosts: [host], now: 1000 })
    const view = views['host-1']

    expect(view.health.state).toBe('unknown')
    expect(view.health.provider).toBe('unknown')
    expect(view.resource).toBeNull()
    expect(view.serviceSummary).toMatchObject({ available: false, total: null, active: null })
    expect(view.processSummary).toMatchObject({ available: false, total: null })
    expect(view.audits).toHaveLength(0)
  })

  it('marks successful but old monitor data as stale', () => {
    const views = buildHostOpsViews({ hosts: [host], monitorLatest: [monitor], now: 10_000, staleAfterMs: 5_000 })
    expect(views['host-1'].health.state).toBe('stale')
    expect(views['host-1'].health.freshness.stale).toBe(true)
  })

  it('distinguishes a ProxyJump failure from a target host outage', () => {
    const views = buildHostOpsViews({
      hosts: [host],
      monitorLatest: [{ ...monitor, status: 'offline', error: 'SSH ProxyJump connection failed' }],
      now: 1100,
    })
    expect(views['host-1'].health.state).toBe('jump-unavailable')
  })

  it('surfaces persisted ShellBeam Probe lifecycle without claiming SSH health', () => {
    const agent: ShellbeamAgentRecord = {
      vaultId: 'vault-1', hostId: host.id, agentId: 'node-1', providerKind: 'shellbeam-agent', source: 'shellbeam-agent',
      status: 'installed', health: 'online', version: '0.1.0', capabilities: ['heartbeat'], heartbeatTtlMs: 300_000,
      lastHeartbeatAt: 1_050, lastCheckedAt: 1_100, updatedAt: 1_100, transport: 'proxy-jump',
    }
    const view = buildHostOpsViews({ hosts: [host], shellbeamAgents: [agent], now: 1_100 })['host-1']

    expect(view.health.provider).toBe('shellbeam-agent')
    expect(view.health.state).toBe('unknown')
    expect(view.health.agent).toMatchObject({ status: 'installed', version: '0.1.0', lastHeartbeatAt: 1_050 })
  })

  it('prefers fresh Komari metrics and exposes SSH as the fallback source', () => {
    const komariSnapshot: ProbeSnapshot = {
      schemaVersion: 1,
      host: { hostId: host.id, address: host.address, port: host.port, username: host.username, jump: { address: 'bastion.internal', port: 2200, username: 'jump' } },
      provider: { kind: 'komari', id: 'komari-prod', nodeId: 'node-1', endpoint: 'https://komari.example', capabilities: ['metrics'] },
      transport: 'proxy-jump',
      health: 'online',
      receivedAt: 1100,
      metrics: createProbeObservation({
        data: { ...monitor.snapshot!, cpuPercent: 77, sampledAt: 1050 },
        source: { kind: 'komari', id: 'komari-prod', nodeId: 'node-1', endpoint: 'https://komari.example', capabilities: ['metrics'] },
        sampledAt: 1050,
        receivedAt: 1100,
        ttlMs: 5000,
      }),
      inventory: null,
      errors: [],
      alerts: { load: 2, offline: 1, total: 3, active: 1, updatedAt: 1100 },
    }
    const view = buildHostOpsViews({ hosts: [host], monitorLatest: [monitor], komariSnapshots: [komariSnapshot], now: 1100 })['host-1']
    expect(view.metrics?.cpuPercent).toBe(77)
    expect(view.health.provider).toBe('komari')
    expect(view.health.fallbackProvider).toBe('ssh-agentless')
    expect(view.health.alertSummary).toMatchObject({ total: 3, active: 1 })
  })
})
