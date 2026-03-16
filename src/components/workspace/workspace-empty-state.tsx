interface WorkspaceEmptyStateProps {
  title: string
  description: string
}

export function WorkspaceEmptyState({ title, description }: WorkspaceEmptyStateProps) {
  return (
    <div className="rounded-3xl border border-dashed border-border/60 bg-card/40 px-6 py-10 text-center">
      <div className="text-base font-semibold">{title}</div>
      <div className="mt-2 text-sm text-muted-foreground">{description}</div>
    </div>
  )
}
