import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostGridCard, HostListItem } from './host-card'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
import type { OperationAuditEntry } from '@/lib/operation-job'
import type { KomariAlertAuditEntry, KomariAlertRecord } from '@/lib/komari-alerts'

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '203.0.113.8',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'password' as const,
  tags: ['web', 'critical'],
  createdAt: 0,
  updatedAt: 0,
}

const sampledMetrics: ServerMonitorSnapshot = {
  hostname: 'api', os: 'Linux', kernel: '', uptimeSeconds: 90_061, cpuPercent: 15, load1: null, load5: null, load15: null,
  memoryUsedBytes: null, memoryTotalBytes: null, memoryPercent: null, diskUsedBytes: null, diskTotalBytes: null, diskPercent: null,
  networkRxBytesPerSec: 1024, networkTxBytesPerSec: 2048, latencyMs: null, sampledAt: 1000,
}
const oldResource = { hostname: 'api', os: 'Linux', kernel: '', uptime: 'old uptime', cpuPercent: 95, memoryPercent: 20, memoryText: '', diskPercent: 30, diskText: '', network: 'old throughput' }

describe('host list item', () => {
  it.each(['grid', 'list'] as const)('shows actual Komari sync metadata separately in the %s host card', (mode) => {
    const probe = { integrationId: 'komari', nodeId: 'node', hostId: host.id, mapping: { hostId: host.id, nodeId: 'node' }, status: 'linked', alertState: null, komari: { state: 'online', sampledAt: 1000, receivedAt: 1100, lastSyncedAt: 2000, alerts: null, snapshot: null }, probe: { state: 'not-recorded', health: null, version: null, lastHeartbeatAt: null, record: null }, recommendedAction: 'none' } as unknown as KomariProbeLink
    const operations = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct' as const, sampledAt: 1000, komariProbe: probe }
    const props = { host, isSelected: false, operations, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.getByTestId('komari-host-last-sync').querySelector('time')).toHaveAttribute('datetime', new Date(2000).toISOString())
  })
  it.each(['grid', 'list'] as const)('explains TTL expiry in the %s card and removes it for fresh data', (mode) => {
    const operations = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct' as const, ttlMs: 60_000, expiryReason: 'ttl-expired' as const }
    const props = { host, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const renderCard = (expiryReason: 'ttl-expired' | null) => mode === 'grid'
      ? <HostGridCard {...props} operations={{ ...operations, expiryReason }} />
      : <HostListItem {...props} index={1} operations={{ ...operations, expiryReason }} />
    const view = render(renderCard('ttl-expired'))
    expect(screen.getByTestId('host-ops-expiry-reason')).toHaveTextContent('Sample TTL expired')
    view.rerender(renderCard(null))
    expect(screen.queryByTestId('host-ops-expiry-reason')).not.toBeInTheDocument()
  })
  it.each(['grid', 'list'] as const)('routes %s shortcuts to the exact host and keeps keyboard navigation inside the control', (view) => {
    const onOpenWorkspace = vi.fn()
    const onRefresh = vi.fn()
    const onSelect = vi.fn()
    const onConnect = vi.fn()
    const props = { host, isSelected: false, onOpenWorkspace, onRefresh, onSelect, onConnect, onEdit: vi.fn(), onDelete: vi.fn() }
    render(view === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    const shortcuts = screen.getByRole('combobox', { name: 'Open operations for Production API' })
    for (const app of ['overview', 'fileSystem', 'services', 'logs', 'network']) {
      fireEvent.change(shortcuts, { target: { value: app } })
      expect(onOpenWorkspace).toHaveBeenLastCalledWith(host.id, app)
    }
    fireEvent.change(shortcuts, { target: { value: 'refresh' } })
    expect(onRefresh).toHaveBeenCalledWith(host.id)
    expect(onOpenWorkspace).toHaveBeenCalledTimes(5)
    fireEvent.click(shortcuts)
    fireEvent.doubleClick(shortcuts)
    fireEvent.keyDown(shortcuts, { key: ' ' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it.each(['grid', 'list'] as const)('shows unsupported distinctly in the %s operations card', (mode) => {
    const props = { host, isSelected: false, status: 'unsupported' as const, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.getByText('Unsupported monitoring')).toBeInTheDocument()
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it.each(['grid', 'list'] as const)('shows sampled network throughput and uptime explicitly in the %s view', (mode) => {
    const props = { host, isSelected: false, resource: oldResource, metrics: sampledMetrics, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.getByText('Network throughput')).toBeVisible()
    expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('↓ 1.0 KB/s · ↑ 2.0 KB/s')
    expect(screen.getByText('Uptime')).toBeVisible()
    expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('1d 1h')
    expect(screen.queryByText('old uptime')).not.toBeInTheDocument()
    expect(screen.queryByText('old throughput')).not.toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'CPU 15%' })).toBeInTheDocument()
  })

  it.each(['grid', 'list'] as const)('keeps missing %s observations unknown while preserving a genuinely observed zero', (mode) => {
    const props = { host, isSelected: false, resource: oldResource, metrics: { ...sampledMetrics, uptimeSeconds: null, networkRxBytesPerSec: 0, networkTxBytesPerSec: null }, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const view = render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('↓ 0 B/s · ↑ Unknown')
    expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('Unknown')
    const missing = { ...props, metrics: undefined, resource: undefined }
    view.rerender(mode === 'grid' ? <HostGridCard {...missing} /> : <HostListItem {...missing} index={1} />)
    expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('Unknown')
    expect(screen.getByTestId('host-resource-throughput')).not.toHaveTextContent('0 B/s')
    expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('Unknown')
    expect(screen.getByTestId('host-resource-uptime')).not.toHaveTextContent('0s')
  })

  it('retains available legacy inventory values when no metric observation exists', () => {
    render(<HostGridCard host={host} isSelected={false} resource={{ ...oldResource, uptime: '3 days', network: '12.5 KB/s' }} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('12.5 KB/s')
    expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('3 days')
  })

  it('localizes throughput, uptime and unknown values in Chinese', () => {
    const previousLocale = localStorage.getItem('shellbeam.locale')
    localStorage.setItem('shellbeam.locale', 'zh-CN')
    try {
      const props = { host, isSelected: false, metrics: { ...sampledMetrics, uptimeSeconds: 42, networkTxBytesPerSec: null }, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
      render(<HostGridCard {...props} />)
      expect(screen.getByText('网络吞吐')).toBeVisible()
      expect(screen.getByText('运行时间')).toBeVisible()
      expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('↑ 未知')
      expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('42 秒')
    } finally {
      if (previousLocale) localStorage.setItem('shellbeam.locale', previousLocale)
      else localStorage.removeItem('shellbeam.locale')
    }
  })

  it('renders cached region and system icons in list mode', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        resource={{
          hostname: 'api',
          os: 'Ubuntu 24.04 LTS',
          kernel: '',
          uptime: '',
          cpuPercent: null,
          memoryPercent: null,
          memoryText: '',
          diskPercent: null,
          diskText: '',
          network: '',
        }}
        network={{
          address: host.address,
          addressType: 'ipv4',
          scope: 'public',
          versionLabel: 'IPv4',
          scopeLabel: 'Public IP',
          locationLabel: 'Region pending',
          publicIp: host.address,
          canLookupLocation: true,
          resolvedLocationLabel: 'Hong Kong',
          locationStatus: 'ready',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByText('Hong Kong')).toBeInTheDocument()
    expect(screen.getByText('Ubuntu 24.04 LTS')).toBeInTheDocument()
    expect(document.querySelector('img[src="https://flagcdn.com/24x18/hk.png"]')).toBeTruthy()
    expect(document.querySelector('[data-os-icon="ubuntu"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="cpu"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="memory"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="disk"]')).toBeTruthy()
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('critical')).toBeInTheDocument()
  })

  it('keeps the host avatar OS-specific with a local icon asset', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        resource={{
          hostname: 'api',
          os: 'Ubuntu 24.04 LTS',
          kernel: '',
          uptime: '',
          cpuPercent: null,
          memoryPercent: null,
          memoryText: '',
          diskPercent: null,
          diskText: '',
          network: '',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(document.querySelector('[data-os-icon="ubuntu"]')).toBeTruthy()
    expect(screen.queryByText('Ub')).not.toBeInTheDocument()
  })

  it('shows the configured jump host in list metadata', () => {
    render(
      <HostListItem
        index={1}
        host={{ ...host, jumpHost: 'bastion.example.com', jumpPort: 2200, jumpUser: 'jump' }}
        isSelected={false}
        status="online"
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(document.querySelector('[data-host-jump-pill]')).toBeTruthy()
    expect(screen.getByText(/bastion\.example\.com:2200/)).toBeInTheDocument()
  })

  it('shows resolved reference metadata and never copies old jump endpoints', () => {
    render(<HostListItem index={1} host={{ ...host, jumpHostId: 'jump-1', jumpHost: 'old-bastion', jumpPort: 22, jumpUser: 'old-user' }} isSelected={false} operations={{ serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'proxy-jump', jumpHost: 'edited-bastion', jumpPort: 2200, jumpUser: 'current-user' }} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText(/current-user@edited-bastion:2200/)).toBeInTheDocument()
    expect(screen.queryByText(/old-bastion|old-user/)).not.toBeInTheDocument()
  })

  it('shows service, process and operation summaries for the ops view', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="stale"
        operations={{
          serviceTotal: 4,
          serviceActive: 3,
          serviceFailed: 1,
          processTotal: 2,
          processRunning: 2,
          auditCount: 3,
          auditActive: 1,
          auditUnknown: 2,
          latestAudit: {
            action: 'service.restart',
            target: 'nginx.service',
            status: 'completed',
            createdAt: 1000,
            transport: 'direct',
            provider: 'ssh-agentless',
            auditId: 'audit-1',
            source: 'mcp',
          },
          provider: 'ssh-agentless',
          sampledAt: 1000,
          probeState: 'recovered',
          probeProviderId: 'ssh-agentless',
          probeTelemetry: {
            status: 'recovered',
            startedAt: 900,
            completedAt: 1000,
            durationMs: 100,
            attempts: 2,
            maxRetries: 2,
            retryDelayMs: 150,
            recovered: true,
            exhausted: true,
            sections: ['metrics'],
          },
          transport: 'direct',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByTestId('host-ops-summary')).toBeInTheDocument()
    expect(screen.getByText('3/4')).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(screen.getByText(/service\.restart/)).toBeInTheDocument()
    expect(screen.getByText(/audit-1/)).toBeInTheDocument()
    expect(screen.getByText(/Unknown: 2/)).toBeInTheDocument()
    expect(screen.getByText(/2 retries/)).toBeInTheDocument()
  })

  it('surfaces MCP alert lifecycle and linked OperationJob outcome in the host ops row', () => {
    const link = {
      integrationId: 'komari-prod',
      nodeId: 'node-1',
      hostId: host.id,
      mapping: { integrationId: 'komari-prod', hostId: host.id, nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 },
      status: 'linked',
      alertState: {
        schemaVersion: 1,
        alerts: [
          { alertId: 'alert-active', nodeId: 'node-1', hostId: host.id, status: 'active', relatedOperationJobId: null },
          { alertId: 'alert-ack', nodeId: 'node-1', hostId: host.id, status: 'acknowledged', relatedOperationJobId: 'job-ack' },
          { alertId: 'alert-closed', nodeId: 'node-1', hostId: host.id, status: 'closed', relatedOperationJobId: null },
        ],
        audit: [{ alertId: 'alert-ack', operationJobId: 'job-ack', event: 'acknowledged', at: 2_000 }],
        summary: {},
      },
      komari: { state: 'online', sampledAt: 1_000, receivedAt: 1_000, alerts: { load: 0, offline: 0, total: 3, active: 1, updatedAt: 1_000 }, snapshot: null },
      probe: { state: 'installed', health: 'online', version: '1.0.0', lastHeartbeatAt: 1_000, record: { capabilities: [] } },
      recommendedAction: 'none',
    } as unknown as KomariProbeLink
    const audit: OperationAuditEntry = {
      auditId: 'audit-ack',
      jobId: 'job-ack',
      hostId: host.id,
      hostName: host.name,
      hostAddress: host.address,
      source: 'mcp',
      actor: 'mcp-client:test',
      action: 'mcp.acknowledge_server_alert',
      target: 'alert-ack',
      risk: 'low',
      provider: 'komari-alert',
      transport: 'local',
      event: 'updated',
      status: 'completed',
      confirmationStatus: 'not_required',
      createdAt: 2_000,
    }
    const alertAudit: KomariAlertAuditEntry = {
      auditId: 'alert-audit-ack',
      alertId: 'alert-ack',
      fingerprint: 'komari-prod|node-1|host-1|load',
      event: 'acknowledged',
      status: 'acknowledged',
      actor: 'mcp-client:test',
      operationJobId: 'job-ack',
      at: 2_000,
    }

    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        operations={{
          serviceTotal: null,
          serviceActive: null,
          serviceFailed: null,
          processTotal: null,
          processRunning: null,
          auditCount: 1,
          latestAudit: audit,
          audits: [audit],
          komariAlertAudits: [alertAudit],
          provider: 'komari',
          sampledAt: 1_000,
          transport: 'direct',
          komariProbe: link,
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByText('2 open alert(s)')).toBeInTheDocument()
    expect(screen.getByText('Acknowledged: 1')).toBeInTheDocument()
    expect(screen.getByText('Closed: 1')).toBeInTheDocument()
    expect(screen.getByText('job job-ack · completed')).toBeInTheDocument()
    expect(screen.getByTestId('host-ops-alert-audit')).toHaveTextContent('Acknowledged')
    expect(screen.getByTestId('host-ops-alert-audit')).toHaveTextContent('mcp-client:test')
  })

  it('runs acknowledge and close actions from the host ops alert context', async () => {
    const activeAlert: KomariAlertRecord = {
      schemaVersion: 1,
      source: 'komari',
      alertId: 'alert-active-card',
      fingerprint: 'komari-prod|node-1|host-1|offline',
      integrationId: 'komari-prod',
      nodeId: 'node-1',
      hostId: host.id,
      kind: 'offline',
      title: 'Offline host',
      severity: 'critical',
      count: 1,
      status: 'active',
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      closedAt: null,
      relatedOperationJobId: null,
      deduplicatedCount: 0,
    }
    const acknowledgedAlert: KomariAlertRecord = {
      ...activeAlert,
      alertId: 'alert-ack-card',
      fingerprint: 'komari-prod|node-1|host-1|load',
      kind: 'load',
      title: 'Load alert',
      severity: 'warning',
      status: 'acknowledged',
      acknowledgedAt: 1_100,
      acknowledgedBy: 'mcp-client:test',
      relatedOperationJobId: 'job-ack-card',
    }
    const onKomariAlertAction = vi.fn()

    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        operations={{
          serviceTotal: null,
          serviceActive: null,
          serviceFailed: null,
          processTotal: null,
          processRunning: null,
          auditCount: 0,
          transport: 'direct',
          komariAlerts: [activeAlert, acknowledgedAlert],
          onKomariAlertAction,
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('komari-host-alert-ack-alert-active-card'))
    await waitFor(() => expect(onKomariAlertAction).toHaveBeenCalledWith('acknowledge', activeAlert))

    fireEvent.click(screen.getByTestId('komari-host-alert-close-alert-ack-card'))
    await waitFor(() => expect(onKomariAlertAction).toHaveBeenCalledWith('close', acknowledgedAlert))
  })
})
