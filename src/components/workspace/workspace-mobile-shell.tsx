import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceOverview } from './workspace-overview'

interface WorkspaceMobileShellProps {
  hostName: string
  hostAddress: string
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

export function WorkspaceMobileShell({
  hostName,
  hostAddress,
  activeApp,
  onSelectApp,
}: WorkspaceMobileShellProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-[linear-gradient(180deg,#f8fafc_0%,#eef2ff_100%)] p-4 text-slate-950">
      <div className="rounded-[28px] bg-white/90 px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.10)]">
        <div className="text-sm font-medium text-slate-500">Server Workspace</div>
        <div className="mt-2 text-3xl font-semibold tracking-tight">{hostName}</div>
        <div className="mt-1 text-sm text-slate-500">{hostAddress}</div>
      </div>

      <div className="mt-4 min-h-0 flex-1">
        {activeApp === 'overview'
          ? <WorkspaceOverview hostName={hostName} hostAddress={hostAddress} activeApp={activeApp} onSelectApp={onSelectApp} />
          : <WorkspaceEmptyApp app={activeApp} />}
      </div>
    </div>
  )
}
