import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostListScrollArea } from './host-list-scroll-area'

describe('host list scroll area', () => {
  let contentWidth = 1000
  const observers: Array<{ observed: Set<Element>; disconnect: ReturnType<typeof vi.fn>; notify: () => void }> = []

  beforeEach(() => {
    contentWidth = 1000
    observers.length = 0
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'host-list-scroll-viewport' ? contentWidth : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'host-list-scroll-viewport' ? 300 : 0
    })
    vi.stubGlobal('ResizeObserver', class {
      observed = new Set<Element>()
      disconnect = vi.fn()
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this) }
      observe(element: Element) { this.observed.add(element) }
      notify = () => this.callback([], this as unknown as ResizeObserver)
    })
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const content = (onChange = vi.fn()) => <HostListScrollArea><select aria-label="Host operation" defaultValue="" onChange={onChange}><option value="">Operations</option><option value="refresh">Refresh</option></select></HostListScrollArea>
  it('observes viewport and content resizing without selecting or scrolling a host', () => {
    const onChange = vi.fn()
    render(content(onChange))
    const viewport = screen.getByTestId('host-list-scroll-viewport')
    const observer = observers[0]
    expect(observer.observed.has(viewport)).toBe(true)
    expect(observer.observed.has(viewport.firstElementChild!)).toBe(true)
    contentWidth = 1300
    act(() => observer.notify())
    expect(screen.getByRole('slider')).toHaveAttribute('max', '1000')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Host operation' })).toHaveValue('')
    expect(viewport.scrollTop).toBe(0)
    expect(viewport.scrollLeft).toBe(0)
  })

  it('keeps the horizontal range, paging buttons and keyboard navigation functional', () => {
    render(content())
    const viewport = screen.getByTestId('host-list-scroll-viewport')
    const range = screen.getByRole('slider')
    fireEvent.change(range, { target: { value: '240' } })
    expect(viewport.scrollLeft).toBe(240)
    fireEvent.click(screen.getByRole('button', { name: 'Scroll right' }))
    expect(viewport.scrollLeft).toBe(480)
    fireEvent.keyDown(range, { key: 'End' })
    expect(viewport.scrollLeft).toBe(700)
    fireEvent.keyDown(range, { key: 'Home' })
    expect(viewport.scrollLeft).toBe(0)
    expect(viewport.scrollTop).toBe(0)
  })

  it('shows controls only for actual overflow, handles its return and clears its observer and resize listener on unmount', () => {
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const view = render(content())
    expect(screen.getByRole('slider')).toHaveAttribute('max', '700')
    contentWidth = 300
    act(() => window.dispatchEvent(new Event('resize')))
    expect(screen.queryByTestId('host-list-scroll-controls')).not.toBeInTheDocument()
    contentWidth = 1000
    act(() => window.dispatchEvent(new Event('resize')))
    expect(screen.getByRole('slider')).toHaveAttribute('max', '700')
    expect(observers).toHaveLength(1)
    view.unmount()
    expect(observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })
})
