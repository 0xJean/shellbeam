import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { compatibleAgentCopy } from '@/lib/locales/compatible-agent'
import { cancelCompatibleAgent, compatibleAgentPolicy, operateCompatibleAgent, prepareCompatibleAgent, readCompatibleAgent, type CompatibleAgentPreview, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import { requestUserDecision } from '@/lib/user-confirmation'
import { CompatibleAgentPanel, CompatibleAgentTools } from './compatible-agent-panel'
import pins from '../../releases/compatible-probe-pins.json'
const vault = vi.hoisted(() => { const state = { generation: 0 }; return { state, capture: () => { const generation = state.generation; return () => generation === state.generation } } })
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'vault', captureVaultScope: vault.capture }) }))
vi.mock('@/lib/compatible-agent', () => ({ cancelCompatibleAgent: vi.fn(), compatibleAgentPolicy: vi.fn(), operateCompatibleAgent: vi.fn(), prepareCompatibleAgent: vi.fn(), readCompatibleAgent: vi.fn() }))
vi.mock('./probe-transfer-panel', () => ({ ProbeTransferPanel: () => null }))
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
  it.each(['en', 'zh-CN'] as const)('shows reviewed distribution and both upgrade/rollback identities (%s)', async locale => {
    localStorage.setItem('shellbeam.locale', locale)
    const copy = compatibleAgentCopy[locale]
    const manifest = (version: '1.5.11' | '1.5.12') => ({ runtime: 'komari', platform: 'linux', architecture: 'amd64', version, sha256: pins.versions[version].amd64.sha256, sizeBytes: pins.versions[version].amd64.size })
    const current = { manifest: manifest('1.5.12'), publicKey: 'public' }
    const previous = { manifest: manifest('1.5.11'), publicKey: 'public' }
    vi.mocked(readCompatibleAgent).mockResolvedValue({ ...row(), current, previous })
    vi.mocked(requestUserDecision).mockResolvedValue({ accepted: false, reason: 'rejected' })
    panel()
    expect(await screen.findByTestId('compatible-agent-origin')).toHaveTextContent(copy.distributions.shellbeam)
    expect(screen.getByTestId('compatible-agent-origin')).toHaveTextContent('0xJean/shellbeam-monitoring-agent · 4e81478e4bde')
    expect(screen.getByTestId('compatible-agent-panel')).toHaveAttribute('data-previous-version', '1.5.11')
    for (const action of ['rollback', 'upgrade'] as const) {
      const from = action === 'rollback' ? current : previous, to = action === 'rollback' ? previous : current
      vi.mocked(prepareCompatibleAgent).mockResolvedValue({ ...preview, action, currentVersion: from.manifest.version, currentArtifact: from.manifest, targetVersion: to.manifest.version, targetArtifact: to.manifest })
      fireEvent.click(screen.getByRole('button', { name: copy[action] }))
      await waitFor(() => expect(screen.getByRole('button', { name: copy[action] })).toBeEnabled())
      const message = vi.mocked(requestUserDecision).mock.calls.at(-1)?.[0].message
      expect(message).toContain(`${action === 'rollback' ? copy.distributions.shellbeam : copy.distributions.upstream} ${from.manifest.version} → ${action === 'rollback' ? copy.distributions.upstream : copy.distributions.shellbeam} ${to.manifest.version}`)
    }
    expect(operateCompatibleAgent).not.toHaveBeenCalled()
  })
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
  it('uses the built-in source without requesting a key and keeps custom settings optional', async () => {
    vi.mocked(compatibleAgentPolicy).mockResolvedValue({ source: 'official', enabled: true, manifestUrl: 'https://official.test/catalog.json', trustedPublicKey: 'compiled-root', allowedHosts: ['official.test'] })
    panel(); await act(async () => {})
    expect(screen.getByText(c.officialHint)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: c.install })); await screen.findByText('durable-job')
    expect(compatibleAgentPolicy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(c.policy)); fireEvent.click(screen.getByRole('button', { name: c.loadPolicy })); await screen.findByRole('combobox', { name: c.source })
    expect(screen.queryByLabelText(c.publicKey)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: c.source }), { target: { value: 'custom' } })
    expect(screen.getByLabelText(c.publicKey)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: c.source }), { target: { value: 'official' } })
    fireEvent.click(screen.getByRole('button', { name: c.savePolicy }))
    await screen.findByText(c.saved)
    expect(compatibleAgentPolicy).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'official', enabled: true }), true)
  })
  it('offers readback and uninstall when the official catalog is expired', async () => {
    vi.mocked(readCompatibleAgent).mockResolvedValue(row())
    vi.mocked(prepareCompatibleAgent).mockRejectedValue('KOMARI_AGENT_CATALOG_EXPIRED')
    panel(); await screen.findByText('durable-job'); fireEvent.click(screen.getByRole('button', { name: c.upgrade }))
    expect(await screen.findByRole('alert')).toHaveTextContent(c.catalogStale)
    expect(screen.getByRole('button', { name: c.inspect })).toBeEnabled()
    expect(screen.getByRole('button', { name: c.uninstall })).toBeEnabled()
    expect(operateCompatibleAgent).not.toHaveBeenCalled()
  })
  it('discards the policy draft on disclosure close and renders only a completed native read after reopening', async () => {
    const stored = { source: 'official' as const, enabled: true, manifestUrl: 'https://official.test/catalog.json', trustedPublicKey: 'compiled-root', allowedHosts: ['official.test'] }
    vi.mocked(compatibleAgentPolicy).mockResolvedValueOnce(stored)
    render(<I18nProvider><CompatibleAgentTools host={host} integrationId="source" /></I18nProvider>)
    const details = screen.getByTestId('compatible-agent-tools') as HTMLDetailsElement
    const toggle = async (open: boolean) => { await act(async () => { details.open = open; fireEvent(details, new Event('toggle')) }) }
    await toggle(true)
    fireEvent.click(screen.getByText(c.policy)); fireEvent.click(screen.getByRole('button', { name: c.loadPolicy }))
    const source = await screen.findByRole('combobox', { name: c.source })
    fireEvent.change(source, { target: { value: 'custom' } })
    expect(source).toHaveValue('custom')
    await toggle(false); expect(screen.queryByTestId('compatible-agent-panel')).not.toBeInTheDocument()
    await toggle(true); fireEvent.click(screen.getByText(c.policy))
    expect(screen.queryByRole('combobox', { name: c.source })).not.toBeInTheDocument()
    let complete!: (value: typeof stored) => void
    vi.mocked(compatibleAgentPolicy).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    fireEvent.click(screen.getByRole('button', { name: c.loadPolicy }))
    expect(screen.queryByRole('combobox', { name: c.source })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: c.loadPolicy })).toBeDisabled()
    await act(async () => { complete(stored) })
    expect(screen.getByRole('combobox', { name: c.source })).toHaveValue('official')
    expect(screen.getByRole('button', { name: c.loadPolicy })).toBeEnabled()
    expect(compatibleAgentPolicy).toHaveBeenCalledTimes(2)
    expect(vi.mocked(compatibleAgentPolicy).mock.calls).toEqual([[], []])
  })
  it('previews adoption of an explicit service and stops after rejected confirmation', async () => {
    vi.mocked(prepareCompatibleAgent).mockResolvedValue({ ...preview, action: 'adopt', legacyUnit: 'existing.service', currentVersion: '1.5.10' })
    vi.mocked(requestUserDecision).mockResolvedValue({ accepted: false, reason: 'rejected' })
    panel(); await act(async () => {}); fireEvent.click(screen.getByText(c.handoff))
    fireEvent.change(screen.getByLabelText(c.legacyUnit), { target: { value: 'existing.service' } })
    fireEvent.click(screen.getByRole('button', { name: c.adopt }))
    await waitFor(() => expect(cancelCompatibleAgent).toHaveBeenCalledWith('plan'))
    expect(prepareCompatibleAgent).toHaveBeenCalledExactlyOnceWith({ vaultId: 'vault', hostId: 'host', integrationId: 'source', action: 'adopt', legacyUnit: 'existing.service' })
    expect(requestUserDecision).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('existing.service') }))
    expect(requestUserDecision).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(c.handoffConfirm) }))
    expect(operateCompatibleAgent).not.toHaveBeenCalled()
  })
  it('migrates only through its explicit action and displays both addresses before applying', async () => {
    vi.mocked(readCompatibleAgent).mockResolvedValue(row())
    vi.mocked(prepareCompatibleAgent).mockResolvedValue({ ...preview, action: 'migrate', endpoint: 'https://new.test', previousEndpoint: 'https://monitor.test' })
    panel(); await screen.findByText('durable-job'); fireEvent.click(screen.getByText(c.handoff))
    fireEvent.change(screen.getByLabelText(c.migrationEndpoint), { target: { value: 'https://new.test' } })
    expect(operateCompatibleAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: c.migrate }))
    await waitFor(() => expect(operateCompatibleAgent).toHaveBeenCalledExactlyOnceWith('plan', true))
    expect(prepareCompatibleAgent).toHaveBeenCalledWith(expect.objectContaining({ action: 'migrate', endpoint: 'https://new.test' }))
    expect(requestUserDecision).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('https://monitor.test → https://new.test') }))
  })
  it('retains explicit configuration and original-service recovery for uncertain handoffs', async () => {
    vi.mocked(readCompatibleAgent).mockResolvedValue({ ...row('unknown'), previousConfiguration: { sha256: 'a'.repeat(64), endpoint: 'https://previous.test' }, observation: { status: 'activating', active: false, legacy: { unit: 'old.service', version: '1.5.10', endpoint: 'https://monitor.test' } } })
    panel(); await screen.findByText('durable-job'); fireEvent.click(screen.getByText(c.handoff))
    expect(screen.getByRole('button', { name: c.migrate })).toBeDisabled()
    expect(screen.getByRole('button', { name: c['restore-config'] })).toBeEnabled()
    expect(screen.getByRole('button', { name: c['restore-legacy'] })).toBeEnabled()
    expect(operateCompatibleAgent).not.toHaveBeenCalled()
  })
  it('never dispatches adoption after a Vault change while confirmation is open', async () => {
    let reply!: (answer: Awaited<ReturnType<typeof requestUserDecision>>) => void
    vi.mocked(requestUserDecision).mockImplementation(() => new Promise(done => { reply = done }))
    panel(); await act(async () => {}); fireEvent.click(screen.getByText(c.handoff)); fireEvent.click(screen.getByRole('button', { name: c.adopt }))
    await waitFor(() => expect(reply).toBeTypeOf('function')); vault.state.generation++
    await act(async () => { reply({ accepted: true, reason: 'accepted' }) })
    expect(operateCompatibleAgent).not.toHaveBeenCalled(); expect(cancelCompatibleAgent).toHaveBeenCalledWith('plan')
  })
})

it('refreshes an already open destination only for the matching Vault and host', async () => {
  panel(); await act(async () => {}); expect(screen.getByRole('button', { name: c.install })).toBeEnabled()
  vi.mocked(readCompatibleAgent).mockResolvedValue(row())
  await act(async () => { window.dispatchEvent(new CustomEvent('shellbeam:probe-deployment-changed', { detail: { vaultId: 'other', hostIds: ['host'] } })) })
  expect(screen.queryByText('durable-job')).not.toBeInTheDocument()
  await act(async () => { window.dispatchEvent(new CustomEvent('shellbeam:probe-deployment-changed', { detail: { vaultId: 'vault', hostIds: ['host'] } })) })
  expect(await screen.findByText('durable-job')).toBeInTheDocument(); expect(screen.getByRole('button', { name: c.install })).toBeDisabled(); expect(screen.getByRole('button', { name: c.upgrade })).toBeEnabled()
})
