import { CommandPalette } from '@/components/command-palette'
import { WelcomePage, useWelcomePage } from '@/components/welcome-page'
import { AppProvider, useApp } from '@/contexts/app-context'
import { HostsProvider, useHosts } from '@/contexts/hosts-context'
import { SessionsProvider } from '@/contexts/sessions-context'
import { VaultProvider } from '@/contexts/vault-context'
import { PcLayout } from '@/layouts/pc-layout'
import { listCommandHistory } from '@/lib/history'
import { I18nProvider } from '@/lib/i18n'
import { useEffect, useState } from 'react'

function AppInner() {
  const app = useApp()
  const hostsCtx = useHosts()
  const welcome = useWelcomePage()
  const [historyEntries, setHistoryEntries] = useState<Array<Awaited<ReturnType<typeof listCommandHistory>>[number]>>([])

  useEffect(() => {
    void listCommandHistory().then(setHistoryEntries)
  }, [])

  if (welcome.show) {
    return <WelcomePage onDismiss={welcome.dismiss} />
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      <PcLayout />
      <CommandPalette
        open={app.commandPaletteOpen}
        onClose={() => app.setCommandPaletteOpen(false)}
        hosts={hostsCtx.hosts}
        historyEntries={historyEntries}
        selectedHostId={hostsCtx.selectedHostId}
        onSelectHost={hostsCtx.setSelectedHostId}
        onAction={app.handleCommandPaletteAction}
      />
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
        <SessionsProvider setOutput={setOutput}>
          <AppInner />
        </SessionsProvider>
      </HostsProvider>
    </VaultProvider>
  )
}

export default AppWithProviders
