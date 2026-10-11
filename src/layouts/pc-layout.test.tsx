import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PcLayout } from './pc-layout'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/activity-log-panel', () => ({ ActivityLogPanel: () => <div /> }))
const interactiveTourSpy = vi.fn()
vi.mock('@/components/interactive-tour', () => ({ InteractiveTour: (props: unknown) => { interactiveTourSpy(props); return null } }))
vi.mock('@/components/backup-restore-panel', () => ({ BackupRestorePanel: () => <div /> }))
vi.mock('@/components/host-key-confirm-dialog', () => ({ HostKeyConfirmDialog: () => <div /> }))
vi.mock('@/components/hosts-dashboard', () => ({
  HostsDashboard: ({ headerExtraAction }: { headerExtraAction?: React.ReactNode }) => <div data-testid="hosts-dashboard">{headerExtraAction}</div>,
}))
vi.mock('@/components/keychain-tab', () => ({ KeychainTab: () => <div /> }))
vi.mock('@/components/known-hosts-panel', () => ({ KnownHostsPanel: () => <div /> }))
vi.mock('@/components/mobile-session-header', () => ({ MobileSessionHeader: () => <div /> }))
vi.mock('@/components/pc-nav-sidebar', () => ({
  MobileBottomNav: () => <div />,
  PcNavSidebar: () => <div />,
}))
const pcSessionTabBarSpy = vi.fn()
vi.mock('@/components/pc-tab-bar', () => ({
  PcSessionTabBar: (props: unknown) => {
    pcSessionTabBarSpy(props)
    return <div />
  },
}))
vi.mock('@/components/port-forward-panel', () => ({ PortForwardPanel: () => <div /> }))
vi.mock('@/components/quick-connect-panel', () => ({ QuickConnectPanel: () => <div /> }))
vi.mock('@/components/session-connect-placeholder', () => ({
  SessionConnectPlaceholder: ({ status, errorMessage, onRetry }: { status: string; errorMessage?: string; onRetry?: () => void }) => (
    <button data-testid="session-connect-placeholder" data-status={status} data-error-message={errorMessage ?? ''} onClick={onRetry} />
  ),
}))
vi.mock('@/components/settings-panel', () => ({ SettingsPanel: ({ onOpenGuide }: { onOpenGuide?: () => void }) => <button onClick={onOpenGuide}>Open guide</button> }))
vi.mock('@/components/sftp-dual-pane', () => ({ SftpDualPane: () => <div /> }))
vi.mock('@/components/snippet-panel', () => ({ SnippetPanel: () => <div /> }))
vi.mock('@/components/ssh-import-dialog', () => ({ SshImportDialog: () => <div data-testid="ssh-import-dialog" /> }))
vi.mock('@/components/sync-center-panel', () => ({ SyncCenterPanel: () => <div /> }))
vi.mock('@/components/terminal-right-sidebar', () => ({ TerminalRightSidebar: () => <div /> }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
const workspaceShellSpy = vi.fn()
const browserViewSpy = vi.fn()

vi.mock('@/components/workspace', () => ({
  WorkspaceShell: (props: { hostName: string; resolveAuthSecret?: (host: { id: string }) => Promise<string> }) => {
    workspaceShellSpy(props)
    return <div data-testid="workspace-shell">{props.hostName}</div>
  },
}))

const workspaceAssetInventorySpy = vi.fn()
vi.mock('@/components/workspace/workspace-asset-inventory-app', () => ({
  WorkspaceAssetInventoryApp: (props: {
    hosts?: Array<{ id: string }>
    onOpenTerminal?: (host: { id: string }) => void
    onEditHost?: (host: { id: string }) => void
    onImportSsh?: () => void
    onCreateHost?: () => void
    headerExtraAction?: React.ReactNode
  }) => {
    workspaceAssetInventorySpy(props)
    return (
      <div>
        <button type="button" data-testid="workspace-asset-inventory-app" onClick={() => props.hosts?.[0] && props.onOpenTerminal?.(props.hosts[0])}>
          Asset Inventory
        </button>
        <button type="button" data-testid="workspace-asset-edit" onClick={() => props.hosts?.[0] && props.onEditHost?.(props.hosts[0])}>
          Asset Edit
        </button>
        <button type="button" data-testid="workspace-asset-import" onClick={() => props.onImportSsh?.()}>
          Asset Import
        </button>
        <button type="button" data-testid="workspace-asset-create" onClick={() => props.onCreateHost?.()}>
          Asset Create
        </button>
        {props.headerExtraAction}
      </div>
    )
  },
}))
vi.mock('@/components/browser/browser-view', () => ({
  BrowserView: ({ sessionId, visible, onCloseRequest }: { sessionId: string; visible?: boolean; onCloseRequest?: () => void }) => {
    browserViewSpy({ sessionId, visible, onCloseRequest })
    return <div data-testid="browser-view" data-session-id={sessionId} data-visible={String(visible)} />
  },
}))
const sessionTerminalViewSpy = vi.fn()

vi.mock('@/components/session-terminal-view', () => ({
  SessionTerminalView: ({
    sessionId,
    visible,
    chromeOnly,
    onOpenBrowser,
    onOpenLinkInBrowser,
  }: {
    sessionId: string
    visible?: boolean
    chromeOnly?: boolean
    onOpenBrowser?: () => void
    onOpenLinkInBrowser?: (url: string) => void
  }) => {
    sessionTerminalViewSpy({ sessionId, visible, chromeOnly, onOpenBrowser, onOpenLinkInBrowser })
    return (
      <div
        data-testid="terminal-view"
        data-session-id={sessionId}
        data-visible={String(visible)}
        data-chrome-only={String(chromeOnly)}
      >
        terminal
      </div>
    )
  },
}))

const useApp = vi.fn()
const useHosts = vi.fn()
const useSessions = vi.fn()
const useVault = vi.fn()
const useSnippets = vi.fn()
const useSync = vi.fn()
let defaultSessionsValue: Record<string, unknown>

vi.mock('@/contexts/app-context', () => ({ useApp: () => useApp() }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => useHosts() }))
vi.mock('@/contexts/sessions-context', () => ({ useSessions: () => useSessions() }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => useVault() }))
vi.mock('@/hooks/use-snippets', () => ({ useSnippets: (...args: unknown[]) => useSnippets(...args) }))
vi.mock('@/hooks/use-sync', () => ({ useSync: (...args: unknown[]) => useSync(...args) }))

describe('pc layout', () => {
  beforeEach(() => {
    workspaceShellSpy.mockReset()
    workspaceAssetInventorySpy.mockReset()
    sessionTerminalViewSpy.mockReset()
    pcSessionTabBarSpy.mockReset()
    browserViewSpy.mockReset()
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })

    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'terminal',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useVault.mockReturnValue({
      activeVaultId: 'vault-1',
      vaults: [{ id: 'vault-1', name: 'Vault' }],
      vaultStatusState: { unlocked: false },
      vaultKeys: [],
      vaultBusy: false,
      vaultAutoLockMinutes: 15,
      resolveAuthSecret: vi.fn(async () => 'secret'),
      refreshVault: vi.fn(async () => {}),
      handleDeleteSecret: vi.fn(),
      handleAutoLockMinutesChange: vi.fn(),
    })
    useHosts.mockReturnValue({
      hosts: [],
      refreshHosts: vi.fn(async () => {}),
      setPcOpenAddHost: vi.fn(),
      pcOpenAddHost: false,
      selectedHostId: null,
      setSelectedHostId: vi.fn(),
      loadingHosts: false,
      defaultUsername: 'root',
      keepAliveIntervalSecs: 30,
      handleCreateHost: vi.fn(),
      handleUpdateHost: vi.fn(),
      handleDeleteHost: vi.fn(),
      handleScanHosts: vi.fn(),
      handleSaveToVault: vi.fn(),
      pcTopBarSearch: '',
      setPcTopBarSearch: vi.fn(),
    })
    useSnippets.mockReturnValue({
      snippets: [],
      selectedSnippetId: null,
      saving: false,
      running: false,
      setSelectedSnippetId: vi.fn(),
      refresh: vi.fn(async () => {}),
      handleCreate: vi.fn(),
      handleUpdate: vi.fn(),
      handleDelete: vi.fn(),
    })
    useSync.mockReturnValue({
      refresh: vi.fn(async () => {}),
    })
    defaultSessionsValue = {
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'workspace', activeApp: 'overview' },
      },
      browserBySession: {
        'session-1': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
      },
      interactiveSessions: [
        { sessionId: 'session-1', hostId: 'host-1', status: 'running', username: 'root' },
      ],
      rightPaneSessionId: null,
      reconnectingSessionIds: new Set<string>(),
      workspaceAuthBySession: { 'session-1': 'cached-secret' },
      pcChunkEmitterRef: { current: {} },
      interactiveChunksBySession: { 'session-1': [] },
      setInteractiveChunksBySession: vi.fn(),
      setPcActiveSessionId: vi.fn(),
      setSessionMode: vi.fn(),
      setSessionWorkspaceApp: vi.fn(),
      openSessionBrowserUrl: vi.fn(),
      openSessionBrowserHtml: vi.fn(),
      openSessionBrowserMarkdown: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserPresentation: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      setSessionBrowserError: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
      closeSessionBrowser: vi.fn(),
      handleCloseSessionTab: vi.fn(),
      handleOpenLocalTerminal: vi.fn(),
      setRightPaneSessionId: vi.fn(),
      handleConnectHost: vi.fn(),
      sendRaw: vi.fn(),
      manualReconnect: vi.fn(),
      pendingHostKey: null,
      acceptPendingHostKey: vi.fn(),
      rejectPendingHostKey: vi.fn(),
      retrySessionConnection: vi.fn(),
    }
    useSessions.mockReturnValue(defaultSessionsValue)
  })

  it('opens the guide from settings', async () => {
    const app = { ...useApp(), pcSidebarNav: 'settings' }
    useApp.mockReturnValue(app)
    useSessions.mockReturnValue({ ...defaultSessionsValue, pcActiveSessionId: null })
    render(<PcLayout />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open guide' }))
    expect(app.setPcSidebarNav).toHaveBeenCalledWith('guide')
  })

  it.each([['hosts', 'hosts'], ['monitor', 'asset-inventory'], ['mcp', 'settings']])('routes the %s walkthrough without connecting a session', async (id, route) => {
    const app = { ...useApp(), pcSidebarNav: 'guide' }
    useApp.mockReturnValue(app)
    useSessions.mockReturnValue({ ...defaultSessionsValue, pcActiveSessionId: null })
    const view = render(<PcLayout />)
    fireEvent.click(await screen.findByRole('button', { name: `tour.launch.${id}` }))
    expect(app.setPcSidebarNav).toHaveBeenLastCalledWith(route)
    useApp.mockReturnValue({ ...app, pcSidebarNav: route })
    view.rerender(<PcLayout />)
    expect(interactiveTourSpy).toHaveBeenLastCalledWith(expect.objectContaining({ id, valid: true }))
    expect(defaultSessionsValue.handleConnectHost).not.toHaveBeenCalled()
    expect(defaultSessionsValue.sendRaw).not.toHaveBeenCalled()
    expect(defaultSessionsValue.handleCloseSessionTab).not.toHaveBeenCalled()
    useVault.mockReturnValue({ ...useVault(), activeVaultId: 'another-vault' })
    view.rerender(<PcLayout />)
    expect(interactiveTourSpy).toHaveBeenLastCalledWith(expect.objectContaining({ valid: false }))
  })

  it('routes guide actions to the host form and monitoring without connecting or running commands', async () => {
    const app = { ...useApp(), pcSidebarNav: 'guide' }
    useApp.mockReturnValue(app)
    useSessions.mockReturnValue({ ...defaultSessionsValue, pcActiveSessionId: null })
    render(<PcLayout />)
    fireEvent.click(await screen.findByRole('button', { name: 'guide.hosts.title' }))
    fireEvent.click(screen.getByRole('button', { name: 'guide.addHost' }))
    expect(app.setPcSidebarNav).toHaveBeenLastCalledWith('hosts')
    expect(useHosts().setPcOpenAddHost).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'guide.monitor.title' }))
    fireEvent.click(screen.getByRole('button', { name: 'guide.openAssets' }))
    expect(app.setPcSidebarNav).toHaveBeenLastCalledWith('asset-inventory')
    expect(defaultSessionsValue.handleConnectHost).not.toHaveBeenCalled()
    expect(defaultSessionsValue.sendRaw).not.toHaveBeenCalled()
    expect(defaultSessionsValue.handleCloseSessionTab).not.toHaveBeenCalled()
  })

  it('lets the mobile hosts page scroll clear of the bottom navigation', async () => {
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'hosts',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [],
      pcActiveSessionId: null,
      workspaceBySession: {},
    })

    render(<PcLayout />)

    const hostsDashboard = await screen.findByTestId('hosts-dashboard')
    const hostsPage = hostsDashboard.parentElement
    const scrollContainer = hostsPage?.parentElement

    expect(scrollContainer).toHaveClass('mobile-safe-pb')
    expect(hostsPage).toHaveClass('min-h-full')
    expect(hostsPage).not.toHaveClass('h-full')
    expect(hostsPage).not.toHaveClass('min-h-0')
  })

  it('renders the VPS asset inventory from the top-level sidebar route', () => {
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'asset-inventory',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useHosts.mockReturnValue({
      hosts: [
        {
          id: 'host-1',
          name: 'Production API',
          address: '10.0.0.15',
          port: 22,
          username: 'root',
          group: 'Production',
          authType: 'password',
          tags: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      refreshHosts: vi.fn(async () => {}),
      setPcOpenAddHost: vi.fn(),
      pcOpenAddHost: false,
      selectedHostId: 'host-1',
      setSelectedHostId: vi.fn(),
      loadingHosts: false,
      defaultUsername: 'root',
      keepAliveIntervalSecs: 30,
      handleCreateHost: vi.fn(),
      handleUpdateHost: vi.fn(),
      handleDeleteHost: vi.fn(),
      handleScanHosts: vi.fn(),
      handleSaveToVault: vi.fn(),
      pcTopBarSearch: '',
      setPcTopBarSearch: vi.fn(),
    })
    useVault.mockReturnValue({
      activeVaultId: 'vault-1',
      vaults: [{ id: 'vault-1', name: 'Vault' }],
      vaultStatusState: { unlocked: true },
      vaultKeys: ['prod-password'],
      vaultBusy: false,
      vaultAutoLockMinutes: 15,
      resolveAuthSecret: vi.fn(async () => 'secret'),
      refreshVault: vi.fn(async () => {}),
      handleRevealSecret: vi.fn(async () => 'secret'),
      handleDeleteSecret: vi.fn(),
      handleAutoLockMinutesChange: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [],
      pcActiveSessionId: null,
      workspaceBySession: {},
    })

    render(<PcLayout />)

    expect(screen.getByTestId('workspace-asset-inventory-app')).toBeInTheDocument()
    expect(workspaceAssetInventorySpy).toHaveBeenCalledWith(expect.objectContaining({
      selectedHostId: 'host-1',
      hosts: expect.arrayContaining([expect.objectContaining({ id: 'host-1' })]),
      resolveAuthSecret: expect.any(Function),
      onOpenTerminal: expect.any(Function),
      onOpenProviderConsole: expect.any(Function),
      onEditHost: expect.any(Function),
      onImportSsh: expect.any(Function),
      onCreateHost: expect.any(Function),
    }))
  })

  it('returns from terminal to the last dashboard route', () => {
    const setPcSidebarNav = vi.fn()
    let pcSidebarNav: 'asset-inventory' | 'terminal' = 'asset-inventory'

    useApp.mockImplementation(() => ({
      setOutput: vi.fn(),
      pcSidebarNav,
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    }))

    const { rerender } = render(<PcLayout />)

    pcSidebarNav = 'terminal'
    rerender(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { onGoToDashboard: () => void } | undefined
    act(() => {
      call?.onGoToDashboard()
    })

    expect(setPcSidebarNav).toHaveBeenCalledWith('asset-inventory')
    expect(setPcSidebarNav).not.toHaveBeenCalledWith('hosts')
  })

  it('routes the top-level asset inventory terminal action to the selected host', () => {
    const handleConnectHost = vi.fn()
    const setPcSidebarNav = vi.fn()
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'asset-inventory',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useHosts.mockReturnValue({
      hosts: [
        {
          id: 'host-1',
          name: 'Production API',
          address: '10.0.0.15',
          port: 22,
          username: 'root',
          group: 'Production',
          authType: 'password',
          tags: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      refreshHosts: vi.fn(async () => {}),
      setPcOpenAddHost: vi.fn(),
      pcOpenAddHost: false,
      selectedHostId: 'host-1',
      setSelectedHostId: vi.fn(),
      loadingHosts: false,
      defaultUsername: 'root',
      keepAliveIntervalSecs: 30,
      handleCreateHost: vi.fn(),
      handleUpdateHost: vi.fn(),
      handleDeleteHost: vi.fn(),
      handleScanHosts: vi.fn(),
      handleSaveToVault: vi.fn(),
      pcTopBarSearch: '',
      setPcTopBarSearch: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [],
      pcActiveSessionId: null,
      workspaceBySession: {},
      handleConnectHost,
    })

    render(<PcLayout />)

    fireEvent.click(screen.getByTestId('workspace-asset-inventory-app'))

    expect(setPcSidebarNav).toHaveBeenCalledWith('terminal')
    expect(handleConnectHost).toHaveBeenCalledWith('host-1')
  })

  it('opens the shared host editor from top-level asset inventory and saves through host update', async () => {
    const handleUpdateHost = vi.fn(async () => {})
    const setSelectedHostId = vi.fn()
    const host = {
      id: 'host-1',
      name: 'Production API',
      address: '10.0.0.15',
      port: 22,
      username: 'root',
      group: 'Production',
      authType: 'password' as const,
      passwordKeyRef: 'prod-password',
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    }
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'asset-inventory',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useHosts.mockReturnValue({
      hosts: [host],
      refreshHosts: vi.fn(async () => {}),
      setPcOpenAddHost: vi.fn(),
      pcOpenAddHost: false,
      selectedHostId: 'host-1',
      setSelectedHostId,
      loadingHosts: false,
      defaultUsername: 'root',
      keepAliveIntervalSecs: 30,
      handleCreateHost: vi.fn(),
      handleUpdateHost,
      handleDeleteHost: vi.fn(),
      handleScanHosts: vi.fn(),
      handleSaveToVault: vi.fn(),
      pcTopBarSearch: '',
      setPcTopBarSearch: vi.fn(),
    })
    useVault.mockReturnValue({
      activeVaultId: 'vault-1',
      vaults: [{ id: 'vault-1', name: 'Vault' }],
      vaultStatusState: { unlocked: false },
      vaultKeys: ['prod-password'],
      vaultBusy: false,
      vaultAutoLockMinutes: 15,
      resolveAuthSecret: vi.fn(async () => 'secret'),
      refreshVault: vi.fn(async () => {}),
      handleRevealSecret: vi.fn(async () => 'secret'),
      handleDeleteSecret: vi.fn(),
      handleAutoLockMinutesChange: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [],
      pcActiveSessionId: null,
      workspaceBySession: {},
    })

    render(<PcLayout />)

    fireEvent.click(screen.getByTestId('workspace-asset-edit'))

    expect(screen.getByText('hostForm.editHost')).toBeInTheDocument()
    expect(setSelectedHostId).toHaveBeenCalledWith('host-1')

    fireEvent.change(screen.getByDisplayValue('Production API'), { target: { value: 'Production API Edited' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'hostForm.save' }))
      await Promise.resolve()
    })

    expect(handleUpdateHost).toHaveBeenCalledWith(host, expect.objectContaining({
      name: 'Production API Edited',
      address: '10.0.0.15',
      passwordKeyRef: 'prod-password',
    }))
  })

  it('opens shared host creation and ssh import from the asset inventory header actions', async () => {
    const handleCreateHost = vi.fn(async () => {})
    const refreshHosts = vi.fn(async () => {})
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'asset-inventory',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useHosts.mockReturnValue({
      hosts: [],
      refreshHosts,
      setPcOpenAddHost: vi.fn(),
      pcOpenAddHost: false,
      selectedHostId: null,
      setSelectedHostId: vi.fn(),
      loadingHosts: false,
      defaultUsername: 'root',
      keepAliveIntervalSecs: 30,
      handleCreateHost,
      handleUpdateHost: vi.fn(),
      handleDeleteHost: vi.fn(),
      handleScanHosts: vi.fn(),
      handleSaveToVault: vi.fn(async () => {}),
      pcTopBarSearch: '',
      setPcTopBarSearch: vi.fn(),
    })
    useVault.mockReturnValue({
      activeVaultId: 'vault-1',
      vaults: [{ id: 'vault-1', name: 'Vault' }],
      vaultStatusState: { unlocked: true },
      vaultKeys: [],
      vaultBusy: false,
      vaultAutoLockMinutes: 15,
      resolveAuthSecret: vi.fn(async () => 'secret'),
      refreshVault: vi.fn(async () => {}),
      handleRevealSecret: vi.fn(async () => 'secret'),
      handleDeleteSecret: vi.fn(),
      handleAutoLockMinutesChange: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [],
      pcActiveSessionId: null,
      workspaceBySession: {},
    })

    render(<PcLayout />)

    fireEvent.click(screen.getByTestId('workspace-asset-create'))
    expect(screen.getByText('hostForm.newHost')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-asset-import'))
    expect(screen.getByTestId('ssh-import-dialog')).toBeInTheDocument()
  })

  it('keeps terminal views mounted while workspace mode is active', async () => {
    await act(async () => {
      render(<PcLayout />)
      await Promise.resolve()
    })

    expect(await screen.findByTestId('workspace-shell')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
  })

  it('keeps terminal chrome visible while workspace mode is active', () => {
    render(<PcLayout />)

    expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-chrome-only', 'true')
    expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-visible', 'true')
  })

  it('ignores stale split-pane ids so workspace can use the full surface', () => {
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      rightPaneSessionId: 'missing-session',
    })

    render(<PcLayout />)

    const workspace = screen.getByTestId('workspace-shell')
    const sessionSurface = workspace.parentElement?.parentElement

    expect(sessionSurface).toHaveClass('inset-x-0')
    expect(sessionSurface).not.toHaveClass('w-1/2')
  })

  it('keeps workspace full width even when a valid split-pane partner exists', () => {
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod A', hostAddress: '10.0.0.8', status: 'connected' },
        { sessionId: 'session-2', hostName: 'Prod B', hostAddress: '10.0.0.9', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      rightPaneSessionId: 'session-2',
      workspaceBySession: {
        'session-1': { mode: 'workspace', activeApp: 'overview' },
        'session-2': { mode: 'terminal', activeApp: 'overview' },
      },
      browserBySession: {
        'session-1': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
        'session-2': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
      },
      interactiveSessions: [
        { sessionId: 'session-1', hostId: 'host-1', status: 'running', username: 'root' },
        { sessionId: 'session-2', hostId: 'host-2', status: 'running', username: 'root' },
      ],
    })

    render(<PcLayout />)

    const workspace = screen.getByText('Prod A')
    const sessionSurface = workspace.parentElement?.parentElement
    const tabBarProps = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { isSplit: boolean; onToggleSplit?: () => void } | undefined

    expect(sessionSurface).toHaveClass('inset-x-0')
    expect(sessionSurface).not.toHaveClass('w-1/2')
    expect(tabBarProps?.isSplit).toBe(false)
    expect(tabBarProps?.onToggleSplit).toBeUndefined()
  })

  it('only applies split-pane sizing when both surfaces are terminals', () => {
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod A', hostAddress: '10.0.0.8', status: 'connected' },
        { sessionId: 'session-2', hostName: 'Prod B', hostAddress: '10.0.0.9', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      rightPaneSessionId: 'session-2',
      workspaceBySession: {
        'session-1': { mode: 'terminal', activeApp: 'overview' },
        'session-2': { mode: 'terminal', activeApp: 'overview' },
      },
      browserBySession: {
        'session-1': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
        'session-2': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
      },
      interactiveSessions: [
        { sessionId: 'session-1', hostId: 'host-1', status: 'running', username: 'root' },
        { sessionId: 'session-2', hostId: 'host-2', status: 'running', username: 'root' },
      ],
      interactiveChunksBySession: { 'session-1': [], 'session-2': [] },
    })

    render(<PcLayout />)

    const terminalSurfaces = screen.getAllByTestId('terminal-view').map((view) => view.parentElement?.parentElement)
    const tabBarProps = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { isSplit: boolean; onToggleSplit?: () => void } | undefined

    expect(terminalSurfaces[0]).toHaveClass('left-0')
    expect(terminalSurfaces[0]).toHaveClass('w-1/2')
    expect(terminalSurfaces[1]).toHaveClass('right-0')
    expect(terminalSurfaces[1]).toHaveClass('w-1/2')
    expect(tabBarProps?.isSplit).toBe(true)
    expect(tabBarProps?.onToggleSplit).toEqual(expect.any(Function))
  })

  it('shows a dedicated connection placeholder before the terminal session exists', () => {
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'pending-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connecting' },
      ],
      pcActiveSessionId: 'pending-1',
      interactiveSessions: [],
      interactiveChunksBySession: {},
      workspaceBySession: {},
      browserBySession: {},
    })

    render(<PcLayout />)

    expect(screen.getByTestId('session-connect-placeholder')).toHaveAttribute('data-status', 'connecting')
    expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument()
  })

  it('shows resumable browser sessions on the dashboard and restores browser mode from the card', async () => {
    const setPcActiveSessionId = vi.fn()
    const setSessionBrowserPresentation = vi.fn()
    const setSessionMode = vi.fn()
    const setPcSidebarNav = vi.fn()

    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'hosts',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcActiveSessionId: null,
      browserBySession: {
        'session-1': {
          presentation: 'closed',
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com' },
            addressInput: 'https://example.com',
            currentUrl: 'https://example.com',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: null,
            title: 'Example',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: null,
          title: 'Example',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      setPcActiveSessionId,
      setSessionBrowserPresentation,
      setSessionMode,
    })

    await act(async () => {
      render(<PcLayout />)
      await Promise.resolve()
    })

    const browserOverviewEntry = await screen.findByRole('button', { name: 'browser.overview.title' })
    fireEvent.click(browserOverviewEntry)

    const resumeCard = await screen.findByRole('button', { name: 'browser.overview.resumeSession' })
    expect(screen.getAllByText('browser.overview.title').length).toBeGreaterThan(0)

    fireEvent.click(resumeCard)

    expect(setPcActiveSessionId).toHaveBeenCalledWith('session-1')
    expect(setSessionBrowserPresentation).toHaveBeenCalledWith('session-1', 'embedded')
    expect(setSessionMode).toHaveBeenCalledWith('session-1', 'browser')
    expect(setPcSidebarNav).toHaveBeenCalledWith('terminal')
  })

  it('passes browser session badges into the pc session tab bar', () => {
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com' },
            addressInput: 'https://example.com',
            currentUrl: 'https://example.com',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: 'http://127.0.0.1:8787',
            title: 'Example',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Example',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
    })

    render(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { browserMetaBySession?: unknown } | undefined
    expect(call?.browserMetaBySession).toBeUndefined()
  })

  it('does not expose browser shortcuts in the pc session tab bar', () => {
    localStorage.setItem('shellbeam.browserSwitcherRecentTabIds', JSON.stringify(['session-2:tab-9']))

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
        { sessionId: 'session-2', hostName: 'Stage', hostAddress: '10.0.0.9', status: 'connected' },
      ],
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com' },
            addressInput: 'https://example.com',
            currentUrl: 'https://example.com',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: 'http://127.0.0.1:8787',
            title: 'Example',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Example',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
        'session-2': {
          presentation: 'embedded',
          routeMode: 'local',
          activeTabId: 'tab-9',
          tabs: [
            {
              id: 'tab-9',
              pinned: false,
              source: { kind: 'markdown', markdown: '# Stage notes', title: 'Stage Notes' },
              addressInput: '',
              currentUrl: null,
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: null,
              title: 'Stage Notes',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'markdown', markdown: '# Stage notes', title: 'Stage Notes' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
            {
              id: 'tab-10',
              pinned: false,
              source: { kind: 'url', url: 'https://stage.example.com' },
              addressInput: 'https://stage.example.com',
              currentUrl: 'https://stage.example.com',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: null,
              title: 'Stage Home',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://stage.example.com' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
          ],
          closedTabs: [],
          source: { kind: 'markdown', markdown: '# Stage notes', title: 'Stage Notes' },
          addressInput: '',
          currentUrl: null,
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: null,
          title: 'Stage Notes',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'markdown', markdown: '# Stage notes', title: 'Stage Notes' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      interactiveSessions: [
        { sessionId: 'session-1', hostId: 'host-1', status: 'running', username: 'root' },
        { sessionId: 'session-2', hostId: 'host-2', status: 'running', username: 'root' },
      ],
    })

    render(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as {
      browserMetaBySession?: unknown
      browserSwitcherTabCount?: number
      browserSwitcherSummary?: unknown
      onOpenSessionBrowser?: unknown
      onOpenBrowserSwitcher?: unknown
    } | undefined

    expect(call?.browserMetaBySession).toBeUndefined()
    expect(call?.browserSwitcherTabCount).toBeUndefined()
    expect(call?.browserSwitcherSummary).toBeUndefined()
    expect(call?.onOpenSessionBrowser).toBeUndefined()
    expect(call?.onOpenBrowserSwitcher).toBeUndefined()
  })

  it('restores a specific browser tab from the dashboard browser overview', () => {
    const activateSessionBrowserTab = vi.fn()
    const setPcActiveSessionId = vi.fn()
    const setSessionBrowserPresentation = vi.fn()
    const setSessionMode = vi.fn()
    const setPcSidebarNav = vi.fn()

    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'hosts',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcActiveSessionId: null,
      browserBySession: {
        'session-1': {
          presentation: 'closed',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              pinned: false,
              source: { kind: 'url', url: 'https://example.com' },
              addressInput: 'https://example.com',
              currentUrl: 'https://example.com',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: 'http://127.0.0.1:8787',
              title: 'Example',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://example.com' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
            {
              id: 'tab-2',
              pinned: false,
              source: { kind: 'url', url: 'https://example.com/docs' },
              addressInput: 'https://example.com/docs',
              currentUrl: 'https://example.com/docs',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: 'http://127.0.0.1:8787',
              title: 'Docs',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://example.com/docs' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
          ],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Example',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      activateSessionBrowserTab,
      setPcActiveSessionId,
      setSessionBrowserPresentation,
      setSessionMode,
    })

    render(<PcLayout />)

    fireEvent.click(screen.getByRole('button', { name: 'browser.overview.title' }))

    const docsTabButton = screen
      .getAllByRole('button', { name: 'browser.overview.resumeTab' })
      .find((button) => button.textContent?.includes('Docs'))
    expect(docsTabButton).toBeDefined()
    fireEvent.click(docsTabButton!)

    expect(activateSessionBrowserTab).toHaveBeenCalledWith('session-1', 'tab-2')
    expect(setPcActiveSessionId).toHaveBeenCalledWith('session-1')
    expect(setSessionBrowserPresentation).toHaveBeenCalledWith('session-1', 'embedded')
    expect(setSessionMode).toHaveBeenCalledWith('session-1', 'browser')
    expect(setPcSidebarNav).toHaveBeenCalledWith('terminal')
  })

  it('filters and searches tabs inside the dashboard browser overview', () => {
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'hosts',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcActiveSessionId: null,
      browserBySession: {
        'session-1': {
          presentation: 'closed',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              pinned: false,
              source: { kind: 'url', url: 'https://example.com/docs' },
              addressInput: 'https://example.com/docs',
              currentUrl: 'https://example.com/docs',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: 'http://127.0.0.1:8787',
              title: 'Remote Docs',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://example.com/docs' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
            {
              id: 'tab-2',
              pinned: false,
              source: { kind: 'markdown', markdown: '# Notes', title: 'Local Notes' },
              addressInput: '',
              currentUrl: null,
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: null,
              title: 'Local Notes',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'markdown', markdown: '# Notes', title: 'Local Notes' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
          ],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com/docs' },
          addressInput: 'https://example.com/docs',
          currentUrl: 'https://example.com/docs',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Remote Docs',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com/docs' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
    })

    render(<PcLayout />)

    fireEvent.click(screen.getByRole('button', { name: 'browser.overview.title' }))

    expect(screen.getAllByRole('button', { name: 'browser.overview.resumeTab' })).toHaveLength(2)

    const localScopeButton = screen
      .getAllByRole('button', { name: 'browser.overview.filterScope' })
      .find((button) => button.textContent?.includes('browser.route.local'))
    expect(localScopeButton).toBeDefined()
    fireEvent.click(localScopeButton!)

    const visibleTabButtons = screen.getAllByRole('button', { name: 'browser.overview.resumeTab' })
    expect(visibleTabButtons).toHaveLength(1)
    expect(visibleTabButtons[0]).toHaveTextContent('Local Notes')

    fireEvent.change(screen.getByRole('textbox', { name: 'browser.overview.searchLabel' }), {
      target: { value: 'missing' },
    })

    expect(screen.getByText('browser.overview.noMatches')).toBeInTheDocument()
  })

  it('opens the global browser switcher and jumps to a tab from any page', () => {
    const activateSessionBrowserTab = vi.fn()
    const setPcActiveSessionId = vi.fn()
    const setSessionBrowserPresentation = vi.fn()
    const setSessionMode = vi.fn()
    const setPcSidebarNav = vi.fn()
    const setOutput = vi.fn()

    useApp.mockReturnValue({
      setOutput,
      pcSidebarNav: 'terminal',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcActiveSessionId: 'session-1',
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              pinned: false,
              source: { kind: 'url', url: 'https://example.com' },
              addressInput: 'https://example.com',
              currentUrl: 'https://example.com',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: 'http://127.0.0.1:8787',
              title: 'Home',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://example.com' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
            {
              id: 'tab-2',
              pinned: false,
              source: { kind: 'url', url: 'https://example.com/docs' },
              addressInput: 'https://example.com/docs',
              currentUrl: 'https://example.com/docs',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: 'http://127.0.0.1:8787',
              title: 'Docs',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://example.com/docs' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
          ],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Home',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      activateSessionBrowserTab,
      setPcActiveSessionId,
      setSessionBrowserPresentation,
      setSessionMode,
    })

    render(<PcLayout />)

    fireEvent.keyDown(window, { key: 'B', metaKey: true, shiftKey: true })

    expect(screen.getByRole('textbox', { name: 'browser.switcher.searchLabel' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'browser.switcher.searchLabel' }), {
      target: { value: 'Docs' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'browser.switcher.switchToTab' })[0]!)

    expect(activateSessionBrowserTab).toHaveBeenCalledWith('session-1', 'tab-2')
    expect(setPcActiveSessionId).toHaveBeenCalledWith('session-1')
    expect(setSessionBrowserPresentation).toHaveBeenCalledWith('session-1', 'embedded')
    expect(setSessionMode).toHaveBeenCalledWith('session-1', 'browser')
    expect(setPcSidebarNav).toHaveBeenCalledWith('terminal')
    expect(setOutput).toHaveBeenCalledWith('browser.feedback.tabOpened')
  })

  it('prioritizes recently visited tabs inside the global browser switcher', () => {
    localStorage.setItem('shellbeam.browserSwitcherRecentTabIds', JSON.stringify(['session-2:tab-9']))

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
        { sessionId: 'session-2', hostName: 'Stage', hostAddress: '10.0.0.9', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com' },
            addressInput: 'https://example.com',
            currentUrl: 'https://example.com',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: 'http://127.0.0.1:8787',
            title: 'Home',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Home',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
        'session-2': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-9',
          tabs: [{
            id: 'tab-9',
            pinned: false,
            source: { kind: 'url', url: 'https://stage.example.com/billing' },
            addressInput: 'https://stage.example.com/billing',
            currentUrl: 'https://stage.example.com/billing',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: 'http://127.0.0.1:8788',
            title: 'Billing',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://stage.example.com/billing' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          source: { kind: 'url', url: 'https://stage.example.com/billing' },
          addressInput: 'https://stage.example.com/billing',
          currentUrl: 'https://stage.example.com/billing',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8788',
          title: 'Billing',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://stage.example.com/billing' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      interactiveSessions: [
        { sessionId: 'session-1', hostId: 'host-1', status: 'running', username: 'root' },
        { sessionId: 'session-2', hostId: 'host-2', status: 'running', username: 'root' },
      ],
    })

    render(<PcLayout />)

    fireEvent.keyDown(window, { key: 'B', metaKey: true, shiftKey: true })

    const switcherButtons = screen.getAllByRole('button', { name: 'browser.switcher.switchToTab' })
    expect(switcherButtons[0]).toHaveAttribute('aria-label', 'browser.switcher.switchToTab')
    expect(switcherButtons[0]).toHaveTextContent('Billing')
  })

  it('can close a browser tab directly from the global browser switcher', () => {
    const closeSessionBrowserTab = vi.fn()
    const setOutput = vi.fn()

    useApp.mockReturnValue({
      setOutput,
      pcSidebarNav: 'terminal',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcActiveSessionId: 'session-1',
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              pinned: false,
              source: { kind: 'url', url: 'https://example.com' },
              addressInput: 'https://example.com',
              currentUrl: 'https://example.com',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: 'http://127.0.0.1:8787',
              title: 'Home',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://example.com' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
            {
              id: 'tab-2',
              pinned: false,
              source: { kind: 'url', url: 'https://example.com/docs' },
              addressInput: 'https://example.com/docs',
              currentUrl: 'https://example.com/docs',
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: 'http://127.0.0.1:8787',
              title: 'Docs',
              error: null,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              history: [{ kind: 'url', url: 'https://example.com/docs' }],
              historyIndex: 0,
              sourceRevision: 1,
            },
          ],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Home',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      closeSessionBrowserTab,
    })

    render(<PcLayout />)

    fireEvent.keyDown(window, { key: 'B', metaKey: true, shiftKey: true })
    fireEvent.click(screen.getAllByRole('button', { name: 'browser.switcher.closeTab' })[1]!)

    expect(closeSessionBrowserTab).toHaveBeenCalledWith('session-1', 'tab-2')
    expect(setOutput).toHaveBeenCalledWith('browser.feedback.tabClosed')
  })

  it('can clear a session browser context directly from the global browser switcher', () => {
    const closeSessionBrowser = vi.fn()
    const setSessionMode = vi.fn()
    const setOutput = vi.fn()

    useApp.mockReturnValue({
      setOutput,
      pcSidebarNav: 'terminal',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'browser', activeApp: 'browser' },
      },
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com' },
            addressInput: 'https://example.com',
            currentUrl: 'https://example.com',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: 'http://127.0.0.1:8787',
            title: 'Home',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Home',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      closeSessionBrowser,
      setSessionMode,
    })

    render(<PcLayout />)

    fireEvent.keyDown(window, { key: 'B', metaKey: true, shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'browser.switcher.clearSession' }))

    expect(closeSessionBrowser).toHaveBeenCalledWith('session-1')
    expect(setSessionMode).toHaveBeenCalledWith('session-1', 'terminal')
    expect(setOutput).toHaveBeenCalledWith('browser.feedback.contextClosed')
  })

  it('asks for confirmation before closing a session that still has browser context', () => {
    const handleCloseSessionTab = vi.fn()
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      handleCloseSessionTab,
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com' },
            addressInput: 'https://example.com',
            currentUrl: 'https://example.com',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: 'http://127.0.0.1:8787',
            title: 'Example',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: 'http://127.0.0.1:8787',
          title: 'Example',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
    })

    render(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { onCloseSession: (sessionId: string) => void } | undefined
    act(() => {
      call?.onCloseSession('session-1')
    })

    expect(handleCloseSessionTab).not.toHaveBeenCalled()
    expect(screen.getByText('browser.sessionClose.title')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'browser.sessionClose.confirm' }))

    expect(handleCloseSessionTab).toHaveBeenCalledWith('session-1')
  })

  it('retries a failed placeholder connection in place', () => {
    const retrySessionConnection = vi.fn()
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        {
          sessionId: 'pending-1',
          hostId: 'host-1',
          connectionKind: 'host',
          hostName: 'Prod',
          hostAddress: '10.0.0.8',
          status: 'error',
          errorMessage: 'auth failed',
        },
      ],
      pcActiveSessionId: 'pending-1',
      interactiveSessions: [],
      interactiveChunksBySession: {},
      workspaceBySession: {},
      browserBySession: {},
      retrySessionConnection,
    })

    render(<PcLayout />)
    fireEvent.click(screen.getByTestId('session-connect-placeholder'))

    expect(retrySessionConnection).toHaveBeenCalledWith('pending-1')
  })

  it('falls back to the hosts dashboard when terminal nav has no remaining sessions', () => {
    const setPcSidebarNav = vi.fn()
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'terminal',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [],
      pcActiveSessionId: null,
      interactiveSessions: [],
      interactiveChunksBySession: {},
      workspaceBySession: {},
      browserBySession: {},
    })

    render(<PcLayout />)

    expect(setPcSidebarNav).toHaveBeenCalledWith('hosts')
  })

  it('resumes another browser session instead of leaving the terminal surface blank after closing the active session', () => {
    const setPcSidebarNav = vi.fn()
    const setPcActiveSessionId = vi.fn()
    const activateSessionBrowserTab = vi.fn()
    const setSessionBrowserPresentation = vi.fn()
    const setSessionMode = vi.fn()
    const handleCloseSessionTab = vi.fn()

    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'terminal',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod A', hostAddress: '10.0.0.8', status: 'connected' },
        { sessionId: 'session-2', hostName: 'Prod B', hostAddress: '10.0.0.9', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'terminal', activeApp: 'overview' },
        'session-2': { mode: 'terminal', activeApp: 'overview' },
      },
      browserBySession: {
        'session-1': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
        'session-2': {
          presentation: 'embedded',
          activeTabId: 'browser-tab-2',
          tabs: [{
            id: 'browser-tab-2',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com' },
            addressInput: 'https://example.com',
            currentUrl: 'https://example.com',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: null,
            transportStatus: 'idle',
            title: 'Example',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          routeMode: 'auto',
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: null,
          transportStatus: 'idle',
          title: 'Example',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
      },
      setPcActiveSessionId,
      activateSessionBrowserTab,
      setSessionBrowserPresentation,
      setSessionMode,
      handleCloseSessionTab,
    })

    render(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { onCloseSession: (sessionId: string) => void } | undefined
    act(() => {
      call?.onCloseSession('session-1')
    })

    expect(handleCloseSessionTab).toHaveBeenCalledWith('session-1')
    expect(activateSessionBrowserTab).toHaveBeenCalledWith('session-2', 'browser-tab-2')
    expect(setPcActiveSessionId).toHaveBeenCalledWith('session-2')
    expect(setSessionBrowserPresentation).toHaveBeenCalledWith('session-2', 'embedded')
    expect(setSessionMode).toHaveBeenCalledWith('session-2', 'browser')
    expect(setPcSidebarNav).toHaveBeenCalledWith('terminal')
  })

  it('falls back to another remaining session after confirming close on the active browser session', () => {
    const setPcSidebarNav = vi.fn()
    const setPcActiveSessionId = vi.fn()
    const activateSessionBrowserTab = vi.fn()
    const setSessionBrowserPresentation = vi.fn()
    const setSessionMode = vi.fn()
    const handleCloseSessionTab = vi.fn()

    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'terminal',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod A', hostAddress: '10.0.0.8', status: 'connected' },
        { sessionId: 'session-2', hostName: 'Prod B', hostAddress: '10.0.0.9', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'browser', activeApp: 'browser' },
        'session-2': { mode: 'terminal', activeApp: 'overview' },
      },
      browserBySession: {
        'session-1': {
          presentation: 'embedded',
          activeTabId: 'browser-tab-1',
          tabs: [{
            id: 'browser-tab-1',
            pinned: false,
            source: { kind: 'url', url: 'https://example.com/docs' },
            addressInput: 'https://example.com/docs',
            currentUrl: 'https://example.com/docs',
            resolvedUrl: null,
            resolvedLocalPort: null,
            proxyUrl: null,
            transportStatus: 'idle',
            title: 'Docs',
            error: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            history: [{ kind: 'url', url: 'https://example.com/docs' }],
            historyIndex: 0,
            sourceRevision: 1,
          }],
          closedTabs: [],
          routeMode: 'auto',
          source: { kind: 'url', url: 'https://example.com/docs' },
          addressInput: 'https://example.com/docs',
          currentUrl: 'https://example.com/docs',
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: null,
          transportStatus: 'idle',
          title: 'Docs',
          error: null,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          history: [{ kind: 'url', url: 'https://example.com/docs' }],
          historyIndex: 0,
          sourceRevision: 1,
        },
        'session-2': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
      },
      setPcActiveSessionId,
      activateSessionBrowserTab,
      setSessionBrowserPresentation,
      setSessionMode,
      handleCloseSessionTab,
    })

    render(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { onCloseSession: (sessionId: string) => void } | undefined
    act(() => {
      call?.onCloseSession('session-1')
    })

    expect(screen.getByTestId('dialog-root')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'browser.sessionClose.confirm' }))

    expect(handleCloseSessionTab).toHaveBeenCalledWith('session-1')
    expect(setPcActiveSessionId).toHaveBeenCalledWith('session-2')
    expect(setPcSidebarNav).toHaveBeenCalledWith('terminal')
    expect(activateSessionBrowserTab).not.toHaveBeenCalled()
    expect(setSessionBrowserPresentation).not.toHaveBeenCalled()
    expect(setSessionMode).not.toHaveBeenCalled()
  })

  it('promotes the split-pane partner after closing the active session', () => {
    const setPcSidebarNav = vi.fn()
    const setPcActiveSessionId = vi.fn()
    const handleCloseSessionTab = vi.fn()

    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'terminal',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod A', hostAddress: '10.0.0.8', status: 'connected' },
        { sessionId: 'session-2', hostName: 'Prod B', hostAddress: '10.0.0.9', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      rightPaneSessionId: 'session-2',
      workspaceBySession: {
        'session-1': { mode: 'terminal', activeApp: 'overview' },
        'session-2': { mode: 'terminal', activeApp: 'overview' },
      },
      browserBySession: {
        'session-1': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
        'session-2': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
      },
      setPcActiveSessionId,
      handleCloseSessionTab,
    })

    render(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { onCloseSession: (sessionId: string) => void } | undefined
    act(() => {
      call?.onCloseSession('session-1')
    })

    expect(handleCloseSessionTab).toHaveBeenCalledWith('session-1')
    expect(setPcActiveSessionId).toHaveBeenCalledWith('session-2')
    expect(setPcSidebarNav).toHaveBeenCalledWith('terminal')
  })

  it('immediately falls back to hosts after closing the last active session', () => {
    const setPcSidebarNav = vi.fn()
    const setPcActiveSessionId = vi.fn()
    const handleCloseSessionTab = vi.fn()

    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'terminal',
      setPcSidebarNav,
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })
    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'terminal', activeApp: 'overview' },
      },
      browserBySession: {
        'session-1': { presentation: 'closed', source: null, addressInput: '', currentUrl: null, title: '', error: null, isLoading: false, history: [], historyIndex: -1, sourceRevision: 0 },
      },
      setPcActiveSessionId,
      handleCloseSessionTab,
    })

    render(<PcLayout />)

    const call = pcSessionTabBarSpy.mock.calls.at(-1)?.[0] as { onCloseSession: (sessionId: string) => void } | undefined
    act(() => {
      call?.onCloseSession('session-1')
    })

    expect(handleCloseSessionTab).toHaveBeenCalledWith('session-1')
    expect(setPcActiveSessionId).toHaveBeenCalledWith(null)
    expect(setPcSidebarNav).toHaveBeenCalledWith('hosts')
  })

  it('prefers the connected session auth cache for workspace tools', async () => {
    render(<PcLayout />)

    const props = workspaceShellSpy.mock.calls.at(-1)?.[0]
    expect(props).toBeTruthy()

    await expect(props.resolveAuthSecret?.({ id: 'host-1' })).resolves.toBe('cached-secret')
  })

  it('routes desktop terminal browser opens into the workspace browser app', () => {
    const sessionsValue = useSessions()

    render(<PcLayout />)

    const terminalProps = sessionTerminalViewSpy.mock.calls.at(-1)?.[0]
    expect(terminalProps).toBeTruthy()

    terminalProps.onOpenBrowser?.()

    expect(sessionsValue.setSessionBrowserPresentation).toHaveBeenCalledWith('session-1', 'embedded')
    expect(sessionsValue.setSessionMode).toHaveBeenCalledWith('session-1', 'browser')
  })

  it('routes desktop terminal links into the workspace browser', () => {
    const sessionsValue = useSessions()

    render(<PcLayout />)

    const terminalProps = sessionTerminalViewSpy.mock.calls.at(-1)?.[0]
    expect(terminalProps).toBeTruthy()

    terminalProps.onOpenLinkInBrowser?.('http://localhost:3000')

    expect(sessionsValue.openSessionBrowserUrl).toHaveBeenCalledWith('session-1', 'http://localhost:3000', 'embedded')
    expect(sessionsValue.setSessionMode).toHaveBeenCalledWith('session-1', 'browser')
  })

  it('shows the browser view in full-page mode when browser mode is active', async () => {
    useSessions.mockReturnValue({
      ...useSessions.mock.results[0]?.value,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'browser', activeApp: 'browser' },
      },
      browserBySession: {
        'session-1': { presentation: 'window', source: { kind: 'url', url: 'https://example.com' }, addressInput: 'https://example.com', currentUrl: 'https://example.com', title: 'Example', error: null, isLoading: false, history: [{ kind: 'url', url: 'https://example.com' }], historyIndex: 0, sourceRevision: 1 },
      },
      interactiveSessions: [
        { sessionId: 'session-1', hostId: 'host-1', status: 'running', username: 'root' },
      ],
      rightPaneSessionId: null,
      reconnectingSessionIds: new Set<string>(),
      workspaceAuthBySession: { 'session-1': 'cached-secret' },
      pcChunkEmitterRef: { current: {} },
      interactiveChunksBySession: { 'session-1': [] },
      setInteractiveChunksBySession: vi.fn(),
      setPcActiveSessionId: vi.fn(),
      setSessionMode: vi.fn(),
      setSessionWorkspaceApp: vi.fn(),
      openSessionBrowserUrl: vi.fn(),
      openSessionBrowserHtml: vi.fn(),
      openSessionBrowserMarkdown: vi.fn(),
      setSessionBrowserPresentation: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      setSessionBrowserError: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
      closeSessionBrowser: vi.fn(),
      handleCloseSessionTab: vi.fn(),
      handleOpenLocalTerminal: vi.fn(),
      setRightPaneSessionId: vi.fn(),
      handleConnectHost: vi.fn(),
      sendRaw: vi.fn(),
      manualReconnect: vi.fn(),
      pendingHostKey: null,
      acceptPendingHostKey: vi.fn(),
      rejectPendingHostKey: vi.fn(),
    })

    await act(async () => {
      render(<PcLayout />)
      await Promise.resolve()
    })

    expect(await screen.findByTestId('browser-view')).toHaveAttribute('data-visible', 'true')
  })

  it('returns to terminal when closing the full-page browser view', () => {
    const closeSessionBrowser = vi.fn()
    const setSessionMode = vi.fn()
    const setOutput = vi.fn()

    useApp.mockReturnValue({
      setOutput,
      pcSidebarNav: 'terminal',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...useSessions.mock.results[0]?.value,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'browser', activeApp: 'browser' },
      },
      browserBySession: {
        'session-1': { presentation: 'window', source: { kind: 'url', url: 'https://example.com' }, addressInput: 'https://example.com', currentUrl: 'https://example.com', title: 'Example', error: null, isLoading: false, history: [{ kind: 'url', url: 'https://example.com' }], historyIndex: 0, sourceRevision: 1 },
      },
      closeSessionBrowser,
      setSessionMode,
    })

    render(<PcLayout />)

    const props = browserViewSpy.mock.calls.at(-1)?.[0] as { onCloseRequest?: () => void } | undefined
    act(() => {
      props?.onCloseRequest?.()
    })

    expect(closeSessionBrowser).toHaveBeenCalledWith('session-1')
    expect(setSessionMode).toHaveBeenCalledWith('session-1', 'terminal')
    expect(setOutput).toHaveBeenCalledWith('browser.feedback.contextClosed')
  })

  it('returns workspace browser closes back to overview with feedback', () => {
    const closeSessionBrowser = vi.fn()
    const setSessionWorkspaceApp = vi.fn()
    const setOutput = vi.fn()

    useApp.mockReturnValue({
      setOutput,
      pcSidebarNav: 'terminal',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...defaultSessionsValue,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'workspace', activeApp: 'browser' },
      },
      browserBySession: {
        'session-1': { presentation: 'embedded', source: { kind: 'url', url: 'https://example.com' }, addressInput: 'https://example.com', currentUrl: 'https://example.com', title: 'Example', error: null, isLoading: false, history: [{ kind: 'url', url: 'https://example.com' }], historyIndex: 0, sourceRevision: 1 },
      },
      closeSessionBrowser,
      setSessionWorkspaceApp,
    })

    render(<PcLayout />)

    const props = workspaceShellSpy.mock.calls.at(-1)?.[0] as { onBrowserCloseRequest?: () => void } | undefined
    act(() => {
      props?.onBrowserCloseRequest?.()
    })

    expect(closeSessionBrowser).toHaveBeenCalledWith('session-1')
    expect(setSessionWorkspaceApp).toHaveBeenCalledWith('session-1', 'overview')
    expect(setOutput).toHaveBeenCalledWith('browser.feedback.workspaceClosed')
  })

  it('unmounts the browser view when desktop navigation leaves the terminal surface', () => {
    useApp.mockReturnValue({
      setOutput: vi.fn(),
      pcSidebarNav: 'hosts',
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    })

    useSessions.mockReturnValue({
      ...useSessions.mock.results[0]?.value,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'browser', activeApp: 'browser' },
      },
      browserBySession: {
        'session-1': { presentation: 'window', source: { kind: 'url', url: 'https://example.com' }, addressInput: 'https://example.com', currentUrl: 'https://example.com', title: 'Example', error: null, isLoading: false, history: [{ kind: 'url', url: 'https://example.com' }], historyIndex: 0, sourceRevision: 1 },
      },
    })

    render(<PcLayout />)

    expect(screen.queryByTestId('browser-view')).not.toBeInTheDocument()
  })

  it('restores the browser view after switching from dashboard back to the active session surface', () => {
    const setOutput = vi.fn()
    let pcSidebarNav: 'terminal' | 'hosts' = 'terminal'

    useApp.mockImplementation(() => ({
      setOutput,
      pcSidebarNav,
      setPcSidebarNav: vi.fn(),
      terminalPrefs: {},
      updateTerminalPrefs: vi.fn(),
      setCommand: vi.fn(),
    }))

    useSessions.mockReturnValue({
      ...useSessions.mock.results[0]?.value,
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'browser', activeApp: 'browser' },
      },
      browserBySession: {
        'session-1': { presentation: 'embedded', source: { kind: 'url', url: 'https://example.com' }, addressInput: 'https://example.com', currentUrl: 'https://example.com', title: 'Example', error: null, isLoading: false, history: [{ kind: 'url', url: 'https://example.com' }], historyIndex: 0, sourceRevision: 1 },
      },
    })

    const { rerender } = render(<PcLayout />)
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-visible', 'true')

    pcSidebarNav = 'hosts'
    rerender(<PcLayout />)
    expect(screen.queryByTestId('browser-view')).not.toBeInTheDocument()

    pcSidebarNav = 'terminal'
    rerender(<PcLayout />)
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-visible', 'true')
  })
})
