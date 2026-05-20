import type { WorkspaceAppId } from '@/lib/workspace'
import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import {
  getWorkspaceRecommendations,
  type WorkspaceRecommendation,
} from '@/lib/workspace-recommendations'
import { WorkspaceActivityFeed, type WorkspaceActivityItem } from './workspace-activity-feed'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceStatusCards } from './workspace-status-cards'
import { getHostInventoryResource, HostMetadataLine, resolveHostForDisplay } from '../host-display-meta'

interface WorkspaceOverviewProps {
  hostName: string
  hostAddress: string
  hostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
  activityItems?: WorkspaceActivityItem[]
  recommendations?: WorkspaceRecommendation[]
}

export function WorkspaceOverview({
  hostName,
  hostAddress,
  hostId = null,
  hosts = [],
  resolveAuthSecret,
  activeApp,
  onSelectApp,
  activityItems = [],
  recommendations,
}: WorkspaceOverviewProps) {
  const resolvedRecommendations = recommendations ?? getWorkspaceRecommendations({})
  const activeHost = resolveHostForDisplay(hosts, hostId, hostAddress)
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border/60 bg-card px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">{t('workspace.mode.workspace')}</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{hostName}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{hostAddress}</span>
          <HostMetadataLine
            network={activeHost ? networkByAddress[activeHost.address] : undefined}
            resource={getHostInventoryResource(activeHost, inventoryStates)}
            className="text-sm text-muted-foreground"
            itemClassName="max-w-[11rem]"
            iconClassName="h-3.5 w-3.5"
          />
        </div>
      </div>

      <WorkspaceStatusCards
        hostAddress={hostAddress}
        selectedHostId={hostId}
        hosts={hosts}
        resolveAuthSecret={resolveAuthSecret}
      />

      <section className="space-y-3">
        <div className="text-sm font-semibold">{t('workspace.section.applications')}</div>
        <WorkspaceAppGrid activeApp={activeApp} onSelectApp={onSelectApp} />
      </section>

      <section className="space-y-3">
        <div className="text-sm font-semibold">{t('workspace.section.activity')}</div>
        <WorkspaceActivityFeed items={activityItems} />
      </section>

      <section className="space-y-3">
        <div className="text-sm font-semibold">{t('workspace.section.recommendations')}</div>
        <div className="space-y-2">
          {resolvedRecommendations.map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-2xl border border-border/60 bg-card/80 px-4 py-3">
              <div className="text-sm font-medium">{item.title}</div>
              <button
                type="button"
                onClick={() => onSelectApp(item.targetApp)}
                className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
              >
                {item.targetApp === 'fileTransfer'
                  ? t('workspace.action.openFiles')
                  : item.targetApp === 'services'
                    ? t('workspace.action.openServices')
                    : t('workspace.action.openTerminal')}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
