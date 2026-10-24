import { sendInteractiveInput } from '@/lib/interactive-session'
import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import type { WorkspaceAppId } from '@/lib/workspace'
import { BatteryFull, ChevronLeft, Signal, Wifi, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WorkspaceAssetInventoryApp } from './workspace-asset-inventory-app'
import { WorkspaceBrowserApp } from './workspace-browser-app'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceFileSystemApp } from './workspace-file-system-app'
import { WorkspaceFileTransferApp } from './workspace-file-transfer-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceProcessesApp } from './workspace-processes-app'
import { WorkspaceServicesApp } from './workspace-services-app'
import { WorkspaceToolManagerApp } from './workspace-tool-manager-app'
import { DockerOpsPanel } from './docker-ops-panel'
import { ScheduledTasksPanel } from './scheduled-tasks-panel'
import { SitesSslPanel } from '../sites-ssl-panel'
import { NetworkOpsPanel } from './network-ops-panel'
import { ProviderHistoryDisclosure } from './provider-history-panel'
import { WorkspaceRecommendationsPanel } from './workspace-recommendations-panel'
import { WorkspaceStatusCards } from './workspace-status-cards'
import { getHostInventoryResource, HostMetadataLine, resolveHostForDisplay } from '../host-display-meta'

function LiveClock() {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  )
  useEffect(() => {
    const id = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    }, 10000)
    return () => window.clearInterval(id)
  }, [])
  return <>{time}</>
}

interface WorkspaceMobileShellProps {
  activeVaultId?: string
  sessionVaultId?: string
  sessionId: string
  hostName: string
  hostAddress: string
  hostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
  onOpenTerminal?: (host: HostProfile) => void
  onOpenProviderConsole?: (url: string, host: HostProfile) => void
  onEditHost?: (host: HostProfile) => void
  onBrowserCloseRequest?: () => void
}

export function WorkspaceMobileShell({
  activeVaultId,
  sessionVaultId,
  sessionId,
  hostName,
  hostAddress,
  hostId,
  hosts = [],
  resolveAuthSecret,
  activeApp,
  onSelectApp,
  onOpenTerminal,
  onOpenProviderConsole,
  onEditHost,
  onBrowserCloseRequest,
}: WorkspaceMobileShellProps) {
  const [diagnosticLogUnit, setDiagnosticLogUnit] = useState('')
  function openDiagnosticLogs(serviceName: string) { setDiagnosticLogUnit(serviceName); onSelectApp('logs') }
  function openDiagnosticTerminal(command: string) {
    onSelectApp('terminal')
    void sendInteractiveInput(sessionId, command).catch(() => {})
  }

  const sessionVaultMismatch = sessionVaultId !== undefined && sessionVaultId !== activeVaultId
  const activeHost = sessionVaultMismatch ? null : resolveHostForDisplay(hosts, hostId, hostAddress)
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))
  const content = (() => {
    if (sessionVaultMismatch && activeApp !== 'terminal') return <p role="status" className="p-6 text-sm text-muted-foreground">{t('workspace.sessionVaultMismatch')}</p>
    if (activeApp === 'assetInventory') {
      if (resolveAuthSecret) {
        return <WorkspaceAssetInventoryApp activeVaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} presentation="mobile" onOpenTerminal={onOpenTerminal} onOpenProviderConsole={onOpenProviderConsole} onEditHost={onEditHost} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'fileTransfer') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileTransferApp vaultId={activeVaultId} presentation="mobile" selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'fileSystem') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileSystemApp vaultId={activeVaultId} presentation="mobile" sessionId={sessionId} selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'processes') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceProcessesApp onOpenTerminal={openDiagnosticTerminal} vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'services') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceServicesApp onOpenLogs={openDiagnosticLogs} vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'network') {
      if (activeHost && resolveAuthSecret) return <NetworkOpsPanel host={activeHost} vaultId={activeVaultId} resolveAuthSecret={resolveAuthSecret} onOpenServices={() => onSelectApp('services')} onOpenLogs={() => openDiagnosticLogs('')} onOpenTerminal={openDiagnosticTerminal} />
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'toolManager') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceToolManagerApp vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} onOpenTerminal={onOpenTerminal} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'logs') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceLogsApp key={`${activeVaultId ?? ""}:${hostId ?? hostAddress}:${diagnosticLogUnit}`} initialUnit={diagnosticLogUnit} vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'docker') {
      if (activeHost && resolveAuthSecret) {
        return <DockerOpsPanel host={activeHost} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'sitesSsl') {
      if (activeHost && resolveAuthSecret) {
        return <SitesSslPanel host={activeHost} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'scheduledTasks') {
      if (activeHost && resolveAuthSecret) {
        return <ScheduledTasksPanel activeVaultId={activeVaultId} host={activeHost} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'browser') {
      return <WorkspaceBrowserApp sessionId={sessionId} onCloseRequest={onBrowserCloseRequest ?? (() => onSelectApp('overview'))} />
    }
    return <WorkspaceEmptyApp app={activeApp} />
  })()

  // Terminal is the primary app, then Files, Services, Overview for settings
  const dockApps: WorkspaceAppId[] = ['terminal', 'assetInventory', 'fileSystem', 'overview']
  const isOverview = activeApp === 'overview'

  return (
    <div
      data-testid="workspace-mobile-shell"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-workspace-shell text-[var(--workspace-text)]"
    >
      {/* iOS Springboard Wallpaper (Blurred Gradients matching PC) */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-workspace-mobile-wallpaper" />
      </div>

      {/* iOS Status Bar */}
      <div className="relative z-10 flex items-center justify-between px-6 pb-2 pt-[max(env(safe-area-inset-top),16px)] text-[15px] font-semibold text-[var(--workspace-primary-foreground)] drop-shadow-md">
        <span><LiveClock /></span>
        <div className="flex items-center gap-1.5">
          <Signal className="h-[14px] w-[14px]" />
          <Wifi className="h-[14px] w-[14px]" />
          <BatteryFull className="h-[18px] w-[18px]" />
        </div>
      </div>

      {/* Springboard (Home Screen) */}
      <motion.div 
        className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-36 pt-6"
        initial={false}
        animate={{ 
          scale: isOverview ? 1 : 0.95,
          opacity: isOverview ? 1 : 0,
          pointerEvents: isOverview ? 'auto' : 'none'
        }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        <div className="mb-8 text-center text-[var(--workspace-primary-foreground)] drop-shadow-md">
          <div className="text-2xl font-semibold tracking-tight">{hostName}</div>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm opacity-80">
            <span>{hostAddress}</span>
            <HostMetadataLine
              network={activeHost ? networkByAddress[activeHost.address] : undefined}
              resource={getHostInventoryResource(activeHost, inventoryStates)}
              className="justify-center text-sm"
              itemClassName="max-w-[9rem]"
              iconClassName="h-3.5 w-3.5"
            />
          </div>
        </div>

        <div className="min-h-[22rem]">
          <WorkspaceAppGrid activeApp={activeApp} onSelectApp={onSelectApp} variant="ios-grid" />
        </div>
        {isOverview && <div className="space-y-4">
          {sessionVaultMismatch ? <p role="status" className="p-4 text-sm">{t('workspace.sessionVaultMismatch')}</p> : <WorkspaceStatusCards activeVaultId={activeVaultId} hostAddress={hostAddress} selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />}
          <WorkspaceRecommendationsPanel host={activeHost ?? null} hosts={hosts} vaultId={activeVaultId} onSelectApp={onSelectApp} />
          {activeVaultId && activeHost && <ProviderHistoryDisclosure vaultId={activeVaultId} hostId={activeHost.id} />}
        </div>}
      </motion.div>

      {/* Fixed iOS Dock */}
      <motion.div 
        className="absolute bottom-4 left-4 right-4 z-20"
        initial={false}
        animate={{ 
          y: isOverview ? 0 : 100,
          opacity: isOverview ? 1 : 0,
          pointerEvents: isOverview ? 'auto' : 'none'
        }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        <div className="rounded-[32px] border border-[var(--workspace-mobile-stroke)] bg-[var(--workspace-mobile-card)] p-3 shadow-[var(--workspace-shadow-overlay)] backdrop-blur-2xl pb-[max(env(safe-area-inset-bottom,12px),12px)]">
          <WorkspaceAppGrid
            activeApp={activeApp}
            onSelectApp={onSelectApp}
            variant="ios-dock"
            apps={dockApps}
          />
        </div>
      </motion.div>

      {/* Full Screen App View */}
      <AnimatePresence>
        {!isOverview && (
          <motion.div
            key="app-view"
            data-testid="workspace-mobile-app-frame"
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className="absolute inset-0 z-30 flex flex-col overflow-hidden bg-[var(--workspace-surface-950)]"
          >
            {/* Frosted Navigation Bar */}
            <div className="relative z-40 flex items-center justify-between border-b border-[var(--workspace-border-soft)] bg-[var(--workspace-nav-translucent)] pb-3 pt-[max(env(safe-area-inset-top),16px)] px-2 shadow-[var(--workspace-shadow-card)] backdrop-blur-xl">
              <button
                type="button"
                onClick={() => onSelectApp('overview')}
                className="flex h-11 min-w-[44px] items-center gap-1 rounded-full px-2 text-[color:var(--workspace-primary-500)] active:opacity-60 transition-opacity"
                aria-label={t('workspace.mobile.backToHomeScreen')}
              >
                <ChevronLeft className="h-6 w-6 -ml-1" />
                <span className="text-[17px] font-medium leading-none">{t('workspace.mobile.home')}</span>
              </button>
              
              <div className="absolute left-1/2 -translate-x-1/2 text-center">
                <div className="text-[17px] font-semibold tracking-tight text-[var(--workspace-text-strong)]">
                  {t(`workspace.app.${activeApp}`)}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--workspace-text-muted)]">
                  {hostName}
                </div>
                <HostMetadataLine
                  network={activeHost ? networkByAddress[activeHost.address] : undefined}
                  resource={getHostInventoryResource(activeHost, inventoryStates)}
                  showLocationText={false}
                  showSystemText={false}
                  className="mt-0.5 justify-center gap-x-1"
                  iconClassName="h-3 w-3"
                />
              </div>

              <button
                type="button"
                className="flex h-11 min-w-[44px] items-center justify-end px-3 text-[color:var(--workspace-primary-500)] active:opacity-60 transition-opacity"
                aria-label={t('workspace.mobile.search')}
              >
                <Search className="h-5 w-5" />
              </button>
            </div>

            {/* App Content */}
            <div
              className={activeApp === 'browser'
                ? 'flex-1 overflow-hidden bg-workspace-shell pb-[env(safe-area-inset-bottom)]'
                : 'flex-1 overflow-auto bg-workspace-shell pb-[env(safe-area-inset-bottom)]'}
            >
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
