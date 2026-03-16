import { ActivityLogPanel } from '@/components/activity-log-panel'
import { BackupRestorePanel } from '@/components/backup-restore-panel'
import { HostKeyConfirmDialog } from '@/components/host-key-confirm-dialog'
import { HostsDashboard } from '@/components/hosts-dashboard'
import { KeychainTab } from '@/components/keychain-tab'
import { KnownHostsPanel } from '@/components/known-hosts-panel'
import { MobileSessionHeader } from '@/components/mobile-session-header'
import { MobileBottomNav, PcNavSidebar } from '@/components/pc-nav-sidebar'
import { PcSessionTabBar } from '@/components/pc-tab-bar'
import { PortForwardPanel } from '@/components/port-forward-panel'
import { QuickConnectPanel } from '@/components/quick-connect-panel'
import { SessionTerminalView } from '@/components/session-terminal-view'
import { SettingsPanel } from '@/components/settings-panel'
import { SftpDualPane } from '@/components/sftp-dual-pane'
import { SnippetPanel } from '@/components/snippet-panel'
import { SyncCenterPanel } from '@/components/sync-center-panel'
import { TerminalRightSidebar } from '@/components/terminal-right-sidebar'
import { useApp } from '@/contexts/app-context'
import { useHosts } from '@/contexts/hosts-context'
import { useSessions } from '@/contexts/sessions-context'
import { useVault } from '@/contexts/vault-context'
import { useSnippets } from '@/hooks/use-snippets'
import { useSync } from '@/hooks/use-sync'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** true when viewport width ≥ 768 px (Tailwind `md` breakpoint) */
function subscribeMediaQuery(cb: () => void) {
  const mql = window.matchMedia('(min-width: 768px)')
  mql.addEventListener('change', cb)
  return () => mql.removeEventListener('change', cb)
}
function getIsMd() { return window.matchMedia('(min-width: 768px)').matches }

export function PcLayout() {
  const { t } = useT()
  const app = useApp()
  const vault = useVault()
  const hostsCtx = useHosts()
  const sessions = useSessions()
  const snippets = useSnippets(vault.activeVaultId, app.setOutput)
  const sync = useSync(app.setOutput, () => {
    void hostsCtx.refreshHosts()
    void snippets.refresh()
    void vault.refreshVault()
  })

  const [, setVaultActiveTab] = useState<string>('hosts')
  const [mobileActiveSessionId, setMobileActiveSessionId] = useState<string | null>(null)
  const [showQuickConnect, setShowQuickConnect] = useState(false)
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => {
    try { return localStorage.getItem('shellbeam.rightSidebar') === 'true' } catch { return false }
  })

  // Auto-switch to terminal tab on mobile when a new session is created
  const prevTabCountRef = useRef(sessions.pcSessionTabs.length)
  useEffect(() => {
    const newCount = sessions.pcSessionTabs.length
    if (newCount > prevTabCountRef.current) {
      // A new session was added — switch mobile to terminal tab and select it
      const newest = sessions.pcSessionTabs[sessions.pcSessionTabs.length - 1]
      if (newest) {
        setMobileActiveSessionId(newest.sessionId)
        app.setPcSidebarNav('terminal')
        setShowQuickConnect(false)
      }
    }
    // If the active mobile session was closed, pick another
    if (mobileActiveSessionId && !sessions.pcSessionTabs.find((t) => t.sessionId === mobileActiveSessionId)) {
      setMobileActiveSessionId(sessions.pcSessionTabs[0]?.sessionId ?? null)
    }
    prevTabCountRef.current = newCount
  }, [sessions.pcSessionTabs, mobileActiveSessionId, app])

  const toggleRightSidebar = useCallback(() => {
    setRightSidebarOpen((v) => {
      const next = !v
      try { localStorage.setItem('shellbeam.rightSidebar', String(next)) } catch {}
      return next
    })
  }, [])

  const handlePcNewConnection = () => {
    sessions.setPcActiveSessionId(null)
    setShowQuickConnect(true)
  }

  const handleQuickConnectHost = (hostId: string) => {
    setShowQuickConnect(false)
    void sessions.handleConnectHost(hostId)
  }

  const handleQuickConnectNewHost = () => {
    setShowQuickConnect(false)
    app.setPcSidebarNav('hosts')
    setVaultActiveTab('hosts')
    hostsCtx.setPcOpenAddHost(true)
  }

  const handleMobileNewConnection = () => {
    setShowQuickConnect(true)
  }

  const handleMobileCloseSession = (sessionId: string) => {
    sessions.handleCloseSessionTab(sessionId)
    if (mobileActiveSessionId === sessionId) {
      const remaining = sessions.pcSessionTabs.filter((t) => t.sessionId !== sessionId)
      setMobileActiveSessionId(remaining[0]?.sessionId ?? null)
    }
  }

  const isSplit = !!sessions.rightPaneSessionId
  const activeWorkspaceMode = sessions.pcActiveSessionId
    ? sessions.workspaceBySession[sessions.pcActiveSessionId]?.mode ?? 'terminal'
    : 'terminal'
  const mobileWorkspaceMode = mobileActiveSessionId
    ? sessions.workspaceBySession[mobileActiveSessionId]?.mode ?? 'terminal'
    : 'terminal'

  const handleToggleSplit = useCallback(() => {
    if (sessions.rightPaneSessionId) {
      sessions.setRightPaneSessionId(null)
    } else {
      const other = sessions.pcSessionTabs.find((t) => t.sessionId !== sessions.pcActiveSessionId)
      if (other) sessions.setRightPaneSessionId(other.sessionId)
    }
  }, [sessions.rightPaneSessionId, sessions.pcActiveSessionId, sessions.pcSessionTabs, sessions.setRightPaneSessionId])

  const handleInitialChunksConsumed = useCallback((sessionId: string) => {
    sessions.setInteractiveChunksBySession((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [sessions.setInteractiveChunksBySession])

  useState(() => { void snippets.refresh(); void sync.refresh() })

  const isMd = useSyncExternalStore(subscribeMediaQuery, getIsMd, () => true)

  return (
    <div className="flex h-full flex-col">
      <HostKeyConfirmDialog
        info={sessions.pendingHostKey}
        onAccept={sessions.acceptPendingHostKey}
        onReject={sessions.rejectPendingHostKey}
      />
      <div className="hidden shrink-0 md:block">
        <PcSessionTabBar
          sessionTabs={sessions.pcSessionTabs}
          activeSessionId={sessions.pcActiveSessionId}
          isDashboard={!sessions.pcActiveSessionId}
          isSplit={isSplit}
          activeMode={activeWorkspaceMode}
          onModeChange={(mode) => {
            const sid = sessions.pcActiveSessionId
            if (sid) sessions.setSessionMode(sid, mode)
          }}
          onSelectSession={(sid) => { sessions.setPcActiveSessionId(sid); setShowQuickConnect(false) }}
          onCloseSession={sessions.handleCloseSessionTab}
          onGoToDashboard={() => { sessions.setPcActiveSessionId(null); setShowQuickConnect(false); app.setPcSidebarNav('hosts') }}
          onOpenLocalTerminal={() => sessions.handleOpenLocalTerminal()}
          onNewConnection={handlePcNewConnection}
          onToggleSplit={handleToggleSplit}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {/* PC Terminal layer - all sessions stay mounted, only active is visible (hidden on mobile) */}
        {sessions.pcSessionTabs.length > 0 && (
          <div className={cn('absolute inset-0 flex', sessions.pcActiveSessionId ? 'z-10' : 'pointer-events-none invisible')}>
            <div className="relative min-w-0 flex-1">
              {sessions.pcSessionTabs.map((tab) => {
                const isActive = tab.sessionId === sessions.pcActiveSessionId
                const isRightPane = isSplit && tab.sessionId === sessions.rightPaneSessionId
                const isVisible = isActive || isRightPane
                return (
                  <div
                    key={tab.sessionId}
                    className={cn(
                      'absolute top-0 bottom-0',
                      !isVisible && 'pointer-events-none invisible',
                      isSplit && isActive && 'left-0 w-1/2 border-r border-border/50',
                      isSplit && isRightPane && 'right-0 w-1/2',
                      !(isSplit && (isActive || isRightPane)) && 'inset-x-0',
                    )}
                  >
                    <SessionTerminalView
                      sessionId={tab.sessionId}
                      session={sessions.interactiveSessions.find((s) => s.sessionId === tab.sessionId) ?? null}
                      hostName={tab.hostName}
                      hostAddress={tab.hostAddress}
                      chunkEmitterRef={sessions.pcChunkEmitterRef}
                      onSendRaw={(data: string) => sessions.sendRaw(tab.sessionId, data)}
                      terminalPrefs={app.terminalPrefs}
                      isReconnecting={sessions.reconnectingSessionIds.has(tab.sessionId)}
                      onReconnect={() => sessions.manualReconnect(tab.sessionId)}
                      visible={isVisible && !!sessions.pcActiveSessionId}
                      onToggleRightSidebar={isActive ? toggleRightSidebar : undefined}
                      rightSidebarOpen={isActive ? rightSidebarOpen : undefined}
                      initialChunks={sessions.interactiveChunksBySession[tab.sessionId]}
                      onInitialChunksConsumed={handleInitialChunksConsumed}
                    />
                  </div>
                )
              })}
            </div>
            {sessions.pcActiveSessionId && (
              <TerminalRightSidebar
                visible={rightSidebarOpen}
                onClose={toggleRightSidebar}
                hostAddress={sessions.pcSessionTabs.find((t) => t.sessionId === sessions.pcActiveSessionId)?.hostAddress ?? ''}
                snippets={snippets.snippets}
                onApplySnippet={(cmd) => {
                  const sid = sessions.pcActiveSessionId
                  if (sid) {
                    sessions.sendRaw(sid, cmd)
                    app.setOutput(t('terminal.snippetPasted'))
                  }
                }}
                onRunSnippet={(cmd) => {
                  const sid = sessions.pcActiveSessionId
                  if (sid) {
                    sessions.sendRaw(sid, cmd + '\n')
                    app.setOutput(t('terminal.snippetPasted'))
                  }
                }}
                terminalPrefs={app.terminalPrefs}
                onTerminalPrefsChange={app.updateTerminalPrefs}
                onSearchToggle={() => {}}
                searchVisible={false}
              />
            )}
          </div>
        )}

        {/* Mobile Terminal layer - shown when nav is 'terminal' on small screens */}
        {!isMd && (
        <div className={cn('absolute inset-0 flex flex-col md:hidden pb-14', app.pcSidebarNav === 'terminal' ? 'z-10' : 'pointer-events-none invisible')}>
          <MobileSessionHeader
            sessionTabs={sessions.pcSessionTabs}
            activeSessionId={mobileActiveSessionId}
            activeMode={mobileWorkspaceMode}
            onModeChange={(mode) => {
              if (mobileActiveSessionId) sessions.setSessionMode(mobileActiveSessionId, mode)
            }}
            onSelectSession={setMobileActiveSessionId}
            onCloseSession={handleMobileCloseSession}
            onNewConnection={handleMobileNewConnection}
            onOpenLocalTerminal={() => sessions.handleOpenLocalTerminal()}
            hosts={hostsCtx.hosts}
            onConnectHost={(hostId) => void sessions.handleConnectHost(hostId)}
          />
          {sessions.pcSessionTabs.length > 0 && (
            <div className="relative min-h-0 flex-1 flex">
              <div className="relative min-w-0 flex-1">
              {sessions.pcSessionTabs.map((tab) => {
                const isActive = tab.sessionId === mobileActiveSessionId
                return (
                  <div
                    key={tab.sessionId}
                    className={cn('absolute inset-0', !isActive && 'pointer-events-none invisible')}
                  >
                    <SessionTerminalView
                      sessionId={tab.sessionId}
                      session={sessions.interactiveSessions.find((s) => s.sessionId === tab.sessionId) ?? null}
                      hostName={tab.hostName}
                      hostAddress={tab.hostAddress}
                      chunkEmitterRef={sessions.pcChunkEmitterRef}
                      onSendRaw={(data: string) => sessions.sendRaw(tab.sessionId, data)}
                      terminalPrefs={app.terminalPrefs}
                      isReconnecting={sessions.reconnectingSessionIds.has(tab.sessionId)}
                      onReconnect={() => sessions.manualReconnect(tab.sessionId)}
                      visible={isActive && app.pcSidebarNav === 'terminal'}
                      initialChunks={sessions.interactiveChunksBySession[tab.sessionId]}
                      onInitialChunksConsumed={handleInitialChunksConsumed}
                      onToggleRightSidebar={isActive ? toggleRightSidebar : undefined}
                      rightSidebarOpen={isActive ? rightSidebarOpen : undefined}
                    />
                  </div>
                )
              })}
              </div>
              {mobileActiveSessionId && (
                <TerminalRightSidebar
                  visible={rightSidebarOpen}
                  onClose={toggleRightSidebar}
                  hostAddress={sessions.pcSessionTabs.find((t) => t.sessionId === mobileActiveSessionId)?.hostAddress ?? ''}
                  snippets={snippets.snippets}
                  onApplySnippet={(cmd) => {
                    if (mobileActiveSessionId) {
                      sessions.sendRaw(mobileActiveSessionId, cmd)
                      app.setOutput(t('terminal.snippetPasted'))
                    }
                  }}
                  onRunSnippet={(cmd) => {
                    if (mobileActiveSessionId) {
                      sessions.sendRaw(mobileActiveSessionId, cmd + '\n')
                      app.setOutput(t('terminal.snippetPasted'))
                    }
                  }}
                  terminalPrefs={app.terminalPrefs}
                  onTerminalPrefsChange={app.updateTerminalPrefs}
                  onSearchToggle={() => {}}
                  searchVisible={false}
                />
              )}
            </div>
          )}
          {/* Mobile QuickConnect overlay */}
          {showQuickConnect && (
            <div className="absolute inset-0 z-20 bg-background">
              <QuickConnectPanel
                hosts={hostsCtx.hosts}
                onConnectHost={(hostId) => { setShowQuickConnect(false); void sessions.handleConnectHost(hostId) }}
                onNewHost={() => { setShowQuickConnect(false); app.setPcSidebarNav('hosts'); hostsCtx.setPcOpenAddHost(true) }}
                onClose={() => setShowQuickConnect(false)}
              />
            </div>
          )}
        </div>
        )}

        {/* Dashboard layer */}
        {!sessions.pcActiveSessionId && (
          <div className={cn(
            'flex h-full',
            app.pcSidebarNav === 'terminal' && 'hidden',
          )}>
            <PcNavSidebar activeNav={app.pcSidebarNav} onNavChange={(nav) => { app.setPcSidebarNav(nav); setShowQuickConnect(false) }} />
            <div className="mobile-safe-pb relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden" style={{ WebkitOverflowScrolling: 'touch' }}>
              {showQuickConnect ? (
                <QuickConnectPanel
                  hosts={hostsCtx.hosts}
                  onConnectHost={handleQuickConnectHost}
                  onNewHost={handleQuickConnectNewHost}
                />
              ) : (
              <>
              {app.pcSidebarNav === 'hosts' && (
                <HostsDashboard
                  hosts={hostsCtx.hosts}
                  selectedHostId={hostsCtx.selectedHostId}
                  loading={hostsCtx.loadingHosts}
                  defaultUsername={hostsCtx.defaultUsername}
                  onSelectHost={hostsCtx.setSelectedHostId}
                  onConnectHost={(hostId) => void sessions.handleConnectHost(hostId)}
                  onCreateHost={hostsCtx.handleCreateHost}
                  onUpdateHost={hostsCtx.handleUpdateHost}
                  onDeleteHost={hostsCtx.handleDeleteHost}
                  openAddForm={hostsCtx.pcOpenAddHost}
                  onAddFormClose={() => hostsCtx.setPcOpenAddHost(false)}
                  externalSearch={hostsCtx.pcTopBarSearch}
                  onExternalSearchChange={hostsCtx.setPcTopBarSearch}
                  onCheckHostStatus={hostsCtx.handleCheckHostStatus}
                  onRefreshHosts={hostsCtx.refreshHosts}
                  vaultKeys={vault.vaultKeys}
                  vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
                  onSaveToVault={hostsCtx.handleSaveToVault}
                  vaultName={vault.vaults.find((v) => v.id === vault.activeVaultId)?.name ?? 'Vault'}
                />
              )}
              {app.pcSidebarNav === 'keychain' && (
                <KeychainTab
                  vaultKeys={vault.vaultKeys}
                  vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
                  vaultBusy={vault.vaultBusy}
                  activeVaultId={vault.activeVaultId}
                  onRefresh={vault.refreshVault}
                  onDeleteSecret={vault.handleDeleteSecret}
                  onOutput={app.setOutput}
                  onError={app.setOutput}
                />
              )}
              {app.pcSidebarNav === 'snippets' && (
                <SnippetPanel
                  snippets={snippets.snippets}
                  selectedSnippetId={snippets.selectedSnippetId}
                  saving={snippets.saving}
                  running={snippets.running}
                  onSelectSnippet={snippets.setSelectedSnippetId}
                  onCreateSnippet={snippets.handleCreate}
                  onUpdateSnippet={snippets.handleUpdate}
                  onDeleteSnippet={snippets.handleDelete}
                  onApplySnippetCommand={(cmd) => {
                    const sid = sessions.pcActiveSessionId
                    if (sid) {
                      sessions.sendRaw(sid, cmd + '\n')
                      app.setOutput(t('terminal.snippetPasted'))
                    } else {
                      app.setCommand(cmd)
                      app.setOutput(t('terminal.snippetCopied'))
                    }
                  }}
                  onRunSnippet={async (id) => {
                    const snippet = snippets.snippets.find((s) => s.id === id)
                    if (!snippet) return
                    const sid = sessions.pcActiveSessionId
                    if (sid) {
                      sessions.sendRaw(sid, snippet.command + '\n')
                      app.setOutput(t('terminal.runningSnippet', { name: snippet.name }))
                    }
                  }}
                />
              )}
              {app.pcSidebarNav === 'port-forwarding' && (
                <PortForwardPanel
                  hosts={hostsCtx.hosts}
                  vaultId={vault.activeVaultId}
                  onOutput={app.setOutput}
                  onError={app.setOutput}
                  resolvePrivateKey={async (hostId) => {
                    const host = hostsCtx.hosts.find((h) => h.id === hostId)
                    if (!host || host.authType !== 'privateKey') return undefined
                    try {
                      return await vault.resolveAuthSecret({
                        authType: 'privateKey', explicitSecret: '', hostForRef: host, inputMode: 'vault',
                      })
                    } catch { return undefined }
                  }}
                />
              )}
              {app.pcSidebarNav === 'known-hosts' && (
                <KnownHostsPanel onOutput={app.setOutput} onError={app.setOutput} />
              )}
              {app.pcSidebarNav === 'sftp' && (
                <div className="absolute inset-0">
                  <SftpDualPane
                    hosts={hostsCtx.hosts}
                    selectedHostId={hostsCtx.selectedHostId}
                    resolveAuthSecret={async (host) => {
                      const secret = await vault.resolveAuthSecret({
                        authType: host.authType, explicitSecret: '', hostForRef: host, inputMode: 'vault',
                      })
                      return secret ?? ''
                    }}
                  />
                </div>
              )}
              {app.pcSidebarNav === 'sync' && (
                <div className="p-6">
                  <SyncCenterPanel
                    localDevice={sync.localDevice}
                    changes={sync.changes}
                    cursors={sync.cursors}
                    trustedPeers={sync.trustedPeers}
                    loading={sync.loading}
                    serverRunning={sync.serverRunning}
                    serverPort={sync.serverPort}
                    onRefresh={sync.refresh}
                    onInitDevice={sync.handleInitDevice}
                    onStartServer={sync.handleStartServer}
                    onPullFromPeer={sync.handlePullFromPeer}
                    onPushToPeer={sync.handlePushToPeer}
                    onRemoveTrustedPeer={sync.handleRemoveTrustedPeer}
                  />
                </div>
              )}
              {app.pcSidebarNav === 'activity' && <ActivityLogPanel />}
              {app.pcSidebarNav === 'backup' && (
                <div className="p-6">
                  <BackupRestorePanel
                    vaultId={vault.activeVaultId}
                    onSuccess={app.setOutput}
                    onError={app.setOutput}
                    onRestoreComplete={() => {
                      void hostsCtx.refreshHosts()
                      void snippets.refresh()
                      void vault.refreshVault()
                      void sync.refresh()
                    }}
                  />
                </div>
              )}
              {app.pcSidebarNav === 'settings' && (
                <SettingsPanel
                  vaultAutoLockMinutes={vault.vaultAutoLockMinutes}
                  reconnectSettings={sessions.reconnectSettings}
                  defaultUsername={hostsCtx.defaultUsername}
                  keepAliveIntervalSecs={hostsCtx.keepAliveIntervalSecs}
                  theme={app.theme}
                  onToggleTheme={app.toggleTheme}
                  terminalPrefs={app.terminalPrefs}
                  onTerminalPrefsChange={app.updateTerminalPrefs}
                  onVaultAutoLockMinutesChange={vault.handleAutoLockMinutesChange}
                  onReconnectSettingsChange={(next) => {
                    sessions.setReconnectSettings((prev) => ({
                      enabled: next.enabled ?? prev.enabled,
                      maxRetries: next.maxRetries !== undefined && !Number.isNaN(next.maxRetries)
                        ? Math.max(0, Math.min(10, Math.floor(next.maxRetries))) : prev.maxRetries,
                      intervalMs: next.intervalMs !== undefined && !Number.isNaN(next.intervalMs)
                        ? Math.max(500, Math.min(15000, Math.floor(next.intervalMs))) : prev.intervalMs,
                    }))
                  }}
                  onDefaultUsernameChange={hostsCtx.handleDefaultUsernameChange}
                  onKeepAliveIntervalSecsChange={hostsCtx.handleKeepAliveIntervalSecsChange}
                />
              )}
              </>
              )}
            </div>
          </div>
        )}
      </div>
      <MobileBottomNav
        activeNav={app.pcSidebarNav}
        sessionCount={sessions.pcSessionTabs.length}
        onNavChange={(nav) => {
          if (nav !== 'terminal') {
            sessions.setPcActiveSessionId(null)
          }
          app.setPcSidebarNav(nav)
        }}
      />
    </div>
  )
}
