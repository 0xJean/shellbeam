import { invoke } from '@tauri-apps/api/core'
import type { HostProfile } from './hosts'
import { getWorkspaceInventoryHostKey } from './workspace-inventory'

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

async function invokeWorkspaceToolStatusCommand<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args)
  } catch {
    return null
  }
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
  return typeof record.hostKey === 'string'
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
): WorkspaceToolStatusSnapshot {
  return {
    hostKey: getWorkspaceInventoryHostKey(host),
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

export async function loadWorkspaceToolStatusSnapshots(hosts: HostProfile[]) {
  const snapshots = await invokeWorkspaceToolStatusCommand<unknown[]>('list_workspace_tool_statuses')
  if (!snapshots) return {}

  const hostKeys = new Set(hosts.map(getWorkspaceInventoryHostKey))
  return snapshots.reduce<Record<string, Record<string, WorkspaceToolStatusSnapshot>>>((next, snapshot) => {
    if (!isWorkspaceToolStatusSnapshot(snapshot)) return next
    if (!hostKeys.has(snapshot.hostKey)) return next
    next[snapshot.hostKey] = {
      ...(next[snapshot.hostKey] ?? {}),
      [snapshot.toolId]: snapshot,
    }
    return next
  }, {})
}

export async function loadWorkspaceToolStatuses(host: HostProfile | null | undefined) {
  if (!host) return {}
  const snapshotsByHost = await loadWorkspaceToolStatusSnapshots([host])
  const hostSnapshots = snapshotsByHost[getWorkspaceInventoryHostKey(host)] ?? {}
  return Object.entries(hostSnapshots).reduce<Record<string, WorkspaceToolStatus>>((next, [toolId, snapshot]) => {
    next[toolId] = snapshot.status
    return next
  }, {})
}

export async function saveWorkspaceToolStatus(
  host: HostProfile,
  tool: { id: string; name: string },
  status: WorkspaceToolStatus,
) {
  const updatedAt = status.checkedAtMs ?? Date.now()
  const payload = toWorkspaceToolStatusSnapshot(host, tool, status, updatedAt)
  await invokeWorkspaceToolStatusCommand<void>('upsert_workspace_tool_status', { payload })
  return payload
}
