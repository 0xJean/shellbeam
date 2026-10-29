import type { WorkspaceInventory } from './workspace-inventory'
import { fillCopy } from './locales/ai-assistant'

export interface SmartPromptCopy {
  disk: string
  memory: string
  failedService: string
  stoppedContainer: string
  containers: string
  nginx: string
  database: string
  redis: string
  pm2: string
  ports: string
}

export interface AISuggestion { text: string; smart: boolean }

const SUGGESTION_LIMIT = 6
/** Leaves room for a couple of everyday requests even on a busy server. */
const SMART_LIMIT = 4
const DATABASES: Record<string, string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgresql: 'PostgreSQL' }

/** Requests that fit this server's last asset scan, most pressing first, topped up with generic examples. */
export function suggestPrompts(inventory: WorkspaceInventory | undefined, copy: SmartPromptCopy, examples: readonly string[]): AISuggestion[] {
  const smart: string[] = []
  if (inventory) {
    const { resource } = inventory
    if (resource.diskPercent !== null && resource.diskPercent >= 80) smart.push(fillCopy(copy.disk, { percent: Math.round(resource.diskPercent) }))
    if (resource.memoryPercent !== null && resource.memoryPercent >= 85) smart.push(fillCopy(copy.memory, { percent: Math.round(resource.memoryPercent) }))
    const failed = inventory.services.find((service) => service.active === 'failed')
    if (failed) smart.push(fillCopy(copy.failedService, { name: failed.name.replace(/\.service$/, '') }))
    const stopped = inventory.containers.find((container) => /^(exited|dead|created)/i.test(container.status))
    if (stopped) smart.push(fillCopy(copy.stoppedContainer, { name: stopped.name }))
    const tools = new Set(inventory.tools.map((tool) => tool.id))
    if (inventory.containers.some((container) => /^up/i.test(container.status))) smart.push(copy.containers)
    if (tools.has('nginx')) smart.push(copy.nginx)
    const database = Object.keys(DATABASES).find((id) => tools.has(id))
    if (database) smart.push(fillCopy(copy.database, { name: DATABASES[database] }))
    if (tools.has('redis')) smart.push(copy.redis)
    if (inventory.pm2.length > 0) smart.push(copy.pm2)
    if ((inventory.listeningPorts?.length ?? 0) > 0) smart.push(copy.ports)
  }
  const picked = smart.slice(0, SMART_LIMIT).map((text) => ({ text, smart: true }))
  for (const text of examples) {
    if (picked.length >= SUGGESTION_LIMIT) break
    picked.push({ text, smart: false })
  }
  return picked
}
