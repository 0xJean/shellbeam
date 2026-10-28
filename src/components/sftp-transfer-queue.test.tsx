import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SftpTransferQueue } from './sftp-transfer-queue'

vi.mock('@/lib/i18n', () => ({ useT: () => ({ t: (key: string) => key, locale: 'zh-CN' }) }))

describe('sftp transfer queue', () => {
  it('lists real transfer states and clears only finished items', () => {
    const onClear = vi.fn()
    render(<SftpTransferQueue onClearFinished={onClear} items={[
      { id: '1', direction: 'upload', fileName: 'release.tar.gz', route: 'web:/opt/app', state: 'running', bytesTotal: 1000, bytesDone: 640 },
      { id: '2', direction: 'upload', fileName: 'compose.yml', route: 'web:/opt/app', state: 'queued' },
      { id: '3', direction: 'download', fileName: 'access.log', route: 'web:/var/log', state: 'done', bytesTotal: 2048 },
    ]} />)
    expect(screen.getByText('传输队列')).toBeVisible()
    expect(screen.getByText('2 个进行中 · 1 个已完成')).toBeVisible()
    expect(screen.getByText('64%')).toBeVisible()
    expect(screen.getByText('排队中')).toBeVisible()
    expect(screen.getByText('完成 · 2.0 KB')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '清除已完成' }))
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('disables clearing when nothing has finished', () => {
    render(<SftpTransferQueue onClearFinished={() => {}} items={[]} />)
    expect(screen.getByText('还没有传输任务')).toBeVisible()
    expect(screen.getByRole('button', { name: '清除已完成' })).toBeDisabled()
  })
})
