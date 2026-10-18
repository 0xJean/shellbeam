import type { HostProfile } from './hosts'
import type { ProbeProviderKind, ProbeTransport } from './probe-provider'

export type ProbeCollectionSection = 'metrics' | 'inventory'
export type ProbeCollectionOutcome = 'success' | 'failure' | 'unknown'
export type ProbeCollectionReason = 'observed' | 'collection-unavailable' | 'scope-unavailable' | 'unsupported' | 'paused' | 'observation-unavailable'
export interface ProbeCollectionEvent {
  eventId: string
  vaultId: string
  hostId: string
  configRevision: string
  provider: { kind: ProbeProviderKind; id: string }
  transport: ProbeTransport
  startedAt: number
  startedSequence: number
  completedAt: number
  sections: Array<{ section: ProbeCollectionSection; outcome: ProbeCollectionOutcome; sampledAt: number | null; reason: ProbeCollectionReason }>
}

// Wall clocks can share a millisecond across runtime/configuration changes.
// A generation captures this boundary before subscribing to future work.
let collectionSequence = 0
export function beginProbeCollectionSequence() { return ++collectionSequence }
export function currentProbeCollectionSequence() { return collectionSequence }

/** Process-local work/cache identity. Never publish or persist this string:
 * it includes credential references, but never their resolved values. */
export function probeCollectionConfigurationKey(host: HostProfile): string {
  return JSON.stringify([
    host.id, host.vaultId ?? null, host.address, host.port || 22, host.username || 'root', host.authType,
    host.passwordKeyRef ?? null, host.privateKeyRef ?? null, host.secretKeyRef ?? null,
    host.jumpHostId ?? null, host.jumpHost ?? null, host.jumpPort ?? null, host.jumpUser ?? null, host.updatedAt,
  ])
}

/** Only a digest leaves this function. Credential values are never accepted;
 * references and routing edits invalidate a previously started collection. */
export async function getProbeCollectionConfigRevision(host: HostProfile): Promise<string> {
  return probeCollectionDigest(probeCollectionConfigurationKey(host))
}

export async function probeCollectionDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

const listeners = new Set<(event: ProbeCollectionEvent) => void>()
export interface ProbeCollectionDiagnostic { code: 'publication-unavailable' | 'listener-failed'; vaultId: string; hostId: string; startedAt: number; startedSequence: number }
const diagnosticListeners = new Set<(diagnostic: ProbeCollectionDiagnostic) => void>()
export function subscribeProbeCollectionDiagnostics(listener: (diagnostic: ProbeCollectionDiagnostic) => void) {
  diagnosticListeners.add(listener)
  return () => { diagnosticListeners.delete(listener) }
}
export function emitProbeCollectionDiagnostic(diagnostic: ProbeCollectionDiagnostic) {
  // Keep event delivery errors separate from the remote collection result.
  // A failing diagnostic sink cannot rewrite that result or leak its cause.
  for (const listener of diagnosticListeners) {
    try { listener(diagnostic) } catch { /* A second diagnostic sink still runs. */ }
  }
  try { console.warn(`probe_collection_${diagnostic.code.replaceAll('-', '_')}`) } catch { /* Diagnostics cannot change a collection outcome. */ }
}
export function subscribeProbeCollections(listener: (event: ProbeCollectionEvent) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Listeners enqueue their consumer and report asynchronous failures themselves.
 * The bus has no renderer, persistence or local-alert dependency. */
export function emitProbeCollection(event: ProbeCollectionEvent) {
  for (const listener of listeners) {
    try { listener(event) } catch { emitProbeCollectionDiagnostic({ code: 'listener-failed', vaultId: event.vaultId, hostId: event.hostId, startedAt: event.startedAt, startedSequence: event.startedSequence }) }
  }
}
