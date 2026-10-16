import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
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
})
