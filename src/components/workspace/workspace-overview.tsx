import type { WorkspaceAppId } from '@/lib/workspace'
import {
  getWorkspaceRecommendations,
  type WorkspaceRecommendation,
} from '@/lib/workspace-recommendations'
import { WorkspaceActivityFeed, type WorkspaceActivityItem } from './workspace-activity-feed'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceStatusCards } from './workspace-status-cards'

interface WorkspaceOverviewProps {
  hostName: string
  hostAddress: string
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
  activityItems?: WorkspaceActivityItem[]
  recommendations?: WorkspaceRecommendation[]
}

export function WorkspaceOverview({
  hostName,
  hostAddress,
  activeApp,
  onSelectApp,
  activityItems = [],
  recommendations,
}: WorkspaceOverviewProps) {
  const resolvedRecommendations = recommendations ?? getWorkspaceRecommendations({})

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Workspace</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{hostName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{hostAddress}</p>
      </div>

      <WorkspaceStatusCards hostAddress={hostAddress} />

      <section className="space-y-3">
        <div className="text-sm font-semibold">Applications</div>
        <WorkspaceAppGrid activeApp={activeApp} onSelectApp={onSelectApp} />
      </section>

      <section className="space-y-3">
        <div className="text-sm font-semibold">Recent Activity</div>
        <WorkspaceActivityFeed items={activityItems} />
      </section>

      <section className="space-y-3">
        <div className="text-sm font-semibold">Recommendations</div>
        <div className="space-y-2">
          {resolvedRecommendations.map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-2xl border border-border/60 bg-card/80 px-4 py-3">
              <div className="text-sm font-medium">{item.title}</div>
              <button
                type="button"
                onClick={() => onSelectApp(item.targetApp)}
                className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
              >
                Open {item.targetApp === 'files' ? 'Files' : item.targetApp === 'services' ? 'Services' : 'Terminal'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
