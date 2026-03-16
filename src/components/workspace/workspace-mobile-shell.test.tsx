import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceMobileShell } from './workspace-mobile-shell'

vi.mock('./workspace-files-app', () => ({
  WorkspaceFilesApp: ({ presentation }: { presentation?: string }) => (
    <div data-testid="workspace-files-app" data-presentation={presentation}>
      files app
    </div>
  ),
}))

describe('workspace mobile shell', () => {
  it('renders file apps inside a full-height mobile app frame', () => {
    render(
      <WorkspaceMobileShell
        hostName="Production API"
        hostAddress="10.0.0.15"
        hostId="host-1"
        hosts={[
          {
            id: 'host-1',
            name: 'Production API',
            address: '10.0.0.15',
            port: 22,
            username: 'root',
            group: 'Default',
            authType: 'password',
            tags: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ]}
        resolveAuthSecret={async () => 'secret'}
        activeApp="files"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-mobile-app-frame')).toHaveClass('flex', 'h-full', 'min-h-0', 'flex-col')
    expect(screen.getByTestId('workspace-mobile-app-content')).toHaveClass('min-h-0', 'flex-1')
    expect(screen.getByTestId('workspace-files-app')).toHaveAttribute('data-presentation', 'mobile')
  })

  it('allows files app fallback by host address without a host id', () => {
    render(
      <WorkspaceMobileShell
        hostName="Production API"
        hostAddress="10.0.0.15"
        hosts={[
          {
            id: 'host-1',
            name: 'Production API',
            address: '10.0.0.15',
            port: 22,
            username: 'root',
            group: 'Default',
            authType: 'password',
            tags: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ]}
        resolveAuthSecret={async () => 'secret'}
        activeApp="files"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-files-app')).toBeInTheDocument()
  })
})
