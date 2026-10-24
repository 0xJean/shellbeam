import { describe, expect, it } from 'vitest'
import { getWorkspaceRecommendations } from './workspace-recommendations'
describe('workspace diagnostic recommendations', () => {
  it('routes resource pressure, failed services, alerts and connection failure to diagnostic apps', () => {
    expect(getWorkspaceRecommendations({ diskUsagePercent: 95, cpuUsagePercent: 90, failedServiceCount: 1, openAlertCount: 2, offline: true }).map((item) => item.targetApp)).toEqual(['fileSystem', 'processes', 'services', 'logs', 'terminal'])
  })
  it('does not invent incidents when no actual observation is available', () => {
    expect(getWorkspaceRecommendations({})).toEqual([])
  })
})
