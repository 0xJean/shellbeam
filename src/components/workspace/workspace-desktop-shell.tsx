import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { LayoutGrid, Minus, Monitor, Search, Square, Volume2, Wifi, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { WorkspaceAssetInventoryApp } from './workspace-asset-inventory-app'
import { WorkspaceBrowserApp } from './workspace-browser-app'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceFileSystemApp } from './workspace-file-system-app'
import { WorkspaceFileTransferApp } from './workspace-file-transfer-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceProcessesApp } from './workspace-processes-app'
import { WorkspaceServicesApp } from './workspace-services-app'
import { WorkspaceStatusCards } from './workspace-status-cards'
import { WorkspaceToolManagerApp } from './workspace-tool-manager-app'

const APP_LABELS: Array<{ id: WorkspaceAppId; labelKey: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview' },
  { id: 'assetInventory', labelKey: 'workspace.app.assetInventory' },
  { id: 'fileTransfer', labelKey: 'workspace.app.fileTransfer' },
  { id: 'fileSystem', labelKey: 'workspace.app.fileSystem' },
  { id: 'processes', labelKey: 'workspace.app.processes' },
  { id: 'services', labelKey: 'workspace.app.services' },
  { id: 'toolManager', labelKey: 'workspace.app.toolManager' },
  { id: 'logs', labelKey: 'workspace.app.logs' },
  { id: 'browser', labelKey: 'workspace.app.browser' },
  { id: 'terminal', labelKey: 'workspace.app.terminal' },
]

const TASKBAR_APPS = APP_LABELS.filter((item) => item.id !== 'overview')

interface WorkspaceDesktopShellProps {
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
}

const DESKTOP_ICON_RAIL_WIDTH = 112
const DESKTOP_WINDOW_MIN_WIDTH = 420
const DESKTOP_WINDOW_MIN_HEIGHT = 360
const DESKTOP_WINDOW_WIDTH_OFFSET = 176
const DESKTOP_WINDOW_HEIGHT_OFFSET = 112
const DESKTOP_WINDOW_MAX_WIDTH = 1080
const DESKTOP_WINDOW_MAX_HEIGHT = 720
const DESKTOP_BROWSER_WINDOW_WIDTH_OFFSET = 144
const DESKTOP_BROWSER_WINDOW_HEIGHT_OFFSET = 96
const DESKTOP_BROWSER_WINDOW_MAX_WIDTH = 1180
const DESKTOP_BROWSER_WINDOW_MAX_HEIGHT = 760

const DEFAULT_WINDOW_POSITIONS: Record<WorkspaceAppId, { x: number; y: number }> = {
  overview: { x: 0, y: 0 },
  assetInventory: { x: 128, y: 28 },
  fileTransfer: { x: 128, y: 28 },
  fileSystem: { x: 144, y: 40 },
  processes: { x: 160, y: 52 },
  services: { x: 176, y: 44 },
  toolManager: { x: 136, y: 36 },
  logs: { x: 152, y: 64 },
  browser: { x: 120, y: 24 },
  terminal: { x: 168, y: 72 },
}

function getDesktopWindowFrame(app: WorkspaceAppId) {
  if (app === 'browser') {
    return {
      width: `min(${DESKTOP_BROWSER_WINDOW_MAX_WIDTH}px, calc(100% - 9rem))`,
      height: `min(${DESKTOP_BROWSER_WINDOW_MAX_HEIGHT}px, calc(100% - 6rem))`,
    }
  }

  return {
    width: `min(${DESKTOP_WINDOW_MAX_WIDTH}px, calc(100% - 11rem))`,
    height: `min(${DESKTOP_WINDOW_MAX_HEIGHT}px, calc(100% - 7rem))`,
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

function LiveDate() {
  const [date] = useState(() =>
    new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
  )
  return <>{date}</>
}

export function WorkspaceDesktopShell({
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
  const isOverview = activeApp === 'overview'
  const [showIntroPanel, setShowIntroPanel] = useState(true)
  const [showWidgets, setShowWidgets] = useState(true)
  const [windows, setWindows] = useState<DesktopWindowState[]>([])
  const desktopSurfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ app: WorkspaceAppId; offsetX: number; offsetY: number } | null>(null)
  const zCounterRef = useRef(3)

  useEffect(() => {
    if (activeApp === 'overview') return
    setWindows((prev) => {
      const existing = prev.find((windowState) => windowState.app === activeApp)
      if (existing) {
        const nextZ = ++zCounterRef.current
        return prev.map((windowState) =>
          windowState.app === activeApp ? { ...windowState, z: nextZ } : windowState,
        )
      }

      const nextZ = ++zCounterRef.current
      const position = DEFAULT_WINDOW_POSITIONS[activeApp]
      return [...prev, { app: activeApp, x: position.x, y: position.y, z: nextZ }]
    })
  }, [activeApp])

  const content = (() => {
    if (activeApp === 'assetInventory') {
      if (resolveAuthSecret) {
        return <WorkspaceAssetInventoryApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} onOpenTerminal={onOpenTerminal} onOpenProviderConsole={onOpenProviderConsole} onEditHost={onEditHost} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'fileTransfer') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileTransferApp presentation="window" selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'fileSystem') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileSystemApp presentation="window" sessionId={sessionId} selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'processes') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceProcessesApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'services') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceServicesApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'toolManager') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceToolManagerApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} onOpenTerminal={onOpenTerminal} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'logs') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceLogsApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'browser') {
      return <WorkspaceBrowserApp sessionId={sessionId} onCloseRequest={onBrowserCloseRequest ?? (() => onSelectApp('overview'))} />
    }
    return <WorkspaceEmptyApp app={activeApp} />
  })()

  function focusWindow(app: WorkspaceAppId) {
    const nextZ = ++zCounterRef.current
    setWindows((prev) => prev.map((windowState) => (
      windowState.app === app ? { ...windowState, z: nextZ } : windowState
    )))
    onSelectApp(app)
  }

  function openDesktopApp(app: WorkspaceAppId) {
    if (app === 'overview') {
      onSelectApp('overview')
      return
    }
    focusWindow(app)
  }

  function closeWindow(app: WorkspaceAppId) {
    setWindows((prev) => {
      const remaining = prev.filter((windowState) => windowState.app !== app)
      const nextActive = remaining.slice().sort((a, b) => b.z - a.z)[0]
      onSelectApp(nextActive?.app ?? 'overview')
      return remaining
    })
  }

  function beginDrag(app: WorkspaceAppId, clientX: number, clientY: number) {
    const windowState = windows.find((entry) => entry.app === app)
    if (!windowState) return
    dragRef.current = {
      app,
      offsetX: clientX - windowState.x,
      offsetY: clientY - windowState.y,
    }
    focusWindow(app)
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
      const maxY = Math.max(24, surfaceHeight - windowSize.height)

      setWindows((prev) => prev.map((windowState) => (
        windowState.app === drag.app
          ? {
              ...windowState,
              x: Math.min(Math.max(DESKTOP_ICON_RAIL_WIDTH, event.clientX - drag.offsetX), maxX),
              y: Math.min(Math.max(24, event.clientY - drag.offsetY), maxY),
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

  function renderWindowContent(app: WorkspaceAppId) {
    if (app === activeApp) return content

    if (app === 'assetInventory') {
      if (resolveAuthSecret) {
        return <WorkspaceAssetInventoryApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} onOpenTerminal={onOpenTerminal} onOpenProviderConsole={onOpenProviderConsole} onEditHost={onEditHost} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'fileTransfer') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileTransferApp presentation="window" selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'fileSystem') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFileSystemApp presentation="window" sessionId={sessionId} selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'processes') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceProcessesApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'services') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceServicesApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'toolManager') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceToolManagerApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} onOpenTerminal={onOpenTerminal} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'logs') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceLogsApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
    }
    if (app === 'browser') {
      return <WorkspaceBrowserApp sessionId={sessionId} onCloseRequest={onBrowserCloseRequest ?? (() => onSelectApp('overview'))} />
    }
    return <WorkspaceEmptyApp app={app} />
  }

  function renderWindowBody(app: WorkspaceAppId) {
    if (app !== activeApp) {
      return (
        <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
          {t('workspace.desktop.windowReady')}
        </div>
      )
    }

    return renderWindowContent(app)
  }

  return (
    <div
      data-testid="workspace-desktop-shell"
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-workspace-desktop-wallpaper text-foreground"
    >
      <div ref={desktopSurfaceRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-workspace-desktop-overlay" />
        <div className="absolute left-6 top-6 z-20 hidden md:block">
          <WorkspaceAppGrid activeApp={activeApp} onSelectApp={openDesktopApp} variant="desktop" />
        </div>

        {isOverview ? (
          <div className="relative h-full w-full">
            {showIntroPanel && (
              <div className="absolute left-[8.5rem] top-8 z-10 hidden w-[24rem] rounded-xl border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] px-5 py-4 shadow-[var(--workspace-shadow-overlay)] backdrop-blur-md md:block">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--workspace-text-subtle)]">{t('workspace.desktop.desktop')}</div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">{hostName}</div>
                    <div className="mt-1 text-sm text-[var(--workspace-text-muted)]">{hostAddress}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowIntroPanel(false)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]"
                    aria-label={t('workspace.desktop.closeIntro')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-4 flex items-center gap-2 text-sm text-[var(--workspace-text)]">
                  <Monitor className="h-4 w-4" />
                  <span>{t('workspace.desktop.ready')}</span>
                </div>
              </div>
            )}

            {showWidgets && (
              <div className="absolute bottom-8 right-8 z-10 hidden w-[26rem] space-y-4 md:block">
                <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] px-4 py-4 shadow-[var(--workspace-shadow-overlay)] backdrop-blur-md">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-subtle)]">{t('workspace.desktop.widgetStack')}</div>
                    <button
                      type="button"
                      onClick={() => setShowWidgets(false)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]"
                      aria-label={t('workspace.desktop.closeWidgets')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                <WorkspaceStatusCards
                  hostAddress={hostAddress}
                  selectedHostId={hostId}
                  hosts={hosts}
                  resolveAuthSecret={resolveAuthSecret}
                />
                </div>
                <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-800)] px-4 py-4 shadow-[var(--workspace-shadow-card)]">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-subtle)]">{t('workspace.desktop.quickHint')}</div>
                  <div className="mt-3 text-sm font-medium text-[var(--workspace-text-strong)]">{t('workspace.desktop.doubleClickHint')}</div>
                  <div className="mt-1 text-sm text-[var(--workspace-text-muted)]">{t('workspace.desktop.taskbarHint')}</div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="relative h-full w-full">
            {windows
              .slice()
              .sort((a, b) => a.z - b.z)
              .map((windowState) => (
                <section
                  key={windowState.app}
                  data-testid={`workspace-desktop-window-${windowState.app}`}
                  className={cn(
                    'absolute flex min-h-[20rem] min-w-[20rem] flex-col overflow-hidden rounded-xl border bg-[var(--workspace-surface-900)] shadow-[var(--workspace-shadow-overlay)] backdrop-blur-md',
                    activeApp === windowState.app
                      ? 'border-[color:var(--workspace-border-glow)]'
                      : 'border-[color:var(--workspace-border-strong)]',
                  )}
                  style={{
                    left: windowState.x,
                    top: windowState.y,
                    ...getDesktopWindowFrame(windowState.app),
                    zIndex: windowState.z,
                  }}
                >
                  <div
                    className="flex cursor-move items-center justify-between gap-4 border-b border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-800)] px-4 py-2"
                    onPointerDown={(event) => beginDrag(windowState.app, event.clientX, event.clientY)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]">
                        <LayoutGrid className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t(APP_LABELS.find((app) => app.id === windowState.app)?.labelKey ?? 'workspace.app.overview')}</div>
                        <div className="text-xs text-[var(--workspace-text-muted)]">{hostName} · {hostAddress}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="hidden items-center gap-2 text-xs text-[var(--workspace-text-muted)] md:flex">
                        <Wifi className="h-3.5 w-3.5" />
                        <span>{t('workspace.desktop.connected')}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]"
                          aria-label={t('workspace.desktop.minimizeWindow')}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]"
                          aria-label={t('workspace.desktop.maximizeWindow')}
                        >
                          <Square className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => closeWindow(windowState.app)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[var(--workspace-status-bad-text)]"
                          aria-label={t('workspace.desktop.closeWindow', {
                            app: t(APP_LABELS.find((app) => app.id === windowState.app)?.labelKey ?? 'workspace.app.overview'),
                          })}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div
                    className={cn(
                      'min-h-0 flex-1',
                      windowState.app === 'browser'
                        ? 'overflow-hidden p-0'
                        : 'overflow-auto p-4 md:p-5',
                    )}
                    onMouseDown={() => focusWindow(windowState.app)}
                  >
                    {renderWindowBody(windowState.app)}
                  </div>
                </section>
              ))}
          </div>
        )}
      </div>

      <div
        data-testid="workspace-desktop-taskbar"
        className="flex w-full min-w-0 items-center justify-between gap-3 border-t border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] px-3 py-2 backdrop-blur-xl"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSelectApp('overview')}
            className="flex items-center gap-2 rounded-xl border border-[color:var(--workspace-border-glow)] bg-[linear-gradient(180deg,var(--workspace-primary-400),var(--workspace-primary-500))] px-4 py-2 text-sm font-semibold text-[var(--workspace-primary-foreground)] shadow-[0_10px_26px_var(--workspace-accent-muted)] hover:brightness-110"
          >
            <LayoutGrid className="h-4 w-4" />
            Start
          </button>
          <div className="mx-1 h-6 w-px bg-[color:var(--workspace-border-strong)]" />
          <div className="hidden items-center gap-1 md:flex">
            {TASKBAR_APPS.map((app) => {
              const isOpen = windows.some((w) => w.app === app.id)
              const isActive = isOpen && activeApp === app.id
              return (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => openDesktopApp(app.id)}
                  className={cn(
                    'relative rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                    isActive
                      ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)]'
                      : isOpen
                        ? 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]'
                        : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
                  )}
                >
                  {t(app.labelKey)}
                  {isActive && (
                    <span className="absolute bottom-0 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-[color:var(--workspace-primary-400)]" />
                  )}
                  {isOpen && !isActive && (
                    <span className="absolute bottom-0 left-1/2 h-0.5 w-1.5 -translate-x-1/2 rounded-full bg-[color:var(--workspace-text-subtle)]" />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]">
          <div className="hidden items-center gap-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2 md:flex">
            <Search className="h-3.5 w-3.5" />
            <span>{t('workspace.desktop.search')}</span>
          </div>
          <div className="hidden items-center gap-3 px-2 md:flex">
            <Wifi className="h-4 w-4" />
            <Volume2 className="h-4 w-4" />
          </div>
          <div className="flex flex-col items-end leading-none rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-1.5">
            <span className="text-[11px] font-bold text-[var(--workspace-text-strong)]">
              <LiveClock />
            </span>
            <span className="mt-0.5 text-[9px] text-[var(--workspace-text-subtle)]">
              <LiveDate />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
