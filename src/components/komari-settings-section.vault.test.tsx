import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultProvider, useVault } from '@/contexts/vault-context'
import { I18nProvider } from '@/lib/i18n'
import { listKomariIntegrations, upsertKomariIntegration, type KomariIntegration } from '@/lib/komari-config'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import { vaultGetSecret, vaultListSecretKeys, vaultSetSecret, vaultStatus, type VaultStatus } from '@/lib/vault'
import { listVaults } from '@/lib/vaults'
import { KomariSettingsSection } from './komari-settings-section'

// Keep the real context and save handler: mocking useVault would conceal a
// swallowed native rejection, which is the failure this regression exercises.
vi.mock('@/lib/vault', () => ({
  vaultDeleteSecret: vi.fn(), vaultGetSecret: vi.fn(), vaultInitialize: vi.fn(),
  vaultListSecretKeys: vi.fn(), vaultLock: vi.fn(), vaultSetSecret: vi.fn(),
  vaultStatus: vi.fn(), vaultUnlock: vi.fn(),
}))
vi.mock('@/lib/vaults', () => ({ DEFAULT_VAULT_ID: 'personal', listVaults: vi.fn() }))
vi.mock('@/components/vault-gate-dialog', () => ({ VaultGateDialog: () => null }))
vi.mock('@/lib/komari-config', () => ({
  listKomariIntegrations: vi.fn(), upsertKomariIntegration: vi.fn(),
  deleteKomariIntegration: vi.fn(), komariCredentialKey: (id: string) => `komari.${id}.api-key`,
}))
vi.mock('@/lib/browser', () => ({ openBrowserWindow: vi.fn(), loadBrowserSource: vi.fn(), closeBrowserWindow: vi.fn() }))

const secret = 'synthetic-unsaved-api-key'
const credentialRef = 'komari.saved.api-key'
const saved: KomariIntegration = {
  id: 'saved', vaultId: 'personal', name: 'Test Komari', endpoint: 'https://komari.example',
  credentialRef: '', enabled: true, createdAt: 1, updatedAt: 1,
}
const output = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function VaultContract({ onRejected = () => {} }: { onRejected?: (cause: unknown) => void }) {
  const vault = useVault()
  const [result, setResult] = useState('idle')
  return <>
    <output data-testid="vault-ready">{String(vault.vaultStatusState?.unlocked === true)}</output>
    <output data-testid="vault-id">{vault.activeVaultId}</output>
    <output data-testid="vault-status">{JSON.stringify(vault.vaultStatusState)}</output>
    <output data-testid="vault-busy">{String(vault.vaultBusy)}</output>
    <output data-testid="vault-keys">{JSON.stringify(vault.vaultKeys)}</output>
    <output data-testid="vault-events">{JSON.stringify(vault.securityEvents)}</output>
    <output data-testid="save-result">{result}</output>
    <button onClick={() => vault.setActiveVaultId('vault-b')}>Switch to Vault B</button>
    <button onClick={() => {
      void vault.handleSaveSecret(credentialRef, secret).then(
        () => setResult('resolved'),
        (cause) => { onRejected(cause); setResult('rejected') },
      )
    }}>Test credential save</button>
  </>
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(vaultStatus).mockResolvedValue({ initialized: true, unlocked: true, secretCount: 0 })
  vi.mocked(vaultListSecretKeys).mockResolvedValue([])
  vi.mocked(vaultSetSecret).mockResolvedValue(undefined)
  vi.mocked(listVaults).mockResolvedValue([{ id: 'personal', name: 'Personal', createdAt: 1, isDefault: true }])
  vi.mocked(listKomariIntegrations).mockResolvedValue([saved])
  vi.mocked(upsertKomariIntegration).mockResolvedValue(saved)
})
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

describe('Vault credential save contract', () => {
  it.each(['write', 'status', 'keys'] as const)('ignores old-Vault %s work completing after the new Vault has loaded', async (pendingStage) => {
    render(<VaultProvider setOutput={output}><VaultContract /></VaultProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    const oldWrite = deferred<void>()
    const oldStatus = deferred<VaultStatus>()
    const oldKeys = deferred<string[]>()
    if (pendingStage === 'write') vi.mocked(vaultSetSecret).mockReturnValueOnce(oldWrite.promise)
    else if (pendingStage === 'status') vi.mocked(vaultStatus).mockReturnValueOnce(oldStatus.promise)
    else vi.mocked(vaultListSecretKeys).mockReturnValueOnce(oldKeys.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Test credential save' }))
    await waitFor(() => {
      if (pendingStage === 'write') expect(vaultSetSecret).toHaveBeenCalledTimes(1)
      else if (pendingStage === 'status') expect(vaultStatus).toHaveBeenCalledTimes(2)
      else expect(vaultListSecretKeys).toHaveBeenCalledTimes(2)
    })

    const statusB = { initialized: true, unlocked: false, secretCount: 1 }
    vi.mocked(vaultStatus).mockImplementation(async (id) => id === 'vault-b'
      ? statusB : { initialized: false, unlocked: true, secretCount: 99 })
    vi.mocked(vaultListSecretKeys).mockImplementation(async (id) => id === 'vault-b'
      ? ['vault-b-key'] : ['late-old-vault-key'])
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Vault B' }))
    await waitFor(() => expect(screen.getByTestId('vault-keys')).toHaveTextContent('["vault-b-key"]'))
    expect(screen.getByTestId('vault-id')).toHaveTextContent('vault-b')
    expect(screen.getByTestId('vault-status')).toHaveTextContent(JSON.stringify(statusB))

    await act(async () => {
      if (pendingStage === 'write') oldWrite.resolve(undefined)
      else if (pendingStage === 'status') oldStatus.resolve({ initialized: false, unlocked: true, secretCount: 99 })
      else oldKeys.resolve(['late-old-vault-key'])
    })
    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('resolved'))
    expect(screen.getByTestId('vault-id')).toHaveTextContent('vault-b')
    expect(screen.getByTestId('vault-status')).toHaveTextContent(JSON.stringify(statusB))
    expect(screen.getByTestId('vault-keys')).toHaveTextContent('["vault-b-key"]')
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it.each(['write', 'refresh'] as const)('rejects a %s failure without reporting success or exposing the native error', async (failureStage) => {
    const onRejected = vi.fn()
    render(<VaultProvider setOutput={output}><VaultContract onRejected={onRejected} /></VaultProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    const failure = new Error(`Native error containing ${secret}`)
    if (failureStage === 'write') vi.mocked(vaultSetSecret).mockRejectedValueOnce(failure)
    else vi.mocked(vaultListSecretKeys).mockRejectedValueOnce(failure)
    fireEvent.click(screen.getByRole('button', { name: 'Test credential save' }))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('rejected'))
    expect(onRejected).toHaveBeenCalledExactlyOnceWith(failure)
    expect(vaultSetSecret).toHaveBeenCalledExactlyOnceWith(credentialRef, secret, 'personal')
    expect(screen.getByTestId('vault-busy')).toHaveTextContent('false')
    expect(screen.getByTestId('vault-events')).toHaveTextContent('[]')
    expect(output).toHaveBeenCalledExactlyOnceWith('Failed to save vault key.')
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret)
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it('resolves only after refreshing the active Vault key list, without reading the secret back', async () => {
    render(<VaultProvider setOutput={output}><VaultContract /></VaultProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    vi.mocked(vaultListSecretKeys).mockResolvedValueOnce([credentialRef])
    fireEvent.click(screen.getByRole('button', { name: 'Test credential save' }))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('resolved'))
    expect(screen.getByTestId('vault-keys')).toHaveTextContent(JSON.stringify([credentialRef]))
    expect(screen.getByTestId('vault-busy')).toHaveTextContent('false')
    expect(output).toHaveBeenCalledExactlyOnceWith(`Saved vault key: ${credentialRef}`)
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })
})

describe('Komari settings with the real Vault save handler', () => {
  it('locks the current form while the native save is pending and restores retained input for retry after rejection', async () => {
    const other = { ...saved, id: 'other', name: 'Other Komari' }
    vi.mocked(listKomariIntegrations).mockResolvedValue([saved, other])
    render(<I18nProvider><VaultProvider setOutput={output}><KomariSettingsSection /><VaultContract /></VaultProvider></I18nProvider>)
    await screen.findByRole('button', { name: saved.name })
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    const name = screen.getByLabelText(en['settings.komariName'])
    const endpoint = screen.getByLabelText(en['settings.komariEndpoint'])
    const input = screen.getByLabelText(en['settings.komariApiKey'])
    const enabled = screen.getByRole('checkbox', { name: en['settings.komariEnabled'] })
    fireEvent.change(input, { target: { value: secret } })
    const pending = deferred<void>()
    vi.mocked(vaultSetSecret).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => expect(vaultSetSecret).toHaveBeenCalledTimes(1))
    const selected = screen.getByRole('button', { name: saved.name })
    const otherButton = screen.getByRole('button', { name: other.name })
    const newButton = screen.getByRole('button', { name: en['settings.komariNew'] })
    const showKey = screen.getByRole('button', { name: en['settings.komariShowApiKey'] })
    const controls = [selected, otherButton, newButton, name, endpoint, input, enabled, showKey]
    for (const control of controls) expect(control).toBeDisabled()
    // Native click honors disabled form controls; dispatchEvent can manufacture
    // a checkbox event that a user cannot send while the input is disabled.
    otherButton.click()
    newButton.click()
    showKey.click()
    enabled.click()
    expect(name).toHaveValue(saved.name)
    expect(endpoint).toHaveValue(saved.endpoint)
    expect(input).toHaveValue(secret)
    expect(input).toHaveAttribute('type', 'password')
    expect(enabled).toBeChecked()

    await act(async () => pending.reject(new Error('Synthetic native save failure')))
    expect(await screen.findByRole('alert')).toHaveTextContent(en['settings.komariCredentialSaveFailed'])
    for (const control of controls) expect(control).toBeEnabled()
    expect(input).toHaveValue(secret)
    fireEvent.change(name, { target: { value: 'Retry Komari' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => expect(input).toHaveValue(''))
    expect(vaultSetSecret).toHaveBeenCalledTimes(2)
    expect(vi.mocked(upsertKomariIntegration).mock.calls[1][0]).toMatchObject({ id: saved.id, name: 'Retry Komari' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it('reuses newly created metadata on a credential-save retry instead of creating another integration', async () => {
    let stored: KomariIntegration | null = null
    vi.mocked(listKomariIntegrations).mockImplementation(async () => stored ? [stored] : [])
    vi.mocked(upsertKomariIntegration).mockImplementation(async (input) => {
      stored = { ...saved, ...input, credentialRef: input.credentialRef ?? '' }
      return stored
    })
    const uuid = vi.spyOn(crypto, 'randomUUID')
    try {
      render(<I18nProvider><VaultProvider setOutput={output}><KomariSettingsSection /><VaultContract /></VaultProvider></I18nProvider>)
      await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
      fireEvent.change(screen.getByLabelText(en['settings.komariName']), { target: { value: saved.name } })
      fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: saved.endpoint } })
      const input = screen.getByLabelText(en['settings.komariApiKey'])
      fireEvent.change(input, { target: { value: secret } })
      vi.mocked(vaultSetSecret).mockRejectedValueOnce(new Error('Synthetic native write failure'))
      fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
      expect(await screen.findByRole('alert')).toHaveTextContent(en['settings.komariCredentialSaveFailed'])
      const firstId = vi.mocked(upsertKomariIntegration).mock.calls[0][0].id
      expect(firstId).toBeTruthy()
      expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
      expect(listKomariIntegrations).toHaveBeenCalledTimes(1)
      expect(input).toHaveValue(secret)

      fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
      await screen.findByRole('button', { name: saved.name })
      await waitFor(() => expect(input).toHaveValue(''))
      expect(upsertKomariIntegration).toHaveBeenCalledTimes(3)
      expect(vi.mocked(upsertKomariIntegration).mock.calls.map(([item]) => item.id)).toEqual([firstId, firstId, firstId])
      expect(uuid).toHaveBeenCalledTimes(1)
      expect(vaultSetSecret).toHaveBeenCalledTimes(2)
      expect(vi.mocked(vaultSetSecret).mock.calls).toEqual([
        [`komari.${firstId}.api-key`, secret, 'personal'],
        [`komari.${firstId}.api-key`, secret, 'personal'],
      ])
      expect(listKomariIntegrations).toHaveBeenCalledTimes(2)
      expect(vaultGetSecret).not.toHaveBeenCalled()
    } finally {
      uuid.mockRestore()
    }
  })

  it.each(['en', 'zh-CN'] as const)('retains and masks failed credentials with a safe error, then permits one successful retry (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const copy = locale === 'en' ? en : zhCN
    render(<I18nProvider><VaultProvider setOutput={output}><KomariSettingsSection /><VaultContract /></VaultProvider></I18nProvider>)
    await screen.findByRole('button', { name: saved.name })
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    const input = screen.getByLabelText(copy['settings.komariApiKey'])
    fireEvent.change(input, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: copy['settings.komariShowApiKey'] }))
    expect(input).toHaveAttribute('type', 'text')
    vi.mocked(vaultSetSecret).mockRejectedValueOnce(new Error(`Native failure with ${secret}`))
    fireEvent.click(screen.getByRole('button', { name: copy['settings.komariSave'] }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy['settings.komariCredentialSaveFailed'])
    expect(screen.getByRole('alert')).not.toHaveTextContent(secret)
    expect(input).toHaveValue(secret)
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: copy['settings.komariSave'] })).toBeEnabled()
    expect(screen.getByTestId('vault-busy')).toHaveTextContent('false')
    expect(vaultSetSecret).toHaveBeenCalledExactlyOnceWith(credentialRef, secret, 'personal')
    expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
    expect(listKomariIntegrations).toHaveBeenCalledExactlyOnceWith('personal')
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret)
    expect(vaultGetSecret).not.toHaveBeenCalled()

    vi.mocked(vaultListSecretKeys).mockResolvedValueOnce([credentialRef])
    fireEvent.click(screen.getByRole('button', { name: copy['settings.komariSave'] }))
    await waitFor(() => expect(input).toHaveValue(''))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(vaultSetSecret).toHaveBeenCalledTimes(2)
    expect(vaultSetSecret).toHaveBeenLastCalledWith(credentialRef, secret, 'personal')
    expect(upsertKomariIntegration).toHaveBeenCalledTimes(3)
    expect(upsertKomariIntegration).toHaveBeenLastCalledWith({
      id: saved.id, vaultId: 'personal', name: saved.name, endpoint: saved.endpoint,
      credentialRef, enabled: saved.enabled,
    })
    expect(listKomariIntegrations).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('vault-keys')).toHaveTextContent(JSON.stringify([credentialRef]))
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })
})
