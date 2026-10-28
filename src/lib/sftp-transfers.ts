import { listen } from '@tauri-apps/api/event'
import type { SftpTransferProgressEvent } from './sftp'

export type SftpTransferDirection = 'upload' | 'download'
export type SftpTransferState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface SftpTransferItem {
  id: string
  direction: SftpTransferDirection
  fileName: string
  route: string
  state: SftpTransferState
  bytesTotal?: number
  bytesDone?: number
  bytesPerSec?: number
}

export const SFTP_TRANSFER_PROGRESS_EVENT = 'sftp-transfer-progress'

export function formatBytes(bytes?: number) {
  if (bytes == null) return '-'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function newTransferId(direction: SftpTransferDirection) {
  return `${direction}-${crypto.randomUUID()}`
}

export function isTransferActive(item: SftpTransferItem) {
  return item.state === 'queued' || item.state === 'running'
}

export function patchTransfers(items: SftpTransferItem[], ids: Iterable<string>, patch: Partial<SftpTransferItem> | ((item: SftpTransferItem) => Partial<SftpTransferItem>)) {
  const targets = new Set(ids)
  return items.map((item) => targets.has(item.id) ? { ...item, ...(typeof patch === 'function' ? patch(item) : patch) } : item)
}

/** Settles a batch after it returns or throws: the item in flight takes `runningState`, untouched ones `queuedState`. */
export function settleTransfers(items: SftpTransferItem[], ids: Iterable<string>, runningState: SftpTransferState, queuedState: SftpTransferState) {
  return patchTransfers(items, ids, (item) => item.state === 'running' ? { state: runningState }
    : item.state === 'queued' ? { state: queuedState } : {})
}

export function clearFinishedTransfers(items: SftpTransferItem[]) {
  return items.filter(isTransferActive)
}

export function summarizeTransfers(items: SftpTransferItem[]) {
  return {
    active: items.filter(isTransferActive).length,
    done: items.filter((item) => item.state === 'done').length,
    failed: items.filter((item) => item.state === 'failed').length,
  }
}

export function transferPercent(item: SftpTransferItem) {
  if (item.state === 'done') return 100
  if (!item.bytesTotal || item.bytesDone == null) return item.state === 'running' ? null : 0
  return Math.min(100, Math.round(item.bytesDone / item.bytesTotal * 100))
}

/** Applies a native progress event; `startedAt` keeps the first event time per transfer for throughput. */
export function applyTransferProgress(items: SftpTransferItem[], event: SftpTransferProgressEvent, startedAt: Map<string, number>, now: number) {
  if (!items.some((item) => item.id === event.transferId)) return items
  if (!startedAt.has(event.transferId)) startedAt.set(event.transferId, now)
  const elapsed = (now - (startedAt.get(event.transferId) ?? now)) / 1000
  return patchTransfers(items, [event.transferId], (item) => ({
    bytesDone: event.bytesProcessed,
    bytesTotal: event.bytesTotal ?? item.bytesTotal,
    bytesPerSec: elapsed > 0.2 ? event.bytesProcessed / elapsed : item.bytesPerSec,
  }))
}

export function listenToSftpTransferProgress(handler: (event: SftpTransferProgressEvent) => void) {
  return listen<SftpTransferProgressEvent>(SFTP_TRANSFER_PROGRESS_EVENT, (event) => handler(event.payload))
}
