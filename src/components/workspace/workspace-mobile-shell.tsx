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
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background px-4 py-4 text-foreground">
      <div className="rounded-2xl border border-border/60 bg-card px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-muted-foreground">{t('workspace.mobile.title')}</div>
          <div className="rounded-full bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            SSH
          </div>
        </div>
        <div className="mt-3 text-3xl font-semibold tracking-tight">{hostName}</div>
        <div className="mt-1 text-sm text-muted-foreground">{hostAddress}</div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-border/50 bg-muted/30 px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('workspace.mobile.surface')}</div>
            <div className="mt-2 text-sm font-semibold">{t('workspace.mobile.touchReady')}</div>
          </div>
          <div className="rounded-xl border border-border/50 bg-muted/30 px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('workspace.mobile.files')}</div>
            <div className="mt-2 text-sm font-semibold">{t('workspace.mobile.live')}</div>
          </div>
          <div className="rounded-xl border border-border/50 bg-muted/30 px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('workspace.mobile.control')}</div>
            <div className="mt-2 text-sm font-semibold">{t('workspace.mobile.quickOps')}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1">
        {content}
      </div>
    </div>
  )
}
