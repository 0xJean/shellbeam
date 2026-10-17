import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { checkKomariLinkedProbe, runKomariLinkedProbeOperation } from './komari-probe-link'
import type { ShellbeamAgentCommandResult, ShellbeamAgentOperationResult } from './shellbeam-agent'
import { checkShellbeamAgent, runShellbeamAgentOperation } from './shellbeam-agent'
import { persistKomariAlertOperationLink } from './komari-alert-actions'
import type { KomariAlertState } from './komari-alerts'

vi.mock('./shellbeam-agent', async () => {
  const actual = await vi.importActual<typeof import('./shellbeam-agent')>('./shellbeam-agent')
  return {
    ...actual,
    checkShellbeamAgent: vi.fn(),
    runShellbeamAgentOperation: vi.fn(),
  }
})

vi.mock('./komari-alert-actions', () => ({
  persistKomariAlertOperationLink: vi.fn(),
}))

const host: HostProfile = {
  id: 'host-1', name: 'prod', address: '10.0.0.1', port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [],
  jumpHost: 'bastion', jumpPort: 2200, jumpUser: 'jump', createdAt: 0, updatedAt: 0,
}
const mapping = { integrationId: 'komari-prod', hostId: 'host-1', nodeId: 'node-1', source: 'manual' as const, confidence: 'explicit' as const, updatedAt: 100 }

describe('Komari probe action bridge', () => {
  beforeEach(() => {
    vi.mocked(checkShellbeamAgent).mockReset()
    vi.mocked(runShellbeamAgentOperation).mockReset()
    vi.mocked(persistKomariAlertOperationLink).mockReset()
  })

  it('uses the mapped ProxyJump host for a read-only check', async () => {
    const commandResult = { record: { hostId: host.id }, stdout: '', stderr: '', exitCode: 0, durationMs: 4 } as unknown as ShellbeamAgentCommandResult
    vi.mocked(checkShellbeamAgent).mockResolvedValue(commandResult)
    const result = await checkKomariLinkedProbe({ integrationId: 'komari-prod', nodeId: 'node-1', mappings: [mapping], hosts: [host], resolveAuthSecret: async () => 'secret', now: 10 })
    expect(result.target.host).toBe(host)
    expect(checkShellbeamAgent).toHaveBeenCalledWith(host, expect.any(Function), 10)
  })

  it('only forwards fixed lifecycle actions to the confirmed OperationJob path', async () => {
    const operationResult = { record: { hostId: host.id }, job: { jobId: 'job-1' } } as unknown as ShellbeamAgentOperationResult
    vi.mocked(runShellbeamAgentOperation).mockResolvedValue(operationResult)
    const onRecord = vi.fn()
    const result = await runKomariLinkedProbeOperation({ integrationId: 'komari-prod', nodeId: 'node-1', mappings: [mapping], hosts: [host], resolveAuthSecret: async () => 'secret', action: 'upgrade', vaultId: 'vault-1', version: '1.2.0', onRecord })
    expect(result.target.host).toBe(host)
    expect(runShellbeamAgentOperation).toHaveBeenCalledWith(expect.objectContaining({ host, action: 'upgrade', vaultId: 'vault-1', version: '1.2.0', onRecord }))
  })

  it('links a confirmed Probe OperationJob back to the supplied Komari alert', async () => {
    const state = { schemaVersion: 1, alerts: [{ alertId: 'alert-1' }], audit: [], summary: {} } as unknown as KomariAlertState
    const linkedState = { ...state, audit: [{ auditId: 'link-1' }] } as unknown as KomariAlertState
    vi.mocked(runShellbeamAgentOperation).mockResolvedValue({ record: { hostId: host.id }, job: { jobId: 'job-1' } } as unknown as ShellbeamAgentOperationResult)
    vi.mocked(persistKomariAlertOperationLink).mockResolvedValue({ state: linkedState, alert: state.alerts[0]! })
    const onAlertState = vi.fn()
    const result = await runKomariLinkedProbeOperation({ integrationId: 'komari-prod', nodeId: 'node-1', mappings: [mapping], hosts: [host], resolveAuthSecret: async () => 'secret', action: 'install', alertState: state, alertId: 'alert-1', onAlertState })
    expect(persistKomariAlertOperationLink).toHaveBeenCalledWith(expect.objectContaining({ integrationId: 'komari-prod', alertId: 'alert-1', operationJobId: 'job-1', state }))
    expect(onAlertState).toHaveBeenCalledWith(linkedState)
    expect(result.alertState).toBe(linkedState)
  })

  it('rejects an unmapped alert before reading Vault or touching SSH', async () => {
    const resolveAuthSecret = vi.fn(async () => 'secret')
    await expect(checkKomariLinkedProbe({ integrationId: 'komari-prod', nodeId: 'missing', mappings: [mapping], hosts: [host], resolveAuthSecret })).rejects.toThrow('not mapped')
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    expect(checkShellbeamAgent).not.toHaveBeenCalled()
  })
})
