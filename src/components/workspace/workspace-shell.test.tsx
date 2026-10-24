import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { hostConnectionKey, type HostProfile } from '@/lib/hosts'
import { WorkspaceShell } from './workspace-shell'

vi.mock('@/lib/sessions', () => ({
  runSshCommand: vi.fn(async () => ({
    stdout: 'nginx started',
    stderr: '',
    exitCode: 0,
    durationMs: 12,
  })),
}))

vi.mock('./workspace-file-transfer-app', () => ({
  WorkspaceFileTransferApp: () => <div>Mock File Transfer App</div>,
}))

vi.mock('./workspace-file-system-app', () => ({
  WorkspaceFileSystemApp: () => <div>Mock File System App</div>,
}))

vi.mock('./workspace-tool-manager-app', () => ({
  WorkspaceToolManagerApp: ({ vaultId }: { vaultId?: string }) => <div data-testid="workspace-tool-manager-app" data-vault={vaultId}>Mock Tool Manager App</div>,
}))

vi.mock('./workspace-asset-inventory-app', () => ({
  WorkspaceAssetInventoryApp: ({
    hosts = [],
    onOpenTerminal,
    onEditHost,
  }: {
    hosts?: Array<{ id: string }>
    onOpenTerminal?: (host: { id: string }) => void
    onEditHost?: (host: { id: string }) => void
  }) => (
    <div>
      <button type="button" data-testid="workspace-asset-inventory-app" onClick={() => hosts[0] && onOpenTerminal?.(hosts[0])}>Mock Asset Inventory App</button>
      <button type="button" data-testid="workspace-asset-edit" onClick={() => hosts[0] && onEditHost?.(hosts[0])}>Mock Asset Edit</button>
    </div>
  ),
}))

describe('workspace shell', () => {
  const sessionId = 'session-1'
  it('blocks new operations on an old connection after the default changes or SSH is removed', () => {
    const host: HostProfile = { id: 'h', name: 'WEB', address: 'old.test', port: 22, username: 'ops', authType: 'password', group: 'Custom', tags: [], createdAt: 1, updatedAt: 1 }
    const onOpenTerminal = vi.fn(), onEditHost = vi.fn()
    const props = { sessionId, sessionConnectionKey: hostConnectionKey(host), hostId: host.id, hostName: host.name, hostAddress: host.address, mobile: false, activeApp: 'overview' as const, onSelectApp: vi.fn(), onOpenTerminal, onEditHost }
    const changed = { ...host, address: 'new.test' }
    const { rerender } = render(<WorkspaceShell {...props} hosts={[changed]} />)
    expect(screen.queryByTestId('workspace-desktop-shell')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onOpenTerminal).toHaveBeenCalledWith(changed)
    const pure = { ...host, connections: [], address: '', username: '', port: 0 }
    rerender(<WorkspaceShell {...props} hosts={[pure]} />)
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Configure SSH' }))
    expect(onEditHost).toHaveBeenCalledWith(pure)
  })
  it('renders the desktop shell when mobile is false', () => {
    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-desktop-shell')).toHaveClass('w-full', 'min-w-0', 'flex-1', 'bg-workspace-desktop-wallpaper')
    expect(screen.getByTestId('workspace-desktop-taskbar')).toHaveClass('w-full', 'min-w-0', 'bg-[var(--workspace-surface-900)]')
    expect(screen.getByText('Start')).toBeInTheDocument()
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
  })

  it('renders the mobile shell when mobile is true', () => {
    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByTestId('workspace-mobile-shell')).toHaveClass('bg-workspace-shell')
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /overview/i }).length).toBeGreaterThan(0)
  })

  it('routes app selection through the shared shell callbacks', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: /logs/i })[0])

    expect(onSelectApp).toHaveBeenCalledWith('logs')
  })

  it('lets desktop windows close back to the desktop surface', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="services"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /close services window/i }))

    expect(onSelectApp).toHaveBeenCalledWith('overview')
  })

  it('lets mobile apps return to the home screen', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="fileTransfer"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /back to home screen/i }))

    expect(onSelectApp).toHaveBeenCalledWith('overview')
  })

  it('keeps the file transfer window close action available when file transfer is open', () => {
    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
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

    expect(screen.getByRole('button', { name: /close file transfer window/i })).toBeInTheDocument()
  })

  it('renders the tool manager desktop window when selected', () => {
    render(
      <WorkspaceShell
        sessionId={sessionId}
        activeVaultId="tools-vault"
        mobile={false}
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

    expect(screen.getByTestId('workspace-desktop-window-toolManager')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-manager-app')).toHaveAttribute('data-vault', 'tools-vault')
    expect(screen.getByRole('button', { name: /close tool manager window/i })).toBeInTheDocument()
  })

  it('renders the asset inventory desktop window when selected', () => {
    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
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

    expect(screen.getByTestId('workspace-desktop-window-assetInventory')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-asset-inventory-app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /close vps assets window/i })).toBeInTheDocument()
  })

  it('routes the asset inventory terminal action through the terminal callback', () => {
    const onOpenTerminal = vi.fn()
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

    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        hostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
        activeApp="assetInventory"
        onSelectApp={() => {}}
        onOpenTerminal={onOpenTerminal}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-asset-inventory-app'))

    expect(onOpenTerminal).toHaveBeenCalledWith(host)
  })

  it('routes the asset inventory edit action through the edit callback', () => {
    const onEditHost = vi.fn()
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

    render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        hostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
        activeApp="assetInventory"
        onSelectApp={() => {}}
        onEditHost={onEditHost}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-asset-edit'))

    expect(onEditHost).toHaveBeenCalledWith(host)
  })

  it('renders file transfer, file system, and logs app shells when selected', async () => {
    const { rerender } = render(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="fileTransfer"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getAllByText('File Transfer').length).toBeGreaterThan(0)
    expect(screen.getByText(/scaffolded and ready/i)).toBeInTheDocument()

    rerender(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="fileSystem"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getAllByText('File System').length).toBeGreaterThan(0)
    expect(screen.getByText(/scaffolded and ready/i)).toBeInTheDocument()

    rerender(
      <WorkspaceShell
        sessionId={sessionId}
        mobile={false}
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
        activeApp="logs"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Log Sources')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run journalctl/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('nginx started')).toBeInTheDocument()
    })
  })
})
