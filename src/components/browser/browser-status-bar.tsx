import { LoaderCircle } from 'lucide-react'
import type { SessionBrowserState } from '@/contexts/session-browser-state'
import { useT } from '@/lib/i18n'
import { browserV3Copy } from '@/lib/locales/browser-v3'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import type { LocalizedBrowserRouteIndicator } from './browser-view-state'
import { BrowserKbd } from './browser-kbd'
import { browserModKey, getBrowserRouteChipClass, type BrowserRouteTone } from './browser-tab-visuals'

interface BrowserStatusBarProps {
  state: SessionBrowserState
  routeIndicator: LocalizedBrowserRouteIndicator
  transportFailed: boolean
  transportRecovering: boolean
}

export function BrowserStatusBar({ state, routeIndicator, transportFailed, transportRecovering }: BrowserStatusBarProps) {
  const { t, locale } = useT()
  const copy = browserV3Copy[locale]
  const mod = browserModKey

  let chip: { tone: BrowserRouteTone; label: string; spinning?: boolean }
  let message: string
  if (transportFailed) {
    chip = { tone: 'bad', label: t('browser.transport.failed') }
    message = copy.linkDown
  } else if (transportRecovering) {
    chip = { tone: 'pending', label: t('browser.transport.recovering'), spinning: true }
    message = routeIndicator.detail
  } else if (state.error && !state.isLoading) {
    chip = { tone: 'bad', label: copy.loadFailed }
    message = routeIndicator.detail
  } else {
    chip = { tone: routeIndicator.scope, label: routeIndicator.label, spinning: routeIndicator.scope === 'pending' }
    const pageLabel = state.source?.kind === 'markdown'
      ? t('browser.status.markdownPreview')
      : state.source?.kind === 'html'
        ? t('browser.status.htmlPreview')
        : state.title || state.currentUrl || ''
    message = state.isLoading
      ? [t('browser.status.loading'), pageLabel].filter(Boolean).join(' · ')
      : state.source
        ? [pageLabel ? fill(copy.ready, { title: pageLabel }) : t('browser.status.ready'), routeIndicator.detail].join(' · ')
        : routeIndicator.detail
  }

  const shortcuts: Array<{ keys: string[]; label: string }> = [
    { keys: [`${mod}T`], label: copy.kNewTab },
    { keys: [`⇧${mod}T`], label: copy.kReopen },
    { keys: [`${mod}W`], label: copy.kClose },
    { keys: [`⇧${mod}[`, ']'], label: copy.kSwitch },
    { keys: [`⇧${mod}O`], label: copy.kOverview },
  ]

  return (
    <div data-testid="browser-status-bar" className="flex shrink-0 items-center gap-3.5 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-3 py-1.5 text-[11.5px] text-[var(--workspace-text-subtle)]">
      <span className={cn('inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium', getBrowserRouteChipClass(chip.tone))}>
        {chip.spinning && <LoaderCircle className="h-3 w-3 animate-spin" />}
        {chip.label}
      </span>
      <span className="min-w-0 flex-1 truncate" title={message}>{message}</span>
      <span className="hidden shrink-0 items-center gap-3.5 lg:flex">
        {shortcuts.map((item) => (
          <span key={item.label} className="flex items-center gap-1">
            {item.keys.map((key) => <BrowserKbd key={key}>{key}</BrowserKbd>)}
            <span className="ml-0.5">{item.label}</span>
          </span>
        ))}
      </span>
    </div>
  )
}
