import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceMobileShell } from './workspace-mobile-shell'

vi.mock('./workspace-file-transfer-app', () => ({
  WorkspaceFileTransferApp: ({ presentation }: { presentation?: string }) => (
    <div data-testid="workspace-file-transfer-app" data-presentation={presentation}>
      file transfer app
    </div>
  ),
}))

vi.mock('./workspace-file-system-app', () => ({
  WorkspaceFileSystemApp: ({ presentation }: { presentation?: string }) => (
    <div data-testid="workspace-file-system-app" data-presentation={presentation}>
      file system app
    </div>
  ),
}))

vi.mock('./workspace-tool-manager-app', () => ({
  WorkspaceToolManagerApp: () => <div data-testid="workspace-tool-manager-app">tool manager app</div>,
}))

vi.mock('./workspace-asset-inventory-app', () => ({
  WorkspaceAssetInventoryApp: () => <div data-testid="workspace-asset-inventory-app">asset inventory app</div>,
}))

describe('workspace mobile shell', () => {
  const sessionId = 'session-1'
  it('renders file apps inside a full-height mobile app frame', () => {
    render(
      <WorkspaceMobileShell
        sessionId={sessionId}
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
        activeApp="fileTransfer"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-mobile-app-frame')).toHaveClass('flex', 'flex-col', 'overflow-hidden')
    expect(screen.getByTestId('workspace-file-transfer-app')).toHaveAttribute('data-presentation', 'mobile')
  })

  it('allows file transfer app fallback by host address without a host id', () => {
    render(
      <WorkspaceMobileShell
        sessionId={sessionId}
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
        activeApp="fileTransfer"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-file-transfer-app')).toBeInTheDocument()
  })

  it('renders the remote file system app in the mobile app frame', () => {
    render(
      <WorkspaceMobileShell
        sessionId={sessionId}
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
        activeApp="fileSystem"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-file-system-app')).toBeInTheDocument()
  })

  it('renders the tool manager app in the mobile app frame', () => {
    render(
      <WorkspaceMobileShell
        sessionId={sessionId}
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
        activeApp="toolManager"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-mobile-app-frame')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-manager-app')).toBeInTheDocument()
  })

  it('renders the asset inventory app in the mobile app frame', () => {
    render(
      <WorkspaceMobileShell
        sessionId={sessionId}
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
        activeApp="assetInventory"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-mobile-app-frame')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-asset-inventory-app')).toBeInTheDocument()
  })

  it('renders the overview dock with the shared workspace mobile material language', () => {
    render(
      <WorkspaceMobileShell
        sessionId={sessionId}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Production API')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /overview/i }).length).toBeGreaterThan(0)
  })
})
