import { useEffect, useId, useRef, useState } from 'react'
import { Info, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { AI_PROVIDERS, type AISettings } from '@/lib/ai'
import { discoverModels, loadModelCache, modelCacheKey, MODEL_CACHE_TTL, ModelDiscoveryError, saveModelCache, type AIModelCatalog } from '@/lib/ai-models'
import { useT } from '@/lib/i18n'
import { aiMcpSettingsCopy } from '@/lib/locales/ai-mcp-settings-v3'
import { cn } from '@/lib/utils'

// Remounted by the parent when endpoint/account changes; late results cannot cross accounts.
export function AIModelPicker({ settings, onChange }: { settings: AISettings; onChange: (model: string) => void }) {
  const { t, locale } = useT()
  const copy = aiMcpSettingsCopy[locale]
  const id = useId()
  const [catalog, setCatalog] = useState<AIModelCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cacheWarning, setCacheWarning] = useState(false)
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const initialSettings = useRef(settings)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void modelCacheKey(initialSettings.current).then((key) => {
      if (!cancelled) setCatalog((current) => current ?? loadModelCache(key))
    }).catch(() => { /* A missing/invalid endpoint still permits manual model entry. */ })
    return () => { cancelled = true; mounted.current = false; request.current?.abort() }
  }, [])

  async function refresh() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    setCacheWarning(false)
    try {
      const result = await discoverModels(settings, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setCatalog(result)
      try {
        const key = await modelCacheKey(settings)
        if (mounted.current && !controller.signal.aborted) setCacheWarning(!saveModelCache(key, result))
      } catch { if (mounted.current && !controller.signal.aborted) setCacheWarning(true) }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        const failure = cause instanceof ModelDiscoveryError ? cause : new ModelDiscoveryError('network')
        setError(t(`settings.modelsError.${failure.code}`, { status: failure.status ?? '' }))
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) setBusy(false)
    }
  }

  const value = settings.provider === 'custom' ? settings.customModel : settings.model
  const models = catalog?.models ?? (AI_PROVIDERS.find((provider) => provider.id === settings.provider)?.models ?? []).map((model) => ({ id: model, name: model }))
  const options = models.map((model) => ({ value: model.id, label: model.name === model.id ? model.id : `${model.name} (${model.id})` }))
  if (value && !models.some((model) => model.id === value)) options.unshift({ value, label: value })

  const stale = catalog ? Date.now() - catalog.fetchedAt > MODEL_CACHE_TTL : false
  const chip = !catalog ? copy.chipFallback : stale ? copy.chipStale : copy.chipCached
  return (
    <div className="sb-card min-w-0">
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
        <h4 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{copy.modelCard}</h4>
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', !catalog ? 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]' : stale ? 'bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]' : 'bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]')}>{chip}</span>
      </div>
      <div className="space-y-3 p-4">
        <div>
          <p className="mb-1.5 text-xs font-medium text-[var(--workspace-text)]">{t('settings.availableModels')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-[1_1_12rem]"><Select value={value} onChange={onChange} options={options} placeholder={t('settings.modelPlaceholder')} /></div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
              {t(busy ? 'settings.modelsRefreshing' : 'settings.modelsRefresh')}
            </Button>
          </div>
        </div>
        <div>
          <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-[var(--workspace-text)]">{t('settings.model')}</label>
          <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={t('settings.modelPlaceholder')} spellCheck={false} className="font-mono" />
        </div>
        <p role="status" className="text-xs text-[var(--workspace-text-muted)]">
          {catalog ? t(stale ? 'settings.modelsStale' : 'settings.modelsCached', {
            count: catalog.models.length, time: new Date(catalog.fetchedAt).toLocaleString(),
          }) : t('settings.modelsFallback')}
        </p>
        {catalog && catalog.models.length === 0 && <p className="text-xs text-[var(--workspace-text-muted)]">{t('settings.modelsEmpty')}</p>}
        {catalog && value && !catalog.models.some((model) => model.id === value) && <p className="text-xs text-[var(--workspace-status-warn-text)]">{t('settings.modelNotListed')}</p>}
        {error && <p role="alert" className="text-xs text-[var(--workspace-status-bad-text)]">{error}</p>}
        {cacheWarning && <p role="alert" className="text-xs text-[var(--workspace-status-warn-text)]">{t('settings.modelsCacheFailed')}</p>}
        <p className="flex items-start gap-2 text-xs text-[var(--workspace-text-subtle)]"><Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('settings.modelsHelp')}</p>
      </div>
    </div>
  )
}
