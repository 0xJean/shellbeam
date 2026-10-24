export type ProbeAlertRuntimeDiagnostic = 'publication-unavailable' | 'listener-failed' | 'persistence-unavailable'
export const PROBE_ALERT_RUNTIME_CHANGED = 'shellbeam:probe-alert-runtime-changed'
const diagnostics = new Map<string, ProbeAlertRuntimeDiagnostic>()
const codes = new Set<ProbeAlertRuntimeDiagnostic>(['publication-unavailable', 'listener-failed', 'persistence-unavailable'])
const scope = (vaultId: string, hostId: string) => JSON.stringify([vaultId, hostId])
const validId = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 160 && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
function changed() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROBE_ALERT_RUNTIME_CHANGED)) }

/** Bounded, scope-only diagnostics. This never changes Provider health, stores
 * exceptions, or claims that an unpersisted alert was delivered. */
export function setProbeAlertRuntimeDiagnostic(vaultId: string, hostId: string, code: ProbeAlertRuntimeDiagnostic) {
  if (!validId(vaultId) || !validId(hostId) || !codes.has(code)) return
  const key = scope(vaultId, hostId)
  if (diagnostics.get(key) === code) return
  diagnostics.set(key, code)
  if (diagnostics.size > 256) diagnostics.delete(diagnostics.keys().next().value!)
  changed()
}
export function getProbeAlertRuntimeDiagnostic(vaultId: string | undefined | null, hostId: string) {
  return vaultId ? diagnostics.get(scope(vaultId, hostId)) ?? null : null
}
export function clearProbeAlertRuntimeDiagnostic(vaultId: string, hostId: string) {
  if (diagnostics.delete(scope(vaultId, hostId))) changed()
}
