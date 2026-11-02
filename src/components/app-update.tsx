import { SettingRow, SettingsGroup, SettingsNote, SettingSwitch } from '@/components/settings-controls'
import { Button } from '@/components/ui/button'
import {
  availableVersion, checkForAppUpdate, dismissAppUpdate, loadAppUpdateInfo, openAppReleasePage, setAppUpdateChecksEnabled,
  startAppUpdateChecks, useAppUpdate, useAppUpdateReminderVersion, usesGitHubUpdates,
} from '@/lib/app-update'
import { useT } from '@/lib/i18n'
import { appUpdateCopy } from '@/lib/locales/app-update'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import { ArrowUpCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export function AppUpdateRuntime() {
  useEffect(() => startAppUpdateChecks(), [])
  return null
}

function useOpenRelease() {
  const [failed, setFailed] = useState(false)
  return { failed, open: (version: string) => { setFailed(false); openAppReleasePage(version).catch(() => setFailed(true)) } }
}

/** Stays where it is placed until dismissed, without covering anything or interrupting work. */
export function AppUpdateReminder({ className }: { className?: string }) {
  const { locale } = useT()
  const copy = appUpdateCopy[locale]
  const version = useAppUpdateReminderVersion()
  const { failed, open } = useOpenRelease()
  if (!version) return null
  return (
    <div role="status" data-testid="app-update-reminder" className={cn('flex items-start gap-2.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2', className)}>
      <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-[var(--workspace-text-strong)]">{fill(copy.available, { version })}</span>
        <button type="button" data-testid="app-update-view" onClick={() => open(version)} className="mt-0.5 text-[11px] text-[var(--workspace-accent-text)] hover:underline">{copy.viewRelease}</button>
        {failed && <span className="mt-0.5 block text-[11px] text-[var(--workspace-text-muted)]">{copy.openFailed}</span>}
      </span>
      <button type="button" data-testid="app-update-dismiss" aria-label={copy.dismiss} title={copy.dismiss} onClick={() => dismissAppUpdate(version)}
        className="rounded-md p-1 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]"><X className="h-3.5 w-3.5" /></button>
    </div>
  )
}

export function AppUpdateSettingsSection() {
  const { locale } = useT()
  const copy = appUpdateCopy[locale]
  const state = useAppUpdate()
  const { failed, open } = useOpenRelease()
  const available = availableVersion(state)
  useEffect(() => { void loadAppUpdateInfo() }, [])
  if (!state.platform || !state.currentVersion) return null
  if (!usesGitHubUpdates(state)) {
    return <SettingsGroup title={copy.title} testId="app-update-settings">
      <SettingRow label={copy.version} description={copy.testFlight}><span className="font-mono text-xs text-[var(--workspace-text-muted)]">{state.currentVersion}</span></SettingRow>
    </SettingsGroup>
  }
  const status = state.checking ? copy.checking
    : available ? [fill(copy.available, { version: available }), state.lastCheckFailed && copy.checkFailed].filter(Boolean).join(' ')
    : state.lastCheckFailed ? copy.checkFailed
    : state.lastCheckedAt ? copy.upToDate : copy.notChecked
  return <div className="space-y-2">
    <SettingsGroup title={copy.title} testId="app-update-settings">
      <SettingRow label={<>{copy.version}<span className="font-mono text-xs font-normal text-[var(--workspace-text-muted)]">{state.currentVersion}</span></>}
        description={<span role="status" data-testid="app-update-status">{status}{failed && ` ${copy.openFailed}`}</span>}>
        {available && <Button variant="outline" size="sm" data-testid="app-update-settings-view" onClick={() => open(available)}>{copy.viewRelease}</Button>}
        <Button variant="outline" size="sm" data-testid="app-update-check" disabled={state.checking} onClick={() => void checkForAppUpdate()}>{copy.checkNow}</Button>
      </SettingRow>
      <SettingRow label={copy.autoCheck} description={copy.autoCheckDesc} htmlFor="settings-update-auto-check">
        <SettingSwitch id="settings-update-auto-check" aria-label={copy.autoCheck} data-testid="app-update-auto-check" checked={state.enabled} onChange={(event) => setAppUpdateChecksEnabled(event.target.checked)} />
      </SettingRow>
    </SettingsGroup>
    <SettingsNote>{copy.privacy}</SettingsNote>
  </div>
}
