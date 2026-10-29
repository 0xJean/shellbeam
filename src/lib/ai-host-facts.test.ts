import { describe, expect, it } from 'vitest'
import { collectHostFacts, hostFactsText } from './ai-host-facts'
import type { WorkspaceInventory } from './workspace-inventory'

describe('ai host facts', () => {
  it('summarises the session and the last asset scan within the size limit', () => {
    const inventory = {
      resource: { hostname: 'web', os: 'Ubuntu 24.04', kernel: '6.8', arch: 'x86_64', uptime: '3 days', cpuPercent: 4, memoryPercent: 40, memoryText: '3.1/8 GiB', diskPercent: 92, diskText: '46/50 GB', network: '' },
      tools: [{ id: 'docker', name: 'docker', category: '', binary: '', path: '', version: '27.1' }],
      services: [{ name: 'cron.service', active: 'inactive', enabled: '' }, { name: 'nginx.service', active: 'active', enabled: '' }],
      containers: Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, image: '', status: 'Up', ports: '' })),
      pm2: [], projects: [],
    } as unknown as WorkspaceInventory
    const facts = collectHostFacts({ name: 'prod', user: 'root', address: '10.0.0.5', region: '', inventory })
    expect(facts.map((fact) => fact.key)).toEqual(['name', 'user', 'address', 'os', 'kernel', 'arch', 'uptime', 'memory', 'disk', 'tools', 'services', 'containers'])
    expect(facts.find((fact) => fact.key === 'services')?.value).toBe('nginx (active), cron (inactive)')
    expect(facts.find((fact) => fact.key === 'containers')?.value).toContain('(+2)')
    expect(hostFactsText(facts)).toContain('os: Ubuntu 24.04')
    expect(hostFactsText([{ key: 'tools', value: 'x'.repeat(5000) }]).length).toBe(2000)
  })

  it('works with only the session details', () => {
    expect(collectHostFacts({ address: '10.0.0.5', user: 'app' })).toEqual([{ key: 'user', value: 'app' }, { key: 'address', value: '10.0.0.5' }])
  })
})
