import type { HostProfile } from './hosts'
import {
  createKomariProbeClient,
  listKomariClients,
  type KomariConnectionConfig,
  type KomariFetch,
  type KomariClient,
} from './komari'
import { mapKomariNodesToHosts, type KomariMappingResult } from './komari-mapping'
import { createKomariProbeProvider } from './komari-probe-provider'
import type { ProbeSnapshot } from './probe-provider'

export interface KomariSyncResult {
  integrationId: string
  syncedAt: number
  clients: KomariClient[]
  mapping: KomariMappingResult
  snapshots: ProbeSnapshot[]
}

/**
 * Read-only sync orchestration. It discovers nodes, resolves host mappings and
 * collects metrics through the same ProbeProvider contract used by SSH.
 * Nothing in this function writes to a remote Komari Server or executes SSH.
 */
export async function syncKomariIntegration(options: {
  integrationId: string
  config: KomariConnectionConfig
  hosts: HostProfile[]
  explicitMappings?: Record<string, string>
  now?: number
  fetchImpl?: KomariFetch
}): Promise<KomariSyncResult> {
  const syncedAt = options.now ?? Date.now()
  const clients = await listKomariClients(options.config, options.fetchImpl)
  const mapping = mapKomariNodesToHosts({
    hosts: options.hosts,
    nodes: clients,
    explicit: options.explicitMappings,
    now: syncedAt,
  })
  const nodeByHostId = new Map(mapping.mappings.map((item) => [
    item.hostId,
    clients.find((client) => client.uuid === item.nodeId) ?? null,
  ]))
  const provider = createKomariProbeProvider({
    endpoint: options.config.endpoint,
    client: createKomariProbeClient(options.config, options.fetchImpl),
    nodeForHost: (host) => nodeByHostId.get(host.id) ?? null,
    id: options.integrationId,
  })
  const snapshots = await Promise.all(mapping.mappings.map((item) => {
    const host = options.hosts.find((candidate) => candidate.id === item.hostId)
    if (!host) return null
    return provider.probe({
      host,
      resolveAuthSecret: async () => '',
      sections: ['metrics'],
      now: syncedAt,
    })
  }))
  return {
    integrationId: options.integrationId,
    syncedAt,
    clients,
    mapping,
    snapshots: snapshots.filter((snapshot): snapshot is ProbeSnapshot => snapshot !== null),
  }
}
