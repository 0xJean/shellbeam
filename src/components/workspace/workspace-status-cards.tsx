import { t } from '@/lib/i18n'

interface WorkspaceStatusCardsProps {
  hostAddress: string
}

const STATUS_CARDS = [
  { labelKey: 'workspace.status.cpu', valueKey: 'workspace.statusValue.normal' },
  { labelKey: 'workspace.status.memory', valueKey: 'workspace.statusValue.stable' },
  { labelKey: 'workspace.status.disk', valueKey: 'workspace.statusValue.healthy' },
  { labelKey: 'workspace.status.network', valueKey: 'workspace.statusValue.connected' },
]

export function WorkspaceStatusCards({ hostAddress }: WorkspaceStatusCardsProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {STATUS_CARDS.map((card) => (
        <div key={card.labelKey} className="rounded-2xl border border-border/60 bg-card/80 p-4">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">{t(card.labelKey)}</div>
          <div className="mt-3 text-base font-semibold">{t(card.valueKey)}</div>
          <div className="mt-1 text-xs text-muted-foreground">{hostAddress}</div>
        </div>
      ))}
    </div>
  )
}
