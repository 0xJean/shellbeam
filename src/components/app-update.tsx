import { SettingRow, SettingsGroup, SettingsNote, SettingSwitch } from '@/components/settings-controls'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  APP_UPDATE_DIALOG_EVENT,
  availableVersion,
  checkForAppUpdate,
  dismissAppUpdate,
  loadAppUpdateInfo,
  openAppReleasePage,
  openAppUpdateDialog,
  setAppUpdateChecksEnabled,
  snoozeAppUpdateToast,
  startAppUpdateChecks,
  useAppUpdate,
  useAppUpdateReminderVersion,
  usesGitHubUpdates,
} from '@/lib/app-update'
import { useT } from '@/lib/i18n'
import { appUpdateCopy } from '@/lib/locales/app-update'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import { ArrowUpCircle, Download, ExternalLink, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'

function formatPublishedDate(raw: string | null, locale: string): string | null {
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  try {
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return null
  }
}

function summarizeReleaseNotes(notes: string | null): string | null {
  if (!notes) return null
  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '').trim())
    .filter((line) => line.length > 0)
  return lines[0] ?? null
}

function useOpenRelease() {
  const [failed, setFailed] = useState(false)
  return { failed, open: (version: string) => { setFailed(false); openAppReleasePage(version).catch(() => setFailed(true)) } }
}

/**
 * Global non-blocking update runtime mounted once in App.tsx:
 * - Schedules startup & 12h background checks
 * - Displays a gentle non-blocking corner toast when a new version is first detected
 * - Hosts the What's New / Download modal triggered from the toast, top-bar pill, or sidebar
 */
export function AppUpdateRuntime() {
  useEffect(() => startAppUpdateChecks(), [])
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    const onOpen = () => setDialogOpen(true)
    window.addEventListener(APP_UPDATE_DIALOG_EVENT, onOpen)
    return () => window.removeEventListener(APP_UPDATE_DIALOG_EVENT, onOpen)
  }, [])

  return (
    <>
      <AppUpdateToast onOpenDetails={() => setDialogOpen(true)} />
      <AppUpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}

/** Always-visible top-bar update pill (mirrors Antigravity / IDE update indicator, works even in full-screen terminal). */
export function AppUpdateTopBarPill() {
  const { locale } = useT()
  const copy = appUpdateCopy[locale] ?? appUpdateCopy['zh-CN']
  const version = useAppUpdateReminderVersion()
  if (!version) return null

  return (
    <button
      type="button"
      data-testid="app-update-topbar-pill"
      onClick={openAppUpdateDialog}
      title={fill(copy.available, { version })}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[color:var(--workspace-primary-500)]/40 bg-[var(--workspace-accent-subtle)] px-2.5 text-[11.5px] font-medium text-[color:var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-accent-muted)]"
    >
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap">{fill(copy.topBarPill, { version })}</span>
    </button>
  )
}

/** Gentle, non-blocking floating notification card shown once per session until snoozed or dismissed. */
function AppUpdateToast({ onOpenDetails }: { onOpenDetails: () => void }) {
  const { locale } = useT()
  const copy = appUpdateCopy[locale] ?? appUpdateCopy['zh-CN']
  const state = useAppUpdate()
  const version = useAppUpdateReminderVersion()
  if (!version || state.snoozedToastVersion === version) return null

  const summary = summarizeReleaseNotes(state.releaseNotes)

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="app-update-toast"
      className="pointer-events-auto fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-3 right-3 z-[90] md:bottom-4 md:left-auto md:right-4 md:w-[340px]"
    >
      <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-950)]/95 p-3.5 shadow-[var(--workspace-shadow-overlay)] backdrop-blur-md">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">
              {fill(copy.available, { version })}
            </p>
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--workspace-text-muted)]">
              {summary ?? copy.noReleaseNotes}
            </p>
          </div>
          <button
            type="button"
            data-testid="app-update-toast-dismiss"
            aria-label={copy.dismiss}
            title={copy.dismiss}
            onClick={() => dismissAppUpdate(version)}
            className="rounded-md p-1 text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="app-update-toast-later"
            className="h-7 px-2.5 text-xs text-[var(--workspace-text-muted)]"
            onClick={() => snoozeAppUpdateToast(version)}
          >
            {copy.later}
          </Button>
          <Button
            size="sm"
            data-testid="app-update-toast-details"
            className="h-7 gap-1 bg-[color:var(--workspace-primary-500)] px-3 text-xs text-[var(--workspace-primary-foreground)]"
            onClick={() => {
              snoozeAppUpdateToast(version)
              onOpenDetails()
            }}
          >
            <ArrowUpCircle className="h-3.5 w-3.5" />
            {copy.toastAction}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** What's New & Download modal opened from the top-bar pill, toast, or sidebar reminder. */
function AppUpdateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { locale } = useT()
  const copy = appUpdateCopy[locale] ?? appUpdateCopy['zh-CN']
  const state = useAppUpdate()
  const version = availableVersion(state)
  const { failed, open: openRelease } = useOpenRelease()

  if (!version) return null

  const publishedDate = formatPublishedDate(state.publishedAt, locale)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0">
        <div data-testid="app-update-dialog" className="flex flex-col">
          <div className="flex items-start gap-3 border-b border-[color:var(--workspace-border-soft)] px-5 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 pr-6">
              <h3 className="text-[16px] font-semibold text-[var(--workspace-text-strong)]">
                {fill(copy.available, { version })}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--workspace-text-muted)]">
                {state.currentVersion && (
                  <span className="rounded-md bg-[var(--workspace-surface-800)] px-2 py-0.5 font-mono text-[11px] text-[var(--workspace-text-strong)]">
                    {fill(copy.versionTransition, { current: state.currentVersion, latest: version })}
                  </span>
                )}
                {publishedDate && <span>{publishedDate}</span>}
              </div>
            </div>
          </div>

          <div className="max-h-[46vh] overflow-y-auto px-5 py-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--workspace-text-subtle)]">
              {copy.releaseNotesTitle}
            </p>
            {state.releaseNotes ? (
              <div
                data-testid="app-update-release-notes"
                className="whitespace-pre-wrap break-words rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-3.5 text-[12.5px] leading-relaxed text-[var(--workspace-text)]"
              >
                {state.releaseNotes}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-[var(--workspace-text-muted)]">
                {copy.noReleaseNotes}
              </p>
            )}
            {failed && (
              <p className="mt-2.5 text-xs text-[color:var(--workspace-status-warn-text)]">
                {copy.openFailed}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3.5">
            <Button
              variant="ghost"
              size="sm"
              data-testid="app-update-dialog-dismiss"
              className="text-xs text-[var(--workspace-text-muted)]"
              onClick={() => {
                dismissAppUpdate(version)
                onOpenChange(false)
              }}
            >
              {copy.dismiss}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="app-update-dialog-later"
                className="text-xs"
                onClick={() => {
                  snoozeAppUpdateToast(version)
                  onOpenChange(false)
                }}
              >
                {copy.later}
              </Button>
              <Button
                size="sm"
                data-testid="app-update-dialog-download"
                className="gap-1.5 bg-[color:var(--workspace-primary-500)] text-xs text-[var(--workspace-primary-foreground)]"
                onClick={() => openRelease(version)}
              >
                <Download className="h-3.5 w-3.5" />
                {fill(copy.downloadNow, { version })}
                <ExternalLink className="h-3 w-3 opacity-75" />
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
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
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <button type="button" data-testid="app-update-view" onClick={() => open(version)} className="text-[11px] text-[var(--workspace-accent-text)] hover:underline">{copy.viewRelease}</button>
          <button type="button" onClick={openAppUpdateDialog} className="text-[11px] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)] hover:underline">{copy.toastAction}</button>
        </span>
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
