import { useEffect, useEffectEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import type { InteractiveTourId, TourOutcome } from '@/lib/interactive-tour'

export function InteractiveTour({ id, valid, setHostFormOpen, onFinish }: {
  id: InteractiveTourId
  valid: boolean
  setHostFormOpen: (open: boolean) => void
  onFinish: (outcome: TourOutcome) => void
}) {
  const { t } = useT()
  const [waiting, setWaiting] = useState(true)
  const finish = useEffectEvent(onFinish)
  const prepareForm = useEffectEvent(setHostFormOpen)

  useEffect(() => {
    if (!valid) { finish('interrupted'); return }
    let disposed = false
    let controller: { dispose: () => void } | undefined
    void Promise.resolve().then(async () => {
      // Skip a transient StrictMode mount before loading the optional tour bundle.
      if (disposed) return
      const { startInteractiveTour } = await import('@/lib/interactive-tour-driver')
      if (disposed) return
      controller = startInteractiveTour({ id, t, setHostFormOpen: (open) => prepareForm(open), onWaiting: setWaiting, onFinish: (outcome) => finish(outcome) })
    }).catch(() => { if (!disposed) finish('unavailable') })
    return () => { disposed = true; controller?.dispose() }
  }, [id, t, valid])

  return waiting ? createPortal(
    <div role="status" className="shellbeam-tour-loading fixed right-3 top-3 z-[1000000001] flex items-center gap-3 rounded-xl border bg-card p-3 text-xs text-card-foreground shadow-lg">
      {t('tour.loading')}
      <Button size="sm" variant="outline" onClick={() => onFinish('cancelled')}>{t('tour.close')}</Button>
    </div>, document.body,
  ) : null
}
