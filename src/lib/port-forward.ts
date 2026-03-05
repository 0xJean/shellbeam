import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface PortForwardRule {
  id: string
  hostId: string
  name: string
  type: 'local' | 'remote'
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
  type: 'local' | 'remote'
  bindHost?: string
  bindPort: number
  targetHost: string
  targetPort: number
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
  privateKey: string,
  vaultId?: string | null
): Promise<void> {
  try {
    await invoke('start_port_forward_tunnel', { ruleId, privateKey, vaultId: vaultId ?? undefined })
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
