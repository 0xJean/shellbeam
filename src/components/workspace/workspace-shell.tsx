import type { HostProfile } from '@/lib/hosts'
import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceDesktopShell } from './workspace-desktop-shell'
import { WorkspaceMobileShell } from './workspace-mobile-shell'

interface WorkspaceShellProps {
  activeVaultId?: string
  sessionVaultId?: string
  sessionId: string
  mobile: boolean
  hostName: string
  hostAddress: string
  hostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
  onOpenTerminal?: (host: HostProfile) => void
  onOpenProviderConsole?: (url: string, host: HostProfile) => void
  onEditHost?: (host: HostProfile) => void
  onBrowserCloseRequest?: () => void
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  if (props.mobile) {
    return <WorkspaceMobileShell {...props} />
  }

  return <WorkspaceDesktopShell {...props} />
}
