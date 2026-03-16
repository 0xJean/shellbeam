import type { HostProfile } from '@/lib/hosts'
import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceDesktopShell } from './workspace-desktop-shell'
import { WorkspaceMobileShell } from './workspace-mobile-shell'

interface WorkspaceShellProps {
  mobile: boolean
  hostName: string
  hostAddress: string
  hostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  if (props.mobile) {
    return <WorkspaceMobileShell {...props} />
  }

  return <WorkspaceDesktopShell {...props} />
}
