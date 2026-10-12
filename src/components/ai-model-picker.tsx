import { useEffect, useId, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { AI_PROVIDERS, type AISettings } from '@/lib/ai'
import { discoverModels, loadModelCache, modelCacheKey, MODEL_CACHE_TTL, ModelDiscoveryError, saveModelCache, type AIModelCatalog } from '@/lib/ai-models'
import { useT } from '@/lib/i18n'

// Remounted by the parent when endpoint/account changes; late results cannot cross accounts.
export function AIModelPicker({ settings, onChange }: { settings: AISettings; onChange: (model: string) => void }) {
  const { t } = useT()
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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-sm text-muted-foreground">{t('settings.availableModels')}</p>
          <Select value={value} onChange={onChange} options={options} placeholder={t('settings.modelPlaceholder')} />
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {t(busy ? 'settings.modelsRefreshing' : 'settings.modelsRefresh')}
        </Button>
      </div>
      <label htmlFor={id} className="block text-sm text-muted-foreground">{t('settings.model')}</label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={t('settings.modelPlaceholder')} spellCheck={false} />
      <p className="text-xs text-muted-foreground">{t('settings.modelsHelp')}</p>
      <p role="status" className="text-xs text-muted-foreground">
        {catalog ? t(Date.now() - catalog.fetchedAt > MODEL_CACHE_TTL ? 'settings.modelsStale' : 'settings.modelsCached', {
          count: catalog.models.length, time: new Date(catalog.fetchedAt).toLocaleString(),
        }) : t('settings.modelsFallback')}
      </p>
      {catalog && catalog.models.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.modelsEmpty')}</p>}
      {catalog && value && !catalog.models.some((model) => model.id === value) && <p className="text-xs text-amber-600 dark:text-amber-400">{t('settings.modelNotListed')}</p>}
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {cacheWarning && <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">{t('settings.modelsCacheFailed')}</p>}
    </div>
  )
}
