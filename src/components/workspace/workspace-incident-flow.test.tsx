import { webcrypto } from 'node:crypto'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceMobileShell } from './workspace-mobile-shell'
import { clearWorkspaceInventoryStates, mergeWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey, type WorkspaceInventory } from '@/lib/workspace-inventory'
import { clearLocalOpsMemory, saveLocalAlertState } from '@/lib/local-ops-store'
import { EMPTY_LOCAL_ALERT_STATE, evaluateLocalAlertRules, type LocalAlertRule } from '@/lib/local-alert-rules'
import type { OperationJob } from '@/lib/operation-job'
import type { WorkspaceAppId } from '@/lib/workspace'

const { invoke, runSshCommand } = vi.hoisted(() => ({ invoke: vi.fn(), runSshCommand: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/sessions', async (original) => ({ ...await original<typeof import('@/lib/sessions')>(), runSshCommand }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('./provider-history-panel', () => ({ ProviderHistoryPanel: () => null }))
const host = { id: 'incident-host', vaultId: 'team', name: 'Production nginx', address: '10.0.0.9', port: 22, username: 'ops', group: 'Default', authType: 'password' as const, tags: [], jumpHost: 'bastion.example', createdAt: 0, updatedAt: 0 }
const hosts = [host]
const resolveAuthSecret = vi.fn(async () => { throw new Error('Saved host credentials must stay native') })
let jobs: OperationJob[] = []
function IncidentWorkspace() {
  const [app, setApp] = useState<WorkspaceAppId>('overview')
  return <WorkspaceMobileShell activeVaultId="team" sessionId="incident-session" hostId={host.id} hosts={hosts} hostName={host.name} hostAddress={host.address} activeApp={app} onSelectApp={setApp} resolveAuthSecret={resolveAuthSecret} />
}
describe('actual Workspace incident flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); vi.stubGlobal('crypto', webcrypto); localStorage.clear(); clearLocalOpsMemory(); clearWorkspaceInventoryStates()
    jobs = []; invoke.mockReset(); runSshCommand.mockReset(); resolveAuthSecret.mockClear()
    invoke.mockImplementation(async (command, payload) => {
      if (command === 'operation_job_create') {
        const job = { ...payload.request, jobId: `job-${jobs.length + 1}`, auditId: `audit-${jobs.length + 1}`, queuedAt: Date.now(), updatedAt: Date.now(), status: 'queued' } as OperationJob
        jobs.push(job); return job
      }
      if (command === 'operation_job_update') {
        const index = jobs.findIndex((job) => job.jobId === payload.request.jobId)
        jobs[index] = { ...jobs[index], ...payload.request }; return jobs[index]
      }
      return []
    })
    let serviceState = 'failed'
    runSshCommand.mockImplementation(async ({ command }) => {
      let stdout = ''
      if (command.startsWith('systemctl list-units')) stdout = `nginx.service loaded ${serviceState} ${serviceState === 'active' ? 'running' : 'failed'} Nginx web server`
      else if (command.startsWith('journalctl')) stdout = 'nginx.service: failed to start worker'
      else if (command === 'systemctl restart -- nginx.service') serviceState = 'active'
      else if (command.startsWith('systemctl show')) stdout = `ActiveState=${serviceState}\nUnitFileState=enabled`
      else throw new Error(`Unexpected remote operation: ${command}`)
      return { stdout, stderr: '', exitCode: 0, durationMs: 2 }
    })
    const now = Date.now()
    const rule: LocalAlertRule = { id: 'nginx-failed', hostId: host.id, name: 'Nginx failed', metric: 'service', target: 'nginx.service', threshold: 1, recoveryThreshold: 0, durationMs: 0, recoveryDurationMs: 0, freshnessMs: 60_000, severity: 'critical', enabled: true }
    saveLocalAlertState('team', host.id, evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, [rule], [{ ruleId: rule.id, value: 1, sampledAt: now, source: 'ssh-agentless', transport: 'proxy-jump' }], now))
    const inventory: WorkspaceInventory = { resource: { hostname: 'nginx', os: 'Linux', kernel: '', uptime: '', cpuPercent: 10, memoryPercent: 20, memoryText: '', diskPercent: 40, diskText: '', network: '' }, tools: [], services: [{ name: 'nginx.service', active: 'failed', enabled: 'enabled' }], containers: [], pm2: [], projects: [], scannedAt: now }
    mergeWorkspaceInventoryStates({ [getWorkspaceInventoryHostKey(host)]: { status: 'ready', inventory, updatedAt: now } })
  })

  it('discovers an alert, inspects logs, confirms restart and sees the verified state in the same audited host', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<IncidentWorkspace />)
    const recommendations = within(await screen.findByTestId('workspace-recommendations'))
    expect(recommendations.getByText('Investigate active host alerts in logs')).toBeInTheDocument()
    fireEvent.click(recommendations.getByRole('button', { name: 'Open logs' }))
    await waitFor(() => expect(screen.getByTestId('workspace-logs-output')).toHaveTextContent('nginx.service: failed to start worker'))
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Home Screen' }))
    fireEvent.click(within(await screen.findByTestId('workspace-recommendations')).getByRole('button', { name: 'Open Services' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restart nginx.service' }))
    await waitFor(() => expect(screen.getByTestId('workspace-services-output')).toHaveTextContent('verification=passed; active=active'))
    expect(confirm).toHaveBeenCalledOnce()
    const mutation = jobs.filter((job) => job.action === 'service.restart')
    expect(mutation).toHaveLength(1)
    expect(mutation[0]).toMatchObject({ hostId: host.id, vaultId: 'team', transport: 'proxy-jump', status: 'completed', confirmationStatus: 'confirmed', resultSummary: expect.stringContaining('verification=passed') })
    expect(jobs.some((job) => job.action === 'logs.read' && job.status === 'completed')).toBe(true)
    expect(runSshCommand.mock.calls.every(([payload]) => payload.hostId === host.id && payload.vaultId === 'team' && !payload.password && !payload.privateKey)).toBe(true)
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open logs for nginx.service' }))
    await screen.findByLabelText('Service unit, e.g. nginx.service')
    expect(screen.getByLabelText('Service unit, e.g. nginx.service')).toHaveValue('nginx.service')
  })

  it('persists rejected confirmation and performs neither restart nor verification when cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<IncidentWorkspace />)
    fireEvent.click(within(await screen.findByTestId('workspace-recommendations')).getByRole('button', { name: 'Open Services' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restart nginx.service' }))
    await waitFor(() => expect(jobs.find((job) => job.action === 'service.restart')).toMatchObject({ status: 'cancelled', confirmationStatus: 'rejected' }))
    expect(runSshCommand.mock.calls.some(([payload]) => payload.command.startsWith('systemctl restart') || payload.command.startsWith('systemctl show'))).toBe(false)
  })
})
