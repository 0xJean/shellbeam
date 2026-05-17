import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWorkspaceInventoryCache,
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryCache,
  parseWorkspaceInventory,
  saveWorkspaceInventoryCacheEntry,
} from './workspace-inventory'

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'password' as const,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

describe('workspace inventory parser', () => {
  afterEach(() => {
    clearWorkspaceInventoryCache()
  })

  it('parses host resources, tools, services, containers, pm2, and projects', () => {
    const inventory = parseWorkspaceInventory(`
__SB_HOSTNAME=vps-prod-1
__SB_OS=Ubuntu 24.04 LTS
__SB_KERNEL=Linux 6.8
__SB_UPTIME=3 days
__SB_CPU=18
__SB_MEMORY=64|1280M/2000M
__SB_DISK=71|36G/50G
__SB_NETWORK=12.5 KB/s
__SB_TOOL=nginx|Nginx|web|nginx|/usr/sbin/nginx|nginx version: nginx/1.24.0
__SB_TOOL=node|Node.js|runtime|node|/usr/bin/node|v22.1.0
__SB_SERVICE=nginx|active|enabled
__SB_DOCKER=api|ghcr.io/acme/api:latest|Up 2 hours|0.0.0.0:3000->3000/tcp
__SB_PM2=web online 1.2.3
__SB_PROJECT=/var/www/acme|node|acme|2026-05-15 10:20
`)

    expect(inventory.resource.hostname).toBe('vps-prod-1')
    expect(inventory.resource.memoryPercent).toBe(64)
    expect(inventory.resource.diskText).toBe('36G/50G')
    expect(inventory.tools.map((tool) => tool.id)).toEqual(['nginx', 'node'])
    expect(inventory.services[0]).toMatchObject({ name: 'nginx', active: 'active' })
    expect(inventory.containers[0]).toMatchObject({ name: 'api', image: 'ghcr.io/acme/api:latest' })
    expect(inventory.pm2[0].raw).toContain('web online')
    expect(inventory.projects[0]).toMatchObject({ path: '/var/www/acme', kind: 'node', name: 'acme' })
  })

  it('normalizes common deployment directories and merges duplicate project markers', () => {
    const inventory = parseWorkspaceInventory(`
__SB_PROJECT=/var/www/predict-game/releases/20260402-121659|node|20260402-121659|2026-04-02 12:16
__SB_PROJECT=/var/www/predict-game/releases/20260402-122658|node|20260402-122658|2026-04-02 12:26
__SB_PROJECT=/opt/satoshi-dao/current|node|satoshi|2026-05-01 10:20
__SB_PROJECT=/opt/satoshi-dao/current|compose|current|2026-05-01 10:21
`)

    expect(inventory.projects).toHaveLength(2)
    expect(inventory.projects[0]).toMatchObject({
      path: '/var/www/predict-game',
      kind: 'node',
      name: 'predict-game',
      modifiedAt: '2026-04-02 12:26',
    })
    expect(inventory.projects[1]).toMatchObject({
      path: '/opt/satoshi-dao',
      kind: 'compose · node',
      name: 'satoshi',
      modifiedAt: '2026-05-01 10:21',
    })
  })

  it('persists successful inventory scans to local cache', () => {
    const inventory = parseWorkspaceInventory('__SB_HOSTNAME=vps-prod-1\n__SB_TOOL=nginx|Nginx|web|nginx|/usr/sbin/nginx|nginx version')

    saveWorkspaceInventoryCacheEntry(host, inventory)

    const cache = loadWorkspaceInventoryCache([host])
    expect(cache[getWorkspaceInventoryHostKey(host)]?.inventory.resource.hostname).toBe('vps-prod-1')
    expect(cache[getWorkspaceInventoryHostKey(host)]?.inventory.tools[0]).toMatchObject({ id: 'nginx', name: 'Nginx' })
  })
})
