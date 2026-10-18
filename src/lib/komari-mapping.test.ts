import { describe, expect, it } from 'vitest'
import { mapKomariNodesToHosts } from './komari-mapping'
import type { HostProfile } from './hosts'
import type { KomariClient } from './komari'

const host = (id: string, address: string, name = id): HostProfile => ({
  id, name, address, port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [], createdAt: 0, updatedAt: 0,
})
const node = (uuid: string, address: string, name = uuid): KomariClient => ({
  uuid, name, hostname: name, ipv4: address, ipv6: null, os: null, kernel: null, version: null, raw: {},
})

describe('Komari host mapping', () => {
  it('prefers explicit mappings and fills unique address matches', () => {
    const result = mapKomariNodesToHosts({
      hosts: [host('h1', '10.0.0.1'), host('h2', '10.0.0.2')],
      nodes: [node('n1', '10.0.0.9'), node('n2', '10.0.0.2')],
      explicit: { h1: 'n1' },
      now: 123,
    })
    expect(result.mappings).toEqual([
      expect.objectContaining({ hostId: 'h1', nodeId: 'n1', source: 'manual', confidence: 'explicit', updatedAt: 123 }),
      expect.objectContaining({ hostId: 'h2', nodeId: 'n2', source: 'address', confidence: 'matched' }),
    ])
    expect(result.unmappedHosts).toEqual([])
    expect(result.unmappedNodes).toEqual([])
  })

  it('leaves ambiguous address matches unresolved', () => {
    const result = mapKomariNodesToHosts({
      hosts: [host('h1', '10.0.0.1', 'shared'), host('h2', '10.0.0.2', 'shared')],
      nodes: [node('n1', '10.0.0.9', 'shared')],
    })
    expect(result.mappings).toEqual([])
    expect(result.conflicts).toEqual([{ nodeId: 'n1', hostIds: ['h1', 'h2'], reason: 'address-ambiguous' }])
  })

  it('retains a manual binding while its node is absent and reserves the host from automatic reuse', () => {
    const result = mapKomariNodesToHosts({ hosts: [host('h1', '10.0.0.1')], nodes: [node('new-node', '10.0.0.1')], explicit: { h1: 'temporarily-absent' } })
    expect(result.mappings).toEqual([expect.objectContaining({ hostId: 'h1', nodeId: 'temporarily-absent', source: 'manual' })])
    expect(result.unmappedNodes).toEqual(['new-node'])
  })
})
