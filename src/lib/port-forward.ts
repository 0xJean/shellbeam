import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

/** `dynamic` is an `ssh -D` SOCKS5 proxy: it has a bind address but no fixed target. */
export type PortForwardType = 'local' | 'remote' | 'dynamic'

export interface PortForwardRule {
  id: string
  hostId: string
  name: string
  type: PortForwardType
  bindHost: string
  bindPort: number
  targetHost: string
  targetPort: number
  createdAt: number
  updatedAt: number
}

export interface PortForwardRuleDraft {
  hostId: string
  name: string
  type: PortForwardType
  bindHost?: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export const PORT_FORWARD_FLAGS: Record<PortForwardType, string> = { local: '-L', remote: '-R', dynamic: '-D' }

export interface PortForwardForm {
  hostId?: string
  name?: string
  type?: PortForwardType
  bindHost?: string
  bindPort?: number
  targetHost?: string
  targetPort?: number
}

/** Normalises the new-rule form; the chosen type is kept as-is, so dynamic rules never become local. */
export function toPortForwardRuleDraft(form: PortForwardForm): PortForwardRuleDraft | null {
  const type = form.type ?? 'local'
  const dynamic = type === 'dynamic'
  const hostId = form.hostId ?? ''
  const name = form.name?.trim() ?? ''
  const bindPort = Number(form.bindPort) || 0
  const targetHost = form.targetHost?.trim() ?? ''
  const targetPort = Number(form.targetPort) || 0
  if (!hostId || !name || !bindPort || (!dynamic && (!targetHost || !targetPort))) return null
  return {
    hostId,
    name,
    type,
    bindHost: form.bindHost?.trim() || '127.0.0.1',
    bindPort,
    targetHost: dynamic ? '' : targetHost,
    targetPort: dynamic ? 0 : targetPort,
  }
}

export async function listPortForwardRules(vaultId?: string | null): Promise<PortForwardRule[]> {
  try {
    return await invoke<PortForwardRule[]>('list_port_forward_rules', { vaultId: vaultId ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function addPortForwardRule(
  payload: PortForwardRuleDraft,
  vaultId?: string | null
): Promise<PortForwardRule> {
  try {
    return await invoke<PortForwardRule>('add_port_forward_rule', { payload, vaultId: vaultId ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function deletePortForwardRule(ruleId: string, vaultId?: string | null): Promise<void> {
  try {
    await invoke('delete_port_forward_rule', { ruleId, vaultId: vaultId ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function startPortForwardTunnel(
  ruleId: string,
  _privateKey: string | undefined,
  vaultId?: string | null
): Promise<void> {
  try {
    await invoke('start_port_forward_tunnel', { ruleId, vaultId: vaultId ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function stopPortForwardTunnel(ruleId: string): Promise<void> {
  try {
    await invoke('stop_port_forward_tunnel', { ruleId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function portForwardTunnelStatus(ruleId: string): Promise<boolean> {
  try {
    return await invoke<boolean>('port_forward_tunnel_status', { ruleId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

/** Live traffic for a registered tunnel: `bytesIn` arrived through the tunnel, `bytesOut` was sent into it. */
export interface PortForwardTunnelStats {
  ruleId: string
  running: boolean
  bytesIn: number
  bytesOut: number
  /** Unix ms when the tunnel was started; null when no tunnel is registered for the rule. */
  startedAt: number | null
}

/** Stats for one rule, or for every registered tunnel when `ruleId` is omitted. */
export async function portForwardTunnelStats(ruleId?: string): Promise<PortForwardTunnelStats[]> {
  try {
    const stats = await invoke<PortForwardTunnelStats[] | null>('port_forward_tunnel_stats', { ruleId })
    return Array.isArray(stats) ? stats : []
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export interface DurationUnits { seconds: string; minutes: string; hours: string; days: string }

/** Coarse running time ("35 min", "2 h"): one unit, rounded down, never negative. */
export function formatTunnelDuration(ms: number, units: DurationUnits): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const [template, n] = seconds < 60 ? [units.seconds, seconds]
    : seconds < 3600 ? [units.minutes, Math.floor(seconds / 60)]
    : seconds < 86_400 ? [units.hours, Math.floor(seconds / 3600)]
    : [units.days, Math.floor(seconds / 86_400)]
  return template.replace('{n}', String(n))
}
