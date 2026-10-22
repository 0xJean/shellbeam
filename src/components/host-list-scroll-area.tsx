import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeftRight, ChevronLeft, ChevronRight } from 'lucide-react'
import { useT } from '@/lib/i18n'

export function HostListScrollArea({ children, monitoring = true, resources = false }: { children: ReactNode; monitoring?: boolean; resources?: boolean }) {
  const { t } = useT()
  const viewportId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, max: 0 })

  function readPosition() {
    const viewport = viewportRef.current
    if (!viewport) return
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    const left = Math.max(0, Math.min(max, viewport.scrollLeft))
    setPosition((previous) => previous.left === left && previous.max === max ? previous : { left, max })
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    readPosition()
    // Observe content too: the desktop column breakpoint can change its width
    // without changing the viewport (for example inside a fixed-width panel).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(readPosition)
    observer?.observe(viewport)
    observer?.observe(content)
    window.addEventListener('resize', readPosition)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', readPosition)
    }
  }, [monitoring, resources])

  function scrollTo(left: number) {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollLeft = Math.max(0, Math.min(position.max, left))
    readPosition()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const page = viewportRef.current?.clientWidth ?? 0
    const targets: Record<string, number> = {
      ArrowLeft: position.left - 48,
      ArrowRight: position.left + 48,
      PageUp: position.left - page,
      PageDown: position.left + page,
      Home: 0,
      End: position.max,
    }
    if (event.key in targets) {
      event.preventDefault()
      scrollTo(targets[event.key])
    }
  }

  return (
    <div className="relative min-w-0">
      {position.max > 1 && (
        <div data-testid="host-list-scroll-controls" className="flex items-center gap-3 border-b border-[color:var(--workspace-border-glow)] bg-[var(--workspace-surface-950)] px-4 py-2 shadow-sm">
          <div className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[var(--workspace-accent-text)]">
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('hosts.horizontalScrollHint')}</span>
          </div>
          <button type="button" aria-label={t('hosts.scrollLeft')} aria-controls={viewportId} disabled={position.left <= 0} onClick={() => scrollTo(position.left - 240)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)] disabled:opacity-40">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <input
            type="range"
            min={0}
            max={position.max}
            step={1}
            value={position.left}
            aria-label={t('hosts.horizontalScrollHint')}
            aria-controls={viewportId}
            className="host-list-scroll-range min-w-0 flex-1"
            onChange={(event) => scrollTo(Number(event.target.value))}
            onKeyDown={handleKeyDown}
          />
          <button type="button" aria-label={t('hosts.scrollRight')} aria-controls={viewportId} disabled={position.left >= position.max - 1} onClick={() => scrollTo(position.left + 240)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)] disabled:opacity-40">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
      <div ref={viewportRef} id={viewportId} data-testid="host-list-scroll-viewport" onScroll={readPosition} className="workspace-scrollbar-hidden workspace-horizontal-scroll min-w-0 overflow-x-auto overscroll-x-contain rounded-b-2xl">
        <div ref={contentRef} className={monitoring ? 'xl:min-w-[91rem]' : resources ? 'xl:min-w-[74rem]' : 'xl:min-w-[60rem]'}>{children}</div>
      </div>
    </div>
  )
}
