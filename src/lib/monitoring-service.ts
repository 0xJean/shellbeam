import { invoke } from '@tauri-apps/api/core'
import type { KomariIntegration } from './komari-config'

export interface ServiceScope { vaultId: string; integrationId: string; configVersion: number; session: number; contextId: string; configurationIdentity: string }
export type ServiceValues = Record<string, unknown>
export interface ServiceIntent {
  intent: { id: string; scope: ServiceScope; target: string; revision: number; status: 'prepared' | 'applying' | 'verified' | 'uncertain' | 'retry' | 'conflict' | 'cancelled'; jobId: string; observedAt: number; updatedAt: number; errorCode?: string }
  extension?: { operation: 'upgrade' | 'uninstall' | 'restore'; stage: string; backupAvailable: boolean; backupVersion?: string } | null
  baseline: ServiceValues; desired: ServiceValues; observed: ServiceValues
}
export async function serviceScope(service: KomariIntegration): Promise<ServiceScope> {
  return invoke<ServiceScope>('monitoring_service_context', { expected: service })
}
export function serviceRequest<T>(scope: ServiceScope, action: string, options: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('monitoring_service', { input: { scope, action, ...options } })
}
export function serviceIntentAction(scope: ServiceScope, row: ServiceIntent, action: string, confirmed = false) {
  return serviceRequest<ServiceIntent>(scope, action, { id: row.intent.id, revision: row.intent.revision, confirmed })
}
export function serviceErrorCode(cause: unknown) {
  const text = String(cause)
  return text.match(/MONITORING_[A-Z_]+/)?.[0] ?? 'MONITORING_REQUEST_FAILED'
}

export function closeServiceScope(scope: ServiceScope) { return invoke('monitoring_service_cancel_context', { contextId: scope.contextId }) }
