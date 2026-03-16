import type { WorkspaceAppId } from '@/lib/workspace'

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
    items.push({ id: 'disk', title: 'Disk is getting full', targetApp: 'files' })
  }

  if (input.hasNginx) {
    items.push({ id: 'nginx', title: 'Nginx is running', targetApp: 'services' })
  }

  if (input.hasDocker) {
    items.push({ id: 'docker', title: 'Docker is available', targetApp: 'terminal' })
  }

  return items
}
