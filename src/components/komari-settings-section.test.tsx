import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KomariSettingsSection } from './komari-settings-section'
import { deleteKomariIntegration, listKomariIntegrations, upsertKomariIntegration, type KomariIntegration } from '@/lib/komari-config'
import { closeBrowserWindow, loadBrowserSource, openBrowserWindow } from '@/lib/browser'
import { I18nProvider } from '@/lib/i18n'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import { invoke, isTauri } from '@tauri-apps/api/core'

const vault = vi.hoisted(() => {
  let scope = { id: 'vault-a' }
  return {
    get id() { return scope.id },
    set id(id: string) { if (scope.id !== id) scope = { id } },
    unlocked: false,
    saveSecret: vi.fn(),
    captureScope: (expectedId: string) => {
      const captured = scope
      return () => captured.id === expectedId && captured === scope
    },
  }
})
vi.mock('@/contexts/vault-context', () => ({
  useVault: () => {
    const id = vault.id
    return {
      activeVaultId: id,
      vaultStatusState: { unlocked: vault.unlocked },
      handleSaveSecret: vault.saveSecret,
      captureVaultScope: () => vault.captureScope(id),
    }
  },
}))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn(), upsertKomariIntegration: vi.fn(), deleteKomariIntegration: vi.fn(), komariCredentialKey: (id: string) => `komari.${id}.api-key` }))
vi.mock('@/lib/browser', () => ({ openBrowserWindow: vi.fn(), loadBrowserSource: vi.fn(), closeBrowserWindow: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }))

const integration = (patch: Partial<KomariIntegration> = {}): KomariIntegration => ({ id: 'same-id', vaultId: 'vault-a', name: 'Saved Komari', endpoint: 'http://192.168.1.10:25774/komari', credentialRef: 'komari.same-id.api-key', enabled: false, createdAt: 1, updatedAt: 1, ...patch })
const section = () => <I18nProvider><KomariSettingsSection /></I18nProvider>
const requestId = '11111111-1111-4111-8111-111111111111'
beforeEach(() => {
  vault.id = 'vault-a'
  vault.unlocked = false
  vi.mocked(isTauri).mockReturnValue(false)
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(listKomariIntegrations).mockResolvedValue([integration()])
  vi.mocked(openBrowserWindow).mockResolvedValue(undefined)
  vi.mocked(loadBrowserSource).mockResolvedValue(undefined)
  vi.mocked(closeBrowserWindow).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

describe('saved Komari console entry', () => {
  it.each(['en', 'zh-CN'] as const)('saves a first integration without an API Key and opens its reloaded same-Vault console without API validation (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const copy = locale === 'en' ? en : zhCN
    vault.unlocked = true
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce('desktop')
    const storedEndpoint = 'http://127.0.0.1:25749/komari'
    let stored: KomariIntegration | null = null
    vi.mocked(listKomariIntegrations).mockImplementation(async () => stored ? [
      { ...stored, vaultId: 'vault-b', name: 'Foreign Komari', endpoint: 'https://foreign.example' }, stored,
    ] : [])
    vi.mocked(upsertKomariIntegration).mockImplementationOnce(async (input) => {
      stored = integration({ id: input.id, name: input.name, endpoint: storedEndpoint, credentialRef: `komari.${input.id}.api-key`, enabled: input.enabled })
      return stored
    })
    const fetchRequest = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Console setup must not require an API request'))
    try {
      await act(async () => { render(section()) })
      const consoleButton = screen.getByRole('button', { name: copy['settings.komariConsoleOpen'] })
      expect(consoleButton).toBeDisabled()
      fireEvent.change(screen.getByLabelText(copy['settings.komariName']), { target: { value: 'First Komari' } })
      fireEvent.change(screen.getByLabelText(copy['settings.komariEndpoint']), { target: { value: `${storedEndpoint}/` } })
      expect(screen.getByLabelText(copy['settings.komariApiKey'])).toHaveValue('')
      fireEvent.click(screen.getByRole('button', { name: copy['settings.komariSave'] }))

      await screen.findByRole('button', { name: 'First Komari' })
      await waitFor(() => expect(consoleButton).toBeEnabled())
      expect(upsertKomariIntegration).toHaveBeenCalledExactlyOnceWith({
        id: expect.any(String), vaultId: 'vault-a', name: 'First Komari', endpoint: `${storedEndpoint}/`, enabled: true,
      })
      expect(listKomariIntegrations).toHaveBeenNthCalledWith(2, 'vault-a')
      expect(screen.getByLabelText(copy['settings.komariEndpoint'])).toHaveValue(storedEndpoint)
      expect(screen.queryByRole('button', { name: 'Foreign Komari' })).not.toBeInTheDocument()
      expect(vault.saveSecret).not.toHaveBeenCalled()
      expect(fetchRequest).not.toHaveBeenCalled()
      expect(invoke).not.toHaveBeenCalled()

      fireEvent.change(screen.getByLabelText(copy['settings.komariEndpoint']), { target: { value: 'https://unsaved.example/?token=unsaved-query' } })
      fireEvent.change(screen.getByLabelText(copy['settings.komariApiKey']), { target: { value: 'unsaved-console-key' } })
      fireEvent.click(consoleButton)
      await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledTimes(1))
      const { browserId, sessionId } = vi.mocked(openBrowserWindow).mock.calls[0][0]
      expect(openBrowserWindow).toHaveBeenCalledExactlyOnceWith({ browserId, sessionId })
      expect(loadBrowserSource).toHaveBeenCalledExactlyOnceWith({ browserId, sessionId, source: { kind: 'url', url: `${storedEndpoint}/` } })
      expect(JSON.stringify([vi.mocked(openBrowserWindow).mock.calls, vi.mocked(loadBrowserSource).mock.calls])).not.toMatch(/foreign|unsaved|token|credentialRef/)
      expect(invoke).toHaveBeenCalledExactlyOnceWith('komari_console_mode')
      expect(vault.saveSecret).not.toHaveBeenCalled()
      expect(fetchRequest).not.toHaveBeenCalled()
      expect(closeBrowserWindow).not.toHaveBeenCalled()
    } finally {
      fetchRequest.mockRestore()
    }
  })

  it('retains the desktop window adapter on a native desktop build', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce('desktop')
    render(section())
    const button = screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledExactlyOnceWith('komari_console_mode')
    expect(openBrowserWindow).toHaveBeenCalledTimes(1)
  })

  it.each(['en', 'zh-CN'] as const)('opens a mobile saved integration through native scope only, without credentials or desktop windows (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const copy = locale === 'en' ? en : zhCN
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce('mobile').mockResolvedValueOnce(requestId).mockResolvedValue(undefined)
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ endpoint: 'http://192.168.1.10:25774/komari?token=legacy-secret#private-state' })])
    render(section())
    const button = screen.getByRole('button', { name: copy['settings.komariConsoleOpen'] })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.change(screen.getByLabelText(copy['settings.komariEndpoint']), { target: { value: 'https://unsaved.example' } })
    fireEvent.change(screen.getByLabelText(copy['settings.komariApiKey']), { target: { value: 'never-forward-token' } })
    fireEvent.click(button)
    await waitFor(() => expect(button).toBeEnabled())
    expect(invoke).toHaveBeenNthCalledWith(1, 'komari_console_mode')
    expect(invoke).toHaveBeenNthCalledWith(2, 'prepare_mobile_komari_console', { vaultId: 'vault-a', integrationId: 'same-id' })
    expect(invoke).toHaveBeenNthCalledWith(3, 'open_mobile_komari_console', { requestId })
    expect(invoke).toHaveBeenNthCalledWith(4, 'cancel_mobile_komari_console', { requestId })
    expect(invoke).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toMatch(/legacy-secret|private-state|unsaved|never-forward|http|credentialRef/)
    expect(openBrowserWindow).not.toHaveBeenCalled()
    expect(loadBrowserSource).not.toHaveBeenCalled()
    expect(closeBrowserWindow).not.toHaveBeenCalled()
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['open-failed', 'locked'] as const)('shows the fixed mobile %s error without falling back to a desktop window', async (failure) => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce('mobile')
    if (failure === 'locked') vi.mocked(invoke).mockRejectedValueOnce('VAULT_LOCKED')
    else vi.mocked(invoke).mockResolvedValueOnce(requestId).mockRejectedValueOnce(new Error('secret http://user:password@internal.example')).mockResolvedValue(undefined)
    render(section())
    const button = screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(en[failure === 'locked' ? 'settings.komariConsoleUnlock' : 'settings.komariConsoleOpenFailed']))
    expect(screen.getByRole('alert')).not.toHaveTextContent(/secret|password|internal\.example/)
    expect(openBrowserWindow).not.toHaveBeenCalled()
    expect(loadBrowserSource).not.toHaveBeenCalled()
    expect(closeBrowserWindow).not.toHaveBeenCalled()
    expect(button).toBeEnabled()
  })

  it('does not dispatch an old-Vault mobile open after a late native capability reply', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    let finishMode!: (mode: string) => void
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finishMode = resolve }))
    const view = render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('komari_console_mode'))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b' })])
    vault.id = 'vault-b'
    view.rerender(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    await act(async () => { finishMode('mobile') })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(openBrowserWindow).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['select', 'new', 'remove'] as const)('invalidates a pending mobile mode lookup when the same-Vault integration changes via %s', async (action) => {
    vi.mocked(isTauri).mockReturnValue(true)
    let finishMode!: (mode: string) => void
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finishMode = resolve }))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration(), integration({ id: 'other-id', name: 'Other Komari' })])
    // Keep deletion pending: invalidation must occur on the user's action,
    // rather than waiting for native persistence to finish.
    vi.mocked(deleteKomariIntegration).mockImplementationOnce(() => new Promise(() => {}))
    render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('komari_console_mode'))
    fireEvent.click(screen.getByRole('button', { name: action === 'select' ? 'Other Komari' : en[action === 'new' ? 'settings.komariNew' : 'settings.komariRemove'] }))
    await act(async () => { finishMode('mobile') })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(openBrowserWindow).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['vault', 'selection'] as const)('cancels a late native prepare after a %s change without opening its token', async (change) => {
    vi.mocked(isTauri).mockReturnValue(true)
    let finishPrepare!: (token: string) => void
    vi.mocked(invoke).mockResolvedValueOnce('mobile')
      .mockImplementationOnce(() => new Promise((resolve) => { finishPrepare = resolve })).mockResolvedValue(undefined)
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration(), integration({ id: 'other-id', name: 'Other Komari' })])
    const view = render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('prepare_mobile_komari_console', { vaultId: 'vault-a', integrationId: 'same-id' }))
    if (change === 'vault') {
      vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b' })])
      vault.id = 'vault-b'
      view.rerender(section())
    } else fireEvent.click(screen.getByRole('button', { name: 'Other Komari' }))
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    await act(async () => { finishPrepare(requestId) })
    expect(invoke).toHaveBeenCalledWith('cancel_mobile_komari_console', { requestId })
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'open_mobile_komari_console')).toBe(false)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['select', 'new', 'remove', 'save', 'unmount'] as const)('cancels a known queued native request on %s', async (action) => {
    vault.unlocked = true
    vi.mocked(isTauri).mockReturnValue(true)
    let finishOpen!: () => void
    vi.mocked(invoke).mockResolvedValueOnce('mobile').mockResolvedValueOnce(requestId)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishOpen = resolve })).mockResolvedValue(undefined)
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration(), integration({ id: 'other-id', name: 'Other Komari' })])
    vi.mocked(deleteKomariIntegration).mockImplementationOnce(() => new Promise(() => {}))
    vi.mocked(upsertKomariIntegration).mockImplementationOnce(() => new Promise(() => {}))
    const view = render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_mobile_komari_console', { requestId }))
    if (action === 'unmount') view.unmount()
    else fireEvent.click(screen.getByRole('button', { name: action === 'select' ? 'Other Komari' : en[action === 'new' ? 'settings.komariNew' : action === 'remove' ? 'settings.komariRemove' : 'settings.komariSave'] }))
    expect(invoke).toHaveBeenCalledWith('cancel_mobile_komari_console', { requestId })
    await act(async () => { finishOpen() })
    expect(openBrowserWindow).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('closes an old same-Vault desktop window without clearing the newer mobile request busy state', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    let finishOldWindow!: () => void
    let finishNewMobile!: () => void
    vi.mocked(invoke).mockResolvedValueOnce('desktop').mockResolvedValueOnce('mobile').mockResolvedValueOnce(requestId)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishNewMobile = resolve }))
      .mockResolvedValue(undefined)
    vi.mocked(openBrowserWindow).mockImplementationOnce(() => new Promise<void>((resolve) => { finishOldWindow = resolve }))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration(), integration({ id: 'other-id', name: 'Other Komari' })])
    render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(openBrowserWindow).toHaveBeenCalledTimes(1))
    const old = vi.mocked(openBrowserWindow).mock.calls[0][0]
    fireEvent.click(screen.getByRole('button', { name: 'Other Komari' }))
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('prepare_mobile_komari_console', { vaultId: 'vault-a', integrationId: 'other-id' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_mobile_komari_console', { requestId }))
    await act(async () => { finishOldWindow() })
    expect(closeBrowserWindow).toHaveBeenCalledExactlyOnceWith(old.browserId, old.sessionId)
    expect(loadBrowserSource).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en['settings.komariConsoleOpening'] })).toBeDisabled()
    await act(async () => { finishNewMobile() })
    expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled()
  })

  it('ignores an old-Vault mobile failure after handoff without blocking the new scope', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    let failOpen!: (cause: string) => void
    vi.mocked(invoke).mockResolvedValueOnce('mobile').mockResolvedValueOnce(requestId)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failOpen = reject })).mockResolvedValue(undefined)
    const view = render(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_mobile_komari_console', { requestId }))
    vi.mocked(listKomariIntegrations).mockResolvedValueOnce([integration({ vaultId: 'vault-b' })])
    vault.id = 'vault-b'
    view.rerender(section())
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled())
    expect(invoke).toHaveBeenCalledWith('cancel_mobile_komari_console', { requestId })
    await act(async () => { failOpen('VAULT_LOCKED') })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['settings.komariConsoleOpen'] })).toBeEnabled()
    expect(openBrowserWindow).not.toHaveBeenCalled()
  })

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
