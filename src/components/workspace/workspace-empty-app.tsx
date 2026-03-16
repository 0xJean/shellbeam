import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceEmptyState } from './workspace-empty-state'

interface WorkspaceEmptyAppProps {
  app: WorkspaceAppId
}

export function WorkspaceEmptyApp({ app }: WorkspaceEmptyAppProps) {
  const title = app === 'overview' ? 'Overview' : app.charAt(0).toUpperCase() + app.slice(1)

  return (
    <WorkspaceEmptyState
      title={title}
      description="This workspace app is scaffolded and ready for the next implementation pass."
    />
  )
}
