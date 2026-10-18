import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostListScrollArea } from './host-list-scroll-area'

describe('host list scroll area', () => {
  let contentWidth = 1000
  let controlsHeight = 49
  const observers: Array<{ observed: Set<Element>; disconnect: ReturnType<typeof vi.fn>; notify: () => void }> = []

  beforeEach(() => {
    contentWidth = 1000
    controlsHeight = 49
    observers.length = 0
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'host-list-scroll-viewport' ? contentWidth : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'host-list-scroll-viewport' ? 300 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.testid === 'host-list-scroll-controls' ? controlsHeight : 0
      return { x: 0, y: 0, width: 300, height, top: 0, bottom: height, left: 0, right: 300, toJSON: () => ({}) }
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
  const clearance = () => screen.getByTestId('host-list-scroll-viewport').parentElement!.style.getPropertyValue('--host-list-scroll-clearance')

  it('measures the actual sticky control height and updates clearance on resize without selecting or scrolling a host', () => {
    const onChange = vi.fn()
    render(content(onChange))
    const controls = screen.getByTestId('host-list-scroll-controls')
    const viewport = screen.getByTestId('host-list-scroll-viewport')
    expect(clearance()).toBe('57px')
    const observer = [...observers].reverse().find(entry => entry.observed.has(controls))!
    expect(observer).toBeDefined()
    controlsHeight = 81.25
    act(() => observer.notify())
    expect(clearance()).toBe('90px')
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

  it('clears the reserved space when overflow disappears and disconnects observers after controls remount and unmount', () => {
    const view = render(content())
    expect(clearance()).toBe('57px')
    contentWidth = 300
    act(() => window.dispatchEvent(new Event('resize')))
    expect(screen.queryByTestId('host-list-scroll-controls')).not.toBeInTheDocument()
    expect(clearance()).toBe('0px')
    contentWidth = 1000
    controlsHeight = 60
    act(() => window.dispatchEvent(new Event('resize')))
    expect(clearance()).toBe('68px')
    expect(observers.at(-1)!.observed.has(screen.getByTestId('host-list-scroll-controls'))).toBe(true)
    view.unmount()
    expect(observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true)
  })
})
