import { DEFAULT_VAULT_ID } from './vaults'
import type { AuthType } from '@/lib/ssh'
import { invoke } from '@tauri-apps/api/core'

export type HostGroup = string
export const DEFAULT_GROUPS = ['Production', 'Development', 'Staging', 'Custom'] as const

export interface ConnectionProfile {
  id: string
  label: string
  address: string
  port: number
  username: string
  authType: AuthType
  secretKeyRef?: string
  passwordKeyRef?: string
  privateKeyRef?: string
  jumpHostId?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
}

export interface HostProfile {
  /** Absent means a legacy single connection; [] explicitly means no SSH. */
  connections?: ConnectionProfile[] | null
  defaultConnectionId?: string | null
  /** Runtime Vault scope supplied by the native host registry. */
  vaultId?: string
  id: string
  name: string
  address: string
  port: number
  username: string
  group: HostGroup
  authType: AuthType
  secretKeyRef?: string
  passwordKeyRef?: string
  privateKeyRef?: string
  tags: string[]
  jumpHostId?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  createdAt: number
  updatedAt: number
}

export interface HostProfileDraft {
  connections?: ConnectionProfile[] | null
  defaultConnectionId?: string | null
  name: string
  address: string
  port: number
  username: string
  group?: HostGroup
  authType: AuthType
  secretKeyRef?: string
  passwordKeyRef?: string
  privateKeyRef?: string
  tags?: string[]
  jumpHostId?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
}

/** Stable projection for legacy rows. Never derive a connection ID from its address. */
export function hostConnections(host: Partial<HostProfile>): ConnectionProfile[] {
  if (host.connections) return host.connections
  if (!host.address?.trim()) return []
  return [{ id: host.id ?? 'primary', label: 'SSH', address: host.address, port: host.port ?? 22,
    username: host.username ?? '', authType: host.authType ?? 'password', secretKeyRef: host.secretKeyRef,
    passwordKeyRef: host.passwordKeyRef, privateKeyRef: host.privateKeyRef,
    jumpHostId: host.jumpHostId, jumpHost: host.jumpHost, jumpPort: host.jumpPort, jumpUser: host.jumpUser }]
}

export function hasSshConnection(host: Pick<HostProfile, 'address' | 'username' | 'port' | 'connections'>): boolean {
  return host.connections?.length !== 0 && !!host.address.trim() && !!host.username.trim() && host.port > 0
}

/** The host ID, metadata and histories never change when switching a default. */
export function withHostConnections(host: HostProfileDraft, connections: ConnectionProfile[], defaultId?: string | null): HostProfileDraft {
  const selected = connections.find(connection => connection.id === defaultId)
  if (connections.length && !selected) throw new Error('HOST_DEFAULT_CONNECTION_REQUIRED')
  return { ...host, connections, defaultConnectionId: selected?.id ?? null,
    address: selected?.address ?? '', port: selected?.port ?? 0, username: selected?.username ?? '',
    authType: selected?.authType ?? 'password', secretKeyRef: selected?.secretKeyRef,
    passwordKeyRef: selected?.passwordKeyRef, privateKeyRef: selected?.privateKeyRef,
    jumpHostId: selected?.jumpHostId, jumpHost: selected?.jumpHost, jumpPort: selected?.jumpPort, jumpUser: selected?.jumpUser }
}

/** Connection references only, never secret values; kept on live sessions to
 * prevent Workspace/reconnect from silently switching to a different default. */
export function hostConnectionKey(host: HostProfile): string {
  return JSON.stringify([host.defaultConnectionId ?? (host.connections == null ? host.id : null), host.address, host.port, host.username, host.authType,
    host.secretKeyRef ?? null, host.passwordKeyRef ?? null, host.privateKeyRef ?? null,
    host.jumpHostId ?? null, host.jumpHost ?? null, host.jumpPort ?? null, host.jumpUser ?? null])
}

export interface HostValidationResult {
  isValid: boolean
  errors: string[]
}

export function normalizeHostDraft(draft: HostProfileDraft): HostProfileDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    address: draft.address.trim(),
    username: draft.username.trim(),
    secretKeyRef: draft.secretKeyRef?.trim() || undefined,
    passwordKeyRef: draft.passwordKeyRef?.trim() || undefined,
    privateKeyRef: draft.privateKeyRef?.trim() || undefined,
    group: draft.group ?? 'Custom',
    tags: (draft.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
  }
}

export function validateHostDraft(draft: HostProfileDraft): HostValidationResult {
  const normalized = normalizeHostDraft(draft)
  const errors: string[] = []

  if (!normalized.name) errors.push('Host name is required')
  if (normalized.connections) {
    if (normalized.connections.length > 16 || new Set(normalized.connections.map(c => c.id)).size !== normalized.connections.length) errors.push('HOST_CONNECTION_INVALID')
    if (normalized.connections.length && !normalized.connections.some(c => c.id === normalized.defaultConnectionId)) errors.push('HOST_DEFAULT_CONNECTION_REQUIRED')
    for (const c of normalized.connections) {
      if (!c.id || !c.label.trim()) errors.push('HOST_CONNECTION_INVALID')
      errors.push(...validateHostDraft({ ...c, name: c.label }).errors)
    }
    return { isValid: errors.length === 0, errors }
  }
  if (!normalized.address) errors.push('Host address is required')
  if (!normalized.username) errors.push('Username is required')

  if (!Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535) {
    errors.push('Port must be an integer between 1 and 65535')
  }

  if (normalized.authType === 'password' && !normalized.passwordKeyRef && !normalized.secretKeyRef) {
    errors.push('Password or vault key reference is required')
  }
  if (normalized.authType === 'privateKey' && !normalized.privateKeyRef && !normalized.secretKeyRef) {
    errors.push('Private key or vault key reference is required')
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

export async function listHosts(vaultId?: string | null) {
  const hosts = await invoke<HostProfile[]>('list_hosts', { vaultId: vaultId ?? undefined })
  return hosts.map((host) => ({ ...host, vaultId: vaultId ?? DEFAULT_VAULT_ID }))
}

export async function createHost(payload: HostProfileDraft, vaultId?: string | null) {
  const host = await invoke<HostProfile>('create_host', { payload: normalizeHostDraft(payload), vaultId: vaultId ?? undefined })
  return { ...host, vaultId: vaultId ?? DEFAULT_VAULT_ID }
}

export async function updateHost(payload: HostProfile, vaultId?: string | null) {
  const host = await invoke<HostProfile>('update_host', { payload, vaultId: vaultId ?? undefined })
  return { ...host, vaultId: vaultId ?? DEFAULT_VAULT_ID }
}

export async function deleteHost(id: string, vaultId?: string | null) {
  return invoke<void>('delete_host', { id, vaultId: vaultId ?? undefined })
}

export interface SshConfigEntry {
  alias: string
  hostName: string | null
  port: number | null
  user: string | null
  identityFile: string | null
  proxyJump: string | null
}

export async function parseSshConfig() {
  return invoke<SshConfigEntry[]>('parse_ssh_config')
}
