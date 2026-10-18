import { expect, it, vi } from 'vitest'
import { listOperationAudit, listOperationJobs } from './operation-job'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue([]) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

it('passes scoped stable cursors and server-side status/source filters without losing the id tie breaker', async () => {
  const before = { timestamp: 1234, id: 'same-time-id' }
  const filters = { vaultId: 'vault-a', hostId: 'shared-host', source: 'workspace' as const, status: 'cancelled' as const, limit: 21, before }
  await listOperationJobs(filters)
  await listOperationAudit(filters)
  expect(invoke).toHaveBeenNthCalledWith(1, 'operation_job_list', { query: filters })
  expect(invoke).toHaveBeenNthCalledWith(2, 'operation_audit_list', { query: filters })
})
