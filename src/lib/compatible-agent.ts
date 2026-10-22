import { invoke } from '@tauri-apps/api/core'
export type CompatibleAgentAction = 'inspect' | 'install' | 'upgrade' | 'rollback' | 'uninstall' | 'adopt' | 'migrate' | 'restore-config' | 'restore-legacy'
export interface CompatibleRelease { manifest: { version: string; sha256: string }; publicKey: string }
export interface CompatibleAgentRecord {
  vaultId: string; hostId: string; hostCreatedAt: number; integrationId: string; deployment: string; revision: number;
  observation: { status: string; active: boolean; legacy?: { unit: string; version: string; endpoint: string } | null; previousConfigSha256?: string | null };
  status: string; action: string; jobId: string; endpoint: string; nodeId: string;
  current: CompatibleRelease | null; previous: CompatibleRelease | null; requested: CompatibleRelease | null;
  observedAt: number | null; updatedAt: number; errorCode: string | null;
  previousConfiguration?: { sha256: string; endpoint: string } | null;
}
export interface CompatibleAgentPreview { planId: string; action: CompatibleAgentAction; hostName: string; nodeId: string; endpoint: string; transport: string; account: string; serviceScope: 'system' | 'user'; dataDirectory: string; artifactBytes: number | null; currentVersion: string | null; targetVersion: string | null; status: string; expiresAt: number; legacyUnit?: string | null; previousEndpoint?: string | null }
export interface CompatibleAgentPolicy { source?: 'official' | 'custom'; enabled: boolean; manifestUrl: string; trustedPublicKey: string; allowedHosts: string[] }
export const readCompatibleAgent = (vaultId: string, hostId: string) => invoke<CompatibleAgentRecord | null>('komari_agent_record', { vaultId, hostId })
export const prepareCompatibleAgent = (input: { vaultId: string; hostId: string; integrationId: string; action: CompatibleAgentAction; endpoint?: string; legacyUnit?: string }) => invoke<CompatibleAgentPreview>('komari_agent_prepare', { input })
export const operateCompatibleAgent = (planId: string, confirmed: boolean) => invoke<CompatibleAgentRecord>('komari_agent_operate', { planId, confirmed })
export const cancelCompatibleAgent = (planId: string) => invoke<void>('komari_agent_cancel', { planId })
export const compatibleAgentPolicy = (value?: CompatibleAgentPolicy, confirmed?: boolean) => invoke<CompatibleAgentPolicy>('komari_agent_release_policy', { value, confirmed })
export interface ProbeTransferDestination { hostId: string; hostName: string; connectionId: string; connectionName: string; account: string; address: string; integrationId: string; serviceName: string; nodeId: string; endpoint: string }
export interface ProbeTransfer { id: string; status: string; jobId: string; targetJobId?: string | null; errorCode: string | null; source: { record: CompatibleAgentRecord }; target: { record: CompatibleAgentRecord }; sourceState: { active: boolean; transfer?: { phase: string } }; targetState: { active: boolean; transfer?: { phase: string } } }
export interface ProbeTransferPreview { planId: string; action: string; source: CompatibleAgentPreview; target: CompatibleAgentPreview }
export const probeTransferDestinations = (vaultId: string) => invoke<ProbeTransferDestination[]>('komari_agent_transfer_destinations', { vaultId })
export const readProbeTransfer = (vaultId: string, hostId: string) => invoke<ProbeTransfer | null>('komari_agent_transfer_record', { vaultId, hostId })
export const prepareProbeTransfer = (input: { vaultId: string; sourceHostId: string; targetHostId: string; targetConnectionId: string; targetIntegrationId: string; endpoint?: string }) => invoke<ProbeTransferPreview>('komari_agent_transfer_prepare', { input })
export const recoverProbeTransfer = (vaultId: string, transferId: string, action: 'inspect' | 'restore' | 'finish') => invoke<ProbeTransferPreview>('komari_agent_transfer_recover', { vaultId, transferId, action })
export const operateProbeTransfer = (planId: string, confirmed: boolean) => invoke<ProbeTransfer>('komari_agent_transfer_operate', { planId, confirmed })
