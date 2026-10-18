import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { ScheduledTasksPanel } from './scheduled-tasks-panel'
import { I18nProvider } from '@/lib/i18n'
import { clearScheduledTaskAuthorizations, isScheduledTaskAuthorized, loadScheduledTasks, normalizeScheduledTask, saveScheduledTasks } from '@/lib/scheduled-tasks'
import type { HostProfile } from '@/lib/hosts'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const host: HostProfile = { id: 'h1', name: 'Host', address: '10.0.0.1', port: 2222, username: 'ops', jumpHost: 'bastion', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }
let job: Record<string, unknown>
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en'); clearScheduledTaskAuthorizations()
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    const request = (args as { request: Record<string, unknown> }).request
    if (command === 'operation_job_create') { job = { ...request, jobId: 'enable-job', auditId: 'enable-audit', status: 'queued', confirmationStatus: 'pending' }; return { ...job } }
    if (command === 'operation_job_update') { job = { ...job, ...request }; return { ...job } }
    throw new Error('unexpected command')
  })
})
afterEach(() => vi.restoreAllMocks())
function renderPanel() { return render(<I18nProvider><ScheduledTasksPanel activeVaultId="vault" host={host} resolveAuthSecret={async () => ''} /></I18nProvider>) }
function savedTask() { const task = normalizeScheduledTask({ id: 'task', hostId: host.id, name: 'Restart nginx', command: 'systemctl restart nginx', intervalMinutes: 5, enabled: false }, 1_000); saveScheduledTasks('vault', host.id, [task]); return task }
describe('ScheduledTasksPanel', () => {
  it('renders the scheduled task surface', () => {
    renderPanel()
    expect(screen.getByTestId('scheduled-tasks-panel')).toBeInTheDocument()
    expect(screen.getByText(/Missed writes are never replayed automatically/)).toBeInTheDocument()
  })
  it('explains host, route, command and recurrence, and requires confirmed consent before enabling', async () => {
    savedTask()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const before = Date.now()
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(loadScheduledTasks('vault', host.id)[0].enabled).toBe(true))
    const task = loadScheduledTasks('vault', host.id)[0]
    expect(task.nextRunAt).toBeGreaterThanOrEqual(before + 5 * 60_000)
    expect(isScheduledTaskAuthorized('vault', task)).toBe(true)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Host (ops@10.0.0.1:2222)'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('ProxyJump bastion'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('systemctl restart nginx'))
    expect(job).toMatchObject({ action: 'scheduled-task.enable', vaultId: 'vault', hostId: host.id, status: 'completed', confirmationStatus: 'confirmed' })
    expect(task.authorizationJobId).toBe('enable-job')
  })
  it('keeps schedules paused and records rejection when consent is denied', async () => {
    savedTask(); vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(job.status).toBe('cancelled'))
    expect(loadScheduledTasks('vault', host.id)[0].enabled).toBe(false)
    expect(isScheduledTaskAuthorized('vault', loadScheduledTasks('vault', host.id)[0])).toBe(false)
    expect(job.confirmationStatus).toBe('rejected')
  })
})
