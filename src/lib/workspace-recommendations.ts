import type { WorkspaceAppId } from '@/lib/workspace'
import { t } from './i18n'

export interface WorkspaceRecommendation {
  id: string
  title: string
  targetApp: WorkspaceAppId
}

export interface WorkspaceRecommendationInput {
  diskUsagePercent?: number
  hasNginx?: boolean
  hasDocker?: boolean
}

export function getWorkspaceRecommendations(input: WorkspaceRecommendationInput): WorkspaceRecommendation[] {
  const items: WorkspaceRecommendation[] = []

  if ((input.diskUsagePercent ?? 0) >= 85) {
    items.push({ id: 'disk', title: t('workspace.recommendation.disk'), targetApp: 'fileTransfer' })
  }

  if (input.hasNginx) {
    items.push({ id: 'nginx', title: t('workspace.recommendation.nginx'), targetApp: 'services' })
  }

  if (input.hasDocker) {
    items.push({ id: 'docker', title: t('workspace.recommendation.docker'), targetApp: 'terminal' })
  }

  return items
}
