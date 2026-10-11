import { useEffect, useRef, useState } from 'react'
import { Activity, Archive, ArrowLeft, ArrowRight, BookOpen, Cable, Check, FolderSync, Info, LifeBuoy, RotateCcw, Server, Shield, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { GUIDE_CHAPTERS, loadGuideProgress, saveGuideProgress, type GuideDestination, type GuideProgress } from '@/lib/user-guide'
import { INTERACTIVE_TOURS, type InteractiveTourId } from '@/lib/interactive-tour'

const CHAPTER_ICONS = { vault: Shield, hosts: Server, connect: Terminal, monitor: Activity, workspace: FolderSync, mcp: Cable, backup: Archive, troubleshooting: LifeBuoy }

export function UserGuide({ onNavigate, onStartTour }: { onNavigate: (destination: GuideDestination) => void; onStartTour?: (id: InteractiveTourId) => void }) {
  const { t } = useT()
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
    <main className="mx-auto w-full max-w-6xl p-4 text-[var(--workspace-text)] md:p-6">
      <header className="rounded-2xl border border-[var(--workspace-border-soft)] bg-gradient-to-br from-primary/10 via-[var(--workspace-surface-900)] to-[var(--workspace-surface-950)] p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--workspace-text-strong)]"><BookOpen aria-hidden="true" className="h-5 w-5 text-primary" />{t('guide.title')}</h1>
            <p className="mt-2 text-sm leading-relaxed text-[var(--workspace-text-muted)]">{t('guide.description')}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('hosts')}>{t('guide.exit')}<ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" /></Button>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs font-medium" role="status">{t('guide.progress', { read: progress.read.length, total: GUIDE_CHAPTERS.length })}</p>
          <div role="progressbar" aria-label={t('guide.readingProgress')} aria-valuemin={0} aria-valuemax={GUIDE_CHAPTERS.length} aria-valuenow={progress.read.length} className="h-1.5 w-32 overflow-hidden rounded-full bg-primary/10">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress.read.length / GUIDE_CHAPTERS.length * 100}%` }} />
          </div>
          <p className="text-xs text-[var(--workspace-text-muted)]">{t('guide.progressHint')}</p>
        </div>
        {!storageAvailable && <p role="alert" className="mt-3 text-xs text-amber-600 dark:text-amber-400">{t('guide.storageError')}</p>}
        {complete && <p role="status" className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{t('guide.complete')}</p>}
      </header>

      {onStartTour && (
        <section aria-label={t('tour.title')} className="mt-5 rounded-2xl border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-5">
          <h2 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t('tour.title')}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--workspace-text-muted)]">{t('tour.description')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {INTERACTIVE_TOURS.map((id) => <Button key={id} variant="outline" size="sm" onClick={() => onStartTour(id)}>{t(`tour.launch.${id}`)}<ArrowRight aria-hidden="true" className="ml-2 h-3.5 w-3.5" /></Button>)}
          </div>
        </section>
      )}

      <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t('guide.chapters')} className="min-w-0">
          <div className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
            {GUIDE_CHAPTERS.map((item, i) => {
              const read = progress.read.includes(item.id)
              return (
                <button key={item.id} type="button" aria-current={chapter.id === item.id ? 'step' : undefined}
                  onClick={() => updateProgress({ ...progress, current: item.id })}
                  className={cn('flex shrink-0 items-center gap-3 rounded-xl border px-3 py-3 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
                    chapter.id === item.id ? 'border-primary/30 bg-primary/10 text-primary' : 'border-transparent text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)]')}>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--workspace-surface-900)] font-mono text-xs" aria-hidden="true">{read ? <Check className="h-3.5 w-3.5" /> : String(i + 1).padStart(2, '0')}</span>
                  {t(`guide.${item.id}.title`)}
                  {read && <span className="sr-only">{t('guide.read')}</span>}
                </button>
              )
            })}
          </div>
          <Button variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={() => updateProgress({ current: 'vault', read: [] })}>
            <RotateCcw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />{t('guide.restart')}
          </Button>
        </nav>

        <article aria-labelledby="guide-chapter-title" className="min-w-0 rounded-2xl border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-5 md:p-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-primary"><Icon aria-hidden="true" className="h-4 w-4" />{t('guide.chapterNumber', { current: index + 1, total: GUIDE_CHAPTERS.length })}</div>
          <h2 ref={headingRef} tabIndex={-1} id="guide-chapter-title" className="scroll-mt-4 text-lg font-semibold text-[var(--workspace-text-strong)] focus:outline-none">{t(`guide.${chapter.id}.title`)}</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--workspace-text-muted)]">{t(`guide.${chapter.id}.summary`)}</p>
          <ol className="mt-6 space-y-5">
            {Array.from({ length: chapter.steps }, (_, i) => (
              <li key={`${chapter.id}-${i}`} className="flex gap-3">
                <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--workspace-border-soft)] font-mono text-xs text-[var(--workspace-text-muted)]">{i + 1}</span>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-[var(--workspace-text-strong)]">{t(`guide.${chapter.id}.step${i + 1}.title`)}</h3>
                  <p className="mt-1 break-words text-sm leading-6 text-[var(--workspace-text-muted)]">{t(`guide.${chapter.id}.step${i + 1}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>
          <aside className="mt-6 flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs leading-5 text-[var(--workspace-text-muted)]">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><p>{t(`guide.${chapter.id}.note`)}</p>
          </aside>
          <div className="mt-5 flex flex-wrap gap-2">
            {chapter.actions.map((action) => <Button key={action.destination} variant="outline" size="sm" onClick={() => onNavigate(action.destination)}>{t(action.label)}<ArrowRight aria-hidden="true" className="ml-2 h-3.5 w-3.5" /></Button>)}
          </div>
          <p className="mt-2 text-xs text-[var(--workspace-text-muted)]">{t('guide.actionHint')}</p>
          <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--workspace-border-soft)] pt-5">
            <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => updateProgress({ ...progress, current: GUIDE_CHAPTERS[index - 1].id })}><ArrowLeft aria-hidden="true" className="mr-2 h-4 w-4" />{t('guide.previous')}</Button>
            <div className="flex flex-wrap gap-2">
              {index < GUIDE_CHAPTERS.length - 1 && <Button variant="ghost" size="sm" onClick={() => updateProgress({ ...progress, current: GUIDE_CHAPTERS[index + 1].id })}>{t('guide.next')}</Button>}
              <Button size="sm" onClick={markRead}><Check aria-hidden="true" className="mr-2 h-4 w-4" />{t(index === GUIDE_CHAPTERS.length - 1 ? 'guide.markRead' : 'guide.readAndContinue')}</Button>
            </div>
          </footer>
        </article>
      </div>
    </main>
  )
}
