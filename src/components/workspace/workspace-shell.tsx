import { useT } from '@/lib/i18n'
import { Button } from '../ui/button'
import { hasSshConnection, hostConnectionKey, type HostProfile } from '@/lib/hosts'
import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceDesktopShell } from './workspace-desktop-shell'
import { WorkspaceMobileShell } from './workspace-mobile-shell'

interface WorkspaceShellProps {
  activeVaultId?: string
  sessionConnectionKey?: string
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
  const { t } = useT()
  const host = props.hosts?.find(h => h.id === props.hostId && (!h.vaultId || h.vaultId === props.activeVaultId))
  if (props.sessionConnectionKey && (!host || hostConnectionKey(host) !== props.sessionConnectionKey)) {
    return <div role="status" className="space-y-3 p-6"><p>{t('hostDirectory.sessionChanged')}</p>
      {host && (hasSshConnection(host)
        ? props.onOpenTerminal && <Button onClick={() => props.onOpenTerminal?.(host)}>{t('hostCard.connect')}</Button>
        : props.onEditHost && <Button onClick={() => props.onEditHost?.(host)}>{t('hostDirectory.addSsh')}</Button>)}
    </div>
  }
  if (props.mobile) {
    return <WorkspaceMobileShell {...props} />
  }

  return <WorkspaceDesktopShell {...props} />
}
