import type { CommandErrorType, CommandRunResult, CommandRunStatus } from '@/lib/sessions'
import { invoke } from '@tauri-apps/api/core'

export interface HistoryEntry {
  id: string
  hostId?: string
  host: string
  command: string
  status: CommandRunStatus
  errorType?: CommandErrorType
  errorCode?: string
  errorSource?: string
  retryable?: boolean
  result: CommandRunResult
  createdAt: number
}

export interface HistoryFilter {
  host?: string
  status?: CommandRunStatus
  errorCode?: string
  retryable?: boolean
  from?: number
  to?: number
}

export function filterHistory(entries: HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
  return entries.filter((entry) => {
    if (filter.host && entry.host !== filter.host) return false
    if (filter.status && entry.status !== filter.status) return false
    if (filter.errorCode && entry.errorCode !== filter.errorCode) return false
    if (typeof filter.retryable === 'boolean' && Boolean(entry.retryable) !== filter.retryable) return false

    if (typeof filter.from === 'number' && entry.createdAt < filter.from) {
      return false
    }

    if (typeof filter.to === 'number' && entry.createdAt > filter.to) {
      return false
    }

    return true
  })
}

export async function listCommandHistory(filter?: HistoryFilter) {
  return invoke<HistoryEntry[]>('list_command_history', { filter })
}
