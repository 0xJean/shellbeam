import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceFilesApp } from './workspace-files-app'

vi.mock('@/components/sftp-dual-pane', () => ({
  SftpDualPane: ({ className }: { className?: string }) => (
    <div data-testid="sftp-dual-pane" className={className}>
      mocked sftp
    </div>
  ),
}))

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  group: 'Default',
  authType: 'password' as const,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

describe('workspace files app', () => {
  it('renders full-height chrome-free content inside desktop windows', () => {
    render(
      <div className="h-[640px]">
        <WorkspaceFilesApp
          presentation="window"
          selectedHostId="host-1"
          hosts={[host]}
          resolveAuthSecret={async () => 'secret'}
        />
      </div>,
    )

    expect(screen.queryByText('Remote Files')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-files-app')).toHaveClass('h-full', 'min-h-0')
    expect(screen.getByTestId('sftp-dual-pane')).toHaveClass('h-full', 'min-h-0')
  })

  it('keeps the overview header in panel presentation', () => {
    render(
      <WorkspaceFilesApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByText('Remote Files')).toBeInTheDocument()
  })
})
