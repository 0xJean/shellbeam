import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { compatibleAgentCopy } from '@/lib/locales/compatible-agent'
import { cancelCompatibleAgent, compatibleAgentPolicy, operateCompatibleAgent, prepareCompatibleAgent, readCompatibleAgent, type CompatibleAgentPreview, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import { requestUserDecision } from '@/lib/user-confirmation'
import { CompatibleAgentPanel, CompatibleAgentTools } from './compatible-agent-panel'
const vault = vi.hoisted(() => { const state = { generation: 0 }; return { state, capture: () => { const generation = state.generation; return () => generation === state.generation } } })
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'vault', captureVaultScope: vault.capture }) }))
vi.mock('@/lib/compatible-agent', () => ({ cancelCompatibleAgent: vi.fn(), compatibleAgentPolicy: vi.fn(), operateCompatibleAgent: vi.fn(), prepareCompatibleAgent: vi.fn(), readCompatibleAgent: vi.fn() }))
vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: vi.fn() }))
const host = { vaultId: 'vault', id: 'host', name: 'Test', address: 'host.test', port: 22, username: 'runner', authType: 'password' as const, group: 'test', tags: [], createdAt: 1, updatedAt: 2 }
const preview: CompatibleAgentPreview = { planId: 'plan', action: 'install', hostName: 'Test', nodeId: 'node', endpoint: 'https://monitor.test', transport: 'ssh-proxyjump', account: 'runner', serviceScope: 'user', dataDirectory: '/home/runner/.local/share/shellbeam/komari/test', artifactBytes: 12000000, currentVersion: null, targetVersion: '1.5.11', status: 'absent', expiresAt: Date.now() + 300000 }
const release = { manifest: { version: '1.5.11', sha256: 'a'.repeat(64) }, publicKey: 'public' }
const row = (status = 'active'): CompatibleAgentRecord => ({ vaultId: 'vault', hostId: 'host', hostCreatedAt: 1, integrationId: 'source', deployment: 'deployment', revision: 1, status, action: 'install', jobId: 'durable-job', endpoint: 'https://monitor.test', nodeId: 'node', current: release, previous: { ...release, manifest: { ...release.manifest, version: '1.5.10' } }, requested: release, observedAt: 1000, updatedAt: 1000, errorCode: null, observation: { status: status === 'retired' ? 'retired' : 'active', active: status !== 'retired' } })
const c = compatibleAgentCopy.en
const panel = () => render(<I18nProvider><CompatibleAgentPanel host={host} integrationId="source" /></I18nProvider>)
beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vault.state.generation++; vi.mocked(readCompatibleAgent).mockResolvedValue(null); vi.mocked(prepareCompatibleAgent).mockResolvedValue(preview); vi.mocked(operateCompatibleAgent).mockResolvedValue(row()); vi.mocked(cancelCompatibleAgent).mockResolvedValue(); vi.mocked(requestUserDecision).mockResolvedValue({ accepted: true, reason: 'accepted' }) })
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })
describe('compatible monitoring probe lifecycle', () => {
  it('keeps unconfigured hosts unchanged and never contacts the server on mount', async () => {
    const view = render(<I18nProvider><CompatibleAgentTools host={host} /></I18nProvider>)
    await act(async () => {})
    expect(view.container).toBeEmptyDOMElement(); expect(readCompatibleAgent).toHaveBeenCalledExactlyOnceWith('vault', 'host'); expect(prepareCompatibleAgent).not.toHaveBeenCalled()
  })
  it('retains a cleanup entry when the monitoring source was removed', async () => {
    vi.mocked(readCompatibleAgent).mockResolvedValue(row())
    render(<I18nProvider><CompatibleAgentTools host={host} /></I18nProvider>)
    expect(await screen.findByText(c.title)).toBeInTheDocument(); expect(operateCompatibleAgent).not.toHaveBeenCalled()
  })
  it.each(['en', 'zh-CN'] as const)('keeps monitoring-only hosts free of SSH actions (%s)', async locale => {
    localStorage.setItem('shellbeam.locale', locale)
    render(<I18nProvider><CompatibleAgentTools host={{ ...host, connections: [] }} integrationId="source" /></I18nProvider>)
    const details = screen.getByTestId('compatible-agent-tools') as HTMLDetailsElement
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    expect(screen.getByText(compatibleAgentCopy[locale].ssh)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: compatibleAgentCopy[locale].install })).not.toBeInTheDocument()
  })
  it('shows host node route and version in confirmation and uses one native intent', async () => {
    panel(); await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: c.install }))
    expect(await screen.findByText('durable-job')).toBeInTheDocument()
    expect(prepareCompatibleAgent).toHaveBeenCalledExactlyOnceWith({ vaultId: 'vault', hostId: 'host', integrationId: 'source', action: 'install' })
    expect(requestUserDecision).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'vault', risk: 'high', message: expect.stringContaining('ssh-proxyjump') }))
    expect(operateCompatibleAgent).toHaveBeenCalledExactlyOnceWith('plan', true); expect(cancelCompatibleAgent).toHaveBeenCalledWith('plan')
  })
  it('does not overwrite a completed operation with a late initial record read', async () => {
    let resolve!: (r: CompatibleAgentRecord | null) => void
    vi.mocked(readCompatibleAgent).mockImplementation(() => new Promise(done => { resolve = done }))
    panel(); fireEvent.click(screen.getByRole('button', { name: c.install })); await screen.findByText('durable-job')
    await act(async () => { resolve(null) }); expect(screen.getByText('durable-job')).toBeInTheDocument()
  })
  it('does not execute after rejected confirmation', async () => {
    vi.mocked(requestUserDecision).mockResolvedValue({ accepted: false, reason: 'rejected' }); panel(); await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: c.install })); await waitFor(() => expect(cancelCompatibleAgent).toHaveBeenCalledWith('plan')); expect(operateCompatibleAgent).not.toHaveBeenCalled()
  })
  it('never dispatches a late preview after the Vault generation changed', async () => {
    let resolve!: (p: CompatibleAgentPreview) => void
    vi.mocked(prepareCompatibleAgent).mockImplementation(() => new Promise(done => { resolve = done }))
    panel(); await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: c.install })); await waitFor(() => expect(resolve).toBeTypeOf('function')); vault.state.generation++
    await act(async () => { resolve(preview) }); expect(operateCompatibleAgent).not.toHaveBeenCalled(); expect(requestUserDecision).not.toHaveBeenCalled(); expect(cancelCompatibleAgent).toHaveBeenCalledWith('plan')
  })
  it('blocks concurrent clicks and revokes an outstanding plan on unmount', async () => {
    let resolve!: (r: CompatibleAgentRecord) => void
    vi.mocked(operateCompatibleAgent).mockImplementation(() => new Promise(done => { resolve = done }))
    const view = panel(); await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: c.install })); await waitFor(() => expect(operateCompatibleAgent).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: c.install })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: c.install })); expect(prepareCompatibleAgent).toHaveBeenCalledOnce()
    view.unmount(); expect(cancelCompatibleAgent).toHaveBeenCalledWith('plan'); await act(async () => { resolve(row()) })
  })
  it('recovers pending operations only through a new explicit read-only check', async () => {
    vi.mocked(readCompatibleAgent).mockResolvedValue(row('unknown')); vi.mocked(prepareCompatibleAgent).mockResolvedValue({ ...preview, action: 'inspect' })
    panel(); await screen.findByText('durable-job'); expect(operateCompatibleAgent).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: c.upgrade })).toBeDisabled(); expect(screen.getByRole('button', { name: c.uninstall })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: c.inspect })); await waitFor(() => expect(operateCompatibleAgent).toHaveBeenCalledExactlyOnceWith('plan', false)); expect(requestUserDecision).not.toHaveBeenCalled()
  })
  it('shows a verified failed rollback outcome without claiming installation success', async () => {
    vi.mocked(operateCompatibleAgent).mockResolvedValue({ ...row('rolled-back'), observation: { status: 'retired', active: false }, errorCode: 'KOMARI_AGENT_REPORT_NOT_VERIFIED' })
    panel(); await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: c.install })); expect(await screen.findByRole('alert')).toHaveTextContent(c.report)
    expect(screen.getByRole('status')).toHaveTextContent(c['rolled-back']); await waitFor(() => expect(screen.getByRole('button', { name: c.install })).toBeEnabled())
  })
  it('does not change publisher trust without an explicit confirmed save', async () => {
    vi.mocked(compatibleAgentPolicy).mockResolvedValue({ enabled: false, manifestUrl: '', trustedPublicKey: '', allowedHosts: [] })
    panel(); await act(async () => {}); expect(compatibleAgentPolicy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(c.policy)); fireEvent.click(screen.getByRole('button', { name: c.loadPolicy })); await screen.findByRole('button', { name: c.savePolicy })
    vi.mocked(requestUserDecision).mockResolvedValue({ accepted: false, reason: 'rejected' }); fireEvent.click(screen.getByRole('button', { name: c.savePolicy })); await waitFor(() => expect(requestUserDecision).toHaveBeenCalledOnce()); expect(compatibleAgentPolicy).toHaveBeenCalledExactlyOnceWith()
  })
})
