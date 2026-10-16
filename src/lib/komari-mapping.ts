import type { HostProfile } from './hosts'
import type { KomariClient } from './komari'

export interface KomariHostMapping {
  hostId: string
  nodeId: string
  source: 'manual' | 'address'
  confidence: 'explicit' | 'matched'
  updatedAt: number
}

export interface KomariMappingConflict {
  nodeId: string
  hostIds: string[]
  reason: 'node-already-mapped' | 'address-ambiguous'
}

export interface KomariMappingResult {
  mappings: KomariHostMapping[]
  unmappedHosts: string[]
  unmappedNodes: string[]
  conflicts: KomariMappingConflict[]
}

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function nodeAddresses(node: KomariClient): string[] {
  return [node.ipv4, node.ipv6, node.hostname, node.name].map(normalized).filter(Boolean)
}

/**
 * Resolve Komari nodes without changing HostProfile. Explicit mappings always
 * win; address matching is only used when it identifies one host uniquely.
 */
export function mapKomariNodesToHosts(options: {
  hosts: HostProfile[]
  nodes: KomariClient[]
  explicit?: Record<string, string>
  now?: number
}): KomariMappingResult {
  const now = options.now ?? Date.now()
  const hostById = new Map(options.hosts.map((host) => [host.id, host]))
  const nodeById = new Map(options.nodes.map((node) => [node.uuid, node]))
  const usedHosts = new Set<string>()
  const usedNodes = new Set<string>()
  const mappings: KomariHostMapping[] = []
  const conflicts: KomariMappingConflict[] = []

  for (const [hostId, nodeId] of Object.entries(options.explicit ?? {})) {
    if (!hostById.has(hostId) || !nodeById.has(nodeId)) continue
    if (usedHosts.has(hostId) || usedNodes.has(nodeId)) {
      conflicts.push({ nodeId, hostIds: [hostId], reason: 'node-already-mapped' })
      continue
    }
    usedHosts.add(hostId)
    usedNodes.add(nodeId)
    mappings.push({ hostId, nodeId, source: 'manual', confidence: 'explicit', updatedAt: now })
  }

  for (const node of options.nodes) {
    if (usedNodes.has(node.uuid)) continue
    const addresses = new Set(nodeAddresses(node))
    const candidates = options.hosts.filter((host) => {
      if (usedHosts.has(host.id)) return false
      return addresses.has(normalized(host.address)) || addresses.has(normalized(host.name))
    })
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        conflicts.push({ nodeId: node.uuid, hostIds: candidates.map((host) => host.id), reason: 'address-ambiguous' })
      }
      continue
    }
    const host = candidates[0]
    usedHosts.add(host.id)
    usedNodes.add(node.uuid)
    mappings.push({ hostId: host.id, nodeId: node.uuid, source: 'address', confidence: 'matched', updatedAt: now })
  }

  return {
    mappings,
    unmappedHosts: options.hosts.filter((host) => !usedHosts.has(host.id)).map((host) => host.id),
    unmappedNodes: options.nodes.filter((node) => !usedNodes.has(node.uuid)).map((node) => node.uuid),
    conflicts,
  }
}
