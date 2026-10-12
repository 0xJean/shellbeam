import { AI_PROVIDERS, type AIProviderId, type AISettings } from './ai'

export interface AIModel { id: string; name: string }
export interface AIModelCatalog { models: AIModel[]; fetchedAt: number }
export const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000
const MAX_MODELS = 5000

export class ModelDiscoveryError extends Error {
  code: 'credentials' | 'endpoint' | 'http' | 'invalid' | 'timeout' | 'network'
  status?: number
  constructor(code: ModelDiscoveryError['code'], status?: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

export function aiBaseUrl(settings: AISettings): string {
  const base = settings.provider === 'custom' ? settings.customBaseUrl : AI_PROVIDERS.find((p) => p.id === settings.provider)?.baseUrl
  try {
    const url = new URL(base?.trim() ?? '')
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    return url.href.replace(/\/$/, '')
  } catch { throw new ModelDiscoveryError('endpoint') }
}

export function openAIEndpoint(base: string, resource: string): string {
  const normalized = base.replace(/\/+$/, '')
  return `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}/${resource}`
}

// Scope the cache to the account and endpoint without persisting credentials in it.
export async function modelCacheKey(settings: AISettings): Promise<string> {
  const identity = JSON.stringify([settings.provider, aiBaseUrl(settings), settings.provider === 'ollama' ? '' : settings.apiKey.trim()])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  return `shellbeam.aiModels.v1.${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textField(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    && Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
}

export function loadModelCache(key: string): AIModelCatalog | null {
  try {
    const data = record(JSON.parse(localStorage.getItem(key) ?? 'null'))
    if (typeof data.fetchedAt !== 'number' || !Number.isFinite(data.fetchedAt) || data.fetchedAt <= 0 || data.fetchedAt > Date.now() + 60000 || !Array.isArray(data.models) || data.models.length > MAX_MODELS) return null
    if (!data.models.every((model) => textField(record(model).id) && textField(record(model).name))) return null
    return data as unknown as AIModelCatalog
  } catch { return null }
}

export function saveModelCache(key: string, catalog: AIModelCatalog): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(catalog))
    return true
  } catch { return false }
}

export function parseModels(provider: AIProviderId, payload: unknown): AIModel[] {
  const entries = record(payload)[provider === 'ollama' ? 'models' : 'data']
  if (!Array.isArray(entries) || entries.length > MAX_MODELS) throw new ModelDiscoveryError('invalid')
  const models = new Map<string, AIModel>()
  for (const entry of entries) {
    const item = record(entry)
    const id = provider === 'ollama' ? item.name ?? item.model : item.id
    if (!textField(id)) continue
    // The OpenAI list includes non-chat products; this is a conservative suggestion
    // filter, not a claim of entitlement or endpoint compatibility. Manual IDs remain possible.
    if (provider === 'openai' && (!/^(gpt-|chatgpt-|o\d|ft:(gpt-|o\d))/.test(id) || /embedding|moderation|realtime|audio|transcribe|tts|image|search|deep-research|codex/i.test(id))) continue
    if (provider === 'openrouter') {
      const architecture = record(item.architecture)
      if (Array.isArray(architecture.output_modalities) && !architecture.output_modalities.includes('text')) continue
      if (Array.isArray(architecture.input_modalities) && !architecture.input_modalities.includes('text')) continue
    }
    const label = item.display_name ?? item.name
    models.set(id, { id, name: textField(label) ? label : id })
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function discoverModels(settings: AISettings, signal?: AbortSignal): Promise<AIModelCatalog> {
  const base = aiBaseUrl(settings)
  const key = settings.apiKey.trim()
  if (['openai', 'anthropic'].includes(settings.provider) && !key) throw new ModelDiscoveryError('credentials')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (settings.provider === 'anthropic') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (settings.provider !== 'ollama' && key) headers.Authorization = `Bearer ${key}`
  const endpoint = settings.provider === 'ollama' ? `${base}/api/tags` : openAIEndpoint(base, 'models')
  const models = new Map<string, AIModel>()
  const cursors = new Set<string>()
  let cursor = ''
  try {
    for (let page = 0; page < 20; page++) {
      const url = new URL(endpoint)
      if (settings.provider === 'anthropic') {
        url.searchParams.set('limit', '100')
        if (cursor) url.searchParams.set('after_id', cursor)
      }
      const response = await fetch(url.href, { headers, signal: controller.signal, redirect: 'error', credentials: 'omit' })
      if (!response.ok) throw new ModelDiscoveryError('http', response.status)
      const payload: unknown = await response.json().catch(() => { throw new ModelDiscoveryError('invalid') })
      for (const model of parseModels(settings.provider, payload)) models.set(model.id, model)
      if (models.size > MAX_MODELS) throw new ModelDiscoveryError('invalid')
      if (settings.provider !== 'anthropic' || record(payload).has_more !== true) {
        return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), fetchedAt: Date.now() }
      }
      const next = record(payload).last_id
      if (!textField(next) || cursors.has(next)) throw new ModelDiscoveryError('invalid')
      cursors.add(next)
      cursor = next
    }
    throw new ModelDiscoveryError('invalid')
  } catch (error) {
    if (signal?.aborted) throw error
    if (timedOut) throw new ModelDiscoveryError('timeout')
    if (error instanceof ModelDiscoveryError) throw error
    throw new ModelDiscoveryError('network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
