import type { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import type { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { Plus, Server, SquareTerminal } from 'lucide-react'
import { getHostInventoryResource, HostMetadataLine } from '../host-display-meta'
import { WorkspaceOsIcon } from '../workspace/workspace-os-icon'
import { sheetPrimaryButton, sheetTintedButton } from './mobile-terminal-styles'

interface MobileNoSessionProps {
  hosts: HostProfile[]
  networkByAddress: ReturnType<typeof useHostNetworkMetadata>
  inventoryStates: ReturnType<typeof useWorkspaceInventoryStates>
  onNewConnection: () => void
  onOpenLocalTerminal: () => void
  onConnectHost?: (hostId: string) => void
}

export function MobileNoSession({ hosts, networkByAddress, inventoryStates, onNewConnection, onOpenLocalTerminal, onConnectHost }: MobileNoSessionProps) {
  const { t, locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const recentHosts = [...hosts]
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, 5)
  const groupLabel = (group: string) => { const label = t(`group.${group}`); return label !== `group.${group}` ? label : group }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
      <h1 className="pb-4 pt-6 text-[30px] font-bold leading-tight text-[var(--workspace-text-strong)]">{copy.sessions}</h1>
      <section className="sb-card flex flex-col items-center px-4 pb-4 pt-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
          <SquareTerminal className="h-7 w-7" aria-hidden="true" />
        </div>
        <p className="mt-4 text-[17px] font-semibold text-[var(--workspace-text-strong)]">{t('mobile.noSessions')}</p>
        <p className="mt-1 text-sm text-[var(--workspace-text-muted)]">{t('mobile.noSessionsHint')}</p>
        <div className="mt-4 flex w-full gap-3">
          <button type="button" onClick={onNewConnection} className={sheetPrimaryButton}><Plus className="h-4 w-4" />{t('mobile.newConnection')}</button>
          <button type="button" onClick={onOpenLocalTerminal} className={sheetTintedButton}><SquareTerminal className="h-4 w-4" />{t('mobile.localTerminal')}</button>
        </div>
      </section>

      {recentHosts.length > 0 && onConnectHost && (
        <section className="mt-6">
          <h2 className="mb-2 px-1 text-[13px] text-[var(--workspace-text-muted)]">{fill(copy.quickConnectRecent, { count: recentHosts.length })}</h2>
          <ul className="sb-card overflow-hidden">
            {recentHosts.map((host) => {
              const resource = getHostInventoryResource(host, inventoryStates)
              return (
                <li key={host.id} className="border-b border-[color:var(--workspace-border-soft)] last:border-b-0">
                  <button type="button" onClick={() => onConnectHost(host.id)}
                    className="flex min-h-[60px] w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-[var(--workspace-surface-800)]">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]">
                      {resource?.os ? <WorkspaceOsIcon os={resource.os} className="h-4 w-4" /> : <Server className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-[var(--workspace-text-strong)]">{host.name}</span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--workspace-text-muted)]">
                        <HostMetadataLine network={networkByAddress[host.address]} showSystem={false} showLocationText={false} className="shrink-0 flex-nowrap" iconClassName="h-3 w-3" />
                        <span className="truncate">{host.username ? `${host.username}@${host.address}` : host.address}</span>
                      </span>
                    </span>
                    {host.group && (
                      <span className="shrink-0 rounded-md bg-[var(--workspace-surface-800)] px-2 py-0.5 text-[11px] font-medium text-[var(--workspace-text-muted)]">{groupLabel(host.group)}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
