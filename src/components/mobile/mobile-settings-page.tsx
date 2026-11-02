import { useEffect, useState, type ReactNode } from 'react'
import { Activity, ArrowUpCircle, ChevronLeft, ChevronRight, Clock, Globe, Palette, Plug, ShieldCheck, TerminalSquare, Type, Wrench, ALargeSmall } from 'lucide-react'
import logoUrl from '@/assets/logo.png'
import { AppUpdateReminder } from '@/components/app-update'
import { SettingsPanel, type SettingsPanelProps } from '@/components/settings-panel'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { useThemePreference } from '@/hooks/use-theme'
import { LOCALE_OPTIONS, useT } from '@/lib/i18n'
import { appUpdateCopy } from '@/lib/locales/app-update'
import { mobileMiscV3Copy } from '@/lib/locales/mobile-misc-v3'
import { fill } from '@/lib/locales/probe-install'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
import { consumeSettingsCategoryRequest, SETTINGS_CATEGORY_REQUEST_EVENT, type SettingsCategory } from '@/lib/settings-request'

type MobileSettingsPageProps = Omit<SettingsPanelProps, 'category' | 'hideNavigation'>

const fontLabel = (fontFamily: string) => fontFamily.split(',')[0]?.replace(/['"]/g, '').trim() || fontFamily

/** iOS-style grouped settings list; each row opens the matching SettingsPanel category full screen. */
export function MobileSettingsPage(props: MobileSettingsPageProps) {
  const { t, locale, preference } = useT()
  const c = mobileMiscV3Copy[locale].settings
  const nav = settingsNavigationCopy[locale]
  const { vaults, activeVaultId, vaultStatusState } = useVault()
  const { hosts } = useHosts()
  const [themePreference] = useThemePreference()
  const [category, setCategory] = useState<SettingsCategory | null>(consumeSettingsCategoryRequest)

  useEffect(() => {
    const onRequest = () => { const next = consumeSettingsCategoryRequest(); if (next) setCategory(next) }
    window.addEventListener(SETTINGS_CATEGORY_REQUEST_EVENT, onRequest)
    return () => window.removeEventListener(SETTINGS_CATEGORY_REQUEST_EVENT, onRequest)
  }, [])

  if (category) {
    return (
      <div data-testid="mobile-settings-category" data-category={category} className="min-h-full pb-[env(safe-area-inset-bottom)]">
        <header className="sticky top-0 z-10 flex h-11 items-center gap-1 bg-[var(--workspace-surface-950)] px-2">
          <button type="button" data-testid="mobile-settings-back" onClick={() => setCategory(null)}
            className="flex min-h-[44px] min-w-[44px] items-center gap-0.5 rounded-md px-1 text-[15px] text-[var(--workspace-accent-text)] active:opacity-70">
            <ChevronLeft className="h-5 w-5" />{c.back}
          </button>
          <h2 className="pointer-events-none absolute inset-x-0 text-center text-[15px] font-semibold text-[var(--workspace-text-strong)]">{nav[category]}</h2>
        </header>
        <SettingsPanel {...props} category={category} hideNavigation />
      </div>
    )
  }

  const vaultName = vaults.find((vault) => vault.id === activeVaultId)?.name ?? ''
  const themeLabel = themePreference === 'light' ? t('settings.light') : themePreference === 'dark' ? t('settings.dark') : t('settings.themeSystem')
  const row = (id: string, target: SettingsCategory, icon: ReactNode, label: string, value?: string) => (
    <button key={id} type="button" data-testid={`mobile-settings-row-${id}`} onClick={() => setCategory(target)}
      className="flex min-h-[48px] w-full items-center gap-3 px-4 py-2 text-left active:bg-[var(--workspace-surface-800)]">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)] [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--workspace-text-strong)]">{label}</span>
      {value && <span className="max-w-[45%] truncate text-sm text-[var(--workspace-text-muted)]">{value}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
    </button>
  )
  const group = (title: string, rows: ReactNode[]) => (
    <section className="space-y-1.5">
      <h3 className="px-4 text-[13px] text-[var(--workspace-text-muted)]">{title}</h3>
      <div className="sb-card divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden p-0">{rows}</div>
    </section>
  )

  return (
    <div data-testid="mobile-settings-page" className="mx-auto max-w-xl space-y-5 px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4">
      <h2 className="px-1 text-[28px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h2>
      <AppUpdateReminder />
      <button type="button" data-testid="mobile-settings-vault" onClick={() => setCategory('security')}
        className="sb-card flex min-h-[64px] w-full items-center gap-3 p-3 text-left active:bg-[var(--workspace-surface-800)]">
        <img src={logoUrl} alt="" className="h-12 w-12 shrink-0 rounded-xl" />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[17px] font-semibold text-[var(--workspace-text-strong)]">{vaultName || nav.security}</b>
          {vaultStatusState && <span className="block truncate text-xs text-[var(--workspace-text-muted)]">
            {fill(c.vaultSummary, { status: vaultStatusState.unlocked ? c.unlocked : c.locked, hosts: hosts.length, secrets: vaultStatusState.secretCount })}
          </span>}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
      </button>
      {group(c.appearance, [
        row('theme', 'general', <Palette />, c.theme, themeLabel),
        row('language', 'general', <Globe />, c.language, preference === 'system' ? t('settings.languageSystem') : LOCALE_OPTIONS.find((option) => option.value === locale)?.label),
      ])}
      {group(c.terminal, [
        row('font', 'connection', <Type />, c.font, fontLabel(props.terminalPrefs.fontFamily)),
        row('font-size', 'connection', <ALargeSmall />, c.fontSize, String(props.terminalPrefs.fontSize)),
        row('connection', 'connection', <TerminalSquare />, c.connection),
      ])}
      {group(c.security, [
        row('auto-lock', 'general', <Clock />, c.autoLock, fill(c.minutes, { n: props.vaultAutoLockMinutes })),
        row('vaults', 'security', <ShieldCheck />, c.vaults),
      ])}
      {group(c.more, [
        row('monitoring', 'monitoring', <Activity />, nav.monitoring),
        row('integrations', 'integrations', <Plug />, nav.integrations),
        row('advanced', 'advanced', <Wrench />, nav.advanced),
        row('updates', 'general', <ArrowUpCircle />, appUpdateCopy[locale].title),
      ])}
    </div>
  )
}
