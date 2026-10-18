import { invoke } from '@tauri-apps/api/core'
import type { HostProfile } from './hosts'

export interface WorkspaceToolStatus {
  installed: boolean | null
  path?: string
  version?: string
  serviceActive?: string
  serviceEnabled?: string
  checkedAt?: string
  checkedAtMs?: number
}

export interface WorkspaceToolStatusSnapshot {
  vaultId: string
  hostKey: string
  hostId: string
  hostName: string
  hostAddress: string
  username: string
  port: number
  toolId: string
  toolName: string
  status: WorkspaceToolStatus
  updatedAt: number
}

function toolScope(host: HostProfile, vaultId?: string) {
  const explicit = vaultId?.trim()
  const contextual = host.vaultId?.trim()
  if (explicit && contextual && explicit !== contextual) throw new Error('tool_status_vault_mismatch')
  const vault = explicit || contextual
  // Unscoped browser previews are ephemeral. Never query a global native cache
  // or assign ambiguous legacy observations to whichever vault happens to open.
  return vault && host.id.trim() ? { vaultId: vault, hostId: host.id } : null
}

export function getWorkspaceToolStatusHostKey(host: HostProfile, vaultId?: string) {
  const scope = toolScope(host, vaultId)
  return scope ? `vault:${JSON.stringify([scope.vaultId, scope.hostId])}` : null
}

function isWorkspaceToolStatus(value: unknown): value is WorkspaceToolStatus {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceToolStatus>
  return (record.installed === true || record.installed === false || record.installed === null)
    && (record.path === undefined || typeof record.path === 'string')
    && (record.version === undefined || typeof record.version === 'string')
    && (record.serviceActive === undefined || typeof record.serviceActive === 'string')
    && (record.serviceEnabled === undefined || typeof record.serviceEnabled === 'string')
    && (record.checkedAt === undefined || typeof record.checkedAt === 'string')
    && (record.checkedAtMs === undefined || typeof record.checkedAtMs === 'number')
}

function isWorkspaceToolStatusSnapshot(value: unknown): value is WorkspaceToolStatusSnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceToolStatusSnapshot>
  return typeof record.vaultId === 'string'
    && typeof record.hostKey === 'string'
    && typeof record.hostId === 'string'
    && typeof record.hostName === 'string'
    && typeof record.hostAddress === 'string'
    && typeof record.username === 'string'
    && typeof record.port === 'number'
    && typeof record.toolId === 'string'
    && typeof record.toolName === 'string'
    && isWorkspaceToolStatus(record.status)
    && typeof record.updatedAt === 'number'
}

function toWorkspaceToolStatusSnapshot(
  host: HostProfile,
  tool: { id: string; name: string },
  status: WorkspaceToolStatus,
  updatedAt: number,
  vaultId: string,
): WorkspaceToolStatusSnapshot {
  return {
    vaultId,
    hostKey: getWorkspaceToolStatusHostKey(host, vaultId)!,
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    port: host.port || 22,
    toolId: tool.id,
    toolName: tool.name,
    status,
    updatedAt,
  }
}

export async function loadWorkspaceToolStatusSnapshots(hosts: HostProfile[], vaultId?: string) {
  const next: Record<string, Record<string, WorkspaceToolStatusSnapshot>> = {}
  for (const host of hosts) {
    const scope = toolScope(host, vaultId)
    if (!scope) continue
    const key = getWorkspaceToolStatusHostKey(host, vaultId)!
    const snapshots = await invoke<unknown[]>('list_workspace_tool_statuses', scope)
    for (const snapshot of snapshots) {
      if (!isWorkspaceToolStatusSnapshot(snapshot) || snapshot.vaultId !== scope.vaultId || snapshot.hostId !== scope.hostId || snapshot.hostKey !== key) continue
      next[key] = { ...(next[key] ?? {}), [snapshot.toolId]: snapshot }
    }
  }
  return next
}

export async function loadWorkspaceToolStatuses(host: HostProfile | null | undefined, vaultId?: string) {
  if (!host) return {}
  const key = getWorkspaceToolStatusHostKey(host, vaultId)
  if (!key) return {}
  const snapshotsByHost = await loadWorkspaceToolStatusSnapshots([host], vaultId)
  const hostSnapshots = snapshotsByHost[key] ?? {}
  return Object.entries(hostSnapshots).reduce<Record<string, WorkspaceToolStatus>>((next, [toolId, snapshot]) => {
    next[toolId] = snapshot.status
    return next
  }, {})
}

export async function saveWorkspaceToolStatus(
  host: HostProfile,
  tool: { id: string; name: string },
  status: WorkspaceToolStatus,
  vaultId?: string,
) {
  const scope = toolScope(host, vaultId)
  if (!scope) return null
  const updatedAt = status.checkedAtMs ?? Date.now()
  const payload = toWorkspaceToolStatusSnapshot(host, tool, status, updatedAt, scope.vaultId)
  await invoke<void>('upsert_workspace_tool_status', { payload })
  return payload
}
