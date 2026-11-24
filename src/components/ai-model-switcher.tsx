import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Check, ChevronDown, Plus, RefreshCw, Search, Star } from 'lucide-react'
import { AI_CLI_BACKENDS, AI_PROVIDERS, isAIConfigured, switchAIProvider, type AIProviderId, type AIReasoningEffort, type AISettings } from '@/lib/ai'
import { CLI_BACKEND_LABELS, CLI_MODEL_PRESETS, currentModelTarget, withEffort, withModel } from '@/lib/ai-conversation'
import { MODEL_CACHE_TTL, canDiscoverModels, discoverModels, loadModelCache, modelCacheKey, saveModelCache, type AIModel } from '@/lib/ai-models'
import { useT } from '@/lib/i18n'
import { aiAssistantCopy, fillCopy } from '@/lib/locales/ai-assistant'
import { openSettingsCategory } from '@/lib/settings-request'
import { cn } from '@/lib/utils'
import { inferModelBrand, type AIBrandId } from '@/lib/ai-brand'
import { AIProviderLogo } from './ai-provider-logo'

type Choice = { key: string; label: string; brand: AIBrandId; apply: (settings: AISettings) => AISettings }

const EFFORT_LEVELS: readonly AIReasoningEffort[] = ['', 'low', 'medium', 'high']
const FAVORITE_MODELS_KEY = 'shellbeam.aiFavoriteModels'

const EMPTY_FAVORITES: Record<string, string[]> = {}
let cachedFavoritesRaw: string | null | undefined = undefined
let cachedFavoritesValue: Record<string, string[]> = EMPTY_FAVORITES
const favoriteListeners = new Set<() => void>()

function parseFavorites(raw: string | null): Record<string, string[]> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((item): item is string => typeof item === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function getFavoritesSnapshot(): Record<string, string[]> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(FAVORITE_MODELS_KEY)
  } catch {
    return cachedFavoritesValue
  }
  if (raw !== cachedFavoritesRaw) {
    cachedFavoritesRaw = raw
    cachedFavoritesValue = parseFavorites(raw)
  }
  return cachedFavoritesValue
}

function subscribeFavorites(listener: () => void): () => void {
  favoriteListeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === FAVORITE_MODELS_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    favoriteListeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

function updateFavorites(updater: (prev: Record<string, string[]>) => Record<string, string[]>) {
  const prev = getFavoritesSnapshot()
  const next = updater(prev)
  const serialized = JSON.stringify(next)
  cachedFavoritesRaw = serialized
  cachedFavoritesValue = next
  try {
    localStorage.setItem(FAVORITE_MODELS_KEY, serialized)
  } catch {
    // Storage unavailable; keep in-memory favorites synced across mounted instances.
  }
  favoriteListeners.forEach((listener) => listener())
}

function backendChoices(settings: AISettings): Choice[] {
  const choices: Choice[] = AI_CLI_BACKENDS.map((backend) => ({
    key: backend,
    label: CLI_BACKEND_LABELS[backend],
    brand: backend,
    apply: (s: AISettings) => ({ ...s, backend }),
  }))
  for (const provider of AI_PROVIDERS) {
    const apply = (s: AISettings): AISettings => ({ ...switchAIProvider(s, provider.id as AIProviderId), backend: 'api' })
    // Only providers that already have a key or endpoint; setting one up belongs in Settings.
    if (isAIConfigured(apply(settings))) choices.push({ key: `api:${provider.id}`, label: `${provider.name} · API`, brand: provider.id, apply })
  }
  return choices
}

/** Agent-style model picker: switches provider/backend, model (with search & pins), and reasoning effort in place. */
export function AIModelSwitcher({ settings, reportedModel, onChange, disabled, placement = 'bottom', compact = false }: {
  settings: AISettings
  /** The model a CLI said it used for the last reply, shown when no explicit model is set. */
  reportedModel?: string
  onChange: (settings: AISettings) => void
  disabled?: boolean
  /** Where the popover opens relative to the trigger or composer container. */
  placement?: 'top' | 'bottom'
  /** Compact pill sizing for the composer bottom toolbar. */
  compact?: boolean
}) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const [query, setQuery] = useState('')
  const favoritesByBucket = useSyncExternalStore(subscribeFavorites, getFavoritesSnapshot, () => EMPTY_FAVORITES)
  const [discovered, setDiscovered] = useState<AIModel[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const customComposingRef = useRef(false)
  const refreshAbort = useRef<AbortController | null>(null)
  const target = currentModelTarget(settings)
  const activeKey = target.backend === 'api' ? `api:${settings.provider}` : target.backend
  const activeBrand: AIBrandId = target.backend === 'api' ? settings.provider : target.backend
  const triggerBrand = inferModelBrand(target.model || reportedModel || '', activeBrand)
  const modelLabel = target.model || (target.backend === 'api' ? copy.defaultModel : reportedModel || copy.cliDefault)
  const supportsEffort = target.backend === 'claude-code'
    || target.backend === 'codex-cli'
    || target.backend === 'opencode-cli'
    || (target.backend === 'api' && settings.provider === 'openai' && /^(o\d|gpt-[5-9])/i.test(target.model))
    || (target.backend === 'api' && settings.provider === 'gemini' && /^gemini-(2\.5|[3-9])/i.test(target.model))

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  // Load cached discovered models for the active API provider whenever the popover opens or provider changes,
  // and silently refresh from the provider's /models endpoint when the cache is absent or expired.
  useEffect(() => {
    if (!open || target.backend !== 'api') {
      setDiscovered(null)
      setRefreshError('')
      setRefreshing(false)
      return
    }
    let active = true
    const ac = new AbortController()
    refreshAbort.current?.abort()
    refreshAbort.current = ac
    setRefreshError('')
    setRefreshing(false)
    void modelCacheKey(settings).then(async (key) => {
      if (!active) return
      const cached = loadModelCache(key)
      setDiscovered(cached?.models ?? null)
      const isFresh = Boolean(cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL)
      if (isFresh || !canDiscoverModels(settings)) {
        if (refreshAbort.current === ac) setRefreshing(false)
        return
      }
      setRefreshing(true)
      try {
        const catalog = await discoverModels(settings, ac.signal)
        if (!active || ac.signal.aborted) return
        setDiscovered(catalog.models)
        saveModelCache(key, catalog)
      } catch {
        // Silent background refresh fallback: keep showing curated presets without alarming offline users.
      } finally {
        if (active && refreshAbort.current === ac) setRefreshing(false)
      }
    }).catch(() => {
      if (active) {
        setDiscovered(null)
        if (refreshAbort.current === ac) setRefreshing(false)
      }
    })
    return () => { active = false; ac.abort() }
  }, [open, target.backend, settings])

  const handleRefreshModels = async () => {
    if (target.backend !== 'api') return
    refreshAbort.current?.abort()
    const ac = new AbortController()
    refreshAbort.current = ac
    setRefreshing(true)
    setRefreshError('')
    try {
      const catalog = await discoverModels(settings, ac.signal)
      if (ac.signal.aborted) return
      setDiscovered(catalog.models)
      try {
        const key = await modelCacheKey(settings)
        saveModelCache(key, catalog)
      } catch { /* cache write best effort */ }
    } catch {
      if (!ac.signal.aborted) setRefreshError('Failed to fetch models')
    } finally {
      if (refreshAbort.current === ac) setRefreshing(false)
    }
  }

  const bucketFavorites = useMemo(
    () => favoritesByBucket[target.bucketKey] ?? [],
    [favoritesByBucket, target.bucketKey],
  )
  const favoriteSet = useMemo(() => new Set(bucketFavorites), [bucketFavorites])

  const toggleFavorite = (model: string) => {
    updateFavorites((prev) => {
      const existing = prev[target.bucketKey] ?? []
      const nextBucket = existing.includes(model)
        ? existing.filter((item) => item !== model)
        : [model, ...existing].slice(0, 12)
      return { ...prev, [target.bucketKey]: nextBucket }
    })
  }

  const allModels = useMemo(() => {
    const presets = target.backend === 'api'
      ? (discovered?.length ? discovered.map((m) => m.id) : (AI_PROVIDERS.find((provider) => provider.id === settings.provider)?.models ?? []))
      : CLI_MODEL_PRESETS[target.backend]
    const recent = settings.recentModels?.[target.bucketKey] ?? []
    const ordered: string[] = []
    const push = (id: string) => { if (!ordered.includes(id)) ordered.push(id) }
    for (const id of bucketFavorites) push(id)
    if (target.backend !== 'api') push('')
    if (target.model) push(target.model)
    for (const id of recent) push(id)
    for (const id of presets) push(id)
    return ordered
  }, [target.backend, target.model, target.bucketKey, bucketFavorites, discovered, settings.provider, settings.recentModels])

  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return allModels
    return allModels.filter((m) => (m || copy.cliDefault).toLowerCase().includes(needle))
  }, [allModels, query, copy.cliDefault])

  const applyCustom = () => {
    const value = custom.trim()
    if (value) {
      onChange(withModel(settings, value))
      setCustom('')
    }
  }

  const choices = useMemo(() => backendChoices(settings), [settings])

  return (
    // When opening upward inside the composer, omit `relative` so the wide multi-pane picker anchors cleanly to the composer width.
    <div ref={root} className={cn('min-w-0', placement === 'bottom' && 'relative')}>
      <button type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} title={copy.modelMenu}
        data-testid="ai-model-switcher" onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex min-w-0 max-w-full items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)]/70 text-[var(--workspace-text)] transition-colors hover:border-[color:var(--workspace-border-strong)] disabled:opacity-50',
          compact ? 'h-6 px-1.5 text-[11px]' : 'h-7 px-2 text-xs',
        )}>
        <AIProviderLogo brand={triggerBrand} className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        <span className="shrink-0 font-medium text-[var(--workspace-text-strong)]">{target.providerName}</span>
        <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--workspace-text-muted)]">{modelLabel}</span>
        {supportsEffort && target.effort && (
          <span className="shrink-0 rounded bg-[var(--workspace-accent-subtle)] px-1 py-0.5 text-[9.5px] font-medium text-[var(--workspace-accent-text)]">
            {copy.effortLabels[target.effort]}
          </span>
        )}
        <ChevronDown className={cn('h-3 w-3 shrink-0 text-[var(--workspace-text-subtle)] transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label={copy.modelMenu}
          className={cn(
            'absolute right-0 z-40 w-[min(476px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] text-xs shadow-[var(--workspace-shadow-overlay)]',
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-1',
          )}>
          <div className="flex h-[320px]">
            {/* Left rail: CLI backends & configured API providers */}
            <div className="flex w-[124px] shrink-0 flex-col border-r border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/60 p-1.5">
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--workspace-text-subtle)]">{copy.backend}</p>
              <div className="flex-1 space-y-0.5 overflow-y-auto">
                {choices.map((choice) => {
                  const active = choice.key === activeKey
                  return (
                    <button key={choice.key} type="button" role="menuitemradio" aria-checked={active}
                      onClick={() => { setQuery(''); onChange(choice.apply(settings)) }}
                      className={cn(
                        'relative flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors',
                        active
                          ? 'bg-[var(--workspace-accent-subtle)] font-medium text-[var(--workspace-text-strong)]'
                          : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
                      )}>
                      {active && <span aria-hidden="true" className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--workspace-primary-500)]" />}
                      <AIProviderLogo brand={choice.brand} className="h-3.5 w-3.5" />
                      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                    </button>
                  )
                })}
              </div>
              <button
                type="button"
                data-testid="ai-add-api-provider"
                onClick={() => { setOpen(false); openSettingsCategory('integrations') }}
                className="mt-1.5 flex w-full shrink-0 items-center gap-1.5 rounded-md border border-dashed border-[color:var(--workspace-border-soft)] px-2 py-1.5 text-left text-[11px] text-[var(--workspace-text-muted)] transition-colors hover:border-[color:var(--workspace-border-strong)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]"
              >
                <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{copy.addApiProvider}</span>
              </button>
            </div>

            {/* Middle pane: search + model list + custom model */}
            <div className="flex min-w-0 flex-1 flex-col p-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--workspace-text-subtle)]" aria-hidden="true" />
                  <input
                    ref={searchInputRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={copy.searchModels}
                    aria-label={copy.searchModels}
                    className="h-7 w-full rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] pl-6 pr-2 font-mono text-[11px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)]"
                  />
                </div>
                {target.backend === 'api' && (
                  <button type="button" disabled={refreshing} onClick={() => void handleRefreshModels()}
                    data-testid="ai-model-refresh"
                    aria-label={refreshing ? copy.refreshingModels : copy.refreshModels}
                    title={refreshing ? copy.refreshingModels : copy.refreshModels}
                    className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] px-2 text-[10.5px] text-[var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-surface-800)] disabled:opacity-50">
                    <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} aria-hidden="true" />
                    <span className="sr-only">{refreshing ? copy.refreshingModels : copy.refreshModels}</span>
                  </button>
                )}
              </div>

              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-2">
                {filteredModels.length === 0 ? (
                  <p className="px-2 py-4 text-center text-[11px] text-[var(--workspace-text-subtle)]">{copy.noMatchingModels}</p>
                ) : filteredModels.map((model) => {
                  const active = model === target.model
                  const starred = favoriteSet.has(model)
                  const label = model || (target.backend === 'api' ? copy.defaultModel : copy.cliDefault)
                  const rowBrand = inferModelBrand(model, activeBrand)
                  return (
                    <div key={model || 'default'}
                      className={cn(
                        'group flex items-center gap-1 rounded-md px-1.5 transition-colors',
                        active ? 'bg-[var(--workspace-accent-subtle)]' : 'hover:bg-[var(--workspace-surface-800)]',
                      )}>
                      <button type="button" aria-pressed={active}
                        onClick={() => onChange(withModel(settings, model))}
                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left font-mono text-[11.5px]">
                        <AIProviderLogo brand={rowBrand} className="h-3.5 w-3.5 opacity-90" />
                        <span className={cn('min-w-0 flex-1 truncate', active ? 'font-medium text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text)]')}>
                          {label}
                        </span>
                        {active && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" aria-hidden="true" />}
                      </button>
                      {model && (
                        <button type="button"
                          aria-label={starred ? copy.unstarModel : copy.starModel}
                          title={starred ? copy.unstarModel : copy.starModel}
                          onClick={(event) => { event.stopPropagation(); toggleFavorite(model) }}
                          className={cn(
                            'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity',
                            starred
                              ? 'text-amber-400 opacity-100'
                              : 'text-[var(--workspace-text-subtle)] opacity-0 hover:text-[var(--workspace-text-strong)] group-hover:opacity-100 focus-visible:opacity-100',
                          )}>
                          <Star className={cn('h-3 w-3', starred && 'fill-current')} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              {refreshError && <p className="pt-1 text-[11px] text-[var(--workspace-status-bad-text)]">{refreshError}</p>}

              <div className="mt-2 flex gap-1.5 border-t border-[color:var(--workspace-border-soft)] pt-2">
                <input value={custom} onChange={(event) => setCustom(event.target.value)} spellCheck={false}
                  onCompositionStart={() => { customComposingRef.current = true }}
                  onCompositionEnd={() => { customComposingRef.current = false }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229 || customComposingRef.current) return
                    if (event.key === 'Enter') { event.preventDefault(); applyCustom() }
                  }}
                  placeholder={copy.customModel} aria-label={copy.customModel}
                  className="h-7 min-w-0 flex-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 font-mono text-[11px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)]" />
                <button type="button" disabled={!custom.trim()} onClick={applyCustom}
                  className="h-7 shrink-0 rounded-md bg-[var(--workspace-accent-subtle)] px-2.5 font-medium text-[var(--workspace-accent-text)] disabled:opacity-40">{copy.apply}</button>
              </div>
            </div>

            {/* Right pane: Reasoning Effort (kept fixed-width so switching providers never shifts layout) */}
            <div className="flex w-[112px] shrink-0 flex-col border-l border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/40 p-2">
              <p className="px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--workspace-text-subtle)]">{copy.reasoningEffort}</p>
              {supportsEffort ? (
                <div className="space-y-0.5">
                  {EFFORT_LEVELS.map((level) => {
                    const active = target.effort === level
                    return (
                      <button key={level || 'default'} type="button" aria-pressed={active}
                        onClick={() => onChange(withEffort(settings, level))}
                        className={cn(
                          'flex w-full items-center justify-between gap-1 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors',
                          active
                            ? 'bg-[var(--workspace-accent-subtle)] font-medium text-[var(--workspace-accent-text)]'
                            : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
                        )}>
                        <span className="truncate">{copy.effortLabels[level]}</span>
                        {active && <Check className="h-3 w-3 shrink-0 text-[var(--workspace-accent-text)]" aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="px-1.5 pt-1 text-[11px] leading-relaxed text-[var(--workspace-text-subtle)]">{copy.effortUnsupported}</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/50 px-3 py-1.5 text-[10.5px] text-[var(--workspace-text-subtle)]">
            <span>{copy.appliesNext}</span>
            {target.backend !== 'api' && !target.model && reportedModel && (
              <span className="font-mono text-[var(--workspace-text-muted)]">{fillCopy(copy.reportedModel, { model: reportedModel })}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
