import { invoke } from '@tauri-apps/api/core'
import type { HostProfile } from './hosts'
import { actOnLocalAlert } from './local-alert-rules'
import { dispatchLocalAlertNotifications, loadLocalAlertState, saveLocalAlertState } from './local-ops-store'
import { applyLocalOpsDocument, flushLocalOpsHost, hasNativeLocalOps, hydrateLocalOpsHost, queueLocalOpsMutation, type LocalOpsDocument } from './local-ops-persistence'
import { operationTransport, runConfirmedOperation, type OperationJob } from './operation-job'

/** Local lifecycle mutations use the same confirmed OperationJob as remote
 * actions. The native transaction validates that job's vault, host, rule,
 * action, running status and confirmed consent before touching the alert. */
export async function runLocalAlertAction(options: {
  vaultId?: string
  host: HostProfile
  ruleId: string
  action: 'acknowledge' | 'close'
  confirmMessage: string
  now?: () => number
  isCurrent?: () => boolean
}) {
  if (options.vaultId && options.host.vaultId && options.vaultId !== options.host.vaultId) throw new Error('LOCAL_OPS_HOST_VAULT_MISMATCH')
  const isCurrent = () => options.isCurrent?.() !== false
  if (!isCurrent()) return null
  await hydrateLocalOpsHost(options.vaultId, options.host.id, true)
  if (!isCurrent()) return null
  await flushLocalOpsHost(options.vaultId, options.host.id)
  if (!isCurrent()) return null
  const record = loadLocalAlertState(options.vaultId, options.host.id).alerts.find((row) => row.ruleId === options.ruleId && row.hostId === options.host.id)
  if (!record) throw new Error('LOCAL_OPS_ALERT_NOT_FOUND')
  let confirmed: OperationJob | undefined
  let committedDocument: LocalOpsDocument | null = null
  let execution: { value: { exitCode: number; durationMs: number; resultSummary: string }; job: OperationJob } | null = null
  try {
    execution = await runConfirmedOperation({
      vaultId: options.vaultId, host: options.host, action: `local-alert.${options.action}`, target: options.ruleId, risk: 'low', source: 'workspace', provider: 'local-ops', transport: operationTransport(options.host), paramsSummary: `rule=${options.ruleId}; metric=${record.metric}`, confirmMessage: options.confirmMessage,
      isCurrent,
      onJob: (job) => { if (job.status === 'running' && job.confirmationStatus === 'confirmed') confirmed = job },
      execute: async () => {
        if (!isCurrent()) throw new Error('LOCAL_OPS_SCOPE_CHANGED')
        if (!confirmed) throw new Error('LOCAL_OPS_CONFIRMED_JOB_REQUIRED')
        if (hasNativeLocalOps()) {
          // Serialize with background alert-state upserts so a concurrent 30s
          // rule scan cannot collide into REVISION_CONFLICT. Defer applying the
          // committed document until runConfirmedOperation persists the
          // `completed` audit entry, keeping UI state and audit in sync.
          committedDocument = await queueLocalOpsMutation(options.vaultId, options.host.id, 'alert-state', () =>
            invoke<LocalOpsDocument>('local_ops_alert_action', {
              payload: { vaultId: options.vaultId, hostId: options.host.id, ruleId: options.ruleId, action: options.action, operationJobId: confirmed!.jobId },
            }),
          )
        } else {
          // Browser previews/tests keep the same canonical confirmation flow;
          // only their credential-free observation repository is renderer-local.
          const current = loadLocalAlertState(options.vaultId, options.host.id)
          saveLocalAlertState(options.vaultId, options.host.id, actOnLocalAlert(current, options.ruleId, options.action, options.now?.() ?? Date.now(), confirmed.jobId))
        }
        return { exitCode: 0, durationMs: 0, resultSummary: `local-alert.${options.action}; rule=${options.ruleId}; lifecycle persisted` }
      },
      getResult: (value) => value,
    })
  } finally {
    if (committedDocument) applyLocalOpsDocument(committedDocument)
  }
  if (!execution) return null
  const state = loadLocalAlertState(options.vaultId, options.host.id)
  if (isCurrent()) await dispatchLocalAlertNotifications(options.vaultId, options.host.id, state).catch(() => undefined)
  return { ...execution, state }
}
