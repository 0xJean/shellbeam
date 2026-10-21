import { invoke } from '@tauri-apps/api/core'
export type CompatibleAgentAction = 'inspect' | 'install' | 'upgrade' | 'rollback' | 'uninstall'
export interface CompatibleRelease { manifest: { version: string; sha256: string }; publicKey: string }
export interface CompatibleAgentRecord {
  vaultId: string; hostId: string; hostCreatedAt: number; integrationId: string; deployment: string; revision: number;
  observation: { status: string; active: boolean };
  status: string; action: string; jobId: string; endpoint: string; nodeId: string;
  current: CompatibleRelease | null; previous: CompatibleRelease | null; requested: CompatibleRelease | null;
  observedAt: number | null; updatedAt: number; errorCode: string | null;
}
export interface CompatibleAgentPreview { planId: string; action: CompatibleAgentAction; hostName: string; nodeId: string; endpoint: string; transport: string; account: string; serviceScope: 'system' | 'user'; dataDirectory: string; artifactBytes: number | null; currentVersion: string | null; targetVersion: string | null; status: string; expiresAt: number }
export interface CompatibleAgentPolicy { enabled: boolean; manifestUrl: string; trustedPublicKey: string; allowedHosts: string[] }
export const readCompatibleAgent = (vaultId: string, hostId: string) => invoke<CompatibleAgentRecord | null>('komari_agent_record', { vaultId, hostId })
export const prepareCompatibleAgent = (input: { vaultId: string; hostId: string; integrationId: string; action: CompatibleAgentAction; endpoint?: string }) => invoke<CompatibleAgentPreview>('komari_agent_prepare', { input })
export const operateCompatibleAgent = (planId: string, confirmed: boolean) => invoke<CompatibleAgentRecord>('komari_agent_operate', { planId, confirmed })
export const cancelCompatibleAgent = (planId: string) => invoke<void>('komari_agent_cancel', { planId })
export const compatibleAgentPolicy = (value?: CompatibleAgentPolicy, confirmed?: boolean) => invoke<CompatibleAgentPolicy>('komari_agent_release_policy', { value, confirmed })
