import type { CompatibleAgentRecord } from './compatible-agent'
import { hasSshConnection, type HostProfile } from './hosts'
import type { CurrentKomariSource } from './komari-source-eligibility'

/**
 * Quick-install readiness for the ShellBeam monitoring probe. The guided
 * installer walks the same prerequisites the backend enforces in
 * `komari_agent_prepare` (source → server monitoring mode → node mapping) and
 * starts at the first one that is not yet satisfied. This module only reads
 * state; every change still goes through the existing confirmed commands.
 */
export type ProbeInstallStage =
  | 'no-ssh' // no usable SSH connection, nothing can be installed
  | 'no-server' // no enabled ShellBeam Server source in this vault
  | 'ssh-mode' // a source exists, but the host still uses SSH sampling
  | 'no-node' // server monitoring, but no node is mapped to this host
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
  const integrationId = (mappedEntry ?? preferred ?? usable[0]).integration.id
  const nodeId = mappedEntry?.state!.mappings.find((m) => m.hostId === host.id && m.integrationId === mappedEntry.integration.id)!.nodeId
  // Linking a node requires server monitoring (edit_komari_mapping enforces it), so the mode comes first.
  if (host.monitoringMode !== 'server') return { stage: 'ssh-mode', integrationId, ...(nodeId ? { nodeId } : {}) }
  if (!nodeId) return { stage: 'no-node', integrationId }
  return { stage: 'ready', integrationId, nodeId }
}

// The managed probe needs Linux with systemd; these systems are known not to qualify.
const UNSUPPORTED_OS = /alpine|synology|\bdsm\b|freebsd|openbsd|netbsd|darwin|mac ?os|windows|openwrt|busybox/i

/** Unknown systems stay eligible; the read-only preflight decides for them. */
export function isProbeSupportedOs(os: string | null | undefined): boolean {
  return !os || !UNSUPPORTED_OS.test(os)
}

/** Whether the host card should offer the one-click install entry. */
export function offersProbeInstall(readiness: ProbeInstallReadiness, os?: string | null): boolean {
  return readiness.stage !== 'installed' && readiness.stage !== 'no-ssh' && readiness.stage !== 'unsettled' && isProbeSupportedOs(os)
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

/** Runs `worker` over `items` with at most `limit` in flight; stops picking new items once `stopped()` is true. */
export async function runProbeInstallPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>, stopped: () => boolean = () => false) {
  let next = 0
  const lane = async () => {
    while (next < items.length && !stopped()) {
      const item = items[next++]
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
}
