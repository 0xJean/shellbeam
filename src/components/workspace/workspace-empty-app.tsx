import type { WorkspaceAppId } from '@/lib/workspace'
import { useT } from '@/lib/i18n'
import { WorkspaceEmptyState } from './workspace-empty-state'

interface WorkspaceEmptyAppProps {
  app: WorkspaceAppId
}

export function WorkspaceEmptyApp({ app }: WorkspaceEmptyAppProps) {
  const { t } = useT()

  return (
    <WorkspaceEmptyState
      title={t(`workspace.app.${app}`)}
      description={t('workspace.emptyApp.description')}
    />
  )
}
