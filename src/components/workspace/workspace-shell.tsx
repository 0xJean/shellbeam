import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceDesktopShell } from './workspace-desktop-shell'
import { WorkspaceMobileShell } from './workspace-mobile-shell'

interface WorkspaceShellProps {
  mobile: boolean
  hostName: string
  hostAddress: string
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  if (props.mobile) {
    return <WorkspaceMobileShell {...props} />
  }

  return <WorkspaceDesktopShell {...props} />
}
