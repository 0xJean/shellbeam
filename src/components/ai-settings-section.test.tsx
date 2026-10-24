import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AISettingsSection } from './settings-panel'
import { DEFAULT_AI_SETTINGS, loadAISettings, saveAISettings } from '@/lib/ai'
import { modelCacheKey, MODEL_CACHE_TTL, saveModelCache } from '@/lib/ai-models'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'

const settings = { ...DEFAULT_AI_SETTINGS, apiKey: 'test-key', model: 'my-existing-model' }
const response = (id: string) => new Response(JSON.stringify({ data: [{ id }] }))

describe('AI model settings', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
    saveAISettings(settings)
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('refreshes suggestions only on request and keeps the selected model', async () => {
    vi.mocked(fetch).mockResolvedValue(response('gpt-new-example'))
    render(<AISettingsSection />)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    await screen.findByText(/1 model suggestions/)
    expect(screen.getByLabelText('Model')).toHaveValue('my-existing-model')
    expect(loadAISettings().model).toBe('my-existing-model')
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('listbox').querySelector('[data-value="gpt-new-example"]')!)
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-new-example')
  })

  it('restores stale cache and preserves it after a failed refresh', async () => {
    saveModelCache(await modelCacheKey(settings), { models: [{ id: 'cached', name: 'cached' }], fetchedAt: Date.now() - MODEL_CACHE_TTL - 1000 })
    vi.mocked(fetch).mockResolvedValue(new Response('bad key', { status: 401 }))
    render(<AISettingsSection />)
    await screen.findByText(/more than 24 hours old/)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 401')
    expect(screen.getByText(/more than 24 hours old/)).toBeInTheDocument()
    expect(screen.getByLabelText('Model')).toHaveValue('my-existing-model')
  })

  it('permits manual IDs for every provider without carrying another provider key', () => {
    render(<AISettingsSection />)
    for (const provider of ['Anthropic', 'OpenRouter', 'Ollama (Local)', 'Custom Endpoint', 'OpenAI']) {
      fireEvent.click(screen.getByRole('button', { name: provider }))
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'manual-model' } })
      expect(screen.getByLabelText('Model')).toHaveValue('manual-model')
      if (provider === 'Anthropic' || provider === 'OpenRouter') expect(screen.getByLabelText('API Key')).toHaveValue('')
    }
    expect(screen.getByLabelText('API Key')).toHaveValue('test-key')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('aborts and ignores late results when provider or credentials change', async () => {
    let resolve!: (value: Response) => void
    let signal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation((_url, init) => { signal = init?.signal; return new Promise((done) => { resolve = done }) })
    render(<AISettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic' }))
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolve(response('gpt-late')); await Promise.resolve() })
    expect(screen.queryByText(/1 model suggestions/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Model')).not.toHaveValue('gpt-late')
  })

  it('renders loaded models even when storage is full', async () => {
    vi.mocked(fetch).mockResolvedValue(response('gpt-new-example'))
    render(<AISettingsSection />)
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('shellbeam.aiModels')) throw new Error('Full')
      original.call(this, key, value)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('cache could not be saved'))
    expect(screen.getByText(/1 model suggestions/)).toBeInTheDocument()
  })

  it('clears the active custom key when its destination changes', () => {
    saveAISettings({ ...settings, provider: 'custom', customBaseUrl: 'https://one.test/v1', customModel: 'private-model' })
    render(<AISettingsSection />)
    expect(screen.getByLabelText('API Key (optional)')).toHaveValue('test-key')
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://two.test/v1' } })
    expect(screen.getByLabelText('API Key (optional)')).toHaveValue('')
    expect(screen.getByLabelText('Model')).toHaveValue('private-model')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('aborts when the key changes and does not reuse another account cache', async () => {
    saveModelCache(await modelCacheKey(settings), { models: [{ id: 'private-model', name: 'private-model' }], fetchedAt: Date.now() })
    let signal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation((_url, init) => { signal = init?.signal; return new Promise(() => {}) })
    render(<AISettingsSection />)
    await screen.findByText(/1 model suggestions/)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'different-key' } })
    expect(signal?.aborted).toBe(true)
    await screen.findByText(/Built-in suggestions only/)
    expect(screen.queryByText(/1 model suggestions/)).not.toBeInTheDocument()
  })

  it('has matching model discovery messages in Chinese and English', () => {
    const keys = Object.keys(en).filter((key) => key.startsWith('settings.model') || key.startsWith('settings.availableModels'))
    for (const key of keys) expect(zhCN[key]).toBeTruthy()
  })
})
