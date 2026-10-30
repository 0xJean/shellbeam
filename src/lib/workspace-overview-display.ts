import type { HostOpsHealthState } from '@/lib/host-ops-view'
import type { WorkspaceInventory } from '@/lib/workspace-inventory'

/** Status dot colour for a provider health state: green online, amber stale, red unreachable. */
export function healthDotClass(state: HostOpsHealthState | undefined) {
  if (state === 'online') return 'bg-[var(--workspace-status-good)]'
  if (state === 'stale' || state === 'paused') return 'bg-[var(--workspace-status-warn)]'
  if (state === 'offline' || state === 'jump-unavailable') return 'bg-[var(--workspace-status-bad)]'
  return 'bg-[var(--workspace-text-subtle)]'
}

/** First two words of the OS line ("Ubuntu 22.04.4 LTS" → "Ubuntu 22.04.4"), short enough for a chip. */
export function shortOsLabel(os: string | undefined) {
  const value = os?.trim()
  if (!value) return null
  return value.replace(/\s+LTS$/i, '').split(/\s+/).slice(0, 2).join(' ')
}

export type ServiceTone = 'ok' | 'warn' | 'bad'
export interface ServiceRow { name: string; kind: 'systemd' | 'docker'; state: string; tone: ServiceTone }

/** systemd units and containers from the last asset scan, problems first. */
export function serviceRows(inventory: WorkspaceInventory | undefined): ServiceRow[] {
  if (!inventory) return []
  const rows: ServiceRow[] = [
    ...inventory.services.map((service): ServiceRow => ({
      name: service.name.replace(/\.service$/, ''), kind: 'systemd', state: service.active,
      tone: service.active === 'active' ? 'ok' : service.active === 'failed' ? 'bad' : 'warn',
    })),
    ...inventory.containers.map((container): ServiceRow => ({
      name: container.name, kind: 'docker', state: container.status,
      tone: /^up\b/i.test(container.status) ? (/unhealthy/i.test(container.status) ? 'bad' : 'ok') : /restarting|dead/i.test(container.status) ? 'bad' : 'warn',
    })),
  ]
  const rank: Record<ServiceTone, number> = { bad: 0, warn: 1, ok: 2 }
  return rows.sort((a, b) => rank[a.tone] - rank[b.tone])
}
