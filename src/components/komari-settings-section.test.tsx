import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KomariSettingsSection } from './komari-settings-section'
import { deleteKomariIntegration, listKomariIntegrations, upsertKomariIntegration, type KomariIntegration } from '@/lib/komari-config'
import { KomariApiError, listKomariClients, verifyKomariConnection, type KomariClient } from '@/lib/komari'
import { listHosts } from '@/lib/hosts'
import { vaultStatus } from '@/lib/vault'
import { editKomariMapping, getKomariMappingState } from '@/lib/komari-persistence'
import { I18nProvider } from '@/lib/i18n'
import { komariOnboardingCopy } from '@/lib/locales/komari-onboarding'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import { invoke, isTauri } from '@tauri-apps/api/core'

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
vi.mock('@/lib/vault', () => ({ vaultStatus: vi.fn() }))
vi.mock('@/lib/hosts', () => ({ listHosts: vi.fn() }))
vi.mock('@/lib/komari-persistence', async (original) => ({ ...await original<typeof import('@/lib/komari-persistence')>(), getKomariMappingState: vi.fn(), editKomariMapping: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }))
const copy = komariOnboardingCopy.en
const integration = (patch: Partial<KomariIntegration> = {}): KomariIntegration => ({ id: 'same-id', vaultId: 'vault-a', name: 'Saved Komari', endpoint: 'http://192.168.1.10:25774/komari', credentialRef: 'custom.saved.key', enabled: false, createdAt: 1, updatedAt: 1, ...patch })
const node: KomariClient = { uuid: 'node-1', name: 'Node One', hostname: null, ipv4: null, ipv6: null, os: null, kernel: null, version: null, raw: {} }
const section = () => <I18nProvider><KomariSettingsSection /></I18nProvider>
const requestId = '11111111-1111-4111-8111-111111111111'
async function advanced(locale: 'en' | 'zh-CN' = 'en') {
  fireEvent.click(screen.getByText(komariOnboardingCopy[locale].advanced))
  const button = screen.getByRole('button', { name: komariOnboardingCopy[locale].open })
  await waitFor(() => expect(button).toBeEnabled())
  return button
}
beforeEach(() => {
  vault.id = 'vault-a'; vault.unlocked = true
  vi.mocked(vaultStatus).mockResolvedValue({ initialized: true, unlocked: true, secretCount: 1 })
  vault.revealSecret.mockResolvedValue('synthetic-stored-key')
  vi.mocked(isTauri).mockReturnValue(false)
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(listKomariIntegrations).mockResolvedValue([integration()])
  vi.mocked(verifyKomariConnection).mockResolvedValue([node])
  vi.mocked(listKomariClients).mockResolvedValue([node])
  vi.mocked(listHosts).mockResolvedValue([])
  vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 0, mappings: [] })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

describe('native Komari connection flow', () => {
  it.each(['en', 'zh-CN'] as const)('verifies the saved custom credential, discovers nodes, and completes without opening a console (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const text = komariOnboardingCopy[locale]
    render(section())
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
    render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: 'draft-key' } })
    fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: 'https://draft.example' } })
    expect(screen.getByRole('button', { name: copy.verify })).toBeDisabled()
    expect(screen.getByText(copy.saveFirst)).toBeVisible()
    expect(verifyKomariConnection).not.toHaveBeenCalled()
  })

  it.each(['permission', 'unavailable', 'timeout', 'server-error'])('shows a safe %s verification result and preserves settings', async (code) => {
    vi.mocked(verifyKomariConnection).mockRejectedValue(new KomariApiError('private token upstream response', { code }))
    render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: copy.verify })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.verify }))
    expect(await screen.findByRole('alert')).toHaveTextContent(copy[code === 'server-error' ? 'failed' : code as 'permission' | 'unavailable' | 'timeout'])
    expect(screen.getByRole('alert')).not.toHaveTextContent('private token')
    expect(deleteKomariIntegration).not.toHaveBeenCalled()
    expect(upsertKomariIntegration).not.toHaveBeenCalled()
  })

  it('handles an empty successful server as waiting for nodes instead of an error', async () => {
    vi.mocked(verifyKomariConnection).mockResolvedValue([])
    render(section())
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
    const view = render(section())
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
    render(section())
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
    render(section())
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
    render(section())
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
    render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: copy.manage })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: copy.manage }))
    expect(await screen.findByTestId('komari-mapping-retained-node')).toBeVisible()
    expect(screen.queryByRole('button', { name: copy.finish })).not.toBeInTheDocument()
    expect(editKomariMapping).not.toHaveBeenCalled()
  })
})

describe('advanced administration in the main window', () => {
  it.each(['en', 'zh-CN'] as const)('opens the saved base URL in one stable scoped panel without forwarding credentials (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const text = locale === 'en' ? en : zhCN
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration({ endpoint: 'https://saved.example/base?token=old#private' })])
    render(section())
    const button = await advanced(locale)
    fireEvent.change(screen.getByLabelText(text['settings.komariApiKey']), { target: { value: 'draft-private-key' } })
    fireEvent.change(screen.getByLabelText(text['settings.komariEndpoint']), { target: { value: 'https://draft.example' } })
    fireEvent.click(button)
    expect(await screen.findByRole('dialog')).toBeVisible()
    const props = browser.render.mock.lastCall?.[0]
    expect(props).toMatchObject({ browserId: expect.stringMatching(/^komari-console-/), source: { kind: 'url', url: 'https://saved.example/base/' } })
    expect(JSON.stringify(props)).not.toMatch(/draft|private|token|credentialRef/)
    fireEvent.click(screen.getByRole('button', { name: komariOnboardingCopy[locale].close }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(button)
    await screen.findByRole('dialog')
    expect(browser.render.mock.lastCall?.[0].browserId).toBe(props.browserId)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not borrow Vault A unlocked status while Vault B native status is still pending', async () => {
    const view = render(section())
    await screen.findByRole('button', { name: 'Saved Komari' })
    vault.id = 'vault-b' // Keep the stale, unlocked context value from A.
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration({ vaultId: 'vault-b' })])
    let finishStatus!: (status: Awaited<ReturnType<typeof vaultStatus>>) => void
    vi.mocked(vaultStatus).mockImplementationOnce(() => new Promise((resolve) => { finishStatus = resolve }))
    view.rerender(section()); fireEvent.click(await advanced())
    await waitFor(() => expect(vaultStatus).toHaveBeenCalledExactlyOnceWith('vault-b'))
    expect(browser.render).not.toHaveBeenCalled()
    await act(async () => { finishStatus({ initialized: true, unlocked: false, secretCount: 1 }) })
    expect(screen.getByRole('alert')).toHaveTextContent(en['settings.komariConsoleUnlock'])
    expect(browser.render).not.toHaveBeenCalled()
    expect(vault.revealSecret).not.toHaveBeenCalled()
  })

  it.each(['vault', 'configuration'] as const)('ignores a late unlocked native console status after %s changes', async (change) => {
    let finishStatus!: (status: Awaited<ReturnType<typeof vaultStatus>>) => void
    vi.mocked(vaultStatus).mockImplementationOnce(() => new Promise((resolve) => { finishStatus = resolve }))
    const view = render(section()); fireEvent.click(await advanced())
    await waitFor(() => expect(vaultStatus).toHaveBeenCalledExactlyOnceWith('vault-a'))
    if (change === 'vault') {
      vault.id = 'vault-b'
      vi.mocked(listKomariIntegrations).mockResolvedValue([integration({ vaultId: 'vault-b' })])
      view.rerender(section())
    } else {
      vi.mocked(listKomariIntegrations).mockResolvedValue([integration({ endpoint: 'https://changed.example', updatedAt: 2 })])
      fireEvent.click(screen.getByRole('button', { name: en['settings.komariRefresh'] }))
      await waitFor(() => expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue('https://changed.example'))
    }
    await act(async () => { finishStatus({ initialized: true, unlocked: true, secretCount: 1 }) })
    expect(browser.render).not.toHaveBeenCalled()
  })

  it.each(['lock', 'vault', 'selection'] as const)('unmounts the administration panel on %s', async (change) => {
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration(), integration({ id: 'other', name: 'Other' })])
    const view = render(section())
    fireEvent.click(await advanced())
    await screen.findByRole('dialog')
    if (change === 'lock') { vault.unlocked = false; view.rerender(section()) }
    if (change === 'vault') { vault.id = 'vault-b'; view.rerender(section()) }
    if (change === 'selection') fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each(['javascript:alert(1)', 'https://user:private-password@komari.example'])('rejects an unsafe saved endpoint: %s', async (endpoint) => {
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration({ endpoint })])
    render(section()); fireEvent.click(await advanced())
    expect(screen.getByRole('alert')).toHaveTextContent(en['settings.komariConsoleInvalidEndpoint'])
    expect(browser.render).not.toHaveBeenCalled()
  })

  it('ignores an old embedded load failure after reopening another administration scope', async () => {
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration(), integration({ id: 'other', name: 'Other' })])
    render(section()); fireEvent.click(await advanced())
    await screen.findByRole('dialog')
    const oldError = browser.render.mock.lastCall?.[0].onError as (message: string) => void
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    fireEvent.click(screen.getByRole('button', { name: copy.open }))
    await screen.findByRole('dialog')
    act(() => oldError('sensitive upstream error'))
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', `${copy.advanced}: Other`)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps mobile administration on a saved-scope native browser handoff', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce('mobile').mockResolvedValueOnce(requestId).mockResolvedValue(undefined)
    render(section()); fireEvent.click(await advanced())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('cancel_mobile_komari_console', { requestId }))
    expect(invoke).toHaveBeenNthCalledWith(2, 'prepare_mobile_komari_console', { vaultId: 'vault-a', integrationId: 'same-id' })
    expect(invoke).toHaveBeenNthCalledWith(3, 'open_mobile_komari_console', { requestId })
    expect(browser.render).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toMatch(/http|credentialRef|synthetic/)
  })

  it.each(['lock', 'vault', 'selection', 'unmount'] as const)('cancels a late mobile prepare after %s without opening the token', async (change) => {
    let finish!: (token: string) => void
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce('mobile').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValue(undefined)
    vi.mocked(listKomariIntegrations).mockResolvedValue([integration(), integration({ id: 'other', name: 'Other' })])
    const view = render(section()); fireEvent.click(await advanced())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('prepare_mobile_komari_console', { vaultId: 'vault-a', integrationId: 'same-id' }))
    if (change === 'lock') { vault.unlocked = false; view.rerender(section()) }
    if (change === 'vault') { vault.id = 'vault-b'; view.rerender(section()) }
    if (change === 'selection') fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    if (change === 'unmount') view.unmount()
    await act(async () => { finish(requestId) })
    expect(invoke).toHaveBeenCalledWith('cancel_mobile_komari_console', { requestId })
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'open_mobile_komari_console')).toBe(false)
    if (change === 'lock') {
      vault.unlocked = true; view.rerender(section())
      expect(screen.getByRole('button', { name: copy.open })).toBeEnabled()
    }
  })
  it.each(['metadata', 'secret'] as const)('does not continue old-Vault writes after switching while %s persistence is pending', async (stage) => {
    vault.unlocked = true
    let finishMetadata!: (value: KomariIntegration) => void
    let finishSecret!: () => void
    const saved = integration({ credentialRef: '' })
    if (stage === 'metadata') vi.mocked(upsertKomariIntegration).mockImplementationOnce(() => new Promise((resolve) => { finishMetadata = resolve }))
    else vi.mocked(upsertKomariIntegration).mockResolvedValueOnce(saved)
    vault.saveSecret.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSecret = resolve }))
    const view = render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: copy.open, hidden: true })).toBeEnabled())
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: 'old-vault-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => expect(stage === 'metadata' ? upsertKomariIntegration : vault.saveSecret).toHaveBeenCalledTimes(1))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b', name: 'Current Vault Komari', endpoint: 'https://current.example/base' })])
    vault.id = 'vault-b'
    view.rerender(section())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Current Vault Komari' })).toBeInTheDocument())
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
    render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: copy.open, hidden: true })).toBeEnabled())
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
    const view = render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariRemove'] })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariRemove'] }))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b', name: 'Current Vault Komari', endpoint: 'https://current.example/base' })])
    vault.id = 'vault-b'
    view.rerender(section())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Current Vault Komari' })).toBeInTheDocument())
    await act(async () => { finishRemove() })
    expect(deleteKomariIntegration).toHaveBeenCalledExactlyOnceWith('same-id', 'vault-a')
    expect(listKomariIntegrations).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue('https://current.example/base')
    expect(screen.getByRole('button', { name: copy.open, hidden: true })).toBeEnabled()
  })
})
