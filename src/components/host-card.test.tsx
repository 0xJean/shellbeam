import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostListItem } from './host-card'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
import type { OperationAuditEntry } from '@/lib/operation-job'
import type { KomariAlertRecord } from '@/lib/komari-alerts'

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

describe('host list item', () => {
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
