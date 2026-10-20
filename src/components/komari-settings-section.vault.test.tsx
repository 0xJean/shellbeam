import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultProvider, useVault } from '@/contexts/vault-context'
import { I18nProvider } from '@/lib/i18n'
import { listKomariIntegrations, normalizeKomariIntegrationInput, upsertKomariIntegration, type KomariIntegration } from '@/lib/komari-config'
import en from '@/lib/locales/en'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
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
vi.mock('@/lib/komari-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/komari-config')>(),
  listKomariIntegrations: vi.fn(), upsertKomariIntegration: vi.fn(), deleteKomariIntegration: vi.fn(),
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
    <button onClick={() => { vault.setActiveVaultId('vault-b'); vault.setActiveVaultId('personal') }}>Switch B then A</button>
    <button onClick={() => {
      void vault.handleSaveSecret(credentialRef, secret).then(
        () => setResult('resolved'),
        (cause) => { onRejected(cause); setResult('rejected') },
      )
    }}>Test credential save</button>
  </>
}

function SettingsNavigation() {
  const [visible, setVisible] = useState(true)
  return <>
    <button onClick={() => setVisible(false)}>Leave settings</button>
    {visible && <KomariSettingsSection />}
    <VaultContract />
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
  it.each(['metadata', 'secret'] as const)('does not continue a save after the Vault provider unmounts during %s', async (stage) => {
    const metadata = deferred<KomariIntegration>()
    const write = deferred<void>()
    if (stage === 'metadata') vi.mocked(upsertKomariIntegration).mockReturnValueOnce(metadata.promise)
    else vi.mocked(vaultSetSecret).mockReturnValueOnce(write.promise)
    const view = render(<I18nProvider><VaultProvider setOutput={output}><SettingsNavigation /></VaultProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    fireEvent.click(await screen.findByRole('button', { name: saved.name }))
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => {
      if (stage === 'metadata') expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
      else expect(vaultSetSecret).toHaveBeenCalledTimes(1)
    })
    view.unmount()
    await act(async () => {
      if (stage === 'metadata') metadata.resolve(saved)
      else write.resolve(undefined)
    })
    expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
    expect(vaultSetSecret).toHaveBeenCalledTimes(stage === 'metadata' ? 0 : 1)
    expect(listKomariIntegrations).toHaveBeenCalledTimes(1)
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it.each(['metadata', 'secret'] as const)('finishes the same-Vault credential save after leaving settings during %s', async (stage) => {
    const metadata = deferred<KomariIntegration>()
    const write = deferred<void>()
    if (stage === 'metadata') vi.mocked(upsertKomariIntegration).mockReturnValueOnce(metadata.promise)
    else vi.mocked(vaultSetSecret).mockReturnValueOnce(write.promise)
    render(<I18nProvider><VaultProvider setOutput={output}><SettingsNavigation /></VaultProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    fireEvent.click(await screen.findByRole('button', { name: saved.name }))
    fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => {
      if (stage === 'metadata') expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
      else expect(vaultSetSecret).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }))
    expect(screen.queryByLabelText(en['settings.komariApiKey'])).not.toBeInTheDocument()
    await act(async () => {
      if (stage === 'metadata') metadata.resolve(saved)
      else write.resolve(undefined)
    })
    await waitFor(() => expect(upsertKomariIntegration).toHaveBeenCalledTimes(2))
    expect(vaultSetSecret).toHaveBeenCalledExactlyOnceWith(credentialRef, secret, 'personal')
    expect(vi.mocked(upsertKomariIntegration).mock.calls[1][0]).toMatchObject({ id: saved.id, vaultId: 'personal', credentialRef })
    expect(screen.getByTestId('vault-busy')).toHaveTextContent('false')
    expect(listKomariIntegrations).toHaveBeenCalledTimes(1)
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it.each(['metadata', 'secret'] as const)('stops old save continuation after a batched A→B→A transition during %s', async (stage) => {
    const metadata = deferred<KomariIntegration>()
    const write = deferred<void>()
    if (stage === 'metadata') vi.mocked(upsertKomariIntegration).mockReturnValueOnce(metadata.promise)
    else vi.mocked(vaultSetSecret).mockReturnValueOnce(write.promise)
    render(<I18nProvider><VaultProvider setOutput={output}><SettingsNavigation /></VaultProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    fireEvent.click(await screen.findByRole('button', { name: saved.name }))
    const input = screen.getByLabelText(en['settings.komariApiKey'])
    fireEvent.change(input, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => {
      if (stage === 'metadata') expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
      else expect(vaultSetSecret).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Switch B then A' }))
    expect(screen.getByTestId('vault-id')).toHaveTextContent('personal')
    await act(async () => {
      if (stage === 'metadata') metadata.resolve(saved)
      else write.resolve(undefined)
    })
    await waitFor(() => expect(screen.getByRole('button', { name: en['settings.komariSave'] })).toBeEnabled())
    expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
    expect(vaultSetSecret).toHaveBeenCalledTimes(stage === 'metadata' ? 0 : 1)
    expect(listKomariIntegrations).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue(secret)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it.each(['new', 'typing', 'selection'] as const)('does not let a late list overwrite a %s draft or redirect its credential write', async (action) => {
    const first = { ...saved, id: 'first', name: 'First Komari', credentialRef: 'legacy.first.api-key' }
    const second = { ...saved, id: 'second', name: 'Second Komari', endpoint: 'https://second.example', credentialRef: 'legacy.second.api-key' }
    let rows = [first, second]
    const pending = deferred<KomariIntegration[]>()
    vi.mocked(listKomariIntegrations).mockImplementation(async () => rows)
    if (action === 'typing') vi.mocked(listKomariIntegrations).mockReturnValueOnce(pending.promise)
    vi.mocked(upsertKomariIntegration).mockImplementation(async (input) => {
      const normalized = normalizeKomariIntegrationInput(input)
      const next = { ...saved, ...normalized, id: input.id! }
      rows = [next, ...rows.filter((row) => row.id !== next.id)]
      return next
    })
    render(<I18nProvider><VaultProvider setOutput={output}><KomariSettingsSection /><VaultContract /></VaultProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    if (action !== 'typing') {
      await screen.findByRole('button', { name: first.name })
      vi.mocked(listKomariIntegrations).mockReturnValueOnce(pending.promise)
      fireEvent.click(screen.getByRole('button', { name: en['settings.komariRefresh'] }))
      await waitFor(() => expect(listKomariIntegrations).toHaveBeenCalledTimes(2))
      fireEvent.click(screen.getByRole('button', { name: action === 'new' ? settingsNavigationCopy.en.addSource : second.name }))
    } else fireEvent.click(screen.getByRole('button', { name: settingsNavigationCopy.en.addSource }))
    const expectedName = action === 'selection' ? second.name : 'New draft Komari'
    const expectedEndpoint = action === 'selection' ? second.endpoint : 'https://draft.example'
    const input = screen.getByLabelText(en['settings.komariApiKey'])
    if (action !== 'selection') {
      fireEvent.change(screen.getByLabelText(en['settings.komariName']), { target: { value: expectedName } })
      fireEvent.change(screen.getByLabelText(en['settings.komariEndpoint']), { target: { value: expectedEndpoint } })
      fireEvent.change(input, { target: { value: secret } })
    }
    // The old response omits the newly selected integration. Without draft
    // invalidation it would select first and overwrite the endpoint/name.
    await act(async () => pending.resolve([first]))
    expect(screen.getByLabelText(en['settings.komariName'])).toHaveValue(expectedName)
    expect(screen.getByLabelText(en['settings.komariEndpoint'])).toHaveValue(expectedEndpoint)
    expect(input).toHaveValue(action === 'selection' ? '' : secret)
    if (action === 'selection') fireEvent.change(input, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))

    await waitFor(() => expect(vaultSetSecret).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(input).toHaveValue(''))
    expect(upsertKomariIntegration).toHaveBeenCalledTimes(1)
    const metadata = vi.mocked(upsertKomariIntegration).mock.calls[0][0]
    expect(metadata).toMatchObject({ name: expectedName, endpoint: expectedEndpoint, vaultId: 'personal' })
    expect(metadata.id).not.toBe(first.id)
    const expectedRef = action === 'selection' ? second.credentialRef : `komari.${metadata.id}.api-key`
    expect(vaultSetSecret).toHaveBeenCalledExactlyOnceWith(expectedRef, secret, 'personal')
    expect(vaultSetSecret).not.toHaveBeenCalledWith(first.credentialRef, expect.anything(), expect.anything())
    if (action === 'selection') expect(metadata.id).toBe(second.id)
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves an existing custom credential reference when replacing the API Key is %s', async (replaceKey) => {
    const customRef = 'legacy.monitoring.api-key'
    let stored = { ...saved, credentialRef: customRef }
    vi.mocked(listKomariIntegrations).mockImplementation(async () => [stored])
    // Use the real normalizer: omitted credentialRef regenerates the default
    // name, so returning the old reference unconditionally would hide the bug.
    vi.mocked(upsertKomariIntegration).mockImplementation(async (input) => {
      const normalized = normalizeKomariIntegrationInput(input)
      stored = { ...stored, ...normalized }
      return stored
    })
    render(<I18nProvider><VaultProvider setOutput={output}><KomariSettingsSection /><VaultContract /></VaultProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    fireEvent.click(await screen.findByRole('button', { name: saved.name }))
    if (replaceKey) fireEvent.change(screen.getByLabelText(en['settings.komariApiKey']), { target: { value: secret } })
    fireEvent.change(screen.getByLabelText(en['settings.komariName']), { target: { value: 'Edited Komari' } })
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))

    await screen.findByRole('button', { name: 'Edited Komari' })
    expect(upsertKomariIntegration).toHaveBeenCalledExactlyOnceWith({
      id: saved.id, vaultId: saved.vaultId, name: 'Edited Komari', endpoint: saved.endpoint,
      credentialRef: customRef, enabled: saved.enabled,
    })
    expect(stored.credentialRef).toBe(customRef)
    if (replaceKey) expect(vaultSetSecret).toHaveBeenCalledExactlyOnceWith(customRef, secret, 'personal')
    else expect(vaultSetSecret).not.toHaveBeenCalled()
    expect(screen.getByLabelText(en['settings.komariApiKey'])).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })

  it('locks the current form while the native save is pending and restores retained input for retry after rejection', async () => {
    const other = { ...saved, id: 'other', name: 'Other Komari' }
    vi.mocked(listKomariIntegrations).mockResolvedValue([saved, other])
    render(<I18nProvider><VaultProvider setOutput={output}><KomariSettingsSection /><VaultContract /></VaultProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    fireEvent.click(await screen.findByRole('button', { name: saved.name }))
    const name = screen.getByLabelText(en['settings.komariName'])
    const endpoint = screen.getByLabelText(en['settings.komariEndpoint'])
    const input = screen.getByLabelText(en['settings.komariApiKey'])
    const enabled = screen.getByRole('checkbox', { name: en['settings.komariEnabled'] })
    fireEvent.change(input, { target: { value: secret } })
    const pending = deferred<void>()
    vi.mocked(vaultSetSecret).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: en['settings.komariSave'] }))
    await waitFor(() => expect(vaultSetSecret).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(en['settings.komariSaved'])).not.toBeInTheDocument()
    const selected = screen.getByRole('button', { name: saved.name })
    const otherButton = screen.getByRole('button', { name: other.name })
    const newButton = screen.getByRole('button', { name: settingsNavigationCopy.en.addSource })
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
      fireEvent.click(screen.getByRole('button', { name: settingsNavigationCopy.en.addSource }))
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
    await waitFor(() => expect(screen.getByTestId('vault-ready')).toHaveTextContent('true'))
    fireEvent.click(await screen.findByRole('button', { name: saved.name }))
    const input = screen.getByLabelText(copy['settings.komariApiKey'])
    expect(screen.getByText(copy['settings.komariApiKeyHelp'])).toBeInTheDocument()
    fireEvent.change(input, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: copy['settings.komariShowApiKey'] }))
    expect(input).toHaveAttribute('type', 'text')
    vi.mocked(vaultSetSecret).mockRejectedValueOnce(new Error(`Native failure with ${secret}`))
    fireEvent.click(screen.getByRole('button', { name: copy['settings.komariSave'] }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy['settings.komariCredentialSaveFailed'])
    expect(screen.queryByText(copy['settings.komariSaved'])).not.toBeInTheDocument()
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
    expect(await screen.findByText(copy['settings.komariSaved'])).toHaveAttribute('role', 'status')
    expect(input).toHaveAttribute('type', 'password')
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
    fireEvent.change(screen.getByLabelText(copy['settings.komariName']), { target: { value: 'Unsaved edit' } })
    expect(screen.queryByText(copy['settings.komariSaved'])).not.toBeInTheDocument()
  })
})
