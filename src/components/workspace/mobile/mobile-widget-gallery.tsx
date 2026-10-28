import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Search } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { workspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import { cn } from '@/lib/utils'
import { MOBILE_WIDGET_IDS, type MobileWidgetId } from './mobile-home-prefs'
import { MobileHomeWidget } from './mobile-home-widgets'
import type { MobileHomeData } from './use-mobile-home-data'

/** v3 `m:widgets`: choose which home widgets show; the choice is saved on this device. */
export function MobileWidgetGallery({ selected, data, onSave, onClose }: { selected: MobileWidgetId[]; data: MobileHomeData; onSave: (widgets: MobileWidgetId[]) => void; onClose: () => void }) {
  const { locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  const [draft, setDraft] = useState<MobileWidgetId[]>(selected)
  const [query, setQuery] = useState('')
  const titles: Record<MobileWidgetId, string> = { host: copy.hostStatus, cpu: copy.cpuTrend, certs: copy.certificates, docker: copy.docker, network: copy.network, tasks: copy.scheduledTasks }
  const sizes: Record<MobileWidgetId, string> = { host: copy.widgetMedium, cpu: copy.widgetSmall, certs: copy.widgetSmall, docker: copy.widgetMedium, network: copy.widgetMedium, tasks: copy.widgetSmall }
  const needle = query.trim().toLowerCase()
  const visible = MOBILE_WIDGET_IDS.filter((id) => !needle || titles[id].toLowerCase().includes(needle) || copy.widgetHint[id].toLowerCase().includes(needle))
  const toggle = (id: MobileWidgetId) => setDraft((current) => current.includes(id) ? current.filter((value) => value !== id) : MOBILE_WIDGET_IDS.filter((value) => value === id || current.includes(value)))

  return <div data-testid="mobile-widget-gallery" role="dialog" aria-modal="true" aria-label={copy.addWidgets} className="absolute inset-0 z-50 flex flex-col justify-end">
    <button type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-[var(--workspace-surface-950)] opacity-50 backdrop-blur-xl" />
    <motion.div initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', damping: 30, stiffness: 320 }}
      className="relative flex max-h-[78%] min-h-0 flex-col rounded-t-[28px] border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] pb-[max(env(safe-area-inset-bottom),12px)] shadow-[var(--workspace-shadow-overlay)]">
      <div aria-hidden="true" className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-[var(--workspace-border-strong)]" />
      <div className="flex items-center justify-between px-2">
        <button type="button" onClick={onClose} className="h-11 px-3 text-[16px] text-[var(--workspace-accent-text)]">{copy.cancel}</button>
        <h2 className="text-[17px] font-semibold text-[var(--workspace-text-strong)]">{copy.addWidgets}</h2>
        <button type="button" data-testid="mobile-widget-gallery-save" onClick={() => onSave(draft)} className="h-11 px-3 text-[16px] font-semibold text-[var(--workspace-accent-text)]">{copy.done}</button>
      </div>
      <label className="mx-4 mb-2.5 mt-1 flex h-10 items-center gap-2 rounded-xl bg-[var(--workspace-surface-800)] px-3 text-[var(--workspace-text-subtle)]">
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchWidgets} aria-label={copy.searchWidgets} className="min-w-0 flex-1 bg-transparent text-[16px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
      </label>
      <div className="grid min-h-0 grid-cols-2 gap-x-3 gap-y-4 overflow-y-auto px-4 pb-2">
        {visible.length === 0 && <p role="status" className="col-span-2 py-6 text-center text-[13px] text-[var(--workspace-text-muted)]">{copy.noResults}</p>}
        {visible.map((id) => {
          const on = draft.includes(id)
          return <button key={id} type="button" aria-pressed={on} data-testid={`mobile-widget-option-${id}`} onClick={() => toggle(id)} className="min-w-0 text-left">
            <span className={cn('relative block h-[132px] overflow-hidden rounded-[24px] ring-2 ring-offset-0 transition-shadow', on ? 'ring-[color:var(--workspace-primary-500)]' : 'ring-transparent')}>
              <span className="pointer-events-none block h-full"><MobileHomeWidget id={id} data={data} preview /></span>
              {on && <span aria-hidden="true" className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]"><Check className="h-3.5 w-3.5" /></span>}
            </span>
            <span className="mt-1.5 block truncate text-[14px] font-semibold text-[var(--workspace-text-strong)]">{titles[id]}</span>
            <span className="block truncate text-[12px] text-[var(--workspace-text-muted)]">{sizes[id]} · {copy.widgetHint[id]}</span>
          </button>
        })}
      </div>
    </motion.div>
  </div>
}
