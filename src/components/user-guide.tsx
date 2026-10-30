import { useEffect, useRef, useState } from 'react'
import { Activity, Archive, ArrowLeft, ArrowRight, Bot, Cable, Check, FolderSync, Info, LayoutGrid, LifeBuoy, Lightbulb, MousePointerClick, RotateCcw, Server, Shield, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { GUIDE_CHAPTERS, loadGuideProgress, saveGuideProgress, type GuideDestination, type GuideProgress } from '@/lib/user-guide'
import { INTERACTIVE_TOURS, type InteractiveTourId } from '@/lib/interactive-tour'
import { guideAuditCopy } from '@/lib/locales/guide-audit-v3'
import { fill } from '@/lib/locales/probe-install'

/** Shortcuts to the walkthroughs people look for most, shown under the chapter list as in the v3 design. */
const FEATURED_TOURS = [
  { id: 'hosts', label: 'guide.tour.hosts', icon: MousePointerClick },
  { id: 'monitor', label: 'guide.tour.monitor', icon: Activity },
  { id: 'mcp', label: 'guide.tour.mcp', icon: Bot },
] as const satisfies ReadonlyArray<{ id: InteractiveTourId; label: string; icon: typeof Activity }>

function hasTour(id: string): id is InteractiveTourId {
  return (INTERACTIVE_TOURS as readonly string[]).includes(id)
}

const CHAPTER_ICONS = { vault: Shield, hosts: Server, connect: Terminal, monitor: Activity, workspace: FolderSync, serverWorkspace: LayoutGrid, mcp: Cable, backup: Archive, troubleshooting: LifeBuoy }

export function UserGuide({ onNavigate, onStartTour }: { onNavigate: (destination: GuideDestination) => void; onStartTour?: (id: InteractiveTourId) => void }) {
  const { t, locale } = useT()
  const copy = guideAuditCopy[locale]
  const [state, setState] = useState(loadGuideProgress)
  const { progress, storageAvailable } = state
  const currentChapter = progress.current
  const index = GUIDE_CHAPTERS.findIndex((chapter) => chapter.id === currentChapter)
  const chapter = GUIDE_CHAPTERS[index]
  const Icon = CHAPTER_ICONS[chapter.id]
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousChapter = useRef(currentChapter)
  const complete = progress.read.length === GUIDE_CHAPTERS.length

  useEffect(() => {
    if (previousChapter.current !== currentChapter) {
      headingRef.current?.focus({ preventScroll: true })
      headingRef.current?.scrollIntoView?.({ block: 'nearest' })
      previousChapter.current = currentChapter
    }
  }, [currentChapter])

  function updateProgress(next: GuideProgress) {
    setState({ progress: next, storageAvailable: saveGuideProgress(next) })
  }

  function markRead() {
    updateProgress({
      current: GUIDE_CHAPTERS[Math.min(index + 1, GUIDE_CHAPTERS.length - 1)].id,
      read: [...new Set([...progress.read, chapter.id])],
    })
  }

  return (
    <main className="flex w-full flex-col p-4 text-[var(--workspace-text)] md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('guide.title')}</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--workspace-text-muted)]">{t('guide.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" className="text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]" onClick={() => updateProgress({ current: 'vault', read: [] })}>
            <RotateCcw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />{t('guide.restart')}
          </Button>
          <Button variant="outline" size="sm" className="border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-800)]" onClick={() => onNavigate('hosts')}>{t('guide.exit')}</Button>
        </div>
      </header>

      <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="sb-card flex min-w-0 flex-col self-start overflow-hidden">
          <div className="border-b border-[color:var(--workspace-border-soft)] px-4 py-3.5">
            <p className="text-[13px] font-semibold text-[var(--workspace-text-strong)]" role="status">{t('guide.progress', { read: progress.read.length, total: GUIDE_CHAPTERS.length })}</p>
            <div role="progressbar" aria-label={t('guide.readingProgress')} aria-valuemin={0} aria-valuemax={GUIDE_CHAPTERS.length} aria-valuenow={progress.read.length} className="mb-1.5 mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--workspace-surface-700)]">
              <div className="h-full rounded-full bg-[color:var(--workspace-primary-500)]" style={{ width: `${progress.read.length / GUIDE_CHAPTERS.length * 100}%` }} />
            </div>
            <p className="flex items-start gap-1.5 text-[11px] leading-4 text-[var(--workspace-text-subtle)]"><Info aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />{t('guide.progressHint')}</p>
            {!storageAvailable && <p role="alert" className="mt-2 text-xs text-[var(--workspace-status-warn-text)]">{t('guide.storageError')}</p>}
            {complete && <p role="status" className="mt-2 text-xs text-[var(--workspace-status-good-text)]">{t('guide.complete')}</p>}
          </div>

          <nav aria-label={t('guide.chapters')} className="min-w-0 py-1.5">
            <div className="flex gap-1 overflow-x-auto px-2 pb-1 lg:flex-col lg:gap-0 lg:overflow-visible lg:px-0 lg:pb-0">
              {GUIDE_CHAPTERS.map((item, i) => {
                const read = progress.read.includes(item.id)
                const active = chapter.id === item.id
                return (
                  <button key={item.id} type="button" aria-current={active ? 'step' : undefined}
                    onClick={() => updateProgress({ ...progress, current: item.id })}
                    className={cn('flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-[12.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--workspace-primary-500)] lg:rounded-none lg:px-4',
                      active ? 'bg-[var(--workspace-accent-subtle)] font-medium text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]')}>
                    <span aria-hidden="true" className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold',
                      read ? 'bg-[var(--workspace-status-good)] text-white' : 'border-[1.5px] border-[color:var(--workspace-border-strong)] text-[var(--workspace-text-subtle)]')}>
                      {read ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                    </span>
                    <span className="flex-1">{t(`guide.${item.id}.title`)}</span>
                    <span aria-hidden="true" className="hidden text-[11px] font-normal text-[var(--workspace-text-subtle)] lg:inline">{fill(copy.steps, { count: item.steps })}</span>
                    {read && <span className="sr-only">{t('guide.read')}</span>}
                  </button>
                )
              })}
            </div>
          </nav>

          {onStartTour && (
            <div data-testid="guide-tours" className="flex flex-col gap-1.5 border-t border-[color:var(--workspace-border-soft)] px-4 py-3">
              <p className="text-[11px] font-semibold text-[var(--workspace-text-subtle)]">{t('guide.tours')}</p>
              {FEATURED_TOURS.map(({ id, label, icon: TourIcon }) => (
                <Button key={id} variant="outline" size="sm" className="justify-start border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-800)]" onClick={() => onStartTour(id)}>
                  <TourIcon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />{t(label)}
                </Button>
              ))}
            </div>
          )}
        </div>

        <article aria-labelledby="guide-chapter-title" className="sb-card flex min-w-0 flex-col p-5 md:px-7 md:py-6">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--workspace-accent-text)]"><Icon aria-hidden="true" className="h-3.5 w-3.5" />{t('guide.chapterNumber', { current: index + 1, total: GUIDE_CHAPTERS.length })}</div>
          <h2 ref={headingRef} tabIndex={-1} id="guide-chapter-title" className="mt-2 scroll-mt-4 text-[22px] font-semibold tracking-tight text-[var(--workspace-text-strong)] focus:outline-none">{t(`guide.${chapter.id}.title`)}</h2>
          <p className="mt-3 text-[13px] leading-6 text-[var(--workspace-text)]">{t(`guide.${chapter.id}.summary`)}</p>
          <ol className="mt-4">
            {Array.from({ length: chapter.steps }, (_, i) => (
              <li key={`${chapter.id}-${i}`} className="flex gap-3.5 border-b border-[color:var(--workspace-border-soft)] py-3.5 last:border-b-0">
                <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--workspace-accent-subtle)] text-xs font-semibold text-[var(--workspace-accent-text)]">{i + 1}</span>
                <div className="min-w-0">
                  <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t(`guide.${chapter.id}.step${i + 1}.title`)}</h3>
                  <p className="mt-0.5 break-words text-xs leading-5 text-[var(--workspace-text-muted)]">{t(`guide.${chapter.id}.step${i + 1}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>
          <aside className="mt-4 flex items-start gap-2.5 rounded-lg bg-[var(--workspace-accent-subtle)] px-4 py-3 text-xs leading-5 text-[var(--workspace-text)]">
            <Lightbulb aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]" /><p>{t(`guide.${chapter.id}.note`)}</p>
          </aside>
          <div className="mt-4 flex flex-wrap gap-2">
            {onStartTour && hasTour(chapter.id) && <Button data-testid="guide-demo" variant="ghost" size="sm" className="bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)] hover:bg-[color:var(--workspace-primary-500)] hover:text-[var(--workspace-primary-foreground)] hover:opacity-90" onClick={() => onStartTour(chapter.id as InteractiveTourId)}><MousePointerClick aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />{t('guide.demo')}</Button>}
            {chapter.actions.map((action, i) => <Button key={action.destination} variant="ghost" size="sm" className={cn(i === 0 ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)] hover:opacity-90' : 'text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-800)]')} onClick={() => onNavigate(action.destination)}>{t(action.label)}<ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" /></Button>)}
          </div>
          <p className="mt-2 text-[11px] text-[var(--workspace-text-subtle)]">{t(onStartTour && hasTour(chapter.id) ? 'guide.demoHint' : 'guide.actionHint')}</p>
          <div className="flex-1" />
          <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--workspace-border-soft)] pt-4">
            <Button variant="ghost" size="sm" className="text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]" disabled={index === 0} onClick={() => updateProgress({ ...progress, current: GUIDE_CHAPTERS[index - 1].id })}><ArrowLeft aria-hidden="true" className="mr-1.5 h-4 w-4" />{t('guide.previous')}</Button>
            <div className="flex flex-wrap gap-2">
              {index < GUIDE_CHAPTERS.length - 1 && <Button variant="outline" size="sm" className="border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-800)]" onClick={() => updateProgress({ ...progress, current: GUIDE_CHAPTERS[index + 1].id })}>{t('guide.next')}</Button>}
              <Button size="sm" className="bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)] hover:bg-[color:var(--workspace-primary-500)] hover:opacity-90" onClick={markRead}><Check aria-hidden="true" className="mr-1.5 h-4 w-4" />{t(index === GUIDE_CHAPTERS.length - 1 ? 'guide.markRead' : 'guide.readAndContinue')}</Button>
            </div>
          </footer>
        </article>
      </div>
    </main>
  )
}
