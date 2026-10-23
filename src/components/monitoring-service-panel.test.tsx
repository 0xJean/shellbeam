import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { MonitoringServicePanel } from './monitoring-service-panel'
import { monitoringServiceCopy } from '@/lib/locales/monitoring-service'
import { closeServiceScope, serviceIntentAction, serviceRequest, serviceScope, type ServiceIntent } from '@/lib/monitoring-service'
import { requestUserDecision } from '@/lib/user-confirmation'
const vault = vi.hoisted(() => { const state = { generation: 1 }; return { state, captureVaultScope: () => { const generation = state.generation; return () => generation === state.generation } } })
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ captureVaultScope: vault.captureVaultScope }) }))
vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: vi.fn() }))
vi.mock('@/lib/monitoring-service', async original => ({ ...await original<typeof import('@/lib/monitoring-service')>(), serviceScope: vi.fn(), closeServiceScope: vi.fn(), serviceRequest: vi.fn(), serviceIntentAction: vi.fn() }))
const service = { id: 'service', vaultId: 'vault', name: 'Monitor', endpoint: 'https://monitor.test', credentialRef: 'original-key', enabled: true, createdAt: 1, updatedAt: 2 }
const scope = { vaultId: 'vault', integrationId: 'service', configVersion: 2, session: 3, contextId: 'context', configurationIdentity: 'config' }
const config = { sitename: 'Server', description: '', private_site: true, notification_enabled: true, notification_method: 'webhook', notification_template: '{{message}}', login_notification: false, expire_notification_enabled: true, expire_notification_lead_days: 7, traffic_limit_percentage: 80 }
const row = (status: ServiceIntent['intent']['status'] = 'prepared'): ServiceIntent => ({ intent: { id: 'edit', scope, target: 'settings', revision: 1, status, jobId: 'audit-job', updatedAt: 100, observedAt: 0 }, baseline: config, desired: { ...config, sitename: 'Changed' }, observed: config })
const c = monitoringServiceCopy.en
const renderPanel = () => render(<I18nProvider><MonitoringServicePanel service={service} /></I18nProvider>)
async function read() { fireEvent.click(screen.getByText(c.title, { selector: 'summary' })); fireEvent.click(screen.getByRole('button', { name: c.read })); await screen.findByDisplayValue('Server'); await waitFor(() => expect(screen.getByRole('button', { name: c.read })).toBeEnabled()) }
beforeEach(() => {
  vault.state.generation++; localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(serviceScope).mockResolvedValue(scope); vi.mocked(closeServiceScope).mockResolvedValue(undefined)
  vi.mocked(requestUserDecision).mockResolvedValue({ accepted: true, reason: 'accepted' })
  vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'list' || action === 'metrics' ? [] : action === 'channels' ? [{ id: 'webhook' }, { id: 'custom-mail' }] : action === 'read' ? config : action === 'prepare' ? row() : { accepted: true, recipientReceipt: false }) as never)
  vi.mocked(serviceIntentAction).mockResolvedValue({ ...row('verified'), observed: row().desired })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

describe('native service management', () => {
  it.each(['en', 'zh-CN'] as const)('keeps remote reads and writes behind explicit controls (%s)', async locale => {
    localStorage.setItem('shellbeam.locale', locale); renderPanel(); await act(async () => {})
    expect(serviceRequest).toHaveBeenCalledExactlyOnceWith(scope, 'list')
    expect(serviceIntentAction).not.toHaveBeenCalled()
    expect(screen.getByText(monitoringServiceCopy[locale].description)).toBeInTheDocument()
    expect(closeServiceScope).toHaveBeenCalledExactlyOnceWith(scope)
  })
  it('uses one confirmed save, durable intent, one apply and verified readback', async () => {
    renderPanel(); await act(async () => {}); await read()
    fireEvent.change(screen.getByLabelText(c.name), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: c.save }))
    expect(await screen.findByRole('status')).toHaveTextContent(c.verified)
    expect(serviceRequest).toHaveBeenCalledWith(scope, 'prepare', { target: 'settings', confirmed: true, baseline: config, desired: { ...config, sitename: 'Changed' } })
    expect(serviceIntentAction).toHaveBeenCalledExactlyOnceWith(scope, row(), 'apply')
    expect(screen.getByRole('button', { name: c.save })).toBeDisabled()
  })
  it('does not prepare or write when confirmation is declined', async () => {
    vi.mocked(requestUserDecision).mockResolvedValue({ accepted: false, reason: 'rejected' })
    renderPanel(); await act(async () => {}); await read()
    fireEvent.change(screen.getByLabelText(c.name), { target: { value: 'Changed' } }); fireEvent.click(screen.getByRole('button', { name: c.save }))
    await waitFor(() => expect(screen.getByRole('button', { name: c.save })).toBeEnabled())
    expect(serviceRequest).not.toHaveBeenCalledWith(scope, 'prepare', expect.anything()); expect(serviceIntentAction).not.toHaveBeenCalled()
  })
  it('cancels the native context on unmount while a write is unresolved', async () => {
    let resolve!: (value: ServiceIntent) => void
    vi.mocked(serviceIntentAction).mockImplementation(() => new Promise(done => { resolve = done }))
    const view = renderPanel(); await act(async () => {}); await read()
    fireEvent.change(screen.getByLabelText(c.name), { target: { value: 'Changed' } }); fireEvent.click(screen.getByRole('button', { name: c.save }))
    await waitFor(() => expect(serviceIntentAction).toHaveBeenCalledOnce())
    vi.mocked(closeServiceScope).mockClear(); view.unmount()
    expect(closeServiceScope).toHaveBeenCalledWith(scope)
    await act(async () => { resolve(row('verified')) })
    expect(serviceIntentAction).toHaveBeenCalledTimes(1)
  })
  it('does not dispatch after prepare resolves in a different Vault session', async () => {
    let resolve!: (value: ServiceIntent) => void
    vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'prepare' ? await new Promise<ServiceIntent>(done => { resolve = done }) : action === 'list' || action === 'metrics' ? [] : action === 'channels' ? [] : config) as never)
    renderPanel(); await act(async () => {}); await read(); fireEvent.change(screen.getByLabelText(c.name), { target: { value: 'Changed' } }); fireEvent.click(screen.getByRole('button', { name: c.save }))
    await waitFor(() => expect(resolve).toBeTypeOf('function')); vault.state.generation++
    await act(async () => { resolve(row()) })
    expect(serviceIntentAction).not.toHaveBeenCalled(); expect(closeServiceScope).toHaveBeenCalledWith(scope)
  })
  it('recovers interrupted writes through reads and never automatically applies them', async () => {
    vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'list' ? [row('uncertain')] : config) as never)
    vi.mocked(serviceIntentAction).mockResolvedValue(row('retry'))
    renderPanel(); await screen.findByText(/audit-job/)
    expect(serviceIntentAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(c.title, { selector: 'summary' })); fireEvent.click(screen.getByText(/Changes & verification/, { selector: 'summary' })); fireEvent.click(screen.getByRole('button', { name: c.recover }))
    await waitFor(() => expect(serviceIntentAction).toHaveBeenCalledExactlyOnceWith(scope, row('uncertain'), 'reconcile', false))
  })
  it('reviews persisted changes read-only and preserves high-risk confirmation on retry', async () => {
    const retained = { ...row('conflict'), intent: { ...row('conflict').intent, target: 'retention:cpu' }, baseline: { retention_days: 30, metric_identity: 'cpu:created' }, desired: { retention_days: 7, metric_identity: 'cpu:created' }, observed: { retention_days: 14, metric_identity: 'cpu:created' } }
    vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'list' ? [retained] : {}) as never)
    vi.mocked(serviceIntentAction).mockResolvedValue({ ...retained, intent: { ...retained.intent, status: 'verified' } })
    renderPanel(); await screen.findByText(/audit-job/)
    fireEvent.click(screen.getByText(c.title, { selector: 'summary' })); fireEvent.click(screen.getByText(/Changes & verification/, { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: c.review }))
    expect(screen.getByLabelText(c.retentionDays)).toHaveValue(7)
    expect(screen.getByLabelText(c.retentionDays)).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: c.save })).toBeDisabled()
    expect(serviceIntentAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: c.retry }))
    await waitFor(() => expect(requestUserDecision).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high', message: expect.stringContaining(c.retentionHint) })))
    await waitFor(() => expect(screen.getByRole('button', { name: c.read })).toBeEnabled())
    expect(serviceIntentAction).toHaveBeenNthCalledWith(1, scope, retained, 'retry', true)
    // An already matching remote value is reconciled without another apply.
    expect(serviceIntentAction).toHaveBeenCalledTimes(1)
  })
  it('keeps channel credentials masked and preserves unknown configuration while editing', async () => {
    const channel = { url: 'https://receiver.test/hook', method: 'POST', content_type: 'application/json', headers: '{"Authorization":"synthetic-only"}', body: '{"message":"{{message}}"}', username: 'user', password: 'synthetic-only', extension: 'preserved' }
    vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'list' ? [] : action === 'read' ? channel : row()) as never)
    renderPanel(); await act(async () => {})
    fireEvent.click(screen.getByText(c.title, { selector: 'summary' })); fireEvent.change(screen.getByLabelText(c.title), { target: { value: 'webhook' } }); fireEvent.click(screen.getByRole('button', { name: c.read }))
    await screen.findByDisplayValue(channel.url)
    expect(screen.getByLabelText(c.url)).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText(c.headers)).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText(c.password)).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getByRole('button', { name: `${c.show} ${c.headers}` }))
    expect(screen.getByLabelText(c.headers)).toHaveAttribute('type', 'text')
    fireEvent.change(screen.getByLabelText(c.url), { target: { value: 'https://other.test/hook' } }); fireEvent.click(screen.getByRole('button', { name: c.save }))
    await waitFor(() => expect(serviceRequest).toHaveBeenCalledWith(scope, 'prepare', { target: 'webhook', confirmed: true, baseline: channel, desired: { ...channel, url: 'https://other.test/hook' } }))
  })
  it('reports server acceptance without claiming recipient delivery or replaying tests', async () => {
    renderPanel(); await act(async () => {}); await read(); fireEvent.click(screen.getByRole('button', { name: c.test }))
    expect(await screen.findByRole('status')).toHaveTextContent(c.testAccepted)
    expect(vi.mocked(serviceRequest).mock.calls.filter(([, action]) => action === 'test')).toHaveLength(1)
    expect(serviceIntentAction).not.toHaveBeenCalled()
  })
  it('preserves failures without displaying secret-bearing native errors', async () => {
    renderPanel(); await act(async () => {}); await read()
    vi.mocked(serviceRequest).mockRejectedValue('MONITORING_PERMISSION raw-password-must-not-appear')
    fireEvent.click(screen.getByRole('button', { name: c.test }))
    expect(await screen.findByRole('alert')).toHaveTextContent(c.permission)
    expect(screen.queryByText(/raw-password/)).not.toBeInTheDocument()
  })
})

it('requires high-risk confirmation for extension install and dispatches only its fixed target', async () => {
  const before = { installed: false, enabled: false }
  const intent = { ...row(), intent: { ...row().intent, target: 'extension' }, baseline: before, desired: { installed: true, enabled: true }, observed: before }
  vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'list' ? [] : action === 'read' ? before : intent) as never)
  vi.mocked(serviceIntentAction).mockResolvedValue({ ...intent, intent: { ...intent.intent, status: 'verified' }, observed: intent.desired })
  renderPanel(); await act(async () => {})
  fireEvent.click(screen.getByText(c.title, { selector: 'summary' })); fireEvent.change(screen.getByLabelText(c.title), { target: { value: 'load-policy' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enable server load alerts' }))
  await waitFor(() => expect(serviceIntentAction).toHaveBeenCalledExactlyOnceWith(scope, intent, 'apply'))
  expect(requestUserDecision).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high', message: expect.stringContaining('administrator RPC') }))
  expect(serviceRequest).toHaveBeenCalledWith(scope, 'prepare', { target: 'extension', baseline: before, desired: intent.desired, confirmed: true })
})
it('saves native load rules with creation identity and policy revision in the durable intent', async () => {
  const policy = { extension_identity: 'server-original', revision: 12, rules: [], silences: [] }
  vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'list' ? [] : action === 'channel-nodes' ? [{ id: 'node', name: 'WEB', createdAt: 'created' }] : action === 'load-status' ? { evaluations: {}, events: [] } : action === 'read' ? policy : row()) as never)
  renderPanel(); await act(async () => {})
  fireEvent.click(screen.getByText(c.title, { selector: 'summary' })); fireEvent.change(screen.getByLabelText(c.title), { target: { value: 'load-policy' } }); fireEvent.click(screen.getByRole('button', { name: c.read }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add load rule' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'Add load rule' })); fireEvent.click(screen.getByRole('button', { name: c.save }))
  await waitFor(() => expect(serviceRequest).toHaveBeenCalledWith(scope, 'prepare', expect.objectContaining({ target: 'load-policy', baseline: policy, desired: { ...policy, rules: [expect.objectContaining({ nodeId: 'node', nodeCreatedAt: 'created' })] }, confirmed: true })))
})
it('discards late configuration from a replaced service and revokes its old context', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(serviceRequest).mockImplementation(async (_scope, action) => (action === 'read' ? await new Promise<unknown>(done => { resolve = done }) : []) as never)
  const view = renderPanel(); await act(async () => {})
  fireEvent.click(screen.getByText(c.title, { selector: 'summary' })); fireEvent.click(screen.getByRole('button', { name: c.read })); await waitFor(() => expect(resolve).toBeTypeOf('function'))
  view.rerender(<I18nProvider><MonitoringServicePanel service={{ ...service, endpoint: 'https://replacement.test', updatedAt: 3 }} /></I18nProvider>)
  await act(async () => { resolve(config) })
  expect(screen.queryByDisplayValue('Server')).not.toBeInTheDocument(); expect(closeServiceScope).toHaveBeenCalledWith(scope)
  expect(serviceIntentAction).not.toHaveBeenCalled()
})
