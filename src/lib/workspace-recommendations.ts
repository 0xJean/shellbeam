import type { WorkspaceAppId } from '@/lib/workspace'
import { t } from './i18n'

export interface WorkspaceRecommendation {
  id: string
  title: string
  targetApp: WorkspaceAppId
}

export interface WorkspaceRecommendationInput {
  diskUsagePercent?: number
  cpuUsagePercent?: number
  memoryUsagePercent?: number
  failedServiceCount?: number
  openAlertCount?: number
  offline?: boolean
  hasNginx?: boolean
  hasDocker?: boolean
}

export function getWorkspaceRecommendations(input: WorkspaceRecommendationInput): WorkspaceRecommendation[] {
  const items: WorkspaceRecommendation[] = []

  if ((input.diskUsagePercent ?? 0) >= 85) {
    items.push({ id: 'disk', title: t('workspace.recommendation.disk'), targetApp: 'fileSystem' })
  }
  if ((input.cpuUsagePercent ?? 0) >= 85 || (input.memoryUsagePercent ?? 0) >= 85) items.push({ id: 'processes', title: t('workspace.diagnostics.recommendation.processes'), targetApp: 'processes' })
  if ((input.failedServiceCount ?? 0) > 0) items.push({ id: 'failed-services', title: t('workspace.diagnostics.recommendation.services'), targetApp: 'services' })
  if ((input.openAlertCount ?? 0) > 0) items.push({ id: 'alerts', title: t('workspace.diagnostics.recommendation.logs'), targetApp: 'logs' })
  if (input.offline) items.push({ id: 'offline', title: t('workspace.diagnostics.recommendation.connection'), targetApp: 'terminal' })

  if (input.hasNginx && !(input.failedServiceCount ?? 0)) {
    items.push({ id: 'nginx', title: t('workspace.recommendation.nginx'), targetApp: 'services' })
  }

  if (input.hasDocker) {
    items.push({ id: 'docker', title: t('workspace.recommendation.docker'), targetApp: 'terminal' })
  }

  return items
}
