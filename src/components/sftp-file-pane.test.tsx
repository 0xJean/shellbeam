import { render, screen } from '@testing-library/react'
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
})
