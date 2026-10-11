import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, useT } from '@/lib/i18n'
import { GUIDE_CHAPTERS, GUIDE_PROGRESS_KEY } from '@/lib/user-guide'
import en from '@/lib/locales/en'
import { UserGuide } from './user-guide'

beforeEach(() => { localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function openChapter(id: string) {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Guide chapters' })).getByRole('button', { name: new RegExp(en[`guide.${id}.title`]) }))
}

describe('user guide', () => {
  it('launches replayable interactive tours without changing written chapter progress', () => {
    const onStartTour = vi.fn()
    const onNavigate = vi.fn()
    render(<UserGuide onNavigate={onNavigate} onStartTour={onStartTour} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark read and continue' }))
    const progress = localStorage.getItem(GUIDE_PROGRESS_KEY)
    for (const id of ['hosts', 'monitor', 'mcp', 'hosts']) {
      fireEvent.click(screen.getByRole('button', { name: en[`tour.launch.${id}`] }))
      expect(onStartTour).toHaveBeenLastCalledWith(id)
    }
    expect(localStorage.getItem(GUIDE_PROGRESS_KEY)).toBe(progress)
    expect(onNavigate).not.toHaveBeenCalled()
    expect(screen.getByRole('navigation', { name: 'Guide chapters' })).toBeInTheDocument()
  })
  it('does not mark a chapter read simply by navigating or exiting', () => {
    const onNavigate = vi.fn()
    render(<UserGuide onNavigate={onNavigate} />)
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Add your first host' })).toHaveFocus()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    fireEvent.click(screen.getByRole('button', { name: 'Back to hosts' }))
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('hosts')
    expect(JSON.parse(localStorage.getItem(GUIDE_PROGRESS_KEY)!)).toEqual({ current: 'hosts', read: [] })
  })
  it('persists explicit reads and resumes after remount', () => {
    const { unmount } = render(<UserGuide onNavigate={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark read and continue' }))
    openChapter('mcp')
    unmount()
    render(<UserGuide onNavigate={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Give agents scoped access' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('button', { name: 'Give agents scoped access' })).toHaveAttribute('aria-current', 'step')
  })
  it('keeps feature actions explicit and remembers their chapter', () => {
    const onNavigate = vi.fn()
    render(<UserGuide onNavigate={onNavigate} />)
    for (const chapter of GUIDE_CHAPTERS) {
      openChapter(chapter.id)
      for (const action of chapter.actions) {
        fireEvent.click(within(screen.getByRole('article')).getByRole('button', { name: en[action.label] }))
        expect(onNavigate).toHaveBeenLastCalledWith(action.destination)
      }
      expect(JSON.parse(localStorage.getItem(GUIDE_PROGRESS_KEY)!).current).toBe(chapter.id)
    }
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })
  it('deduplicates reads and reports completion only when all chapters are read', () => {
    render(<UserGuide onNavigate={vi.fn()} />)
    openChapter('troubleshooting')
    fireEvent.click(screen.getByRole('button', { name: 'Mark chapter as read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark chapter as read' }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
    expect(screen.queryByText(en['guide.complete'])).not.toBeInTheDocument()
    openChapter('vault')
    for (let i = 0; i < GUIDE_CHAPTERS.length - 1; i++) fireEvent.click(screen.getByRole('button', { name: 'Mark read and continue' }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '8')
    expect(screen.getByText(en['guide.complete'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.queryByText(en['guide.complete'])).not.toBeInTheDocument()
    expect(localStorage.getItem('shellbeam.locale')).toBe('en')
  })
  it('keeps in-memory progress and warns when persistence fails', () => {
    render(<UserGuide onNavigate={vi.fn()} />)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    fireEvent.click(screen.getByRole('button', { name: 'Mark read and continue' }))
    expect(screen.getByRole('alert')).toHaveTextContent(en['guide.storageError'])
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('heading', { level: 2, name: 'Add your first host' })).toBeInTheDocument()
  })
  it('switches language without resetting chapter or progress', () => {
    function LanguageSwitch() {
      const { setLocale } = useT()
      return <button onClick={() => setLocale('zh-CN')}>Chinese</button>
    }
    render(<I18nProvider><LanguageSwitch /><UserGuide onNavigate={vi.fn()} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Mark read and continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chinese' }))
    expect(screen.getByRole('heading', { level: 2, name: '添加第一台主机' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
  })
})
