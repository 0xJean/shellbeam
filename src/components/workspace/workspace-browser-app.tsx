import { Suspense, lazy } from 'react'
import { useT } from '@/lib/i18n'

const BrowserView = lazy(async () => {
  const module = await import('@/components/browser/browser-view')
  return { default: module.BrowserView }
})

interface WorkspaceBrowserAppProps {
  sessionId: string
  visible?: boolean
  onCloseRequest?: () => void
}

export function WorkspaceBrowserApp({ sessionId, visible = true, onCloseRequest }: WorkspaceBrowserAppProps) {
  return (
    <div data-testid="workspace-browser-app" className="flex h-full min-h-0 flex-col">
      <Suspense fallback={<BrowserAppFallback />}>
        <BrowserView sessionId={sessionId} visible={visible} onCloseRequest={onCloseRequest} />
      </Suspense>
    </div>
  )
}

function BrowserAppFallback() {
  const { t } = useT()

  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-[var(--workspace-surface-950)]">
      <div role="status" className="sb-card flex items-center gap-2.5 bg-[var(--workspace-surface-900)] px-4 py-3 text-sm text-[var(--workspace-text-muted)]">
        <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[color:var(--workspace-border-strong)] border-t-[hsl(var(--primary))]" />
        {t('browser.loading')}
      </div>
    </div>
  )
}
