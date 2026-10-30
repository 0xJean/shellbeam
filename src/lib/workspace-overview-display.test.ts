import { describe, expect, it } from 'vitest'
import { serviceRows } from './workspace-overview-display'
import type { WorkspaceInventory } from '@/lib/workspace-inventory'

const inventory = (services: WorkspaceInventory['services'], containers: WorkspaceInventory['containers']) => ({ services, containers } as WorkspaceInventory)

describe('workspace overview services card rows', () => {
  it('merges systemd units and containers, problems first', () => {
    const rows = serviceRows(inventory(
      [{ name: 'nginx.service', active: 'active', enabled: 'enabled' }, { name: 'cron.service', active: 'failed', enabled: 'enabled' }],
      [{ name: 'api', image: 'api', status: 'Up 3 days', ports: '' }, { name: 'pg', image: 'pg', status: 'Exited (0) 2 hours ago', ports: '' }],
    ))
    expect(rows.map((row) => [row.name, row.kind, row.tone])).toEqual([
      ['cron', 'systemd', 'bad'], ['pg', 'docker', 'warn'], ['nginx', 'systemd', 'ok'], ['api', 'docker', 'ok'],
    ])
  })

  it('is empty before the first asset scan', () => {
    expect(serviceRows(undefined)).toEqual([])
  })
})
