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

export async function appendActivity(params: {
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

export async function listActivityLog() {
  return invoke<ActivityEntry[]>('list_activity_log')
}
