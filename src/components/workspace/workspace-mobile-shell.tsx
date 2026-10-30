import { sendInteractiveInput } from '@/lib/interactive-session'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { workspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { resolveWorkspaceMetricsHost } from '@/lib/workspace-metrics'
import type { WorkspaceAppId } from '@/lib/workspace'
import { BatteryFull, ChevronLeft, Copy, Signal, Wifi, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WorkspaceAssetInventoryApp } from './workspace-asset-inventory-app'
import { WorkspaceBrowserApp } from './workspace-browser-app'
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
import { WorkspaceChartsApp } from './workspace-charts-app'
import { NetworkOpsPanel } from './network-ops-panel'
import { ProviderHistoryDisclosure } from './provider-history-panel'
import { WorkspaceRecommendationsPanel } from './workspace-recommendations-panel'
import { WorkspaceStatusCards } from './workspace-status-cards'
import { getHostInventoryResource, HostMetadataLine, resolveHostForDisplay } from '../host-display-meta'
import { SessionVaultMismatchCard } from './session-state-card'
import { loadMobileHomePrefs, saveMobileHomePrefs, FIRST_PAGE_WIDGETS, type MobileHomePrefs, type MobileWidgetId } from './mobile/mobile-home-prefs'
import { MobileDock, MobileHomePage, MobileHomeTopBar, MobilePageDots, MobilePullIndicator } from './mobile/mobile-home-screen'
import { MobileAppList } from './mobile/mobile-app-list'
import { MobileSpotlight } from './mobile/mobile-spotlight'
import { MobileQuickActions } from './mobile/mobile-quick-actions'
import { MobileAppSwitcher } from './mobile/mobile-app-switcher'
import { MobileWidgetGallery } from './mobile/mobile-widget-gallery'
import { useMobileHomeData } from './mobile/use-mobile-home-data'
import { useHorizontalSwipe, usePullToRefresh } from './mobile/use-mobile-gestures'

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
  /** Shows the v3 "‹ Hosts" pill on the home screen when the host list is reachable. */
  onBackToHosts?: () => void
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
  onBackToHosts,
}: WorkspaceMobileShellProps) {
  const { t, locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
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
    if (sessionVaultMismatch && activeApp !== 'terminal') return <SessionVaultMismatchCard sessionId={sessionId} onContinueInTerminal={() => onSelectApp('terminal')} />
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
    if (activeApp === 'charts') {
      return activeHost ? <WorkspaceChartsApp host={activeHost} vaultId={activeVaultId} /> : <WorkspaceEmptyApp app={activeApp} />
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

  const isOverview = activeApp === 'overview'
  const metricsHost = sessionVaultMismatch ? null : resolveWorkspaceMetricsHost(hosts, { selectedHostId: hostId, hostAddress, vaultId: activeVaultId }) ?? null
  const home = useMobileHomeData({ host: metricsHost, hosts, vaultId: activeVaultId })
  const [prefs, setPrefs] = useState<MobileHomePrefs>(loadMobileHomePrefs)
  const [page, setPage] = useState<1 | 2>(1)
  const [overlay, setOverlay] = useState<null | 'spot' | 'switcher' | 'widgets' | { quick: WorkspaceAppId }>(null)
  const [recents, setRecents] = useState<{ tracked: WorkspaceAppId; apps: WorkspaceAppId[] }>(() => ({ tracked: activeApp, apps: isOverview ? [] : [activeApp] }))
  if (recents.tracked !== activeApp) setRecents({ tracked: activeApp, apps: isOverview ? recents.apps : [activeApp, ...recents.apps.filter((app) => app !== activeApp)].slice(0, 8) })
  const overviewRef = useRef<HTMLDivElement>(null)
  const pull = usePullToRefresh(home.refresh)
  const hasSecondPage = prefs.widgets.some((id) => !FIRST_PAGE_WIDGETS.includes(id))
  const currentPage = prefs.layout === 'grid' && hasSecondPage ? page : 1
  const swipe = useHorizontalSwipe((direction) => { if (prefs.layout === 'grid' && hasSecondPage) setPage(direction > 0 ? 2 : 1) })

  function updatePrefs(next: Partial<MobileHomePrefs>) {
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    saveMobileHomePrefs(merged)
  }
  function openApp(app: WorkspaceAppId) {
    setOverlay(null)
    if (app !== 'overview') { onSelectApp(app); return }
    if (!isOverview) onSelectApp('overview')
    setPage(1)
    overviewRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }
  const quickApp = overlay && typeof overlay === 'object' ? overlay.quick : null
  const showLargeTitle = activeApp !== 'browser' && activeApp !== 'charts'

  return (
    <div
      data-testid="workspace-mobile-shell"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-workspace-shell text-[var(--workspace-text)]"
    >
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-workspace-mobile-wallpaper" />
      </div>

      <div className="relative z-10 flex items-center justify-between px-6 pb-1 pt-[max(env(safe-area-inset-top),16px)] text-[15px] font-semibold text-[var(--workspace-text-strong)]">
        <span><LiveClock /></span>
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <Signal className="h-[14px] w-[14px]" />
          <Wifi className="h-[14px] w-[14px]" />
          <BatteryFull className="h-[18px] w-[18px]" />
        </div>
      </div>

      <motion.div
        className="relative z-10 flex min-h-0 flex-1 flex-col"
        initial={false}
        animate={{
          scale: isOverview ? 1 : 0.95,
          opacity: isOverview ? 1 : 0,
          pointerEvents: isOverview ? 'auto' : 'none'
        }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        <MobileHomeTopBar hostName={hostName} health={home.provider.view?.health.state} layout={prefs.layout} onBackToHosts={onBackToHosts}
          onToggleLayout={() => updatePrefs({ layout: prefs.layout === 'grid' ? 'list' : 'grid' })} onAddWidgets={() => setOverlay('widgets')} />
        <div
          data-testid="workspace-mobile-home-scroll"
          className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-56 pt-2"
          {...pull.handlers}
          onTouchStart={(event) => { pull.handlers.onTouchStart(event); swipe.onTouchStart(event) }}
          onTouchEnd={(event) => { pull.handlers.onTouchEnd(); swipe.onTouchEnd(event) }}
        >
          <MobilePullIndicator state={pull.state} distance={pull.distance} />
          <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 text-xs text-[var(--workspace-text-muted)]">
            <span>{hostAddress}</span>
            <HostMetadataLine
              network={activeHost ? networkByAddress[activeHost.address] : undefined}
              resource={getHostInventoryResource(activeHost, inventoryStates)}
              className="justify-center text-xs"
              itemClassName="max-w-[9rem]"
              iconClassName="h-3.5 w-3.5"
            />
          </div>
          {prefs.layout === 'list'
            ? <MobileAppList data={home} onOpen={openApp} onQuickActions={(app) => setOverlay({ quick: app })} />
            : <MobileHomePage page={currentPage} widgets={prefs.widgets} data={home} onOpen={openApp} onQuickActions={(app) => setOverlay({ quick: app })} onOpenWidgetApp={openApp} />}
          {currentPage === 1 && <div ref={overviewRef} data-testid="workspace-mobile-overview" className="mt-6 scroll-mt-4 space-y-4 px-4">
            {isOverview && <>
              {sessionVaultMismatch ? <SessionVaultMismatchCard sessionId={sessionId} onContinueInTerminal={() => onSelectApp('terminal')} className="p-0" /> : <WorkspaceStatusCards activeVaultId={activeVaultId} hostAddress={hostAddress} selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />}
              <WorkspaceRecommendationsPanel host={activeHost ?? null} hosts={hosts} vaultId={activeVaultId} onSelectApp={onSelectApp} />
              {activeVaultId && activeHost && <ProviderHistoryDisclosure vaultId={activeVaultId} hostId={activeHost.id} />}
            </>}
          </div>}
        </div>
      </motion.div>

      <motion.div
        className="absolute bottom-0 left-3 right-3 z-20 pb-[max(env(safe-area-inset-bottom),12px)]"
        initial={false}
        animate={{
          y: isOverview ? 0 : 100,
          opacity: isOverview ? 1 : 0,
          pointerEvents: isOverview ? 'auto' : 'none'
        }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        {prefs.layout === 'grid' && <MobilePageDots pages={hasSecondPage ? 2 : 1} page={currentPage} onSelect={setPage} />}
        <MobileDock data={home} onOpen={openApp} onQuickActions={(app) => setOverlay({ quick: app })} onSearch={() => setOverlay('spot')} />
      </motion.div>

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
            <div className="relative z-40 border-b border-[var(--workspace-border-soft)] bg-[var(--workspace-nav-translucent)] pt-[max(env(safe-area-inset-top),16px)] shadow-[var(--workspace-shadow-card)] backdrop-blur-xl">
              <div className="relative flex items-center justify-between px-2 pb-1">
                <button
                  type="button"
                  onClick={() => onSelectApp('overview')}
                  className="flex h-11 min-w-[44px] items-center gap-1 rounded-full px-2 text-[color:var(--workspace-primary-500)] active:opacity-60 transition-opacity"
                  aria-label={t('workspace.mobile.backToHomeScreen')}
                >
                  <ChevronLeft className="h-6 w-6 -ml-1" />
                  <span className="text-[17px] font-medium leading-none">{t('workspace.mobile.home')}</span>
                </button>

                <div className="pointer-events-none absolute left-1/2 max-w-[45%] -translate-x-1/2 text-center">
                  {!showLargeTitle && <div className="truncate text-[17px] font-semibold tracking-tight text-[var(--workspace-text-strong)]">{t(`workspace.app.${activeApp}`)}</div>}
                  <div className="truncate text-[11px] uppercase tracking-wider text-[var(--workspace-text-muted)]">{hostName}</div>
                  <HostMetadataLine
                    network={activeHost ? networkByAddress[activeHost.address] : undefined}
                    resource={getHostInventoryResource(activeHost, inventoryStates)}
                    showLocationText={false}
                    showSystemText={false}
                    className="mt-0.5 justify-center gap-x-1"
                    iconClassName="h-3 w-3"
                  />
                </div>

                <div className="flex items-center">
                  <button
                    type="button"
                    data-testid="workspace-mobile-switcher-button"
                    onClick={() => setOverlay('switcher')}
                    className="flex h-11 min-w-[44px] items-center justify-center text-[color:var(--workspace-primary-500)] active:opacity-60 transition-opacity"
                    aria-label={copy.switcher}
                  >
                    <Copy className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setOverlay('spot')}
                    className="flex h-11 min-w-[44px] items-center justify-end px-3 text-[color:var(--workspace-primary-500)] active:opacity-60 transition-opacity"
                    aria-label={t('workspace.mobile.search')}
                  >
                    <Search className="h-5 w-5" />
                  </button>
                </div>
              </div>
              {showLargeTitle && <h1 className="truncate px-4 pb-2 text-[30px] font-bold leading-tight tracking-tight text-[var(--workspace-text-strong)]">{t(`workspace.app.${activeApp}`)}</h1>}
            </div>

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

      {overlay === 'spot' && <MobileSpotlight data={home} onOpenApp={openApp} onOpenLogs={(unit) => { setOverlay(null); openDiagnosticLogs(unit) }} onClose={() => setOverlay(null)} />}
      {overlay === 'switcher' && <MobileAppSwitcher apps={recents.apps} activeApp={activeApp} hostName={hostName} onOpen={openApp}
        onDismiss={(app) => setRecents((current) => ({ ...current, apps: current.apps.filter((value) => value !== app) }))} onClose={() => setOverlay(null)} />}
      {overlay === 'widgets' && <MobileWidgetGallery selected={prefs.widgets} data={home} onClose={() => setOverlay(null)}
        onSave={(widgets: MobileWidgetId[]) => { updatePrefs({ widgets }); setOverlay(null) }} />}
      {quickApp && <MobileQuickActions app={quickApp} data={home} onOpenApp={openApp} onOpenLogs={() => openDiagnosticLogs('')}
        onTerminalInput={sessionVaultMismatch ? undefined : openDiagnosticTerminal} onEditHome={() => setOverlay('widgets')} onClose={() => setOverlay(null)} />}
    </div>
  )
}
