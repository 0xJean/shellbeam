import { WelcomePage } from '@/components/welcome-page'
import { useWelcomePage } from '@/hooks/use-welcome-page'
import { AppProvider, useApp } from '@/contexts/app-context'
import { HostsProvider, useHosts } from '@/contexts/hosts-context'
import { SessionsProvider } from '@/contexts/sessions-context'
import { VaultProvider } from '@/contexts/vault-context'
import { ScheduledOpsRuntime } from '@/components/scheduled-ops-runtime'
import { LocalOpsRuntime } from '@/components/local-ops-runtime'
import { ServerMonitorRuntime } from '@/components/server-monitor-runtime'
import { ProbeAlertRuntime } from '@/components/probe-alert-runtime'
import { ShellbeamAgentRuntime } from '@/components/shellbeam-agent-runtime'
import { UserConfirmationRuntime } from '@/components/user-confirmation-dialog'
import { PcLayout } from '@/layouts/pc-layout'
import { listCommandHistory } from '@/lib/history'
import { I18nProvider } from '@/lib/i18n'
import { Suspense, lazy, useEffect, useState } from 'react'

const CommandPalette = lazy(async () => {
  const module = await import('@/components/command-palette')
  return { default: module.CommandPalette }
})

function AppInner() {
  const app = useApp()
  const hostsCtx = useHosts()
  const welcome = useWelcomePage()
  const [historyEntries, setHistoryEntries] = useState<Array<Awaited<ReturnType<typeof listCommandHistory>>[number]>>([])

  useEffect(() => {
    void listCommandHistory()
      .then(setHistoryEntries)
      .catch((error) => {
        console.error('Load command history failed', error)
        setHistoryEntries([])
      })
  }, [])

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
            onSelectHost={hostsCtx.setSelectedHostId}
            onAction={app.handleCommandPaletteAction}
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
        <ProbeAlertRuntime />
        <ServerMonitorRuntime />
        <LocalOpsRuntime />
        <ScheduledOpsRuntime />
        <ShellbeamAgentRuntime />
        <SessionsProvider setOutput={setOutput}>
          <AppInner />
        </SessionsProvider>
      </HostsProvider>
    </VaultProvider>
  )
}

export default AppWithProviders
