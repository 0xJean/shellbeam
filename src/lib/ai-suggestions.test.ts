import { describe, expect, it } from 'vitest'
import { suggestPrompts } from './ai-suggestions'
import { aiAssistantCopy } from './locales/ai-assistant'
import type { WorkspaceInventory } from './workspace-inventory'

const copy = aiAssistantCopy.en
const scan = (patch: Partial<WorkspaceInventory> = {}, resource: Partial<WorkspaceInventory['resource']> = {}): WorkspaceInventory => ({
  resource: { hostname: 'h', os: 'Ubuntu', kernel: '', uptime: '', cpuPercent: null, memoryPercent: null, memoryText: '', diskPercent: null, diskText: '', network: '', ...resource },
  tools: [], services: [], containers: [], pm2: [], projects: [], scannedAt: 1, ...patch,
})

describe('suggestPrompts', () => {
  it('falls back to everyday examples without a scan', () => {
    const picked = suggestPrompts(undefined, copy.smart, copy.examples)
    expect(picked).toHaveLength(6)
    expect(picked.every((item) => !item.smart)).toBe(true)
  })

  it('puts problems first, then installed components, and keeps room for examples', () => {
    const picked = suggestPrompts(scan({
      services: [{ name: 'nginx.service', active: 'failed', enabled: 'enabled' }],
      containers: [{ name: 'api', image: 'x', status: 'Exited (1) 2 hours ago', ports: '' }, { name: 'db', image: 'y', status: 'Up 3 days', ports: '' }],
      tools: [{ id: 'nginx', name: 'nginx', category: '', binary: '', path: '', version: '' }, { id: 'postgresql', name: 'PostgreSQL', category: '', binary: '', path: '', version: '' }],
    }, { diskPercent: 88.4, memoryPercent: 92 }), copy.smart, copy.examples)
    expect(picked.map((item) => item.text).slice(0, 4)).toEqual([
      'Disk is 88% full. Find what takes the most space',
      'Memory is 92% used. Which processes use the most?',
      'The nginx service has failed. Find out why',
      'Container api has stopped. Show its last logs',
    ])
    expect(picked.filter((item) => !item.smart)).toHaveLength(2)
  })

  it('suggests database and pm2 checks when they are installed', () => {
    const texts = suggestPrompts(scan({ tools: [{ id: 'mysql', name: 'MySQL', category: '', binary: '', path: '', version: '' }], pm2: [{ raw: 'app' }] }), copy.smart, copy.examples).filter((item) => item.smart).map((item) => item.text)
    expect(texts).toEqual(['Check MySQL status and current connections', 'Show pm2 process status and recent errors'])
  })
})
