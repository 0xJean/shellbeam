import { sendInteractiveInput } from '@/lib/interactive-session'
import type { HostProfile } from '@/lib/hosts'
import { t, useT } from '@/lib/i18n'
import { useHostNetworkMetadata, type HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import type { WorkspaceAppId } from '@/lib/workspace'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import type { WorkspaceInventory } from '@/lib/workspace-inventory'
import type { HostOpsHealthState } from '@/lib/host-ops-view'
import { cn } from '@/lib/utils'
import { formatBytesRate } from '@/lib/metric-series'
import { Copy, LayoutGrid, Minus, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { WorkspaceAssetInventoryApp } from './workspace-asset-inventory-app'
import { WorkspaceBrowserApp } from './workspace-browser-app'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceAppList, WorkspaceAppLineIcon, WorkspaceDesktopRail } from './workspace-app-grid'
import { WorkspaceLayoutToggle } from './workspace-layout-toggle'
import { useWorkspaceLayout } from '@/lib/workspace-layout'
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
import { WorkspaceRecommendationsPanel } from './workspace-recommendations-panel'
import { WorkspaceListOverview } from './workspace-list-overview'
import { WorkspaceHostCard } from './workspace-host-card'
import { useWorkspaceProviderState } from '@/lib/workspace-provider-state'
import { healthDotClass } from '@/lib/workspace-overview-display'
import { getWorkspaceInventoryHostKey } from '@/lib/workspace-inventory'
import { HostMetadataLine, resolveHostForDisplay } from '../host-display-meta'
import { SessionVaultMismatchCard } from './session-state-card'

const APP_LABEL_KEYS: Record<WorkspaceAppId, string> = {
  overview: 'workspace.app.overview',
  charts: 'workspace.app.charts',
  assetInventory: 'workspace.app.assetInventory',
  fileTransfer: 'workspace.app.fileTransfer',
  fileSystem: 'workspace.app.fileSystem',
  processes: 'workspace.app.processes',
  services: 'workspace.app.services',
  network: 'workspace.network.title',
  toolManager: 'workspace.app.toolManager',
  logs: 'workspace.app.logs',
  browser: 'workspace.app.browser',
  terminal: 'workspace.app.terminal',
  docker: 'workspace.app.docker',
  sitesSsl: 'workspace.app.sitesSsl',
  scheduledTasks: 'workspace.app.scheduledTasks',
}

function appLabel(app: WorkspaceAppId) {
  return t(APP_LABEL_KEYS[app])
}

interface WorkspaceDesktopShellProps {
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

interface DesktopWindowState {
  app: WorkspaceAppId
  x: number
  y: number
  z: number
  minimized: boolean
  maximized: boolean
}

/** Windows stay to the right of the two-column icon rail (16px inset + 168px rail + gap). */
const DESKTOP_ICON_RAIL_WIDTH = 200
const DESKTOP_WINDOW_MIN_WIDTH = 420
const DESKTOP_WINDOW_MIN_HEIGHT = 360
const DESKTOP_WINDOW_WIDTH_OFFSET = 240
const DESKTOP_WINDOW_HEIGHT_OFFSET = 80
const DESKTOP_WINDOW_MAX_WIDTH = 1080
const DESKTOP_WINDOW_MAX_HEIGHT = 720
const DESKTOP_BROWSER_WINDOW_WIDTH_OFFSET = 224
const DESKTOP_BROWSER_WINDOW_HEIGHT_OFFSET = 64
const DESKTOP_BROWSER_WINDOW_MAX_WIDTH = 1180
const DESKTOP_BROWSER_WINDOW_MAX_HEIGHT = 760

/** New windows cascade down and to the right from beside the rail, so each title bar stays reachable. */
function cascadePosition(openCount: number) {
  const step = openCount % 6
  return { x: DESKTOP_ICON_RAIL_WIDTH + 14 + step * 32, y: 24 + step * 28 }
}

function getDesktopWindowFrame(app: WorkspaceAppId) {
  if (app === 'browser') {
    return {
      width: `min(${DESKTOP_BROWSER_WINDOW_MAX_WIDTH}px, calc(100% - 14rem))`,
      height: `min(${DESKTOP_BROWSER_WINDOW_MAX_HEIGHT}px, calc(100% - 4rem))`,
    }
  }

  return {
    width: `min(${DESKTOP_WINDOW_MAX_WIDTH}px, calc(100% - 15rem))`,
    height: `min(${DESKTOP_WINDOW_MAX_HEIGHT}px, calc(100% - 5rem))`,
  }
}

function getDesktopWindowPixelSize(app: WorkspaceAppId, surfaceWidth: number, surfaceHeight: number) {
  const isBrowser = app === 'browser'
  const widthOffset = isBrowser ? DESKTOP_BROWSER_WINDOW_WIDTH_OFFSET : DESKTOP_WINDOW_WIDTH_OFFSET
  const heightOffset = isBrowser ? DESKTOP_BROWSER_WINDOW_HEIGHT_OFFSET : DESKTOP_WINDOW_HEIGHT_OFFSET
  const maxWidth = isBrowser ? DESKTOP_BROWSER_WINDOW_MAX_WIDTH : DESKTOP_WINDOW_MAX_WIDTH
  const maxHeight = isBrowser ? DESKTOP_BROWSER_WINDOW_MAX_HEIGHT : DESKTOP_WINDOW_MAX_HEIGHT

  return {
    width: Math.min(maxWidth, Math.max(DESKTOP_WINDOW_MIN_WIDTH, surfaceWidth - widthOffset)),
    height: Math.min(maxHeight, Math.max(DESKTOP_WINDOW_MIN_HEIGHT, surfaceHeight - heightOffset)),
  }
}

/** Taskbar clock: 24-hour time over the short date, in the app's language. */
function TaskbarClock() {
  const { locale } = useT()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <span data-testid="workspace-desktop-clock" className="ml-2.5 flex flex-col items-end font-mono text-[12.5px] font-semibold leading-[1.2] text-[var(--workspace-text-strong)]">
      {now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })}
      <small className="font-sans text-[10.5px] font-normal text-[var(--workspace-text-muted)]">{now.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</small>
    </span>
  )
}

function meterTone(percent: number) {
  if (percent >= 90) return 'bg-[var(--workspace-status-bad)]'
  if (percent >= 75) return 'bg-[var(--workspace-status-warn)]'
  return 'bg-[var(--workspace-status-good)]'
}

/** The four live readings on the desktop home: CPU, memory, disk and download rate. */
function DesktopMetrics({ snapshot }: { snapshot: ServerMonitorSnapshot | null }) {
  const percent = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? null : value)
  const rx = snapshot?.networkRxBytesPerSec == null ? null : formatBytesRate(snapshot.networkRxBytesPerSec)
  const cards = [
    { key: 'cpu', label: t('workspace.status.cpu'), percent: percent(snapshot?.cpuPercent) },
    { key: 'memory', label: t('workspace.status.memory'), percent: percent(snapshot?.memoryPercent) },
    { key: 'disk', label: t('workspace.status.disk'), percent: percent(snapshot?.diskPercent) },
    { key: 'network', label: t('workspace.status.network'), percent: null, value: rx ? `↓${rx}` : null },
  ]
  return (
    <div data-testid="workspace-desktop-metrics" className="grid grid-cols-4 gap-2.5">
      {cards.map((card) => {
        const value = card.value ?? (card.percent == null ? null : `${Math.round(card.percent)}%`)
        return (
          <div key={card.key} className="sb-card min-w-0 px-3.5 py-3">
            <span className="text-xs text-[var(--workspace-text-muted)]">{card.label}</span>
            <b className="mb-2 mt-[3px] block truncate text-[17px] font-semibold text-[var(--workspace-text-strong)]">{value ?? '—'}</b>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--workspace-surface-800)]">
              {card.percent != null && <i className={cn('block h-full rounded-full', meterTone(card.percent))} style={{ width: `${Math.max(0, Math.min(100, card.percent))}%` }} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface DesktopHomeProps {
  hostName: string
  hostAddress: string
  host: HostProfile | null
  hosts: HostProfile[]
  vaultId?: string
  network?: HostNetworkDisplay
  inventory?: WorkspaceInventory
  health?: HostOpsHealthState
  snapshot: ServerMonitorSnapshot | null
  showIntro: boolean
  onCloseIntro: () => void
  onSelectApp: (app: WorkspaceAppId) => void
  mismatch?: ReactNode
}

/** v3 desktop home: host intro, four live metrics and the suggestions card, beside the icon rail. */
function DesktopHome({ hostName, hostAddress, host, hosts, vaultId, network, inventory, health, snapshot, showIntro, onCloseIntro, onSelectApp, mismatch }: DesktopHomeProps) {
  return (
    <div data-testid="workspace-desktop-home" className="absolute bottom-4 left-[214px] top-6 z-[2] hidden w-[560px] max-w-[calc(100%-230px)] flex-col gap-3 overflow-y-auto md:flex">
      {showIntro && (
        <section className="sb-card px-[18px] py-4">
          <div className="flex justify-between gap-2.5">
            <div className="min-w-0">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-[var(--workspace-text-muted)]">{t('workspace.desktop.desktop')}</span>
              <h2 className="mt-1 flex min-w-0 items-center gap-2.5 text-2xl font-semibold text-[var(--workspace-text-strong)]">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', healthDotClass(health))} aria-hidden="true" />
                <span className="truncate">{hostName}</span>
              </h2>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[12.5px] text-[var(--workspace-text-muted)]">
                <span>{host?.username ? `${host.username}@${hostAddress}` : hostAddress}</span>
                <HostMetadataLine network={network} resource={inventory?.resource} className="text-[12.5px] text-[var(--workspace-text-muted)]" itemClassName="max-w-[12rem]" iconClassName="h-3.5 w-3.5" />
                <span>{t('workspace.desktop.ready')}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onCloseIntro}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]"
              aria-label={t('workspace.desktop.closeIntro')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}
      {mismatch ?? (
        <>
          <DesktopMetrics snapshot={snapshot} />
          <WorkspaceRecommendationsPanel variant="desktop" host={host} hosts={hosts} vaultId={vaultId} onSelectApp={onSelectApp} footer={t('workspace.desktop.hint')} />
        </>
      )}
    </div>
  )
}

const WINDOW_BUTTON = 'flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]'

export function WorkspaceDesktopShell({
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
}: WorkspaceDesktopShellProps) {
  const { layout, setLayout } = useWorkspaceLayout()
  const [diagnosticLogUnit, setDiagnosticLogUnit] = useState('')
  function openDiagnosticLogs(serviceName: string) { setDiagnosticLogUnit(serviceName); onSelectApp('logs') }
  function openDiagnosticTerminal(command: string) {
    onSelectApp('terminal')
    void sendInteractiveInput(sessionId, command).catch(() => {})
  }

  const isOverview = activeApp === 'overview'
  const [showIntroPanel, setShowIntroPanel] = useState(true)
  const [windows, setWindows] = useState<DesktopWindowState[]>([])
  const desktopSurfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ app: WorkspaceAppId; offsetX: number; offsetY: number } | null>(null)
  const zCounterRef = useRef(3)
  const sessionVaultMismatch = sessionVaultId !== undefined && sessionVaultId !== activeVaultId
  const activeHost = sessionVaultMismatch ? null : resolveHostForDisplay(hosts, hostId, hostAddress)
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))
  const providerView = useWorkspaceProviderState({ host: activeHost ?? null, hosts, vaultId: activeVaultId }).view
  const health = providerView?.health.state
  const activeNetwork = activeHost ? networkByAddress[activeHost.address] : undefined
  const activeInventory = activeHost ? inventoryStates[getWorkspaceInventoryHostKey(activeHost)]?.inventory : undefined

  useEffect(() => {
    if (activeApp === 'overview') return
    setWindows((prev) => {
      const nextZ = ++zCounterRef.current
      if (prev.some((windowState) => windowState.app === activeApp)) {
        return prev.map((windowState) =>
          windowState.app === activeApp ? { ...windowState, z: nextZ, minimized: false } : windowState,
        )
      }
      const position = cascadePosition(prev.length)
      return [...prev, { app: activeApp, x: position.x, y: position.y, z: nextZ, minimized: false, maximized: false }]
    })
  }, [activeApp])

  function renderApp(app: WorkspaceAppId) {
    if (sessionVaultMismatch && app !== 'terminal') return <SessionVaultMismatchCard sessionId={sessionId} onContinueInTerminal={() => onSelectApp('terminal')} />
    if (app === 'assetInventory') {
      if (resolveAuthSecret) {
        return <WorkspaceAssetInventoryApp activeVaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} onOpenTerminal={onOpenTerminal} onOpenProviderConsole={onOpenProviderConsole} onEditHost={onEditHost} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'fileTransfer') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileTransferApp vaultId={activeVaultId} presentation="window" selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'fileSystem') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileSystemApp vaultId={activeVaultId} presentation="window" sessionId={sessionId} selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'processes') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceProcessesApp onOpenTerminal={openDiagnosticTerminal} vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'services') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceServicesApp onOpenLogs={openDiagnosticLogs} vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'network') {
      if (activeHost && resolveAuthSecret) return <NetworkOpsPanel host={activeHost} vaultId={activeVaultId} resolveAuthSecret={resolveAuthSecret} onOpenServices={() => onSelectApp('services')} onOpenLogs={() => openDiagnosticLogs('')} onOpenTerminal={openDiagnosticTerminal} />
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'toolManager') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceToolManagerApp vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} onOpenTerminal={onOpenTerminal} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'logs') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceLogsApp key={`${activeVaultId ?? ""}:${hostId ?? hostAddress}:${diagnosticLogUnit}`} initialUnit={diagnosticLogUnit} vaultId={activeVaultId} selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'docker') {
      if (activeHost && resolveAuthSecret) {
        return <DockerOpsPanel host={activeHost} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'charts') {
      return activeHost ? <WorkspaceChartsApp host={activeHost} vaultId={activeVaultId} /> : <WorkspaceEmptyApp app={app} />
    }
    if (app === 'sitesSsl') {
      if (activeHost && resolveAuthSecret) {
        return <SitesSslPanel host={activeHost} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'scheduledTasks') {
      if (activeHost && resolveAuthSecret) {
        return <ScheduledTasksPanel activeVaultId={activeVaultId} host={activeHost} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'browser') {
      return <WorkspaceBrowserApp sessionId={sessionId} onCloseRequest={onBrowserCloseRequest ?? (() => onSelectApp('overview'))} />
    }
    return <WorkspaceEmptyApp app={app} />
  }

  function focusWindow(app: WorkspaceAppId) {
    const nextZ = ++zCounterRef.current
    setWindows((prev) => prev.map((windowState) => (
      windowState.app === app ? { ...windowState, z: nextZ, minimized: false } : windowState
    )))
    onSelectApp(app)
  }

  /** The window to bring forward when the current one goes away, or the desktop when none is left. */
  function nextFrontApp(remaining: DesktopWindowState[]) {
    return remaining.filter((windowState) => !windowState.minimized).sort((a, b) => b.z - a.z)[0]?.app ?? 'overview'
  }

  function closeWindow(app: WorkspaceAppId) {
    const remaining = windows.filter((windowState) => windowState.app !== app)
    setWindows(remaining)
    if (app === activeApp) onSelectApp(nextFrontApp(remaining))
  }

  function minimizeWindow(app: WorkspaceAppId) {
    const next = windows.map((windowState) => (windowState.app === app ? { ...windowState, minimized: true } : windowState))
    setWindows(next)
    if (app === activeApp) onSelectApp(nextFrontApp(next))
  }

  function toggleMaximize(app: WorkspaceAppId) {
    setWindows((prev) => prev.map((windowState) => (
      windowState.app === app ? { ...windowState, maximized: !windowState.maximized } : windowState
    )))
    if (app !== activeApp) focusWindow(app)
  }

  /** Taskbar buttons bring a window forward, or tuck the front one away like a desktop taskbar. */
  function toggleFromTaskbar(app: WorkspaceAppId) {
    const windowState = windows.find((entry) => entry.app === app)
    if (windowState && app === activeApp && !windowState.minimized) minimizeWindow(app)
    else focusWindow(app)
  }

  function beginDrag(app: WorkspaceAppId, clientX: number, clientY: number) {
    const windowState = windows.find((entry) => entry.app === app)
    if (!windowState) return
    if (!windowState.maximized) {
      dragRef.current = {
        app,
        offsetX: clientX - windowState.x,
        offsetY: clientY - windowState.y,
      }
    }
    if (app !== activeApp) focusWindow(app)
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      const bounds = desktopSurfaceRef.current?.getBoundingClientRect()
      const surfaceWidth = bounds?.width ?? window.innerWidth
      const surfaceHeight = bounds?.height ?? window.innerHeight
      const windowSize = getDesktopWindowPixelSize(drag.app, surfaceWidth, surfaceHeight)
      const maxX = Math.max(DESKTOP_ICON_RAIL_WIDTH, surfaceWidth - windowSize.width)
      const maxY = Math.max(16, surfaceHeight - windowSize.height)

      setWindows((prev) => prev.map((windowState) => (
        windowState.app === drag.app
          ? {
              ...windowState,
              x: Math.min(Math.max(DESKTOP_ICON_RAIL_WIDTH, event.clientX - drag.offsetX), maxX),
              y: Math.min(Math.max(16, event.clientY - drag.offsetY), maxY),
            }
          : windowState
      )))
    }

    function handlePointerUp() {
      dragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [])

  if (layout === 'list') {
    return (
      <div data-testid="workspace-list-shell" className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-[var(--workspace-content-bg)] text-foreground">
        <aside className="flex w-[200px] shrink-0 flex-col overflow-y-auto border-r border-[color:var(--workspace-border-soft)] px-2.5 py-3.5">
          <WorkspaceHostCard hostName={hostName} hostAddress={hostAddress} host={activeHost ?? null} network={activeNetwork} resource={activeInventory?.resource} health={health}>
            <WorkspaceLayoutToggle layout={layout} onChange={setLayout} full />
          </WorkspaceHostCard>
          <WorkspaceAppList activeApp={activeApp} onSelectApp={onSelectApp} />
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto p-5">
          {isOverview ? (
            sessionVaultMismatch
              ? <SessionVaultMismatchCard sessionId={sessionId} onContinueInTerminal={() => onSelectApp('terminal')} className="p-0" />
              : <WorkspaceListOverview activeVaultId={activeVaultId} hostName={hostName} hostAddress={hostAddress} host={activeHost ?? null} hosts={hosts} network={activeNetwork} inventory={activeInventory} resolveAuthSecret={resolveAuthSecret} onSelectApp={onSelectApp} />
          ) : <div className="h-full min-h-[28rem]">{renderApp(activeApp)}</div>}
        </main>
      </div>
    )
  }

  const openApps = new Set(windows.map((windowState) => windowState.app))
  const hostTarget = `${hostName} · ${hostAddress}`

  return (
    <div
      data-testid="workspace-desktop-shell"
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-workspace-desktop-wallpaper text-foreground"
    >
      <div ref={desktopSurfaceRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-workspace-desktop-overlay" />
        <div className="absolute bottom-4 left-4 top-4 z-[1] hidden overflow-y-auto md:block">
          <WorkspaceDesktopRail openApps={openApps} onSelectApp={(app) => (app === 'overview' ? onSelectApp('overview') : focusWindow(app))} />
        </div>

        {isOverview && (
          <DesktopHome
            hostName={hostName}
            hostAddress={hostAddress}
            host={activeHost ?? null}
            hosts={hosts}
            vaultId={activeVaultId}
            network={activeNetwork}
            inventory={activeInventory}
            health={health}
            snapshot={providerView?.metrics ?? null}
            showIntro={showIntroPanel}
            onCloseIntro={() => setShowIntroPanel(false)}
            onSelectApp={onSelectApp}
            mismatch={sessionVaultMismatch ? <SessionVaultMismatchCard sessionId={sessionId} onContinueInTerminal={() => onSelectApp('terminal')} className="p-0" /> : undefined}
          />
        )}

        {windows.map((windowState) => {
          const { app } = windowState
          const front = app === activeApp
          const label = appLabel(app)
          return (
            <section
              key={app}
              data-testid={`workspace-desktop-window-${app}`}
              data-front={front || undefined}
              aria-label={label}
              hidden={isOverview || windowState.minimized}
              className={cn(
                // The display class must follow `hidden`, or `flex` would keep a hidden window on screen.
                isOverview || windowState.minimized ? 'hidden' : 'flex',
                'absolute flex-col overflow-hidden bg-[var(--workspace-content-bg)] shadow-[var(--workspace-shadow-overlay)] ring-1 transition-opacity',
                windowState.maximized ? 'rounded-none' : 'min-h-[20rem] min-w-[20rem] rounded-xl',
                front ? 'ring-[color:var(--workspace-border-strong)]' : 'opacity-[.78] ring-[color:var(--workspace-border-soft)] hover:opacity-100',
              )}
              style={windowState.maximized
                ? { inset: 0, zIndex: windowState.z }
                : { left: windowState.x, top: windowState.y, ...getDesktopWindowFrame(app), zIndex: windowState.z }}
            >
              <div
                className={cn('flex h-[38px] shrink-0 items-center gap-2 border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] pl-3 pr-1.5 text-[12.5px]', !windowState.maximized && 'cursor-grab active:cursor-grabbing')}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).closest('button')) return
                  beginDrag(app, event.clientX, event.clientY)
                }}
                onDoubleClick={(event) => {
                  if (!(event.target as HTMLElement).closest('button')) toggleMaximize(app)
                }}
              >
                <WorkspaceAppLineIcon app={app} className="h-[15px] w-[15px] shrink-0 text-[var(--workspace-accent-text)]" />
                <b className="shrink-0 font-semibold text-[var(--workspace-text-strong)]">{label}</b>
                <span className="min-w-0 truncate text-[11.5px] text-[var(--workspace-text-muted)]">{hostTarget}</span>
                <span className={cn(
                  'ml-1 shrink-0 rounded-md px-1.5 text-[11px] leading-5',
                  front ? 'bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]',
                )}>
                  {t(front ? 'workspace.desktop.currentWindow' : 'workspace.desktop.backgroundWindow')}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <button type="button" onClick={() => minimizeWindow(app)} className={WINDOW_BUTTON} aria-label={t('workspace.desktop.minimizeWindow')} title={t('workspace.desktop.minimizeWindow')}>
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleMaximize(app)}
                    className={WINDOW_BUTTON}
                    aria-label={t(windowState.maximized ? 'workspace.desktop.restoreWindow' : 'workspace.desktop.maximizeWindow')}
                    title={t(windowState.maximized ? 'workspace.desktop.restoreWindow' : 'workspace.desktop.maximizeWindow')}
                  >
                    {windowState.maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => closeWindow(app)}
                    className={cn(WINDOW_BUTTON, 'hover:bg-[var(--workspace-status-bad-bg)] hover:text-[var(--workspace-status-bad-text)]')}
                    aria-label={t('workspace.desktop.closeWindow', { app: label })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div
                data-testid="workspace-window-body"
                className={cn(
                  'min-h-0 flex-1',
                  app === 'browser'
                    ? 'overflow-hidden p-0'
                    : 'overflow-auto p-4 md:p-5',
                )}
                onMouseDown={() => { if (!front) focusWindow(app) }}
              >
                {renderApp(app)}
              </div>
            </section>
          )
        })}
      </div>

      <div
        data-testid="workspace-desktop-taskbar"
        className="flex h-12 w-full min-w-0 shrink-0 items-center gap-1.5 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3"
      >
        <button
          type="button"
          onClick={() => onSelectApp('overview')}
          aria-label={t('workspace.desktop.home')}
          title={t('workspace.desktop.home')}
          aria-pressed={isOverview}
          className={cn(
            'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]',
            isOverview ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text)]',
          )}
        >
          <LayoutGrid className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
          {windows.map((windowState) => {
            const { app } = windowState
            const front = app === activeApp && !windowState.minimized
            const label = appLabel(app)
              return (
              <button
                key={app}
                type="button"
                data-testid={`workspace-taskbar-${app}`}
                onClick={() => toggleFromTaskbar(app)}
                aria-pressed={front}
                title={windowState.minimized ? t('workspace.desktop.minimized', { app: label }) : label}
                className={cn(
                  'relative flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[12.5px]',
                  front
                    ? 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-strong)] ring-1 ring-[color:var(--workspace-border-soft)]'
                    : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
                )}
              >
                <WorkspaceAppLineIcon app={app} className="h-[15px] w-[15px]" />
                <span>{label}</span>
                <i
                  aria-hidden="true"
                  className={cn(
                    'absolute bottom-0.5 left-1/2 h-1 -translate-x-1/2',
                    front ? 'w-4 rounded-sm bg-[var(--workspace-primary-400)]' : 'w-1 rounded-full bg-[var(--workspace-text-muted)]',
                  )}
                />
              </button>
            )
          })}
        </div>
        <span className="flex-1" />
        <span data-testid="workspace-desktop-host-status" className="mr-1.5 hidden min-w-0 items-center gap-1.5 text-xs text-[var(--workspace-text)] md:flex">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', healthDotClass(health))} aria-hidden="true" />
          <span className="truncate">{hostName} · {t(health === 'offline' || health === 'jump-unavailable' ? 'workspace.desktop.unreachable' : 'workspace.desktop.connected')}</span>
        </span>
        <WorkspaceLayoutToggle layout={layout} onChange={setLayout} />
        <TaskbarClock />
      </div>
    </div>
  )
}
