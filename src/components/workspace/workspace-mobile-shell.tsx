import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { ArrowLeft, BatteryFull, Search, Signal, Wifi } from 'lucide-react'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceFilesApp } from './workspace-files-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceProcessesApp } from './workspace-processes-app'
import { WorkspaceServicesApp } from './workspace-services-app'

interface WorkspaceMobileShellProps {
  hostName: string
  hostAddress: string
  hostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

export function WorkspaceMobileShell({
  hostName,
  hostAddress,
  hostId,
  hosts = [],
  resolveAuthSecret,
  activeApp,
  onSelectApp,
}: WorkspaceMobileShellProps) {
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

  const dockApps: WorkspaceAppId[] = ['overview', 'files', 'services', 'logs']
  const isOverview = activeApp === 'overview'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[linear-gradient(180deg,#dbeafe_0%,#eff6ff_36%,#f8fafc_100%)] text-foreground">
      <div className="flex items-center justify-between px-5 pb-3 pt-4 text-sm font-semibold text-slate-900">
        <span>9:41</span>
        <div className="flex items-center gap-1.5 text-slate-700">
          <Signal className="h-4 w-4" />
          <Wifi className="h-4 w-4" />
          <BatteryFull className="h-4 w-4" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4">
        {isOverview ? (
          <div className="space-y-5 pb-6">
            <div>
              <div className="text-sm font-medium text-slate-600">{t('workspace.mobile.title')}</div>
              <div className="mt-1 text-4xl font-semibold tracking-tight text-slate-950">Home Screen</div>
              <div className="mt-1 text-sm text-slate-600">{hostName} · {hostAddress}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[26px] border border-white/70 bg-white/70 px-4 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.10)] backdrop-blur">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t('workspace.mobile.surface')}</div>
                <div className="mt-3 text-2xl font-semibold text-slate-950">{t('workspace.mobile.touchReady')}</div>
                <div className="mt-2 text-sm text-slate-600">{hostName}</div>
              </div>
              <div className="rounded-[26px] border border-white/70 bg-white/70 px-4 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.10)] backdrop-blur">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t('workspace.mobile.control')}</div>
                <div className="mt-3 text-2xl font-semibold text-slate-950">{t('workspace.mobile.quickOps')}</div>
                <div className="mt-2 text-sm text-slate-600">{hostAddress}</div>
              </div>
            </div>

            <div className="flex items-center justify-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-900/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-400/40" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-400/40" />
            </div>

            <div className="rounded-[32px] border border-white/65 bg-white/28 px-3 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] backdrop-blur-sm">
              <div className="mb-4 text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">{t('workspace.section.applications')}</div>
              <div className="min-h-[22rem]">
                <WorkspaceAppGrid activeApp={activeApp} onSelectApp={onSelectApp} variant="mobile" />
              </div>
            </div>
          </div>
        ) : (
          <div className="pb-6">
            <div className="mb-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => onSelectApp('overview')}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/70 bg-white/75 text-slate-800 shadow-sm"
                aria-label="Back to Home Screen"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div>
                <div className="text-sm font-medium text-slate-600">{hostName}</div>
                <div className="text-2xl font-semibold tracking-tight text-slate-950">{t(`workspace.app.${activeApp}`)}</div>
              </div>
            </div>

            <div className="overflow-hidden rounded-[30px] border border-white/70 bg-white/78 shadow-[0_14px_36px_rgba(15,23,42,0.12)] backdrop-blur">
              <div className="flex items-center justify-between border-b border-slate-200/80 px-4 py-3 text-sm font-semibold text-slate-900">
                <span>{t('workspace.mobile.title')}</span>
                <Search className="h-4 w-4 text-slate-500" />
              </div>
              <div className="min-h-0 p-3">
                {content}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 pb-3 pt-2">
        <div className="rounded-[30px] border border-white/70 bg-white/72 px-3 py-3 shadow-[0_10px_28px_rgba(15,23,42,0.10)] backdrop-blur">
          <WorkspaceAppGrid
            activeApp={activeApp}
            onSelectApp={onSelectApp}
            variant="mobile"
            apps={dockApps}
          />
        </div>
        <div className="mx-auto mt-3 h-1.5 w-32 rounded-full bg-slate-900/80" />
      </div>
    </div>
  )
}
