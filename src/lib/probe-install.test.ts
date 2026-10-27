import { describe, expect, it } from 'vitest'
import type { CompatibleAgentRecord } from './compatible-agent'
import type { HostProfile } from './hosts'
import type { CurrentKomariSource } from './komari-source-eligibility'
import { offersProbeInstall, probeInstallReadiness, probePreflightFailure } from './probe-install'

const host = (patch: Partial<HostProfile> = {}): HostProfile => ({
  id: 'h1', vaultId: 'v1', name: 'redis-cache', address: '10.0.3.20', port: 22, username: 'root',
  group: 'production', authType: 'privateKey', tags: [], createdAt: 1, updatedAt: 1, monitoringMode: 'server', ...patch,
} as HostProfile)

const source = (id: string, mappings: Array<{ hostId: string; nodeId: string }> = [], patch: Partial<CurrentKomariSource> = {}): CurrentKomariSource => ({
  integration: { id, vaultId: 'v1', name: id, endpoint: 'https://monitor.example', credentialRef: '', enabled: true, createdAt: 1, updatedAt: 1 },
  state: { mappings: mappings.map((m) => ({ ...m, integrationId: id, source: 'manual' })) } as unknown as CurrentKomariSource['state'],
  mappingRevision: 1,
  error: false,
  ...patch,
})

const record = (patch: Partial<CompatibleAgentRecord> = {}): CompatibleAgentRecord => ({
  vaultId: 'v1', hostId: 'h1', hostCreatedAt: 1, integrationId: 's1', deployment: 'd', revision: 1,
  observation: { status: 'absent', active: false }, status: 'absent', action: 'inspect', jobId: 'j', endpoint: '', nodeId: 'n1',
  current: null, previous: null, requested: null, observedAt: null, updatedAt: 1, errorCode: null, ...patch,
})

describe('probeInstallReadiness', () => {
  it('starts at the server step when the vault has no usable source', () => {
    expect(probeInstallReadiness(host(), [], null).stage).toBe('no-server')
    expect(probeInstallReadiness(host(), [source('s1', [], { error: true })], null).stage).toBe('no-server')
  })

  it('asks for a node when the host is not mapped', () => {
    expect(probeInstallReadiness(host(), [source('s1', [{ hostId: 'other', nodeId: 'n9' }])], null)).toEqual({ stage: 'no-node', integrationId: 's1' })
  })

  it('asks to switch the monitoring mode when the host still uses SSH sampling', () => {
    expect(probeInstallReadiness(host({ monitoringMode: 'ssh' }), [source('s1', [{ hostId: 'h1', nodeId: 'n1' }])], null)).toEqual({ stage: 'ssh-mode', integrationId: 's1', nodeId: 'n1' })
  })

  it('is ready once source, node and mode are in place', () => {
    expect(probeInstallReadiness(host(), [source('s0'), source('s1', [{ hostId: 'h1', nodeId: 'n1' }])], null)).toEqual({ stage: 'ready', integrationId: 's1', nodeId: 'n1' })
  })

  it('reports installed and unsettled probes without offering an install', () => {
    const installed = probeInstallReadiness(host(), [], record({ current: { manifest: {} as never, publicKey: '' }, observation: { status: 'active', active: true } }))
    expect(installed.stage).toBe('installed')
    expect(offersProbeInstall(installed)).toBe(false)
    const unsettled = probeInstallReadiness(host(), [], record({ status: 'dispatched' }))
    expect(unsettled.stage).toBe('unsettled')
    expect(offersProbeInstall(unsettled)).toBe(false)
  })

  it('ignores records that belong to another host or vault', () => {
    const foreign = record({ hostId: 'h2', current: { manifest: {} as never, publicKey: '' }, observation: { status: 'active', active: true } })
    expect(probeInstallReadiness(host(), [], foreign).stage).toBe('no-server')
  })

  it('never offers an install without SSH', () => {
    const readiness = probeInstallReadiness(host({ connections: [] }), [source('s1', [{ hostId: 'h1', nodeId: 'n1' }])], null)
    expect(readiness.stage).toBe('no-ssh')
    expect(offersProbeInstall(readiness)).toBe(false)
  })
})

describe('probePreflightFailure', () => {
  it('maps backend error codes onto preflight rows', () => {
    expect(probePreflightFailure(new Error('KOMARI_AGENT_SSH_CONNECTION'))).toEqual({ check: 'ssh', code: 'KOMARI_AGENT_SSH_CONNECTION' })
    expect(probePreflightFailure('KOMARI_AGENT_LINUX_REQUIRED').check).toBe('system')
    expect(probePreflightFailure('KOMARI_AGENT_LINGER_REQUIRED').check).toBe('account')
    expect(probePreflightFailure('KOMARI_AGENT_NODE_ALREADY_REPORTING').check).toBe('existing')
    expect(probePreflightFailure('KOMARI_AGENT_MAPPING_REQUIRED').check).toBe('node')
    expect(probePreflightFailure('KOMARI_AGENT_CATALOG_EXPIRED').check).toBe('release')
    expect(probePreflightFailure('boom')).toEqual({ check: 'server', code: 'KOMARI_AGENT_OPERATION_FAILED' })
  })
})
