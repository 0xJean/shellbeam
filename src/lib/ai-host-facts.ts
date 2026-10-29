import type { WorkspaceInventory, WorkspaceInventoryResource } from './workspace-inventory'

export type HostFactKey = 'name' | 'user' | 'address' | 'region' | 'os' | 'kernel' | 'arch' | 'uptime' | 'memory' | 'disk' | 'tools' | 'services' | 'containers'
export interface HostFact { key: HostFactKey; value: string }

const TEXT_LIMIT = 2000
const list = (items: string[], limit: number) => items.length > limit ? `${items.slice(0, limit).join(', ')} (+${items.length - limit})` : items.join(', ')

/** What ShellBeam already knows about the server from the session and its last asset scan. */
export function collectHostFacts(input: {
  name?: string
  user?: string
  address: string
  region?: string
  resource?: Partial<WorkspaceInventoryResource>
  inventory?: WorkspaceInventory
}): HostFact[] {
  const resource = input.inventory?.resource ?? input.resource
  const facts: HostFact[] = []
  const add = (key: HostFactKey, value: string | null | undefined) => { const v = value?.trim(); if (v) facts.push({ key, value: v }) }
  add('name', input.name)
  add('user', input.user)
  add('address', input.address)
  add('region', input.region)
  add('os', resource?.os)
  add('kernel', resource?.kernel)
  add('arch', resource?.arch ?? undefined)
  add('uptime', resource?.uptime)
  add('memory', resource?.memoryText)
  add('disk', resource?.diskText)
  const inventory = input.inventory
  if (inventory) {
    add('tools', list(inventory.tools.map((tool) => tool.version ? `${tool.name} ${tool.version}` : tool.name), 20))
    const services = [...inventory.services].sort((a, b) => Number(b.active === 'active') - Number(a.active === 'active'))
    add('services', list(services.map((service) => `${service.name.replace(/\.service$/, '')} (${service.active})`), 20))
    add('containers', list(inventory.containers.map((container) => `${container.name} (${container.status})`), 10))
  }
  return facts
}

export function hostFactsText(facts: HostFact[]): string {
  const text = facts.map((fact) => `${fact.key}: ${fact.value}`).join('\n')
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text
}
