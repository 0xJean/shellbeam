import { TerminalThemeGrid } from '@/components/terminal-widgets'
import { McpSettingsSection } from '@/components/mcp-settings-section'
import { AIModelPicker } from '@/components/ai-model-picker'
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
import type { TerminalPrefs } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { AlertTriangle, BookOpen, Eye, EyeOff, Fingerprint, Monitor, Moon, Settings, Sparkles, Sun } from 'lucide-react'
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

export function SettingsPanel({
  onOpenGuide,
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
        {onOpenGuide && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
            <div>
              <h3 className="flex items-center gap-2 font-semibold"><BookOpen className="h-4 w-4" />{t('guide.title')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t('guide.settingsHint')}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenGuide}>{t('guide.open')}</Button>
          </section>
        )}
        <McpSettingsSection />
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
          <BiometricToggle />
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

        <ClearDataSection />
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
