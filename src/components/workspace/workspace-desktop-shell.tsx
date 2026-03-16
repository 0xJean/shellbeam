import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { Clock3, LayoutGrid, Monitor, Search, Wifi, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceFilesApp } from './workspace-files-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceProcessesApp } from './workspace-processes-app'
import { WorkspaceServicesApp } from './workspace-services-app'
import { WorkspaceStatusCards } from './workspace-status-cards'

const APP_LABELS: Array<{ id: WorkspaceAppId; labelKey: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview' },
  { id: 'files', labelKey: 'workspace.app.files' },
  { id: 'processes', labelKey: 'workspace.app.processes' },
  { id: 'services', labelKey: 'workspace.app.services' },
  { id: 'logs', labelKey: 'workspace.app.logs' },
  { id: 'terminal', labelKey: 'workspace.app.terminal' },
]

const TASKBAR_APPS = APP_LABELS.filter((item) => item.id !== 'overview')

interface WorkspaceDesktopShellProps {
  hostName: string
  hostAddress: string
  hostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

interface DesktopWindowState {
  app: WorkspaceAppId
  x: number
  y: number
  z: number
}

const DEFAULT_WINDOW_POSITIONS: Record<WorkspaceAppId, { x: number; y: number }> = {
  overview: { x: 0, y: 0 },
  files: { x: 170, y: 56 },
  processes: { x: 220, y: 90 },
  services: { x: 250, y: 70 },
  logs: { x: 200, y: 120 },
  terminal: { x: 240, y: 100 },
}

export function WorkspaceDesktopShell({
  hostName,
  hostAddress,
  hostId,
  hosts = [],
  resolveAuthSecret,
  activeApp,
  onSelectApp,
}: WorkspaceDesktopShellProps) {
  const isOverview = activeApp === 'overview'
  const [showIntroPanel, setShowIntroPanel] = useState(true)
  const [showWidgets, setShowWidgets] = useState(true)
  const [windows, setWindows] = useState<DesktopWindowState[]>([])
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
    if (activeApp === 'files') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFilesApp presentation="window" selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
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
    if (activeApp === 'logs') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceLogsApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
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
      setWindows((prev) => prev.map((windowState) => (
        windowState.app === drag.app
          ? {
              ...windowState,
              x: Math.max(112, event.clientX - drag.offsetX),
              y: Math.max(24, event.clientY - drag.offsetY),
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

    if (app === 'files') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFilesApp presentation="window" selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
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
    if (app === 'logs') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceLogsApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={app} />
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[linear-gradient(180deg,#dbeafe_0%,#bfdbfe_40%,#93c5fd_100%)] text-foreground">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.55),transparent_22%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.3),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.15),transparent_42%)]" />
        <div className="absolute left-6 top-6 z-20 hidden md:block">
          <WorkspaceAppGrid activeApp={activeApp} onSelectApp={openDesktopApp} variant="desktop" />
        </div>

        {isOverview ? (
          <div className="relative h-full w-full">
            {showIntroPanel && (
              <div className="absolute left-[8.5rem] top-8 z-10 hidden w-[24rem] rounded-2xl border border-white/55 bg-white/44 px-5 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.14)] backdrop-blur md:block">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-600">{t('workspace.desktop.desktop')}</div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{hostName}</div>
                    <div className="mt-1 text-sm text-slate-700">{hostAddress}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowIntroPanel(false)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-white/50 hover:text-slate-900"
                    aria-label="Close desktop intro"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-4 flex items-center gap-2 text-sm text-slate-700">
                  <Monitor className="h-4 w-4" />
                  <span>{t('workspace.desktop.ready')}</span>
                </div>
              </div>
            )}

            {showWidgets && (
              <div className="absolute bottom-8 right-8 z-10 hidden w-[26rem] space-y-4 md:block">
                <div className="rounded-[24px] border border-white/65 bg-white/52 px-4 py-4 shadow-[0_16px_36px_rgba(15,23,42,0.15)] backdrop-blur">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-600">{t('workspace.desktop.widgetStack')}</div>
                    <button
                      type="button"
                      onClick={() => setShowWidgets(false)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 hover:bg-white/50 hover:text-slate-900"
                      aria-label="Close desktop widgets"
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
                <div className="rounded-[24px] border border-white/65 bg-white/52 px-4 py-4 shadow-[0_16px_36px_rgba(15,23,42,0.15)] backdrop-blur">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-600">{t('workspace.desktop.quickHint')}</div>
                  <div className="mt-3 text-sm font-medium text-slate-900">{t('workspace.desktop.doubleClickHint')}</div>
                  <div className="mt-1 text-sm text-slate-700">{t('workspace.desktop.taskbarHint')}</div>
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
                  className="absolute flex min-h-[24rem] min-w-0 flex-col overflow-hidden rounded-[22px] border border-white/72 bg-white/82 shadow-[0_18px_48px_rgba(15,23,42,0.20)] backdrop-blur"
                  style={{
                    left: windowState.x,
                    top: windowState.y,
                    width: 'min(1080px, calc(100vw - 22rem))',
                    height: 'min(720px, calc(100vh - 11rem))',
                    zIndex: windowState.z,
                  }}
                >
                  <div
                    className="flex cursor-move items-center justify-between gap-4 border-b border-slate-200/80 bg-white/84 px-4 py-3"
                    onPointerDown={(event) => beginDrag(windowState.app, event.clientX, event.clientY)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700">
                        <LayoutGrid className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold">{t(APP_LABELS.find((app) => app.id === windowState.app)?.labelKey ?? 'workspace.app.overview')}</div>
                        <div className="text-xs text-muted-foreground">{hostName} · {hostAddress}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="hidden items-center gap-2 text-xs text-slate-600 md:flex">
                        <Wifi className="h-3.5 w-3.5" />
                        <span>{t('workspace.desktop.connected')}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => closeWindow(windowState.app)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-red-50 hover:text-red-600"
                        aria-label={`Close ${t(APP_LABELS.find((app) => app.id === windowState.app)?.labelKey ?? 'workspace.app.overview')} window`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div
                    className="min-h-0 flex-1 overflow-auto p-4 md:p-5"
                    onMouseDown={() => focusWindow(windowState.app)}
                  >
                    {renderWindowBody(windowState.app)}
                  </div>
                </section>
              ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-200/70 bg-white/80 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSelectApp('overview')}
            className="flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-700"
          >
            <LayoutGrid className="h-4 w-4" />
            Start
          </button>
          <div className="hidden items-center gap-1.5 md:flex">
            {TASKBAR_APPS.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => openDesktopApp(app.id)}
                className={cn(
                  'rounded-xl border px-3 py-2 text-xs font-medium transition-colors',
                  windows.some((windowState) => windowState.app === app.id) && activeApp === app.id
                    ? 'border-sky-300 bg-sky-100 text-sky-800'
                    : 'border-white/70 bg-white/65 text-slate-700 hover:bg-white',
                )}
              >
                {t(app.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-700">
          <div className="hidden items-center gap-1 rounded-lg border border-white/70 bg-white/60 px-3 py-2 md:flex">
            <Search className="h-3.5 w-3.5" />
            <span>{t('workspace.desktop.search')}</span>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-white/70 bg-white/60 px-3 py-2">
            <Clock3 className="h-3.5 w-3.5" />
            <span>09:41</span>
          </div>
        </div>
      </div>
    </div>
  )
}
