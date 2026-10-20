import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { EmbeddedBrowserWebview } from './browser/embedded-browser-webview'
import { Button } from './ui/button'
import { useT } from '@/lib/i18n'
import { komariOnboardingCopy } from '@/lib/locales/komari-onboarding'
import { komariConsoleBrowserId } from '@/lib/komari-console'

/** A single, scoped child WebView in the main window. Its existing lease
 * implementation hides and closes the native surface on unmount. */
export function KomariAdministrationPanel({ vaultId, integrationId, name, url, onClose, onError }: {
  vaultId: string
  integrationId: string
  name: string
  url: string
  onClose: () => void
  onError: () => void
}) {
  const { locale } = useT()
  const copy = komariOnboardingCopy[locale]
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeCallback = useRef(onClose)
  useEffect(() => { closeCallback.current = onClose }, [onClose])
  useEffect(() => {
    const priorFocus = document.activeElement
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeCallback.current() }
      // The sole React-side action is the close button; native WebView focus
      // remains managed by the platform rather than trapping its document.
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus()
    }
  }, [])
  const browserId = komariConsoleBrowserId(vaultId, integrationId)
  return createPortal(<section role="dialog" aria-modal="true" aria-label={`${copy.advanced}: ${name}`} className="fixed inset-0 z-50 flex flex-col bg-background" data-testid="komari-administration-panel">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
      <div><h3 className="text-sm font-semibold">{name}</h3><p className="text-xs text-muted-foreground">{copy.panelHint}</p></div>
      <Button ref={closeRef} variant="outline" size="sm" onClick={onClose}><X className="mr-1 h-4 w-4" />{copy.close}</Button>
    </header>
    <div className="min-h-0 flex-1">
      <EmbeddedBrowserWebview browserId={browserId} sessionId={browserId} visible source={{ kind: 'url', url }} sourceRevision={0} onError={onError} />
    </div>
  </section>, document.body)
}
