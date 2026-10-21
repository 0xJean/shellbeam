import { persistKomariAlertState } from './komari-persistence'
import { describe, expect, it, vi } from 'vitest'
import type { KomariAlertState } from './komari-alerts'
import { persistKomariAlertAction, persistKomariAlertOperationLink, runKomariAlertAction } from './komari-alert-actions'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

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
    kind: 'probe-error:metrics',
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

const host = {
  id: 'h',
  name: 'Host',
  address: '10.0.0.2',
  port: 22,
  username: 'root',
  authType: 'password' as const,
  group: 'Default',
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

describe('persistKomariAlertAction', () => {
  it('runs a host-card action through a durable OperationJob', async () => {
    invoke
      .mockResolvedValueOnce({ jobId: 'job-card', auditId: 'audit-card', status: 'queued' })
      .mockResolvedValueOnce({ jobId: 'job-card', auditId: 'audit-card', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'job-card', auditId: 'audit-card', status: 'completed' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const result = await runKomariAlertAction('acknowledge', {
      integrationId: 'i',
      state,
      alertId: 'a1',
      host,
      vaultId: 'vault-1',
      actor: 'alice',
      now: 10,
    })

    expect(result).not.toBeNull()
    expect(result!.alert).toMatchObject({ status: 'acknowledged', relatedOperationJobId: 'job-card' })
    expect(result!.state.audit.map((entry) => entry.operationJobId)).toEqual(['job-card', 'job-card'])
    expect(result!.job).toMatchObject({ jobId: 'job-card', status: 'completed' })
    expect(invoke).toHaveBeenNthCalledWith(1, 'operation_job_create', expect.objectContaining({
      request: expect.objectContaining({
        hostId: 'h',
        vaultId: 'vault-1',
        source: 'monitor',
        action: 'komari.alert.acknowledge',
        provider: 'komari-local',
        transport: 'local',
        confirmationRequired: true,
        actor: 'alice',
      }),
    }))
    expect(invoke).toHaveBeenNthCalledWith(2, 'operation_job_update', expect.objectContaining({ request: expect.objectContaining({ status: 'running' }) }))
    expect(invoke).toHaveBeenNthCalledWith(3, 'operation_job_update', expect.objectContaining({ request: expect.objectContaining({ status: 'completed' }) }))
  })

  it('does not continue a lifecycle write after the Vault scope changes during the operation link', async () => {
    let current = true
    invoke
      .mockResolvedValueOnce({ jobId: 'job-scope', auditId: 'audit-scope', status: 'queued' })
      .mockResolvedValueOnce({ jobId: 'job-scope', auditId: 'audit-scope', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'job-scope', auditId: 'audit-scope', status: 'failed' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const persist = vi.mocked(persistKomariAlertState)
    persist.mockClear()
    persist.mockImplementationOnce(async () => { current = false })
    await expect(runKomariAlertAction('close', {
      integrationId: 'i', state, alertId: 'a1', host, vaultId: 'vault-1', isCurrent: () => current,
    })).rejects.toThrow('Operation context changed')
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].state.audit.at(-1)?.event).toBe('operation-linked')
  })

  it('updates the lifecycle and persists the audit entry', async () => {
    const result = await persistKomariAlertAction('acknowledge', { integrationId: 'i', state, alertId: 'a1', actor: 'alice', now: 3 })
    expect(result.alert).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'alice' })
    expect(result.state.audit[0]).toMatchObject({ event: 'acknowledged', operationJobId: 'job-1' })
    expect(result.state.summary.open).toBe(1)
  })

  it('links a confirmed OperationJob to the alert and is idempotent', async () => {
    const first = await persistKomariAlertOperationLink({ integrationId: 'i', state, alertId: 'a1', operationJobId: 'job-2', actor: 'alice', now: 4 })
    expect(first.alert).toMatchObject({ relatedOperationJobId: 'job-2' })
    expect(first.state.audit).toHaveLength(1)
    expect(first.state.audit[0]).toMatchObject({ event: 'operation-linked', operationJobId: 'job-2', actor: 'alice' })
    const second = await persistKomariAlertOperationLink({ integrationId: 'i', state: first.state, alertId: 'a1', operationJobId: 'job-2', actor: 'alice', now: 5 })
    expect(second.state.audit).toHaveLength(1)
    expect(second.state).toEqual(first.state)
  })

  it('rejects invalid links without persisting', async () => {
    await expect(persistKomariAlertOperationLink({ integrationId: 'i', state, alertId: 'a1', operationJobId: ' ' })).rejects.toThrow('job id is required')
    await expect(persistKomariAlertOperationLink({ integrationId: 'i', state, alertId: 'missing', operationJobId: 'job-2' })).rejects.toThrow('not found')
  })

  it('rejects unknown alerts without persisting', async () => {
    await expect(persistKomariAlertAction('close', { integrationId: 'i', state, alertId: 'missing' })).rejects.toThrow('not found')
  })

  it('does not append duplicate lifecycle audit rows when a request is retried', async () => {
    const acknowledged = await persistKomariAlertAction('acknowledge', { integrationId: 'i', state, alertId: 'a1', actor: 'alice', now: 6 })
    const retriedAck = await persistKomariAlertAction('acknowledge', { integrationId: 'i', state: acknowledged.state, alertId: 'a1', actor: 'alice', now: 7 })
    expect(retriedAck.state).toEqual(acknowledged.state)
    expect(retriedAck.state.audit).toHaveLength(1)

    const closed = await persistKomariAlertAction('close', { integrationId: 'i', state: retriedAck.state, alertId: 'a1', actor: 'alice', now: 8 })
    const retriedClose = await persistKomariAlertAction('close', { integrationId: 'i', state: closed.state, alertId: 'a1', actor: 'alice', now: 9 })
    expect(retriedClose.state).toEqual(closed.state)
    expect(retriedClose.state.audit).toHaveLength(2)
  })
})
