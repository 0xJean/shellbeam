export interface WorkspaceActivityItem {
  id: string
  label: string
  detail?: string
}

interface WorkspaceActivityFeedProps {
  items: WorkspaceActivityItem[]
}

export function WorkspaceActivityFeed({ items }: WorkspaceActivityFeedProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
        No recent activity yet
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className="rounded-2xl border border-border/60 bg-card/80 px-4 py-3">
          <div className="text-sm font-medium">{item.label}</div>
          {item.detail && <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>}
        </div>
      ))}
    </div>
  )
}
