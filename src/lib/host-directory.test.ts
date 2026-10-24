import { describe, expect, it, vi } from 'vitest'
import { hasSshConnection, hostConnections, hostConnectionKey, withHostConnections, validateHostDraft, type HostProfile } from './hosts'
import { mapKomariNodesToHosts } from './komari-mapping'
import { scanServerMonitorHosts } from './server-monitor-scan'
import { scanWorkspaceInventoryHosts } from './workspace-inventory-scan'
import { selectBatchHosts } from './multi-host-operations'
import { getHostIdentity } from './host-identity'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
const host: HostProfile = { id: 'stable', vaultId: 'v', name: 'WEB', address: 'old', port: 2222, username: 'ops', authType: 'privateKey', privateKeyRef: 'keep-key', group: 'prod', tags: ['keep'], createdAt: 1, updatedAt: 2 }

describe('unified host directory', () => {
  it('projects legacy connections without changing host or credential identity', () => {
    const connections = hostConnections(host)
    expect(connections).toEqual([expect.objectContaining({ id: host.id, privateKeyRef: 'keep-key' })])
    const renamed = { ...host, ...withHostConnections(host, connections, connections[0].id), name: 'Renamed' }
    expect(hostConnectionKey(renamed)).toBe(hostConnectionKey(host))
    const secondary = { ...connections[0], id: 'secondary', label: 'Admin', username: 'admin', privateKeyRef: 'admin-key', jumpHostId: 'jump' }
    const updated = { ...host, ...withHostConnections(host, [...connections, secondary], 'secondary') } as HostProfile
    expect(updated.id).toBe(host.id); expect(updated.createdAt).toBe(1)
    expect(updated.username).toBe('admin'); expect(updated.jumpHostId).toBe('jump')
    expect(updated.connections?.[0].privateKeyRef).toBe('keep-key')
    expect(hostConnectionKey(updated)).not.toBe(hostConnectionKey(host))
    expect(validateHostDraft(updated).isValid).toBe(true)
  })
  it('retains one host when its last connection is removed and adding SSH later reuses it', () => {
    const pure = { ...host, ...withHostConnections(host, [], null) } as HostProfile
    expect(pure.id).toBe(host.id); expect(pure.tags).toEqual(host.tags)
    expect(hasSshConnection(pure)).toBe(false)
    expect(getHostIdentity(pure)).toEqual({ hostId: host.id, address: '', port: 0, username: '' })
    expect(validateHostDraft(pure).isValid).toBe(true)
    const added = { ...pure, ...withHostConnections(pure, hostConnections(host), host.id) }
    expect(added.id).toBe(host.id); expect(hasSshConnection(added)).toBe(true)
  })
  it('does not access SSH credentials or create failed collections for monitoring-only hosts', async () => {
    const pure = { ...host, ...withHostConnections(host, [], null) } as HostProfile
    const resolveAuthSecret = vi.fn(async () => 'never-read')
    await scanServerMonitorHosts({ hosts: [pure], vaultId: 'v', resolveAuthSecret })
    await scanWorkspaceInventoryHosts({ hosts: [pure], vaultId: 'v', resolveAuthSecret })
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    expect(() => selectBatchHosts([host, pure], [pure.id])).toThrow('HOST_CONNECTION_REQUIRED')
  })
  it('finds secondary-address suggestions without authorizing monitoring or merging objects', () => {
    const multi = { ...host, ...withHostConnections(host, [...hostConnections(host), { ...hostConnections(host)[0], id: 'second', address: 'second.test' }], host.id) } as HostProfile
    const node = { uuid: 'node', name: 'different', hostname: '', ipv4: 'second.test', ipv6: null, os: null, kernel: null, version: null, raw: {} }
    const unconfirmed = mapKomariNodesToHosts({ hosts: [multi], nodes: [node] })
    expect(unconfirmed.mappings).toEqual([])
    expect(unconfirmed.suggestions?.[0].hostId).toBe(host.id)
    expect(mapKomariNodesToHosts({ hosts: [multi], nodes: [node], explicit: { [host.id]: node.uuid } }).mappings[0].source).toBe('manual')
  })
})
