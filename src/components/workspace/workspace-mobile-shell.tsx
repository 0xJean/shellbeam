import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceFilesApp } from './workspace-files-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceOverview } from './workspace-overview'
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
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.16),transparent_30%),linear-gradient(180deg,#f8fafc_0%,#e0e7ff_52%,#eef2ff_100%)] p-4 text-slate-950">
      <div className="rounded-[32px] border border-white/60 bg-white/80 px-5 py-5 shadow-[0_20px_50px_rgba(15,23,42,0.12)] backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-slate-500">{t('workspace.mobile.title')}</div>
          <div className="rounded-full bg-slate-950 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white">
            SSH
          </div>
        </div>
        <div className="mt-3 text-3xl font-semibold tracking-tight">{hostName}</div>
        <div className="mt-1 text-sm text-slate-500">{hostAddress}</div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-2xl bg-slate-950/[0.04] px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{t('workspace.mobile.surface')}</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{t('workspace.mobile.touchReady')}</div>
          </div>
          <div className="rounded-2xl bg-slate-950/[0.04] px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{t('workspace.mobile.files')}</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{t('workspace.mobile.live')}</div>
          </div>
          <div className="rounded-2xl bg-slate-950/[0.04] px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{t('workspace.mobile.control')}</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{t('workspace.mobile.quickOps')}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 rounded-[30px] border border-white/50 bg-white/50 p-1.5 shadow-[0_16px_40px_rgba(15,23,42,0.08)] backdrop-blur-xl">
        {content}
      </div>
    </div>
  )
}
