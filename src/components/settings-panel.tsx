import { useState, useEffect } from 'react'
import { Settings, Sun, Moon, Monitor, Sparkles, Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { TERMINAL_THEMES, type TerminalPrefs } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import {
  AI_PROVIDERS,
  loadAISettings,
  saveAISettings,
  type AISettings,
} from '@/lib/ai'
import { Select } from '@/components/ui/select'
import { useT, LOCALE_OPTIONS } from '@/lib/i18n'

interface ReconnectSettings {
  enabled: boolean
  maxRetries: number
  intervalMs: number
}

interface SettingsPanelProps {
  vaultAutoLockMinutes: number
  reconnectSettings: ReconnectSettings
  defaultUsername: string
  keepAliveIntervalSecs: number
  theme: string
  onToggleTheme: () => void
  terminalPrefs: TerminalPrefs
  onTerminalPrefsChange: (prefs: Partial<TerminalPrefs>) => void
  onVaultAutoLockMinutesChange: (value: number) => void
  onReconnectSettingsChange: (next: Partial<ReconnectSettings>) => void
  onDefaultUsernameChange: (value: string) => void
  onKeepAliveIntervalSecsChange: (value: number) => void
}

export function SettingsPanel({
  vaultAutoLockMinutes,
  reconnectSettings,
  defaultUsername,
  keepAliveIntervalSecs,
  theme,
  onToggleTheme,
  terminalPrefs,
  onTerminalPrefsChange,
  onVaultAutoLockMinutesChange,
  onReconnectSettingsChange,
  onDefaultUsernameChange,
  onKeepAliveIntervalSecsChange,
}: SettingsPanelProps) {
  const { t, locale, setLocale } = useT()
  return (
    <div className="flex w-full flex-col">
      <div className="px-6 pb-4 pt-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Settings className="h-5 w-5" />
          {t('settings.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.desc')}</p>
      </div>
      <div className="space-y-4 px-6 pb-6">
        <section className="rounded-lg border p-4">
          <h3 className="mb-2 font-semibold">{t('settings.language')}</h3>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.languageDesc')}</span>
            </div>
            <div className="flex gap-2">
              {LOCALE_OPTIONS.map((opt) => (
                <button key={opt.value} type="button"
                  onClick={() => setLocale(opt.value)}
                  className={cn('rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                    locale === opt.value ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-foreground/30'
                  )}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-lg border p-4">
          <h3 className="mb-2 font-semibold">{t('settings.appearance')}</h3>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.theme')}</span>
              <p className="text-xs text-muted-foreground">{t('settings.themeToggle')}</p>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={onToggleTheme}>
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === 'dark' ? t('settings.light') : t('settings.dark')}
            </Button>
          </div>
        </section>

        <section className="rounded-lg border p-4">
          <h3 className="mb-3 flex items-center gap-2 font-semibold"><Monitor className="h-4 w-4" />{t('settings.terminal')}</h3>
          <div className="space-y-4">
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.fontSize')}</span>
              <Input type="number" min={10} max={24} value={terminalPrefs.fontSize}
                onChange={(e) => onTerminalPrefsChange({ fontSize: Number(e.target.value) || 13 })}
                className="mt-1 w-20" />
            </div>
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.fontFamily')}</span>
              <Select
                value={terminalPrefs.fontFamily}
                onChange={(v) => onTerminalPrefsChange({ fontFamily: v })}
                className="mt-1 max-w-xs"
                options={[
                  { value: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Courier New', monospace", label: 'JetBrains Mono' },
                  { value: "'Fira Code', 'SF Mono', Menlo, Monaco, monospace", label: 'Fira Code' },
                  { value: "'SF Mono', Menlo, Monaco, 'Courier New', monospace", label: 'SF Mono' },
                  { value: "Menlo, Monaco, 'Courier New', monospace", label: 'Menlo' },
                  { value: "'Cascadia Code', 'Fira Code', Menlo, monospace", label: 'Cascadia Code' },
                  { value: "'Source Code Pro', Menlo, Monaco, monospace", label: 'Source Code Pro' },
                ]}
              />
            </div>
            <div>
              <span className="mb-2 block text-sm text-muted-foreground">{t('settings.colorTheme')}</span>
              <TerminalThemeGrid
                currentThemeId={terminalPrefs.themeId}
                onSelect={(id) => onTerminalPrefsChange({ themeId: id })}
                columns="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border p-4">
          <h3 className="mb-2 font-semibold">{t('settings.general')}</h3>
          <div className="space-y-3">
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.defaultUser')}</span>
              <p className="text-xs text-muted-foreground mb-1">{t('settings.defaultUserDesc')}</p>
              <Input
                value={defaultUsername}
                onChange={(e) => onDefaultUsernameChange(e.target.value)}
                placeholder="root"
                className="w-full max-w-[200px]"
              />
            </div>
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.keepAlive')}</span>
              <p className="text-xs text-muted-foreground mb-1">{t('settings.keepAliveDesc')}</p>
              <Input
                type="number"
                min={10}
                max={300}
                value={keepAliveIntervalSecs}
                onChange={(e) => onKeepAliveIntervalSecsChange(Number(e.target.value) || 30)}
                className="w-20"
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border p-4">
          <h3 className="mb-2 font-semibold">{t('settings.vault')}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('settings.autoLock')}</span>
            <Input
              type="number"
              min={1}
              max={120}
              value={vaultAutoLockMinutes}
              onChange={(e) => onVaultAutoLockMinutesChange(Number(e.target.value) || 10)}
              className="w-20"
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.autoLockDesc')}
          </p>
        </section>

        <section className="rounded-lg border p-4">
          <h3 className="mb-2 font-semibold">{t('settings.reconnect')}</h3>
          <div className="space-y-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={reconnectSettings.enabled}
                onChange={(e) => onReconnectSettingsChange({ enabled: e.target.checked })}
                className="rounded"
              />
              <span className="text-sm">{t('settings.autoReconnect')}</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('settings.maxRetries')}</span>
              <Input
                type="number"
                min={0}
                max={10}
                value={reconnectSettings.maxRetries}
                onChange={(e) =>
                  onReconnectSettingsChange({ maxRetries: Number(e.target.value) || 0 })
                }
                className="w-16"
              />
              <span className="text-sm text-muted-foreground">{t('settings.interval')}</span>
              <Input
                type="number"
                min={500}
                max={15000}
                step={500}
                value={reconnectSettings.intervalMs}
                onChange={(e) =>
                  onReconnectSettingsChange({ intervalMs: Number(e.target.value) || 1500 })
                }
                className="w-24"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.reconnectDesc')}
            </p>
          </div>
        </section>

        <AISettingsSection />
      </div>
    </div>
  )
}

function AISettingsSection() {
  const [settings, setSettings] = useState<AISettings>(loadAISettings)
  const [showKey, setShowKey] = useState(false)
  const { t } = useT()

  useEffect(() => { saveAISettings(settings) }, [settings])

  const providerDef = AI_PROVIDERS.find((p) => p.id === settings.provider)
  const isOllama = settings.provider === 'ollama'
  const isCustom = settings.provider === 'custom'

  return (
    <section className="rounded-lg border p-4">
      <h3 className="mb-3 flex items-center gap-2 font-semibold">
        <Sparkles className="h-4 w-4 text-violet-500" />
        {t('settings.ai')}
      </h3>
      <div className="space-y-4">
        <div>
          <span className="text-sm text-muted-foreground">{t('settings.provider')}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {AI_PROVIDERS.map((p) => (
              <button key={p.id} type="button"
                onClick={() => setSettings((s) => ({
                  ...s,
                  provider: p.id,
                  model: p.id === s.provider ? s.model : p.defaultModel,
                }))}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  settings.provider === p.id
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:border-foreground/30',
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {!isOllama && !isCustom && (
          <div>
            <span className="text-sm text-muted-foreground">{t('settings.apiKey')}</span>
            <div className="relative mt-1">
              <Input
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder={`Enter your ${providerDef?.name ?? ''} API key`}
                className="pr-10"
              />
              <button type="button" onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        {isCustom && (
          <div>
            <span className="text-sm text-muted-foreground">{t('settings.baseUrl')}</span>
            <Input
              value={settings.customBaseUrl}
              onChange={(e) => setSettings((s) => ({ ...s, customBaseUrl: e.target.value }))}
              placeholder="https://your-llm-endpoint.com/v1"
              className="mt-1"
            />
          </div>
        )}

        <div>
          <span className="text-sm text-muted-foreground">{t('settings.model')}</span>
          {isCustom || isOllama ? (
            <Input
              value={isCustom ? settings.customModel : settings.model}
              onChange={(e) => isCustom
                ? setSettings((s) => ({ ...s, customModel: e.target.value }))
                : setSettings((s) => ({ ...s, model: e.target.value }))
              }
              placeholder={isOllama ? 'e.g. llama3, qwen2, mistral...' : 'model-name'}
              className="mt-1 w-full max-w-xs"
            />
          ) : (
            <Select
              value={settings.model}
              onChange={(v) => setSettings((s) => ({ ...s, model: v }))}
              className="mt-1 max-w-xs"
              options={(providerDef?.models ?? []).map((m) => ({ value: m, label: m }))}
            />
          )}
        </div>

        {isCustom && (
          <div>
            <span className="text-sm text-muted-foreground">{t('settings.apiKeyOptional')}</span>
            <div className="relative mt-1">
              <Input
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder="Bearer token (if required)"
                className="pr-10"
              />
              <button type="button" onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {isOllama
            ? t('settings.ollamaHelper')
            : isCustom
              ? t('settings.customHelper')
              : t('settings.apiKeyHelper')}
        </p>
      </div>
    </section>
  )
}

export function FontSizeControl({ value, onChange }: {
  value: number
  onChange: (size: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(Math.max(10, value - 1))}
        className="flex h-7 w-7 items-center justify-center rounded border text-sm hover:bg-muted"
      >−</button>
      <span className="w-8 text-center text-sm font-medium">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(24, value + 1))}
        className="flex h-7 w-7 items-center justify-center rounded border text-sm hover:bg-muted"
      >+</button>
    </div>
  )
}

export function TerminalThemeGrid({ currentThemeId, onSelect, columns }: {
  currentThemeId: string
  onSelect: (themeId: string) => void
  columns?: string
}) {
  return (
    <div className={columns ?? 'space-y-1.5'}>
      {TERMINAL_THEMES.map((thm) => (
        <button
          key={thm.id}
          type="button"
          onClick={() => onSelect(thm.id)}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-all',
            currentThemeId === thm.id
              ? 'border-primary ring-1 ring-primary'
              : 'border-border/50 hover:border-foreground/30',
          )}
        >
          <div
            className="flex h-8 w-14 shrink-0 items-center justify-center rounded"
            style={{ background: thm.theme.background }}
          >
            <span style={{ color: thm.theme.foreground, fontSize: 10, fontFamily: 'monospace' }}>Aa</span>
          </div>
          <span className="truncate text-xs font-medium">{thm.name}</span>
        </button>
      ))}
    </div>
  )
}
