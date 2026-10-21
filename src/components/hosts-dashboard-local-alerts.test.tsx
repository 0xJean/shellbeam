import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { HostsDashboard } from './hosts-dashboard'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { buildHostOpsViews, loadHostOpsViews } from '@/lib/host-ops-view'
import { actOnLocalAlert, type LocalAlertEvaluation, type LocalAlertRecord, type LocalAlertState } from '@/lib/local-alert-rules'
import { clearLocalOpsMemory, loadLocalAlertState, saveLocalAlertState } from '@/lib/local-ops-store'
import { applyLocalOpsDocument, flushLocalOpsHost, queueLocalOpsDocument, resetLocalOpsPersistenceMemory, type LocalOpsDocument } from '@/lib/local-ops-persistence'
import { clearProbeAlertRuntimeDiagnostic, setProbeAlertRuntimeDiagnostic } from '@/lib/probe-alert-runtime-state'
import type { OperationAuditEntry, OperationJob } from '@/lib/operation-job'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/lib/workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
vi.mock('@/lib/host-ops-view', async (original) => ({ ...(await original<typeof import('@/lib/host-ops-view')>()), loadHostOpsViews: vi.fn() }))

const host: HostProfile = { id: 'same-host', vaultId: 'vault-a', name: 'API via saved bastion', address: '10.0.0.8', port: 22, username: 'ops', authType: 'password', jumpHostId: 'saved-bastion', jumpHost: 'outdated-endpoint', group: 'Production', tags: [], createdAt: 1, updatedAt: 1 }
let documents: Map<string, LocalOpsDocument>
let jobs: Map<string, OperationJob>
let actionWait: (document: LocalOpsDocument) => Promise<void>
const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function seed(vaultId: string, name: string) {
  const alert: LocalAlertRecord = { ruleId: 'builtin-probe', hostId: host.id, name, metric: 'probe-provider', status: 'active', severity: 'warning', openedAt: 1000, updatedAt: 1000, resolvedAt: null, value: 1, source: 'shellbeam-agent', transport: 'proxy-jump' }
  const state: LocalAlertState = { version: 1, alerts: [alert], audit: [], evaluations: [] }
  documents.set(vaultId, { vaultId, hostId: host.id, kind: 'alert-state', payload: state, revision: 1, updatedAt: 1000 })
  saveLocalAlertState(vaultId, host.id, state)
}
function element(vaultId = 'vault-a', extra: Partial<React.ComponentProps<typeof HostsDashboard>> = {}) {
  return <I18nProvider><HostsDashboard activeVaultId={vaultId} vaultUnlocked hosts={[{ ...host, vaultId }]} selectedHostId={null} loading={false} onSelectHost={vi.fn()} onCreateHost={vi.fn()} onUpdateHost={vi.fn()} onDeleteHost={vi.fn()} {...extra} /></I18nProvider>
}
async function openListOperations() {
  const toggle = await screen.findByTestId('host-ops-details-toggle')
  expect(toggle).toBeVisible()
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  expect(screen.getByTestId('host-ops-details')).toBeVisible()
}
beforeEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en')
  clearLocalOpsMemory(); resetLocalOpsPersistenceMemory()
  clearProbeAlertRuntimeDiagnostic('vault-a', host.id); clearProbeAlertRuntimeDiagnostic('vault-b', host.id)
  documents = new Map(); jobs = new Map(); actionWait = async () => {}
  seed('vault-a', 'A Probe collection'); seed('vault-b', 'B Probe collection')
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    const request = (args as { request?: Record<string, unknown> } | undefined)?.request
    if (command === 'mcp_list_project_deployments') return { projects: [], total: 0, observedAt: 0 }
    if (command === 'local_ops_list') {
      const query = (args as { query: { vaultId: string; kind?: string } }).query
      const document = documents.get(query.vaultId)
      return document && (!query.kind || query.kind === document.kind) ? [document] : []
    }
    if (command === 'local_ops_upsert') {
      const payload = (args as { payload: LocalOpsDocument & { expectedRevision: number } }).payload
      const previous = documents.get(payload.vaultId)
      if (previous && previous.revision !== payload.expectedRevision) throw new Error('LOCAL_OPS_REVISION_CONFLICT')
      const document = { ...payload, revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now() }
      documents.set(payload.vaultId, document)
      return document
    }
    if (command === 'operation_job_create') {
      const job = { ...request, jobId: `job-${jobs.size + 1}`, auditId: `audit-${jobs.size + 1}`, status: 'queued', confirmationStatus: 'pending', queuedAt: Date.now(), updatedAt: Date.now() } as OperationJob
      jobs.set(job.jobId, job); return job
    }
    if (command === 'operation_job_update') {
      const id = request!.jobId as string
      const job = { ...jobs.get(id)!, ...request, updatedAt: Date.now() } as OperationJob
      jobs.set(id, job); return job
    }
    if (command === 'local_ops_alert_action') {
      const payload = (args as { payload: { vaultId: string; hostId: string; ruleId: string; action: 'acknowledge' | 'close'; operationJobId: string } }).payload
      const previous = documents.get(payload.vaultId)!
      await actionWait(previous)
      const job = jobs.get(payload.operationJobId)!
      expect(job).toMatchObject({ hostId: payload.hostId, vaultId: payload.vaultId, target: payload.ruleId, status: 'running', confirmationStatus: 'confirmed' })
      const document = { ...previous, payload: actOnLocalAlert(previous.payload as LocalAlertState, payload.ruleId, payload.action, Date.now(), payload.operationJobId), revision: previous.revision + 1, updatedAt: Date.now() }
      documents.set(payload.vaultId, document); return document
    }
    return []
  })
  vi.mocked(loadHostOpsViews).mockReset().mockImplementation(async (hosts, options) => buildHostOpsViews({ hosts,
    localAlertStates: Object.fromEntries(hosts.map((row) => [row.id, loadLocalAlertState(options?.vaultId, row.id)])),
    audits: [...jobs.values()].filter((job) => job.vaultId === options?.vaultId).map((job) => ({ ...job, event: job.status, createdAt: job.updatedAt } as OperationAuditEntry)),
  }))
  vi.mocked(runWorkspaceRemoteCommand).mockReset()
})
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.restoreAllMocks(); clearLocalOpsMemory(); resetLocalOpsPersistenceMemory(); clearProbeAlertRuntimeDiagnostic('vault-a', host.id); clearProbeAlertRuntimeDiagnostic('vault-b', host.id) })

describe('host card canonical local alert actions', () => {
  it('uses the same confirmation and durable OperationJob lifecycle from the unified alerts center', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(element())
    fireEvent.click(await screen.findByTestId('host-alerts-open'))
    let incident = await screen.findByTestId('host-incident')
    expect(incident).toHaveAttribute('data-host-id', host.id)
    fireEvent.click(within(incident).getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(jobs.get('job-1')).toMatchObject({ status: 'completed', action: 'local-alert.acknowledge', confirmationStatus: 'confirmed', vaultId: 'vault-a', hostId: host.id, transport: 'proxy-jump' }))
    expect(loadLocalAlertState('vault-a', host.id).audit.at(-1)).toMatchObject({ event: 'acknowledged', operationJobId: 'job-1' })
    expect(window.confirm).toHaveBeenCalledTimes(1)
    incident = screen.getByTestId('host-incident')
    expect(within(incident).queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument()
    fireEvent.click(within(incident).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(jobs.get('job-2')).toMatchObject({ status: 'completed', action: 'local-alert.close', confirmationStatus: 'confirmed', vaultId: 'vault-a', hostId: host.id, transport: 'proxy-jump' }))
    expect(loadLocalAlertState('vault-a', host.id).audit.at(-1)).toMatchObject({ event: 'closed', operationJobId: 'job-2' })
    expect(window.confirm).toHaveBeenCalledTimes(2)
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    expect(screen.queryByTestId('host-incident')).not.toBeInTheDocument()
  })

  it.each(['grid', 'list'] as const)('accepts a real collection newer than the last 15-second display tick in %s', async (mode) => {
    const initialTime = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(initialTime)
    render(element())
    if (mode === 'grid') fireEvent.click(screen.getByTitle('Grid view'))
    await openListOperations()
    await screen.findByTestId('host-local-alert')
    const sampledAt = initialTime + 1_000
    clock.mockReturnValue(sampledAt)
    await act(async () => {
      applyLocalOpsDocument(documents.get('vault-a')!)
      saveLocalAlertState('vault-a', host.id, { version: 1, alerts: [], audit: [], evaluations: [{ ruleId: `probe:ssh-agentless:${'a'.repeat(32)}:metrics`, sampledAt, state: 'healthy', value: 0, pendingSince: null, recoverySince: null }] })
      await flushLocalOpsHost('vault-a', host.id)
    })
    const row = await screen.findByTestId('host-probe-evaluation')
    expect(row).toHaveAttribute('data-state', 'healthy')
    expect(row).toHaveAttribute('data-sampled-at', String(sampledAt))
    expect(row).toHaveTextContent('Just now')
  })

  it.each(['grid', 'list'] as const)('projects live healthy evaluations without alerts, resolved sample and cross-session unknown evidence in %s', async (mode) => {
    const ruleId = `probe:ssh-agentless:${'a'.repeat(32)}:metrics`
    const sampledAt = Date.now() - 60_000
    const evaluation: LocalAlertEvaluation = { ruleId, sampledAt, pendingSince: null, recoverySince: null, state: 'healthy', value: 0 }
    const state: LocalAlertState = { version: 1, alerts: [], audit: [], evaluations: [evaluation] }
    applyLocalOpsDocument(documents.get('vault-a')!)
    saveLocalAlertState('vault-a', host.id, state)
    await flushLocalOpsHost('vault-a', host.id)
    const view = render(element())
    if (mode === 'grid') fireEvent.click(screen.getByTitle('Grid view'))
    await openListOperations()
    const row = await screen.findByTestId('host-probe-evaluation')
    expect(row).toBeVisible()
    expect(row).toHaveTextContent('Healthy')
    expect(row).toHaveAttribute('data-sampled-at', String(sampledAt))
    expect(screen.queryByTestId('host-local-alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('host-ops-summary')).toHaveAttribute('data-vault-id', 'vault-a')
    expect(screen.getByTestId('host-ops-summary')).toHaveAttribute('data-host-id', host.id)
    const resolvedAt = Date.now() - 1_000
    await act(async () => {
      saveLocalAlertState('vault-a', host.id, { ...state, alerts: [{ ...((documents.get('vault-b')!.payload as LocalAlertState).alerts[0]), ruleId, status: 'resolved', value: 0, updatedAt: resolvedAt, resolvedAt, operationJobId: 'ack-before-recovery' }] })
      await flushLocalOpsHost('vault-a', host.id)
    })
    expect(screen.getByTestId('host-local-alert')).toHaveAttribute('data-job-id', 'ack-before-recovery')
    expect(screen.getByTestId('host-local-alert')).toHaveAttribute('data-resolved-at', String(resolvedAt))
    expect(screen.getByTestId('host-probe-evaluation')).toHaveAttribute('data-sampled-at', String(sampledAt))
    // Reopening persisted evidence resets health to unknown but retains its
    // original sample; the journal's newer update is never a sample.
    act(() => { clearLocalOpsMemory(); window.dispatchEvent(new StorageEvent('storage')) })
    expect(screen.getByTestId('host-probe-evaluation')).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByTestId('host-probe-evaluation')).toHaveAttribute('title', new Date(sampledAt).toISOString())
    view.unmount()
  })

  it.each(['grid', 'list'] as const)('keeps same-id Probe evaluations isolated by active Vault, supports validated legacy hosts and drops foreign host scope in %s', async (mode) => {
    const ruleId = `probe:ssh-agentless:${'a'.repeat(32)}:metrics`
    const samples = { 'vault-a': Date.now() - 50_000, 'vault-b': Date.now() - 20_000 }
    for (const vault of ['vault-a', 'vault-b'] as const) {
      applyLocalOpsDocument(documents.get(vault)!)
      saveLocalAlertState(vault, host.id, { version: 1, alerts: [], audit: [], evaluations: [{ ruleId, sampledAt: samples[vault], state: vault === 'vault-a' ? 'firing' : 'healthy', value: vault === 'vault-a' ? 1 : 0, pendingSince: null, recoverySince: null }] })
      await flushLocalOpsHost(vault, host.id)
    }
    const view = render(element('vault-a', { hosts: [{ ...host, vaultId: undefined }] }))
    if (mode === 'grid') fireEvent.click(screen.getByTitle('Grid view'))
    await openListOperations()
    let row = await screen.findByTestId('host-probe-evaluation')
    expect(row).toHaveAttribute('data-vault-id', 'vault-a')
    expect(row).toHaveAttribute('data-state', 'firing')
    expect(row).toHaveAttribute('data-sampled-at', String(samples['vault-a']))
    view.rerender(element('vault-b', { hosts: [{ ...host, vaultId: undefined }] }))
    await waitFor(() => expect(screen.getByTestId('host-probe-evaluation')).toHaveAttribute('data-vault-id', 'vault-b'))
    row = screen.getByTestId('host-probe-evaluation')
    expect(row).toHaveAttribute('data-state', 'healthy')
    expect(row).toHaveAttribute('data-sampled-at', String(samples['vault-b']))
    await act(async () => {
      saveLocalAlertState('vault-a', host.id, { version: 1, alerts: [], audit: [], evaluations: [{ ruleId, sampledAt: Date.now(), state: 'firing', value: 1, pendingSince: null, recoverySince: null }] })
      await flushLocalOpsHost('vault-a', host.id)
    })
    expect(row).toHaveAttribute('data-sampled-at', String(samples['vault-b']))
    view.rerender(element('vault-b', { hosts: [{ ...host, vaultId: 'vault-a' }] }))
    await waitFor(() => expect(screen.queryByTestId('host-probe-evaluation')).not.toBeInTheDocument())
  })

  it('shows scope-specific lifecycle and persistence failures from real events without changing provider health or exposing exceptions', async () => {
    const view = render(element())
    await openListOperations()
    await screen.findByTestId('host-local-alert')
    const health = document.querySelector('[data-host-health]')!.getAttribute('data-host-health')
    act(() => setProbeAlertRuntimeDiagnostic('vault-a', host.id, 'listener-failed'))
    expect(await screen.findByText('Probe alert recording is unavailable. The next collection will retry.')).toBeVisible()
    expect(document.querySelector('[data-host-health]')).toHaveAttribute('data-host-health', health)
    view.rerender(element('vault-b'))
    await openListOperations()
    await waitFor(() => expect(screen.getByTestId('host-local-alert')).toHaveTextContent('B Probe collection'))
    expect(screen.queryByText('Probe alert recording is unavailable. The next collection will retry.')).not.toBeInTheDocument()
    view.rerender(element())
    await openListOperations()
    await screen.findByText('Probe alert recording is unavailable. The next collection will retry.')
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'local_ops_upsert') throw new Error('private-test-error-must-not-be-rendered')
      return original(command, args)
    })
    await act(async () => {
      await queueLocalOpsDocument('vault-a', host.id, 'alert-state', documents.get('vault-a')!.payload).catch(() => undefined)
      await flushLocalOpsHost('vault-a', host.id).catch(() => undefined)
    })
    expect(await screen.findByText('Native operations history could not be saved or changed in another session. Refresh before continuing.')).toBeVisible()
    expect(document.body).not.toHaveTextContent('private-test-error-must-not-be-rendered')
    expect(document.querySelector('[data-host-health]')).toHaveAttribute('data-host-health', health)
    act(() => {
      clearProbeAlertRuntimeDiagnostic('vault-a', host.id)
      applyLocalOpsDocument({ ...documents.get('vault-a')!, revision: 2 })
    })
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
  it('rejects consent with a same-vault reference-ProxyJump cancelled job and zero lifecycle or remote writes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(element())
    await openListOperations()
    expect(await screen.findByTestId('local-host-alert-ack-builtin-probe')).toBeVisible()
    fireEvent.click(screen.getByTestId('local-host-alert-ack-builtin-probe'))
    await waitFor(() => expect([...jobs.values()][0]).toMatchObject({ status: 'cancelled', confirmationStatus: 'rejected', hostId: host.id, vaultId: 'vault-a', action: 'local-alert.acknowledge', transport: 'proxy-jump' }))
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('A Probe collection'))
    expect(loadLocalAlertState('vault-a', host.id).alerts[0].status).toBe('active')
    expect(invoke).not.toHaveBeenCalledWith('local_ops_alert_action', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('local_ops_upsert', expect.anything())
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })

  it.each(['grid', 'list'] as const)('confirms once, links the native lifecycle job and refreshes its same-host audit in %s', async (mode) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(element())
    if (mode === 'grid') fireEvent.click(screen.getByTitle('Grid view'))
    await openListOperations()
    expect(await screen.findByTestId('local-host-alert-ack-builtin-probe')).toBeVisible()
    fireEvent.click(screen.getByTestId('local-host-alert-ack-builtin-probe'))
    await waitFor(() => expect(screen.getByTestId('host-local-alert')).toHaveAttribute('data-alert-status', 'acknowledged'))
    await waitFor(() => expect(screen.getByTestId('host-ops-details-summary')).toHaveTextContent('local-alert.acknowledge builtin-probe · completed'))
    expect(screen.getByTestId('host-local-alert')).toHaveTextContent('job=job-1')
    expect(screen.queryByTestId('local-host-alert-ack-builtin-probe')).not.toBeInTheDocument()
    expect(loadLocalAlertState('vault-a', host.id).audit.at(-1)).toMatchObject({ event: 'acknowledged', operationJobId: 'job-1' })
    expect([...jobs.values()][0]).toMatchObject({ status: 'completed', confirmationStatus: 'confirmed', provider: 'local-ops', transport: 'proxy-jump', source: 'workspace' })
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'local_ops_alert_action')).toHaveLength(1)
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    expect(screen.getByTestId('local-host-alert-close-builtin-probe')).toBeVisible()
    fireEvent.click(screen.getByTestId('local-host-alert-close-builtin-probe'))
    await waitFor(() => expect(screen.getByTestId('host-local-alert')).toHaveAttribute('data-alert-status', 'closed'))
    expect(screen.getByTestId('host-local-alert')).toHaveTextContent('job=job-2')
    expect(screen.queryByTestId('local-host-alert-close-builtin-probe')).not.toBeInTheDocument()
    expect(jobs.get('job-2')).toMatchObject({ action: 'local-alert.close', hostId: host.id, vaultId: 'vault-a', transport: 'proxy-jump', confirmationStatus: 'confirmed' })
    expect(window.confirm).toHaveBeenCalledTimes(2)
  })

  it.each(['completed', 'failed'] as const)('isolates a late %s A result from B data, errors and in-flight busy state with the same host/rule ids', async (status) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const old = deferred(), current = deferred()
    actionWait = async (document) => document.vaultId === 'vault-a' ? old.promise : current.promise
    const view = render(element())
    await openListOperations()
    expect(await screen.findByTestId('local-host-alert-ack-builtin-probe')).toBeVisible()
    fireEvent.click(screen.getByTestId('local-host-alert-ack-builtin-probe'))
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'local_ops_alert_action')).toHaveLength(1))
    view.rerender(element('vault-b'))
    await openListOperations()
    const button = await screen.findByTestId('local-host-alert-ack-builtin-probe')
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByTestId('host-local-alert')).toHaveTextContent('B Probe collection')
    fireEvent.click(button)
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'local_ops_alert_action')).toHaveLength(2))
    await act(async () => status === 'failed' ? old.reject(new Error('LOCAL_OPS_REVISION_CONFLICT')) : old.resolve())
    await waitFor(() => expect(jobs.get('job-1')?.status).toBe(status))
    expect(screen.getByTestId('local-host-alert-ack-builtin-probe')).toBeDisabled()
    expect(screen.getByTestId('host-local-alert')).toHaveAttribute('data-alert-status', 'active')
    expect(screen.getByTestId('host-local-alert')).not.toHaveTextContent('A Probe collection')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => current.resolve())
    await waitFor(() => expect(screen.getByTestId('host-local-alert')).toHaveTextContent('job=job-2'))
    expect(jobs.get('job-1')).toMatchObject({ vaultId: 'vault-a', status })
    expect(jobs.get('job-2')).toMatchObject({ vaultId: 'vault-b', status: 'completed' })
    expect(loadLocalAlertState('vault-a', host.id).alerts[0].operationJobId).toBe(status === 'completed' ? 'job-1' : undefined)
    expect(loadLocalAlertState('vault-b', host.id).alerts[0].operationJobId).toBe('job-2')
  })

  it('shows a scoped safe error on a native CAS failure and keeps the incident active with its failed audit', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    actionWait = async () => { throw new Error('LOCAL_OPS_REVISION_CONFLICT') }
    render(element())
    await openListOperations()
    expect(await screen.findByTestId('local-host-alert-ack-builtin-probe')).toBeVisible()
    fireEvent.click(screen.getByTestId('local-host-alert-ack-builtin-probe'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The alert action could not be fully recorded'))
    expect(screen.getByTestId('host-local-alert')).toHaveAttribute('data-alert-status', 'active')
    await waitFor(() => expect(screen.getByTestId('local-host-alert-ack-builtin-probe')).toBeEnabled())
    expect(jobs.get('job-1')).toMatchObject({ status: 'failed', confirmationStatus: 'confirmed', vaultId: 'vault-a' })
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })

  it('omits action controls for a locked vault or a host from a conflicting vault', async () => {
    const view = render(element('vault-a', { vaultUnlocked: false }))
    await openListOperations()
    await screen.findByTestId('host-local-alert')
    expect(screen.queryByTestId('local-host-alert-ack-builtin-probe')).not.toBeInTheDocument()
    view.rerender(element('vault-a', { hosts: [{ ...host, vaultId: 'different' }] }))
    await waitFor(() => expect(screen.queryByTestId('local-host-alert-ack-builtin-probe')).not.toBeInTheDocument())
    expect(jobs.size).toBe(0)
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })
})
