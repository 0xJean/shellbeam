import { Pencil, Plug, RefreshCcwDot } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { connectionStatesCopy } from '@/lib/locales/connection-states'
import { Button } from '../ui/button'
import { hasSshConnection, hostConnectionKey, type HostProfile } from '@/lib/hosts'
import type { WorkspaceAppId } from '@/lib/workspace'
import { SessionStateCard } from './session-state-card'
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
  const { t, locale } = useT()
  const host = props.hosts?.find(h => h.id === props.hostId && (!h.vaultId || h.vaultId === props.activeVaultId))
  if (props.sessionConnectionKey && (!host || hostConnectionKey(host) !== props.sessionConnectionKey)) {
    const copy = connectionStatesCopy[locale] ?? connectionStatesCopy.en
    return <SessionStateCard tone="warn" icon={<RefreshCcwDot />} title={copy.sessionChangedTitle} description={t('hostDirectory.sessionChanged')} className="h-full items-center">
      {host && (hasSshConnection(host)
        ? <>
            {props.onOpenTerminal && <Button size="sm" className="gap-1.5" onClick={() => props.onOpenTerminal?.(host)}><Plug className="h-3.5 w-3.5" />{copy.connectWithNew}</Button>}
            {props.onEditHost && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => props.onEditHost?.(host)}><Pencil className="h-3.5 w-3.5" />{copy.viewHost}</Button>}
          </>
        : props.onEditHost && <Button size="sm" onClick={() => props.onEditHost?.(host)}>{t('hostDirectory.addSsh')}</Button>)}
    </SessionStateCard>
  }
  if (props.mobile) {
    return <WorkspaceMobileShell {...props} />
  }

  return <WorkspaceDesktopShell {...props} />
}
