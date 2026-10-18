import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HardDrive } from 'lucide-react'
import { FilePane } from './sftp-file-pane'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string, params?: Record<string, string | number>) => {
    if (key === 'sftpPane.selected') return `${params?.n} selected`
    return key
  } }),
}))

describe('sftp file pane', () => {
  it('renders file list skeleton rows while loading', () => {
    render(
      <FilePane
        title="Local"
        icon={<HardDrive className="h-3.5 w-3.5" />}
        entries={[]}
        currentDir="/Users/demo"
        loading
        selectedPaths={new Set()}
        onDirChange={() => {}}
        onRefresh={() => {}}
        onGoUp={() => {}}
        onEnterDir={() => {}}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onClearSelection={() => {}}
        filter=""
        onFilterChange={() => {}}
      />,
    )

    expect(screen.getByTestId('sftp-file-pane-skeleton')).toBeInTheDocument()
    expect(screen.getAllByTestId('sftp-file-row-skeleton')).toHaveLength(5)
  })

  it('hands the full selected scope to one batch delete action', () => {
    const onDeletePaths = vi.fn()
    const onDelete = vi.fn()
    render(<FilePane title="Remote" icon={<HardDrive />} entries={[
      { path: '/tmp/a', fileName: 'a', isDir: false }, { path: '/tmp/b', fileName: 'b', isDir: false },
    ]} currentDir="/tmp" loading={false} selectedPaths={new Set(['/tmp/a', '/tmp/b'])}
    onDirChange={() => {}} onRefresh={() => {}} onGoUp={() => {}} onEnterDir={() => {}}
    onToggleSelect={() => {}} onSelectAll={() => {}} onClearSelection={() => {}}
    filter="" onFilterChange={() => {}} onDelete={onDelete} onDeletePaths={onDeletePaths} />)
    fireEvent.click(screen.getByTitle('sftpPane.delete'))
    expect(onDeletePaths).toHaveBeenCalledOnce()
    expect(onDeletePaths).toHaveBeenCalledWith(['/tmp/a', '/tmp/b'])
    expect(onDelete).not.toHaveBeenCalled()
  })
})
