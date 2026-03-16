import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { Clock3, LayoutGrid, Monitor, Search, Wifi } from 'lucide-react'
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

  const content = (() => {
    if (activeApp === 'files') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceFilesApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'processes') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceProcessesApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'services') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceServicesApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'logs') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceLogsApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    return <WorkspaceEmptyApp app={activeApp} />
  })()

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[linear-gradient(180deg,#dbeafe_0%,#bfdbfe_40%,#93c5fd_100%)] text-foreground">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.55),transparent_22%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.3),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.15),transparent_42%)]" />
        <div className="absolute left-6 top-6 hidden md:block">
          <WorkspaceAppGrid activeApp={activeApp} onSelectApp={onSelectApp} variant="desktop" />
        </div>

        {isOverview ? (
          <div className="relative h-full w-full">
            <div className="absolute left-36 top-8 hidden rounded-2xl border border-white/55 bg-white/40 px-5 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.14)] backdrop-blur md:block">
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-600">{t('workspace.desktop.desktop')}</div>
              <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{hostName}</div>
              <div className="mt-1 text-sm text-slate-700">{hostAddress}</div>
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-700">
                <Monitor className="h-4 w-4" />
                <span>{t('workspace.desktop.ready')}</span>
              </div>
            </div>

            <div className="absolute bottom-8 right-8 hidden w-[26rem] space-y-4 md:block">
              <div className="rounded-[24px] border border-white/65 bg-white/52 px-4 py-4 shadow-[0_16px_36px_rgba(15,23,42,0.15)] backdrop-blur">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-600">{t('workspace.desktop.widgetStack')}</div>
                <WorkspaceStatusCards hostAddress={hostAddress} />
              </div>
              <div className="rounded-[24px] border border-white/65 bg-white/52 px-4 py-4 shadow-[0_16px_36px_rgba(15,23,42,0.15)] backdrop-blur">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-600">{t('workspace.desktop.quickHint')}</div>
                <div className="mt-3 text-sm font-medium text-slate-900">{t('workspace.desktop.doubleClickHint')}</div>
                <div className="mt-1 text-sm text-slate-700">{t('workspace.desktop.taskbarHint')}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="relative flex h-full min-h-0 items-start justify-center px-4 py-5 md:px-10 md:py-8">
            <main className="flex h-full min-h-[24rem] min-w-0 w-full max-w-[1080px] flex-col overflow-hidden rounded-[22px] border border-white/72 bg-white/76 shadow-[0_18px_48px_rgba(15,23,42,0.20)] backdrop-blur">
              <div className="flex items-center justify-between gap-4 border-b border-slate-200/80 bg-white/80 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700">
                    <LayoutGrid className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{t(APP_LABELS.find((app) => app.id === activeApp)?.labelKey ?? 'workspace.app.overview')}</div>
                    <div className="text-xs text-muted-foreground">{hostName} · {hostAddress}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <Wifi className="h-3.5 w-3.5" />
                  <span>{t('workspace.desktop.connected')}</span>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4 md:p-5">
                {content}
              </div>
            </main>
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
                onClick={() => onSelectApp(app.id)}
                className={cn(
                  'rounded-xl border px-3 py-2 text-xs font-medium transition-colors',
                  activeApp === app.id
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
