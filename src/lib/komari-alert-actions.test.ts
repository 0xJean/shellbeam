import { describe, expect, it, vi } from 'vitest'
import type { KomariAlertState } from './komari-alerts'
import { persistKomariAlertAction } from './komari-alert-actions'

vi.mock('./komari-persistence', () => ({
  persistKomariAlertState: vi.fn().mockResolvedValue(undefined),
}))

const state: KomariAlertState = {
  schemaVersion: 1,
  alerts: [{
    schemaVersion: 1,
    source: 'komari',
    alertId: 'a1',
    fingerprint: 'i|n|h|load',
    integrationId: 'i',
    nodeId: 'n',
    hostId: 'h',
    kind: 'load',
    title: 'Load',
    severity: 'warning',
    count: 1,
    status: 'active',
    firstSeenAt: 1,
    lastSeenAt: 2,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    closedAt: null,
    relatedOperationJobId: 'job-1',
    deduplicatedCount: 0,
  }],
  audit: [],
  summary: { load: 1, offline: 0, total: 1, active: 1, open: 1, acknowledged: 0, resolved: 0, closed: 0, deduplicated: 0, localUpdatedAt: 2, updatedAt: 2 },
}

describe('persistKomariAlertAction', () => {
  it('updates the lifecycle and persists the audit entry', async () => {
    const result = await persistKomariAlertAction('acknowledge', { integrationId: 'i', state, alertId: 'a1', actor: 'alice', now: 3 })
    expect(result.alert).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'alice' })
    expect(result.state.audit[0]).toMatchObject({ event: 'acknowledged', operationJobId: 'job-1' })
    expect(result.state.summary.open).toBe(1)
  })

  it('rejects unknown alerts without persisting', async () => {
    await expect(persistKomariAlertAction('close', { integrationId: 'i', state, alertId: 'missing' })).rejects.toThrow('not found')
  })
})
