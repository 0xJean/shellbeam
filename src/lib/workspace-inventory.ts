import { getHostObservationKey, observationVaultIds, type ObservationHost } from './host-observation-scope'
import type { HostProfile } from '@/lib/hosts'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { invoke } from '@tauri-apps/api/core'
import { normalizeWorkspaceInventory } from './workspace-projects'
import { buildUnifiedProbeCommand, parseUnifiedProbeOutput } from './unified-probe'

export interface WorkspaceInventoryResource {
  hostname: string
  os: string
  kernel: string
  uptime: string
  cpuPercent: number | null
  memoryPercent: number | null
  memoryText: string
  diskPercent: number | null
  diskText: string
  network: string
}

export interface WorkspaceInventoryTool {
  id: string
  name: string
  category: string
  binary: string
  path: string
  version: string
}

export interface WorkspaceInventoryService {
  name: string
  active: string
  enabled: string
}

export interface WorkspaceInventoryContainer {
  name: string
  image: string
  status: string
  ports: string
}

export interface WorkspaceInventoryPm2Process {
  raw: string
}

export interface WorkspaceInventoryProject {
  path: string
  kind: string
  name: string
  modifiedAt: string
}

export interface WorkspaceInventory {
  resource: WorkspaceInventoryResource
  tools: WorkspaceInventoryTool[]
  services: WorkspaceInventoryService[]
  containers: WorkspaceInventoryContainer[]
  pm2: WorkspaceInventoryPm2Process[]
  projects: WorkspaceInventoryProject[]
  scannedAt: number
  listeningPorts?: string[]
  filesystems?: Array<Record<string, unknown>>
  inodes?: Array<Record<string, unknown>>
}

export interface WorkspaceInventoryCacheEntry {
  inventory: WorkspaceInventory
  updatedAt: number
}

export type WorkspaceInventoryCache = Record<string, WorkspaceInventoryCacheEntry>

export interface WorkspaceInventorySnapshot {
  hostKey: string
  hostId: string
  hostName: string
  hostAddress: string
  username: string
  port: number
  inventory: WorkspaceInventory
  updatedAt: number
}

export interface WorkspaceInventoryHostStateSnapshot {
  hostKey: string
  hostId: string
  hostName: string
  hostAddress: string
  username: string
  port: number
  hostGroup: string
  tags: string[]
  authType: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  status: 'ready' | 'error' | 'unsupported'
  error?: string
  updatedAt: number
}

const WORKSPACE_INVENTORY_CACHE_KEY = 'shellbeam.workspaceInventoryCache.v1'
const memoryInventoryCache: WorkspaceInventoryCache = {}

const DEFAULT_RESOURCE: WorkspaceInventoryResource = {
  hostname: '',
  os: '',
  kernel: '',
  uptime: '',
  cpuPercent: null,
  memoryPercent: null,
  memoryText: '',
  diskPercent: null,
  diskText: '',
  network: '',
}

export const WORKSPACE_INVENTORY_COMMAND = buildUnifiedProbeCommand('inventory')

export const getWorkspaceInventoryHostKey = (host: ObservationHost) => getHostObservationKey(host)

function isWorkspaceInventory(value: unknown): value is WorkspaceInventory {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceInventory>
  return !!record.resource
    && Array.isArray(record.tools)
    && Array.isArray(record.services)
    && Array.isArray(record.containers)
    && Array.isArray(record.pm2)
    && Array.isArray(record.projects)
    && typeof record.scannedAt === 'number'
}

function readLocalInventoryCache(): WorkspaceInventoryCache {
  if (typeof localStorage === 'undefined') return {}

  try {
    const raw = localStorage.getItem(WORKSPACE_INVENTORY_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.entries(parsed as Record<string, unknown>).reduce<WorkspaceInventoryCache>((cache, [key, value]) => {
      if (!value || typeof value !== 'object') return cache
      const entry = value as Partial<WorkspaceInventoryCacheEntry>
      if (!isWorkspaceInventory(entry.inventory) || typeof entry.updatedAt !== 'number') return cache
      cache[key] = { inventory: normalizeWorkspaceInventory(entry.inventory), updatedAt: entry.updatedAt }
      return cache
    }, {})
  } catch {
    return {}
  }
}

function writeLocalInventoryCache(cache: WorkspaceInventoryCache) {
  if (typeof localStorage === 'undefined') return

  try {
    localStorage.setItem(WORKSPACE_INVENTORY_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Best effort cache; storage may be unavailable or full.
  }
}

async function invokeWorkspaceInventoryCommand<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args)
  } catch {
    return null
  }
}

function toWorkspaceInventorySnapshot(host: HostProfile, entry: WorkspaceInventoryCacheEntry): WorkspaceInventorySnapshot {
  return {
    hostKey: getWorkspaceInventoryHostKey(host),
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    port: host.port || 22,
    inventory: entry.inventory,
    updatedAt: entry.updatedAt,
  }
}

function isWorkspaceInventorySnapshot(value: unknown): value is WorkspaceInventorySnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceInventorySnapshot>
  return typeof record.hostKey === 'string'
    && typeof record.hostId === 'string'
    && typeof record.hostName === 'string'
    && typeof record.hostAddress === 'string'
    && typeof record.username === 'string'
    && typeof record.port === 'number'
    && isWorkspaceInventory(record.inventory)
    && typeof record.updatedAt === 'number'
}

function isWorkspaceInventoryHostStateSnapshot(value: unknown): value is WorkspaceInventoryHostStateSnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceInventoryHostStateSnapshot>
  return typeof record.hostKey === 'string'
    && typeof record.hostId === 'string'
    && typeof record.hostName === 'string'
    && typeof record.hostAddress === 'string'
    && typeof record.username === 'string'
    && typeof record.port === 'number'
    && typeof record.hostGroup === 'string'
    && Array.isArray(record.tags)
    && typeof record.authType === 'string'
    && (record.status === 'ready' || record.status === 'error' || record.status === 'unsupported')
    && typeof record.updatedAt === 'number'
}

function toWorkspaceInventoryHostStateSnapshot(
  host: HostProfile,
  status: WorkspaceInventoryHostStateSnapshot['status'],
  updatedAt: number,
  error?: string,
): WorkspaceInventoryHostStateSnapshot {
  return {
    hostKey: getWorkspaceInventoryHostKey(host),
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    port: host.port || 22,
    hostGroup: host.group || 'Custom',
    tags: host.tags ?? [],
    authType: host.authType,
    jumpHost: host.jumpHost,
    jumpPort: host.jumpPort,
    jumpUser: host.jumpUser,
    status,
    error,
    updatedAt,
  }
}

export function loadWorkspaceInventoryCache(hosts: HostProfile[]): WorkspaceInventoryCache {
  const localCache = readLocalInventoryCache()
  const validKeys = new Set(hosts.map(getWorkspaceInventoryHostKey))
  const nextCache: WorkspaceInventoryCache = {}

  hosts.forEach((host) => {
    const key = getWorkspaceInventoryHostKey(host)
    const entry = memoryInventoryCache[key] ?? localCache[key]
    if (entry) nextCache[key] = { inventory: normalizeWorkspaceInventory(entry.inventory), updatedAt: entry.updatedAt }
  })

  Object.keys(memoryInventoryCache).forEach((key) => {
    if (!validKeys.has(key)) delete memoryInventoryCache[key]
  })
  Object.assign(memoryInventoryCache, nextCache)

  return nextCache
}

export async function loadWorkspaceInventoryHostStateSnapshots(hosts: HostProfile[]) {
  const snapshots = await invokeWorkspaceInventoryCommand<unknown[]>('list_workspace_inventory_host_states', { vaultIds: observationVaultIds(hosts) })
  if (!snapshots) return {}

  const hostByKey = new Map(hosts.map((host) => [getWorkspaceInventoryHostKey(host), host]))
  return snapshots.reduce<Record<string, WorkspaceInventoryHostStateSnapshot>>((states, snapshot) => {
    if (!isWorkspaceInventoryHostStateSnapshot(snapshot)) return states
    if (!hostByKey.has(snapshot.hostKey)) return states
    states[snapshot.hostKey] = snapshot
    return states
  }, {})
}

export async function saveWorkspaceInventoryHostStateSnapshot(
  host: HostProfile,
  status: WorkspaceInventoryHostStateSnapshot['status'],
  updatedAt = Date.now(),
  error?: string,
) {
  const payload = toWorkspaceInventoryHostStateSnapshot(host, status, updatedAt, error)
  await invokeWorkspaceInventoryCommand<void>('upsert_workspace_inventory_host_state', { payload })
  return payload
}

export async function loadWorkspaceInventoryPersistedCache(hosts: HostProfile[]): Promise<WorkspaceInventoryCache> {
  const fallbackCache = loadWorkspaceInventoryCache(hosts)
  const snapshots = await invokeWorkspaceInventoryCommand<unknown[]>('list_workspace_inventory_snapshots', { vaultIds: observationVaultIds(hosts) })
  if (!snapshots) return fallbackCache

  const hostByKey = new Map(hosts.map((host) => [getWorkspaceInventoryHostKey(host), host]))
  const nativeCache = snapshots.reduce<WorkspaceInventoryCache>((cache, snapshot) => {
    if (!isWorkspaceInventorySnapshot(snapshot)) return cache
    if (!hostByKey.has(snapshot.hostKey)) return cache
    cache[snapshot.hostKey] = { inventory: normalizeWorkspaceInventory(snapshot.inventory), updatedAt: snapshot.updatedAt }
    return cache
  }, {})

  Object.assign(memoryInventoryCache, nativeCache)
  if (Object.keys(nativeCache).length > 0) {
    writeLocalInventoryCache({ ...readLocalInventoryCache(), ...nativeCache })
  }

  return { ...fallbackCache, ...nativeCache }
}

export async function saveWorkspaceInventoryCacheEntry(host: HostProfile, inventory: WorkspaceInventory) {
  const key = getWorkspaceInventoryHostKey(host)
  const entry = { inventory: normalizeWorkspaceInventory(inventory), updatedAt: Date.now() }
  memoryInventoryCache[key] = entry

  const localCache = readLocalInventoryCache()
  localCache[key] = entry
  writeLocalInventoryCache(localCache)

  await invokeWorkspaceInventoryCommand<void>('upsert_workspace_inventory_snapshot', {
    payload: toWorkspaceInventorySnapshot(host, entry),
  })

  return entry
}

export function clearWorkspaceInventoryMemoryCache() {
  Object.keys(memoryInventoryCache).forEach((key) => {
    delete memoryInventoryCache[key]
  })
}

export function clearWorkspaceInventoryCache() {
  clearWorkspaceInventoryMemoryCache()
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(WORKSPACE_INVENTORY_CACHE_KEY)
    } catch {
      // Best effort cache cleanup.
    }
  }
  void invokeWorkspaceInventoryCommand<void>('clear_workspace_inventory_snapshots')
}

function parseNumber(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function markerValue(line: string, marker: string) {
  return line.startsWith(`${marker}=`) ? line.slice(marker.length + 1).trim() : null
}

export function parseWorkspaceInventory(output: string): WorkspaceInventory {
  if (output.includes('__SB_PROBE_BEGIN')) return normalizeWorkspaceInventory(parseUnifiedProbeOutput(output).inventory)
  const resource = { ...DEFAULT_RESOURCE }
  const tools: WorkspaceInventoryTool[] = []
  const services: WorkspaceInventoryService[] = []
  const containers: WorkspaceInventoryContainer[] = []
  const pm2: WorkspaceInventoryPm2Process[] = []
  const projects: WorkspaceInventoryProject[] = []

  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const hostname = markerValue(line, '__SB_HOSTNAME')
      if (hostname !== null) {
        resource.hostname = hostname
        return
      }

      const os = markerValue(line, '__SB_OS')
      if (os !== null) {
        resource.os = os
        return
      }

      const kernel = markerValue(line, '__SB_KERNEL')
      if (kernel !== null) {
        resource.kernel = kernel
        return
      }

      const uptime = markerValue(line, '__SB_UPTIME')
      if (uptime !== null) {
        resource.uptime = uptime
        return
      }

      const cpu = markerValue(line, '__SB_CPU')
      if (cpu !== null) {
        resource.cpuPercent = parseNumber(cpu)
        return
      }

      const memory = markerValue(line, '__SB_MEMORY')
      if (memory !== null) {
        const [percent = '', text = ''] = memory.split('|')
        resource.memoryPercent = parseNumber(percent)
        resource.memoryText = text
        return
      }

      const disk = markerValue(line, '__SB_DISK')
      if (disk !== null) {
        const [percent = '', text = ''] = disk.split('|')
        resource.diskPercent = parseNumber(percent)
        resource.diskText = text
        return
      }

      const network = markerValue(line, '__SB_NETWORK')
      if (network !== null) {
        resource.network = network
        return
      }

      const tool = markerValue(line, '__SB_TOOL')
      if (tool !== null) {
        const [id = '', name = '', category = '', binary = '', path = '', version = ''] = tool.split('|')
        if (id && name) tools.push({ id, name, category, binary, path, version })
        return
      }

      const service = markerValue(line, '__SB_SERVICE')
      if (service !== null) {
        const [name = '', active = '', enabled = ''] = service.split('|')
        if (name) services.push({ name, active, enabled })
        return
      }

      const docker = markerValue(line, '__SB_DOCKER')
      if (docker !== null) {
        const [name = '', image = '', status = '', ports = ''] = docker.split('|')
        if (name) containers.push({ name, image, status, ports })
        return
      }

      const pm2Line = markerValue(line, '__SB_PM2')
      if (pm2Line !== null) {
        if (pm2Line) pm2.push({ raw: pm2Line })
        return
      }

      const project = markerValue(line, '__SB_PROJECT')
      if (project !== null) {
        const [path = '', kind = '', name = '', modifiedAt = ''] = project.split('|')
        if (path) projects.push({ path, kind, name, modifiedAt })
      }
    })

  return normalizeWorkspaceInventory({
    resource,
    tools,
    services,
    containers,
    pm2,
    projects,
    scannedAt: Date.now(),
  })
}

function buildWorkspaceInventoryError(result: { stderr?: string; exitCode?: number; errorType?: string; errorCode?: string }) {
  const message = result.stderr?.trim()
    || result.errorCode
    || result.errorType
    || `inventory command failed with exit code ${result.exitCode ?? 'unknown'}`
  return new Error(message)
}

export async function fetchWorkspaceInventory(options: {
  vaultId?: string
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  const { host, resolveAuthSecret } = options
  const result = await runWorkspaceRemoteCommand({
    host,
    resolveAuthSecret,
    command: WORKSPACE_INVENTORY_COMMAND,
    audit: { action: 'probe.inventory', target: 'host inventory' },
    vaultId: options.vaultId,
  })
  if (result.exitCode !== 0) {
    throw buildWorkspaceInventoryError(result)
  }

  return parseWorkspaceInventory([result.stdout, result.stderr].filter(Boolean).join('\n'))
}
