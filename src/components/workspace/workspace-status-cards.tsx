interface WorkspaceStatusCardsProps {
  hostAddress: string
}

const STATUS_CARDS = [
  { label: 'CPU', value: 'Normal' },
  { label: 'Memory', value: 'Stable' },
  { label: 'Disk', value: 'Healthy' },
  { label: 'Network', value: 'Connected' },
]

export function WorkspaceStatusCards({ hostAddress }: WorkspaceStatusCardsProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {STATUS_CARDS.map((card) => (
        <div key={card.label} className="rounded-2xl border border-border/60 bg-card/80 p-4">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">{card.label}</div>
          <div className="mt-3 text-base font-semibold">{card.value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{hostAddress}</div>
        </div>
      ))}
    </div>
  )
}
