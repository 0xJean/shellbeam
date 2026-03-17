import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PcLayout } from './pc-layout'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/activity-log-panel', () => ({ ActivityLogPanel: () => <div /> }))
vi.mock('@/components/backup-restore-panel', () => ({ BackupRestorePanel: () => <div /> }))
vi.mock('@/components/host-key-confirm-dialog', () => ({ HostKeyConfirmDialog: () => <div /> }))
vi.mock('@/components/hosts-dashboard', () => ({ HostsDashboard: () => <div /> }))
vi.mock('@/components/keychain-tab', () => ({ KeychainTab: () => <div /> }))
vi.mock('@/components/known-hosts-panel', () => ({ KnownHostsPanel: () => <div /> }))
vi.mock('@/components/mobile-session-header', () => ({ MobileSessionHeader: () => <div /> }))
vi.mock('@/components/pc-nav-sidebar', () => ({
  MobileBottomNav: () => <div />,
  PcNavSidebar: () => <div />,
}))
vi.mock('@/components/pc-tab-bar', () => ({ PcSessionTabBar: () => <div /> }))
vi.mock('@/components/port-forward-panel', () => ({ PortForwardPanel: () => <div /> }))
vi.mock('@/components/quick-connect-panel', () => ({ QuickConnectPanel: () => <div /> }))
vi.mock('@/components/settings-panel', () => ({ SettingsPanel: () => <div /> }))
vi.mock('@/components/sftp-dual-pane', () => ({ SftpDualPane: () => <div /> }))
vi.mock('@/components/snippet-panel', () => ({ SnippetPanel: () => <div /> }))
vi.mock('@/components/sync-center-panel', () => ({ SyncCenterPanel: () => <div /> }))
vi.mock('@/components/terminal-right-sidebar', () => ({ TerminalRightSidebar: () => <div /> }))
const workspaceShellSpy = vi.fn()

vi.mock('@/components/workspace', () => ({
  WorkspaceShell: (props: { hostName: string; resolveAuthSecret?: (host: { id: string }) => Promise<string> }) => {
    workspaceShellSpy(props)
    return <div data-testid="workspace-shell">{props.hostName}</div>
  },
}))
vi.mock('@/components/session-terminal-view', () => ({
  SessionTerminalView: ({ sessionId, visible }: { sessionId: string; visible?: boolean }) => (
    <div data-testid="terminal-view" data-session-id={sessionId} data-visible={String(visible)}>
      terminal
    </div>
  ),
}))

const useApp = vi.fn()
const useHosts = vi.fn()
const useSessions = vi.fn()
const useVault = vi.fn()
const useSnippets = vi.fn()
const useSync = vi.fn()

vi.mock('@/contexts/app-context', () => ({ useApp: () => useApp() }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => useHosts() }))
vi.mock('@/contexts/sessions-context', () => ({ useSessions: () => useSessions() }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => useVault() }))
vi.mock('@/hooks/use-snippets', () => ({ useSnippets: (...args: unknown[]) => useSnippets(...args) }))
vi.mock('@/hooks/use-sync', () => ({ useSync: (...args: unknown[]) => useSync(...args) }))

describe('pc layout', () => {
  beforeEach(() => {
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
      resolveAuthSecret: vi.fn(async () => 'secret'),
      refreshVault: vi.fn(async () => {}),
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
      handleCheckHostStatus: vi.fn(),
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
    useSessions.mockReturnValue({
      pcSessionTabs: [
        { sessionId: 'session-1', hostName: 'Prod', hostAddress: '10.0.0.8', status: 'connected' },
      ],
      pcActiveSessionId: 'session-1',
      workspaceBySession: {
        'session-1': { mode: 'workspace', activeApp: 'overview' },
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
  })

  it('keeps terminal views mounted while workspace mode is active', () => {
    render(<PcLayout />)

    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
  })

  it('prefers the connected session auth cache for workspace tools', async () => {
    render(<PcLayout />)

    const props = workspaceShellSpy.mock.calls.at(-1)?.[0]
    expect(props).toBeTruthy()

    await expect(props.resolveAuthSecret?.({ id: 'host-1' })).resolves.toBe('cached-secret')
  })
})
