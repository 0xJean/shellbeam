import { describe, expect, it } from 'vitest'
import type { HostProfile } from './hosts'
import { buildHostOpsViews } from './host-ops-view'
import type { ServerMonitorLatest } from './server-monitor'
import type { OperationAuditEntry } from './operation-job'
import type { WorkspaceInventoryCache } from './workspace-inventory'
import { createProbeObservation } from './probe-provider'
import type { ProbeSnapshot } from './probe-provider'
import type { ShellbeamAgentRecord } from './shellbeam-agent'
import type { KomariAlertState } from './komari-alerts'

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

  it('summarizes current jobs once and prefers terminal events at the same millisecond', () => {
    const audits: OperationAuditEntry[] = [
      { ...audit, auditId: 'queued', status: 'queued', createdAt: 1001 },
      { ...audit, auditId: 'running', status: 'running', createdAt: 1001 },
      { ...audit, auditId: 'done', status: 'completed', createdAt: 1001 },
      { ...audit, auditId: 'failed', jobId: 'job-2', status: 'failed', createdAt: 1000 },
    ]
    const view = buildHostOpsViews({ hosts: [host], audits, now: 1100 })[host.id]
    expect(view.operationSummary).toMatchObject({ total: 2, active: 0, failed: 1, latestStatus: 'completed' })
    expect(view.latestAudit?.auditId).toBe('done')
    expect(view.audits).toHaveLength(4)
  })

  it('shows the actual edited jump route and keeps unresolved referenced metadata partial', () => {
    const target = { ...host, jumpHostId: 'jump-profile' }
    const jump = { ...host, id: 'jump-profile', name: 'Current jump', address: 'new-bastion', port: 2200, username: 'new-user', jumpHost: undefined }
    expect(buildHostOpsViews({ hosts: [target, jump] })[host.id].route).toEqual({ transport: 'proxy-jump', jumpHost: 'new-bastion', jumpHostName: 'Current jump', jumpPort: 2200, jumpUser: 'new-user' })
    expect(buildHostOpsViews({ hosts: [target] })[host.id].route).toEqual({ transport: 'proxy-jump' })
  })

  it('keeps unsupported Linux collection distinct from offline and stale previous metrics', () => {
    const probe: ProbeSnapshot = { schemaVersion: 1, host: { hostId: host.id, address: host.address, port: host.port, username: host.username }, provider: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics', 'inventory'] }, transport: 'proxy-jump', health: 'unsupported', receivedAt: 1100, metrics: null, inventory: null, errors: [{ section: 'provider', code: 'unsupported_os', message: 'Darwin' }] }
    const view = buildHostOpsViews({ hosts: [host], monitorLatest: [monitor], probeSnapshots: [probe], now: 1200 })[host.id]
    expect(view.health.state).toBe('unsupported')
    expect(view.capabilities).toEqual(['files'])
    const newer = buildHostOpsViews({ hosts: [host], monitorLatest: [{ ...monitor, updatedAt: 1300 }], probeSnapshots: [probe], now: 1350 })[host.id]
    expect(newer.health.state).toBe('online')
  })

  it.each(['shellbeam-agent', 'komari'] as const)('prefers current %s observations over unsupported SSH collection', (kind) => {
    const source = { kind, id: kind, capabilities: ['metrics'] as const }
    const probe: ProbeSnapshot = { schemaVersion: 1, host: { hostId: host.id, address: host.address, port: host.port, username: host.username }, provider: { ...source, capabilities: ['metrics'] }, transport: 'proxy-jump', health: 'online', receivedAt: 1100, metrics: createProbeObservation({ data: { ...monitor.snapshot!, sampledAt: 1100 }, source: { ...source, capabilities: ['metrics'] }, sampledAt: 1100, receivedAt: 1100, ttlMs: 5000 }), inventory: null, errors: [] }
    const view = buildHostOpsViews({ hosts: [host], monitorLatest: [{ ...monitor, status: 'unsupported', snapshot: null, updatedAt: 1200 }], probeSnapshots: [...(kind === 'komari' ? [] : [probe]), { ...probe, provider: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics'] }, health: 'unsupported', receivedAt: 1200, metrics: null }], komariSnapshots: kind === 'komari' ? [probe] : [], now: 1250 })[host.id]
    expect(view.health).toMatchObject({ state: 'online', provider: kind })
    expect(view.metrics?.sampledAt).toBe(1100)
    expect(view.capabilities).toContain('metrics')
    expect(view.capabilities).not.toContain('services')
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

  it('does not wash old selected metrics fresh with a new inventory or inventory attempt', () => {
    const now = 3_601_000
    const currentInventory = { ...inventoryCache['host-1'].inventory, scannedAt: now }
    const view = buildHostOpsViews({
      hosts: [host], monitorLatest: [monitor],
      inventoryCache: { 'host-1': { inventory: currentInventory, updatedAt: now } },
      now,
    })[host.id]
    expect(view.metrics?.sampledAt).toBe(1_000)
    expect(view.health).toMatchObject({ state: 'stale', provider: 'ssh-agentless', lastSuccessAt: 1_000 })
    expect(view.health.freshness).toMatchObject({ sampledAt: 1_000, updatedAt: 1_000, ageMs: 3_600_000, stale: true })
    expect(view.inventory?.scannedAt).toBe(now)
  })

  it('retains the selected metric Provider TTL independently of inventory freshness', () => {
    const source = { kind: 'ssh-agentless' as const, id: 'ssh-agentless', capabilities: ['metrics' as const] }
    const probe: ProbeSnapshot = { schemaVersion: 1, host: { hostId: host.id, address: host.address, port: host.port, username: host.username }, provider: source, transport: 'proxy-jump', health: 'online', receivedAt: 1_000, metrics: createProbeObservation({ data: monitor.snapshot!, source, sampledAt: 1_000, receivedAt: 1_000, ttlMs: 200 }), inventory: null, errors: [] }
    const view = buildHostOpsViews({ hosts: [host], monitorLatest: [monitor], probeSnapshots: [probe], inventoryCache: { 'host-1': { ...inventoryCache['host-1'], updatedAt: 1_300, inventory: { ...inventoryCache['host-1'].inventory, scannedAt: 1_300 } } }, now: 1_300, staleAfterMs: 5_000 })[host.id]
    expect(view.health.state).toBe('stale')
    expect(view.health.freshness).toMatchObject({ sampledAt: 1_000, ageMs: 300, ttlMs: 200, expiresAt: 1_200, stale: true })
  })

  it.each([0, Number.NaN, 20_000])('keeps invalid metric sample time %s unknown instead of borrowing inventory time', (sampledAt) => {
    const now = 10_000
    const view = buildHostOpsViews({ hosts: [host], monitorLatest: [{ ...monitor, snapshot: { ...monitor.snapshot!, sampledAt } }], inventoryCache: { 'host-1': { ...inventoryCache['host-1'], updatedAt: now, inventory: { ...inventoryCache['host-1'].inventory, scannedAt: now } } }, now })[host.id]
    expect(view.health.state).toBe('unknown')
    expect(view.health.freshness).toMatchObject({ sampledAt: null, ageMs: null, ttlMs: null, expiresAt: null })
    expect(view.metrics?.memoryPercent).toBe(10)
  })

  it('keeps in-memory ProbeProvider telemetry visible before snapshot persistence completes', () => {
    const view = buildHostOpsViews({
      hosts: [host],
      monitorLatest: [{
        ...monitor,
        status: 'stale',
        probeTelemetry: {
          status: 'recovered',
          startedAt: 900,
          completedAt: 1_000,
          durationMs: 100,
          attempts: 2,
          maxRetries: 2,
          retryDelayMs: 150,
          recovered: true,
          exhausted: true,
          sections: ['metrics'],
          lastErrorCode: 'ssh_timeout',
        },
      }],
      now: 1_100,
    })['host-1']

    expect(view.health.probe).toMatchObject({
      state: 'recovered',
      providerKind: 'ssh-agentless',
      providerId: 'ssh-agentless',
      persisted: false,
      telemetry: expect.objectContaining({ status: 'recovered', attempts: 2, lastErrorCode: 'ssh_timeout' }),
    })
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

  it('joins persisted Komari lifecycle and MCP operation links into the host view', () => {
    const alertState: KomariAlertState = {
      schemaVersion: 1,
      alerts: [
        {
          schemaVersion: 1,
          source: 'komari',
          alertId: 'alert-1',
          fingerprint: 'komari-prod|node-1|host-1|load',
          integrationId: 'komari-prod',
          nodeId: 'node-1',
          hostId: host.id,
          kind: 'load',
          title: 'Load',
          severity: 'warning',
          count: 1,
          status: 'acknowledged',
          firstSeenAt: 1_000,
          lastSeenAt: 1_100,
          acknowledgedAt: 1_101,
          acknowledgedBy: 'mcp-client:test',
          resolvedAt: null,
          closedAt: null,
          relatedOperationJobId: 'job-alert-1',
          deduplicatedCount: 0,
        },
        {
          schemaVersion: 1,
          source: 'komari',
          alertId: 'alert-2',
          fingerprint: 'komari-prod|node-1|host-1|offline',
          integrationId: 'komari-prod',
          nodeId: 'node-1',
          hostId: host.id,
          kind: 'offline',
          title: 'Offline',
          severity: 'critical',
          count: 1,
          status: 'closed',
          firstSeenAt: 900,
          lastSeenAt: 1_050,
          acknowledgedAt: null,
          acknowledgedBy: null,
          resolvedAt: null,
          closedAt: 1_060,
          relatedOperationJobId: 'job-alert-2',
          deduplicatedCount: 0,
        },
      ],
      audit: [
        { auditId: 'audit-1', alertId: 'alert-1', fingerprint: 'f1', event: 'acknowledged', status: 'acknowledged', actor: 'mcp-client:test', operationJobId: 'job-alert-1', at: 1_101 },
        { auditId: 'audit-2', alertId: 'alert-2', fingerprint: 'f2', event: 'closed', status: 'closed', actor: 'mcp-client:test', operationJobId: 'job-alert-2', at: 1_060 },
      ],
      summary: { load: 1, offline: 1, total: 2, active: 2, updatedAt: 1_100, open: 1, acknowledged: 1, resolved: 0, closed: 1, deduplicated: 0, localUpdatedAt: 1_101 },
    }
    const view = buildHostOpsViews({
      hosts: [host],
      komariSnapshots: [{
        schemaVersion: 1,
        host: { hostId: host.id, address: host.address, port: host.port, username: host.username },
        provider: { kind: 'komari', id: 'komari-prod', nodeId: 'node-1', endpoint: 'https://komari.example', capabilities: ['metrics'] },
        transport: 'proxy-jump', health: 'online', receivedAt: 1_100, metrics: null, inventory: null, errors: [], alerts: null,
      }],
      komariAlertStates: [alertState],
      now: 1_100,
    })['host-1']

    expect(view.health.alertLifecycle).toEqual({
      total: 2, open: 1, active: 0, acknowledged: 1, resolved: 0, closed: 1, latestOperationJobId: 'job-alert-1',
    })
    expect(view.komariAlerts.map((alert) => [alert.alertId, alert.status, alert.relatedOperationJobId])).toEqual([
      ['alert-1', 'acknowledged', 'job-alert-1'],
      ['alert-2', 'closed', 'job-alert-2'],
    ])
    expect(view.komariAlertAudits.map((entry) => [entry.alertId, entry.event, entry.operationJobId])).toEqual([
      ['alert-1', 'acknowledged', 'job-alert-1'],
      ['alert-2', 'closed', 'job-alert-2'],
    ])
  })

  it('surfaces a persisted Probe recovery marker across sessions', () => {
    const recovered: ProbeSnapshot = {
      schemaVersion: 1,
      host: { hostId: host.id, address: host.address, port: host.port, username: host.username },
      provider: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics'] },
      transport: 'proxy-jump',
      health: 'stale',
      receivedAt: 1_500,
      metrics: createProbeObservation({
        data: monitor.snapshot!,
        source: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics'] },
        sampledAt: 1_000,
        receivedAt: 1_500,
        ttlMs: 100,
      }),
      inventory: null,
      errors: [{ section: 'provider', code: 'stale-cache-fallback', message: 'fresh probe unavailable' }],
      telemetry: {
        status: 'recovered',
        startedAt: 1_400,
        completedAt: 1_500,
        durationMs: 100,
        attempts: 2,
        maxRetries: 2,
        retryDelayMs: 150,
        recovered: true,
        exhausted: true,
        sections: ['metrics'],
        lastError: 'fresh probe unavailable',
      },
      alerts: null,
    }
    const view = buildHostOpsViews({ hosts: [host], probeSnapshots: [recovered], now: 2_000 })['host-1']
    expect(view.health.probe).toMatchObject({
      state: 'recovered',
      providerKind: 'ssh-agentless',
      persisted: true,
      sampledAt: 1_000,
      receivedAt: 1_500,
      telemetry: expect.objectContaining({ status: 'recovered', attempts: 2, exhausted: true }),
    })
    expect(view.health.state).toBe('stale')
  })

  it('recomputes persisted probe expiry when a host view is rebuilt after restart', () => {
    const persisted: ProbeSnapshot = {
      schemaVersion: 1,
      host: { hostId: host.id, address: host.address, port: host.port, username: host.username },
      provider: { kind: 'komari', id: 'komari-prod', nodeId: 'node-1', capabilities: ['metrics'] },
      transport: 'proxy-jump',
      health: 'online',
      receivedAt: 1_100,
      metrics: createProbeObservation({
        data: monitor.snapshot!,
        source: { kind: 'komari', id: 'komari-prod', nodeId: 'node-1', capabilities: ['metrics'] },
        sampledAt: 1_000,
        receivedAt: 1_100,
        ttlMs: 500,
      }),
      inventory: null,
      errors: [],
      alerts: null,
    }
    const view = buildHostOpsViews({ hosts: [host], komariSnapshots: [persisted], now: 2_000 })['host-1']

    expect(view.health.probe).toMatchObject({ state: 'stale', persisted: false })
    expect(view.health.state).toBe('stale')
  })
})

it('shows canonical TTL, capability evidence and highest open severity across local and Komari alerts', () => {
  const snapshot: ProbeSnapshot = { schemaVersion: 1, host: { hostId: host.id, address: host.address, port: 22, username: 'ops' }, provider: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics', 'inventory'] }, transport: 'proxy-jump', health: 'online', receivedAt: 1_000, metrics: createProbeObservation({ data: monitor.snapshot!, source: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics'] }, sampledAt: 1_000, receivedAt: 1_000, ttlMs: 2_000 }), inventory: null, errors: [] }
  const view = buildHostOpsViews({ hosts: [host], monitorLatest: [monitor], inventoryCache, probeSnapshots: [snapshot], now: 4_000, localAlertStates: { [host.id]: { version: 1, evaluations: [], audit: [], alerts: [{ ruleId: 'cpu', hostId: host.id, name: 'CPU', metric: 'cpu', status: 'acknowledged', severity: 'critical', openedAt: 1_000, updatedAt: 1_000, resolvedAt: null, value: 99, source: 'ssh-agentless', transport: 'proxy-jump' }] } } })[host.id]
  expect(view.health.freshness).toMatchObject({ ttlMs: 2_000, expiresAt: 3_000, stale: true })
  expect(view.health.state).toBe('stale')
  expect(view.capabilities).toEqual(expect.arrayContaining(['files', 'services', 'processes', 'logs', 'port-checks', 'metrics']))
  expect(view.highestAlertSeverity).toBe('critical')
  expect(view.localAlertOpen).toBe(1)
})

it('keeps native structured jump and target failures distinct, including host key errors', () => {
  for (const error of [JSON.stringify({ code: 'jump_auth_failed', source: 'jump', message: 'SSH jump auth_failed' }), JSON.stringify({ code: 'host_key_mismatch', routeStage: 'jump' })]) {
    expect(buildHostOpsViews({ hosts: [host], monitorLatest: [{ ...monitor, status: 'offline', error }], now: 1_100 })[host.id].health.state).toBe('jump-unavailable')
  }
  for (const error of [JSON.stringify({ code: 'target_auth_failed', source: 'target' }), JSON.stringify({ code: 'host_key_mismatch', routeStage: 'target', message: 'via bastion' })]) {
    expect(buildHostOpsViews({ hosts: [host], monitorLatest: [{ ...monitor, status: 'offline', error }], now: 1_100 })[host.id].health.state).toBe('offline')
  }
})

it('shows a referenced jump profile name only when that profile exists in the active host scope', () => {
  const target = { ...host, jumpHost: undefined, jumpHostId: 'jump-profile' }
  const jump = { ...host, id: 'jump-profile', name: 'Production bastion', address: '203.0.113.10', jumpHost: undefined, jumpHostId: undefined }
  expect(buildHostOpsViews({ hosts: [target, jump] })[target.id].route).toMatchObject({ transport: 'proxy-jump', jumpHostName: 'Production bastion', jumpHost: '203.0.113.10' })
  expect(buildHostOpsViews({ hosts: [target] })[target.id].route.jumpHostName).toBeUndefined()
})
