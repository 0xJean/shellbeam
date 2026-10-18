import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runSshCommand } from './sessions'
import { runSiteOperation, runSiteSslScan } from './sites-ssl'
import type { HostProfile } from './hosts'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./sessions', () => ({ runSshCommand: vi.fn() }))
const host = { id: 'same-host', vaultId: 'vault-b', name: 'Production', address: '192.0.2.20', port: 22, username: 'ops', authType: 'privateKey', privateKeyRef: 'key', jumpHostId: 'jump-ref', tags: [], group: 'Production', createdAt: 1, updatedAt: 1 } as HostProfile
const result = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, durationMs: 1 })
const site = { server: 'nginx' as const, name: 'app.example' }
const createCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'operation_job_create')
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockImplementation(async (_command, args) => ({ jobId: 'job-1', auditId: 'audit-1', ...(args as { request: object }).request }))
  vi.mocked(runSshCommand).mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => vi.restoreAllMocks())
describe('External read and internal post-state audit boundaries', () => {
  it('journals a manual site scan through the actual Workspace helper in its saved Vault without prompting', async () => {
    vi.mocked(runSshCommand).mockResolvedValueOnce(result('__SB_SITE=nginx|app.example||||app.example|configured'))
    const resolveAuthSecret = vi.fn(async () => 'never-transfer-secret')
    const scan = await runSiteSslScan({ host, resolveAuthSecret })
    expect(scan.sites).toHaveLength(1)
    expect(createCalls()).toHaveLength(1)
    expect(createCalls()[0][1]).toMatchObject({ request: { vaultId: 'vault-b', hostId: host.id, action: 'sites.scan', risk: 'read-only', confirmationRequired: false } })
    expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'vault-b', hostId: host.id }))
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
  })
  it('keeps reload, service observation and site post-scan in exactly one confirmed job', async () => {
    vi.mocked(runSshCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result('__SB_SITE_CONFIG=0\n__SB_SITE_ACTIVE=active\n__SB_SITE_VERIFY_COMPLETE=1')).mockResolvedValueOnce(result('__SB_SITE=nginx|app.example||||app.example|configured'))
    const execution = await runSiteOperation({ host, site, operation: 'reload', confirmMessage: 'Reload?', resolveAuthSecret: vi.fn() })
    expect(execution?.job.status).toBe('completed')
    expect(runSshCommand).toHaveBeenCalledTimes(3)
    expect(createCalls()).toHaveLength(1)
    expect(createCalls()[0][1]).toMatchObject({ request: { vaultId: 'vault-b', action: 'site.reload' } })
    expect(window.confirm).toHaveBeenCalledTimes(1)
  })
  it('rejecting the mutation sends no command, including pre/post-state reads', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    expect(await runSiteOperation({ host, site, operation: 'reload', confirmMessage: 'Reload?', resolveAuthSecret: vi.fn() })).toBeNull()
    expect(runSshCommand).not.toHaveBeenCalled()
    expect(createCalls()).toHaveLength(1)
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'cancelled', confirmationStatus: 'rejected' }) })
  })
})
