import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceFilesApp } from './workspace-files-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceOverview } from './workspace-overview'
import { WorkspaceProcessesApp } from './workspace-processes-app'
import { WorkspaceServicesApp } from './workspace-services-app'

const APP_LABELS: Array<{ id: WorkspaceAppId; labelKey: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview' },
  { id: 'files', labelKey: 'workspace.app.files' },
  { id: 'processes', labelKey: 'workspace.app.processes' },
  { id: 'services', labelKey: 'workspace.app.services' },
  { id: 'logs', labelKey: 'workspace.app.logs' },
  { id: 'terminal', labelKey: 'workspace.app.terminal' },
]

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
  const content = (() => {
    if (activeApp === 'overview') {
      return <WorkspaceOverview hostName={hostName} hostAddress={hostAddress} activeApp={activeApp} onSelectApp={onSelectApp} />
    }
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
    <div className="flex h-full min-h-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.16),transparent_32%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.88))] text-slate-50">
      <aside className="hidden w-56 shrink-0 border-r border-white/10 bg-black/15 p-4 md:block">
        <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.24em] text-slate-400">{t('workspace.section.appsPanel')}</div>
          <div className="mt-2 text-lg font-semibold">{hostName}</div>
          <div className="text-xs text-slate-400">{hostAddress}</div>
        </div>
        <div className="mt-4 space-y-1.5">
          {APP_LABELS.map((app) => (
            <button
              key={app.id}
              type="button"
              onClick={() => onSelectApp(app.id)}
              className={cn(
                'flex w-full items-center rounded-xl px-3 py-2 text-left text-sm transition-colors',
                activeApp === app.id ? 'bg-white/12 text-white' : 'text-slate-300 hover:bg-white/8 hover:text-white',
              )}
            >
              {t(app.labelKey)}
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">
        {content}
      </main>
    </div>
  )
}
