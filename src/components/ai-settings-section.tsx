import { useEffect, useState, type ReactNode } from 'react'
import { Asterisk, Cloud, Cpu, Eye, EyeOff, Lock, Plug, Route, ShieldCheck, Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react'
import { AICliSettings } from '@/components/ai-cli-settings'
import { AIModelPicker } from '@/components/ai-model-picker'
import { Input } from '@/components/ui/input'
import { AI_PROVIDERS, loadAISettings, saveAISettings, switchAIProvider, type AIBackend, type AIProviderId, type AISettings } from '@/lib/ai'
import { useT } from '@/lib/i18n'
import { aiMcpSettingsCopy } from '@/lib/locales/ai-mcp-settings-v3'
import { cn } from '@/lib/utils'

const PROVIDER_ICONS: Record<AIProviderId, LucideIcon> = { openai: Sparkles, anthropic: Asterisk, openrouter: Route, ollama: Cpu, custom: Plug }
const BACKENDS = ['api', 'claude-code', 'codex-cli'] as const

const choiceCardClass = (active: boolean) => cn('rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  active ? 'border-[color:var(--workspace-primary-500)] bg-[var(--workspace-accent-subtle)]' : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] hover:border-[color:var(--workspace-border-strong)]')

export function AISettingsSection() {
  const [settings, setSettings] = useState<AISettings>(loadAISettings)
  const [showKey, setShowKey] = useState(false)
  const { t, locale } = useT()
  const copy = aiMcpSettingsCopy[locale]
  useEffect(() => { saveAISettings(settings) }, [settings])
  const providerDef = AI_PROVIDERS.find((p) => p.id === settings.provider)
  const isOllama = settings.provider === 'ollama'
  const isCustom = settings.provider === 'custom'
  const backend: AIBackend = settings.backend ?? 'api'

  const secret = (label: string, placeholder: string) => <div className="relative">
    <Lock aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
    <Input aria-label={label} type={showKey ? 'text' : 'password'} value={settings.apiKey}
      onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))} placeholder={placeholder} className="pl-8 pr-10 font-mono" />
    <button type="button" onClick={() => setShowKey((v) => !v)}
      aria-label={t(showKey ? 'settings.hideApiKey' : 'settings.showApiKey')}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-text-strong)]">
      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  </div>

  return (
    <section className="space-y-5" data-testid="ai-settings">
      <header>
        <h3 className="text-lg font-semibold text-[var(--workspace-text-strong)]">{t('settings.ai')}</h3>
        <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{copy.aiDesc}</p>
      </header>
      <div>
        <p className="mb-2 text-sm font-medium text-[var(--workspace-text)]">{t('ai.backend')}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {BACKENDS.map((item) => {
            const label = item === 'api' ? t('ai.backendApi') : item === 'claude-code' ? 'Claude Code' : 'Codex CLI'
            const Icon = item === 'api' ? Cloud : SquareTerminal
            return <button key={item} type="button" aria-label={label} aria-pressed={backend === item}
              onClick={() => { setShowKey(false); setSettings((s) => ({ ...s, backend: item })) }}
              className={cn(choiceCardClass(backend === item), 'flex min-w-0 items-center gap-3 px-3 py-3')}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]"><Icon aria-hidden className="h-4 w-4" /></span>
              <span className="min-w-0"><span className="block text-sm font-medium text-[var(--workspace-text-strong)]">{label}</span><span className="block truncate text-xs text-[var(--workspace-text-muted)]">{copy.backendDesc[item]}</span></span>
            </button>
          })}
        </div>
      </div>
      {settings.backend === 'claude-code' || settings.backend === 'codex-cli' ? (
        <AICliSettings key={settings.backend} backend={settings.backend}
          profile={settings.cliProfiles?.[settings.backend] ?? { executable: '', model: '' }}
          onChange={(profile) => setSettings((s) => ({ ...s, cliProfiles: { ...s.cliProfiles, [settings.backend!]: profile } }))} />
      ) : <>
        <div>
          <p className="mb-2 text-sm font-medium text-[var(--workspace-text)]">{t('settings.provider')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {AI_PROVIDERS.map((p) => {
              const Icon = PROVIDER_ICONS[p.id]
              const active = settings.provider === p.id
              return <button key={p.id} type="button" aria-pressed={active}
                onClick={() => { setShowKey(false); setSettings((s) => switchAIProvider(s, p.id)) }}
                className={cn(choiceCardClass(active), 'flex flex-col items-center gap-2 px-2 py-4')}>
                <span className={cn('flex h-8 w-8 items-center justify-center rounded-md', active ? 'bg-[var(--workspace-surface-800)] text-[var(--workspace-accent-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}><Icon aria-hidden className="h-4 w-4" /></span>
                <span className={cn('text-center text-xs', active ? 'font-semibold text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)]')}>{p.name}</span>
              </button>
            })}
          </div>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="sb-card divide-y divide-[color:var(--workspace-border-soft)]">
            {!isOllama && !isCustom && <SettingRow label={t('settings.apiKey')} hint={copy.apiKeyHint}>
              {secret(t('settings.apiKey'), t('settings.apiKeyPlaceholder', { provider: providerDef?.name ?? '' }))}
            </SettingRow>}
            {isCustom && <SettingRow label={t('settings.baseUrl')} hint={copy.baseUrlHint}>
              <Input aria-label={t('settings.baseUrl')} value={settings.customBaseUrl} className="font-mono"
                onChange={(e) => setSettings((s) => ({ ...s, customBaseUrl: e.target.value, apiKey: '' }))}
                placeholder="https://your-llm-endpoint.com/v1" />
            </SettingRow>}
            {isCustom && <SettingRow label={t('settings.apiKeyOptional')} hint={copy.customKeyHint}>
              {secret(t('settings.apiKeyOptional'), 'Bearer token (if required)')}
            </SettingRow>}
            <div className="space-y-2 p-4 text-xs text-[var(--workspace-text-muted)]">
              <p>{isOllama ? t('settings.ollamaHelper') : isCustom ? t('settings.customHelper') : t('settings.apiKeyHelper')}</p>
              <p className="flex items-start gap-2"><ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-status-good-text)]" /><span><span className="font-medium text-[var(--workspace-text)]">{copy.privacyTitle} · </span>{copy.privacy}</span></p>
            </div>
          </div>
          <AIModelPicker key={JSON.stringify([settings.provider, settings.apiKey, settings.customBaseUrl])}
            settings={settings} onChange={(model) => setSettings((s) => isCustom ? { ...s, customModel: model } : { ...s, model })} />
        </div>
      </>}
    </section>
  )
}

function SettingRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-center">
    <div className="min-w-0"><p className="text-sm font-medium text-[var(--workspace-text-strong)]">{label}</p><p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{hint}</p></div>
    <div className="min-w-0">{children}</div>
  </div>
}
