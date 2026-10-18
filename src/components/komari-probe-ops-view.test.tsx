import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
import type { OperationAuditEntry } from '@/lib/operation-job'
import { I18nProvider } from '@/lib/i18n'
import { KomariProbeOpsView } from './komari-probe-ops-view'

const host: HostProfile = {
  id: 'host-1', name: 'prod', address: '10.0.0.1', port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [],
  jumpHost: 'bastion', jumpPort: 2200, jumpUser: 'jump', createdAt: 0, updatedAt: 0,
}

const link = {
  integrationId: 'komari-prod',
  nodeId: 'node-1',
  hostId: host.id,
  mapping: { integrationId: 'komari-prod', hostId: host.id, nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 },
  status: 'linked',
  alertState: {
    schemaVersion: 1,
    alerts: [{ alertId: 'alert-1', integrationId: 'komari-prod', nodeId: 'node-1', hostId: host.id, status: 'active', relatedOperationJobId: 'job-1' }],
    audit: [], summary: {},
  },
  komari: { state: 'online', sampledAt: 1_000, receivedAt: 1_000, alerts: { load: 1, offline: 0, total: 1, active: 1, updatedAt: 1_000 }, snapshot: null },
  probe: { state: 'installed', health: 'online', version: '1.0.0', lastHeartbeatAt: 1_000, record: { capabilities: [] } },
  recommendedAction: 'none',
} as unknown as KomariProbeLink

describe('KomariProbeOpsView', () => {
  it('surfaces open alert and linked OperationJob in the host operations context', () => {
    render(<I18nProvider><KomariProbeOpsView host={host} link={link} /></I18nProvider>)
    expect(screen.getByTestId('komari-probe-ops-view')).toBeInTheDocument()
    expect(screen.getByText('1 open alert(s)')).toBeInTheDocument()
    expect(screen.getByText('job job-1')).toBeInTheDocument()
    expect(screen.getByText('ProxyJump')).toBeInTheDocument()
  })

  it('labels a real sync time independently and leaves missing sync metadata unknown', () => {
    const current = { ...link, komari: { ...link.komari, sampledAt: 1000, lastSyncedAt: 2000 } }
    const view = render(<I18nProvider><KomariProbeOpsView host={host} link={current} /></I18nProvider>)
    const sync = screen.getByTestId('komari-host-last-sync')
    expect(sync).toHaveTextContent('Komari last synchronized')
    expect(sync.querySelector('time')).toHaveAttribute('datetime', new Date(2000).toISOString())
    expect(sync.querySelector('time')).not.toHaveAttribute('datetime', new Date(1000).toISOString())
    view.rerender(<I18nProvider><KomariProbeOpsView host={host} link={{ ...current, komari: { ...current.komari, lastSyncedAt: null } }} /></I18nProvider>)
    expect(screen.getByTestId('komari-host-last-sync')).toHaveTextContent('Unknown')
    expect(screen.getByTestId('komari-host-last-sync').querySelector('time')).toBeNull()
  })

  it('summarizes acknowledged and closed alerts and resolves the linked MCP job audit', () => {
    const acknowledged = {
      ...link.alertState!.alerts[0],
      alertId: 'alert-ack',
      status: 'acknowledged',
      relatedOperationJobId: 'job-ack',
    }
    const closed = {
      ...link.alertState!.alerts[0],
      alertId: 'alert-closed',
      status: 'closed',
      relatedOperationJobId: null,
    }
    const operationAudit: OperationAuditEntry = {
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
      <I18nProvider>
        <KomariProbeOpsView
          host={host}
          link={{
            ...link,
            alertState: {
              ...link.alertState!,
              alerts: [link.alertState!.alerts[0], acknowledged, closed],
              audit: [{
                auditId: 'alert-audit-ack',
                alertId: 'alert-ack',
                fingerprint: 'prod|node-1|host-1|offline',
                event: 'acknowledged',
                status: 'acknowledged',
                actor: 'mcp-client:test',
                operationJobId: 'job-ack',
                at: 2_000,
              }],
            },
          } as unknown as KomariProbeLink}
          operationAudits={[operationAudit]}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('2 open alert(s)')).toBeInTheDocument()
    expect(screen.getByText('Acknowledged: 1')).toBeInTheDocument()
    expect(screen.getByText('Closed: 1')).toBeInTheDocument()
    expect(screen.getByText('job job-ack · completed')).toBeInTheDocument()
  })
})
