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
  it('shows type icons and where links point, marking broken ones', () => {
    const onEnterDir = vi.fn()
    render(
      <FilePane
        title="Remote" icon={<HardDrive className="h-3.5 w-3.5" />} currentDir="/srv/app" loading={false} selectedPaths={new Set()}
        entries={[
          { path: '/srv/app/current', fileName: 'current', isDir: true, isSymlink: true, linkTarget: 'releases/2026-10-23' },
          { path: '/srv/app/gone', fileName: 'gone', isDir: false, isSymlink: true, linkTarget: 'missing', linkBroken: true },
          { path: '/srv/app/deploy.sh', fileName: 'deploy.sh', isDir: false, size: 10 },
        ]}
        onDirChange={() => {}} onRefresh={() => {}} onGoUp={() => {}} onEnterDir={onEnterDir} onToggleSelect={() => {}}
        onSelectAll={() => {}} onClearSelection={() => {}} filter="" onFilterChange={() => {}}
      />,
    )
    expect(screen.getByText('→ releases/2026-10-23')).toBeInTheDocument()
    expect(screen.getByText('sftpPane.linkBroken', { exact: false })).toBeInTheDocument()
    const icons = Array.from(document.querySelectorAll('[data-file-icon]')).map((node) => node.getAttribute('data-file-icon'))
    expect(icons).toEqual(expect.arrayContaining(['folder', 'console']))
    fireEvent.doubleClick(screen.getByText('current'))
    expect(onEnterDir).toHaveBeenCalledWith('/srv/app/current')
  })
})
