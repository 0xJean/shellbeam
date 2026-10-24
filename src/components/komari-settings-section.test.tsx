import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KomariSettingsSection } from './komari-settings-section'
import { deleteKomariIntegration, listKomariIntegrations, upsertKomariIntegration, type KomariIntegration } from '@/lib/komari-config'
import { KomariApiError, listKomariClients, verifyKomariConnection, type KomariClient } from '@/lib/komari'
import { listHosts } from '@/lib/hosts'
import { editKomariMapping, getKomariMappingState } from '@/lib/komari-persistence'
import { I18nProvider } from '@/lib/i18n'
import { komariOnboardingCopy } from '@/lib/locales/komari-onboarding'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import { invoke } from '@tauri-apps/api/core'
import { monitoringServiceCopy } from '@/lib/locales/monitoring-service'

const vault = vi.hoisted(() => {
  let scope = { id: 'vault-a' }
  return { get id() { return scope.id }, set id(id: string) { if (scope.id !== id) scope = { id } }, unlocked: true,
    saveSecret: vi.fn(), revealSecret: vi.fn(), captureScope: (expectedId: string) => { const captured = scope; return () => captured.id === expectedId && captured === scope } }
})
const browser = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('@/components/browser/embedded-browser-webview', () => ({ EmbeddedBrowserWebview: (props: unknown) => { browser.render(props); return <div data-testid="embedded-webview" /> } }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => { const id = vault.id; return { activeVaultId: id, vaultStatusState: { unlocked: vault.unlocked }, handleSaveSecret: vault.saveSecret, handleRevealSecret: vault.revealSecret, captureVaultScope: () => vault.captureScope(id) } } }))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn(), upsertKomariIntegration: vi.fn(), deleteKomariIntegration: vi.fn(), komariCredentialKey: (id: string) => `komari.${id}.api-key` }))
vi.mock('@/lib/komari', async (original) => ({ ...await original<typeof import('@/lib/komari')>(), listKomariClients: vi.fn(), verifyKomariConnection: vi.fn() }))
vi.mock('./monitoring-service-panel', () => ({ MonitoringServicePanel: () => <div data-testid="native-service" /> }))
vi.mock('@/lib/hosts', async original => ({ ...(await original<typeof import('@/lib/hosts')>()), listHosts: vi.fn() }))
vi.mock('@/lib/komari-persistence', async (original) => ({ ...await original<typeof import('@/lib/komari-persistence')>(), getKomariMappingState: vi.fn(), editKomariMapping: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }))
const copy = komariOnboardingCopy.en
const integration = (patch: Partial<KomariIntegration> = {}): KomariIntegration => ({ id: 'same-id', vaultId: 'vault-a', name: 'Saved Komari', endpoint: 'http://192.168.1.10:25774/komari', credentialRef: 'custom.saved.key', enabled: false, createdAt: 1, updatedAt: 1, ...patch })
const node: KomariClient = { uuid: 'node-1', name: 'Node One', hostname: null, ipv4: null, ipv6: null, os: null, kernel: null, version: null, raw: {} }
const section = () => <I18nProvider><KomariSettingsSection /></I18nProvider>
async function renderEditor() {
  const view = render(section())
  fireEvent.click(await screen.findByRole('button', { name: 'Saved Komari' }))
  return view
}
beforeEach(() => {
  vault.id = 'vault-a'; vault.unlocked = true
  vault.revealSecret.mockResolvedValue('synthetic-stored-key')
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(listKomariIntegrations).mockResolvedValue([integration()])
  vi.mocked(verifyKomariConnection).mockResolvedValue([node])
  vi.mocked(listKomariClients).mockResolvedValue([node])
  vi.mocked(listHosts).mockResolvedValue([])
  vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 0, mappings: [] })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

describe('optional Komari data sources', () => {
  it.each(['en', 'zh-CN'] as const)('waits for an explicit add action before exposing an unconfigured connection form (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    vi.mocked(listKomariIntegrations).mockResolvedValue([])
    const text = locale === 'en' ? en : zhCN
    const navigation = settingsNavigationCopy[locale]
    render(section())
    await act(async () => {})
    expect(screen.getByText(navigation.optionalKomari)).toBeVisible()
    expect(screen.queryByLabelText(text['settings.komariApiKey'])).not.toBeInTheDocument()
    expect(screen.queryByText(komariOnboardingCopy[locale].advanced)).not.toBeInTheDocument()
    expect(verifyKomariConnection).not.toHaveBeenCalled()
    expect(vault.revealSecret).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: navigation.addSource }))
    fireEvent.change(screen.getByLabelText(monitoringServiceCopy[locale].access), { target: { value: 'key' } })
    expect(screen.getByLabelText(text['settings.komariApiKey'])).toHaveValue('')
    fireEvent.change(screen.getByLabelText(text['settings.komariApiKey']), { target: { value: 'unsaved-draft' } })
    fireEvent.click(screen.getByRole('button', { name: navigation.closeEditor }))
    expect(screen.queryByLabelText(text['settings.komariApiKey'])).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: navigation.addSource }))
    fireEvent.change(screen.getByLabelText(monitoringServiceCopy[locale].access), { target: { value: 'key' } })
    expect(screen.getByLabelText(text['settings.komariApiKey'])).toHaveValue('')
    expect(upsertKomariIntegration).not.toHaveBeenCalled()
    expect(vault.saveSecret).not.toHaveBeenCalled()
  })

  it('shows saved sources without opening or reading credentials until selected', async () => {
    render(section())
    const saved = await screen.findByRole('button', { name: 'Saved Komari' })
    expect(screen.getByText(settingsNavigationCopy.en.paused)).toBeVisible()
    expect(screen.queryByTestId('komari-connection-editor')).not.toBeInTheDocument()
    expect(vault.revealSecret).not.toHaveBeenCalled()
    fireEvent.click(saved)
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue(integration().endpoint)
    expect(screen.getByLabelText(en['settings.komariApiKey'])).toHaveValue('')
    expect(screen.getByLabelText(en['settings.komariApiKey'])).toHaveAttribute('placeholder', en['settings.komariApiKeyKeep'])
    expect(vault.revealSecret).not.toHaveBeenCalled()
  })

  it('closes the editor and drops every draft when the Vault locks', async () => {
    const view = await renderEditor()
    fireEvent.change(screen.getByLabelText(en['settings.komariName']), { target: { value: 'Draft source' } })
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: 'draft-secret' } })
    vault.unlocked = false; view.rerender(section())
    expect(screen.queryByTestId('komari-connection-editor')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: settingsNavigationCopy.en.addSource })).toBeDisabled()
    vault.unlocked = true; view.rerender(section())
    expect(screen.queryByTestId('komari-connection-editor')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Saved Komari' }))
    expect(screen.getByLabelText(en['settings.komariName'])).toHaveValue(integration().name)
    expect(screen.getByLabelText(en['settings.komariApiKey'])).toHaveValue('')
    expect(vault.saveSecret).not.toHaveBeenCalled()
  })

  it('does not persist a pending draft credential after locking and unlocking the same Vault', async () => {
    let finish!: (saved: KomariIntegration) => void
    vi.mocked(upsertKomariIntegration).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = await renderEditor()
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: 'draft-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => expect(upsertKomariIntegration).toHaveBeenCalledOnce())
    vault.unlocked = false; view.rerender(section())
    vault.unlocked = true; view.rerender(section())
    await act(async () => { finish(integration()) })
    expect(vault.saveSecret).not.toHaveBeenCalled()
    expect(screen.queryByTestId('komari-connection-editor')).not.toBeInTheDocument()
    expect(screen.queryByText(en['settings.komariSaved'])).not.toBeInTheDocument()
  })
})

describe('new destination product admission', () => {
  it.each(['en', 'zh-CN'] as const)('preserves the draft and never writes credentials when server identity is rejected (%s)', async locale => {
    localStorage.setItem('shellbeam.locale', locale)
    const text = locale === 'en' ? en : zhCN
    await renderEditor()
    vi.mocked(upsertKomariIntegration).mockRejectedValueOnce(new Error('MONITORING_SHELLBEAM_REQUIRED'))
    fireEvent.change(screen.getByLabelText(text['settings.komariEndpoint']), { target: { value: 'https://upstream.example' } })
    fireEvent.change(screen.getByLabelText(text['settings.komariApiKey']), { target: { value: 'unsaved-key' } })
    fireEvent.click(screen.getByRole('button', { name: text['settings.komariSave'] }))
    expect(await screen.findByText(monitoringServiceCopy[locale].ownServer)).toBeVisible()
    expect(vault.saveSecret).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(screen.getByLabelText(text['settings.komariApiKey'])).toHaveValue('unsaved-key')
    expect(screen.queryByText(text['settings.komariSaved'])).not.toBeInTheDocument()
  })
})

describe('native Komari connection flow', () => {
  it.each(['en', 'zh-CN'] as const)('verifies the saved custom credential, discovers nodes, and completes without opening a console (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const text = komariOnboardingCopy[locale]
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: text.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: text.verify }))
    expect(await screen.findByText(`${text.verified} · ${text.nodes}: 1`)).toBeVisible()
    expect(vault.revealSecret).toHaveBeenCalledExactlyOnceWith('custom.saved.key')
    expect(verifyKomariConnection).toHaveBeenCalledExactlyOnceWith({ endpoint: integration().endpoint, token: 'synthetic-stored-key' })
    expect(getKomariMappingState).toHaveBeenCalledWith('vault-a', 'same-id')
    expect(await screen.findByTestId('komari-mapping-node-1')).toHaveTextContent('Node One')
    await waitFor(() => expect(screen.getByRole('button', { name: text.finish })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: text.finish }))
    expect(screen.getByRole('status')).toHaveTextContent(text.ready)
    expect(screen.getByText(text.disabled)).toBeVisible()
    expect(vault.saveSecret).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(browser.render).not.toHaveBeenCalled()
    expect(screen.queryByDisplayValue('synthetic-stored-key')).not.toBeInTheDocument()
  })

  it('saves a first connection without a key, but distinguishes saved settings from verified API access', async () => {
    let stored: KomariIntegration | null = null
    vi.mocked(listKomariIntegrations).mockImplementation(async () => stored ? [stored] : [])
    vi.mocked(upsertKomariIntegration).mockImplementation(async (input) => { stored = integration({ id: input.id, name: input.name, endpoint: input.endpoint, enabled: true }); return stored })
    vault.revealSecret.mockResolvedValue(null)
    render(section())
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: settingsNavigationCopy.en.addSource }))
    fireEvent.change(screen.getByLabelText(monitoringServiceCopy.en.access), { target: { value: 'key' } })
    await waitFor(() => expect(listKomariIntegrations).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText(en['settings.komariName']), { target: { value: 'New source' } })
    fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: 'http://localhost:25749' } })
    expect(screen.getByRole('button', { name: copy.verify })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    expect(await screen.findByRole('status')).toHaveTextContent(en['settings.komariSaved'])
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.missingKey)
    expect(verifyKomariConnection).not.toHaveBeenCalled()
    expect(vault.saveSecret).not.toHaveBeenCalled()
    expect(screen.queryByText(copy.ready)).not.toBeInTheDocument()
  })

  it('requires saving edited fields before verification and never sends a draft key or endpoint', async () => {
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: 'draft-key' } })
    fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: 'https://draft.example' } })
    expect(screen.getByRole('button', { name: copy.verify })).toBeDisabled()
    expect(screen.getByText(copy.saveFirst)).toBeVisible()
    expect(verifyKomariConnection).not.toHaveBeenCalled()
  })

  it.each(['permission', 'unavailable', 'timeout', 'server-error'])('shows a safe %s verification result and preserves settings', async (code) => {
    vi.mocked(verifyKomariConnection).mockRejectedValue(new KomariApiError('private token upstream response', { code }))
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    expect(await screen.findByRole('alert')).toHaveTextContent(copy[code === 'server-error' ? 'failed' : code as 'permission' | 'unavailable' | 'timeout'])
    expect(screen.getByRole('alert')).not.toHaveTextContent('private token')
    expect(deleteKomariIntegration).not.toHaveBeenCalled()
    expect(upsertKomariIntegration).not.toHaveBeenCalled()
  })

  it('handles an empty successful server as waiting for nodes instead of an error', async () => {
    vi.mocked(verifyKomariConnection).mockResolvedValue([])
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    expect(await screen.findByText(copy.empty)).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.finish })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.finish }))
    expect(screen.getByRole('status')).toHaveTextContent(copy.ready)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['vault', 'lock', 'edit', 'selection', 'unmount'] as const)('discards late discovery after %s', async (change) => {
    let finish!: (nodes: KomariClient[]) => void
    vi.mocked(verifyKomariConnection).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration(), integration({ id: 'other', name: 'Other' })])
    const view = await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    await waitFor(() => expect(verifyKomariConnection).toHaveBeenCalledTimes(1))
    if (change === 'vault') { vault.id = 'vault-b'; view.rerender(section()) }
    if (change === 'lock') { vault.unlocked = false; view.rerender(section()) }
    if (change === 'edit') fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: 'https://changed.example' } })
    if (change === 'selection') fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    if (change === 'unmount') view.unmount()
    await act(async () => { finish([node]) })
    expect(screen.queryByText(/API access verified/)).not.toBeInTheDocument()
    expect(listHosts).not.toHaveBeenCalled()
  })

  it.each(['endpoint', 'credentialRef', 'updatedAt'] as const)('invalidates verification when refreshed same-ID %s changes', async (field) => {
    let finish!: (nodes: KomariClient[]) => void
    vi.mocked(verifyKomariConnection).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    await waitFor(() => expect(verifyKomariConnection).toHaveBeenCalledTimes(1))
    const updated = integration({ [field]: field === 'updatedAt' ? 2 : field === 'endpoint' ? 'https://changed.example' : 'rotated.key' })
    vi.mocked(listKomariIntegrations).mockResolvedValue([updated])
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariRefresh'] }))
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    await act(async () => { finish([node]) })
    expect(screen.queryByText(/API access verified/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('komari-mappings-panel')).not.toBeInTheDocument()
    expect(listHosts).not.toHaveBeenCalled()
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue(updated.endpoint)
    vi.mocked(verifyKomariConnection).mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    await screen.findByRole('button', { name: copy.finish })
    expect(vault.revealSecret).toHaveBeenLastCalledWith(updated.credentialRef)
    expect(verifyKomariConnection).toHaveBeenLastCalledWith({ endpoint: updated.endpoint, token: 'synthetic-stored-key' })
  })

  it('invalidates completed verification on refresh while retaining an edited draft', async () => {
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    await screen.findByTestId('komari-mapping-node-1')
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration({ endpoint: 'https://new.example', updatedAt: 2 })])
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariRefresh'] }))
    await waitFor(() => expect(screen.queryByTestId('komari-mappings-panel')).not.toBeInTheDocument())
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue('https://new.example')
    fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: 'https://draft.example' } })
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration({ endpoint: 'https://newer.example', updatedAt: 3 })])
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariRefresh'] }))
    await waitFor(() => expect(listKomariIntegrations).toHaveBeenCalledTimes(4))
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue('https://draft.example')
    expect(screen.getByRole('button', { name: copy.verify })).toBeDisabled()
  })

  it('waits for a selected binding to be saved before finishing and reports remaining unmapped nodes', async () => {
    vi.mocked(listHosts).mockResolvedValue([{ id: 'host-one', name: 'Existing host', vaultId: 'vault-a', address: '10.0.0.1', username: 'ops', port: 22, authType: 'password', group: '', tags: [], createdAt: 0, updatedAt: 0 }])
    let finishSave!: (value: Awaited<ReturnType<typeof editKomariMapping>>) => void
    vi.mocked(editKomariMapping).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve }))
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    await screen.findByTestId('komari-mapping-node-1')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'host-one' } })
    expect(screen.getByRole('button', { name: copy.finish })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save binding' }))
    expect(screen.getByRole('button', { name: copy.finish })).toBeDisabled()
    await act(async () => { finishSave({ revision: 1, mappings: [{ integrationId: 'same-id', nodeId: 'node-1', hostId: 'host-one', source: 'manual', confidence: 'explicit', updatedAt: 1 }] }) })
    await waitFor(() => expect(screen.getByRole('button', { name: copy.finish })).toBeEnabled())
    expect(editKomariMapping).toHaveBeenCalledExactlyOnceWith({ vaultId: 'vault-a', integrationId: 'same-id', nodeId: 'node-1', hostId: 'host-one', expectedRevision: 0 })
    fireEvent.click(screen.getByRole('button', { name: copy.finish }))
    expect(screen.getByText(`${copy.unmapped}: 0`)).toBeVisible()
  })

  it('allows managing retained bindings for an offline or paused data source', async () => {
    vault.revealSecret.mockResolvedValue(null)
    vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 2, mappings: [{ integrationId: 'same-id', hostId: 'host-one', nodeId: 'retained-node', source: 'manual', confidence: 'explicit', updatedAt: 1 }] })
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: copy.manage })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.manage }))
    expect(await screen.findByTestId('komari-mapping-retained-node')).toBeVisible()
    expect(screen.queryByRole('button', { name: copy.finish })).not.toBeInTheDocument()
    expect(editKomariMapping).not.toHaveBeenCalled()
  })
})

describe('native service ownership and retained credential guards', () => {
  it.each(['en', 'zh-CN'] as const)('has no second console or browser entry (%s)', async locale => {
    localStorage.setItem('shellbeam.locale', locale)
    await renderEditor()
    expect(screen.getByTestId('native-service')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: komariOnboardingCopy[locale].open })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(browser.render).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
  it.each(['metadata', 'secret'] as const)('does not continue old-Vault writes after switching while %s persistence is pending', async (stage) => {
    vault.unlocked = true
    let finishMetadata!: (value: KomariIntegration) => void
    let finishSecret!: () => void
    const saved = integration({ credentialRef: '' })
    if (stage === 'metadata') vi.mocked(upsertKomariIntegration).mockImplementationOnce(() => new Promise((resolve) => { finishMetadata = resolve }))
    else vi.mocked(upsertKomariIntegration).mockResolvedValueOnce(saved)
    vault.saveSecret.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSecret = resolve }))
    const view = await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariSave'] })).toBeEnabled())
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: 'old-vault-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => expect(stage === 'metadata' ? upsertKomariIntegration : vault.saveSecret).toHaveBeenCalledTimes(1))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b', name: 'Current Vault Komari', endpoint: 'https://current.example/base' })])
    vault.id = 'vault-b'
    view.rerender(section())
    expect(screen.queryByTestId('komari-connection-editor')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Current Vault Komari' }))
    await act(async () => { if (stage === 'metadata') finishMetadata(saved); else finishSecret() })
    expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
    expect(vault.saveSecret).toHaveBeenCalledTimes(stage === 'metadata' ? 0 : 1)
    expect(listKomariIntegrations).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText(en['settings.komariApiKey'])).toHaveValue('')
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue('https://current.example/base')
    expect(screen.getByRole('button', { name: en['settings.komariSave'] })).toBeEnabled()
  })

  it('keeps the normal same-Vault metadata, secret and credential-reference save sequence intact', async () => {
    vault.unlocked = true
    vi.mocked(upsertKomariIntegration).mockResolvedValueOnce(integration({ credentialRef: '' })).mockResolvedValueOnce(integration())
    vault.saveSecret.mockResolvedValueOnce(undefined)
    await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariSave'] })).toBeEnabled())
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: 'new-scoped-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => expect(upsertKomariIntegration).toHaveBeenCalledTimes(2))
    expect(vault.saveSecret).toHaveBeenCalledExactlyOnceWith('komari.same-id.api-key', 'new-scoped-secret')
    expect(vi.mocked(upsertKomariIntegration).mock.calls.every(([request]) => request.vaultId === 'vault-a')).toBe(true)
    await waitFor(() => expect(screen.getByLabelText(en['settings.komariApiKey'])).toHaveValue(''))
  })

  it('does not reload or reset the new Vault after an old-Vault removal finishes', async () => {
    let finishRemove!: () => void
    vi.mocked(deleteKomariIntegration).mockImplementationOnce(() => new Promise((resolve) => { finishRemove = resolve }))
    const view = await renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariRemove'] })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariRemove'] }))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b', name: 'Current Vault Komari', endpoint: 'https://current.example/base' })])
    vault.id = 'vault-b'
    view.rerender(section())
    expect(screen.queryByTestId('komari-connection-editor')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Current Vault Komari' }))
    await act(async () => { finishRemove() })
    expect(deleteKomariIntegration).toHaveBeenCalledExactlyOnceWith('same-id', 'vault-a')
    expect(listKomariIntegrations).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue('https://current.example/base')
    expect(screen.getByRole('button', { name: en['settings.komariSave'] })).toBeEnabled()
  })
})

describe('native administrator authorization', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'monitoring_service_context' ? { vaultId: 'vault-a', integrationId: 'same-id', configVersion: 1, session: 2, contextId: 'auth-context', configurationIdentity: 'config' } : command === 'monitoring_service' ? { authorized: true } : undefined)
    vi.mocked(upsertKomariIntegration).mockResolvedValue(integration())
  })
  it.each(['en', 'zh-CN'] as const)('saves and discovers in one login workflow without copying a key (%s)', async locale => {
    localStorage.setItem('shellbeam.locale', locale)
    const text = monitoringServiceCopy[locale]
    await renderEditor()
    fireEvent.change(screen.getByLabelText(text.access), { target: { value: 'authorize' } })
    fireEvent.change(screen.getByLabelText(text.user), { target: { value: 'synthetic-admin' } })
    fireEvent.change(screen.getByLabelText(text.pass), { target: { value: 'Synthetic-only-123' } })
    fireEvent.click(screen.getByRole('button', { name: text.connect }))
    expect(await screen.findByText(`${komariOnboardingCopy[locale].verified} · ${komariOnboardingCopy[locale].nodes}: 1`)).toBeVisible()
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'monitoring_service')).toEqual([['monitoring_service', { input: { scope: { vaultId: 'vault-a', integrationId: 'same-id', configVersion: 1, session: 2, contextId: 'auth-context', configurationIdentity: 'config' }, action: 'authorize', confirmed: false, username: 'synthetic-admin', password: 'Synthetic-only-123', twoFactor: '', metricDsn: './data/metrics.db' } }]])
    expect(vault.saveSecret).not.toHaveBeenCalled()
    expect(browser.render).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('monitoring_service_cancel_context', { contextId: 'auth-context' })
    fireEvent.click(screen.getByRole('button', { name: komariOnboardingCopy[locale].back }))
    expect(screen.getByLabelText(text.pass)).toHaveValue('')
  })
  it.each([true, false])('requires an explicit initialization decision before any save (%s)', async accepted => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(accepted)
    const text = monitoringServiceCopy.en
    await renderEditor()
    fireEvent.change(screen.getByLabelText(text.access), { target: { value: 'initialize' } })
    fireEvent.change(screen.getByLabelText(text.user), { target: { value: 'synthetic-admin' } })
    fireEvent.change(screen.getByLabelText(text.pass), { target: { value: 'Synthetic-only-123' } })
    fireEvent.click(screen.getByRole('button', { name: text.connect }))
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    if (accepted) {
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('monitoring_service', { input: expect.objectContaining({ action: 'initialize', confirmed: true, username: 'synthetic-admin', metricDsn: './data/metrics.db' }) }))
      await screen.findByText(`${copy.verified} · ${copy.nodes}: 1`)
    } else {
      await waitFor(() => expect(screen.getByRole('button', { name: text.connect })).toBeEnabled())
      expect(upsertKomariIntegration).not.toHaveBeenCalled()
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'monitoring_service')).toHaveLength(0)
    }
    confirm.mockRestore()
  })
  it.each(['lock', 'vault', 'unmount'] as const)('revokes authorization before further work after %s', async change => {
    let done!: (value: unknown) => void
    vi.mocked(invoke).mockImplementation(async command => command === 'monitoring_service_context' ? { vaultId: 'vault-a', integrationId: 'same-id', configVersion: 1, session: 2, contextId: 'auth-context', configurationIdentity: 'config' } : command === 'monitoring_service' ? await new Promise(resolve => { done = resolve }) : undefined)
    const view = await renderEditor(); const text = monitoringServiceCopy.en
    fireEvent.change(screen.getByLabelText(text.access), { target: { value: 'authorize' } })
    fireEvent.change(screen.getByLabelText(text.user), { target: { value: 'synthetic-admin' } }); fireEvent.change(screen.getByLabelText(text.pass), { target: { value: 'Synthetic-only-123' } }); fireEvent.click(screen.getByRole('button', { name: text.connect }))
    await waitFor(() => expect(done).toBeTypeOf('function'))
    if (change === 'lock') { vault.unlocked = false; view.rerender(section()) }
    if (change === 'vault') { vault.id = 'vault-b'; view.rerender(section()) }
    if (change === 'unmount') view.unmount()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('monitoring_service_cancel_context', { contextId: 'auth-context' }))
    await act(async () => { done({ authorized: true }) })
    expect(vault.revealSecret).not.toHaveBeenCalled(); expect(verifyKomariConnection).not.toHaveBeenCalled()
  })
})
