import { invoke } from '@tauri-apps/api/core'

export interface ActivityEntry {
  id: string
  event: string
  hostId?: string
  hostName: string
  hostAddress: string
  username?: string
  authType?: string
  detail?: string
  createdAt: number
}

// The activity log is stored per vault; an unset vault means Personal.
export async function appendActivity(params: {
  vaultId: string | undefined
  event: string
  hostId?: string
  hostName: string
  hostAddress: string
  username?: string
  authType?: string
  detail?: string
}) {
  return invoke<void>('append_activity', params)
}

export async function listActivityLog(vaultId: string | undefined) {
  return invoke<ActivityEntry[]>('list_activity_log', { vaultId })
}
