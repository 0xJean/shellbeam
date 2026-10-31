import { AppUpdateSettingsSection } from '@/components/app-update'
import { TerminalThemeGrid } from '@/components/terminal-widgets'
import { McpSettingsSection } from '@/components/mcp-settings-section'
import { AISettingsSection } from '@/components/ai-settings-section'
import { MonitorSettingsSection } from '@/components/monitor-settings-section'
import { ShellbeamAgentReleaseSettingsSection } from '@/components/shellbeam-agent-release-settings-section'
import { ProbeRetrySettingsSection } from '@/components/probe-retry-settings-section'
import { AppearancePicker } from '@/components/appearance-picker'
import { SegmentedChoice, SettingRow, SettingsGroup, SettingsHead, SettingsNote, SettingStepper, SettingSwitch } from '@/components/settings-controls'
import { SecuritySettingsSection } from '@/components/security-settings-section'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useVault } from '@/contexts/vault-context'
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
import { settingsV3Copy } from '@/lib/locales/settings-v3'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import { useThemePreference, type ThemePreference } from '@/hooks/use-theme'
import { consumeSettingsCategoryRequest, SETTINGS_CATEGORY_REQUEST_EVENT, type SettingsCategory } from '@/lib/settings-request'
import { Activity, AlertTriangle, BookOpen, Fingerprint, Monitor, Moon, Plug, Settings, ShieldCheck, SlidersHorizontal, Sun, TerminalSquare, Trash2, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ReconnectSettings {
  enabled: boolean
  maxRetries: number
  intervalMs: number
}

export interface SettingsPanelProps {
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
  /** Opens this category and follows the prop instead of the panel's own navigation. */
  category?: SettingsCategory
  hideNavigation?: boolean
}

const TERMINAL_FONT_OPTIONS = [
  { value: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Courier New', monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', 'SF Mono', Menlo, Monaco, monospace", label: 'Fira Code' },
  { value: "'SF Mono', Menlo, Monaco, 'Courier New', monospace", label: 'SF Mono' },
  { value: "Menlo, Monaco, 'Courier New', monospace", label: 'Menlo' },
  { value: "'Cascadia Code', 'Fira Code', Menlo, monospace", label: 'Cascadia Code' },
  { value: "'Source Code Pro', Menlo, Monaco, monospace", label: 'Source Code Pro' },
]

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
  category: controlledCategory,
  hideNavigation = false,
}: SettingsPanelProps) {
  const { t, locale, preference, setLocale } = useT()
  const copy = settingsNavigationCopy[locale]
  const [ownCategory, setCategory] = useState<SettingsCategory>(() => (controlledCategory ? null : consumeSettingsCategoryRequest()) ?? 'general')
  const category = controlledCategory ?? ownCategory
  useEffect(() => {
    if (controlledCategory) return
    const onRequest = () => { const next = consumeSettingsCategoryRequest(); if (next) setCategory(next) }
    window.addEventListener(SETTINGS_CATEGORY_REQUEST_EVENT, onRequest)
    return () => window.removeEventListener(SETTINGS_CATEGORY_REQUEST_EVENT, onRequest)
  }, [controlledCategory])
  const v3 = settingsV3Copy[locale]
  const stepLabels = (label: string) => ({ label, decreaseLabel: fill(v3.decrease, { label }), increaseLabel: fill(v3.increase, { label }) })
  return (
    <div className={cn('flex w-full min-w-0 flex-col', hideNavigation ? 'px-4 pb-8 pt-2' : 'gap-5 p-4 md:p-6')}>
      {!hideNavigation && <header className="min-w-0">
        <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">
          <Settings className="h-5 w-5 md:hidden" />
          {t('settings.title')}
        </h1>
        <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{t('settings.desc')}</p>
      </header>}
      <div className="flex w-full min-w-0 flex-col gap-4 md:flex-row md:items-start md:gap-8">
      {!hideNavigation && <div className="shrink-0 md:sticky md:top-6 md:w-52">
        <nav className="flex flex-wrap gap-1 md:flex-col" aria-label={copy.navigation}>
          {SETTINGS_CATEGORIES.map(([item, Icon]) => (
            <button key={item} type="button" data-testid={`settings-category-${item}`}
              aria-pressed={category === item} aria-controls="settings-category-content"
              className={cn('flex items-center gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors', category === item ? 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] font-medium text-[var(--workspace-text-strong)]' : 'border-transparent text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]')}
              onClick={() => setCategory(item)}><Icon className={cn('h-4 w-4 shrink-0', category === item && 'text-[var(--workspace-accent-text)]')} aria-hidden="true" />{copy[item]}</button>
          ))}
        </nav>
      </div>}
      <div id="settings-category-content" className="min-w-0 flex-1 space-y-4" role="region" aria-label={copy[category]}>
        {category === 'general' && <>
        <section className="sb-card p-4">
          <h3 className="mb-2 font-semibold">{t('settings.language')}</h3>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-muted-foreground">{t('settings.languageDesc')}</span>
            </div>
            <div className="flex gap-2">
              {[{ value: 'system' as const, label: t('settings.languageSystem') }, ...LOCALE_OPTIONS].map((opt) => (
                <button key={opt.value} type="button" aria-pressed={preference === opt.value}
                  onClick={() => setLocale(opt.value)}
                  className={cn('rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                    preference === opt.value ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-foreground/30'
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
        <AppUpdateSettingsSection />
        </>}
        {category === 'connection' && <>
        <SettingsHead title={v3.terminalTitle} description={v3.terminalDesc} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            <SettingsGroup title={v3.connectionGroup}>
              <SettingRow label={t('settings.defaultUser')} description={t('settings.defaultUserDesc')} htmlFor="settings-default-user">
                <Input id="settings-default-user" value={defaultUsername} onChange={(e) => onDefaultUsernameChange(e.target.value)}
                  placeholder="root" className="h-8 w-40 font-mono text-xs" />
              </SettingRow>
              <SettingRow label={t('settings.keepAlive')} description={`${t('settings.keepAliveDesc')} · ${v3.keepAliveRange}`}>
                <SettingStepper {...stepLabels(t('settings.keepAlive'))} min={10} max={300} unit={v3.seconds} value={keepAliveIntervalSecs}
                  onChange={(value) => onKeepAliveIntervalSecsChange(value || 30)} />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={t('settings.reconnect')}>
              <SettingRow label={t('settings.autoReconnect')} description={t('settings.reconnectDesc')} htmlFor="settings-auto-reconnect">
                <SettingSwitch id="settings-auto-reconnect" checked={reconnectSettings.enabled}
                  onChange={(e) => onReconnectSettingsChange({ enabled: e.target.checked })} />
              </SettingRow>
              <SettingRow label={t('settings.maxRetries')} description={v3.maxRetriesRange}>
                <SettingStepper {...stepLabels(t('settings.maxRetries'))} min={0} max={10} unit={v3.times} value={reconnectSettings.maxRetries}
                  onChange={(value) => onReconnectSettingsChange({ maxRetries: value || 0 })} />
              </SettingRow>
              <SettingRow label={t('settings.interval')} description={v3.intervalRange}>
                <SettingStepper {...stepLabels(t('settings.interval'))} min={500} max={15000} step={500} unit="ms" width="w-14" value={reconnectSettings.intervalMs}
                  onChange={(value) => onReconnectSettingsChange({ intervalMs: value || 1500 })} />
              </SettingRow>
            </SettingsGroup>
          </div>
          <div className="min-w-0 space-y-3">
            <SettingsGroup title={<><Monitor className="h-4 w-4" />{t('settings.terminal')}</>}>
              <SettingRow label={t('settings.fontFamily')} description={v3.fontFamilyDesc}>
                <Select
                  value={terminalPrefs.fontFamily}
                  onChange={(v) => onTerminalPrefsChange({ fontFamily: v })}
                  className="w-44"
                  options={TERMINAL_FONT_OPTIONS}
                />
              </SettingRow>
              <SettingRow label={t('settings.fontSize')} description={v3.fontSizeDesc}>
                <SettingStepper {...stepLabels(t('settings.fontSize'))} min={10} max={24} value={terminalPrefs.fontSize}
                  onChange={(value) => onTerminalPrefsChange({ fontSize: value || 13 })} />
              </SettingRow>
              <SettingRow label={v3.cursorStyle}>
                <SegmentedChoice label={v3.cursorStyle} value={terminalPrefs.cursorStyle ?? 'block'} onChange={(value) => onTerminalPrefsChange({ cursorStyle: value })}
                  options={[{ value: 'block', label: v3.cursorBlock }, { value: 'bar', label: v3.cursorBar }, { value: 'underline', label: v3.cursorUnderline }]} />
              </SettingRow>
              <SettingRow label={v3.cursorBlink} htmlFor="settings-cursor-blink">
                <SettingSwitch id="settings-cursor-blink" aria-label={v3.cursorBlink} checked={terminalPrefs.cursorBlink ?? true} onChange={(event) => onTerminalPrefsChange({ cursorBlink: event.target.checked })} />
              </SettingRow>
            </SettingsGroup>
            <SettingsNote>{v3.sharedNote}</SettingsNote>
          </div>
        </div>
        <SettingsGroup title={t('settings.colorTheme')} extra={<small className="text-xs font-normal text-[var(--workspace-text-subtle)]">{fill(v3.defaultTheme, { name: t('terminal.themeFollowApp') })}</small>}>
          <div className="p-4">
            <TerminalThemeGrid variant="preview" currentThemeId={terminalPrefs.themeId} onSelect={(id) => onTerminalPrefsChange({ themeId: id })} />
          </div>
        </SettingsGroup>
        </>}
        {category === 'monitoring' && <MonitorSettingsSection />}
        {category === 'integrations' && <>
          <AISettingsSection />
        </>}
        {category === 'security' && <SecuritySettingsSection />}
        {category === 'advanced' && <>
          <McpSettingsSection />
          <SettingsHead title={v3.advancedTitle} description={v3.advancedDesc} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ShellbeamAgentReleaseSettingsSection />
            <div className="min-w-0 space-y-4">
              <ProbeRetrySettingsSection />
              <SettingsNote>{v3.advancedNote}</SettingsNote>
              <ClearDataSection />
            </div>
          </div>
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
    <SettingsGroup title={t('settings.dangerZone')} cardClassName="border-[color:var(--workspace-status-bad-border)]">
      <SettingRow label={t('settings.clearData')} description={t('settings.clearDataDesc')}>
        <Button variant="outline" size="sm"
          className="gap-1.5 border-[color:var(--workspace-status-bad-border)] text-[var(--workspace-status-bad)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[var(--workspace-status-bad)]"
          onClick={() => setConfirmOpen(true)}>
          <Trash2 className="h-3.5 w-3.5" />
          {t('settings.clearData')}
        </Button>
      </SettingRow>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="md:max-w-sm">
          <div className="p-6">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--workspace-status-bad-bg)]">
              <AlertTriangle className="h-6 w-6 text-[var(--workspace-status-bad)]" />
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
              <Button className="flex-1 bg-[var(--workspace-status-bad)] text-white hover:opacity-90"
                onClick={() => void handleClear()} disabled={busy}>
                {busy ? t('settings.clearingData') : t('settings.clearDataConfirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
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
