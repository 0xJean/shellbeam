import { describe, expect, it } from 'vitest'
import { applyTransferProgress, clearFinishedTransfers, settleTransfers, summarizeTransfers, transferPercent, type SftpTransferItem } from './sftp-transfers'

const item = (id: string, state: SftpTransferItem['state'], extra: Partial<SftpTransferItem> = {}): SftpTransferItem =>
  ({ id, direction: 'upload', fileName: id, route: 'web:/srv', state, ...extra })

describe('sftp transfers', () => {
  it('settles the in-flight item and the untouched rest separately', () => {
    const items = [item('a', 'done'), item('b', 'running'), item('c', 'queued'), item('x', 'queued')]
    expect(settleTransfers(items, ['a', 'b', 'c'], 'failed', 'cancelled').map((i) => i.state)).toEqual(['done', 'failed', 'cancelled', 'queued'])
  })

  it('summarizes, clears finished items and derives percent from native byte counts', () => {
    const items = [item('a', 'done'), item('b', 'failed'), item('c', 'running', { bytesTotal: 200 }), item('d', 'queued')]
    expect(summarizeTransfers(items)).toEqual({ active: 2, done: 1, failed: 1 })
    expect(clearFinishedTransfers(items).map((i) => i.id)).toEqual(['c', 'd'])
    expect(transferPercent(items[2])).toBeNull()
    const startedAt = new Map<string, number>()
    let next = applyTransferProgress(items, { transferId: 'c', phase: 'upload_start', bytesProcessed: 0, bytesTotal: 200, message: '' }, startedAt, 1000)
    next = applyTransferProgress(next, { transferId: 'c', phase: 'upload_progress', bytesProcessed: 100, bytesTotal: 200, message: '' }, startedAt, 2000)
    expect(transferPercent(next[2])).toBe(50)
    expect(next[2].bytesPerSec).toBe(100)
    expect(applyTransferProgress(next, { transferId: 'zzz', phase: 'x', bytesProcessed: 1, message: '' }, startedAt, 3000)).toBe(next)
  })
})
