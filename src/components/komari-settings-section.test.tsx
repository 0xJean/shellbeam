import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KomariSettingsSection } from './komari-settings-section'
import { deleteKomariIntegration, listKomariIntegrations, upsertKomariIntegration, type KomariIntegration } from '@/lib/komari-config'
import { closeBrowserWindow, loadBrowserSource, openBrowserWindow } from '@/lib/browser'
import { I18nProvider } from '@/lib/i18n'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'

const vault = vi.hoisted(() => ({ id: 'vault-a', unlocked: false, saveSecret: vi.fn() }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: vault.id, vaultStatusState: { unlocked: vault.unlocked }, handleSaveSecret: vault.saveSecret }) }))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn(), upsertKomariIntegration: vi.fn(), deleteKomariIntegration: vi.fn(), komariCredentialKey: (id: string) => `komari.${id}.api-key` }))
vi.mock('@/lib/browser', () => ({ openBrowserWindow: vi.fn(), loadBrowserSource: vi.fn(), closeBrowserWindow: vi.fn() }))

const integration = (patch: Partial<KomariIntegration> = {}): KomariIntegration => ({ id: 'same-id', vaultId: 'vault-a', name: 'Saved Komari', endpoint: 'http://192.168.1.10:25774/komari', credentialRef: 'komari.same-id.api-key', enabled: false, createdAt: 1, updatedAt: 1, ...patch })
const section = () => <I18nProvider><KomariSettingsSection /></I18nProvider>
beforeEach(() => {
  vault.id = 'vault-a'
  vault.unlocked = false
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(listKomariIntegrations).mockResolvedValue([integration()])
  vi.mocked(openBrowserWindow).mockResolvedValue(undefined)
  vi.mocked(loadBrowserSource).mockResolvedValue(undefined)
  vi.mocked(closeBrowserWindow).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

describe('saved Komari console entry', () => {
  it.each(['en', 'zh-CN'] as const)('opens only the saved base URL without API credentials or draft input (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const copy = locale === 'en' ? en : zhCN
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ endpoint: 'http://192.168.1.10:25774/komari?token=legacy-secret#private-state' })])
    render(section())
    const button = screen.getByRole('button', { name: copy['settings.komariConsoleOpen'] })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.change(screen.getByLabelText(copy['settings.komariEndpoint']), { target: { value: 'https://unsaved.example/elsewhere' } })
    fireEvent.change(screen.getByLabelText(copy['settings.komariApiKey']), { target: { value: 'never-forward-api-token' } })
    fireEvent.click(button)
    await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledTimes(1))
    const { browserId, sessionId } = vi.mocked(openBrowserWindow).mock.calls[0][0]
    expect(browserId).toMatch(/^komari-console-/)
    expect(sessionId).toBe(browserId)
    expect(openBrowserWindow).toHaveBeenCalledExactlyOnceWith({ browserId, sessionId })
    expect(loadBrowserSource).toHaveBeenCalledExactlyOnceWith({ browserId, sessionId, source: { kind: 'url', url: 'http://192.168.1.10:25774/komari/' } })
    const sent = JSON.stringify([vi.mocked(openBrowserWindow).mock.calls, vi.mocked(loadBrowserSource).mock.calls])
    expect(sent).not.toMatch(/legacy-secret|private-state|unsaved\.example|never-forward-api-token|credentialRef|proxyUrl/)
    expect(vault.saveSecret).not.toHaveBeenCalled()
    expect(closeBrowserWindow).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'https://user:private-password@komari.example'])('refuses an unsafe saved endpoint without sending it to the browser: %s', async (endpoint) => {
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ endpoint })])
    render(section())
    const button = screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(screen.getByRole('alert')).toHaveTextContent(en['settings.komariConsoleInvalidEndpoint'])
    expect(screen.getByRole('alert')).not.toHaveTextContent(endpoint)
    expect(openBrowserWindow).not.toHaveBeenCalled()
    expect(loadBrowserSource).not.toHaveBeenCalled()
  })

  it('keeps an unsaved integration disabled even when a valid endpoint was typed', async () => {
    render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariNew'] }))
    fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: 'https://unsaved.example' } })
    expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeDisabled()
    expect(openBrowserWindow).not.toHaveBeenCalled()
  })

  it('closes its new empty window on load failure and shows only a fixed safe error', async () => {
    vi.mocked(loadBrowserSource).mockRejectedValueOnce(new Error('https://user:password@internal.example?token=do-not-show'))
    render(section())
    const button = screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(en['settings.komariConsoleOpenFailed']))
    const { browserId, sessionId } = vi.mocked(openBrowserWindow).mock.calls[0][0]
    expect(closeBrowserWindow).toHaveBeenCalledExactlyOnceWith(browserId, sessionId)
    expect(screen.getByRole('alert')).not.toHaveTextContent(/password|internal\.example|do-not-show/)
    expect(button).toBeEnabled()
  })

  it('ignores a late list from the old Vault, including a reused integration id', async () => {
    let finishOld!: (value: KomariIntegration[]) => void
    vi.mocked(listKomariIntegrations).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce([integration({ vaultId: 'vault-b', name: 'Current Vault Komari', endpoint: 'https://current.example/base' })])
    const view = render(section())
    vault.id = 'vault-b'
    view.rerender(section())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Current Vault Komari' })).toBeInTheDocument())
    await act(async () => { finishOld([integration({ name: 'Stale Vault Komari', endpoint: 'https://stale.example' })]) })
    expect(screen.queryByRole('button', { name: 'Stale Vault Komari' })).not.toBeInTheDocument()
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue('https://current.example/base')
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'url', url: 'https://current.example/base/' } })))
  })

  it('closes a late old-Vault window without navigating it or blocking the new Vault', async () => {
    let finishOpen!: () => void
    vi.mocked(openBrowserWindow).mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve }))
    const view = render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(openBrowserWindow).toHaveBeenCalledTimes(1))
    const old = vi.mocked(openBrowserWindow).mock.calls[0][0]
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b', endpoint: 'https://current.example/base' })])
    vault.id = 'vault-b'
    view.rerender(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    await act(async () => { finishOpen() })
    expect(closeBrowserWindow).toHaveBeenCalledWith(old.browserId, old.sessionId)
    expect(loadBrowserSource).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled()
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
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
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
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
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
    expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled()
  })
})
