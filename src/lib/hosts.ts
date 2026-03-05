import type { AuthType } from '@/lib/ssh'
import { invoke } from '@tauri-apps/api/core'

export type HostGroup = string
export const DEFAULT_GROUPS = ['Production', 'Development', 'Staging', 'Custom'] as const

export interface HostProfile {
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
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  createdAt: number
  updatedAt: number
}

export interface HostProfileDraft {
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
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
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
  if (!normalized.address) errors.push('Host address is required')
  if (!normalized.username) errors.push('Username is required')

  if (!Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535) {
    errors.push('Port must be an integer between 1 and 65535')
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

export async function listHosts(vaultId?: string | null) {
  return invoke<HostProfile[]>('list_hosts', { vaultId: vaultId ?? undefined })
}

export async function createHost(payload: HostProfileDraft, vaultId?: string | null) {
  return invoke<HostProfile>('create_host', { payload: normalizeHostDraft(payload), vaultId: vaultId ?? undefined })
}

export async function updateHost(payload: HostProfile, vaultId?: string | null) {
  return invoke<HostProfile>('update_host', { payload, vaultId: vaultId ?? undefined })
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
