import { SftpDualPane } from '@/components/sftp-dual-pane'
import type { HostProfile } from '@/lib/hosts'
import { WorkspaceEmptyState } from './workspace-empty-state'

interface WorkspaceFilesAppProps {
  selectedHostId?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

export function WorkspaceFilesApp({
  selectedHostId = null,
  hosts,
  resolveAuthSecret,
}: WorkspaceFilesAppProps) {
  const activeHostId = selectedHostId

  if (!activeHostId) {
    return (
      <WorkspaceEmptyState
        title="Remote Files"
        description="Connect a remote host to browse files here."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Files</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Remote Files</h2>
        <p className="mt-1 text-sm text-muted-foreground">Browse remote paths visually, then drop back to the terminal when you need precision.</p>
      </div>
      <div className="rounded-[28px] border border-border/60 bg-card/70 p-3">
        <SftpDualPane
          hosts={hosts}
          selectedHostId={activeHostId}
          resolveAuthSecret={resolveAuthSecret}
        />
      </div>
    </div>
  )
}
