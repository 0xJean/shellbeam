import { AppUpdateRuntime } from '@/components/app-update'
import { InAppNotifications } from '@/components/in-app-notifications'
import { WelcomePage } from '@/components/welcome-page'
import { useWelcomePage } from '@/hooks/use-welcome-page'
import { AppProvider, useApp } from '@/contexts/app-context'
import { HostsProvider, useHosts } from '@/contexts/hosts-context'
import { SessionsProvider, useSessions } from '@/contexts/sessions-context'
import { VaultProvider, useVault } from '@/contexts/vault-context'
import { ScheduledOpsRuntime } from '@/components/scheduled-ops-runtime'
import { LocalOpsRuntime } from '@/components/local-ops-runtime'
import { ServerMonitorRuntime } from '@/components/server-monitor-runtime'
import { ProbeAlertRuntime } from '@/components/probe-alert-runtime'
import { ShellbeamAgentRuntime } from '@/components/shellbeam-agent-runtime'
import { UserConfirmationRuntime } from '@/components/user-confirmation-dialog'
import { PcLayout } from '@/layouts/pc-layout'
import { listCommandHistory } from '@/lib/history'
import { hasSshConnection } from '@/lib/hosts'
import { requestHostSftp } from '@/lib/navigation-request'
import { I18nProvider } from '@/lib/i18n'
import { Suspense, lazy, useEffect, useState } from 'react'

const CommandPalette = lazy(async () => {
  const module = await import('@/components/command-palette')
  return { default: module.CommandPalette }
})

function AppInner() {
  const app = useApp()
  const hostsCtx = useHosts()
  const sessions = useSessions()
  const welcome = useWelcomePage()
  const { activeVaultId } = useVault()
  const [loadedHistory, setLoadedHistory] = useState<{ vaultId: string; entries: Awaited<ReturnType<typeof listCommandHistory>> } | null>(null)
  // Command history is per vault: only the active vault's entries are ever shown.
  const historyEntries = loadedHistory?.vaultId === activeVaultId ? loadedHistory.entries : []

  useEffect(() => {
    let current = true
    void listCommandHistory(activeVaultId)
      .then((entries) => { if (current) setLoadedHistory({ vaultId: activeVaultId, entries }) })
      .catch((error) => {
        console.error('Load command history failed', error)
        if (current) setLoadedHistory({ vaultId: activeVaultId, entries: [] })
      })
    return () => { current = false }
  }, [activeVaultId])

  if (welcome.show) {
    return <WelcomePage onDismiss={welcome.dismiss} onOpenGuide={() => {
      app.setPcSidebarNav('guide')
      welcome.dismiss()
    }} />
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      <PcLayout />
      {app.commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open={app.commandPaletteOpen}
            onClose={() => app.setCommandPaletteOpen(false)}
            hosts={hostsCtx.hosts}
            historyEntries={historyEntries}
            selectedHostId={hostsCtx.selectedHostId}
            onSelectHost={(hostId) => {
              hostsCtx.setSelectedHostId(hostId)
              // Choosing a host in the palette connects to it, as the palette's hint says.
              const host = hostsCtx.hosts.find((item) => item.id === hostId)
              if (host && hasSshConnection(host)) { app.setPcSidebarNav('terminal'); void sessions.handleConnectHost(hostId) }
            }}
            onAction={app.handleCommandPaletteAction}
            onToggleTheme={app.toggleTheme}
            onHostAction={(hostId, action) => {
              hostsCtx.setSelectedHostId(hostId)
              // The PC layout handles the SFTP request: selects the host and opens SFTP in its home directory.
              if (action === 'sftp') requestHostSftp({ vaultId: hostsCtx.hosts.find((host) => host.id === hostId)?.vaultId, hostId, path: '' })
              else if (action === 'forward') app.setPcSidebarNav('port-forwarding')
              else { app.setPcSidebarNav('terminal'); void sessions.openHostWorkspace(hostId, 'overview') }
            }}
          />
        </Suspense>
      )}
    </div>
  )
}

function AppWithProviders() {
  return (
    <I18nProvider>
      <AppProvider>
        <AppInnerWithVault />
      </AppProvider>
    </I18nProvider>
  )
}

function AppInnerWithVault() {
  const { setOutput } = useApp()
  return (
    <VaultProvider setOutput={setOutput}>
      <HostsProvider>
        <UserConfirmationRuntime />
        <InAppNotifications />
        <ProbeAlertRuntime />
        <ServerMonitorRuntime />
        <LocalOpsRuntime />
        <ScheduledOpsRuntime />
        <ShellbeamAgentRuntime />
        <AppUpdateRuntime />
        <SessionsProvider setOutput={setOutput}>
          <AppInner />
        </SessionsProvider>
      </HostsProvider>
    </VaultProvider>
  )
}

export default AppWithProviders
