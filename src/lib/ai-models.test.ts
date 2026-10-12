import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_SETTINGS, streamAICommand, switchAIProvider } from './ai'
import { aiBaseUrl, discoverModels, loadModelCache, modelCacheKey, openAIEndpoint, parseModels, saveModelCache } from './ai-models'

const settings = { ...DEFAULT_AI_SETTINGS, apiKey: 'test-key' }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('model discovery', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('lists OpenAI text models, deduplicates and filters unrelated products', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ data: [
      { id: 'gpt-example' }, { id: 'gpt-example' }, { id: 'o3' }, { id: 'text-embedding-3-small' },
      { id: 'gpt-image-1' }, { id: 'gpt-realtime' }, { id: 'gpt-audio' }, { id: 'gpt-codex' }, {},
    ] }))
    const catalog = await discoverModels(settings)
    expect(catalog.models.map((model) => model.id)).toEqual(['gpt-example', 'o3'])
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      headers: { Accept: 'application/json', Authorization: 'Bearer test-key' }, redirect: 'error', credentials: 'omit',
    }))
  })

  it('paginates Anthropic using cursor metadata and its own authentication headers', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true, last_id: 'a /' }))
      .mockResolvedValueOnce(response({ data: [{ id: 'claude-b' }], has_more: false }))
    const catalog = await discoverModels({ ...settings, provider: 'anthropic' })
    expect(catalog.models).toEqual([{ id: 'claude-a', name: 'Claude A' }, { id: 'claude-b', name: 'claude-b' }])
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.anthropic.com/v1/models?limit=100&after_id=a+%2F', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' }),
    }))
  })

  it('rejects repeated or missing pagination cursors instead of silently caching partial data', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ data: [], has_more: true, last_id: 'same' }))
    await expect(discoverModels({ ...settings, provider: 'anthropic' })).rejects.toMatchObject({ code: 'invalid' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses Ollama tags without forwarding any API key', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ models: [{ name: 'qwen:latest' }] }))
    expect((await discoverModels({ ...settings, provider: 'ollama' })).models[0].id).toBe('qwen:latest')
    expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.objectContaining({ headers: { Accept: 'application/json' } }))
  })

  it('filters OpenRouter output modalities without requiring a key for its public catalog', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ data: [
      { id: 'vendor/text', name: 'Text', architecture: { output_modalities: ['text'] } },
      { id: 'vendor/image', architecture: { output_modalities: ['image'] } },
    ] }))
    expect((await discoverModels({ ...settings, provider: 'openrouter', apiKey: '' })).models).toEqual([{ id: 'vendor/text', name: 'Text' }])
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', expect.objectContaining({ headers: { Accept: 'application/json' } }))
  })

  it('supports custom model IDs and normalizes trailing /v1 slashes', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ data: [{ id: 'my-model' }] }))
    const result = await discoverModels({ ...settings, provider: 'custom', customBaseUrl: 'https://example.test/proxy/v1/' })
    expect(result.models[0].id).toBe('my-model')
    expect(fetch).toHaveBeenCalledWith('https://example.test/proxy/v1/models', expect.anything())
    expect(openAIEndpoint('https://example.test/', 'models')).toBe('https://example.test/v1/models')
  })

  it('rejects missing required keys before making a request', async () => {
    await expect(discoverModels({ ...settings, apiKey: '' })).rejects.toMatchObject({ code: 'credentials' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['file:///etc/passwd', 'https://user:secret@example.test', 'https://example.test/?key=secret', 'not a url'])('rejects unsafe or malformed endpoint %s', (customBaseUrl) => {
    expect(() => aiBaseUrl({ ...settings, provider: 'custom', customBaseUrl })).toThrow()
  })

  it('does not expose provider error bodies or credentials', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ error: 'test-key reflected by server' }, 401))
    await expect(discoverModels(settings)).rejects.toMatchObject({ code: 'http', status: 401, message: 'http' })
  })

  it('distinguishes empty lists from malformed responses', () => {
    expect(parseModels('custom', { data: [] })).toEqual([])
    expect(() => parseModels('custom', {})).toThrow()
    expect(() => parseModels('custom', { data: new Array(5001) })).toThrow()
    expect(parseModels('custom', { data: [{ id: 'bad\nmodel' }, null] })).toEqual([])
  })

  it('times out and propagates caller cancellation', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const timed = expect(discoverModels(settings)).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(15000)
    await timed
    const controller = new AbortController()
    const cancelled = expect(discoverModels(settings, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await cancelled
  })

  it('isolates caches by provider, endpoint and account without storing keys', async () => {
    const key = await modelCacheKey(settings)
    expect(key).not.toContain('test-key')
    expect(await modelCacheKey({ ...settings, apiKey: 'other-key' })).not.toBe(key)
    expect(await modelCacheKey({ ...settings, provider: 'anthropic' })).not.toBe(key)
    const custom = { ...settings, provider: 'custom' as const, customBaseUrl: 'https://one.test/v1' }
    expect(await modelCacheKey(custom)).not.toBe(await modelCacheKey({ ...custom, customBaseUrl: 'https://two.test/v1' }))
    const catalog = { models: [{ id: 'x', name: 'X' }], fetchedAt: Date.now() }
    expect(saveModelCache(key, catalog)).toBe(true)
    expect(loadModelCache(key)).toEqual(catalog)
    expect(localStorage.getItem(key)).not.toContain('test-key')
    localStorage.setItem(key, 'corrupt')
    expect(loadModelCache(key)).toBeNull()
  })

  it('keeps legacy settings and restores each provider without sharing credentials', () => {
    const switched = switchAIProvider(settings, 'anthropic')
    expect(switched.apiKey).toBe('')
    const restored = switchAIProvider({ ...switched, apiKey: 'claude-key', model: 'chosen-claude' }, 'openai')
    expect(restored.apiKey).toBe('test-key')
    expect(restored.model).toBe(settings.model)
    expect(switchAIProvider(restored, 'anthropic')).toMatchObject({ apiKey: 'claude-key', model: 'chosen-claude' })
  })

  it('uses the modern OpenAI output-token parameter without changing third-party adapters', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('data: [DONE]\n\n'))
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    await streamAICommand(settings, 'list files', '', callbacks)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({ max_completion_tokens: 1024 })
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).not.toHaveProperty('max_tokens')
    await streamAICommand({ ...settings, provider: 'openrouter' }, 'list files', '', callbacks)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string)).toMatchObject({ max_tokens: 1024 })
  })
})
