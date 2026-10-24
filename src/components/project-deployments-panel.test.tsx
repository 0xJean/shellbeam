import { beforeEach, describe, expect, it } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import { parseWorkspaceInventory, type WorkspaceInventoryCache } from '@/lib/workspace-inventory'
import { buildProjectDeploymentRows, getAgentDeploymentVerification, getProjectDeploymentSignals } from './project-deployments-panel'

const host: HostProfile = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'password',
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

describe('project deployments panel helpers', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'en')
  })

  it('derives deployment rows and running signals from cached inventory', () => {
    const inventory = parseWorkspaceInventory(`
__SB_SERVICE=nginx|active|enabled
__SB_DOCKER=acme-api|ghcr.io/acme/api:latest|Up 2 hours|0.0.0.0:3000->3000/tcp
__SB_PM2=acme-web online 1.2.3
__SB_PROJECT=/var/www/acme-api|node|acme-api|2026-05-15 10:20
`)
    const cache: WorkspaceInventoryCache = {
      'host-1': { inventory, updatedAt: Date.now() },
    }

    const rows = buildProjectDeploymentRows([host], cache)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      host: expect.objectContaining({ id: 'host-1' }),
      project: expect.objectContaining({ name: 'acme-api' }),
      status: 'running',
    })
    expect(rows[0].signals.join(' ')).toContain('Docker: acme-api')
  })

  it('matches PM2 and reverse proxy signals for a project', () => {
    const inventory = parseWorkspaceInventory(`
__SB_SERVICE=caddy|active|enabled
__SB_PM2=billing online 1.2.3
__SB_PROJECT=/srv/billing|node|billing|2026-05-15 10:20
`)

    const signals = getProjectDeploymentSignals(inventory.projects[0], inventory)

    expect(signals).toEqual(expect.arrayContaining([
      expect.stringContaining('PM2:'),
      'caddy: active',
    ]))
  })

  it('shows one deployment row for each normalized project root', () => {
    const inventory = parseWorkspaceInventory(`
__SB_PROJECT=/var/www/predict-game/releases/20260402-121659|node|20260402-121659|2026-04-02 12:16
__SB_PROJECT=/var/www/predict-game/releases/20260402-122658|node|20260402-122658|2026-04-02 12:26
__SB_PROJECT=/opt/satoshi-dao/current|node|satoshi|2026-05-01 10:20
__SB_PROJECT=/opt/satoshi-dao/current|compose|current|2026-05-01 10:21
`)
    const cache: WorkspaceInventoryCache = {
      'host-1': { inventory, updatedAt: Date.now() },
    }

    const rows = buildProjectDeploymentRows([host], cache)

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.project.path).sort()).toEqual(['/opt/satoshi-dao', '/var/www/predict-game'])
    expect(rows.find((row) => row.project.path === '/opt/satoshi-dao')?.project).toMatchObject({
      kind: 'compose · node',
      name: 'satoshi',
    })
  })

  it('keeps Agent supplied verification separate from deployment status', () => {
    const now = 1_000_000
    expect(getAgentDeploymentVerification({ lastVerifiedAt: now - 60_000 }, now, 120_000)).toBe('verified')
    expect(getAgentDeploymentVerification({ lastVerifiedAt: now - 180_000 }, now, 120_000)).toBe('stale')
    expect(getAgentDeploymentVerification({ lastVerifiedAt: null }, now, 120_000)).toBe('unverified')
    expect(getAgentDeploymentVerification({}, now, 120_000)).toBe('unverified')
    expect(getAgentDeploymentVerification({ lastVerifiedAt: now + 10 * 60 * 1000 }, now, 120_000)).toBe('unverified')
  })
})
