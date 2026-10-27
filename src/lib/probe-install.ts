import type { CompatibleAgentRecord } from './compatible-agent'
import { hasSshConnection, type HostProfile } from './hosts'
import type { CurrentKomariSource } from './komari-source-eligibility'

/**
 * Quick-install readiness for the ShellBeam monitoring probe. The guided
 * installer walks the same prerequisites the backend enforces in
 * `komari_agent_prepare` (source → node mapping → server monitoring mode) and
 * starts at the first one that is not yet satisfied. This module only reads
 * state; every change still goes through the existing confirmed commands.
 */
export type ProbeInstallStage =
  | 'no-ssh' // no usable SSH connection, nothing can be installed
  | 'no-server' // no enabled ShellBeam Server source in this vault
  | 'no-node' // a source exists but no node is mapped to this host
  | 'ssh-mode' // mapped, but the host still uses SSH sampling
  | 'ready' // all prerequisites met; next step is the read-only preflight
  | 'unsettled' // a previous operation must be read back first
  | 'installed'

export interface ProbeInstallReadiness {
  stage: ProbeInstallStage
  integrationId?: string
  nodeId?: string
}

const UNSETTLED = new Set(['prepared', 'dispatched', 'unknown', 'migrated'])

export function isProbeInstalled(record: CompatibleAgentRecord | null | undefined): boolean {
  return !!record?.current && !['retired', 'absent'].includes(record.observation.status)
}

export function probeInstallReadiness(host: HostProfile, sources: readonly CurrentKomariSource[], record: CompatibleAgentRecord | null): ProbeInstallReadiness {
  const owned = record && record.hostId === host.id && record.vaultId === host.vaultId ? record : null
  if (isProbeInstalled(owned)) return { stage: 'installed', integrationId: owned!.integrationId, nodeId: owned!.nodeId }
  if (owned && UNSETTLED.has(owned.status)) return { stage: 'unsettled', integrationId: owned.integrationId }
  if (!hasSshConnection(host)) return { stage: 'no-ssh' }
  const usable = sources.filter((entry) => entry.integration.enabled && entry.integration.vaultId === host.vaultId && entry.state && !entry.error)
  if (usable.length === 0) return { stage: 'no-server' }
  // Prefer the source a previous record used, then any source that already maps this host.
  const preferred = owned ? usable.find((entry) => entry.integration.id === owned.integrationId) : undefined
  const mappedEntry = (preferred ? [preferred] : usable).find((entry) => entry.state!.mappings.some((m) => m.hostId === host.id && m.integrationId === entry.integration.id))
  if (!mappedEntry) return { stage: 'no-node', integrationId: (preferred ?? usable[0]).integration.id }
  const nodeId = mappedEntry.state!.mappings.find((m) => m.hostId === host.id && m.integrationId === mappedEntry.integration.id)!.nodeId
  if (host.monitoringMode !== 'server') return { stage: 'ssh-mode', integrationId: mappedEntry.integration.id, nodeId }
  return { stage: 'ready', integrationId: mappedEntry.integration.id, nodeId }
}

/** Whether the host card should offer the one-click install entry. */
export function offersProbeInstall(readiness: ProbeInstallReadiness): boolean {
  return readiness.stage !== 'installed' && readiness.stage !== 'no-ssh' && readiness.stage !== 'unsettled'
}

/** Preflight rows shown by the installer; errors from prepare map onto one of them. */
export type ProbePreflightCheck = 'ssh' | 'system' | 'account' | 'existing' | 'server' | 'node' | 'release'
export const PROBE_PREFLIGHT_CHECKS: readonly ProbePreflightCheck[] = ['ssh', 'system', 'account', 'existing', 'server', 'release']

export function probePreflightFailure(error: unknown): { check: ProbePreflightCheck; code: string } {
  const code = String(error).match(/(?:KOMARI_AGENT|MONITORING)_[A-Z_]+/)?.[0] ?? 'KOMARI_AGENT_OPERATION_FAILED'
  const check: ProbePreflightCheck = /SSH/.test(code) ? 'ssh'
    : /LINUX_REQUIRED|ARCHITECTURE|SYSTEMD|PYTHON/.test(code) ? 'system'
      : /LINGER|PRIVILEGE|ACCOUNT/.test(code) ? 'account'
        : /EXTERNAL|ALREADY_REPORTING|UNMANAGED|LEGACY/.test(code) ? 'existing'
          : /MAPPING|NODE/.test(code) ? 'node'
            : /RELEASE|CATALOG|SIGNATURE|ARTIFACT|POLICY/.test(code) ? 'release'
              : 'server'
  return { check, code }
}
