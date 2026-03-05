import { useCallback, useState } from 'react'
import { useT } from '@/lib/i18n'
import { useApp } from '@/contexts/app-context'
import { useVault } from '@/contexts/vault-context'
import { useHosts } from '@/contexts/hosts-context'
import { useSessions } from '@/contexts/sessions-context'
import { useSnippets } from '@/hooks/use-snippets'
import { useSync } from '@/hooks/use-sync'
import { PcSessionTabBar } from '@/components/pc-tab-bar'
import { PcNavSidebar, MobileBottomNav } from '@/components/pc-nav-sidebar'
import { SessionTerminalView } from '@/components/session-terminal-view'
import { HostsDashboard } from '@/components/hosts-dashboard'
import { VaultsDashboardPanel, type VaultTab } from '@/components/vaults-dashboard-panel'
import { SnippetPanel } from '@/components/snippet-panel'
import { PortForwardPanel } from '@/components/port-forward-panel'
import { KnownHostsPanel } from '@/components/known-hosts-panel'
import { SftpDualPane } from '@/components/sftp-dual-pane'
import { SyncCenterPanel } from '@/components/sync-center-panel'
import { BackupRestorePanel } from '@/components/backup-restore-panel'
import { SettingsPanel } from '@/components/settings-panel'
import { ActivityLogPanel } from '@/components/activity-log-panel'
import { HostKeyConfirmDialog } from '@/components/host-key-confirm-dialog'
import { TerminalRightSidebar } from '@/components/terminal-right-sidebar'
import { cn } from '@/lib/utils'

export function PcLayout() {
  const { t } = useT()
  const app = useApp()
  const vault = useVault()
  const hostsCtx = useHosts()
  const sessions = useSessions()
  const snippets = useSnippets(vault.activeVaultId, app.setOutput)
  const sync = useSync(app.setOutput)

  const [, setVaultActiveTab] = useState<VaultTab>('hosts')
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => {
    try { return localStorage.getItem('shellbeam.rightSidebar') === 'true' } catch { return false }
  })

  const toggleRightSidebar = useCallback(() => {
    setRightSidebarOpen((v) => {
      const next = !v
      try { localStorage.setItem('shellbeam.rightSidebar', String(next)) } catch {}
      return next
    })
  }, [])

  const handlePcNewConnection = () => {
    sessions.setPcActiveSessionId(null)
    app.setPcSidebarNav('hosts')
    setVaultActiveTab('hosts')
    hostsCtx.setPcOpenAddHost(true)
  }

  const isSplit = !!sessions.rightPaneSessionId

  const handleToggleSplit = useCallback(() => {
    if (sessions.rightPaneSessionId) {
      sessions.setRightPaneSessionId(null)
    } else {
      const other = sessions.pcSessionTabs.find((t) => t.sessionId !== sessions.pcActiveSessionId)
      if (other) sessions.setRightPaneSessionId(other.sessionId)
    }
  }, [sessions.rightPaneSessionId, sessions.pcActiveSessionId, sessions.pcSessionTabs, sessions.setRightPaneSessionId])

  useState(() => { void snippets.refresh(); void sync.refresh() })

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
          onSelectSession={(sid) => sessions.setPcActiveSessionId(sid)}
          onCloseSession={sessions.handleCloseSessionTab}
          onGoToDashboard={() => sessions.setPcActiveSessionId(null)}
          onOpenLocalTerminal={() => sessions.handleOpenLocalTerminal()}
          onNewConnection={handlePcNewConnection}
          onToggleSplit={handleToggleSplit}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {/* Terminal layer - all sessions stay mounted, only active is visible */}
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
        {/* Dashboard layer */}
        {!sessions.pcActiveSessionId && (
          <div className="flex h-full">
            <PcNavSidebar activeNav={app.pcSidebarNav} onNavChange={app.setPcSidebarNav} />
            <div className="mobile-safe-pb relative min-h-0 min-w-0 flex-1 overflow-auto">
              {app.pcSidebarNav === 'hosts' && (
                <HostsDashboard
                  hosts={hostsCtx.hosts}
                  selectedHostId={hostsCtx.selectedHostId}
                  loading={hostsCtx.loadingHosts}
                  defaultUsername={hostsCtx.defaultUsername}
                  onSelectHost={hostsCtx.setSelectedHostId}
                  onConnectHost={(hostId) => void sessions.handleConnectHost(hostId)}
                  onCreateHost={hostsCtx.handleCreateHost}
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
                <VaultsDashboardPanel
                  activeVaultId={vault.activeVaultId}
                  vaults={vault.vaults}
                  vaultStatusState={vault.vaultStatusState}
                  vaultKeys={vault.vaultKeys}
                  vaultBusy={vault.vaultBusy}
                  autoLockMinutes={vault.vaultAutoLockMinutes}
                  lastActivityAt={vault.vaultLastActivityAt}
                  securityEvents={vault.securityEvents}
                  onSwitchVault={vault.setActiveVaultId}
                  onInitialize={vault.handleInitialize}
                  onUnlock={vault.handleUnlock}
                  onLock={vault.handleLock}
                  onAutoLockMinutesChange={vault.handleAutoLockMinutesChange}
                  onRefresh={vault.refreshVault}
                  onRefreshVaults={vault.refreshVaults}
                  onSaveSecret={vault.handleSaveSecret}
                  onLoadSecret={vault.handleLoadSecret}
                  onDeleteSecret={vault.handleDeleteSecret}
                  onClearSecurityEvents={vault.handleClearSecurityEvents}
                  onOutput={app.setOutput}
                  onError={app.setOutput}
                  activeTab="keychain"
                  onTabChange={() => {}}
                />
              )}
              {app.pcSidebarNav === 'snippets' && (
                <div className="absolute inset-0 p-4">
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
                </div>
              )}
              {app.pcSidebarNav === 'port-forwarding' && (
                <div className="p-6">
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
                </div>
              )}
              {app.pcSidebarNav === 'known-hosts' && (
                <div className="p-6">
                  <KnownHostsPanel onOutput={app.setOutput} onError={app.setOutput} />
                </div>
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
            </div>
          </div>
        )}
      </div>
      <MobileBottomNav
        activeNav={app.pcSidebarNav}
        onNavChange={(nav) => {
          sessions.setPcActiveSessionId(null)
          app.setPcSidebarNav(nav)
        }}
      />
    </div>
  )
}
