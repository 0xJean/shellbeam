import { AICliSettings } from './ai-cli-settings'
import { HostRuleSettingsSection } from './host-notification-rules-panel'
import { TerminalThemeGrid } from '@/components/terminal-widgets'
import { McpSettingsSection } from '@/components/mcp-settings-section'
import { KomariSettingsSection } from '@/components/komari-settings-section'
import { ShellbeamAgentReleaseSettingsSection } from '@/components/shellbeam-agent-release-settings-section'
import { NotificationSettingsSection } from '@/components/notification-settings-section'
import { ProbeRetrySettingsSection } from '@/components/probe-retry-settings-section'
import { AIModelPicker } from '@/components/ai-model-picker'
import { AppearancePicker } from '@/components/appearance-picker'
import { SecuritySettingsSection } from '@/components/security-settings-section'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useVault } from '@/contexts/vault-context'
import {
    AI_PROVIDERS,
    loadAISettings,
    saveAISettings,
    switchAIProvider,
    type AISettings,
} from '@/lib/ai'
import {
    biometryLabel,
    checkBiometricStatus,
    isBiometricEnabled,
    removeMasterPassword,
    retrieveMasterPassword,
    storeMasterPassword,
    type BiometricStatus,
} from '@/lib/biometric'
import { LOCALE_OPTIONS, useT } from '@/lib/i18n'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
import type { TerminalPrefs } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { useThemePreference, type ThemePreference } from '@/hooks/use-theme'
import { consumeSettingsCategoryRequest, SETTINGS_CATEGORY_REQUEST_EVENT, type SettingsCategory } from '@/lib/settings-request'
import { Activity, AlertTriangle, BookOpen, Eye, EyeOff, Fingerprint, Monitor, Moon, Plug, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Sun, TerminalSquare, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ReconnectSettings {
  enabled: boolean
  maxRetries: number
  intervalMs: number
}

interface SettingsPanelProps {
  onOpenGuide?: () => void
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

const SETTINGS_CATEGORIES = [
  ['general', SlidersHorizontal], ['connection', TerminalSquare], ['monitoring', Activity],
  ['integrations', Plug], ['security', ShieldCheck], ['advanced', Wrench],
] as const

export function SettingsPanel({
  onOpenGuide,
  vaultAutoLockMinutes,
  reconnectSettings,
  defaultUsername,
  keepAliveIntervalSecs,
  theme,
  terminalPrefs,
  onTerminalPrefsChange,
  onVaultAutoLockMinutesChange,
  onReconnectSettingsChange,
  onDefaultUsernameChange,
  onKeepAliveIntervalSecsChange,
}: SettingsPanelProps) {
  const { t, locale, setLocale } = useT()
  const copy = settingsNavigationCopy[locale]
  const [category, setCategory] = useState<SettingsCategory>(() => consumeSettingsCategoryRequest() ?? 'general')
  useEffect(() => {
    const onRequest = () => { const next = consumeSettingsCategoryRequest(); if (next) setCategory(next) }
    window.addEventListener(SETTINGS_CATEGORY_REQUEST_EVENT, onRequest)
    return () => window.removeEventListener(SETTINGS_CATEGORY_REQUEST_EVENT, onRequest)
  }, [])
  return (
    <div className="flex w-full flex-col">
      <div className="px-6 pb-4 pt-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Settings className="h-5 w-5" />
          {t('settings.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.desc')}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-4 px-6 pb-6 md:flex-row md:items-start">
      <nav className="flex shrink-0 flex-wrap gap-1 md:sticky md:top-4 md:w-52 md:flex-col" aria-label={copy.navigation}>
        {SETTINGS_CATEGORIES.map(([item, Icon]) => (
          <button key={item} type="button" data-testid={`settings-category-${item}`}
            aria-pressed={category === item} aria-controls="settings-category-content"
            className={cn('flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors', category === item ? 'bg-primary/10 font-medium text-[var(--workspace-accent-text)]' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
            onClick={() => setCategory(item)}><Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{copy[item]}</button>
        ))}
      </nav>
      <div id="settings-category-content" className="min-w-0 max-w-4xl flex-1 space-y-4" role="region" aria-label={copy[category]}>
        {category === 'general' && <>
        <section className="sb-card p-4">
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

        <section className="sb-card p-4">
          <h3 className="mb-2 font-semibold">{t('settings.appearance')}</h3>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.theme')}</span>
              <p className="text-xs text-muted-foreground">{t('settings.themeToggle')}</p>
            </div>
            <ThemePreferenceControl />
          </div>
          <div className="mt-4 border-t pt-4">
            <span className="text-sm text-muted-foreground">{t('settings.palettes')}</span>
            <p className="mb-3 text-xs text-muted-foreground">{t('settings.palettesDesc')}</p>
            <AppearancePicker family={theme === 'dark' ? 'dark' : 'light'} />
          </div>
        </section>

        <section className="sb-card p-4">
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
          <BiometricToggle />
        </section>

        {onOpenGuide && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
            <div>
              <h3 className="flex items-center gap-2 font-semibold"><BookOpen className="h-4 w-4" />{t('guide.title')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t('guide.settingsHint')}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenGuide}>{t('guide.open')}</Button>
          </section>
        )}
        </>}
        {category === 'connection' && <>
        <section className="sb-card p-4">
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

        <section className="sb-card p-4">
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

        <section className="sb-card p-4">
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
        </>}
        {category === 'monitoring' && <><KomariSettingsSection /><HostRuleSettingsSection /><NotificationSettingsSection /></>}
        {category === 'integrations' && <>
          <AISettingsSection />
        </>}
        {category === 'security' && <SecuritySettingsSection />}
        {category === 'advanced' && <>
          <McpSettingsSection />
          <ShellbeamAgentReleaseSettingsSection />
          <ProbeRetrySettingsSection />
          <ClearDataSection />
        </>}
      </div>
      </div>
    </div>
  )
}

function BiometricToggle() {
  const { t } = useT()
  const { sessionPassword } = useVault()
  const [bioStatus, setBioStatus] = useState<BiometricStatus | null>(null)
  const [enabled, setEnabled] = useState(isBiometricEnabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void checkBiometricStatus().then(setBioStatus)
  }, [])

  if (!bioStatus || !bioStatus.available) {
    return null
  }

  const label = biometryLabel(bioStatus.type)

  const handleToggle = async () => {
    setBusy(true)
    setError('')
    try {
      if (enabled) {
        await removeMasterPassword()
        setEnabled(false)
      } else {
        if (!sessionPassword) {
          setError(t('settings.biometricNeedReauth'))
          setBusy(false)
          return
        }
        // Store password + verify with biometric prompt
        await storeMasterPassword(sessionPassword)
        const verified = await retrieveMasterPassword(t('vault.biometricReason'))
        if (verified !== sessionPassword) {
          await removeMasterPassword()
          setError(t('vault.biometricVerifyFailed'))
          setBusy(false)
          return
        }
        setEnabled(true)
      }
    } catch (e) {
      await removeMasterPassword().catch(() => {})
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('-34018') || msg.includes('keychainError')) {
        setError(t('vault.biometricKeychainError'))
      } else {
        setError(`${t('vault.biometricSetupFailed')}\n${msg}`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-border/50 pt-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-muted-foreground" />
          <div>
            <span className="text-sm text-muted-foreground">{t('settings.biometric')}</span>
            <p className="text-xs text-muted-foreground/70">
              {t('settings.biometricDesc', { type: label })}
            </p>
          </div>
        </div>
        <Button
          variant={enabled ? 'default' : 'outline'}
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => void handleToggle()}
          disabled={busy}
        >
          <Fingerprint className="h-3.5 w-3.5" />
          {enabled ? t('settings.biometricDisable') : t('settings.biometricEnable')}
        </Button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{error}</p>
      )}
    </div>
  )
}

export function AISettingsSection() {
  const [settings, setSettings] = useState<AISettings>(loadAISettings)
  const [showKey, setShowKey] = useState(false)
  const { t } = useT()
  useEffect(() => { saveAISettings(settings) }, [settings])
  const providerDef = AI_PROVIDERS.find((p) => p.id === settings.provider)
  const isOllama = settings.provider === 'ollama'
  const isCustom = settings.provider === 'custom'

  return (
    <section className="sb-card p-4">
      <h3 className="mb-3 flex items-center gap-2 font-semibold">
        <Sparkles className="h-4 w-4 text-violet-500" />
        {t('settings.ai')}
      </h3>
      <div className="space-y-4">
        <div>
          <span className="text-sm text-muted-foreground">{t('ai.backend')}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {(['api', 'claude-code', 'codex-cli'] as const).map((backend) => <button key={backend} type="button"
              aria-pressed={(settings.backend ?? 'api') === backend}
              onClick={() => { setShowKey(false); setSettings((s) => ({ ...s, backend })) }}
              className={cn('rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                (settings.backend ?? 'api') === backend ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-foreground/30')}>
              {backend === 'api' ? t('ai.backendApi') : backend === 'claude-code' ? 'Claude Code' : 'Codex CLI'}
            </button>)}
          </div>
        </div>
        {settings.backend === 'claude-code' || settings.backend === 'codex-cli' ? (
          <AICliSettings key={settings.backend} backend={settings.backend}
            profile={settings.cliProfiles?.[settings.backend] ?? { executable: '', model: '' }}
            onChange={(profile) => setSettings((s) => ({ ...s, cliProfiles: { ...s.cliProfiles, [settings.backend!]: profile } }))} />
        ) : <>
        <div>
          <span className="text-sm text-muted-foreground">{t('settings.provider')}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {AI_PROVIDERS.map((p) => (
              <button key={p.id} type="button"
                onClick={() => { setShowKey(false); setSettings((s) => switchAIProvider(s, p.id)) }}
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
                aria-label={t('settings.apiKey')}
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder={t('settings.apiKeyPlaceholder', { provider: providerDef?.name ?? '' })}
                className="pr-10"
              />
              <button type="button" onClick={() => setShowKey((v) => !v)}
                aria-label={t(showKey ? 'settings.hideApiKey' : 'settings.showApiKey')}
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
              aria-label={t('settings.baseUrl')}
              value={settings.customBaseUrl}
              onChange={(e) => setSettings((s) => ({ ...s, customBaseUrl: e.target.value, apiKey: '' }))}
              placeholder="https://your-llm-endpoint.com/v1"
              className="mt-1"
            />
          </div>
        )}

        <AIModelPicker key={JSON.stringify([settings.provider, settings.apiKey, settings.customBaseUrl])}
          settings={settings} onChange={(model) => setSettings((s) => isCustom ? { ...s, customModel: model } : { ...s, model })} />
        {isCustom && (
          <div>
            <span className="text-sm text-muted-foreground">{t('settings.apiKeyOptional')}</span>
            <div className="relative mt-1">
              <Input
                aria-label={t('settings.apiKeyOptional')}
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder="Bearer token (if required)"
                className="pr-10"
              />
              <button type="button" onClick={() => setShowKey((v) => !v)}
                aria-label={t(showKey ? 'settings.hideApiKey' : 'settings.showApiKey')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {isOllama ? t('settings.ollamaHelper') : isCustom ? t('settings.customHelper') : t('settings.apiKeyHelper')}
        </p>
        </>}
      </div>
    </section>
  )
}

function ClearDataSection() {
  const { t } = useT()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleClear = async () => {
    setBusy(true)
    try {
      const { clearAllAppData } = await import('@/lib/reset')
      await clearAllAppData()
      // Reload the app — this works on all platforms (WebView reload)
      window.location.reload()
    } catch {
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  return (
    <section className="rounded-lg border border-red-500/20 p-4">
      <h3 className="mb-2 font-semibold text-red-500">{t('settings.dangerZone')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.clearDataDesc')}</p>
      <Button variant="outline" size="sm"
        className="mt-3 border-red-500/30 text-red-500 hover:bg-red-500/10"
        onClick={() => setConfirmOpen(true)}>
        {t('settings.clearData')}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="md:max-w-sm">
          <div className="p-6">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
              <AlertTriangle className="h-6 w-6 text-red-500" />
            </div>
            <h3 className="text-center text-lg font-semibold">{t('settings.clearDataConfirmTitle')}</h3>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              {t('settings.clearDataConfirmDesc')}
            </p>
            <div className="mt-6 flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setConfirmOpen(false)}
                disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button className="flex-1 bg-red-500 text-white hover:bg-red-600"
                onClick={() => void handleClear()} disabled={busy}>
                {busy ? t('settings.clearingData') : t('settings.clearDataConfirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function ThemePreferenceControl() {
  const { t } = useT()
  const [preference, setPreference] = useThemePreference()
  const options: Array<[ThemePreference, string, typeof Sun]> = [['light', t('settings.light'), Sun], ['dark', t('settings.dark'), Moon], ['system', t('settings.themeSystem'), Monitor]]
  return <div role="radiogroup" aria-label={t('settings.theme')} data-testid="settings-theme-preference" className="inline-flex rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] p-0.5">
    {options.map(([value, label, Icon]) => <button key={value} type="button" role="radio" aria-checked={preference === value} onClick={() => setPreference(value)}
      className={cn('inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors', preference === value ? 'bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-sm ring-1 ring-[color:var(--workspace-border-soft)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
      <Icon className="h-3.5 w-3.5" />{label}
    </button>)}
  </div>
}
