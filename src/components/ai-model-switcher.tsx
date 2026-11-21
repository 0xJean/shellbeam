import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, RefreshCw, Search } from 'lucide-react'
import { AI_CLI_BACKENDS, AI_PROVIDERS, isAIConfigured, switchAIProvider, type AIProviderId, type AIReasoningEffort, type AISettings } from '@/lib/ai'
import { CLI_BACKEND_LABELS, CLI_MODEL_PRESETS, currentModelTarget, withEffort, withModel } from '@/lib/ai-conversation'
import { discoverModels, loadModelCache, modelCacheKey, saveModelCache, type AIModel } from '@/lib/ai-models'
import { useT } from '@/lib/i18n'
import { aiAssistantCopy, fillCopy } from '@/lib/locales/ai-assistant'
import { cn } from '@/lib/utils'

type Choice = { key: string; label: string; apply: (settings: AISettings) => AISettings }

const EFFORT_LEVELS: readonly AIReasoningEffort[] = ['', 'low', 'medium', 'high']

function backendChoices(settings: AISettings): Choice[] {
  const choices: Choice[] = AI_CLI_BACKENDS.map((backend) => ({
    key: backend,
    label: CLI_BACKEND_LABELS[backend],
    apply: (s: AISettings) => ({ ...s, backend }),
  }))
  for (const provider of AI_PROVIDERS) {
    const apply = (s: AISettings): AISettings => ({ ...switchAIProvider(s, provider.id as AIProviderId), backend: 'api' })
    // Only providers that already have a key or endpoint; setting one up belongs in Settings.
    if (isAIConfigured(apply(settings))) choices.push({ key: `api:${provider.id}`, label: `${provider.name} · API`, apply })
  }
  return choices
}

/** Header control: shows what the next message will use and switches backend, model & reasoning effort in place. */
export function AIModelSwitcher({ settings, reportedModel, onChange, disabled }: {
  settings: AISettings
  /** The model a CLI said it used for the last reply, shown when no explicit model is set. */
  reportedModel?: string
  onChange: (settings: AISettings) => void
  disabled?: boolean
}) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const [query, setQuery] = useState('')
  const [discovered, setDiscovered] = useState<AIModel[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const refreshAbort = useRef<AbortController | null>(null)
  const target = currentModelTarget(settings)
  const activeKey = target.backend === 'api' ? `api:${settings.provider}` : target.backend
  const modelLabel = target.model || (target.backend === 'api' ? copy.defaultModel : reportedModel || copy.cliDefault)
  const supportsEffort = target.backend === 'claude-code'
    || target.backend === 'codex-cli'
    || target.backend === 'opencode-cli'
    || (target.backend === 'api' && settings.provider === 'openai' && /^(o\d|gpt-5)/i.test(target.model))

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  // Load cached discovered models for the active API provider whenever the popover opens or provider changes.
  useEffect(() => {
    if (!open || target.backend !== 'api') {
      setDiscovered(null)
      setRefreshError('')
      return
    }
    let active = true
    setRefreshError('')
    void modelCacheKey(settings).then((key) => {
      if (!active) return
      const cached = loadModelCache(key)
      setDiscovered(cached?.models ?? null)
    }).catch(() => {
      if (active) setDiscovered(null)
    })
    return () => { active = false; refreshAbort.current?.abort() }
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
      if (!ac.signal.aborted) setRefreshing(false)
    }
  }

  const allModels = useMemo(() => {
    const presets = target.backend === 'api'
      ? (discovered?.length ? discovered.map((m) => m.id) : (AI_PROVIDERS.find((provider) => provider.id === settings.provider)?.models ?? []))
      : CLI_MODEL_PRESETS[target.backend]
    const recent = settings.recentModels?.[target.bucketKey] ?? []
    const ordered: string[] = []
    const push = (id: string) => { if (!ordered.includes(id)) ordered.push(id) }
    if (target.backend !== 'api') push('')
    if (target.model) push(target.model)
    for (const id of recent) push(id)
    for (const id of presets) push(id)
    return ordered
  }, [target.backend, target.model, target.bucketKey, discovered, settings.provider, settings.recentModels])

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

  return (
    <div ref={root} className="relative min-w-0">
      <button type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} title={copy.modelMenu}
        data-testid="ai-model-switcher" onClick={() => setOpen((value) => !value)}
        className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 text-xs text-[var(--workspace-text)] transition-colors hover:border-[color:var(--workspace-border-strong)] disabled:opacity-50">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" aria-hidden="true" />
        <span className="shrink-0 font-medium text-[var(--workspace-text-strong)]">{target.providerName}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{modelLabel}</span>
        {supportsEffort && target.effort && (
          <span className="shrink-0 rounded bg-[var(--workspace-accent-subtle)] px-1 py-0.5 text-[9.5px] font-medium text-[var(--workspace-accent-text)]">
            {copy.effortLabels[target.effort]}
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-[var(--workspace-text-subtle)]" aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label={copy.modelMenu}
          className="absolute right-0 top-full z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1.5 text-xs shadow-[var(--workspace-shadow-overlay)]">
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--workspace-text-subtle)]">{copy.backend}</p>
          <div className="max-h-40 overflow-y-auto">
            {backendChoices(settings).map((choice) => (
              <button key={choice.key} type="button" role="menuitemradio" aria-checked={choice.key === activeKey}
                onClick={() => { setQuery(''); onChange(choice.apply(settings)) }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]">
                <Check className={cn('h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]', choice.key !== activeKey && 'invisible')} aria-hidden="true" />
                <span className="truncate">{choice.label}</span>
              </button>
            ))}
          </div>
          <div className="my-1.5 border-t border-[color:var(--workspace-border-soft)]" />
          <div className="flex items-center justify-between gap-2 px-2 pb-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--workspace-text-subtle)]">{copy.model}</p>
            {target.backend === 'api' && (
              <button type="button" disabled={refreshing} onClick={() => void handleRefreshModels()}
                data-testid="ai-model-refresh"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--workspace-accent-text)] hover:bg-[var(--workspace-surface-800)] disabled:opacity-50">
                <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} aria-hidden="true" />
                {refreshing ? copy.refreshingModels : copy.refreshModels}
              </button>
            )}
          </div>
          {allModels.length > 6 && (
            <div className="relative mb-1.5 px-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--workspace-text-subtle)]" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={copy.searchModels}
                aria-label={copy.searchModels}
                className="h-7 w-full rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] pl-6 pr-2 font-mono text-[11px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)]"
              />
            </div>
          )}
          <div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto px-2">
            {filteredModels.map((model) => {
              const active = model === target.model
              return (
                <button key={model || 'default'} type="button" aria-pressed={active} onClick={() => onChange(withModel(settings, model))}
                  className={cn('max-w-full truncate rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                    active ? 'border-[color:var(--workspace-primary-500)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]'
                      : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text)] hover:border-[color:var(--workspace-border-strong)]')}>
                  {model || (target.backend === 'api' ? copy.defaultModel : copy.cliDefault)}
                </button>
              )
            })}
          </div>
          {refreshError && <p className="px-2 pt-1 text-[11px] text-[var(--workspace-status-bad-text)]">{refreshError}</p>}
          <div className="mt-2 flex gap-1.5 px-2">
            <input value={custom} onChange={(event) => setCustom(event.target.value)} spellCheck={false}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyCustom() } }}
              placeholder={copy.customModel} aria-label={copy.customModel}
              className="h-7 min-w-0 flex-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 font-mono text-[11px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)]" />
            <button type="button" disabled={!custom.trim()} onClick={applyCustom}
              className="h-7 shrink-0 rounded-md bg-[var(--workspace-accent-subtle)] px-2.5 font-medium text-[var(--workspace-accent-text)] disabled:opacity-40">{copy.apply}</button>
          </div>
          {supportsEffort && (
            <>
              <div className="my-1.5 border-t border-[color:var(--workspace-border-soft)]" />
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <span className="text-[11px] font-medium text-[var(--workspace-text-subtle)]">{copy.reasoningEffort}</span>
                <div className="flex gap-1">
                  {EFFORT_LEVELS.map((level) => {
                    const active = target.effort === level
                    return (
                      <button key={level || 'default'} type="button" aria-pressed={active}
                        onClick={() => onChange(withEffort(settings, level))}
                        className={cn('rounded border px-1.5 py-0.5 text-[10.5px] transition-colors',
                          active
                            ? 'border-[color:var(--workspace-primary-500)] bg-[var(--workspace-accent-subtle)] font-medium text-[var(--workspace-accent-text)]'
                            : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text-muted)] hover:border-[color:var(--workspace-border-strong)]')}>
                        {copy.effortLabels[level]}
                      </button>
                    )
                  })}
                </div>
              </div>
            </>
          )}
          {target.backend !== 'api' && !target.model && reportedModel && (
            <p className="px-2 pt-2 text-[11px] text-[var(--workspace-text-muted)]">{fillCopy(copy.reportedModel, { model: reportedModel })}</p>
          )}
          <p className="px-2 pb-1 pt-2 text-[11px] leading-relaxed text-[var(--workspace-text-subtle)]">{copy.appliesNext}</p>
        </div>
      )}
    </div>
  )
}
